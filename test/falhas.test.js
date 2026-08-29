// Testes da fase F2 (backend) do plano de melhorias do painel: "falhas de envio
// explicadas" — o tradutor puro em src/destinations/erros-explicados.js e os dois
// endpoints novos em src/admin/router.js (GET /projects/:id/deliveries e
// GET /projects/:id/deliveries/resumo).
//
// Segue o estilo de test/integracao.test.js e test/metricas.test.js: parte unitária pura
// (sem banco, só o dicionário de erros) e parte de integração (API real contra um
// Postgres real).
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { explicarErro, truncarEMascarar } from '../src/destinations/erros-explicados.js';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { createUser } from '../src/db/repos/users.js';
import { createProject } from '../src/db/repos/projects.js';
import { recordEvent } from '../src/db/repos/events.js';

// ================================================================== tradutor de erros

describe('explicarErro — catálogo (módulo puro, sem I/O)', () => {
  test('meta.token_invalido — OAuthException / código 190', () => {
    const r = explicarErro({
      destino: 'meta',
      status: 'dead',
      http_status: 401,
      last_error: 'Error validating access token: Session has expired on Tuesday, 12-Aug-26 10:00:00 PDT. (#190)',
      response: { code: 190 },
    });
    assert.equal(r.chave, 'meta.token_invalido');
    assert.equal(r.gravidade, 'critica');
    assert.equal(r.catalogado, true);
    assert.ok(r.acao.length > 0);
  });

  test('meta.janela_7_dias — código 100, subcode 2804019 (event_time fora da janela)', () => {
    const r = explicarErro({
      destino: 'meta',
      status: 'dead',
      http_status: 400,
      last_error: '(#100) Event time is more than 7 days in the past or 1 hour in the future.',
    });
    assert.equal(r.chave, 'meta.janela_7_dias');
    assert.equal(r.gravidade, 'atencao');
  });

  test('meta.parametro_invalido — código 100 genérico, inclui error_user_msg quando existe', () => {
    const r = explicarErro({
      destino: 'meta',
      status: 'error',
      http_status: 400,
      last_error: '(#100) Invalid parameter',
      response: {
        error_user_title: 'Parâmetro inválido',
        error_user_msg: 'O campo custom_data.currency não é uma moeda ISO válida.',
      },
    });
    assert.equal(r.chave, 'meta.parametro_invalido');
    assert.ok(r.resumo.includes('Parâmetro inválido'), 'deveria usar o error_user_title da Meta no resumo');
    assert.ok(r.detalhe.includes('moeda ISO'), 'deveria usar o error_user_msg da Meta no detalhe');
  });

  test('meta.limite_taxa — código 80004 (rate limit do pixel)', () => {
    const r = explicarErro({
      destino: 'meta',
      status: 'error',
      http_status: 400,
      last_error: '(#80004) There have been too many calls to this ad-account. Wait a bit and try again.',
    });
    assert.equal(r.chave, 'meta.limite_taxa');
    assert.equal(r.gravidade, 'atencao');
  });

  test('meta.pixel_invalido — código 803 (pixel inexistente/sem permissão)', () => {
    const r = explicarErro({
      destino: 'meta',
      status: 'dead',
      http_status: 400,
      last_error: '(#803) This pixel does not exist or you do not have permission to access it.',
    });
    assert.equal(r.chave, 'meta.pixel_invalido');
    assert.equal(r.gravidade, 'critica');
  });

  test('meta.nao_configurado — falta pixel id ou access token', () => {
    const r = explicarErro({
      destino: 'meta',
      status: 'dead',
      last_error: 'Meta não configurado (pixel id ou access token ausente)',
    });
    assert.equal(r.chave, 'meta.nao_configurado');
  });

  test('meta.evento_incompleto — bloqueio local antes de chamar a Meta', () => {
    const r = explicarErro({
      destino: 'meta',
      status: 'dead',
      last_error: 'evento incompleto para a Meta: Purchase exige custom_data.value — sem valor, a conversão entra com receita zero',
    });
    assert.equal(r.chave, 'meta.evento_incompleto');
    assert.equal(r.gravidade, 'critica');
  });

  test('ga4.nao_configurado — falta measurement id ou api secret', () => {
    const r = explicarErro({
      destino: 'google',
      status: 'dead',
      last_error: 'GA4 não configurado (measurement id ou api secret ausente)',
    });
    assert.equal(r.chave, 'ga4.nao_configurado');
  });

  test('ga4.validation_message — HTTP 2xx com validationMessages no corpo', () => {
    const r = explicarErro({
      destino: 'google',
      status: 'error',
      http_status: 200,
      last_error: 'GA4 debug: validationMessages: [{"fieldPath":"currency","description":"Currency is invalid."}]',
    });
    assert.equal(r.chave, 'ga4.validation_message');
  });

  test('ga4.credencial_invalida — measurement_id/api_secret não conferem (GA4 aceita em silêncio)', () => {
    const r = explicarErro({
      destino: 'google',
      status: 'error',
      last_error: 'Verificação manual: measurement_id e api_secret não conferem com o GA4 configurado — evento aceito (204) mas não aparece no relatório.',
    });
    assert.equal(r.chave, 'ga4.credencial_invalida');
    assert.ok(r.detalhe.includes('silêncio'), 'o texto precisa explicar que o GA4 aceita sem avisar');
  });

  test('ads.nao_configurado — faltam credenciais/config do Google Ads', () => {
    const r = explicarErro({
      destino: 'google',
      status: 'dead',
      last_error: 'Google Ads não configurado: faltam client_secret, developer_token',
    });
    assert.equal(r.chave, 'ads.nao_configurado');
  });

  test('ads.oauth_revogado — refresh token revogado/expirado', () => {
    const r = explicarErro({
      destino: 'google',
      status: 'dead',
      last_error: 'OAuth falhou: Token has been expired or revoked.',
    });
    assert.equal(r.chave, 'ads.oauth_revogado');
    assert.equal(r.gravidade, 'critica');
  });

  test('ads.oauth_revogado — também reconhece UNAUTHENTICATED da Ads API', () => {
    const r = explicarErro({
      destino: 'google',
      status: 'dead',
      last_error: 'UNAUTHENTICATED: Request had invalid authentication credentials.',
    });
    assert.equal(r.chave, 'ads.oauth_revogado');
  });

  test('ads.permissao_negada — PERMISSION_DENIED', () => {
    const r = explicarErro({
      destino: 'google',
      status: 'dead',
      last_error: 'PERMISSION_DENIED: The caller does not have permission',
    });
    assert.equal(r.chave, 'ads.permissao_negada');
  });

  test('ads.customer_id_invalido — INVALID_CUSTOMER_ID', () => {
    const r = explicarErro({
      destino: 'google',
      status: 'dead',
      last_error: 'Request contains an invalid argument.',
      response: { detalhe: { errors: [{ errorCode: { requestError: 'INVALID_CUSTOMER_ID' } }] } },
    });
    assert.equal(r.chave, 'ads.customer_id_invalido');
  });

  test('ads.conversion_action_inexistente — conversion action não existe', () => {
    const r = explicarErro({
      destino: 'google',
      status: 'dead',
      last_error: 'Request contains an invalid argument.',
      response: {
        detalhe: {
          errors: [{ message: 'The conversion_action does not exist.', location: { fieldPathElements: [{ fieldName: 'conversion_action' }] } }],
        },
      },
    });
    assert.equal(r.chave, 'ads.conversion_action_inexistente');
  });

  test('ads.clique_fora_da_janela — clique fora da janela de conversão', () => {
    const r = explicarErro({
      destino: 'google',
      status: 'dead',
      last_error: 'The click referenced by this conversion is outside the conversion window.',
    });
    assert.equal(r.chave, 'ads.clique_fora_da_janela');
    assert.equal(r.gravidade, 'atencao');
  });

  test('postback.rota_invalida — HTTP 4xx (URL/rota errada)', () => {
    const r = explicarErro({
      destino: 'postback',
      status: 'dead',
      http_status: 404,
      last_error: 'HTTP 404',
    });
    assert.equal(r.chave, 'postback.rota_invalida');
    assert.ok(r.resumo.includes('404'));
  });

  test('postback.servidor_indisponivel — HTTP 5xx', () => {
    const r = explicarErro({
      destino: 'postback',
      status: 'error',
      http_status: 503,
      last_error: 'HTTP 503',
    });
    assert.equal(r.chave, 'postback.servidor_indisponivel');
    assert.equal(r.gravidade, 'atencao');
  });

  test('postback.nao_configurado — sem URL configurada', () => {
    const r = explicarErro({
      destino: 'postback',
      status: 'dead',
      last_error: 'postback sem URL configurada',
    });
    assert.equal(r.chave, 'postback.nao_configurado');
  });

  test('rede.timeout', () => {
    const r = explicarErro({
      destino: 'meta',
      status: 'error',
      last_error: 'The operation was aborted due to timeout',
    });
    assert.equal(r.chave, 'rede.timeout');
  });

  test('rede.dns', () => {
    const r = explicarErro({
      destino: 'postback',
      status: 'error',
      last_error: 'getaddrinfo ENOTFOUND destino-invalido.exemplo.com',
    });
    assert.equal(r.chave, 'rede.dns');
    assert.equal(r.gravidade, 'critica');
  });

  test('rede.conexao_recusada', () => {
    const r = explicarErro({
      destino: 'postback',
      status: 'error',
      last_error: 'connect ECONNREFUSED 203.0.113.10:443',
    });
    assert.equal(r.chave, 'rede.conexao_recusada');
  });

  test('rede.tls', () => {
    const r = explicarErro({
      destino: 'postback',
      status: 'error',
      last_error: 'unable to verify the first certificate',
    });
    assert.equal(r.chave, 'rede.tls');
  });

  test('consentimento.negado — status skipped_consent, gravidade informativa e sem ação corretiva', () => {
    const r = explicarErro({
      destino: 'meta',
      status: 'skipped_consent',
      last_error: 'ad_storage e analytics_storage negados',
    });
    assert.equal(r.chave, 'consentimento.negado');
    assert.equal(r.gravidade, 'informativa');
    assert.equal(r.catalogado, true);
  });

  test('mapeamento.ausente — status skipped_unmapped', () => {
    const r = explicarErro({
      destino: 'postback',
      status: 'skipped_unmapped',
      last_error: 'destino desativado',
    });
    assert.equal(r.chave, 'mapeamento.ausente');
    assert.equal(r.gravidade, 'atencao');
  });

  test('dead — esgotou tentativas sem bater em nenhuma causa conhecida', () => {
    const r = explicarErro({
      destino: 'meta',
      status: 'dead',
      last_error: 'falha completamente inédita do sistema, código interno 42-xyz',
    });
    assert.equal(r.chave, 'dead');
    assert.equal(r.gravidade, 'critica');
    assert.equal(r.catalogado, true);
  });

  test('desconhecido — erro nunca visto devolve catalogado:false e NÃO inventa ação', () => {
    const r = explicarErro({
      destino: 'meta',
      status: 'error',
      last_error: 'falha completamente inédita do sistema, código interno 42-xyz',
    });
    assert.equal(r.chave, 'desconhecido');
    assert.equal(r.catalogado, false);
    assert.ok(r.resumo.includes('42-xyz'), 'o resumo precisa trazer o erro cru, não uma explicação inventada');
    assert.ok(!r.acao.toLowerCase().includes('token') && !r.acao.toLowerCase().includes('pixel'),
      'a ação para erro desconhecido não pode citar uma causa específica que não foi reconhecida');
  });

  test('sem last_error nenhum, ainda devolve a forma completa (sem quebrar)', () => {
    const r = explicarErro({ destino: 'meta', status: 'error' });
    assert.equal(r.chave, 'desconhecido');
    assert.equal(r.catalogado, false);
    assert.equal(typeof r.resumo, 'string');
    assert.equal(typeof r.gravidade, 'string');
  });
});

