// Teste de integração ponta a ponta contra um PostgreSQL real.
//
// Sobe a API de verdade, cria projeto pelo painel, coleta identidade, envia evento e
// processa a entrega — com a chamada à Meta interceptada. Cobre justamente o que teste
// unitário não pega: idempotência por constraint, enriquecimento pela ponte de
// identidade e o formato que o painel consome.
//
// Requer um Postgres acessível. Padrão: postgres://traker:traker@localhost:55432/traker_test
//   docker run -d --name traker-test-db -e POSTGRES_USER=traker -e POSTGRES_PASSWORD=traker \
//     -e POSTGRES_DB=traker_test -p 55432:5432 postgres:16-alpine
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe, before, after } from 'node:test';
import { existsSync as fsExistsSync } from 'node:fs';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { pool, query, closePool } from '../src/db/pool.js';
import { createUser, createUserToken } from '../src/db/repos/users.js';
import { claimDeliveries } from '../src/db/repos/events.js';
import { processDelivery } from '../src/queue/dispatcher.js';

let servidor;
let base;
let cookie = '';
let projeto;
let tokenWebhook;

// Intercepta só as chamadas às plataformas; o resto continua indo pela rede de verdade.
const fetchOriginal = globalThis.fetch;
let chamadasMeta = [];
let respostaMeta = { ok: true, status: 200, body: { events_received: 1, fbtrace_id: 'trace-teste' } };

globalThis.fetch = async (url, options) => {
  const alvo = String(url);
  if (alvo.includes('graph.facebook.com')) {
    chamadasMeta.push({ url: alvo, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(respostaMeta.body), {
      status: respostaMeta.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (alvo.includes('google-analytics.com')) {
    return new Response(null, { status: 204 });
  }
  return fetchOriginal(url, options);
};

const api = (caminho, opcoes = {}) =>
  fetchOriginal(`${base}${caminho}`, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...opcoes.headers },
  });

before(async () => {
  await runMigrations();
  // Banco limpo a cada execução para o teste ser determinístico.
  await query('TRUNCATE events, deliveries, identities, destinations, project_domains, projects, sessions, user_tokens, users CASCADE');
  await createUser({ email: 'teste@empresa.com', password: 'senha-de-teste-123', name: 'Teste' });

  servidor = createApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  globalThis.fetch = fetchOriginal;
  await new Promise((r) => servidor.close(r));
  await closePool();
});

describe('autenticação do painel', () => {
  test('API do painel rejeita acesso sem sessão', async () => {
    const res = await fetchOriginal(`${base}/api/projects`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'não autenticado');
  });

  test('login com senha errada é rejeitado', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'teste@empresa.com', password: 'errada' }),
    });
    assert.equal(res.status, 401);
  });

  test('login válido devolve cookie de sessão HttpOnly', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'teste@empresa.com', password: 'senha-de-teste-123' }),
    });
    assert.equal(res.status, 200);

    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('traker_sess='));
    assert.ok(setCookie, 'deveria enviar o cookie de sessão');
    assert.match(setCookie, /HttpOnly/);
    cookie = setCookie.split(';')[0];

    assert.equal((await (await api('/api/auth/me')).json()).user.email, 'teste@empresa.com');
  });
});

// "Manter conectado" precisa esticar a SESSÃO no servidor — e só isso. Se um dia a
// implementação passar a confiar em algo guardado no navegador, ou se o teto de 30
// dias sumir, é aqui que aparece.
describe('manter conectado (sessão prolongada)', () => {
  const horasDaSessao = async (remember) => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'teste@empresa.com', password: 'senha-de-teste-123', ...(remember === undefined ? {} : { remember }) }),
    });
    assert.equal(res.status, 200);
    const token = res.headers.getSetCookie().find((c) => c.startsWith('traker_sess='));
    const expira = /Expires=([^;]+)/i.exec(token);
    assert.ok(expira, 'cookie de sessão deveria trazer Expires');
    return (new Date(expira[1]).getTime() - Date.now()) / 3600_000;
  };

  test('sem marcar, a sessão dura o padrão curto (SESSION_TTL_HOURS)', async () => {
    const horas = await horasDaSessao(undefined);
    assert.ok(horas < 24, `esperava sessão curta, veio ${horas.toFixed(1)}h`);
  });

  test('marcando, a sessão dura 30 dias', async () => {
    const horas = await horasDaSessao(true);
    assert.ok(horas > 700 && horas <= 720, `esperava ~720h, veio ${horas.toFixed(1)}h`);
  });

  test('um valor adulterado no corpo não fabrica sessão eterna', async () => {
    // O cliente manda booleano; qualquer outra coisa cai no padrão curto.
    const horas = await horasDaSessao(99999);
    assert.ok(horas < 24, `esperava sessão curta, veio ${horas.toFixed(1)}h`);
  });
});

// O atalho "entrar sem senha" foi REMOVIDO do código em 2026-08-13 — não é mais uma
// flag desligada. Estes dois testes existem para que a remoção seja permanente: quem
// reintroduzir a rota (ou o campo que a anunciava) quebra a suíte.
describe('login sem senha não existe', () => {
  test('a rota de login sem senha não abre sessão nem se distingue de uma rota inventada', async () => {
    const chamar = (caminho) => fetchOriginal(`${base}${caminho}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });

    const removida = await chamar('/api/auth/login-rapido');
    const inventada = await chamar('/api/auth/rota-que-nunca-existiu');

    // O que importa não é o número do status: é que ninguém entra por aqui.
    assert.notEqual(removida.status, 200);
    assert.equal(
      removida.headers.getSetCookie().find((c) => c.startsWith('traker_sess=')),
      undefined,
      'a rota removida jamais pode devolver cookie de sessão'
    );

    // E que ela responde exatamente como qualquer caminho inexistente — quem sonda o
    // servidor não consegue descobrir que um dia existiu um atalho aqui.
    assert.equal(removida.status, inventada.status);
  });

  test('a tela de login não recebe nenhum campo sobre atalho de acesso', async () => {
    const info = await (await fetchOriginal(`${base}/api/auth/setup-necessario`)).json();
    assert.ok(!('loginRapido' in info), 'setup-necessario não deve expor loginRapido');
    assert.deepEqual(Object.keys(info), ['setupNecessario']);
  });
});

describe('cadastro de projeto', () => {
  test('cria projeto com slug e token de ingestão', async () => {
    const res = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Código Vencedor', domain: 'codigovencedor.com' }),
    });
    assert.equal(res.status, 201);
    projeto = await res.json();

    assert.match(projeto.id, /^prj_[a-f0-9]{12}$/);
    assert.match(projeto.slug, /^[23456789bcdfghjkmnpqrstvwxyz]{8}$/);
    assert.equal(projeto.urls.evento, `http://traker.teste.local/e/${projeto.slug}`);
  });

  test('o token de webhook NÃO acompanha o payload do projeto', async () => {
    // Segredo que viaja em toda leitura acaba em cache do navegador e em log de
    // intermediário. Aqui só vem a informação de que ele existe.
    const detalhe = await (await api(`/api/projects/${projeto.id}`)).json();
    assert.equal(detalhe.temIngestToken, true);
    assert.ok(!('ingestToken' in detalhe));

    const lista = await (await api('/api/projects')).json();
    assert.ok(!lista.some((p) => 'ingestToken' in p));
  });

  test('o token é revelado sob demanda, por endpoint próprio', async () => {
    const res = await api(`/api/projects/${projeto.id}/ingest-token`);
    assert.equal(res.status, 200);
    const { ingestToken } = await res.json();
    assert.match(ingestToken, /^[a-f0-9]{48}$/);
    tokenWebhook = ingestToken; // usado nos testes de webhook adiante
  });

  test('domínio duplicado é recusado', async () => {
    const res = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Outro', domain: 'codigovencedor.com' }),
    });
    assert.equal(res.status, 409);
  });

  test('o domínio do projeto já nasce cadastrado para verificação', async () => {
    const dominios = await (await api(`/api/projects/${projeto.id}/domains`)).json();
    assert.equal(dominios.length, 1);
    assert.equal(dominios[0].hostname, 'codigovencedor.com');
    assert.equal(dominios[0].verification_status, 'pending');
  });
});

