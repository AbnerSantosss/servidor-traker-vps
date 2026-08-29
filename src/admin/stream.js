// Tempo real do painel: Server-Sent Events alimentado por LISTEN/NOTIFY do Postgres
// (src/db/notificacoes.js). SSE e não WebSocket de propósito: é HTTP puro — o Express já
// sabe escrever num stream de resposta, o navegador já sabe reconectar sozinho (com
// backoff) via `EventSource`, e o cookie de sessão já vai junto sem código extra. Nenhuma
// dependência nova (nem `ws`, nem lib de SSE) é necessária para nada disto.
import { Router } from 'express';
import { requireAuth } from './auth.js';
import { getProject } from '../db/repos/projects.js';
import { getEventRow } from '../db/repos/events.js';
import { query } from '../db/pool.js';
import { assinar, CANAL_EVENTOS, CANAL_ENTREGAS } from '../db/notificacoes.js';
import { truncarEMascarar } from '../destinations/erros-explicados.js';
import { log } from '../config/log.js';

export const streamRouter = Router();
streamRouter.use(requireAuth);

/**
 * Valores ajustáveis SÓ pelo teste automatizado, para não precisar esperar 25s de verdade
 * nem abrir 20 conexões de verdade para provar o limite. Em produção ninguém toca nisto —
 * os campos ficam com o padrão (25s de heartbeat, 20 conexões). Mesmo espírito do
 * `_internos` de src/db/notificacoes.js: um ponto de substituição explícito, sem
 * biblioteca de mock.
 */
export const _config = {
  heartbeatMs: 25_000,
  // Painel interno, não uma API pública: 20 é folga generosa para qualquer operação
  // legítima (um punhado de operadores, cada um com uma aba do projeto aberta) e baixo o
  // bastante para estourar antes de uma aba esquecida em N máquinas virar um vazamento de
  // conexão silencioso com o banco.
  limiteConexoes: 20,
};

// clienteId -> { res, projectId, heartbeat }. Registro em memória do processo — nunca
// persiste em banco, porque é só roteamento de quem está com uma aba aberta agora.
const clientes = new Map();
let proximoClienteId = 1;

// Só para o teste confirmar que fechar a conexão realmente limpa o registro (sem isto,
// vazar uma entrada por conexão fechada derruba o processo depois de horas de painel
// aberto, exatamente o risco que a fase pediu para evitar).
export function _clientesAtivos() {
  return clientes.size;
}

function enviarSSE(res, evento, dados) {
  // Sem `id:` de propósito: implementar de verdade a retomada por Last-Event-ID exigiria
  // guardar um backlog de eventos perdidos durante a desconexão, o que este módulo não
  // faz. Prometer retomada que não existe (mandar `id:` e o navegador confiar nisso) é
  // pior do que não prometer nada — ver anotação no relatório da fase.
  res.write(`event: ${evento}\n`);
  res.write(`data: ${JSON.stringify(dados)}\n\n`);
}

// Mesma proteção que já existe para a tela de "falhas explicadas" (src/admin/router.js):
// `last_error` vem de um terceiro (Meta/Google/postback) e já aconteceu de mensagem de
// erro carregar fragmento de token por engano. `response`, por outro lado, já viaja cru
// para o painel hoje via GET /projects/:id/events (listEvents) — não há regressão em
// manter esse mesmo comportamento aqui.
function entregaSegura(row) {
  return {
    ...row,
    last_error: row.last_error ? truncarEMascarar(row.last_error) : row.last_error,
  };
}

// `events.payload` já sai da ingestão com a PII hasheada (redactForStorage, aplicado em
// src/ingest/router.js ANTES de recordEvent gravar) — reaproveita esse mascaramento em
// vez de escrever um segundo filtro aqui. O registro que este módulo busca no banco já é
// o mesmo "registro completo mascarado" que a invariante I-8 exige; só serializa as datas.
function eventoSeguro(row) {
  return {
    ...row,
    received_at: row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at,
    occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
  };
}