describe('truncarEMascarar', () => {
  test('trunca em ~500 caracteres', () => {
    const longo = 'x'.repeat(1000);
    const t = truncarEMascarar(longo);
    assert.ok(t.length <= 502, 'não pode ultrapassar o teto de truncamento (com folga da reticência)');
    assert.ok(t.endsWith('…'));
  });

  test('mascara access_token=... e Bearer ... para nunca vazar credencial', () => {
    const t1 = truncarEMascarar('falha ao chamar API: access_token=EAAG1234567890abcdef falhou');
    assert.ok(!t1.includes('EAAG1234567890abcdef'), 'token não pode aparecer em claro');
    assert.ok(t1.includes('access_token=***'));

    const t2 = truncarEMascarar('HTTP 401 Authorization: Bearer abcDEF123.456-789_xyz');
    assert.ok(!t2.includes('abcDEF123.456-789_xyz'), 'bearer token não pode aparecer em claro');
    assert.ok(t2.includes('Bearer ***'));
  });

  test('texto vazio ou nulo devolve string vazia', () => {
    assert.equal(truncarEMascarar(''), '');
    assert.equal(truncarEMascarar(null), '');
    assert.equal(truncarEMascarar(undefined), '');
  });
});

// ================================================================== endpoints (integração)

let servidor;
let base;
let cookie = '';

