// Teste de contrato — protege as invariantes I-3 ("publicProject só acrescenta campos,
// nunca renomeia nem muda tipo") e I-4 ("endpoints existentes intactos") descritas em
// docs/15-convencoes-do-painel.md.
//
// O painel (public/admin/*.js) lê estas respostas por nome de chave. Fases futuras vão
// mexer em src/db/repos e em src/admin/router.js sem que quem mexe necessariamente saiba
// tudo que o front consome hoje — este teste é a rede de segurança: qualquer chave que o
// front já depende e que sumir ou for renomeada quebra a suíte na hora, antes de virar
// bug silencioso em produção. Campo NOVO não quebra (o front ignora o que não conhece);
// só a REMOÇÃO ou a RENOMEAÇÃO de um campo já existente quebra.
//
// Este arquivo roda ao lado de test/integracao.test.js, que também sobe a aplicação e
// mexe no MESMO Postgres real. `node --test` roda arquivos de teste em processos
// separados e em paralelo, e o outro arquivo faz TRUNCATE das tabelas compartilhadas
// no próprio before() dele — por isso, DE PROPÓSITO, este arquivo evita TRUNCATE
// (não é dono exclusivo do banco), usa um domínio de projeto único por execução (para
// nunca colidir com dado que sobrou de uma rodada anterior) e revalida a fixture antes
// de cada teste, recriando-a se um TRUNCATE concorrente a tiver apagado no meio do
// caminho. `runMigrations()` é idempotente (`IF NOT EXISTS`), mas duas migrações rodando
// no mesmo instante em processos diferentes podem colidir por uma fração de segundo —
// daí o retry.
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { closePool } from '../src/db/pool.js';
import { createUser } from '../src/db/repos/users.js';
import { getProject } from '../src/db/repos/projects.js';
import { claimDeliveries } from '../src/db/repos/events.js';
import { processDelivery } from '../src/queue/dispatcher.js';

const EMAIL = 'contrato@empresa.com';
const SENHA = 'senha-de-teste-123';

let servidor;
let base;
let cookie = '';
let projeto; // id do projeto de fixture — pode ser reatribuído por garantirFixture()
let slug;

const fetchOriginal = globalThis.fetch;
// A Meta é interceptada só para a entrega ter algo determinístico para responder —
// o conteúdo da resposta não importa para este teste, só que exista uma entrega
// processada para os campos de `destinations` aparecerem no /events.
globalThis.fetch = async (url, options) => {
  const alvo = String(url);
  if (alvo.includes('graph.facebook.com')) {
    return new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace-contrato' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return fetchOriginal(url, options);
};

const api = (caminho, opcoes = {}) =>
  fetchOriginal(`${base}${caminho}`, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...opcoes.headers },
  });

// Confere que cada chave de `esperadas` existe em `obj` — não que só elas existem.
// É essa assimetria que faz campo novo não quebrar o teste e campo removido/renomeado
// quebrar: `in` não se importa com o que sobra, só com o que deveria estar lá.
function assertChaves(obj, esperadas, contexto) {
  assert.ok(obj && typeof obj === 'object', `${contexto}: esperava um objeto`);
  for (const chave of esperadas) {
    assert.ok(chave in obj, `${contexto}: campo "${chave}" sumiu ou foi renomeado`);
  }
}

// Duas migrações simultâneas (este arquivo e test/integracao.test.js) podem colidir por
// uma fração de segundo num `CREATE TABLE IF NOT EXISTS` — o check-then-create não é
// atômico entre sessões distintas no Postgres. O erro é sempre 23505 (chave duplicada);
// tentar de novo depois que a outra sessão commitou resolve, porque a migração em si é
// idempotente.
async function runMigrationsComRetentativa() {
  for (let tentativa = 1; tentativa <= 5; tentativa++) {
    try {
      await runMigrations();
      return;
    } catch (err) {
      if (err.code !== '23505' || tentativa === 5) throw err;
      await new Promise((r) => setTimeout(r, 150 * tentativa));
    }
  }
}

// Papel OPERADOR de propósito, não admin: test/integracao.test.js roda no mesmo banco
// (sem truncar um o do outro, ver nota no topo) e tem casos que contam quantos admins
// existem ("não é possível remover o último admin"). Um admin a mais criado por este
// arquivo bagunçaria essa contagem lá; operador tem acesso de sobra para tudo que os
// quatro endpoints deste teste exigem (nenhum deles é requireAdmin — só o endpoint de
// ingest-token é, e por isso o token é lido direto do banco logo abaixo, sem passar
// pela API).
async function garantirSessao() {
  if (cookie) {
    const me = await api('/api/auth/me');
    if (me.status === 200) return;
  }
  await createUser({ email: EMAIL, password: SENHA, name: 'Contrato', role: 'operador' }).catch(() => {});
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: SENHA }) });
  const setCookie = login.headers.getSetCookie().find((c) => c.startsWith('traker_sess='));
  // Login pode falhar (sem Set-Cookie) se um TRUNCATE concorrente tiver apagado o
  // usuário bem entre o createUser acima e este login — lança em vez de estourar um
  // TypeError obscuro em `.split`, para o retry de garantirFixture() ter um erro
  // reconhecível para tentar de novo.
  if (!setCookie) throw new Error(`login da fixture falhou (status ${login.status})`);
  cookie = setCookie.split(';')[0];
}

