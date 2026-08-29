// Motor de notificações por e-mail (épico E8): avalia os gatilhos do catálogo fechado
// (ver CATALOGO_NOTIFICACOES em src/db/repos/notificacoes.js) e dispara os e-mails.
//
// Roda NO WORKER (src/worker.js chama tick() uma vez por minuto, junto da manutenção que
// já existia). Cada avaliação sai em uma consulta barata quando não há nada para fazer —
// "notificação é conforto, entrega de conversão é a função crítica" é o princípio que
// guia toda decisão de robustez aqui: qualquer falha (SMTP fora do ar, template quebrado,
// destino inesperado) fica presa num try/catch e vira log, nunca uma exceção que sobe.
//
// Decisão de projeto sobre "1 por incidente": sem um componente de estado dedicado (e
// a regra da fase é "nenhuma dependência nova"), o motor usa BUCKETS DE RELÓGIO como
// proxy de incidente — ex.: falha_recorrente agrupa por hora corrida, entrega_morta por
// janela de 30 min. Um incidente que dura 3 horas gera 3 e-mails (um por hora), não um só
// do início ao fim. É uma simplificação deliberada, documentada aqui e no relatório desta
// fase — trocar por um rastreamento de estado mais fino é trabalho futuro, não bug.
import { query } from '../db/pool.js';
import { log } from '../config/log.js';
import { publicBaseUrl } from '../config/env.js';
import { enviarEmail, emailConfigurado } from '../config/mailer.js';
import {
  emailEntregasMortas, emailFalhaRecorrente, emailFalhaResolvida, emailFilaAcumulada,
  emailDominioProblema, emailResumoDiario, emailResumoSemanal, emailTesteNotificacao,
} from '../emails/templates.js';
import {
  assinantesDoTipo, assinantesExatoDoTipo, existeAssinanteDoTipo, jaNotificado,
  registrarEnvio, contarEnviosAnteriores, chavesAbertasSemResolucao,
} from '../db/repos/notificacoes.js';
import { getProject, listProjects } from '../db/repos/projects.js';
import { computeMetrics } from '../db/repos/events.js';
import { getUserById } from '../db/repos/users.js';

// Fuso dos agendados (resumo diário/semanal). Não há variável de ambiente própria para
// isto no projeto — o mesmo fuso fixo já aparece em src/admin/auth.js (confirmação de
// troca de senha) e é o público-alvo real do produto; documentar aqui em vez de inventar
// uma dependência de biblioteca de datas só para isto (regra da fase).
const FUSO_NOTIFICACOES = 'America/Sao_Paulo';

// Limiares do catálogo v1 — fixos no código nesta fase (sem tela de configuração ainda).
// Ver "decisões que merecem revisão humana" no relatório: seriam os primeiros candidatos
// a virar campo configurável por conta quando o produto tiver mais de uma operação usando.
const JANELA_DIGEST_MORTAS_MIN = 30;
const LIMIAR_FALHA_RECORRENTE = 5; // erros do mesmo destino em 1h
const LIMIAR_FILA_ACUMULADA = 50; // entregas pending+error paradas
const MINUTOS_FILA_ACUMULADA = 15;

function urlPainel() {
  return `${publicBaseUrl()}/painel`;
}

/**
 * Ponto de substituição usado só pelo teste de resiliência (uma falha no envio — SMTP
 * fora do ar, erro inesperado — não pode derrubar o motor nem impedir os demais
 * destinatários). Mesmo padrão de src/db/notificacoes.js (`_internos`): sem biblioteca de
 * mock, reatribuir estas duas funções é a forma mais direta de simular a falha sem
 * depender de rede de verdade. Nunca reatribuído fora de teste.
 */
export const _internos = { emailConfigurado, enviarEmail };

/**
 * Resolve o par (inscritoPor, urlDescadastro) que todo template de notificação carrega
 * no rodapé. `inscritoPor` só vem preenchido quando é o PRIMEIRO e-mail que este
 * destinatário recebe E ele é externo (sem conta no painel) — é quando a explicação "você
 * foi inscrito por Fulano" faz diferença; depois disso a pessoa já sabe de onde veio.
 */
async function contextoDestinatario(destinatario) {
  const urlDescadastro = `${publicBaseUrl()}/descadastro?token=${destinatario.token_descadastro}`;
  const primeiraVez = (await contarEnviosAnteriores(destinatario.id)) === 0;

  let inscritoPor;
  if (primeiraVez && !destinatario.user_id) {
    const autor = destinatario.criado_por ? await getUserById(destinatario.criado_por) : null;
    inscritoPor = autor?.name || autor?.email || 'um administrador do painel';
  }
  return { inscritoPor, urlDescadastro };
}