describe('credenciais', () => {
  test('salva o access token e nunca o devolve — só a flag', async () => {
    const res = await api(`/api/projects/${projeto.id}/meta`, {
      method: 'PUT',
      body: JSON.stringify({
        enabled: true,
        pixelId: '1234567890',
        accessToken: 'EAABtoken-super-secreto',
        eventMap: { purchase: 'Purchase', page_view: 'PageView' },
      }),
    });
    assert.equal(res.status, 200);
    projeto = await res.json();

    assert.equal(projeto.meta.hasAccessToken, true);
    assert.equal(projeto.meta.pixelId, '1234567890');
    assert.ok(!JSON.stringify(projeto).includes('EAABtoken-super-secreto'), 'o token não pode aparecer na resposta');
  });

  test('o token fica cifrado no banco', async () => {
    const { rows } = await query(`SELECT credentials_enc FROM destinations WHERE project_id=$1 AND type='meta'`, [projeto.id]);
    const guardado = rows[0].credentials_enc.access_token;
    assert.ok(guardado.startsWith('v1:'));
    assert.ok(!guardado.includes('EAABtoken'));
  });

  test('salvar sem mandar o token de novo preserva o valor', async () => {
    const res = await api(`/api/projects/${projeto.id}/meta`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, pixelId: '1234567890', testEventCode: 'TEST99' }),
    });
    const atualizado = await res.json();
    assert.equal(atualizado.meta.hasAccessToken, true);
    assert.equal(atualizado.meta.testEventCode, 'TEST99');
  });
});

