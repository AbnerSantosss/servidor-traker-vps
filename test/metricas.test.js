// Testes de integração das métricas de analytics (fase F1 do plano de melhorias do
// painel): colunas novas de events, e os 4 endpoints novos em src/admin/router.js.
//
// Segue o estilo de test/integracao.test.js: sobe a API de verdade contra um Postgres
// real, cria projetos pelo repositório (mais direto que passar pelo painel para montar
// cenário controlado) e grava eventos via recordEvent — a mesma função que a ingestão
// usa — para exercitar exatamente o preenchimento que o ingest de produção provoca.
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { createUser } from '../src/db/repos/users.js';
import { createProject } from '../src/db/repos/projects.js';
import { recordEvent } from '../src/db/repos/events.js';
import { rodarBackfill } from '../src/scripts/backfill-analytics.js';

let servidor;
let base;
let cookie = '';

const api = (caminho, opcoes = {}) =>
  fetch(`${base}${caminho}`, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...opcoes.headers },
  });

// Monta um "Evento Interno" no formato que src/ingest/normalize.js produz — é essa a
// forma que recordEvent espera, não o payload cru do cliente.
// `orderId`/`transactionId` existem para os testes do funil de dinheiro: é por eles que
// o servidor casa um pix_gerado com a compra correspondente. Quando não são passados, o
// custom_data sai exatamente como saía antes.
function evento({ eventId, eventName, valor, currency = 'BRL', userData = {}, orderId, transactionId }) {
  const custom = {};
  if (valor !== undefined) { custom.value = valor; custom.currency = currency; }
  if (orderId) custom.order_id = orderId;
  if (transactionId) custom.transaction_id = transactionId;

  return {
    event_id: eventId,
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    source: 'web',
    event_source_url: '',
    action_source: 'website',
    user_id: userData.user_id,
    user_data: userData,
    custom_data: custom,
    consent_state: {},
    page: {},
  };
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

describe('recordEvent preenche as colunas novas de analytics', () => {
  let projeto;
  before(async () => {
    projeto = await createProject({ name: 'Projeto Colunas', domain: 'projeto-colunas.com' });
  });

  test('grava utm_medium/utm_campaign e detecta fbc e gclid quando presentes', async () => {
    const { id } = await recordEvent({
      project: projeto,
      event: evento({
        eventId: 'col-completo',
        eventName: 'lead',
        userData: { utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'black-friday', fbc: 'fb.1.1.abc', gclid: 'Cj0KCQ' },
      }),
      destinationTypes: [],
    });
    const { rows } = await query('SELECT utm_medium, utm_campaign, tem_fbc, tem_gclid FROM events WHERE id=$1', [id]);
    assert.equal(rows[0].utm_medium, 'cpc');
    assert.equal(rows[0].utm_campaign, 'black-friday');
    assert.equal(rows[0].tem_fbc, true);
    assert.equal(rows[0].tem_gclid, true);
  });

  test('só fbclid, sem fbc, ainda marca tem_fbc como verdadeiro', async () => {
    const { id } = await recordEvent({
      project: projeto,
      event: evento({ eventId: 'col-so-fbclid', eventName: 'lead', userData: { fbclid: 'IwAR-xyz' } }),
      destinationTypes: [],
    });
    const { rows } = await query('SELECT tem_fbc, tem_gclid FROM events WHERE id=$1', [id]);
    assert.equal(rows[0].tem_fbc, true);
    assert.equal(rows[0].tem_gclid, false);
  });

  test('só gbraid, sem gclid, ainda marca tem_gclid como verdadeiro', async () => {
    const { id } = await recordEvent({
      project: projeto,
      event: evento({ eventId: 'col-so-gbraid', eventName: 'lead', userData: { gbraid: 'abc123' } }),
      destinationTypes: [],
    });
    const { rows } = await query('SELECT tem_fbc, tem_gclid FROM events WHERE id=$1', [id]);
    assert.equal(rows[0].tem_fbc, false);
    assert.equal(rows[0].tem_gclid, true);
  });

  test('sem nenhum dado de clique ou UTM, grava false (não null) e utm como NULL', async () => {
    const { id } = await recordEvent({
      project: projeto,
      event: evento({ eventId: 'col-vazio', eventName: 'page_view', userData: {} }),
      destinationTypes: [],
    });
    const { rows } = await query('SELECT utm_medium, utm_campaign, tem_fbc, tem_gclid FROM events WHERE id=$1', [id]);
    assert.equal(rows[0].utm_medium, null);
    assert.equal(rows[0].utm_campaign, null);
    assert.equal(rows[0].tem_fbc, false);
    assert.equal(rows[0].tem_gclid, false);
  });
});

describe('GET /projects/:id/metrics/utm', () => {
  let projeto;
  let outroProjeto;

  before(async () => {
    projeto = await createProject({ name: 'Projeto UTM', domain: 'projeto-utm.com' });
    outroProjeto = await createProject({ name: 'Projeto UTM Outro', domain: 'projeto-utm-outro.com' });

    await recordEvent({
      project: projeto,
      event: evento({ eventId: 'utm-compra-1', eventName: 'purchase', valor: 100, userData: { utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'promo', fbc: 'fb.1.1.1' } }),
      destinationTypes: [],
    });
    await recordEvent({
      project: projeto,
      event: evento({ eventId: 'utm-lead-1', eventName: 'lead', userData: { utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'promo' } }),
      destinationTypes: [],
    });
    await recordEvent({
      project: projeto,
      event: evento({ eventId: 'utm-compra-direto', eventName: 'purchase', valor: 50, userData: {} }),
      destinationTypes: [],
    });
    // Ruído de outro projeto: não pode aparecer na resposta acima.
    await recordEvent({
      project: outroProjeto,
      event: evento({ eventId: 'utm-outro-projeto', eventName: 'purchase', valor: 9999, userData: { utm_source: 'google' } }),
      destinationTypes: [],
    });
  });

  test('soma receita só de purchase e agrupa "(direto)" quando não há UTM', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics/utm`)).json();

    const linhaFacebook = r.linhas.find((l) => l.utm_source === 'facebook');
    assert.ok(linhaFacebook, 'deveria ter uma linha para facebook/cpc/promo');
    assert.equal(linhaFacebook.utm_medium, 'cpc');
    assert.equal(linhaFacebook.utm_campaign, 'promo');
    assert.equal(linhaFacebook.eventos, 2, 'compra + lead');
    assert.equal(linhaFacebook.compras, 1);
    assert.equal(linhaFacebook.receita, 100);
    assert.equal(linhaFacebook.ticket_medio, 100);
    assert.equal(linhaFacebook.pct_com_atribuicao, 0.5, 'só a compra tem fbc; o lead não');

    const linhaDireto = r.linhas.find((l) => l.utm_source === '(direto)');
    assert.ok(linhaDireto, 'evento sem UTM deveria virar a chave (direto), nunca null');
    assert.equal(linhaDireto.utm_medium, '(direto)');
    assert.equal(linhaDireto.utm_campaign, '(direto)');
    assert.equal(linhaDireto.compras, 1);
    assert.equal(linhaDireto.receita, 50);

    assert.ok(!r.linhas.some((l) => l.utm_source === 'google'), 'evento de outro projeto vazou para a resposta');
  });

  test('devolve o total geral do período, além das linhas', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics/utm`)).json();
    assert.equal(r.total.eventos, 3);
    assert.equal(r.total.compras, 2);
    assert.equal(r.total.receita, 150);
  });

  test('limit é respeitado e tem teto rígido', async () => {
    const r1 = await (await api(`/api/projects/${projeto.id}/metrics/utm?limit=1`)).json();
    assert.equal(r1.linhas.length, 1);

    const r2 = await (await api(`/api/projects/${projeto.id}/metrics/utm?limit=999999`)).json();
    assert.ok(r2.linhas.length <= 200, 'limit não pode ultrapassar o teto de 200');
  });
});

