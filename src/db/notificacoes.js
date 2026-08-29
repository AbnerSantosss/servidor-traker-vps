// Barramento de tempo real entre processos: LISTEN/NOTIFY do Postgres.
//
// api e worker são dois containers separados que não compartilham memória (I-11) — o
// Postgres já é o único ponto que os dois conversam, então reaproveitá-lo para avisos em
// tempo real evita subir Redis ou qualquer outro componente novo só para isto (e a regra
// da fase é clara: nenhuma dependência nova).
//
// Dois papéis, bem separados:
//   publicar(canal, dados)   -> dispara `pg_notify`, best-effort, nunca lança.
//   assinar(canais, callback) -> mantém UMA conexão dedicada em LISTEN, compartilhada por
//                                 todo mundo que assinar no mesmo processo.
//
// Por que uma conexão dedicada, fora do pool: um cliente que entrou em LISTEN não pode
// voltar para o pool — se voltasse, o pool o devolveria mais tarde para rodar uma query
// qualquer, e a assinatura desapareceria em silêncio (o pior tipo de bug: nada quebra,
// só o tempo real para de chegar e ninguém percebe até reclamarem).
import pg from 'pg';
import { env } from '../config/env.js';
import { log } from '../config/log.js';
import { query } from './pool.js';

export const CANAL_EVENTOS = 'trk_eventos';
export const CANAL_ENTREGAS = 'trk_entregas';

// Folga generosa sob o teto real de 8KB do NOTIFY do Postgres. O payload que este módulo
// manda nunca chega perto disso (é só { project_id, tipo, id } — nunca o registro
// inteiro, e nunca PII, ver I-8), mas o teto fica aqui como cinto de segurança: se algum
// dia alguém colar um objeto maior "de passagem", falha local e visível em vez de um
// erro cru do Postgres.
const LIMITE_PAYLOAD_BYTES = 7500;

/**
 * Ponto de substituição usado SÓ pelo teste de resiliência (recordEvent não pode quebrar
 * quando a publicação falha). Sem biblioteca de mock (o projeto não traz nenhuma — regra
 * de "nenhuma dependência nova"), reatribuir `_internos.query` é a forma mais direta de
 * simular uma falha real sem depender de internals do módulo `pg` nem derrubar o banco de
 * teste inteiro. Nunca reatribuído fora de teste.
 */
export const _internos = { query };

/**
 * Publica uma notificação. BEST-EFFORT SEMPRE: a ingestão de evento é a função crítica
 * deste sistema (é o que o cliente do site espera na resposta), o tempo real é conforto
 * por cima dela. Por isso todo erro daqui é só logado — nunca relançado — e o payload é
 * deliberadamente mínimo: quem assina busca o registro completo (já mascarado) no banco.
 */
export async function publicar(canal, dados) {
  try {
    const texto = JSON.stringify(dados ?? {});
    if (Buffer.byteLength(texto, 'utf8') > LIMITE_PAYLOAD_BYTES) {
      log('warn', 'notificação descartada: payload maior que o limite do canal NOTIFY', { canal });
      return;
    }
    await _internos.query('SELECT pg_notify($1, $2)', [canal, texto]);
  } catch (err) {
    log('warn', 'falha ao publicar notificação em tempo real (best-effort, ignorada)', {
      canal,
      error: err.message,
    });
  }
}

// ---------------------------------------------------------------- assinatura (LISTEN)

// Estado do processo inteiro: uma conexão dedicada só, reaproveitada por todo mundo que
// chamar assinar() — nunca uma conexão por aba de painel aberta (é exatamente o que a
// fase pede: "uma única assinatura LISTEN por processo").
const ouvintesPorCanal = new Map(); // canal -> Set<callback>
let clienteAtual = null;
let tentativasReconexao = 0;
let timerReconexao = null;
let encerrando = false;
let sinaisRegistrados = false;

const ESPERA_MAXIMA_MS = 30_000;

function proximaEsperaMs() {
  // Backoff exponencial (1s, 2s, 4s… teto de 30s): o Postgres reinicia ou a rede oscila
  // de vez em quando, e sem reconexão automática o tempo real morre em silêncio — ninguém
  // vê erro nenhum, só percebe que o painel parou de atualizar sozinho.
  return Math.min(1000 * 2 ** tentativasReconexao, ESPERA_MAXIMA_MS);
}

