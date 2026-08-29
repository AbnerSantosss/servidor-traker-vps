// Testes da F9/E9 — instalação sem GTM (tag única /w/:slug.js) e identificadores de
// anúncio de outras plataformas (camada explícita + camada aberta `click_ids`).
//
// Combina dois estilos, como os arquivos irmãos deste projeto:
//   - unitários puros para normalizeEvent/sanitizeClickIds/mergeIdentityIntoUserData/
//     interpolate de postback (não tocam banco);
//   - um bloco de integração (com Postgres real) para a rota /w/:slug.js e para provar
//     que a ponte de identidade sobrevive a um ciclo real /c/:slug -> /e/:slug.
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { createUser } from '../src/db/repos/users.js';
import { renderTagUnica, renderTagGtm, renderCollector, renderSnippet } from '../src/ingest/scripts.js';
import { normalizeEvent } from '../src/ingest/normalize.js';
import { saveIdentity, getIdentity, sanitizeClickIds, mergeIdentityIntoUserData, CLICK_IDS_MAX_KEYS, CLICK_ID_VALUE_MAX_LEN } from '../src/db/repos/identities.js';
import { interpolate } from '../src/destinations/postback.js';

// Todos os identificadores explícitos novos da camada 16.4 do plano (Bing, X, LinkedIn,
// Pinterest, Snapchat x2, Reddit, Impact, Outbrain, Kwai).
const IDENTIFICADORES_EXPLICITOS = [
  'msclkid', 'twclid', 'li_fat_id', 'epik', 'sccid', '_scid', 'rdt_cid', 'irclickid', 'obclid', 'kwai_click_id',
];

describe('sanitização da camada aberta (click_ids)', () => {
  test('aceita chave e valor dentro do padrão', () => {
    assert.deepEqual(sanitizeClickIds({ meu_parceiro: 'abc123' }), { meu_parceiro: 'abc123' });
  });

  test('descarta chave fora do formato [a-z0-9_]{1,40} sem derrubar o resto', () => {
    const out = sanitizeClickIds({ 'chave com espaço': 'x', 'chave-com-traço': 'y', valido_1: 'z' });
    assert.deepEqual(out, { valido_1: 'z' });
  });

  test('normaliza a chave para minúsculas', () => {
    assert.deepEqual(sanitizeClickIds({ MeuParceiro: 'abc' }), { meuparceiro: 'abc' });
  });

  test('trunca o valor no teto configurado', () => {
    const enorme = 'x'.repeat(CLICK_ID_VALUE_MAX_LEN + 100);
    const out = sanitizeClickIds({ parceiro: enorme });
    assert.equal(out.parceiro.length, CLICK_ID_VALUE_MAX_LEN);
  });

  test('limita a quantidade de chaves ao teto', () => {
    const raw = {};
    for (let i = 0; i < CLICK_IDS_MAX_KEYS + 10; i++) raw[`chave_${i}`] = 'v';
    const out = sanitizeClickIds(raw);
    assert.equal(Object.keys(out).length, CLICK_IDS_MAX_KEYS);
  });

  test('entrada que não é objeto vira objeto vazio, não lança exceção', () => {
    assert.deepEqual(sanitizeClickIds(null), {});
    assert.deepEqual(sanitizeClickIds('texto'), {});
    assert.deepEqual(sanitizeClickIds(['a', 'b']), {});
    assert.deepEqual(sanitizeClickIds(undefined), {});
  });

  test('valores vazios ou nulos são descartados', () => {
    assert.deepEqual(sanitizeClickIds({ a: '', b: null, c: undefined, d: '  ', e: 'ok' }), { e: 'ok' });
  });
});