describe('GET /projects/:id/metrics/atribuicao', () => {
  let projeto;
  let outroProjeto;

  before(async () => {
    projeto = await createProject({ name: 'Projeto Atribuição', domain: 'projeto-atribuicao.com' });
    outroProjeto = await createProject({ name: 'Projeto Atribuição Outro', domain: 'projeto-atribuicao-outro.com' });

    await recordEvent({
      project: projeto,
      event: evento({ eventId: 'atr-compra-com-fbc', eventName: 'purchase', valor: 70, userData: { fbc: 'fb.1.1.1' } }),
      destinationTypes: [],
    });
    await recordEvent({
      project: projeto,
      event: evento({ eventId: 'atr-compra-sem-click', eventName: 'purchase', valor: 30, userData: {} }),
      destinationTypes: [],
    });
    await recordEvent({
      project: outroProjeto,
      event: evento({ eventId: 'atr-outro-projeto', eventName: 'purchase', valor: 500, userData: {} }),
      destinationTypes: [],
    });
  });

  test('lista a compra sem click ID e não lista a que tem fbc', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics/atribuicao`)).json();
    const ids = r.sem_atribuicao.map((e) => e.event_id);
    assert.ok(ids.includes('atr-compra-sem-click'), 'a compra sem clique deveria aparecer na lista');
    assert.ok(!ids.includes('atr-compra-com-fbc'), 'a compra com fbc não pode aparecer na lista');
    assert.ok(!ids.includes('atr-outro-projeto'), 'evento de outro projeto vazou para a lista');

    const linha = r.sem_atribuicao.find((e) => e.event_id === 'atr-compra-sem-click');
    assert.equal(linha.value, 30);
    assert.equal(linha.currency, 'BRL');
    assert.ok(linha.id, 'deveria trazer o id da linha de evento para o painel abrir o detalhe');
  });

  test('resumo mostra a "receita invisível" só das duas compras deste projeto', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics/atribuicao`)).json();
    assert.equal(r.resumo.total_eventos, 2);
    assert.equal(r.resumo.sem_atribuicao, 1);
    assert.equal(r.resumo.receita_sem_atribuicao, 30);
  });

  test('serie vem com com_fbc/sem_fbc/com_gclid/sem_gclid por dia', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics/atribuicao`)).json();
    assert.ok(Array.isArray(r.serie) && r.serie.length > 0);
    assert.ok(r.serie.every((d) => 'com_fbc' in d && 'sem_fbc' in d && 'com_gclid' in d && 'sem_gclid' in d));
    const hoje = r.serie[0];
    assert.equal(hoje.com_fbc + hoje.sem_fbc, 2);
  });

  test('event_name filtra a série e o resumo, sem afetar a lista de compras cegas', async () => {
    await recordEvent({
      project: projeto,
      event: evento({ eventId: 'atr-lead-sem-click', eventName: 'lead', userData: {} }),
      destinationTypes: [],
    });
    const r = await (await api(`/api/projects/${projeto.id}/metrics/atribuicao?event_name=lead`)).json();
    assert.equal(r.resumo.total_eventos, 1, 'só o lead deveria contar com o filtro');
    // sem_atribuicao continua sendo sobre purchase, independente do filtro.
    assert.ok(r.sem_atribuicao.every((e) => e.event_id !== 'atr-lead-sem-click'));
  });
});

describe('GET /projects/:id/metrics/funil', () => {
  let projeto;

  before(async () => {
    projeto = await createProject({ name: 'Projeto Funil', domain: 'projeto-funil.com' });
    await recordEvent({ project: projeto, event: evento({ eventId: 'f-pv-1', eventName: 'page_view' }), destinationTypes: [] });
    await recordEvent({ project: projeto, event: evento({ eventId: 'f-pv-2', eventName: 'page_view' }), destinationTypes: [] });
    await recordEvent({ project: projeto, event: evento({ eventId: 'f-lead-1', eventName: 'lead' }), destinationTypes: [] });
    await recordEvent({ project: projeto, event: evento({ eventId: 'f-purchase-1', eventName: 'purchase', valor: 10 }), destinationTypes: [] });
  });

  test('calcula as taxas na ordem certa, com as etapas padrão', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics/funil`)).json();
    assert.deepEqual(r.etapas.map((e) => e.nome), ['page_view', 'lead', 'begin_checkout', 'pix_gerado', 'purchase']);

    const [pv, lead, checkout, pix, purchase] = r.etapas;
    assert.equal(pv.eventos, 2);
    assert.equal(pv.taxa_do_topo, 1);
    assert.equal(pv.taxa_da_etapa_anterior, null, 'primeira etapa não tem "anterior"');

    assert.equal(lead.eventos, 1);
    assert.equal(lead.taxa_da_etapa_anterior, 0.5);
    assert.equal(lead.taxa_do_topo, 0.5);

    assert.equal(checkout.eventos, 0);
    assert.equal(checkout.taxa_da_etapa_anterior, 0, 'lead(1) -> begin_checkout(0) é 0, não divisão por zero');

    assert.equal(pix.eventos, 0);

    assert.equal(purchase.eventos, 1);
    assert.equal(purchase.taxa_da_etapa_anterior, 0, 'etapa anterior (pix_gerado) tem 0 eventos: guarda contra 1/0');
    assert.equal(purchase.taxa_do_topo, 0.5);
  });

  test('não divide por zero quando o topo (primeira etapa) é 0', async () => {
    const vazio = await createProject({ name: 'Projeto Funil Vazio', domain: 'projeto-funil-vazio.com' });
    const r = await (await api(`/api/projects/${vazio.id}/metrics/funil`)).json();
    for (const etapa of r.etapas) {
      assert.equal(etapa.eventos, 0);
      assert.equal(etapa.taxa_do_topo, 0);
      assert.ok(Number.isFinite(etapa.taxa_do_topo), 'nunca NaN nem Infinity');
    }
  });

  test('aceita etapas customizadas, com teto de quantidade', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics/funil?etapas=page_view,purchase`)).json();
    assert.deepEqual(r.etapas.map((e) => e.nome), ['page_view', 'purchase']);
    assert.equal(r.etapas[1].taxa_da_etapa_anterior, 0.5);
  });
});

describe('GET /projects/:id/metrics/destinos', () => {
  let projeto;

  before(async () => {
    projeto = await createProject({ name: 'Projeto Destinos', domain: 'projeto-destinos.com' });

    const okMeta = await recordEvent({ project: projeto, event: evento({ eventId: 'd-ev-1', eventName: 'purchase', valor: 1 }), destinationTypes: ['meta'] });
    const okGoogle = await recordEvent({ project: projeto, event: evento({ eventId: 'd-ev-2', eventName: 'purchase', valor: 1 }), destinationTypes: ['google'] });
    const errMeta = await recordEvent({ project: projeto, event: evento({ eventId: 'd-ev-3', eventName: 'purchase', valor: 1 }), destinationTypes: ['meta'] });
    const pendenteGoogle = await recordEvent({ project: projeto, event: evento({ eventId: 'd-ev-4', eventName: 'purchase', valor: 1 }), destinationTypes: ['google'] });

    // Entrega "concluída" há 3 segundos, para dar uma latência média conhecida.
    await query(
      `UPDATE deliveries SET status='success', created_at = now() - interval '3 seconds', updated_at = now()
        WHERE event_row_id = $1 AND destination_type = 'meta'`,
      [okMeta.id]
    );
    await query(
      `UPDATE deliveries SET status='success', created_at = now() - interval '1 seconds', updated_at = now()
        WHERE event_row_id = $1 AND destination_type = 'google'`,
      [okGoogle.id]
    );
    await query(
      `UPDATE deliveries SET status='dead', last_error='Invalid access token'
        WHERE event_row_id = $1 AND destination_type = 'meta'`,
      [errMeta.id]
    );
    // pendenteGoogle fica como veio (status pending) — sem tocar.
    void pendenteGoogle;
  });

  test('separa por destino e conta os status', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics/destinos`)).json();

    const linhaMeta = r.serie.find((s) => s.destino === 'meta');
    assert.ok(linhaMeta, 'deveria ter uma linha para meta');
    assert.equal(linhaMeta.status.success, 1);
    assert.equal(linhaMeta.status.dead, 1);
    assert.equal(linhaMeta.status.pending, 0);

    const linhaGoogle = r.serie.find((s) => s.destino === 'google');
    assert.ok(linhaGoogle, 'deveria ter uma linha para google');
    assert.equal(linhaGoogle.status.success, 1);
    assert.equal(linhaGoogle.status.pending, 1);
  });

  test('calcula a latência média das entregas com sucesso, em segundos', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics/destinos`)).json();
    assert.ok(r.latencia_media_segundos.meta >= 2.5 && r.latencia_media_segundos.meta <= 5, `latência do meta fora do esperado: ${r.latencia_media_segundos.meta}`);
    assert.ok(r.latencia_media_segundos.google >= 0.5 && r.latencia_media_segundos.google <= 3);
  });

  test('lista os erros mais frequentes por destino, truncados e contados', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics/destinos`)).json();
    assert.ok(r.top_erros.meta.some((e) => e.erro === 'Invalid access token' && e.quantidade === 1));
    assert.ok(!r.top_erros.google || r.top_erros.google.length === 0, 'google não teve erro nenhum');
  });
});

