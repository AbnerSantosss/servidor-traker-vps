// Testes da FASE F6 (backend): eventos em tempo real via SSE + Postgres LISTEN/NOTIFY.
// Cobre os dois módulos novos: src/db/notificacoes.js (o barramento LISTEN/NOTIFY em si)
// e src/admin/stream.js (o endpoint SSE que o painel consome), além de confirmar que
// recordEvent/processDelivery continuam funcionando quando a publicação falha — a
// invariante mais importante da fase: tempo real é conforto, ingestão é crítica.
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { createUser } from '../src/db/repos/users.js';
import { createProject } from '../src/db/repos/projects.js';
import { recordEvent } from '../src/db/repos/events.js';
import { publicar, assinar, pararAssinatura, _internos } from '../src/db/notificacoes.js';
import { _config, _clientesAtivos } from '../src/admin/stream.js';

// Acelera o que em produção é 25s/20 conexões — sem isto, testar o heartbeat de verdade
// levaria 25 segundos e testar o limite exigiria abrir 20 conexões reais.
_config.heartbeatMs = 60;
_config.limiteConexoes = 3;

// Espera até `condicao()` ser verdadeira ou estourar o timeout — usado em vez de um
// `sleep` fixo porque a entrega de NOTIFY do Postgres é assíncrona (nunca instantânea o
// bastante para um `await` simples logo depois de publicar).
async function esperarAte(condicao, timeoutMs = 2000, intervaloMs = 20) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (await condicao()) return true;
    await new Promise((r) => setTimeout(r, intervaloMs));
  }
  return false;
}

function evento({ eventId, eventName = 'purchase', valor = 10 }) {
  return {
    event_id: eventId,
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    source: 'web',
    event_source_url: '',
    action_source: 'website',
    user_data: {},
    custom_data: valor !== undefined ? { value: valor, currency: 'BRL' } : {},
    consent_state: {},
    page: {},
  };
}

// Abre uma conexão SSE de verdade contra o servidor de teste e vai acumulando os bytes
// recebidos num array, para os testes poderem inspecionar o que chegou até agora sem
// travar esperando o stream terminar (ele nunca termina sozinho).
function conectarSSE(url, cookie) {
  const controller = new AbortController();
  const pedacos = [];
  let statusPromiseResolve;
  const statusPromise = new Promise((r) => { statusPromiseResolve = r; });

  const feito = fetch(url, { headers: { Cookie: cookie }, signal: controller.signal })
    .then(async (res) => {
      statusPromiseResolve(res);
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pedacos.push(decoder.decode(value));
        }
      } catch {
        // Abortado de propósito no fim do teste — não é falha.
      }
    })
    .catch(() => {});

  return {
    controller,
    pedacos,
    status: statusPromise,
    feito,
    texto: () => pedacos.join(''),
    fechar() { controller.abort(); return feito; },
  };
}

let servidor;
let base;
let cookie = '';

const apiFetch = (caminho, opcoes = {}) =>
  fetch(`${base}${caminho}`, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...opcoes.headers },
  });

before(async () => {
  await runMigrations();
  await query('TRUNCATE events, deliveries, identities, destinations, project_domains, projects, sessions, user_tokens, users CASCADE');
  await createUser({ email: 'teste@empresa.com', password: 'senha-de-teste-123', name: 'Teste' });

  servidor = createApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'teste@empresa.com', password: 'senha-de-teste-123' }),
  });
  cookie = login.headers.getSetCookie().find((c) => c.startsWith('traker_sess=')).split(';')[0];
});

after(async () => {
  await new Promise((r) => servidor.close(r));
  // Encerra a conexão dedicada de LISTEN (usada pelo módulo inteiro, inclusive por
  // src/admin/stream.js) — sem isto o processo deste arquivo de teste ficaria com um
  // socket aberto pendurado.
  await pararAssinatura();
  await closePool();
});

// ================================================================== notificacoes.js (puro)

describe('publicar/assinar — LISTEN/NOTIFY ponta a ponta', () => {
  test('uma mensagem publicada num canal chega ao assinante daquele canal', async () => {
    const recebidos = [];
    const cancelar = await assinar(['trk_teste_ponta_a_ponta'], (dados) => recebidos.push(dados));
    try {
      await publicar('trk_teste_ponta_a_ponta', { ola: 'mundo', numero: 42 });
      const chegou = await esperarAte(() => recebidos.length > 0);
      assert.ok(chegou, 'a notificação deveria ter chegado ao assinante dentro do timeout');
      assert.deepEqual(recebidos[0], { ola: 'mundo', numero: 42 });
    } finally {
      cancelar();
    }
  });

  test('assinante de um canal não recebe mensagem publicada em outro canal', async () => {
    const recebidos = [];
    const cancelar = await assinar(['trk_teste_canal_a'], (dados) => recebidos.push(dados));
    try {
      await publicar('trk_teste_canal_b', { nao: 'deveria chegar' });
      // Espera um pouco para dar chance de (não) chegar, em vez de checar na hora.
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(recebidos.length, 0);
    } finally {
      cancelar();
    }
  });
});

describe('recordEvent — resiliência quando a publicação de tempo real falha', () => {
  test('o evento continua sendo gravado mesmo com publicar() falhando (best-effort)', async () => {
    const original = _internos.query;
    _internos.query = async () => {
      throw new Error('falha simulada de publicação de tempo real');
    };
    try {
      const projeto = await createProject({ name: 'Projeto Publicação Falha', domain: 'pub-falha.com' });
      const resultado = await recordEvent({
        project: projeto,
        event: evento({ eventId: 'pub-falha-1' }),
        destinationTypes: ['meta'],
      });

      assert.equal(resultado.duplicate, false, 'a gravação não pode ser afetada pela falha de publicação');
      assert.ok(resultado.id);

      const { rows } = await query('SELECT id, event_id FROM events WHERE id = $1', [resultado.id]);
      assert.equal(rows.length, 1, 'o evento precisa estar gravado no banco mesmo com a notificação falhando');
      assert.equal(rows[0].event_id, 'pub-falha-1');
    } finally {
      _internos.query = original;
    }
  });
});