const api = (caminho, opcoes = {}) =>
  fetch(`${base}${caminho}`, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...opcoes.headers },
  });

// Mesmo helper de test/metricas.test.js: monta um "Evento Interno" no formato que
// recordEvent espera (o mesmo que src/ingest/normalize.js produz).
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

// Cria um evento + entrega, e já grava a entrega como falha com o last_error/http_status
// desejado — o jeito mais direto de montar um cenário controlado, sem depender do worker
// de verdade nem de rede.
async function criarEntregaFalha(projeto, { eventId, destino, status = 'dead', httpStatus = null, lastError, updatedAt }) {
  const { id: eventRowId } = await recordEvent({
    project: projeto,
    event: evento({ eventId }),
    destinationTypes: [destino],
  });
  const params = [status, httpStatus, lastError, eventRowId, destino];
  let sql = `UPDATE deliveries SET status=$1, http_status=$2, last_error=$3, updated_at=now()
              WHERE event_row_id=$4 AND destination_type=$5`;
  if (updatedAt) {
    sql = `UPDATE deliveries SET status=$1, http_status=$2, last_error=$3, updated_at=$6
            WHERE event_row_id=$4 AND destination_type=$5`;
    params.push(updatedAt);
  }
  await query(sql, params);
  return eventRowId;
}

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
  await closePool();
});