describe('normalizeEvent reconhece os identificadores explícitos novos', () => {
  for (const campo of IDENTIFICADORES_EXPLICITOS) {
    test(`user_data.${campo} é preservado`, () => {
      const evento = normalizeEvent({ user_data: { [campo]: `valor-${campo}` } });
      assert.equal(evento.user_data[campo], `valor-${campo}`);
    });
  }

  test('user_data.click_ids sai sanitizado e mesclado a partir do payload', () => {
    const evento = normalizeEvent({
      user_data: { click_ids: { parceiro_x: 'clique-123', 'chave inválida': 'descartar' } },
    });
    assert.deepEqual(evento.user_data.click_ids, { parceiro_x: 'clique-123' });
  });

  test('sem click_ids no payload, a chave não aparece (ausente, não objeto vazio)', () => {
    const evento = normalizeEvent({ user_data: { email: 'a@b.com' } });
    assert.ok(!('click_ids' in evento.user_data), 'click_ids não deveria existir quando não há nada capturado');
  });

  test('click_ids também pode vir solto no corpo (fora de user_data)', () => {
    const evento = normalizeEvent({ click_ids: { parceiro_y: 'abc' } });
    assert.deepEqual(evento.user_data.click_ids, { parceiro_y: 'abc' });
  });
});

describe('mergeIdentityIntoUserData preserva os identificadores novos', () => {
  test('mescla explícitos e click_ids da identidade quando o evento não trouxe nada', () => {
    const identidade = {
      params: { msclkid: 'ms-da-identidade', fbclid: 'fb-da-identidade' },
      click_ids: { parceiro_z: 'da-identidade' },
    };
    const mesclado = mergeIdentityIntoUserData({ email: 'a@b.com' }, identidade);
    assert.equal(mesclado.msclkid, 'ms-da-identidade');
    assert.equal(mesclado.fbclid, 'fb-da-identidade');
    assert.deepEqual(mesclado.click_ids, { parceiro_z: 'da-identidade' });
  });

  test('o que já veio no evento tem prioridade sobre a identidade (nunca sobrescreve valor bom)', () => {
    const identidade = { params: { msclkid: 'antigo' }, click_ids: { parceiro_z: 'antigo' } };
    const mesclado = mergeIdentityIntoUserData(
      { msclkid: 'do-evento', click_ids: { parceiro_z: 'do-evento' } },
      identidade
    );
    assert.equal(mesclado.msclkid, 'do-evento');
    assert.equal(mesclado.click_ids.parceiro_z, 'do-evento');
  });

  test('click_ids da identidade e do evento se combinam quando as chaves são diferentes', () => {
    const identidade = { params: {}, click_ids: { a: '1' } };
    const mesclado = mergeIdentityIntoUserData({ click_ids: { b: '2' } }, identidade);
    assert.deepEqual(mesclado.click_ids, { a: '1', b: '2' });
  });

  test('identidade sem click_ids não cria a chave à toa', () => {
    const mesclado = mergeIdentityIntoUserData({ email: 'a@b.com' }, { params: { fbclid: 'x' } });
    assert.ok(!('click_ids' in mesclado));
  });
});

describe('macros de postback', () => {
  const evento = {
    event_name: 'purchase',
    event_id: 'evt-1',
    user_id: 'user-1',
    custom_data: { order_id: '8812', value: 97 },
    user_data: {
      fbclid: 'fb-clique', gclid: 'g-clique', clickid: 'afiliado-clique',
      msclkid: 'ms-clique', twclid: 'tw-clique', li_fat_id: 'li-clique',
      epik: 'pin-clique', sccid: 'snap-clique', _scid: 'snap-cookie',
      rdt_cid: 'reddit-clique', irclickid: 'impact-clique', obclid: 'outbrain-clique',
      kwai_click_id: 'kwai-clique',
      click_ids: { parceiro_exotico: 'valor-exotico' },
    },
  };

  test('macros já existentes continuam resolvendo igual (não-regressão)', () => {
    assert.equal(interpolate('.../conv?click_id={{clickid}}', evento), '.../conv?click_id=afiliado-clique');
    assert.equal(interpolate('{{fbclid}}|{{gclid}}', evento), 'fb-clique|g-clique');
    assert.equal(interpolate('{{event_name}}-{{order_id}}', evento), 'purchase-8812');
  });

  test('macros novas da camada explícita resolvem pelo mesmo mecanismo genérico', () => {
    for (const campo of IDENTIFICADORES_EXPLICITOS) {
      assert.equal(interpolate(`{{${campo}}}`, evento), evento.user_data[campo]);
    }
  });

  test('macro da camada aberta {{click_id.nome}} resolve dentro de click_ids', () => {
    assert.equal(interpolate('{{click_id.parceiro_exotico}}', evento), 'valor-exotico');
  });

  test('macro de click_id inexistente vira string vazia, não quebra a URL', () => {
    assert.equal(interpolate('.../conv?x={{click_id.nao_existe}}', evento), '.../conv?x=');
  });
});