describe('ponte de identidade e ingestão', () => {
  test('coletor grava a identidade amarrada ao user_id', async () => {
    const res = await fetchOriginal(`${base}/c/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': 'Mozilla/5.0 (Teste)' },
      body: JSON.stringify({
        user_id: 'jogador-8842',
        fbclid: 'IwAR-clique-do-anuncio',
        fbp: 'fb.1.1700000000000.987654321',
        gclid: 'Cj0KCQ-google',
        utm_source: 'facebook',
        utm_campaign: 'black-friday',
      }),
    });
    assert.equal(res.status, 202);

    const { rows } = await query('SELECT * FROM identities WHERE user_key=$1', ['jogador-8842']);
    assert.equal(rows[0].params.fbclid, 'IwAR-clique-do-anuncio');
    assert.equal(rows[0].params.utm_source, 'facebook');
    assert.ok(rows[0].params.client_ip_address, 'deveria gravar o IP do request');
  });

  test('merge nunca apaga valor bom com vazio', async () => {
    // Segunda visita: o visitante voltou por tráfego direto, sem fbclid na URL.
    await fetchOriginal(`${base}/c/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ user_id: 'jogador-8842', fbclid: '', utm_source: '', fbp: 'fb.1.1700000000000.987654321' }),
    });
    const { rows } = await query('SELECT * FROM identities WHERE user_key=$1', ['jogador-8842']);
    assert.equal(rows[0].params.fbclid, 'IwAR-clique-do-anuncio', 'o fbclid da primeira visita tem que sobreviver');
    assert.equal(rows[0].params.utm_source, 'facebook');
  });

  test('conversão de webhook sai enriquecida com o que o navegador capturou', async () => {
    const res = await fetchOriginal(`${base}/e/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenWebhook}` },
      body: JSON.stringify({
        event_name: 'purchase',
        user_id: 'jogador-8842',
        custom_data: { value: 199.9, currency: 'BRL', order_id: '8812' },
        user_data: { email: 'Cliente@Exemplo.com' },
      }),
    });
    assert.equal(res.status, 202);
    const corpo = await res.json();
    assert.equal(corpo.status, 'accepted');
    // event_id determinístico derivado do order_id
    assert.equal(corpo.event_id, 'purchase-8812');

    const { rows } = await query('SELECT * FROM events WHERE event_id=$1', ['purchase-8812']);
    const ud = rows[0].payload.user_data;
    assert.equal(ud.fbclid, 'IwAR-clique-do-anuncio', 'deveria completar o fbclid pela identidade');
    assert.equal(ud.gclid, 'Cj0KCQ-google');
    assert.equal(ud.external_id, 'jogador-8842');
    assert.equal(rows[0].source, 'webhook');
  });

  test('webhook usa o IP e o User-Agent do NAVEGADOR, não os do servidor do cliente', async () => {
    // Sem isso, a conversão de backend sairia com o IP do datacenter do cliente e um
    // User-Agent de biblioteca HTTP — dois campos de match apontando para a máquina errada.
    const UA_NAVEGADOR = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15';
    const UA_BACKEND = 'axios/1.7.2';

    await fetchOriginal(`${base}/c/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': UA_NAVEGADOR, 'X-Forwarded-For': '200.150.100.50' },
      body: JSON.stringify({ user_id: 'jogador-9001', fbclid: 'IwAR-mobile', fbp: 'fb.1.1700000000000.55' }),
    });

    await fetchOriginal(`${base}/e/${projeto.slug}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA_BACKEND,
        'X-Forwarded-For': '10.0.0.9', // IP do servidor do cliente
        Authorization: `Bearer ${tokenWebhook}`,
      },
      body: JSON.stringify({ event_name: 'purchase', event_id: 'conv-mobile', user_id: 'jogador-9001' }),
    });

    const { rows } = await query('SELECT payload FROM events WHERE event_id=$1', ['conv-mobile']);
    const ud = rows[0].payload.user_data;

    assert.equal(ud.client_user_agent, UA_NAVEGADOR, 'deveria usar o UA do visitante, não o da biblioteca HTTP');
    assert.equal(ud.client_ip_address, '200.150.100.50', 'deveria usar o IP do visitante, não o do datacenter');
    assert.equal(ud.fbclid, 'IwAR-mobile');
  });

  test('evento do navegador continua usando o IP/UA da própria requisição', async () => {
    // A exceção acima vale só para webhook: no navegador, quem faz a requisição É o visitante.
    await fetchOriginal(`${base}/e/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows)', 'X-Forwarded-For': '177.1.1.1' },
      body: JSON.stringify({ event_name: 'page_view', event_id: 'pv-navegador', user_id: 'jogador-9001' }),
    });

    const { rows } = await query('SELECT payload FROM events WHERE event_id=$1', ['pv-navegador']);
    assert.equal(rows[0].payload.user_data.client_ip_address, '177.1.1.1');
    assert.equal(rows[0].payload.user_data.client_user_agent, 'Mozilla/5.0 (Windows)');
  });

  test('PII não fica em texto plano no banco', async () => {
    const { rows } = await query('SELECT payload FROM events WHERE event_id=$1', ['purchase-8812']);
    const ud = rows[0].payload.user_data;
    assert.match(ud.email, /^[a-f0-9]{64}$/, 'e-mail deveria estar hasheado no log');
    assert.ok(!JSON.stringify(rows[0].payload).includes('Cliente@Exemplo.com'));
  });

  test('reenvio do mesmo webhook não duplica o evento (idempotência)', async () => {
    const res = await fetchOriginal(`${base}/e/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenWebhook}` },
      body: JSON.stringify({
        event_name: 'purchase',
        user_id: 'jogador-8842',
        custom_data: { value: 199.9, currency: 'BRL', order_id: '8812' },
      }),
    });
    assert.equal((await res.json()).status, 'duplicate');

    const { rows } = await query('SELECT COUNT(*)::int AS n FROM events WHERE event_id=$1', ['purchase-8812']);
    assert.equal(rows[0].n, 1);
  });

  test('token de webhook inválido é rejeitado', async () => {
    const res = await fetchOriginal(`${base}/e/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-errado' },
      body: JSON.stringify({ event_name: 'purchase' }),
    });
    assert.equal(res.status, 401);
  });

  test('payload sem event_name é recusado em vez de virar lixo no banco', async () => {
    const res = await fetchOriginal(`${base}/e/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_data: { value: 10 } }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /event_name/);
  });

  test('consentimento negado remove a PII antes de gravar', async () => {
    await fetchOriginal(`${base}/e/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_name: 'lead',
        event_id: 'sem-consentimento',
        user_data: { email: 'privado@exemplo.com', fbp: 'fb.1.1.1' },
        consent_state: { ad_user_data: 'denied' },
      }),
    });

    const { rows } = await query('SELECT payload FROM events WHERE event_id=$1', ['sem-consentimento']);
    const ud = rows[0].payload.user_data;
    assert.equal(ud.email, undefined, 'a PII não pode nem chegar ao banco quando o titular negou');
    assert.equal(ud.fbp, 'fb.1.1.1', 'identificador de navegador não é PII e permanece');
  });

  test('slug inexistente devolve 404', async () => {
    const res = await fetchOriginal(`${base}/e/naoexiste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_name: 'page_view' }),
    });
    assert.equal(res.status, 404);
  });

  test('evento do navegador renova _fbp/_fbc por Set-Cookie (mitigação de ITP)', async () => {
    const res = await fetchOriginal(`${base}/e/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Host: 'traker.codigovencedor.com' },
      body: JSON.stringify({
        event_name: 'page_view',
        event_id: 'pv-001',
        user_data: { fbp: 'fb.1.1700000000000.111' },
      }),
    });
    assert.equal(res.status, 202);
    const cookies = res.headers.getSetCookie();
    const fbp = cookies.find((c) => c.startsWith('_fbp='));
    assert.ok(fbp, 'deveria renovar o _fbp');
    assert.ok(!/HttpOnly/i.test(fbp), 'o _fbp NÃO pode ser HttpOnly — o pixel precisa lê-lo via JS');
    assert.match(fbp, /Max-Age=7776000/); // 90 dias
  });
});

describe('fila de entrega', () => {
  test('entrega pendente foi criada para o destino ativo', async () => {
    const { rows } = await query(
      `SELECT d.* FROM deliveries d JOIN events e ON e.id=d.event_row_id WHERE e.event_id='purchase-8812'`
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].destination_type, 'meta');
    assert.equal(rows[0].status, 'pending');
  });

  test('worker envia à Meta com o payload correto', async () => {
    chamadasMeta = [];
    const lote = await claimDeliveries(10);
    assert.ok(lote.length >= 1);

    for (const item of lote) await processDelivery(item);

    // Busca pelo event_id, não pelo nome: mais de um evento do lote vira "Purchase",
    // e procurar por nome tornaria a asserção dependente da ordem da fila.
    const compra = chamadasMeta.find((c) => c.body.data[0].event_id === 'purchase-8812');
    assert.ok(compra, 'deveria ter enviado o evento Purchase da conversão enriquecida');

    const ev = compra.body.data[0];
    assert.equal(ev.event_id, 'purchase-8812', 'event_id preservado para dedup');
    assert.equal(ev.custom_data.value, 199.9);
    assert.match(ev.user_data.em[0], /^[a-f0-9]{64}$/, 'e-mail hasheado');
    assert.match(ev.user_data.fbc, /^fb\.1\.\d+\.IwAR-clique-do-anuncio$/, 'fbc derivado do fbclid da identidade');
    assert.ok(!/^[a-f0-9]{64}$/.test(ev.user_data.fbc), 'fbc não pode ser hasheado');
    assert.equal(compra.body.access_token, 'EAABtoken-super-secreto', 'token decifrado corretamente');
    assert.equal(compra.body.test_event_code, 'TEST99');
  });

  test('entrega bem-sucedida é registrada', async () => {
    const { rows } = await query(
      `SELECT d.* FROM deliveries d JOIN events e ON e.id=d.event_row_id WHERE e.event_id='purchase-8812'`
    );
    assert.equal(rows[0].status, 'success');
    assert.equal(rows[0].http_status, 200);
    assert.equal(rows[0].response.events_received, 1);
  });

  test('erro 4xx de configuração não é retentado (vai direto para dead)', async () => {
    respostaMeta = { status: 400, body: { error: { message: 'Invalid access token', code: 190 } } };

    await fetchOriginal(`${base}/e/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_name: 'purchase', event_id: 'vai-falhar', custom_data: { value: 10 } }),
    });

    for (const item of await claimDeliveries(10)) await processDelivery(item);

    const { rows } = await query(
      `SELECT d.* FROM deliveries d JOIN events e ON e.id=d.event_row_id WHERE e.event_id='vai-falhar'`
    );
    assert.equal(rows[0].status, 'dead', 'token inválido não deve ser retentado');
    assert.match(rows[0].last_error, /Invalid access token/);

    respostaMeta = { ok: true, status: 200, body: { events_received: 1, fbtrace_id: 'trace-teste' } };
  });

  test('erro 5xx é retentado com backoff', async () => {
    respostaMeta = { status: 503, body: { error: { message: 'Service unavailable' } } };

    await fetchOriginal(`${base}/e/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_name: 'purchase', event_id: 'vai-retentar', custom_data: { value: 10 } }),
    });

    for (const item of await claimDeliveries(10)) await processDelivery(item);

    const { rows } = await query(
      `SELECT d.* FROM deliveries d JOIN events e ON e.id=d.event_row_id WHERE e.event_id='vai-retentar'`
    );
    assert.equal(rows[0].status, 'error', 'deveria ficar agendado para nova tentativa');
    assert.ok(new Date(rows[0].next_attempt_at) > new Date(), 'backoff deveria empurrar a próxima tentativa');

    respostaMeta = { ok: true, status: 200, body: { events_received: 1, fbtrace_id: 'trace-teste' } };
  });

  test('reenvio manual recoloca na fila', async () => {
    const { rows } = await query(`SELECT id FROM events WHERE event_id='vai-falhar'`);
    const res = await api(`/api/events/${rows[0].id}/requeue`, { method: 'POST' });
    assert.equal(res.status, 200);

    const { rows: entregas } = await query('SELECT * FROM deliveries WHERE event_row_id=$1', [rows[0].id]);
    assert.equal(entregas[0].status, 'pending');
    assert.equal(entregas[0].attempts, 0);
  });
});