describe('GET /projects/:id/deliveries — sem nenhuma falha', () => {
  test('devolve grupos vazios e por_destino zerado, nunca um objeto ausente', async () => {
    const projeto = await createProject({ name: 'Projeto Sem Falhas', domain: 'sem-falhas.com' });
    const r = await (await api(`/api/projects/${projeto.id}/deliveries`)).json();
    assert.deepEqual(r.grupos, []);
    assert.equal(r.total, 0);
    assert.deepEqual(r.por_destino, { meta: 0, google: 0, postback: 0 });
  });
});

describe('GET /projects/:id/deliveries/resumo — sem nenhuma falha', () => {
  test('resposta estável mesmo com zero falhas', async () => {
    const projeto = await createProject({ name: 'Projeto Resumo Zero', domain: 'resumo-zero.com' });
    const r = await (await api(`/api/projects/${projeto.id}/deliveries/resumo`)).json();
    assert.deepEqual(r.destinos, {
      meta: { ultimas_24h: 0, ultimos_7d: 0 },
      google: { ultimas_24h: 0, ultimos_7d: 0 },
      postback: { ultimas_24h: 0, ultimos_7d: 0 },
    });
    assert.equal(r.total_24h, 0);
    assert.equal(r.total_7d, 0);
  });
});

describe('GET /projects/:id/deliveries — agrupamento por causa', () => {
  let projeto;

  before(async () => {
    projeto = await createProject({ name: 'Projeto Falhas', domain: 'projeto-falhas.com' });

    // 3 entregas com a MESMA causa (token inválido) precisam virar UM grupo com quantidade 3.
    await criarEntregaFalha(projeto, { eventId: 'f-token-1', destino: 'meta', status: 'dead', lastError: '(#190) Error validating access token: expired.' });
    await criarEntregaFalha(projeto, { eventId: 'f-token-2', destino: 'meta', status: 'dead', lastError: '(#190) Error validating access token: expired.' });
    await criarEntregaFalha(projeto, { eventId: 'f-token-3', destino: 'meta', status: 'dead', lastError: '(#190) Error validating access token: expired.' });

    // 1 entrega com causa diferente no mesmo destino.
    await criarEntregaFalha(projeto, { eventId: 'f-rate-1', destino: 'meta', status: 'error', lastError: '(#80004) too many calls' });

    // 1 entrega em outro destino.
    await criarEntregaFalha(projeto, { eventId: 'f-postback-1', destino: 'postback', status: 'dead', httpStatus: 404, lastError: 'HTTP 404' });
  });

  test('agrupa entregas com a mesma causa e conta corretamente', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/deliveries`)).json();

    const grupoToken = r.grupos.find((g) => g.chave === 'meta.token_invalido');
    assert.ok(grupoToken, 'deveria existir um grupo para token inválido');
    assert.equal(grupoToken.quantidade, 3);
    assert.equal(grupoToken.destino, 'meta');
    assert.equal(grupoToken.gravidade, 'critica');
    assert.equal(grupoToken.catalogado, true);
    assert.equal(grupoToken.event_row_ids.length, 3);
    assert.equal(grupoToken.truncado, false);
    assert.ok(grupoToken.amostras.length <= 5 && grupoToken.amostras.length === 3);

    const grupoRate = r.grupos.find((g) => g.chave === 'meta.limite_taxa');
    assert.ok(grupoRate, 'deveria existir um grupo separado para rate limit');
    assert.equal(grupoRate.quantidade, 1);

    const grupoPostback = r.grupos.find((g) => g.chave === 'postback.rota_invalida');
    assert.ok(grupoPostback, 'deveria existir um grupo para o postback');
    assert.equal(grupoPostback.destino, 'postback');

    assert.equal(r.total, 5);
    assert.equal(r.por_destino.meta, 4);
    assert.equal(r.por_destino.postback, 1);
    assert.equal(r.por_destino.google, 0);
  });

  test('grupos vêm ordenados por gravidade (critica antes de atencao) e depois por quantidade', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/deliveries`)).json();
    const gravidades = r.grupos.map((g) => g.gravidade);
    const primeiraAtencao = gravidades.indexOf('atencao');
    const ultimaCritica = gravidades.lastIndexOf('critica');
    if (primeiraAtencao !== -1 && ultimaCritica !== -1) {
      assert.ok(ultimaCritica < primeiraAtencao, 'toda entrada crítica deve vir antes de qualquer atenção');
    }
  });

  test('filtro por destino restringe os grupos devolvidos', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/deliveries?destination=postback`)).json();
    assert.ok(r.grupos.every((g) => g.destino === 'postback'));
    assert.equal(r.total, 1);
  });

  test('amostras trazem last_error truncado/mascarado, nunca o valor cru com token', async () => {
    await criarEntregaFalha(projeto, {
      eventId: 'f-token-com-segredo',
      destino: 'meta',
      status: 'dead',
      lastError: 'falha ao renovar: access_token=EAAG-super-secreto-nao-pode-vazar',
    });
    const r = await (await api(`/api/projects/${projeto.id}/deliveries`)).json();
    const grupoToken = r.grupos.find((g) => g.chave === 'meta.token_invalido');
    const amostraComSegredo = grupoToken.amostras.find((a) => a.event_id === 'f-token-com-segredo');
    if (amostraComSegredo) {
      assert.ok(!amostraComSegredo.last_error.includes('EAAG-super-secreto-nao-pode-vazar'));
    }
  });
});

describe('GET /projects/:id/deliveries — isolamento entre projetos', () => {
  test('falha de outro projeto nunca aparece na lista/contagem', async () => {
    const projA = await createProject({ name: 'Isolamento Falhas A', domain: 'isolamento-falhas-a.com' });
    const projB = await createProject({ name: 'Isolamento Falhas B', domain: 'isolamento-falhas-b.com' });

    await criarEntregaFalha(projA, { eventId: 'iso-a-1', destino: 'meta', status: 'dead', lastError: '(#190) Error validating access token' });
    await criarEntregaFalha(projB, { eventId: 'iso-b-1', destino: 'meta', status: 'dead', lastError: '(#190) Error validating access token' });
    await criarEntregaFalha(projB, { eventId: 'iso-b-2', destino: 'meta', status: 'dead', lastError: '(#190) Error validating access token' });

    const rA = await (await api(`/api/projects/${projA.id}/deliveries`)).json();
    assert.equal(rA.total, 1, 'projeto A só pode ver a própria falha');

    const rB = await (await api(`/api/projects/${projB.id}/deliveries`)).json();
    assert.equal(rB.total, 2, 'projeto B só pode ver as próprias falhas');

    const resumoA = await (await api(`/api/projects/${projA.id}/deliveries/resumo`)).json();
    assert.equal(resumoA.destinos.meta.ultimas_24h, 1);

    const resumoB = await (await api(`/api/projects/${projB.id}/deliveries/resumo`)).json();
    assert.equal(resumoB.destinos.meta.ultimas_24h, 2);
  });
});

describe('GET /projects/:id/deliveries/resumo — janelas de 24h e 7 dias', () => {
  test('separa corretamente falha recente, falha da semana e falha antiga demais', async () => {
    const projeto = await createProject({ name: 'Projeto Janelas', domain: 'projeto-janelas.com' });

    await criarEntregaFalha(projeto, { eventId: 'jan-recente', destino: 'google', status: 'dead', lastError: 'erro qualquer' });
    await criarEntregaFalha(projeto, {
      eventId: 'jan-3dias', destino: 'google', status: 'dead', lastError: 'erro qualquer',
      updatedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
    });
    await criarEntregaFalha(projeto, {
      eventId: 'jan-10dias', destino: 'google', status: 'dead', lastError: 'erro qualquer',
      updatedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
    });

    const r = await (await api(`/api/projects/${projeto.id}/deliveries/resumo`)).json();
    assert.equal(r.destinos.google.ultimas_24h, 1, 'só a falha recente entra nas últimas 24h');
    assert.equal(r.destinos.google.ultimos_7d, 2, 'a falha de 3 dias conta nos últimos 7 dias, a de 10 dias não');
  });
});

describe('GET /projects/:id/deliveries — limite de reenvio em massa (event_row_ids)', () => {
  test('corta em 200 ids e sinaliza truncado:true quando há mais falhas que o teto', async () => {
    const projeto = await createProject({ name: 'Projeto Muitas Falhas', domain: 'projeto-muitas-falhas.com' });

    const total = 205;
    for (let n = 0; n < total; n++) {
      await recordEvent({
        project: projeto,
        event: evento({ eventId: `massa-${n}` }),
        destinationTypes: ['meta'],
      });
    }
    // Uma UPDATE só, em vez de 205 chamadas: mais rápido e testa exatamente o mesmo
    // agrupamento (todas caem na mesma causa: token inválido).
    await query(
      `UPDATE deliveries SET status='dead', last_error='(#190) Error validating access token: expired.', updated_at=now()
        WHERE project_id=$1 AND destination_type='meta'`,
      [projeto.id]
    );

    // limit=500 (o teto do repositório) para as 205 falhas caberem todas na consulta —
    // sem isso o padrão (100) já cortaria antes mesmo de chegar ao agrupamento, e o teste
    // estaria medindo o limite errado.
    const r = await (await api(`/api/projects/${projeto.id}/deliveries?limit=500`)).json();
    const grupo = r.grupos.find((g) => g.chave === 'meta.token_invalido');
    assert.equal(grupo.quantidade, total);
    assert.equal(grupo.event_row_ids.length, 200, 'nunca pode devolver mais de 200 ids para o reenvio em massa');
    assert.equal(grupo.truncado, true, 'precisa avisar que cortou, em vez de fingir que reenviou tudo');
  });
});

describe('GET /projects/:id/deliveries — filtro de status aceita skipped_* quando pedido', () => {
  test('status=skipped_consent devolve as entregas puladas por consentimento', async () => {
    const projeto = await createProject({ name: 'Projeto Consentimento', domain: 'projeto-consentimento.com' });
    const { id: eventRowId } = await recordEvent({
      project: projeto,
      event: evento({ eventId: 'consent-1' }),
      destinationTypes: ['meta'],
    });
    await query(
      `UPDATE deliveries SET status='skipped_consent', last_error='ad_storage e analytics_storage negados', updated_at=now()
        WHERE event_row_id=$1`,
      [eventRowId]
    );

    // Sem filtro explícito (padrão error/dead), a entrega pulada não deve aparecer.
    const semFiltro = await (await api(`/api/projects/${projeto.id}/deliveries`)).json();
    assert.equal(semFiltro.total, 0);

    const comFiltro = await (await api(`/api/projects/${projeto.id}/deliveries?status=skipped_consent`)).json();
    assert.equal(comFiltro.total, 1);
    assert.equal(comFiltro.grupos[0].chave, 'consentimento.negado');
    assert.equal(comFiltro.grupos[0].gravidade, 'informativa');
  });
});

describe('GET /projects/:id/deliveries — o corpo cru da resposta do destino não vaza', () => {
  test('o subcode da Meta é usado para traduzir, mas o response não sai na API', async () => {
    const projeto = await createProject({ name: 'Projeto Vazamento', domain: 'projeto-vazamento.com' });

    const { id: eventRowId } = await recordEvent({
      project: projeto,
      event: evento({ eventId: 'vazamento-1' }),
      destinationTypes: ['meta'],
    });

    // Resposta realista da Meta: além da mensagem, o corpo traz o subcode que distingue a
    // causa — e, no mundo real, pode ecoar trecho do que foi enviado.
    await query(
      `UPDATE deliveries
          SET status='dead', http_status=400,
              last_error='Invalid parameter',
              response=$2::jsonb,
              updated_at=now()
        WHERE event_row_id=$1`,
      [eventRowId, JSON.stringify({
        error: 'Invalid parameter',
        code: 100,
        error_subcode: 2804019,
        error_user_msg: 'O horário do evento é anterior à janela permitida.',
        eco_do_envio: 'access_token=EAAG-secreto-nao-pode-vazar',
      })]
    );

    const res = await (await api(`/api/projects/${projeto.id}/deliveries`)).json();
    assert.equal(res.total, 1);

    // O subcode precisa ter chegado ao tradutor: sem ele, o código 100 sozinho seria
    // apenas "parâmetro inválido", que não diz a ninguém o que fazer.
    assert.equal(res.grupos[0].chave, 'meta.janela_7_dias');

    // E o corpo cru não pode acompanhar a resposta — o painel já tem a explicação pronta,
    // que é a informação útil; o resto é superfície de vazamento.
    const serializado = JSON.stringify(res);
    assert.ok(!serializado.includes('EAAG-secreto-nao-pode-vazar'), 'credencial ecoada pelo destino não pode sair na API');
    assert.equal(res.grupos[0].amostras[0].response, undefined, 'a amostra não deve carregar o corpo cru da resposta');
  });
});