describe('tag única /w/:slug.js — geração', () => {
  const js = renderTagUnica({ ingestUrl: 'https://t.exemplo.com/e/slug123', collectUrl: 'https://t.exemplo.com/c/slug123' });

  test('é sintaticamente válido — tag quebrada derruba o site do cliente', () => {
    assert.doesNotThrow(() => new Function(js), 'renderTagUnica deveria gerar JS sintaticamente válido');
  });

  test('não usa let/const/arrow function (compatibilidade ES5 no site do cliente)', () => {
    assert.doesNotMatch(js, /\blet\s/, 'não pode usar let');
    assert.doesNotMatch(js, /\bconst\s/, 'não pode usar const');
    assert.doesNotMatch(js, /=>/, 'não pode usar arrow function');
  });

  test('embute as URLs corretas de ingestão e de coleta', () => {
    assert.ok(js.includes('https://t.exemplo.com/e/slug123'));
    assert.ok(js.includes('https://t.exemplo.com/c/slug123'));
  });

  test('expõe window.trk e window.trkIdentify', () => {
    assert.ok(js.includes('window.trk ='));
    assert.ok(js.includes('window.trkIdentify ='));
  });

  test('drena window.trkQueue', () => {
    assert.ok(js.includes('window.trkQueue'));
  });

  test('dispara page_view automático com dedupe por URL, exceto quando desligado', () => {
    assert.ok(js.includes('dispararPageView'));
    assert.ok(js.includes('AUTO_PAGEVIEW'));
    assert.ok(js.includes('ultimaUrlPageView'));
  });
});