describe('formato consumido pelo painel', () => {
  test('lista de eventos vem como array puro com destinations por destino', async () => {
    const eventos = await (await api(`/api/projects/${projeto.id}/events`)).json();
    assert.ok(Array.isArray(eventos), 'o painel espera array puro, não { items: [] }');

    const compra = eventos.find((e) => e.event_id === 'purchase-8812');
    assert.ok(compra.id && compra.receivedAt && compra.event_name);
    assert.equal(compra.destinations.meta.status, 'success');
    assert.equal(compra.destinations.meta.httpStatus, 200);
  });

  test('métricas têm a forma exata que o dashboard consome', async () => {
    const m = await (await api(`/api/projects/${projeto.id}/metrics`)).json();

    for (const chave of ['events', 'purchases', 'revenue', 'signUps', 'avgTicket', 'successRate']) {
      assert.ok(chave in m.totals, `totals.${chave} ausente`);
    }
    assert.ok(m.totals.successRate >= 0 && m.totals.successRate <= 1, 'successRate é fração, não percentual');
    assert.ok(Array.isArray(m.byDay) && Array.isArray(m.byUtmSource));
    assert.ok(m.byDay.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)));
    assert.ok(m.byEventName.every((e) => 'name' in e && 'count' in e));
    assert.ok(!Array.isArray(m.byDestination), 'byDestination é um mapa, não array');
  });

  test('diagnóstico de EMQ mostra a cobertura por campo', async () => {
    const emq = await (await api(`/api/projects/${projeto.id}/emq`)).json();
    assert.ok(emq.total > 0);
    const campos = Object.fromEntries(emq.coverage.map((c) => [c.field, c]));
    assert.ok(campos.client_ip_address.pct > 0, 'IP deveria estar presente em todo evento');
    assert.ok(campos.email.pct <= 1);

    const { rows } = await query('SELECT COUNT(*)::int AS n FROM identities WHERE project_id=$1', [projeto.id]);
    assert.equal(emq.identidades, rows[0].n, 'deveria refletir as identidades guardadas pela ponte');
  });

  test('a listagem de projetos não carrega o token de webhook', async () => {
    const lista = await (await api('/api/projects')).json();
    assert.ok(lista.length > 0);
    assert.ok(!('ingestToken' in lista[0]), 'o segredo do webhook não deve trafegar na listagem');

    // Nem no detalhe: lá vem só a flag. O valor sai pelo endpoint dedicado e auditado.
    const detalhe = await (await api(`/api/projects/${projeto.id}`)).json();
    assert.ok(!('ingestToken' in detalhe));
    assert.equal(detalhe.temIngestToken, true);
  });

  test('/api/servidor informa o host e os IPs para a instrução de DNS', async () => {
    const servidor = await (await api('/api/servidor')).json();
    assert.equal(servidor.publicHost, 'traker.teste.local');
    assert.equal(servidor.baseUrl, 'http://traker.teste.local');
    assert.ok(Array.isArray(servidor.ips));
  });

  test('resposta de erro usa o formato { error }', async () => {
    const res = await api('/api/projects/prj_inexistente');
    assert.equal(res.status, 404);
    assert.ok('error' in (await res.json()));
  });
});

describe('gate de emissão de certificado', () => {
  test('nega domínio não cadastrado — sem isso qualquer um emitiria certificado', async () => {
    const res = await fetchOriginal(`${base}/api/caddy/ask?domain=dominio-de-estranho.com`);
    assert.equal(res.status, 403);
  });

  test('nega domínio cadastrado cujo DNS ainda não aponta para cá', async () => {
    // Estar cadastrado no painel não basta: sem o DNS apontando, emitir certificado
    // só queimaria cota da Let's Encrypt.
    const res = await fetchOriginal(`${base}/api/caddy/ask?domain=codigovencedor.com`);
    assert.equal(res.status, 403);
  });

  test('autoriza domínio já verificado e marca o certificado como emitido', async () => {
    await query(`UPDATE project_domains SET verification_status='verified' WHERE hostname=$1`, ['codigovencedor.com']);

    const res = await fetchOriginal(`${base}/api/caddy/ask?domain=codigovencedor.com`);
    assert.equal(res.status, 200);

    const { rows } = await query('SELECT * FROM project_domains WHERE hostname=$1', ['codigovencedor.com']);
    assert.equal(rows[0].verification_status, 'active');
    assert.ok(rows[0].ssl_issued_at, 'deveria registrar quando o certificado foi emitido');
  });

  test('autoriza o host público do próprio serviço', async () => {
    const res = await fetchOriginal(`${base}/api/caddy/ask?domain=traker.teste.local`);
    assert.equal(res.status, 200);
  });

  test('exige o parâmetro domain', async () => {
    assert.equal((await fetchOriginal(`${base}/api/caddy/ask`)).status, 400);
  });
});

