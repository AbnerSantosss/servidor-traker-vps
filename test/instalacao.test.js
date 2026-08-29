// Confirmação de instalação: cada sinal, no positivo e no negativo.
//
// Por que o negativo importa tanto quanto o positivo: o defeito que esta feature
// existe para evitar é o falso verde — o painel dizer "instalado" quando o que
// aconteceu foi só alguém preencher um campo. Um teste que só verifica o caminho feliz
// não pega isso. Aqui cada sinal é checado ANTES de existir evidência (tem de vir
// `ok: false`) e DEPOIS (tem de vir `ok: true` com a evidência junto).
//
// Os dados entram pelo caminho real sempre que possível — POST em /e/:slug e /c/:slug,
// como o navegador e o backend do cliente fazem — em vez de INSERT direto. Um teste que
// escreve na tabela na mão prova que a consulta lê a tabela; não prova que aquilo que
// o produto grava é o que a consulta procura, que é justamente onde este tipo de
// feature quebra.
import './setup-env.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { createUser } from '../src/db/repos/users.js';
import { estadoInstalacao } from '../src/db/repos/instalacao.js';

let servidor;
let base;
let cookie = '';
let projeto;

/** Envia um evento como o NAVEGADOR envia (sem token, origem `web`). */
async function eventoWeb(corpo) {
  const res = await fetch(`${base}/e/${projeto.slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ source: 'web', ...corpo }),
  });
  assert.equal(res.status, 202, `evento web recusado: ${await res.text()}`);
}

/** Envia um evento como o BACKEND do cliente envia (token no header, origem `webhook`). */
async function eventoWebhook(corpo) {
  const res = await fetch(`${base}/e/${projeto.slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${projeto.ingestToken}` },
    body: JSON.stringify(corpo),
  });
  assert.equal(res.status, 202, `evento webhook recusado: ${await res.text()}`);
}

const sinais = () => estadoInstalacao(projeto.id);

before(async () => {
  await runMigrations();
  await query(
    'TRUNCATE events, deliveries, identities, destinations, project_domains, projects, sessions, user_tokens, users CASCADE'
  );
  await createUser({ email: 'instalacao@empresa.com', password: 'senha-de-teste-123', name: 'Teste Instalação' });

  servidor = createApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'instalacao@empresa.com', password: 'senha-de-teste-123' }),
  });
  cookie = login.headers.getSetCookie().find((c) => c.startsWith('traker_sess=')).split(';')[0];

  const res = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Loja Instalação', domain: 'loja-instalacao.example' }),
  });
  projeto = await res.json();

  const tokenRes = await fetch(`${base}/api/projects/${projeto.id}/ingest-token`, { headers: { Cookie: cookie } });
  projeto.ingestToken = (await tokenRes.json()).ingestToken;
});

after(async () => {
  await new Promise((r) => servidor.close(r));
  await closePool();
});

describe('projeto recém-criado: nenhum sinal mente que está instalado', () => {
  test('todos os sinais respondem "ainda não", e nenhum vem ausente', async () => {
    const s = await sinais();
    const esperados = [
      'tag_navegador', 'pixel_meta', 'clique_anuncio', 'ponte_identidade',
      'webhook_backend', 'entrega_meta', 'entrega_google', 'dominio',
    ];
    for (const nome of esperados) {
      assert.ok(s[nome], `o sinal ${nome} sumiu da resposta — o front renderiza a lista inteira`);
      assert.equal(s[nome].ok, false, `${nome} veio confirmado num projeto sem nenhum evento`);
    }
  });
});

describe('tag no navegador', () => {
  test('confirma com hora e host depois do primeiro page_view', async () => {
    assert.equal((await sinais()).tag_navegador.ok, false);

    await eventoWeb({
      event_name: 'page_view',
      event_id: 'pv-inst-1',
      event_source_url: 'https://loja-instalacao.example/checkout',
    });

    const s = (await sinais()).tag_navegador;
    assert.equal(s.ok, true);
    assert.ok(s.em, 'sem a hora, "confirmado" não diz se foi agora ou mês passado');
    assert.equal(s.onde, 'loja-instalacao.example', 'o host é o que o operador reconhece como o site dele');
    assert.equal(s.ultimas_24h, 1);
  });
});

describe('Pixel da Meta rodando na página', () => {
  test('page_view SEM fbp não confirma o Pixel — é o falso verde que a feature evita', async () => {
    // Este é o caso que mais engana: a tag do TrackServer funciona, os eventos chegam,
    // o dashboard enche — e o Pixel do navegador nunca foi instalado. A CAPI segue
    // entregando, mas sem dedup e com correspondência pior.
    const s = await sinais();
    assert.equal(s.tag_navegador.ok, true, 'a tag já está confirmada neste ponto');
    assert.equal(s.pixel_meta.ok, false, 'não pode confirmar o Pixel sem ter visto um _fbp');
  });

  test('confirma quando chega um evento web com _fbp — só o fbq cria esse cookie', async () => {
    await eventoWeb({
      event_name: 'page_view',
      event_id: 'pv-inst-2',
      event_source_url: 'https://loja-instalacao.example/',
      user_data: { fbp: 'fb.1.1755000000000.1234567890' },
    });

    const s = (await sinais()).pixel_meta;
    assert.equal(s.ok, true);
    assert.ok(s.em);
  });
});

describe('clique de anúncio capturado', () => {
  test('distingue Meta de Google pelo identificador que chegou', async () => {
    await eventoWeb({
      event_name: 'page_view',
      event_id: 'pv-inst-3',
      user_data: { fbc: 'fb.1.1755000000000.IwAR-teste' },
    });

    const s = (await sinais()).clique_anuncio;
    assert.equal(s.ok, true);
    assert.equal(s.meta, true, 'chegou fbc, então o clique da Meta foi capturado');
    assert.equal(s.google, false, 'não chegou gclid neste evento');
  });
});

describe('ponte de identidade', () => {
  test('conta as pessoas amarradas depois de um POST em /c/', async () => {
    assert.equal((await sinais()).ponte_identidade.ok, false);

    await fetch(`${base}/c/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ user_id: 'visitante-inst-1', fbclid: 'IwAR-teste' }),
    });

    const s = (await sinais()).ponte_identidade;
    assert.equal(s.ok, true);
    assert.equal(s.pessoas, 1);
    assert.ok(s.em);
  });
});

