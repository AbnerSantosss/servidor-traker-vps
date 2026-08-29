// Despachante: pega uma entrega reivindicada da fila e a executa no destino certo.
// Isolado do laço do worker para poder ser testado sem subir processo.
import { getProject, iaKey, registrarUsoIA } from '../db/repos/projects.js';
import { markDeliverySuccess, markDeliveryFailure, markDeliverySkipped } from '../db/repos/events.js';
import { sendToMeta } from '../destinations/meta.js';
import { sendToGoogle } from '../destinations/google.js';
import { sendPostback } from '../destinations/postback.js';
import { isBlockedByConsent } from '../ingest/consent.js';
import { log } from '../config/log.js';
import { publicar, CANAL_ENTREGAS } from '../db/notificacoes.js';
import { completar, TIMEOUT_EVENTO_MS } from '../ia/openrouter.js';
import { PROMPT_EVENTO_SISTEMA, VERSAO_PROMPT_EVENTO, montarPromptEventoUsuario } from '../ia/prompts.js';
import { hashearPiiParaPrompt } from '../ia/pii.js';

const SENDERS = {
  meta: sendToMeta,
  google: sendToGoogle,
  postback: sendPostback,
};

// ---------------------------------------------------------------- modo "IA por evento" (F5/7.4)
//
// CONTRATO com quem grava o evento na ingestão (fora deste arquivo — ver docs/15,
// I-4/I-6: a ingestão não muda de comportamento nesta fase): um evento pendente de
// estruturação por IA chega aqui com `event.payload.ia_por_evento === true` e
// `event.payload.ia_bruto` guardando o corpo original do webhook. O `event_name`
// gravado nesse momento é sempre um placeholder neutro — NUNCA "purchase" — porque até
// a IA rodar aqui ninguém confirmou pagamento nenhum ainda.
//
// A estruturação roda SÓ AQUI, dentro do worker, nunca na ingestão: o webhook já
// respondeu 200 muito antes disso (I-4/I-6 intactos).

// O hasheamento de PII mora em src/ia/pii.js porque a INGESTÃO também precisa dele (para
// não gravar e-mail em claro ao guardar o corpo bruto de um webhook em modo IA), e a
// ingestão não pode importar este arquivo — traria a fila de entregas inteira para o
// caminho crítico do webhook. Reexportado aqui porque este segue sendo o ponto de uso
// principal e há testes que o importam daqui.
export { hashearPiiParaPrompt };

// Mesmo vocabulário de status usado no adaptador hardcoded (nomeDoEvento, em
// src/ingest/adaptadores.js) — não é coincidência: é a MESMA regra de negócio,
// reimplementada aqui porque este caminho não passa pela DSL/validarMapeamento (a IA
// devolve o evento pronto, não uma regra declarativa para validar).
const STATUS_PAGO_CONHECIDOS = ['paid', 'approved', 'confirmed', 'succeeded', 'completed', 'pago', 'aprovado', 'confirmado'];

function coletarValoresDeChavesStatus(valor, saida = [], profundidade = 0) {
  if (profundidade > 6) return saida;
  if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
    for (const [k, v] of Object.entries(valor)) {
      if (/status|situacao|pagamento|payment/i.test(k) && typeof v === 'string') saida.push(v);
      else coletarValoresDeChavesStatus(v, saida, profundidade + 1);
    }
  }
  return saida;
}

/**
 * REGRA DURA do modo por evento: "modelo nenhum pode inventar um purchase" (F5,
 * ENTREGÁVEL 5). Como aqui não existe DSL para rodar `validarMapeamento` em cima, o
 * servidor reimplementa o mesmo espírito de forma independente do que a IA CLAMOU: só
 * aceita `event_name: 'purchase'` quando o PRÓPRIO payload bruto (não a palavra da
 * IA) tem algum campo de status reconhecível como pago. Isso é auditável e não
 * depende de o modelo "ter sido honesto".
 */
function eventoConfirmaPagamento(payloadBruto, evento) {
  if (evento?.event_name !== 'purchase') return true; // a regra só existe para "purchase"
  const candidatos = coletarValoresDeChavesStatus(payloadBruto);
  return candidatos.some((v) => STATUS_PAGO_CONHECIDOS.includes(String(v).toLowerCase()));
}