// Cria o projeto de fixture com Meta habilitada, um evento e uma entrega processada —
// o suficiente para os quatro endpoints devolverem dado real em vez de listas vazias
// (uma lista vazia não exercitaria as chaves aninhadas de item). O domínio leva
// timestamp + sufixo aleatório para nunca colidir com sobra de uma execução anterior,
// já que este arquivo não trunca a tabela de projetos.
async function criarFixture() {
  const dominio = `contrato-teste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.com.br`;
  const criado = await (await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Contrato', domain: dominio }),
  })).json();
  if (!criado || !criado.id) throw new Error(`criação do projeto de fixture falhou: ${JSON.stringify(criado)}`);
  projeto = criado.id;
  slug = criado.slug;

  await api(`/api/projects/${projeto}/meta`, {
    method: 'PUT',
    body: JSON.stringify({ enabled: true, pixelId: '123456789012345', eventMap: { purchase: 'Purchase' } }),
  });

  // Lido direto do banco, não pelo endpoint GET /ingest-token: aquele é requireAdmin,
  // e a sessão deste arquivo é operador de propósito (ver garantirSessao()).
  const { ingestToken } = await getProject(projeto);

  await fetchOriginal(`${base}/e/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ingestToken}` },
    body: JSON.stringify({
      event_name: 'purchase',
      event_id: 'contrato-1',
      user_data: { email: 'a@b.com' },
      custom_data: { value: 99.9, currency: 'BRL' },
    }),
  });
  for (const item of await claimDeliveries(10)) await processDelivery(item);
}

// Chamado no início de cada teste: revalida sessão e fixture, recriando o que um
// TRUNCATE concorrente tiver apagado. Na execução normal (sem corrida com outro
// arquivo) isso é só um GET a mais por teste — custo desprezível perto do valor de não
// depender de ordem de execução entre processos.
//
// A sequência inteira (sessão → checar projeto → recriar) vai dentro do retry, não só
// a parte que falhou: o TRUNCATE concorrente é um evento único e pontual, mas pode
// cair em QUALQUER chamada de rede no meio do caminho (a próxima chamada depois dele
// vai ver o dado sumido e falhar de um jeito ou de outro); tentar a sequência de novo
// do zero depois de uma pausa curta é mais simples e mais robusto do que tentar
// adivinhar em qual passo exato a corrida aconteceu.
async function garantirFixture() {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= 5; tentativa++) {
    try {
      await garantirSessao();
      if (projeto) {
        const res = await api(`/api/projects/${projeto}`);
        if (res.status === 200) return;
      }
      await criarFixture();
      return;
    } catch (err) {
      ultimoErro = err;
      await new Promise((r) => setTimeout(r, 150 * tentativa));
    }
  }
  throw ultimoErro;
}

before(async () => {
  await runMigrationsComRetentativa();

  servidor = createApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;

  await garantirFixture();
});

after(async () => {
  globalThis.fetch = fetchOriginal;
  await new Promise((r) => servidor.close(r));
  await closePool();
});

// ---------------------------------------------------------------- publicProject
// Espelha exatamente src/admin/router.js#publicProject — é a função que monta a
// resposta para /projects e /projects/:id.
const CHAVES_PROJETO = [
  'id', 'name', 'domain', 'slug', 'status', 'createdAt', 'temIngestToken',
  'urls', 'meta', 'google', 'postback',
];
// `scriptGtm` e `scriptUnica` são as tags únicas (com e sem GTM). O painel monta o
// código de instalação a partir delas: se sumirem da resposta, a aba Instalação passa
// a mostrar a URL de fallback montada no front, que ignora o PUBLIC_BASE_URL.
const CHAVES_PROJETO_URLS = [
  'base', 'evento', 'coleta', 'scriptColetor', 'scriptTag', 'scriptGtm', 'scriptUnica',
];
const CHAVES_PROJETO_META = ['enabled', 'pixelId', 'testEventCode', 'eventMap', 'hasAccessToken'];
const CHAVES_PROJETO_GOOGLE = [
  'enabled', 'route', 'measurementId', 'ga4ClientId', 'clientId', 'customerId',
  'loginCustomerId', 'conversionActions', 'eventMap',
  'hasApiSecret', 'hasClientSecret', 'hasRefreshToken', 'hasDeveloperToken',
];
const CHAVES_PROJETO_POSTBACK = ['enabled', 'url', 'method', 'headers', 'events', 'hasBearerToken'];