// ================================================================== stream.js (SSE)

describe('GET /api/projects/:id/stream — autenticação', () => {
  test('sem cookie de sessão, responde 401', async () => {
    const projeto = await createProject({ name: 'Projeto Auth SSE', domain: 'auth-sse.com' });
    const r = await fetch(`${base}/api/projects/${projeto.id}/stream`);
    assert.equal(r.status, 401);
  });
});

describe('GET /api/projects/:id/stream — contrato do protocolo', () => {
  test('responde text/event-stream e manda heartbeat periódico', async () => {
    const projeto = await createProject({ name: 'Projeto Contrato SSE', domain: 'contrato-sse.com' });
    const con = conectarSSE(`${base}/api/projects/${projeto.id}/stream`, cookie);
    try {
      const res = await con.status;
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type').startsWith('text/event-stream'));

      const chegouHeartbeat = await esperarAte(() => con.texto().includes(': ping'));
      assert.ok(chegouHeartbeat, 'deveria ter recebido ao menos um heartbeat dentro do timeout');
    } finally {
      await con.fechar();
    }
  });

  test('projeto inexistente responde 404, não abre o stream', async () => {
    const r = await apiFetch('/api/projects/prj_inexistente/stream');
    assert.equal(r.status, 404);
  });
});

describe('GET /api/projects/:id/stream — isolamento entre projetos', () => {
  test('evento do projeto A nunca chega ao cliente conectado no projeto B', async () => {
    const projA = await createProject({ name: 'Isolamento SSE A', domain: 'isolamento-sse-a.com' });
    const projB = await createProject({ name: 'Isolamento SSE B', domain: 'isolamento-sse-b.com' });

    const conA = conectarSSE(`${base}/api/projects/${projA.id}/stream`, cookie);
    const conB = conectarSSE(`${base}/api/projects/${projB.id}/stream`, cookie);

    try {
      await conA.status;
      await conB.status;
      // Garante que as duas conexões já estão de fato recebendo bytes (heartbeat) antes
      // de gravar o evento — sem isto, um teste "passaria" só porque o cliente nem
      // tinha conectado ainda a tempo de receber o evento_novo.
      await esperarAte(() => conA.texto().includes(': ping'));
      await esperarAte(() => conB.texto().includes(': ping'));

      await recordEvent({
        project: projA,
        event: evento({ eventId: 'iso-sse-a-1' }),
        destinationTypes: [],
      });

      const chegouNaA = await esperarAte(() => conA.texto().includes('evento_novo'));
      assert.ok(chegouNaA, 'o cliente do projeto A deveria ter recebido o evento_novo');

      // Dá uma folga extra depois que A já recebeu, para garantir que B teve tempo de
      // "vazar" o evento se o isolamento estivesse quebrado.
      await new Promise((r) => setTimeout(r, 200));

      assert.ok(conA.texto().includes('"iso-sse-a-1"'), 'o payload que chegou em A precisa ser o evento certo');
      assert.ok(!conB.texto().includes('evento_novo'), 'o cliente do projeto B NUNCA pode receber evento do projeto A');
    } finally {
      await Promise.all([conA.fechar(), conB.fechar()]);
    }
  });
});

describe('GET /api/projects/:id/stream — limite de conexões', () => {
  test('acima do limite, responde 503 em vez de acumular conexão', async () => {
    const projeto = await createProject({ name: 'Projeto Limite SSE', domain: 'limite-sse.com' });
    const url = `${base}/api/projects/${projeto.id}/stream`;

    const abertas = [];
    try {
      // Abre exatamente o limite configurado (3, ver _config no topo do arquivo) — todas
      // precisam ser aceitas.
      for (let i = 0; i < _config.limiteConexoes; i++) {
        const con = conectarSSE(url, cookie);
        const res = await con.status;
        assert.equal(res.status, 200, `conexão ${i + 1} deveria ser aceita (dentro do limite)`);
        abertas.push(con);
      }

      // Mais uma, além do limite: precisa ser recusada com 503, não ficar pendurada.
      const excedente = await apiFetch(url.replace(base, ''));
      assert.equal(excedente.status, 503);
      const corpo = await excedente.json();
      assert.ok(corpo.error);
    } finally {
      await Promise.all(abertas.map((c) => c.fechar()));
    }
  });
});

describe('GET /api/projects/:id/stream — limpeza ao fechar', () => {
  test('fechar a conexão remove o cliente do registro (sem vazar timer nem entrada)', async () => {
    const projeto = await createProject({ name: 'Projeto Limpeza SSE', domain: 'limpeza-sse.com' });
    const antes = _clientesAtivos();

    const con = conectarSSE(`${base}/api/projects/${projeto.id}/stream`, cookie);
    await con.status;
    await esperarAte(() => con.texto().includes(': ping'));
    assert.equal(_clientesAtivos(), antes + 1, 'a conexão aberta precisa aparecer no registro');

    await con.fechar();
    const limpou = await esperarAte(() => _clientesAtivos() === antes);
    assert.ok(limpou, 'depois de fechar, o registro precisa voltar ao tamanho de antes (sem vazamento)');
  });
});