const TENTATIVAS_MAX_IA_EVENTO = 2; // "no máximo 2 tentativas" (F5, ENTREGÁVEL 5)

/**
 * Chama a IA para estruturar UM evento (payload bruto -> Evento Interno pronto).
 * PII hasheada ANTES de montar o prompt (I-8) — ver hashearPiiParaPrompt. Lança
 * sempre com mensagem prefixada "ia:" (o tradutor de erros do painel já sabe mostrar
 * o que não reconhece com honestidade — ver src/destinations/erros-explicados.js).
 */
export async function estruturarEventoComIA({ project, payloadBruto }) {
  const chave = iaKey(project);
  if (!chave) throw Object.assign(new Error('ia: projeto sem chave da OpenRouter configurada'), { retriable: false });
  const modelo = project?.ia?.modelo;
  if (!modelo) throw Object.assign(new Error('ia: projeto sem modelo da OpenRouter selecionado'), { retriable: false });

  const brutoHasheado = hashearPiiParaPrompt(payloadBruto || {});

  let ultimoErro;
  for (let tentativa = 1; tentativa <= TENTATIVAS_MAX_IA_EVENTO; tentativa++) {
    try {
      const resultado = await completar(chave, {
        modelo,
        system: PROMPT_EVENTO_SISTEMA,
        user: montarPromptEventoUsuario(brutoHasheado),
        jsonEsperado: true,
        timeoutMs: TIMEOUT_EVENTO_MS,
      });

      if (resultado.uso?.custoUsd) {
        await registrarUsoIA(project.id, { custoUsd: resultado.uso.custoUsd }).catch(() => {});
      }

      const evento = resultado.json?.evento;
      if (!evento || typeof evento !== 'object') throw new Error('resposta sem campo "evento"');

      if (!eventoConfirmaPagamento(brutoHasheado, evento)) {
        // Rebaixa em vez de descartar o evento inteiro: o resto da estruturação pode
        // estar correto, só a classificação de compra não tem lastro no payload bruto.
        evento.event_name = 'estruturado_por_ia_sem_confirmacao_pagamento';
        log('warn', 'IA classificou evento como purchase sem sinal de pagamento no payload bruto — rebaixado', { project: project.id });
      }

      return { evento, custo: resultado.uso, promptVersao: VERSAO_PROMPT_EVENTO };
    } catch (err) {
      ultimoErro = err;
    }
  }

  throw Object.assign(new Error(`ia: ${ultimoErro?.message || 'falha ao estruturar evento'}`), { retriable: true });
}

// Cache em memória por event_row_id: um mesmo evento pode ter várias entregas (uma
// por destino habilitado — meta/google/postback), cada uma processada por uma
// chamada separada a `processDelivery`. Sem isto, a IA rodaria uma vez por DESTINO em
// vez de uma vez por EVENTO — 3x o custo pelo mesmo trabalho. TTL curto (não
// permanente: o worker é um processo que reinicia, e persistir o resultado de volta
// no banco exigiria mexer em src/db/repos/events.js, fora do escopo desta fase — ver
// relato de decisões pendentes).
const CACHE_EVENTO_IA_TTL_MS = 5 * 60 * 1000;
const cacheEventoIA = new Map(); // event_row_id -> { resultado: { evento } | { erro }, expiraEm }

async function estruturarComCache(eventRowId, project, payload) {
  const agora = Date.now();
  const emCache = cacheEventoIA.get(eventRowId);
  if (emCache && emCache.expiraEm > agora) return emCache.resultado;

  let resultado;
  try {
    const { evento } = await estruturarEventoComIA({ project, payloadBruto: payload.ia_bruto });
    resultado = { evento };
  } catch (err) {
    resultado = { erro: err.message };
  }
  cacheEventoIA.set(eventRowId, { resultado, expiraEm: agora + CACHE_EVENTO_IA_TTL_MS });
  return resultado;
}