describe('webhook do backend', () => {
  test('confirma com o nome do evento que chegou', async () => {
    assert.equal((await sinais()).webhook_backend.ok, false);

    await eventoWebhook({ event_name: 'purchase', event_id: 'compra-inst-1', user_id: 'visitante-inst-1' });

    const s = (await sinais()).webhook_backend;
    assert.equal(s.ok, true);
    assert.equal(s.evento, 'purchase');
    assert.ok(s.em);
  });
});

describe('o que NÃO é sinal', () => {
  test('o mesmo evento pelas duas origens não existe: a ingestão deduplica antes', async () => {
    // Este teste guarda a razão de não haver sinal de "dedup navegador × servidor".
    // Foi escrito depois de a primeira versão da feature tentar exatamente isso e
    // devolver vazio para sempre — `recordEvent` deduplica por (projeto, event_id,
    // event_name) NA INGESTÃO, então o segundo envio nunca vira linha.
    await eventoWeb({ event_name: 'purchase', event_id: 'compra-dedup-1' });
    await eventoWebhook({ event_name: 'purchase', event_id: 'compra-dedup-1' });

    const { rows } = await query(
      `SELECT source FROM events WHERE project_id = $1 AND event_id = 'compra-dedup-1'`,
      [projeto.id]
    );
    assert.equal(rows.length, 1, 'se um dia forem duas linhas, a dedup da ingestão quebrou');

    const s = await sinais();
    assert.equal(s.dedup, undefined, 'o sinal de dedup não deve voltar a existir — ver o comentário em repos/instalacao.js');
  });
});

describe('entrega confirmada pelo destino', () => {
  test('guarda o que a plataforma devolveu, não a nossa opinião', async () => {
    assert.equal((await sinais()).entrega_meta.ok, false);

    // A entrega é escrita pelo worker, que não roda na suíte. Simulamos o resultado
    // dele — este é o único ponto em que o teste escreve direto, porque o que está
    // sendo verificado é a LEITURA da resposta da plataforma.
    const { rows } = await query(
      `SELECT id FROM events WHERE project_id = $1 ORDER BY received_at DESC LIMIT 1`,
      [projeto.id]
    );
    await query(
      `INSERT INTO deliveries (event_row_id, project_id, destination_type, status, http_status, response, updated_at)
            VALUES ($1, $2, 'meta', 'success', 200, $3::jsonb, now())
       ON CONFLICT (event_row_id, destination_type)
       DO UPDATE SET status = 'success', response = EXCLUDED.response, updated_at = now()`,
      [rows[0].id, projeto.id, JSON.stringify({ events_received: 1, fbtrace_id: 'AbC-trace-123' })]
    );

    const s = (await sinais()).entrega_meta;
    assert.equal(s.ok, true);
    assert.equal(s.eventos_recebidos, 1, 'é o número que a Meta devolveu');
    assert.equal(s.fbtrace_id, 'AbC-trace-123', 'é o identificador que o suporte da Meta pede');
  });

  test('entrega com erro NÃO confirma — só `success` conta', async () => {
    const { rows } = await query(
      `SELECT id FROM events WHERE project_id = $1 ORDER BY received_at DESC LIMIT 1`,
      [projeto.id]
    );
    await query(
      `INSERT INTO deliveries (event_row_id, project_id, destination_type, status, http_status, response, updated_at)
            VALUES ($1, $2, 'google', 'error', 400, $3::jsonb, now())
       ON CONFLICT (event_row_id, destination_type)
       DO UPDATE SET status = 'error', response = EXCLUDED.response, updated_at = now()`,
      [rows[0].id, projeto.id, JSON.stringify({ error: 'invalid' })]
    );

    assert.equal((await sinais()).entrega_google.ok, false, 'erro não pode virar confirmação');
  });
});