describe('isolamento entre projetos nas 4 métricas novas', () => {
  test('evento de outro projeto não aparece em nenhuma das métricas', async () => {
    const projA = await createProject({ name: 'Isolamento A', domain: 'isolamento-a.com' });
    const projB = await createProject({ name: 'Isolamento B', domain: 'isolamento-b.com' });

    await recordEvent({ project: projA, event: evento({ eventId: 'iso-a-1', eventName: 'purchase', valor: 10 }), destinationTypes: ['meta'] });
    await recordEvent({ project: projB, event: evento({ eventId: 'iso-b-1', eventName: 'purchase', valor: 999999 }), destinationTypes: ['meta'] });

    const utm = await (await api(`/api/projects/${projA.id}/metrics/utm`)).json();
    assert.equal(utm.total.compras, 1);
    assert.equal(utm.total.receita, 10);

    const atrib = await (await api(`/api/projects/${projA.id}/metrics/atribuicao`)).json();
    assert.equal(atrib.resumo.total_eventos, 1);

    const funil = await (await api(`/api/projects/${projA.id}/metrics/funil`)).json();
    assert.equal(funil.etapas.find((e) => e.nome === 'purchase').eventos, 1);

    const destinos = await (await api(`/api/projects/${projA.id}/metrics/destinos`)).json();
    const totalEntregasA = destinos.serie.reduce((acc, s) => acc + Object.values(s.status).reduce((a, b) => a + b, 0), 0);
    assert.equal(totalEntregasA, 1);
  });
});