/**
 * Núcleo comum a todo tipo de notificação: resolve os assinantes, pula quem já foi
 * avisado deste MESMO incidente (idempotência — reinício do worker não redispara),
 * monta e envia o e-mail, e registra. Uma falha isolada (um destinatário com endereço
 * inválido, por exemplo) não pode impedir os demais nem derrubar o tick inteiro.
 */
async function notificarAssinantes({
  assinaturaTipo, idempotenciaTipo = assinaturaTipo, projectId = null, chaveIncidente, montarMensagem, exato = false,
}) {
  const assinantes = exato
    ? await assinantesExatoDoTipo(assinaturaTipo, projectId)
    : await assinantesDoTipo(assinaturaTipo, projectId);

  for (const destinatario of assinantes) {
    try {
      if (await jaNotificado(idempotenciaTipo, chaveIncidente, destinatario.id)) continue;

      const contexto = await contextoDestinatario(destinatario);
      const msg = await montarMensagem(contexto);

      const resultado = _internos.emailConfigurado()
        ? await _internos.enviarEmail({ para: destinatario.email, ...msg })
        : { enviado: false, erro: 'SMTP não configurado' };

      // Registrado mesmo quando o envio falhou: notificação é conforto, não fila
      // crítica — reter e reprocessar um destinatário com problema de e-mail a cada
      // tick só produziria log repetido sem chance real de sucesso.
      await registrarEnvio(idempotenciaTipo, chaveIncidente, destinatario.id);
      log(resultado.enviado ? 'info' : 'warn', 'notificação processada', {
        tipo: idempotenciaTipo, para: destinatario.email, enviado: resultado.enviado,
      });
    } catch (err) {
      log('error', 'falha ao processar notificação — seguindo para os próximos destinatários', {
        tipo: idempotenciaTipo, destinatarioId: destinatario.id, error: err.message,
      });
    }
  }
}

// ---------------------------------------------------------------- entrega_morta

async function avaliarEntregaMorta() {
  const janelaMs = JANELA_DIGEST_MORTAS_MIN * 60_000;
  const inicioJanela = new Date(Math.floor(Date.now() / janelaMs) * janelaMs);

  const { rows } = await query(
    `SELECT project_id, destination_type AS destino, COUNT(*)::int AS quantidade
       FROM deliveries
      WHERE status = 'dead' AND updated_at >= $1
      GROUP BY 1, 2`,
    [inicioJanela]
  );
  if (!rows.length) return; // consulta única, sem gatilho — sai aqui (barato)

  const porProjeto = new Map();
  for (const r of rows) {
    const lista = porProjeto.get(r.project_id) || [];
    lista.push({ destino: r.destino, quantidade: r.quantidade });
    porProjeto.set(r.project_id, lista);
  }

  for (const [projectId, itens] of porProjeto) {
    const projeto = await getProject(projectId);
    if (!projeto) continue; // projeto removido entre a leitura e a avaliação
    const chave = `${projectId}:${inicioJanela.toISOString()}`;
    await notificarAssinantes({
      assinaturaTipo: 'entrega_morta',
      projectId,
      chaveIncidente: chave,
      montarMensagem: (contexto) => emailEntregasMortas({
        projeto: projeto.name, janelaMinutos: JANELA_DIGEST_MORTAS_MIN, itens,
        urlPainel: urlPainel(), ...contexto,
      }),
    });
  }
}

// ---------------------------------------------------------------- falha_recorrente

async function avaliarFalhaRecorrente() {
  const desde = new Date(Date.now() - 3600_000);
  const { rows } = await query(
    `SELECT project_id, destination_type AS destino, COUNT(*)::int AS quantidade
       FROM deliveries
      WHERE status IN ('error','dead') AND updated_at >= $1
      GROUP BY 1, 2
     HAVING COUNT(*) >= $2`,
    [desde, LIMIAR_FALHA_RECORRENTE]
  );

  const bucketHora = Math.floor(Date.now() / 3600_000);
  const ativos = new Set(rows.map((r) => `${r.project_id}:${r.destino}`));

  for (const r of rows) {
    const projeto = await getProject(r.project_id);
    if (!projeto) continue;
    const chave = `${r.project_id}:${r.destino}:${bucketHora}`;
    await notificarAssinantes({
      assinaturaTipo: 'falha_recorrente',
      projectId: r.project_id,
      chaveIncidente: chave,
      montarMensagem: (contexto) => emailFalhaRecorrente({
        projeto: projeto.name, destino: r.destino, quantidade: r.quantidade, janelaMinutos: 60,
        urlPainel: urlPainel(), ...contexto,
      }),
    });
  }

  // "Resolvido": alertas de abertura enviados nas últimas 3h que ainda não têm o par de
  // resolução, e cujo (projeto,destino) já não está mais acima do limiar agora.
  const abertos = await chavesAbertasSemResolucao(
    'falha_recorrente', 'falha_recorrente_resolvido', new Date(Date.now() - 3 * 3600_000)
  );
  for (const chave of abertos) {
    const [projectId, destino] = chave.split(':');
    if (ativos.has(`${projectId}:${destino}`)) continue; // ainda ruim — não resolveu
    const projeto = await getProject(projectId);
    if (!projeto) continue;
    await notificarAssinantes({
      assinaturaTipo: 'falha_recorrente', // mesmos assinantes do alerta de abertura
      idempotenciaTipo: 'falha_recorrente_resolvido',
      projectId,
      chaveIncidente: chave,
      montarMensagem: (contexto) => emailFalhaResolvida({
        projeto: projeto.name, destino, urlPainel: urlPainel(), ...contexto,
      }),
    });
  }
}