// A trilha do GTM deixou de ser duas tags de HTML personalizado e passou a ser uma só,
// servida em /g/:slug.js. O que estes testes protegem não é a cosmética do painel: é a
// ORDEM (o coletor grava os tk_* que o snippet lê, e dois <script src> injetados pelo
// GTM não têm ordem garantida) e a diferença de FONTE do user_id em relação à /w/.
describe('tag única do GTM /g/:slug.js — geração', () => {
  const urls = { ingestUrl: 'https://t.exemplo.com/e/slug123', collectUrl: 'https://t.exemplo.com/c/slug123' };
  const js = renderTagGtm(urls);

  test('é sintaticamente válido — tag quebrada derruba o site do cliente', () => {
    assert.doesNotThrow(() => new Function(js), 'renderTagGtm deveria gerar JS sintaticamente válido');
  });

  test('não usa let/const/arrow function (compatibilidade ES5 no site do cliente)', () => {
    assert.doesNotMatch(js, /\blet\s/, 'não pode usar let');
    assert.doesNotMatch(js, /\bconst\s/, 'não pode usar const');
    assert.doesNotMatch(js, /=>/, 'não pode usar arrow function');
  });

  test('é a composição literal do coletor e do snippet — nada de terceira implementação', () => {
    assert.ok(js.includes(renderCollector({ collectUrl: urls.collectUrl })), 'deveria embutir o coletor /s/ inteiro');
    assert.ok(js.includes(renderSnippet({ ingestUrl: urls.ingestUrl })), 'deveria embutir o snippet /t/ inteiro');
  });

  test('a ordem é coletor -> snippet -> page_view (é a razão de existir um arquivo só)', () => {
    const coletor = js.indexOf('coletor de identidade');
    const snippet = js.indexOf('window.trk =');
    const pageView = js.indexOf("window.trk('page_view'");
    assert.ok(coletor >= 0 && snippet >= 0 && pageView >= 0, 'as três partes deveriam estar presentes');
    assert.ok(coletor < snippet, 'o coletor precisa vir antes do snippet: ele grava os tk_* que o snippet lê');
    assert.ok(snippet < pageView, 'o page_view só pode disparar depois de window.trk existir');
  });

  test('dispara page_view uma única vez (o gatilho All Pages já garante uma execução)', () => {
    assert.equal(js.split("window.trk('page_view'").length - 1, 1);
  });

  test('descobre o user_id pelo dataLayer E por window[chave], nesta ordem', () => {
    assert.ok(js.includes('dataLayer'), 'no GTM a variável costuma viver no dataLayer');
    assert.ok(js.includes('fromWindow'), 'sem dataLayer, a global é a segunda fonte');
    const dl = js.indexOf('fromDataLayer.apply');
    const win = js.indexOf('fromWindow(USER_ID_KEYS)');
    assert.ok(dl >= 0 && win >= 0 && dl < win, 'o dataLayer precisa ser consultado primeiro');
    assert.ok(!js.includes('window.trkConfig'), 'a superfície de configuração data-*/trkConfig é exclusiva da /w/');
  });

  // O site que não expõe o identificador em lugar nenhum (login assíncrono, SPA) ficava
  // sem saída na trilha GTM: a tag saía calada e a ponte de identidade nunca era gravada.
  test('expõe window.trkIdentify — a saída para quem não tem o user_id no load', () => {
    assert.ok(js.includes('window.trkIdentify'), 'a /g/ precisa da mesma saída manual que a /w/ já tinha');
  });

  test('drena a fila trkQueue por __identify__ (independe da ordem de carregamento)', () => {
    assert.ok(js.includes('trkQueue'), 'deveria ler a fila de pré-carregamento');
    assert.ok(js.includes('__identify__'), 'o marcador de identificação na fila');
  });

  // Sem isto, a falha mais comum da instalação (não achar o user_id) é invisível: o
  // operador vê a tag "Concluída" no GTM e nada chegando no servidor.
  test('o DEBUG é ligável sem republicar o container', () => {
    assert.ok(js.includes('trk_debug'), 'deveria aceitar ?trk_debug=1 na URL');
    assert.ok(js.includes('window.trkDebug'), 'deveria aceitar window.trkDebug = true');
    assert.ok(!/var DEBUG = false;\s*\n\s*var USER_ID_KEYS/.test(js), 'DEBUG não pode voltar a ser constante');
  });

  test('quando não acha o user_id, o DEBUG mostra as chaves que EXISTEM no dataLayer', () => {
    assert.ok(js.includes('chaves presentes no dataLayer'), 'é o que permite descobrir o nome certo da chave');
    assert.ok(js.includes('chaves procuradas'), 'e a lista do que foi procurado, para comparar');
  });

  test('embute as URLs corretas de ingestão e de coleta', () => {
    assert.ok(js.includes('https://t.exemplo.com/e/slug123'));
    assert.ok(js.includes('https://t.exemplo.com/c/slug123'));
  });
});

// Setup único de nível de arquivo: um servidor real contra o Postgres de teste,
// compartilhado pelos blocos que precisam de banco. `runMigrations`/`closePool` só
// podem rodar UMA vez cada — chamá-los de novo depois de fechar o pool quebraria os
// blocos seguintes, por isso ficam aqui em vez de espalhados por describe.
let servidor;
let base;
let cookie = '';
let projeto;