describe('backfill de analytics (src/scripts/backfill-analytics.js)', () => {
  test('preenche eventos antigos e é idempotente ao rodar duas vezes', async () => {
    const projeto = await createProject({ name: 'Projeto Backfill', domain: 'projeto-backfill.com' });

    // Simula um evento gravado ANTES da migração 003: insere direto no banco com as 4
    // colunas novas em NULL, contornando recordEvent (que já preenche tudo na ingestão).
    const payload = {
      event_id: 'antigo-1',
      event_name: 'purchase',
      user_data: { utm_medium: 'cpc', utm_campaign: 'antiga', fbclid: 'IwAR-old' },
      custom_data: { value: 42, currency: 'BRL' },
    };
    await query(
      `INSERT INTO events (project_id, event_id, event_name, source, received_at, utm_source, value, currency, payload, consent)
       VALUES ($1,'antigo-1','purchase','web',now(),NULL,42,'BRL',$2::jsonb,'{}'::jsonb)`,
      [projeto.id, JSON.stringify(payload)]
    );

    const primeiraRodada = await rodarBackfill();
    assert.ok(primeiraRodada >= 1, 'deveria ter processado pelo menos o evento antigo inserido');

    const { rows: depois1 } = await query(
      'SELECT utm_medium, utm_campaign, tem_fbc, tem_gclid FROM events WHERE event_id=$1',
      ['antigo-1']
    );
    assert.equal(depois1[0].utm_medium, 'cpc');
    assert.equal(depois1[0].utm_campaign, 'antiga');
    assert.equal(depois1[0].tem_fbc, true, 'tinha fbclid');
    assert.equal(depois1[0].tem_gclid, false);

    const segundaRodada = await rodarBackfill();
    assert.equal(segundaRodada, 0, 'não deveria sobrar nenhuma linha pendente na segunda rodada');

    const { rows: depois2 } = await query(
      'SELECT utm_medium, utm_campaign, tem_fbc, tem_gclid FROM events WHERE event_id=$1',
      ['antigo-1']
    );
    assert.deepEqual(depois1[0], depois2[0], 'rodar de novo não pode mudar o resultado');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Funil de dinheiro (F-V3): os seis indicadores principais do dashboard.
// Dois deles não existem como evento — são derivados — e é exatamente onde um número
// errado passa despercebido, porque não há nenhuma linha no banco para conferir a olho.
// Por isso cada derivado tem teste do caso normal E do caso de borda.
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /projects/:id/metrics — funil de dinheiro', () => {
  let projeto;

  before(async () => {
    projeto = await createProject({ name: 'Projeto Funil Dinheiro', domain: 'funil-dinheiro.com' });

    const ev = (args) => recordEvent({ project: projeto, event: evento(args), destinationTypes: [] });

    await ev({ eventId: 'fd-pv-1', eventName: 'page_view' });
    await ev({ eventId: 'fd-pv-2', eventName: 'page_view' });
    await ev({ eventId: 'fd-pv-3', eventName: 'page_view' });

    await ev({ eventId: 'fd-chk-1', eventName: 'begin_checkout', valor: 200, orderId: 'PED-1' });
    await ev({ eventId: 'fd-chk-2', eventName: 'begin_checkout', valor: 150, orderId: 'PED-9' });

    // Pix pago: mesma chave da compra abaixo.
    await ev({ eventId: 'fd-pix-1', eventName: 'pix_gerado', valor: 200, orderId: 'PED-1' });
    // Pix que ninguém pagou: nenhuma compra tem a chave PED-9 no período.
    await ev({ eventId: 'fd-pix-2', eventName: 'pix_gerado', valor: 150, orderId: 'PED-9' });

    await ev({ eventId: 'fd-compra-1', eventName: 'purchase', valor: 200, orderId: 'PED-1' });
  });

  test('conta vendas (quantidade e valor), page_views e checkouts iniciados', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics`)).json();
    const f = r.funilDinheiro;
    assert.equal(f.vendas, 1);
    assert.equal(Number(f.vendas_valor), 200);
    assert.equal(f.page_views, 3);
    assert.equal(f.checkouts_iniciados, 2);
  });

  test('checkout abandonado = iniciados − vendas no período, com a taxa', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics`)).json();
    const f = r.funilDinheiro;
    assert.equal(f.checkouts_abandonados, 1, '2 checkouts iniciados, 1 virou venda');
    assert.equal(f.taxa_abandono_checkout, 0.5);
  });

  test('pix abandonado casa por order_id quando todo pix traz a chave', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics`)).json();
    const f = r.funilDinheiro;
    assert.equal(f.pix_gerados, 2);
    assert.equal(Number(f.pix_valor), 350);
    assert.equal(f.pix_metodo, 'order_id', 'os dois pix trouxeram order_id');
    assert.equal(f.pix_com_chave, 2);
    assert.equal(Number(f.pix_abandonado_valor), 150, 'só o PED-9 ficou sem compra');
    assert.equal(f.pix_abandonado_qtd, 1);
  });

  test('os campos antigos de totals continuam valendo (nada foi renomeado)', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics`)).json();
    assert.equal(r.totals.purchases, 1);
    assert.equal(Number(r.totals.revenue), 200);
    assert.equal(r.totals.events, 8);
    assert.ok('avgTicket' in r.totals && 'successRate' in r.totals && 'signUps' in r.totals);
  });

  test('o filtro por tipo de evento não zera o funil de dinheiro', async () => {
    // O filtro recorta o resto da resposta, mas o funil compara SEIS eventos entre si:
    // herdar "só purchase" zeraria cinco cards e o painel mostraria zero onde há dado.
    const r = await (await api(`/api/projects/${projeto.id}/metrics?event_name=purchase`)).json();
    assert.equal(r.totals.events, 1, 'o filtro continua valendo para totals');
    assert.equal(r.funilDinheiro.page_views, 3, 'o funil ignora o filtro de evento, de propósito');
    assert.equal(r.funilDinheiro.checkouts_iniciados, 2);
  });

  test('evento de outro projeto não entra no funil de dinheiro', async () => {
    const vizinho = await createProject({ name: 'Funil Dinheiro Vizinho', domain: 'funil-dinheiro-vizinho.com' });
    await recordEvent({
      project: vizinho,
      event: evento({ eventId: 'fdv-pix', eventName: 'pix_gerado', valor: 99999, orderId: 'X-1' }),
      destinationTypes: [],
    });
    const r = await (await api(`/api/projects/${projeto.id}/metrics`)).json();
    assert.equal(Number(r.funilDinheiro.pix_valor), 350, 'o pix do vizinho vazou para a soma');
  });
});