export async function processDelivery({ delivery, event }) {
  // try/finally em vez de publicar em cada `return`: TODO caminho desta função termina
  // com exatamente uma chamada a markDelivery*, ou seja, com uma mudança de status real —
  // publicar uma vez no finally cobre os sete pontos de saída sem repetir a chamada em
  // cada um. `publicar` é best-effort (ver src/db/notificacoes.js): se ela falhar, o
  // `finally` não relança nada, e o resultado do despacho (sucesso, erro, pulado) segue
  // intacto — o tempo real nunca pode contaminar a fila de verdade.
  try {
    if (!event) {
      await markDeliverySkipped(delivery.id, 'skipped_unmapped', 'evento não encontrado');
      return { status: 'skipped' };
    }

    const project = await getProject(delivery.project_id);
    if (!project) {
      await markDeliverySkipped(delivery.id, 'skipped_unmapped', 'projeto removido');
      return { status: 'skipped' };
    }

    let payload = event.payload;

    // O destino pode ter sido desligado depois que o evento entrou na fila.
    if (!project.destinations[delivery.destination_type]?.enabled) {
      await markDeliverySkipped(delivery.id, 'skipped_unmapped', 'destino desativado');
      return { status: 'skipped' };
    }

    // Modo "IA por evento" (F5/7.4): este evento ainda não foi estruturado — a
    // ingestão só marcou `payload.ia_por_evento` e guardou o corpo bruto original em
    // `payload.ia_bruto`. A estruturação de verdade acontece SÓ AQUI, no worker,
    // nunca na ingestão (I-4/I-6 intactos: o webhook já respondeu 200 muito antes
    // disso). Timeout de 15s e no máximo 2 tentativas ficam dentro de
    // estruturarEventoComIA; falha vira entrega 'error' com last_error prefixado
    // "ia:", sem travar a fila (as outras entregas continuam sendo processadas
    // normalmente pelo worker).
    if (payload?.ia_por_evento) {
      const resultado = await estruturarComCache(delivery.event_row_id, project, payload);
      if (resultado.erro) {
        const outcome = await markDeliveryFailure(delivery.id, {
          error: resultado.erro,
          retriable: true,
          attempts: delivery.attempts,
        });
        return { status: outcome.dead ? 'dead' : 'retry', retryInSeconds: outcome.retryInSeconds };
      }
      payload = resultado.evento;
    }

    // Consentimento negado para armazenamento e análise: não envia a lugar nenhum.
    if (isBlockedByConsent(payload)) {
      await markDeliverySkipped(delivery.id, 'skipped_consent', 'ad_storage e analytics_storage negados');
      return { status: 'skipped' };
    }

    const send = SENDERS[delivery.destination_type];
    if (!send) {
      await markDeliverySkipped(delivery.id, 'skipped_unmapped', `destino desconhecido: ${delivery.destination_type}`);
      return { status: 'skipped' };
    }

    let result;
    try {
      result = await send(payload, project);
    } catch (err) {
      result = { ok: false, retriable: true, response: { error: String(err?.message || err) } };
    }

    // Destino pediu explicitamente para pular (ex.: postback com filtro de evento).
    if (result.skipped) {
      await markDeliverySkipped(delivery.id, result.reason || 'skipped_unmapped', result.response?.error);
      return { status: 'skipped' };
    }

    if (result.ok) {
      await markDeliverySuccess(delivery.id, { httpStatus: result.httpStatus, response: result.response });
      return { status: 'success' };
    }

    const outcome = await markDeliveryFailure(delivery.id, {
      httpStatus: result.httpStatus,
      response: result.response,
      error: result.response?.error || 'falha no envio',
      retriable: result.retriable,
      attempts: delivery.attempts,
    });

    log(outcome.dead ? 'error' : 'warn', `entrega falhou (${delivery.destination_type})`, {
      project: delivery.project_id,
      event_id: event.event_id,
      tentativa: delivery.attempts,
      dead: outcome.dead,
      erro: result.response?.error,
    });

    return { status: outcome.dead ? 'dead' : 'retry', retryInSeconds: outcome.retryInSeconds };
  } finally {
    await publicar(CANAL_ENTREGAS, { project_id: delivery.project_id, tipo: 'entrega', id: delivery.id });
  }
}