before(async () => {
  await runMigrations();
  await query(
    'TRUNCATE events, deliveries, identities, destinations, project_domains, projects, sessions, user_tokens, users CASCADE'
  );
  await createUser({ email: 'tagweb@empresa.com', password: 'senha-de-teste-123', name: 'Teste Tag Web' });

  servidor = createApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'tagweb@empresa.com', password: 'senha-de-teste-123' }),
  });
  cookie = login.headers.getSetCookie().find((c) => c.startsWith('traker_sess=')).split(';')[0];

  const res = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Loja Tag Web', domain: 'loja-tagweb.example' }),
  });
  projeto = await res.json();

  const tokenRes = await fetch(`${base}/api/projects/${projeto.id}/ingest-token`, { headers: { Cookie: cookie } });
  projeto.ingestToken = (await tokenRes.json()).ingestToken;
});

after(async () => {
  await new Promise((r) => servidor.close(r));
  await closePool();
});

describe('tag única /w/:slug.js — servida pela API', () => {
  test('responde application/javascript com as URLs do projeto embutidas', async () => {
    const res = await fetch(`${base}/w/${projeto.slug}.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);

    const js = await res.text();
    assert.ok(js.includes(`/e/${projeto.slug}`), 'deveria apontar para o endpoint de ingestão do projeto');
    assert.ok(js.includes(`/c/${projeto.slug}`), 'deveria apontar para o endpoint de coleta do projeto');
    assert.doesNotThrow(() => new Function(js));
  });

  test('slug inexistente devolve 404', async () => {
    const res = await fetch(`${base}/w/nao-existe-jamais.js`);
    assert.equal(res.status, 404);
  });

  test('projeto pausado devolve 404 (mesma regra das rotas /s/ e /t/)', async () => {
    await query('UPDATE projects SET status=$1 WHERE id=$2', ['paused', projeto.id]);
    const res = await fetch(`${base}/w/${projeto.slug}.js`);
    assert.equal(res.status, 404);
    await query('UPDATE projects SET status=$1 WHERE id=$2', ['active', projeto.id]);
  });

  test('as rotas /s/ e /t/ continuam intactas (I-4) ao lado da nova /w/', async () => {
    const s = await fetch(`${base}/s/${projeto.slug}.js`);
    const t = await fetch(`${base}/t/${projeto.slug}.js`);
    assert.equal(s.status, 200);
    assert.equal(t.status, 200);
    assert.ok((await t.text()).includes('window.trk'));
  });
});

describe('tag única do GTM /g/:slug.js — servida pela API', () => {
  test('responde application/javascript com as URLs do projeto embutidas', async () => {
    const res = await fetch(`${base}/g/${projeto.slug}.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);

    const js = await res.text();
    assert.ok(js.includes(`/e/${projeto.slug}`), 'deveria apontar para o endpoint de ingestão do projeto');
    assert.ok(js.includes(`/c/${projeto.slug}`), 'deveria apontar para o endpoint de coleta do projeto');
    assert.ok(js.includes("window.trk('page_view'"), 'a tag do GTM dispara o page_view sozinha');
    assert.doesNotThrow(() => new Function(js));
  });

  test('slug inexistente devolve 404', async () => {
    const res = await fetch(`${base}/g/nao-existe-jamais.js`);
    assert.equal(res.status, 404);
  });

  test('projeto pausado devolve 404 (mesma regra das rotas /s/, /t/ e /w/)', async () => {
    await query('UPDATE projects SET status=$1 WHERE id=$2', ['paused', projeto.id]);
    const res = await fetch(`${base}/g/${projeto.slug}.js`);
    assert.equal(res.status, 404);
    await query('UPDATE projects SET status=$1 WHERE id=$2', ['active', projeto.id]);
  });

  test('a /g/ é servida como <script src>, não como JS colado — o GTM recusa HTML inválido', async () => {
    // O painel gera `<script src=".../g/slug.js">` justamente porque o campo "HTML
    // personalizado" do GTM é um campo HTML: JS cru colado ali é recusado no Publicar.
    // O que este teste garante é o outro lado do contrato — que a URL existe e serve JS.
    const res = await fetch(`${base}/g/${projeto.slug}.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /charset=utf-8/);
  });

  test('o page_view da /g/ chega de verdade em /e/ e vira evento do projeto', async () => {
    const js = await (await fetch(`${base}/g/${projeto.slug}.js`)).text();
    // Usa o endpoint que a PRÓPRIA tag embutiu, e não `base` montado no teste: é o que
    // prova que o endereço servido ao navegador é um endereço que responde.
    const endpoint = js.match(new RegExp(`"([^"]+/e/${projeto.slug})"`))[1];

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ event_name: 'page_view', event_id: 'pv-tag-gtm-1', source: 'web' }),
    });
    assert.equal(res.status, 202, 'o endpoint embutido na tag precisa aceitar o page_view do navegador');

    const { rows } = await query(
      'SELECT event_name FROM events WHERE project_id=$1 AND event_id=$2',
      [projeto.id, 'pv-tag-gtm-1']
    );
    assert.equal(rows.length, 1, 'o page_view deveria ter sido gravado');
    assert.equal(rows[0].event_name, 'page_view');
  });

  describe('ponte de identidade sobrevive a um ciclo real /c/ -> /e/', () => {
    test('identificadores explícitos capturados em /c/ chegam ao evento de webhook em /e/', async () => {
      await fetch(`${base}/c/${projeto.slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          user_id: 'visitante-tagweb-1',
          msclkid: 'ms-real-do-clique',
          twclid: 'tw-real-do-clique',
        }),
      });

      const ingest = await fetch(`${base}/e/${projeto.slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${projeto.ingestToken}` },
        body: JSON.stringify({ event_name: 'purchase', event_id: 'venda-tagweb-1', user_id: 'visitante-tagweb-1' }),
      });
      assert.equal(ingest.status, 202);

      const { rows } = await query('SELECT payload FROM events WHERE event_id=$1', ['venda-tagweb-1']);
      const ud = rows[0].payload.user_data;
      assert.equal(ud.msclkid, 'ms-real-do-clique', 'a ponte de identidade deveria completar o msclkid pelo que o /c/ capturou');
      assert.equal(ud.twclid, 'tw-real-do-clique');
    });

    test('/c/ persiste a camada aberta (click_ids) na coluna própria de identities', async () => {
      await fetch(`${base}/c/${projeto.slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          user_id: 'visitante-tagweb-2',
          fbclid: 'fb-para-ter-algum-identificador',
          click_ids: { parceiro_afiliado: 'clique-aberto-123', 'chave inválida': 'descartar' },
        }),
      });

      const identidade = await getIdentity(projeto.id, 'visitante-tagweb-2');
      assert.ok(identidade, 'a identidade deveria ter sido gravada');
      assert.deepEqual(identidade.click_ids, { parceiro_afiliado: 'clique-aberto-123' });
    });
  });
});