describe('funil de dinheiro — derivados nos casos de borda', () => {
  test('mais compras que checkouts iniciados: abandono fica em 0, nunca negativo', async () => {
    // Acontece de verdade toda vez que o checkout começou ANTES da janela do filtro e a
    // compra fechou dentro dela. Sem piso, o card mostraria "-2 checkouts abandonados".
    const projeto = await createProject({ name: 'Funil Piso Zero', domain: 'funil-piso-zero.com' });
    const ev = (args) => recordEvent({ project: projeto, event: evento(args), destinationTypes: [] });

    await ev({ eventId: 'pz-chk-1', eventName: 'begin_checkout', valor: 10 });
    await ev({ eventId: 'pz-compra-1', eventName: 'purchase', valor: 10 });
    await ev({ eventId: 'pz-compra-2', eventName: 'purchase', valor: 20 });
    await ev({ eventId: 'pz-compra-3', eventName: 'purchase', valor: 30 });

    const r = await (await api(`/api/projects/${projeto.id}/metrics`)).json();
    assert.equal(r.funilDinheiro.checkouts_abandonados, 0);
    assert.equal(r.funilDinheiro.taxa_abandono_checkout, 0);
  });

  test('pix sem chave em qualquer linha derruba o cálculo para o agregado', async () => {
    // Casar par a par com dado incompleto é pior que não casar: o pix sem chave nunca
    // encontraria compra e viraria "abandonado" por falta de dado, não por falta de
    // pagamento. Por isso basta UM pix sem chave para o método virar agregado.
    const projeto = await createProject({ name: 'Funil Pix Agregado', domain: 'funil-pix-agregado.com' });
    const ev = (args) => recordEvent({ project: projeto, event: evento(args), destinationTypes: [] });

    await ev({ eventId: 'ag-pix-1', eventName: 'pix_gerado', valor: 300 });                    // sem chave
    await ev({ eventId: 'ag-pix-2', eventName: 'pix_gerado', valor: 100, orderId: 'AG-2' });   // com chave
    await ev({ eventId: 'ag-compra-1', eventName: 'purchase', valor: 120, orderId: 'AG-2' });

    const r = await (await api(`/api/projects/${projeto.id}/metrics`)).json();
    const f = r.funilDinheiro;
    assert.equal(f.pix_metodo, 'agregado');
    assert.equal(f.pix_com_chave, 1, 'só um dos dois pix trouxe a chave');
    assert.equal(Number(f.pix_valor), 400);
    assert.equal(Number(f.pix_abandonado_valor), 280, 'Σ pix (400) − Σ compras (120)');
    assert.equal(f.pix_abandonado_qtd, null, 'no agregado não existe "quantos pix" — 0 mentiria');
  });

  test('compras somando mais que os pix: abandono em R$ fica em 0, nunca negativo', async () => {
    const projeto = await createProject({ name: 'Funil Pix Piso', domain: 'funil-pix-piso.com' });
    const ev = (args) => recordEvent({ project: projeto, event: evento(args), destinationTypes: [] });

    await ev({ eventId: 'pp-pix-1', eventName: 'pix_gerado', valor: 50 });
    await ev({ eventId: 'pp-compra-1', eventName: 'purchase', valor: 900 });

    const r = await (await api(`/api/projects/${projeto.id}/metrics`)).json();
    assert.equal(Number(r.funilDinheiro.pix_abandonado_valor), 0);
  });

  test('transaction_id serve de chave quando o webhook não manda order_id', async () => {
    const projeto = await createProject({ name: 'Funil Transaction', domain: 'funil-transaction.com' });
    const ev = (args) => recordEvent({ project: projeto, event: evento(args), destinationTypes: [] });

    await ev({ eventId: 'tx-pix-1', eventName: 'pix_gerado', valor: 80, transactionId: 'TX-1' });
    await ev({ eventId: 'tx-pix-2', eventName: 'pix_gerado', valor: 40, transactionId: 'TX-2' });
    await ev({ eventId: 'tx-compra-1', eventName: 'purchase', valor: 80, transactionId: 'TX-1' });

    const r = await (await api(`/api/projects/${projeto.id}/metrics`)).json();
    assert.equal(r.funilDinheiro.pix_metodo, 'order_id');
    assert.equal(Number(r.funilDinheiro.pix_abandonado_valor), 40, 'só o TX-2 ficou sem compra');
  });

  test('projeto sem nenhum evento devolve o funil zerado, não nulo nem NaN', async () => {
    const vazio = await createProject({ name: 'Funil Dinheiro Vazio', domain: 'funil-dinheiro-vazio.com' });
    const r = await (await api(`/api/projects/${vazio.id}/metrics`)).json();
    const f = r.funilDinheiro;
    for (const campo of ['vendas', 'vendas_valor', 'page_views', 'checkouts_iniciados',
      'checkouts_abandonados', 'taxa_abandono_checkout', 'pix_gerados', 'pix_valor',
      'pix_abandonado_valor']) {
      assert.equal(Number(f[campo]), 0, `${campo} deveria ser 0`);
      assert.ok(Number.isFinite(Number(f[campo])), `${campo} virou NaN/Infinity`);
    }
    assert.equal(f.pix_metodo, 'agregado', 'sem pix nenhum, não há chave para casar');
  });

  test('o período do filtro recorta o funil', async () => {
    const projeto = await createProject({ name: 'Funil Dinheiro Periodo', domain: 'funil-dinheiro-periodo.com' });
    await recordEvent({
      project: projeto,
      event: evento({ eventId: 'fp-compra-hoje', eventName: 'purchase', valor: 500 }),
      destinationTypes: [],
    });
    // Janela que termina ontem: o evento de hoje não pode entrar.
    const ontem = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const r = await (await api(`/api/projects/${projeto.id}/metrics?from=2020-01-01&to=${ontem}`)).json();
    assert.equal(r.funilDinheiro.vendas, 0);
    assert.equal(Number(r.funilDinheiro.vendas_valor), 0);
  });
});