describe('scripts servidos first-party', () => {
  test('script coletor é servido com o endpoint do projeto embutido', async () => {
    const res = await fetchOriginal(`${base}/s/${projeto.slug}.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);

    const js = await res.text();
    assert.ok(js.includes(`/c/${projeto.slug}`), 'deveria apontar para o endpoint de coleta do projeto');
    assert.ok(js.includes('sendBeacon'));
  });

  test('tag de captura expõe window.trk', async () => {
    const js = await (await fetchOriginal(`${base}/t/${projeto.slug}.js`)).text();
    assert.ok(js.includes('window.trk'));
    assert.ok(js.includes(`/e/${projeto.slug}`));
  });

  test('slug inexistente não vaza detalhe', async () => {
    const res = await fetchOriginal(`${base}/s/naoexiste.js`);
    assert.equal(res.status, 404);
  });
});

describe('gestão de usuários e convites', () => {
  // Sem SMTP configurado nos testes, o convite não é enviado e a API devolve o link
  // para envio manual — que é exatamente o caminho que precisamos exercitar aqui.
  let convidado;
  let urlConvite;

  test('convida um operador e devolve o link quando o e-mail não sai', async () => {
    const res = await api('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({ email: 'operador@empresa.com', name: 'Operador Teste', role: 'operador' }),
    });
    assert.equal(res.status, 201);

    const corpo = await res.json();
    convidado = corpo.user;
    urlConvite = corpo.urlConvite;

    assert.equal(convidado.role, 'operador');
    assert.equal(convidado.status, 'convite_pendente');
    assert.equal(corpo.conviteEnviado, false, 'SMTP não está configurado no teste');
    assert.match(urlConvite, /\/definir-senha\?token=[a-f0-9]{64}/);
  });

  test('o convidado ainda não consegue entrar (não tem senha)', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'operador@empresa.com', password: 'qualquer-coisa' }),
    });
    assert.equal(res.status, 401);
  });

  test('e-mail duplicado é recusado', async () => {
    const res = await api('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({ email: 'operador@empresa.com', name: 'Outro', role: 'admin' }),
    });
    assert.equal(res.status, 409);
  });

  test('papel inválido é recusado', async () => {
    const res = await api('/api/usuarios', {
      method: 'POST',
      body: JSON.stringify({ email: 'x@empresa.com', role: 'superusuario' }),
    });
    assert.equal(res.status, 400);
  });

  test('o token do convite é válido e identifica o convidado', async () => {
    const token = new URL(urlConvite).searchParams.get('token');
    const info = await (await api(`/api/auth/token/${token}`)).json();
    assert.equal(info.valido, true);
    assert.equal(info.tipo, 'convite');
    assert.equal(info.email, 'operador@empresa.com');
  });

  test('o token fica hasheado no banco, nunca em claro', async () => {
    const token = new URL(urlConvite).searchParams.get('token');
    const { rows } = await query('SELECT token_hash FROM user_tokens WHERE user_id = $1', [convidado.id]);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, token);
  });

  test('reenviar convite invalida o link anterior', async () => {
    const tokenAntigo = new URL(urlConvite).searchParams.get('token');

    const res = await api(`/api/usuarios/${convidado.id}/reenviar-convite`, { method: 'POST' });
    assert.equal(res.status, 200);
    const corpo = await res.json();
    urlConvite = corpo.urlConvite;

    // Dois links válidos circulando seria uma porta a mais para o mesmo acesso.
    const antigo = await (await api(`/api/auth/token/${tokenAntigo}`)).json();
    assert.equal(antigo.valido, false);

    const novo = await (await api(`/api/auth/token/${new URL(urlConvite).searchParams.get('token')}`)).json();
    assert.equal(novo.valido, true);
  });

  test('senha curta demais é recusada', async () => {
    const token = new URL(urlConvite).searchParams.get('token');
    const res = await api('/api/auth/definir-senha', {
      method: 'POST',
      body: JSON.stringify({ token, password: '123' }),
    });
    assert.equal(res.status, 400);
  });

  test('o convidado define a senha, é autenticado na hora e vira ativo', async () => {
    const token = new URL(urlConvite).searchParams.get('token');
    const res = await api('/api/auth/definir-senha', {
      method: 'POST',
      body: JSON.stringify({ token, password: 'senha-do-operador-123' }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.getSetCookie().some((c) => c.startsWith('traker_sess=')), 'deveria já criar a sessão');

    const usuarios = await (await api('/api/usuarios')).json();
    assert.equal(usuarios.find((u) => u.email === 'operador@empresa.com').status, 'ativo');
  });

  test('o mesmo link não pode ser usado duas vezes', async () => {
    const token = new URL(urlConvite).searchParams.get('token');
    const res = await api('/api/auth/definir-senha', {
      method: 'POST',
      body: JSON.stringify({ token, password: 'outra-senha-qualquer' }),
    });
    assert.equal(res.status, 400);
  });

  test('agora o operador consegue entrar com a senha que definiu', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'operador@empresa.com', password: 'senha-do-operador-123' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.role, 'operador');
  });

  test('operador NÃO gerencia usuários', async () => {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'operador@empresa.com', password: 'senha-do-operador-123' }),
    });
    const cookieOperador = login.headers.getSetCookie().find((c) => c.startsWith('traker_sess=')).split(';')[0];

    for (const rota of ['/api/usuarios']) {
      const res = await fetchOriginal(`${base}${rota}`, { headers: { Cookie: cookieOperador } });
      assert.equal(res.status, 403, `${rota} deveria ser restrita a administradores`);
      assert.match((await res.json()).error, /administrador/);
    }

    // Mas continua enxergando os projetos — é o trabalho dele.
    const projetos = await fetchOriginal(`${base}/api/projects`, { headers: { Cookie: cookieOperador } });
    assert.equal(projetos.status, 200);
  });

  test('esqueci-senha responde igual para e-mail existente e inexistente', async () => {
    const existente = await api('/api/auth/esqueci-senha', {
      method: 'POST', body: JSON.stringify({ email: 'operador@empresa.com' }),
    });
    const inexistente = await api('/api/auth/esqueci-senha', {
      method: 'POST', body: JSON.stringify({ email: 'ninguem@lugar-nenhum.com' }),
    });

    assert.equal(existente.status, 200);
    assert.equal(inexistente.status, 200);
    // Respostas idênticas: a tela não pode virar um verificador de contas cadastradas.
    assert.deepEqual(await existente.json(), await inexistente.json());
  });

  test('trocar a senha derruba as sessões antigas', async () => {
    const login = await api('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ email: 'operador@empresa.com', password: 'senha-do-operador-123' }),
    });
    const cookieAntigo = login.headers.getSetCookie().find((c) => c.startsWith('traker_sess=')).split(';')[0];
    assert.equal((await fetchOriginal(`${base}/api/auth/me`, { headers: { Cookie: cookieAntigo } })).status, 200);

    const { rows } = await query(`SELECT id FROM users WHERE email = 'operador@empresa.com'`);
    const { token } = await createUserToken(rows[0].id, 'redefinicao');
    await api('/api/auth/definir-senha', {
      method: 'POST', body: JSON.stringify({ token, password: 'senha-nova-do-operador' }),
    });

    const depois = await fetchOriginal(`${base}/api/auth/me`, { headers: { Cookie: cookieAntigo } });
    assert.equal(depois.status, 401, 'a sessão anterior deveria ter sido invalidada');
  });

  test('não é possível remover a própria conta nem o último admin', async () => {
    const usuarios = await (await api('/api/usuarios')).json();
    const eu = usuarios.find((u) => u.email === 'teste@empresa.com');

    const proprio = await api(`/api/usuarios/${eu.id}`, { method: 'DELETE' });
    assert.equal(proprio.status, 400);
    assert.match((await proprio.json()).error, /própria conta/);

    // Rebaixar o único admin também não pode — deixaria o sistema sem administrador.
    const rebaixar = await api(`/api/usuarios/${eu.id}`, {
      method: 'PUT', body: JSON.stringify({ role: 'operador' }),
    });
    assert.equal(rebaixar.status, 400);
    assert.match((await rebaixar.json()).error, /último administrador/);
  });

  test('admin promove o operador e consegue removê-lo depois', async () => {
    const usuarios = await (await api('/api/usuarios')).json();
    const operador = usuarios.find((u) => u.email === 'operador@empresa.com');

    const promovido = await (await api(`/api/usuarios/${operador.id}`, {
      method: 'PUT', body: JSON.stringify({ role: 'admin', name: 'Operador Promovido' }),
    })).json();
    assert.equal(promovido.user.role, 'admin');
    assert.equal(promovido.user.name, 'Operador Promovido');

    const remocao = await api(`/api/usuarios/${operador.id}`, { method: 'DELETE' });
    assert.equal(remocao.status, 200);

    const restantes = await (await api('/api/usuarios')).json();
    assert.ok(!restantes.some((u) => u.email === 'operador@empresa.com'));
  });
});

describe('webhook no formato do checkout do Código Vencedor', () => {
  // Payloads reais do checkout, enviados exatamente como o site dispara.
  const payloadPix = {
    lead: { name: 'Jaksson Santana de Jesus', email: 'jakssonsantana@gmail.com', phone: '83981055357', taxId: '04595104448' },
    event: 'checkout.pix.generated', method: 'pix', eventId: '36781fb1509a47b4b2424f13c6a70147',
    pricing: { couponCode: null, discountMinor: 0, originalAmountMinor: 9700 },
    currency: 'BRL', tracking: [], gatewayId: 'mercadopago',
    paymentId: 'c5818e41-a7b5-4dea-9770-b00e681095aa', reference: null,
    sessionId: '74351d8f-7145-45a9-8475-75adf8be7d47',
    occurredAt: '2026-08-12T13:40:11.5250831+00:00', productIds: ['plan-4'], amountMinor: 9700,
    attribution: {
      utm: { term: null, medium: null, source: null, content: null, campaign: null },
      cookies: { ga: null, fbc: null, fbp: 'fb.1.1786541879715.4099310706', gclAu: null, gclid: null, fbclid: null, gbraid: null, wbraid: null },
      ipAddress: '::ffff:10.244.16.187',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
      eventSourceUrl: 'https://codigovencedor.com/',
    },
    chargeExpiresAt: '2026-08-12T13:50:11.5250647+00:00', customerReference: null,
  };

  const payloadPago = {
    ...payloadPix,
    event: 'checkout.session.completed',
    eventId: '9a712a559fe0431182894719ac73f825',
    lead: { name: 'Joao marcos rocha de araujo', email: 'joaomarcosflamengo32@gmail.com', phone: '83996031060', taxId: '04970261474' },
    pricing: { couponCode: 'TESTE99', discountMinor: 9699, originalAmountMinor: 9700 },
    paymentId: 'bedd9a1c-79f3-418f-9387-fa3ff4f96c38',
    amountMinor: 1,
    paymentStatus: 'paid',
  };

  const enviar = (payload) => fetchOriginal(`${base}/e/${projeto.slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'axios/1.7.2', 'X-Forwarded-For': '10.0.0.9', Authorization: `Bearer ${tokenWebhook}` },
    body: JSON.stringify(payload),
  });

  before(async () => {
    await api(`/api/projects/${projeto.id}/meta`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, eventMap: { purchase: 'Purchase', pix_gerado: 'AddPaymentInfo' } }),
    });
  });

  test('o formato é reconhecido e traduzido sozinho', async () => {
    const res = await enviar(payloadPix);
    assert.equal(res.status, 202);
    const corpo = await res.json();
    assert.equal(corpo.formato, 'codigo-vencedor');
    assert.equal(corpo.event_name, 'pix_gerado', 'PIX gerado não pode virar compra');
  });

  test('pagamento confirmado vira purchase', async () => {
    const corpo = await (await enviar(payloadPago)).json();
    assert.equal(corpo.event_name, 'purchase');
    assert.equal(corpo.event_id, '9a712a559fe0431182894719ac73f825');
  });

  test('valores em centavos são convertidos — não pode sair 100x maior', async () => {
    const { rows } = await query('SELECT value, currency FROM events WHERE event_id = $1', ['9a712a559fe0431182894719ac73f825']);
    assert.equal(rows[0].value, 0.01, 'amountMinor 1 = um centavo, não R$ 1,00');
    assert.equal(rows[0].currency, 'BRL');

    const { rows: pix } = await query('SELECT value FROM events WHERE event_id = $1', ['36781fb1509a47b4b2424f13c6a70147']);
    assert.equal(pix[0].value, 97, 'amountMinor 9700 = R$ 97,00');
  });

  test('IP interno do cluster não é aceito como sinal de correspondência', async () => {
    const { rows } = await query('SELECT payload FROM events WHERE event_id = $1', ['9a712a559fe0431182894719ac73f825']);
    const ud = rows[0].payload.user_data;
    assert.equal(ud.client_ip_address, undefined, '10.244.x.x é IP privado, não do comprador');
    // O User-Agent, ao contrário, é o do navegador real e deve ser aproveitado.
    assert.match(ud.client_user_agent, /Macintosh|Windows/);
  });

  test('o payload chega à Meta com os campos comerciais e o evento certo', async () => {
    chamadasMeta = [];
    for (const item of await claimDeliveries(10)) await processDelivery(item);

    const compra = chamadasMeta.find((c) => c.body.data[0].event_id === '9a712a559fe0431182894719ac73f825');
    const pix = chamadasMeta.find((c) => c.body.data[0].event_id === '36781fb1509a47b4b2424f13c6a70147');

    assert.equal(compra.body.data[0].event_name, 'Purchase');
    assert.equal(pix.body.data[0].event_name, 'AddPaymentInfo', 'PIX gerado não pode contar como receita');

    const cd = compra.body.data[0].custom_data;
    assert.equal(cd.value, 0.01);
    assert.equal(cd.currency, 'BRL');
    assert.equal(cd.payment_method, 'pix');
    assert.equal(cd.coupon, 'TESTE99');
    assert.equal(cd.valor_original, 97);
    assert.deepEqual(cd.content_ids, ['plan-4']);

    // Correspondência montada a partir de dados que o backend não mandou hasheados.
    const ud = compra.body.data[0].user_data;
    for (const campo of ['em', 'ph', 'fn', 'ln', 'external_id']) {
      assert.match(ud[campo][0], /^[a-f0-9]{64}$/, `${campo} deveria estar hasheado`);
    }
    assert.equal(ud.fbp, 'fb.1.1786541879715.4099310706', 'fbp nunca hasheado');
    assert.equal(compra.body.data[0].action_source, 'website');
  });

  test('o log do painel mostra valor, moeda e forma de pagamento', async () => {
    const eventos = await (await api(`/api/projects/${projeto.id}/events`)).json();
    const compra = eventos.find((e) => e.event_id === '9a712a559fe0431182894719ac73f825');

    assert.equal(compra.value, 0.01);
    assert.equal(compra.currency, 'BRL');
    assert.equal(compra.payment_method, 'pix');
    assert.equal(compra.coupon, 'TESTE99');
    assert.equal(compra.source, 'webhook');
  });

  test('reenvio do mesmo eventId não duplica a conversão', async () => {
    const corpo = await (await enviar(payloadPago)).json();
    assert.equal(corpo.status, 'duplicate');
  });

  test('aceita webhook na raiz, identificando o projeto pelo Host', async () => {
    // O backoffice do cliente cadastra o endpoint como "https://dominio.com", sem
    // caminho. Migrar para cá não pode exigir editar o endpoint lá.
    // O cliente HTTP do Node ignora o header Host (é proibido); o servidor lê o
    // X-Forwarded-Host, que é justamente o que o Caddy envia em produção.
    const res = await fetchOriginal(`${base}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'codigovencedor.com' },
      body: JSON.stringify({
        event: 'purchase_approved',
        eventId: 'via-host-1',
        occurredAt: new Date().toISOString(),
        amountMinor: 9700,
        currency: 'BRL',
        lead: { name: 'Teste Host', email: 'host@exemplo.com', phone: '11987654321' },
        attribution: { utm: {}, cookies: { fbp: 'fb.1.1.1' }, ipAddress: '187.45.22.10', userAgent: 'Mozilla/5.0', eventSourceUrl: 'https://codigovencedor.com/' },
      }),
    });
    assert.equal(res.status, 202);
    const corpo = await res.json();
    assert.equal(corpo.event_name, 'purchase');
    assert.equal(corpo.formato, 'codigo-vencedor');
  });

  test('hostname não cadastrado não vira porta aberta na raiz', async () => {
    const res = await fetchOriginal(`${base}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'dominio-de-estranho.com' },
      body: JSON.stringify({ event_name: 'purchase' }),
    });
    assert.equal(res.status, 404);
  });

  test('a ponte de identidade recupera o clique que o webhook não conhece', async () => {
    // O navegador capturou o fbclid quando o visitante chegou pelo anúncio, guardado
    // sob a chave da sessão de checkout.
    await fetchOriginal(`${base}/c/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/151', 'X-Forwarded-For': '201.17.88.4' },
      body: JSON.stringify({
        user_id: 'sessao-de-checkout-777',
        fbclid: 'IwAR-clique-que-gerou-a-venda',
        fbp: 'fb.1.1786541879715.4099310706',
      }),
    });

    // A venda chega pelo backend, sem nenhum identificador de clique no payload.
    await enviar({
      ...payloadPago,
      eventId: 'venda-com-ponte',
      sessionId: 'sessao-de-checkout-777',
      customerReference: null,
      lead: { ...payloadPago.lead, taxId: null },
    });

    const { rows } = await query('SELECT payload FROM events WHERE event_id = $1', ['venda-com-ponte']);
    const ud = rows[0].payload.user_data;
    assert.equal(ud.fbclid, 'IwAR-clique-que-gerou-a-venda', 'deveria recuperar o clique pela sessão');
    assert.equal(ud.client_ip_address, '201.17.88.4', 'e o IP real do comprador, que o payload não tinha');
  });
});

describe('console de testes do painel', () => {
  test('oferece modelos prontos, incluindo o formato do checkout', async () => {
    const { modelos } = await (await api(`/api/projects/${projeto.id}/testar/modelos`)).json();
    assert.ok(modelos.length >= 4);
    const compra = modelos.find((m) => m.id === 'compra-checkout');
    assert.equal(compra.formato, 'codigo-vencedor');
    assert.equal(compra.payload.paymentStatus, 'paid');
  });

  test('simular não envia nada, mas mostra o payload exato', async () => {
    chamadasMeta = [];
    const res = await api(`/api/projects/${projeto.id}/testar`, {
      method: 'POST',
      body: JSON.stringify({
        modo: 'simular',
        destino: 'meta',
        payload: { event_name: 'purchase', event_id: 'sim-1', user_data: { email: 'a@b.com' }, custom_data: { value: 50, currency: 'BRL' } },
      }),
    });
    assert.equal(res.status, 200);
    const r = await res.json();

    assert.equal(r.enviado, false);
    assert.equal(chamadasMeta.length, 0, 'simular não pode tocar na API da Meta');
    assert.equal(r.payloadEnviado.data[0].event_name, 'Purchase');
    assert.match(r.urlDestino, /graph\.facebook\.com/);
    assert.ok(!(await query('SELECT 1 FROM events WHERE event_id=$1', ['sim-1'])).rows.length, 'simulação não grava evento');
  });

  test('o diagnóstico aponta o que falta e por que importa', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/testar`, {
      method: 'POST',
      body: JSON.stringify({
        modo: 'simular', destino: 'meta',
        payload: { event_name: 'purchase', event_id: 'diag-1', user_data: { email: 'a@b.com' }, custom_data: { value: 10 } },
      }),
    })).json();

    assert.ok(r.diagnostico.pontuacao > 0 && r.diagnostico.pontuacao < 100);
    assert.ok(r.diagnostico.camposPresentes.some((c) => c.campo === 'em'));

    const ip = r.diagnostico.camposAusentes.find((c) => c.campo === 'client_ip_address');
    assert.equal(ip.peso, 'alto', 'a Meta lista o IP entre os parâmetros de alta qualidade');

    const fbc = r.diagnostico.camposAusentes.find((c) => c.campo === 'fbc');
    assert.ok(fbc.dica.length > 10, 'campo ausente precisa vir com orientação, não só o nome');
    assert.ok(r.diagnostico.alertas.some((a) => /fbc|fbp/.test(a)));
  });

  test('avisa que o IP interno foi descartado, com a causa', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/testar`, {
      method: 'POST',
      body: JSON.stringify({
        modo: 'simular', destino: 'meta',
        payload: {
          event: 'checkout.session.completed', paymentStatus: 'paid',
          lead: { name: 'A B', email: 'a@b.com', phone: '11987654321' },
          eventId: 'ip-1', amountMinor: 100, currency: 'BRL', occurredAt: new Date().toISOString(),
          attribution: { utm: {}, cookies: {}, ipAddress: '::ffff:10.244.16.187', userAgent: 'Mozilla/5.0', eventSourceUrl: 'https://x.com/' },
        },
      }),
    })).json();

    assert.equal(r.formatoDetectado, 'codigo-vencedor');
    assert.ok(r.diagnostico.alertas.some((a) => a.includes('10.244.16.187') && /X-Forwarded-For/.test(a)));
  });

  test('modo teste exige o test_event_code em vez de mandar para produção calado', async () => {
    await api(`/api/projects/${projeto.id}/meta`, { method: 'PUT', body: JSON.stringify({ testEventCode: '' }) });
    const res = await api(`/api/projects/${projeto.id}/testar`, {
      method: 'POST',
      body: JSON.stringify({ modo: 'teste', destino: 'meta', payload: { event_name: 'purchase', event_id: 't-1' } }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Test Event Code/i);
  });

  test('modo teste envia com o código de teste; modo real envia sem ele', async () => {
    await api(`/api/projects/${projeto.id}/meta`, { method: 'PUT', body: JSON.stringify({ testEventCode: 'TEST42' }) });

    chamadasMeta = [];
    const teste = await (await api(`/api/projects/${projeto.id}/testar`, {
      method: 'POST',
      body: JSON.stringify({ modo: 'teste', destino: 'meta', payload: { event_name: 'purchase', event_id: 'env-teste', user_data: { email: 'a@b.com' }, custom_data: { value: 97, currency: 'BRL' } } }),
    })).json();
    assert.equal(teste.enviado, true);
    assert.equal(teste.resposta.ok, true);
    assert.equal(chamadasMeta.at(-1).body.test_event_code, 'TEST42');

    const real = await (await api(`/api/projects/${projeto.id}/testar`, {
      method: 'POST',
      body: JSON.stringify({ modo: 'real', destino: 'meta', payload: { event_name: 'purchase', event_id: 'env-real', user_data: { email: 'a@b.com' }, custom_data: { value: 97, currency: 'BRL' } } }),
    })).json();
    assert.equal(real.enviado, true);
    assert.equal(chamadasMeta.at(-1).body.test_event_code, undefined, 'modo real não pode carregar test_event_code');
    assert.ok(real.diagnostico.alertas.some((a) => /REAL/.test(a)), 'modo real precisa avisar que entra em produção');
  });
});

// No repositório da API (deploy em dois repos) o `public/` não existe — as páginas
// são servidas pelo container do painel. Os testes de página só rodam quando os
// arquivos estão presentes; os de API rodam sempre. O repositório do painel tem o
// equivalente estático destes testes (test/estatico.test.mjs, lá).
const TEM_PAINEL = fsExistsSync(new URL('../public/admin.html', import.meta.url));

describe('separação entre painel e API', () => {
  test('nenhuma resposta da API pode ser cacheada', async () => {
    for (const rota of ['/api/projects', `/api/projects/${projeto.id}`, '/api/auth/me']) {
      const res = await api(rota);
      assert.match(res.headers.get('cache-control'), /no-store/, `${rota} deveria ser no-store`);
    }
  });

  test('as páginas do painel vão com CSP que bloqueia script externo e inline', { skip: !TEM_PAINEL && 'painel servido pelo repo do app' }, async () => {
    for (const pagina of ['/painel', '/login', '/definir-senha']) {
      const res = await fetchOriginal(`${base}${pagina}`);
      const csp = res.headers.get('content-security-policy');
      assert.ok(csp, `${pagina} deveria ter CSP`);
      assert.match(csp, /script-src 'self'/);
      assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"), 'script inline não pode ser liberado');
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
    }
  });

  test('as páginas não carregam nada de terceiros e não têm script inline', { skip: !TEM_PAINEL && 'painel servido pelo repo do app' }, async () => {
    for (const pagina of ['/painel', '/login', '/definir-senha']) {
      const html = await (await fetchOriginal(`${base}${pagina}`)).text();

      // Qualquer host externo no HTML é uma requisição que denuncia quem usa o painel.
      const externos = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(externos, [], `${pagina} carrega recurso externo: ${externos.join(', ')}`);

      // <script> com corpo (inline) seria bloqueado pela CSP em produção.
      const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
        .filter((m) => m[1].trim().length);
      assert.equal(inline.length, 0, `${pagina} tem <script> inline`);
    }
  });

  test('nenhum segredo aparece no HTML servido', { skip: !TEM_PAINEL && 'painel servido pelo repo do app' }, async () => {
    const html = await (await fetchOriginal(`${base}/painel`)).text();
    for (const segredo of ['EAABtoken-super-secreto', tokenWebhook, 'senha-de-teste-123']) {
      assert.ok(!html.includes(segredo), 'segredo encontrado no HTML do painel');
    }
  });

  test('operador não consegue revelar o token de webhook', async () => {
    // Operador próprio deste bloco: o do teste de gestão de usuários já foi removido lá.
    await createUser({ email: 'leitura@empresa.com', password: 'senha-de-leitura-123', role: 'operador' });
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'leitura@empresa.com', password: 'senha-de-leitura-123' }),
    });
    const cookieOperador = login.headers.getSetCookie().find((c) => c.startsWith('traker_sess=')).split(';')[0];
    const res = await fetchOriginal(`${base}/api/projects/${projeto.id}/ingest-token`, {
      headers: { Cookie: cookieOperador },
    });
    assert.equal(res.status, 403);
  });
});

describe('saúde', () => {
  test('/health confirma o banco', async () => {
    const saude = await (await fetchOriginal(`${base}/health`)).json();
    assert.equal(saude.ok, true);
    assert.equal(saude.db, true);
  });
});