// ---------------------------------------------------------------- fila_acumulada

async function avaliarFilaAcumulada() {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS quantidade
       FROM deliveries
      WHERE status IN ('pending','error') AND created_at <= now() - ($1 || ' minutes')::interval`,
    [MINUTOS_FILA_ACUMULADA]
  );
  const quantidade = rows[0]?.quantidade || 0;
  if (quantidade < LIMIAR_FILA_ACUMULADA) return;

  const bucketHora = Math.floor(Date.now() / 3600_000);
  await notificarAssinantes({
    assinaturaTipo: 'fila_acumulada',
    projectId: null, // alerta de sistema — não é de um projeto (catálogo: porProjeto=false)
    chaveIncidente: `global:${bucketHora}`,
    montarMensagem: (contexto) => emailFilaAcumulada({
      quantidade, limiar: LIMIAR_FILA_ACUMULADA, minutos: MINUTOS_FILA_ACUMULADA,
      urlPainel: urlPainel(), ...contexto,
    }),
  });
}

// ---------------------------------------------------------------- dominio_problema

async function avaliarDominioProblema() {
  const { rows } = await query(
    `SELECT d.hostname, d.project_id, d.last_error, p.name AS projeto_nome
       FROM project_domains d
       JOIN projects p ON p.id = d.project_id
      WHERE d.verification_status = 'failed'`
  );
  if (!rows.length) return;

  // Um aviso por domínio por dia enquanto o problema persistir — evita martelar a cada
  // minuto sem precisar de uma máquina de estados "aberto/resolvido" para isto.
  const dataHoje = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    await notificarAssinantes({
      assinaturaTipo: 'dominio_problema',
      projectId: r.project_id,
      chaveIncidente: `${r.hostname}:${dataHoje}`,
      montarMensagem: (contexto) => emailDominioProblema({
        hostname: r.hostname, projeto: r.projeto_nome, erro: r.last_error,
        urlPainel: urlPainel(), ...contexto,
      }),
    });
  }
}

// ---------------------------------------------------------------- resumo_diario / semanal

/** Hora local, data (YYYY-MM-DD) e dia da semana abreviado em inglês ('Mon', 'Tue', ...). */
function agoraNoFuso() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_NOTIFICACOES, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short',
  }).formatToParts(new Date());
  const mapa = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return { data: `${mapa.year}-${mapa.month}-${mapa.day}`, hora: Number(mapa.hour), diaSemana: mapa.weekday };
}

function deslocarDias(dataYYYYMMDD, dias) {
  const d = new Date(`${dataYYYYMMDD}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/** Soma os KPIs de todos os projetos — usado pela assinatura "todos os projetos". */
async function agregarKpisTodosProjetos(from, to) {
  const projetos = await listProjects();
  const acc = { events: 0, purchases: 0, revenue: 0, signUps: 0 };
  let sucesso = 0;
  let tentadas = 0;
  for (const p of projetos) {
    const { totals, byDestination } = await computeMetrics(p.id, { from, to });
    acc.events += totals.events;
    acc.purchases += totals.purchases;
    acc.revenue += totals.revenue;
    acc.signUps += totals.signUps;
    for (const d of Object.values(byDestination)) {
      sucesso += d.success;
      tentadas += d.success + d.error;
    }
  }
  return {
    ...acc,
    avgTicket: acc.purchases ? acc.revenue / acc.purchases : 0,
    successRate: tentadas ? sucesso / tentadas : 0,
  };
}

async function avaliarResumoDiario() {
  const { data, hora } = agoraNoFuso();
  if (hora < 8) return; // só a partir das 08h (fuso do produto); idempotência evita reenvio depois
  if (!(await existeAssinanteDoTipo('resumo_diario'))) return; // sai cedo e barato

  const ontem = deslocarDias(data, 1);

  await notificarAssinantes({
    assinaturaTipo: 'resumo_diario',
    projectId: null,
    chaveIncidente: `todos:${data}`,
    montarMensagem: async (contexto) => emailResumoDiario({
      escopo: 'todos os projetos', data: ontem, kpis: await agregarKpisTodosProjetos(ontem, ontem),
      urlPainel: urlPainel(), ...contexto,
    }),
  });

  for (const projeto of await listProjects()) {
    await notificarAssinantes({
      assinaturaTipo: 'resumo_diario',
      projectId: projeto.id,
      exato: true, // "todos os projetos" já foi coberto pela chamada acima
      chaveIncidente: `${projeto.id}:${data}`,
      montarMensagem: async (contexto) => {
        const { totals } = await computeMetrics(projeto.id, { from: ontem, to: ontem });
        return emailResumoDiario({ escopo: projeto.name, data: ontem, kpis: totals, urlPainel: urlPainel(), ...contexto });
      },
    });
  }
}

async function avaliarResumoSemanal() {
  const { data, hora, diaSemana } = agoraNoFuso();
  if (diaSemana !== 'Mon' || hora < 8) return;
  if (!(await existeAssinanteDoTipo('resumo_semanal'))) return;

  const semanaAtualInicio = deslocarDias(data, 7);
  const semanaAtualFim = deslocarDias(data, 1);
  const semanaAnteriorInicio = deslocarDias(data, 14);
  const semanaAnteriorFim = deslocarDias(data, 8);
  const periodo = `${semanaAtualInicio} a ${semanaAtualFim}`;

  await notificarAssinantes({
    assinaturaTipo: 'resumo_semanal',
    projectId: null,
    chaveIncidente: `todos:${semanaAtualInicio}`,
    montarMensagem: async (contexto) => emailResumoSemanal({
      escopo: 'todos os projetos', periodo,
      atual: await agregarKpisTodosProjetos(semanaAtualInicio, semanaAtualFim),
      anterior: await agregarKpisTodosProjetos(semanaAnteriorInicio, semanaAnteriorFim),
      urlPainel: urlPainel(), ...contexto,
    }),
  });

  for (const projeto of await listProjects()) {
    await notificarAssinantes({
      assinaturaTipo: 'resumo_semanal',
      projectId: projeto.id,
      exato: true,
      chaveIncidente: `${projeto.id}:${semanaAtualInicio}`,
      montarMensagem: async (contexto) => {
        const atual = (await computeMetrics(projeto.id, { from: semanaAtualInicio, to: semanaAtualFim })).totals;
        const anterior = (await computeMetrics(projeto.id, { from: semanaAnteriorInicio, to: semanaAnteriorFim })).totals;
        return emailResumoSemanal({ escopo: projeto.name, periodo, atual, anterior, urlPainel: urlPainel(), ...contexto });
      },
    });
  }
}

// ---------------------------------------------------------------- laço principal

const AVALIADORES = [
  avaliarEntregaMorta, avaliarFalhaRecorrente, avaliarFilaAcumulada,
  avaliarDominioProblema, avaliarResumoDiario, avaliarResumoSemanal,
];

/**
 * Um tick do motor. Chamado pelo worker uma vez por minuto (ver src/worker.js). Cada
 * gatilho é isolado: um tipo quebrado não impede os outros de rodar nem propaga erro
 * para quem chamou — a falha crítica que o worker precisa proteger é a fila de entrega,
 * não este laço de conforto.
 */
export async function tick() {
  for (const avaliar of AVALIADORES) {
    try {
      await avaliar();
    } catch (err) {
      log('error', 'falha ao avaliar gatilho de notificação — seguindo para os próximos tipos', {
        gatilho: avaliar.name, error: err.message,
      });
    }
  }
}

/**
 * E-mail de teste sob demanda (POST /api/notificacoes/destinatarios/:id/teste). Não
 * passa pela idempotência de incidente — é uma ação explícita do admin, pode repetir
 * quantas vezes quiser.
 */
export async function enviarNotificacaoTeste(destinatario) {
  if (!_internos.emailConfigurado()) return { enviado: false, motivo: 'SMTP não configurado' };

  const contexto = await contextoDestinatario(destinatario);
  const msg = emailTesteNotificacao({ nome: destinatario.nome, urlPainel: urlPainel(), ...contexto });
  const resultado = await _internos.enviarEmail({ para: destinatario.email, ...msg });
  return { enviado: resultado.enviado, ...(!resultado.enviado && { motivo: resultado.erro }) };
}