describe('GET /projects/:id/metrics/serie', () => {
  let projeto;

  before(async () => {
    projeto = await createProject({ name: 'Projeto Serie', domain: 'projeto-serie.com' });
    await recordEvent({ project: projeto, event: evento({ eventId: 's-pv-1', eventName: 'page_view' }), destinationTypes: [] });
    await recordEvent({ project: projeto, event: evento({ eventId: 's-pv-2', eventName: 'page_view' }), destinationTypes: [] });
    await recordEvent({ project: projeto, event: evento({ eventId: 's-lead-1', eventName: 'lead' }), destinationTypes: [] });
    await recordEvent({ project: projeto, event: evento({ eventId: 's-compra-1', eventName: 'purchase', valor: 150 }), destinationTypes: [] });
    await recordEvent({ project: projeto, event: evento({ eventId: 's-compra-2', eventName: 'purchase', valor: 50 }), destinationTypes: [] });
  });

  test('agrupa por dia, conta por tipo e soma a receita só de purchase', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics/serie`)).json();
    assert.equal(r.serie.length, 1, 'os eventos foram gravados no mesmo dia');

    const dia = r.serie[0];
    assert.equal(dia.tipos.page_view, 2);
    assert.equal(dia.tipos.lead, 1);
    assert.equal(dia.tipos.purchase, 2);
    assert.equal(Number(dia.receita), 200, 'receita é a soma do value das compras');
    assert.equal(dia.compras, 2);
  });

  test('o filtro por tipo de evento recorta a série', async () => {
    const r = await (await api(`/api/projects/${projeto.id}/metrics/serie?event_name=purchase`)).json();
    assert.deepEqual(r.tipos, ['purchase'], 'só o tipo pedido vira série');
    assert.equal(r.serie[0].tipos.page_view, undefined);
    assert.equal(r.serie[0].tipos.purchase, 2);
  });

  test('tipos além do topN caem em "outros" em vez de virar série própria', async () => {
    // Com topN=1, só o tipo mais frequente (page_view e purchase empatam em 2) fica de
    // fora do balde — o resto precisa continuar contado, não sumir do gráfico.
    const r = await (await api(`/api/projects/${projeto.id}/metrics/serie?top_n=1`)).json();
    assert.equal(r.tipos.length, 1);
    assert.equal(r.temOutros, true, 'o que sobrou precisa ser sinalizado');

    const dia = r.serie[0];
    const somaVisivel = Object.values(dia.tipos).reduce((a, b) => a + b, 0) + dia.outros;
    assert.equal(somaVisivel, 5, 'nenhum evento pode desaparecer do total ao ser agrupado');
  });

  test('projeto sem eventos devolve estrutura vazia, não erro', async () => {
    const vazio = await createProject({ name: 'Projeto Serie Vazio', domain: 'serie-vazia.com' });
    const r = await (await api(`/api/projects/${vazio.id}/metrics/serie`)).json();
    assert.deepEqual(r.serie, []);
    assert.deepEqual(r.tipos, []);
    assert.equal(r.temOutros, false);
    assert.equal(r.coletandoDesde, null, 'sem evento não há "coletando desde"');
  });

  test('coletandoDesde traz o 1º evento do projeto, mesmo fora do período filtrado', async () => {
    // É o dado da nota "coletando dados desde …", que o gráfico mostra quando a série
    // tem poucos pontos — a pergunta é "desde quando este projeto coleta?", não "o que
    // coube no filtro".
    const amanha = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const r = await (await api(`/api/projects/${projeto.id}/metrics/serie?from=${amanha}&to=${amanha}`)).json();
    assert.deepEqual(r.serie, [], 'a janela é o futuro: nenhum evento cabe nela');
    assert.ok(r.coletandoDesde, 'a data do 1º evento não pode depender do filtro');
    assert.ok(!Number.isNaN(Date.parse(r.coletandoDesde)), 'deveria ser uma data ISO válida');
  });

  test('evento de outro projeto não entra na série', async () => {
    const outro = await createProject({ name: 'Projeto Serie Outro', domain: 'serie-outro.com' });
    await recordEvent({ project: outro, event: evento({ eventId: 's-vizinho', eventName: 'purchase', valor: 999 }), destinationTypes: [] });

    const r = await (await api(`/api/projects/${projeto.id}/metrics/serie`)).json();
    assert.equal(Number(r.serie[0].receita), 200, 'a receita do vizinho não pode vazar');
  });
});