async function conectar() {
  const cliente = new pg.Client({ connectionString: env.DATABASE_URL });

  cliente.on('notification', (msg) => {
    const callbacks = ouvintesPorCanal.get(msg.channel);
    if (!callbacks || !callbacks.size) return;
    let dados = null;
    try {
      dados = msg.payload ? JSON.parse(msg.payload) : null;
    } catch (err) {
      log('warn', 'notificação recebida com payload não-JSON, ignorada', { canal: msg.channel, error: err.message });
      return;
    }
    for (const callback of callbacks) {
      try {
        callback(dados);
      } catch (err) {
        // Um assinante que quebra não pode derrubar os outros nem a conexão.
        log('error', 'assinante de notificação lançou erro ao processar mensagem', {
          canal: msg.channel,
          error: err.message,
        });
      }
    }
  });

  // 'error' (a conexão caiu com erro) e 'end' (a conexão fechou, com ou sem erro) podem
  // disparar em sequência para o mesmo evento de queda — agendarReconexao() é idempotente
  // (um timer pendente não é substituído por outro) para não abrir duas tentativas em
  // paralelo.
  cliente.on('error', (err) => {
    log('warn', 'conexão de LISTEN/NOTIFY caiu, reconectando', { error: err.message });
    if (clienteAtual === cliente) clienteAtual = null;
    agendarReconexao();
  });
  cliente.on('end', () => {
    if (clienteAtual === cliente) clienteAtual = null;
    if (!encerrando) agendarReconexao();
  });

  await cliente.connect();
  for (const canal of ouvintesPorCanal.keys()) {
    // LISTEN não aceita parâmetro vinculado ($1) — o nome do canal vai literal no SQL.
    // Seguro aqui porque os únicos canais possíveis são as constantes deste módulo
    // (CANAL_EVENTOS/CANAL_ENTREGAS), nunca uma string vinda de fora.
    await cliente.query(`LISTEN ${canal}`);
  }

  // Uma conexão só de LISTEN não pode, sozinha, impedir o processo de encerrar: em teste
  // (sem servidor HTTP escutando) e em qualquer script de vida curta, isto travaria o
  // processo indefinidamente à espera de uma notificação que talvez nunca chegue. Em
  // produção não muda nada, porque o `server.listen()`/laço do worker já mantêm o
  // processo vivo por conta própria.
  cliente.unref();

  clienteAtual = cliente;
  tentativasReconexao = 0;
  log('info', 'assinatura LISTEN/NOTIFY conectada', { canais: [...ouvintesPorCanal.keys()] });
}

function agendarReconexao() {
  if (encerrando || timerReconexao) return;
  const espera = proximaEsperaMs();
  tentativasReconexao++;
  timerReconexao = setTimeout(() => {
    timerReconexao = null;
    conectar().catch((err) => {
      log('warn', 'falha ao reconectar LISTEN/NOTIFY, nova tentativa agendada', {
        error: err.message,
        em_ms: proximaEsperaMs(),
      });
      agendarReconexao();
    });
  }, espera);
  timerReconexao.unref?.();
}

/**
 * Garante que a conexão dedicada exista e esteja ouvindo `canaisNovos`. Nunca lança: uma
 * falha de conexão na hora de assinar (ex.: banco ainda subindo no boot) não pode derrubar
 * quem chamou `assinar` — só agenda a reconexão em segundo plano, como qualquer outra
 * queda.
 */
async function garantirConexao(canaisNovos) {
  if (clienteAtual) {
    for (const canal of canaisNovos) {
      await clienteAtual.query(`LISTEN ${canal}`).catch((err) => {
        log('warn', 'falha ao registrar LISTEN em canal novo', { canal, error: err.message });
      });
    }
    return;
  }
  try {
    await conectar();
  } catch (err) {
    log('warn', 'falha ao conectar para LISTEN/NOTIFY, tentando de novo em segundo plano', { error: err.message });
    agendarReconexao();
  }
}

function registrarEncerramentoGracioso() {
  if (sinaisRegistrados) return;
  sinaisRegistrados = true;
  for (const sinal of ['SIGTERM', 'SIGINT']) {
    process.on(sinal, async () => {
      await pararAssinatura();
    });
  }
}

/**
 * Assina um ou mais canais. Idempotente: chamadas subsequentes (de módulos diferentes, ou
 * de vários endpoints SSE) reaproveitam a MESMA conexão dedicada — nunca abrem uma conexão
 * nova por assinante. Devolve uma função para este assinante específico parar de receber;
 * a conexão com o banco só encerra de fato no SIGTERM/SIGINT do processo (ou em
 * `pararAssinatura`, usado pelos testes).
 */
export async function assinar(canais, aoReceber) {
  const lista = Array.isArray(canais) ? canais : [canais];
  const canaisNovos = [];
  for (const canal of lista) {
    if (!ouvintesPorCanal.has(canal)) {
      ouvintesPorCanal.set(canal, new Set());
      canaisNovos.push(canal);
    }
    ouvintesPorCanal.get(canal).add(aoReceber);
  }

  registrarEncerramentoGracioso();
  await garantirConexao(canaisNovos);

  return function cancelar() {
    for (const canal of lista) {
      ouvintesPorCanal.get(canal)?.delete(aoReceber);
    }
  };
}

/**
 * Encerramento gracioso: fecha a conexão dedicada sem deixar cliente pendurado. Chamado
 * pelo handler de SIGTERM/SIGINT e, nos testes, diretamente no `after()` para o processo
 * do teste conseguir terminar sozinho (mesmo com `unref()`, um `client.end()` explícito é
 * mais rápido e mais limpo que esperar o processo perceber que não há mais nada a fazer).
 */
export async function pararAssinatura() {
  encerrando = true;
  if (timerReconexao) {
    clearTimeout(timerReconexao);
    timerReconexao = null;
  }
  const cliente = clienteAtual;
  clienteAtual = null;
  if (cliente) {
    await cliente.end().catch(() => {});
    log('info', 'assinatura LISTEN/NOTIFY encerrada');
  }
  ouvintesPorCanal.clear();
  // Permite reabrir depois (usado pelos testes, que chamam assinar() de novo em outro
  // describe): sem isto, `encerrando` ficaria travado em `true` para sempre neste processo.
  encerrando = false;
  tentativasReconexao = 0;
}