async function buscarEntrega(id) {
  const { rows } = await query('SELECT * FROM deliveries WHERE id = $1', [id]);
  return rows[0] || null;
}

// Manda para todo cliente conectado NAQUELE projeto — o roteamento por projeto acontece
// aqui, em memória, não no Postgres (o NOTIFY já chega pra este processo inteiro; quem
// filtra por projeto somos nós). Isolamento entre clientes de projetos diferentes é o pior
// bug possível aqui, por isso o filtro é a primeira linha do laço, não uma checagem depois.
function despachar(projectId, evento, dados) {
  for (const cliente of clientes.values()) {
    if (cliente.projectId !== projectId) continue;
    enviarSSE(cliente.res, evento, dados);
  }
}

/**
 * Única assinatura LISTEN por processo (I-11): todo cliente SSE, de qualquer projeto,
 * escuta a MESMA conexão dedicada — nunca uma conexão de banco por aba de painel aberta.
 * Assinado uma vez, na carga do módulo, não a cada requisição.
 */
assinar([CANAL_EVENTOS, CANAL_ENTREGAS], async (aviso) => {
  if (!aviso || !aviso.project_id || !aviso.id) return;
  try {
    if (aviso.tipo === 'evento') {
      const row = await getEventRow(aviso.id);
      if (row) despachar(aviso.project_id, 'evento_novo', eventoSeguro(row));
    } else if (aviso.tipo === 'entrega') {
      const row = await buscarEntrega(aviso.id);
      if (row) despachar(aviso.project_id, 'entrega_atualizada', entregaSegura(row));
    }
  } catch (err) {
    // Falha ao buscar o registro completo (banco momentaneamente indisponível, etc.) não
    // pode derrubar a assinatura inteira — só este aviso específico se perde.
    log('error', 'falha ao processar notificação de tempo real', { error: err.message });
  }
});

streamRouter.get('/:id/stream', async (req, res) => {
  // Express 4 não captura rejeição de Promise em handler async sozinho — um try/catch
  // próprio é necessário para não deixar a requisição pendurada nem vazar stack trace
  // (mesmo espírito do `wrap()` de src/admin/router.js, que não é exportado daquele
  // módulo).
  try {
    // Mesma checagem que `loadProject` faz em src/admin/router.js: projeto inexistente é
    // 404, não uma conexão SSE que fica aberta sem nunca mandar nada.
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'projeto não encontrado' });

    if (clientes.size >= _config.limiteConexoes) {
      log('warn', 'conexão de tempo real recusada: limite atingido', { limite: _config.limiteConexoes });
      return res.status(503).json({
        error: 'limite de conexões de tempo real atingido — feche alguma aba do painel e tente de novo',
      });
    }

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Sem isto, um proxy no meio do caminho (Caddy, nginx) pode bufferizar a resposta e
      // entregar os eventos em rajadas em vez de um por vez — o oposto de "tempo real".
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const clienteId = proximoClienteId++;

    // Comentário SSE (linha começando com `:`) — não é um evento, o navegador o ignora,
    // mas mantém a conexão viva contra qualquer timeout de proxy no meio do caminho para
    // uma conexão ociosa (sem tráfego de eventos de verdade por um tempo).
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, _config.heartbeatMs);

    clientes.set(clienteId, { res, projectId: project.id });

    // Limpeza: sem isto, o timer do heartbeat continua rodando para sempre depois que o
    // navegador já foi embora, e o registro em `clientes` nunca esvazia — é exatamente o
    // vazamento que derruba o processo depois de algumas horas de painel em uso.
    req.on('close', () => {
      clearInterval(heartbeat);
      clientes.delete(clienteId);
    });
  } catch (err) {
    log('error', 'falha ao abrir conexão de tempo real', { rota: req.originalUrl, error: err.message });
    if (!res.headersSent) res.status(500).json({ error: 'erro interno' });
  }
});