describe('saveIdentity/getIdentity — camada aberta na coluna click_ids', () => {
  test('grava e recupera click_ids separado de params', async () => {
    await query(
      `INSERT INTO projects (id, name, domain, slug, status, ingest_token) VALUES ($1,$2,$3,$4,'active',$5) ON CONFLICT (id) DO NOTHING`,
      ['prj_teste_identities', 'Projeto Teste Identities', 'identities-teste.example', 'slugtestid', 'token-teste']
    );

    await saveIdentity('prj_teste_identities', 'usuario-x', { fbclid: 'fb-x' }, { parceiro: 'valor-x' });
    const identidade = await getIdentity('prj_teste_identities', 'usuario-x');

    assert.equal(identidade.params.fbclid, 'fb-x');
    assert.deepEqual(identidade.click_ids, { parceiro: 'valor-x' });

    // Segunda gravação: merge, não substituição (mesma regra de params já testada em integracao.test.js).
    await saveIdentity('prj_teste_identities', 'usuario-x', {}, { outro_parceiro: 'valor-y' });
    const depois = await getIdentity('prj_teste_identities', 'usuario-x');
    assert.deepEqual(depois.click_ids, { parceiro: 'valor-x', outro_parceiro: 'valor-y' });

    await query('DELETE FROM projects WHERE id=$1', ['prj_teste_identities']);
  });
});