describe('domínio first-party', () => {
  test('só confirma com certificado emitido (`active`), não com DNS pendente', async () => {
    // O projeto já nasce com o próprio domínio cadastrado como primário — é ele que o
    // painel mostra, e é nele que o teste mexe. Inserir um segundo domínio aqui só
    // testaria a ordenação, não a regra.
    const { rows } = await query(
      `SELECT hostname FROM project_domains WHERE project_id = $1 AND is_primary ORDER BY id LIMIT 1`,
      [projeto.id]
    );
    const hostname = rows[0].hostname;

    await query(
      `UPDATE project_domains SET verification_status = 'pending', ssl_issued_at = NULL
        WHERE project_id = $1 AND hostname = $2`,
      [projeto.id, hostname]
    );
    let s = (await sinais()).dominio;
    assert.equal(s.ok, false, 'DNS pendente não é domínio funcionando');
    assert.equal(s.situacao, 'pending', 'mas o painel mostra em que pé está');

    await query(
      `UPDATE project_domains SET verification_status = 'active', ssl_issued_at = now()
        WHERE project_id = $1 AND hostname = $2`,
      [projeto.id, hostname]
    );
    s = (await sinais()).dominio;
    assert.equal(s.ok, true);
    assert.equal(s.hostname, hostname);
  });
});

describe('contrato de GET /api/projects/:id/instalacao', () => {
  test('devolve sinais e ressalvas, e exige sessão', async () => {
    const semSessao = await fetch(`${base}/api/projects/${projeto.id}/instalacao`);
    assert.equal(semSessao.status, 401, 'rota de projeto não pode responder sem sessão');

    const res = await fetch(`${base}/api/projects/${projeto.id}/instalacao`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const corpo = await res.json();

    assert.ok(corpo.sinais, 'o painel espera { sinais, ressalvas }');
    assert.ok(corpo.ressalvas, 'as ressalvas mudam o significado do "confirmado"');
    assert.equal(typeof corpo.ressalvas.meta_em_modo_teste, 'boolean');
    assert.equal(typeof corpo.ressalvas.google_aceita_em_silencio, 'boolean');
    assert.equal(corpo.sinais.tag_navegador.ok, true);
  });

  test('projeto inexistente devolve 404, não 500', async () => {
    const res = await fetch(`${base}/api/projects/prj_nao_existe/instalacao`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 404);
  });

  test('modo teste da Meta vira ressalva — "confirmado" ali não entra nos dados da conta', async () => {
    await fetch(`${base}/api/projects/${projeto.id}/meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ enabled: true, pixelId: '123456', accessToken: 'EAAtoken-de-teste', testEventCode: 'TEST123' }),
    });

    const corpo = await (await fetch(`${base}/api/projects/${projeto.id}/instalacao`, { headers: { Cookie: cookie } })).json();
    assert.equal(corpo.ressalvas.meta_em_modo_teste, true,
      'sem esta ressalva o operador conclui que a campanha está otimizando, e não está');
  });
});

describe('custo das consultas', () => {
  test('nenhum sinal varre a tabela de eventos', async () => {
    // A confirmação é aberta a cada visita da aba Instalação e reconsultada ao vivo.
    // Uma consulta que hoje é instantânea com 5 eventos e faz seq scan vira um problema
    // silencioso no primeiro cliente com volume — e o sintoma aparece no cliente, não aqui.
    const { rows } = await query(
      `EXPLAIN (FORMAT JSON)
       SELECT received_at FROM events
        WHERE project_id = $1 AND source = 'web'
        ORDER BY received_at DESC LIMIT 1`,
      [projeto.id]
    );
    const plano = JSON.stringify(rows[0]['QUERY PLAN']);
    assert.ok(
      !plano.includes('"Seq Scan"'),
      `a consulta do sinal da tag está varrendo events: ${plano}`
    );
  });
});