function assertFormatoProjeto(p, contexto) {
  assertChaves(p, CHAVES_PROJETO, contexto);
  assertChaves(p.urls, CHAVES_PROJETO_URLS, `${contexto}.urls`);
  assertChaves(p.meta, CHAVES_PROJETO_META, `${contexto}.meta`);
  assertChaves(p.google, CHAVES_PROJETO_GOOGLE, `${contexto}.google`);
  assertChaves(p.postback, CHAVES_PROJETO_POSTBACK, `${contexto}.postback`);
}

describe('contrato: GET /api/projects', () => {
  test('cada projeto da listagem mantém o formato publicProject', async () => {
    await garantirFixture();
    const lista = await (await api('/api/projects')).json();
    assert.ok(Array.isArray(lista), 'o painel espera array puro, não { items: [] }');
    const meu = lista.find((p) => p.id === projeto);
    assert.ok(meu, 'a fixture deveria aparecer na listagem');
    assertFormatoProjeto(meu, 'GET /api/projects[i]');
  });
});

describe('contrato: GET /api/projects/:id', () => {
  test('o detalhe do projeto mantém o formato publicProject', async () => {
    await garantirFixture();
    const p = await (await api(`/api/projects/${projeto}`)).json();
    assertFormatoProjeto(p, 'GET /api/projects/:id');
  });
});

// ---------------------------------------------------------------- eventos
const CHAVES_EVENTO = [
  'id', 'event_id', 'event_name', 'receivedAt', 'source', 'value', 'currency',
  'utm_source', 'payment_method', 'coupon', 'order_id', 'destinations',
];
const CHAVES_EVENTO_DESTINO = ['status', 'httpStatus', 'attempts', 'response'];

describe('contrato: GET /api/projects/:id/events', () => {
  test('cada evento mantém as chaves que o painel (aba Logs) consome', async () => {
    await garantirFixture();
    const eventos = await (await api(`/api/projects/${projeto}/events`)).json();
    assert.ok(Array.isArray(eventos), 'o painel espera array puro, não { items: [] }');
    const compra = eventos.find((e) => e.event_id === 'contrato-1');
    assert.ok(compra, 'a fixture deveria ter gravado o evento de compra');
    assertChaves(compra, CHAVES_EVENTO, 'GET /api/projects/:id/events[i]');

    assert.ok(compra.destinations.meta, 'a entrega para a Meta deveria aparecer em destinations');
    assertChaves(compra.destinations.meta, CHAVES_EVENTO_DESTINO, 'events[i].destinations.meta');
  });
});

// ---------------------------------------------------------------- métricas
const CHAVES_METRICAS = ['totals', 'byDay', 'byUtmSource', 'byEventName', 'byDestination'];
const CHAVES_METRICAS_TOTALS = ['events', 'purchases', 'revenue', 'signUps', 'avgTicket', 'successRate'];
const CHAVES_METRICAS_BYDAY = ['date', 'events'];
const CHAVES_METRICAS_BYUTM = ['source', 'count'];
const CHAVES_METRICAS_BYEVENT = ['name', 'count'];
const CHAVES_METRICAS_BYDEST_ITEM = ['success', 'error', 'off'];

describe('contrato: GET /api/projects/:id/metrics', () => {
  test('a forma consumida pelo dashboard continua intacta', async () => {
    await garantirFixture();
    const m = await (await api(`/api/projects/${projeto}/metrics`)).json();
    assertChaves(m, CHAVES_METRICAS, 'GET /api/projects/:id/metrics');
    assertChaves(m.totals, CHAVES_METRICAS_TOTALS, 'metrics.totals');

    assert.ok(Array.isArray(m.byDay) && m.byDay.length > 0, 'a fixture deveria gerar ao menos um dia');
    assertChaves(m.byDay[0], CHAVES_METRICAS_BYDAY, 'metrics.byDay[i]');

    assert.ok(Array.isArray(m.byUtmSource) && m.byUtmSource.length > 0);
    assertChaves(m.byUtmSource[0], CHAVES_METRICAS_BYUTM, 'metrics.byUtmSource[i]');

    assert.ok(Array.isArray(m.byEventName) && m.byEventName.length > 0);
    assertChaves(m.byEventName[0], CHAVES_METRICAS_BYEVENT, 'metrics.byEventName[i]');

    assert.ok(!Array.isArray(m.byDestination), 'byDestination é um mapa por destino, não array');
    assert.ok(m.byDestination.meta, 'a fixture deveria ter gerado entrega para a Meta');
    assertChaves(m.byDestination.meta, CHAVES_METRICAS_BYDEST_ITEM, 'metrics.byDestination.meta');
  });
});
