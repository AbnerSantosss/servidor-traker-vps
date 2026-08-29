// Testes da F5 (backend): integração com a OpenRouter para estruturar payload de
// webhook com IA. Segue o estilo de test/integracao.test.js (fetch interceptado, API
// real contra Postgres real) e test/webhook-studio.test.js (parte pura + parte de
// integração no mesmo arquivo).
//
// NUNCA chama a OpenRouter de verdade: todo fetch para openrouter.ai é interceptado
// abaixo, do mesmo jeito que test/integracao.test.js intercepta graph.facebook.com.
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { createUser } from '../src/db/repos/users.js';
import { createProject } from '../src/db/repos/projects.js';
import { recordEvent } from '../src/db/repos/events.js';
import { processDelivery, hashearPiiParaPrompt } from '../src/queue/dispatcher.js';

// ============================================================== interceptação de fetch

const fetchOriginal = globalThis.fetch;

// Fila de respostas para /chat/completions, consumida NA ORDEM a cada chamada — assim
// um teste consegue simular "primeira resposta é JSON inválido, segunda é válida" (a
// retentativa) sem depender de estado externo.
let filaRespostasChat = [];
let respostaModelos = { status: 200, data: [] };
let chamadasOpenRouter = []; // { caminho, url, corpo } — para inspecionar o que foi enviado
let chamadasMeta = []; // { url, body } — só para o modo "IA por evento" não travar num send() de verdade

function respostaChatPadrao() {
  return { status: 200, choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } };
}

globalThis.fetch = async (url, options) => {
  const alvo = String(url);
  // O modo "IA por evento" segue até `send()` de verdade (src/destinations/meta.js)
  // depois de estruturar o evento — precisa de um destino mockado para não bater na
  // rede real, do mesmo jeito que test/integracao.test.js intercepta graph.facebook.com.
  if (alvo.includes('graph.facebook.com')) {
    chamadasMeta.push({ url: alvo, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace-teste-ia' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (alvo.includes('openrouter.ai')) {
    const corpo = options?.body ? JSON.parse(options.body) : null;
    chamadasOpenRouter.push({ url: alvo, corpo, headers: options?.headers });

    if (alvo.includes('/chat/completions')) {
      const proxima = filaRespostasChat.shift() || respostaChatPadrao();
      if (proxima.abortar) {
        // Simula o timeout SEM esperar o relógio de verdade: o cliente
        // (src/ia/openrouter.js) trata qualquer erro com name 'AbortError' como
        // timeout, então isto exercita o mesmo caminho de código que um AbortController
        // de verdade produziria, sem o teste precisar esperar 15s reais.
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }
      return new Response(JSON.stringify(proxima), {
        status: proxima.status || 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (alvo.includes('/models')) {
      return new Response(JSON.stringify(respostaModelos), {
        status: respostaModelos.status || 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  return fetchOriginal(url, options);
};

// ============================================================== hashearPiiParaPrompt (puro)

describe('hashearPiiParaPrompt — PII hasheada antes do prompt (I-8)', () => {
  test('email, telefone e nome viram hash sha256; outros campos passam intactos', () => {
    const bruto = {
      status: 'aprovado',
      valor: 199.9,
      cliente: { email: 'pessoa@exemplo.com', telefone: '11999998888', nome: 'Maria da Silva' },
      pedido_id: 'PED-1',
    };
    const hasheado = hashearPiiParaPrompt(bruto);

    assert.notEqual(hasheado.cliente.email, 'pessoa@exemplo.com');
    assert.match(hasheado.cliente.email, /^[a-f0-9]{64}$/);
    assert.notEqual(hasheado.cliente.telefone, '11999998888');
    assert.match(hasheado.cliente.telefone, /^[a-f0-9]{64}$/);
    assert.notEqual(hasheado.cliente.nome, 'Maria da Silva');
    assert.match(hasheado.cliente.nome, /^[a-f0-9]{64}$/);

    // Não-PII passa intacto — não é para hashear tudo.
    assert.equal(hasheado.status, 'aprovado');
    assert.equal(hasheado.valor, 199.9);
    assert.equal(hasheado.pedido_id, 'PED-1');
  });

  test('funciona aninhado em listas', () => {
    const hasheado = hashearPiiParaPrompt({ itens: [{ email: 'a@b.com' }, { email: 'c@d.com' }] });
    assert.match(hasheado.itens[0].email, /^[a-f0-9]{64}$/);
    assert.match(hasheado.itens[1].email, /^[a-f0-9]{64}$/);
  });
});

// ============================================================== integração (Postgres real)

let servidor;
let base;
let cookieAdmin = '';
let cookieOperador = '';

const api = (caminho, opcoes = {}, cookie = cookieAdmin) =>
  fetchOriginal(`${base}${caminho}`, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...opcoes.headers },
  });

before(async () => {
  await runMigrations();
  await query(`TRUNCATE ia_uso_mensal, webhook_amostras, adaptadores_projeto, events, deliveries,
                identities, destinations, project_domains, projects, sessions, user_tokens, users CASCADE`);
  await createUser({ email: 'admin-ia@empresa.com', password: 'senha-de-teste-123', name: 'Admin IA', role: 'admin' });
  await createUser({ email: 'operador-ia@empresa.com', password: 'senha-de-teste-123', name: 'Operador IA', role: 'operador' });

  servidor = createApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;

  const loginAdmin = await fetchOriginal(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin-ia@empresa.com', password: 'senha-de-teste-123' }),
  });
  cookieAdmin = loginAdmin.headers.getSetCookie().find((c) => c.startsWith('traker_sess=')).split(';')[0];

  const loginOperador = await fetchOriginal(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'operador-ia@empresa.com', password: 'senha-de-teste-123' }),
  });
  cookieOperador = loginOperador.headers.getSetCookie().find((c) => c.startsWith('traker_sess=')).split(';')[0];
});

after(async () => {
  globalThis.fetch = fetchOriginal;
  await new Promise((r) => servidor.close(r));
  await closePool();
});

beforeEach(() => {
  filaRespostasChat = [];
  respostaModelos = { status: 200, data: [] };
  chamadasOpenRouter = [];
  chamadasMeta = [];
});

// -------------------------------------------------------------- PUT /projects/:id/ia

describe('PUT /projects/:id/ia — chave cifrada, nunca devolvida, "em branco" mantém', () => {
  test('salva a chave: a resposta nunca traz o valor, só hasIaKey', async () => {
    const projeto = await createProject({ name: 'Projeto IA 1', domain: 'projeto-ia-1.com' });
    const res = await api(`/api/projects/${projeto.id}/ia`, {
      method: 'PUT',
      body: JSON.stringify({ apiKey: 'sk-or-v1-segredo-de-teste', modelo: 'deepseek/deepseek-v4-flash', habilitada: true }),
    });
    assert.equal(res.status, 200);
    const corpo = await res.json();
    assert.equal(corpo.ia.hasIaKey, true);
    assert.equal(corpo.ia.modelo, 'deepseek/deepseek-v4-flash');
    assert.equal(corpo.ia.enabled, true);
    assert.equal(JSON.stringify(corpo).includes('sk-or-v1-segredo-de-teste'), false, 'a chave em claro nunca pode aparecer na resposta');

    // E também não fica gravada em claro no banco — só o valor cifrado.
    const { rows } = await query('SELECT ia_openrouter_key_enc FROM projects WHERE id = $1', [projeto.id]);
    assert.ok(rows[0].ia_openrouter_key_enc);
    assert.equal(rows[0].ia_openrouter_key_enc.includes('sk-or-v1-segredo-de-teste'), false);
  });

  test('campo apiKey em branco mantém a chave atual (nunca apaga)', async () => {
    const projeto = await createProject({ name: 'Projeto IA 2', domain: 'projeto-ia-2.com' });
    await api(`/api/projects/${projeto.id}/ia`, {
      method: 'PUT', body: JSON.stringify({ apiKey: 'sk-or-chave-original', modelo: 'modelo-x' }),
    });
    const { rows: antes } = await query('SELECT ia_openrouter_key_enc FROM projects WHERE id = $1', [projeto.id]);

    // Salva de novo só o modelo, com apiKey ausente E com apiKey em branco — em ambos
    // os casos a chave gravada não pode mudar.
    await api(`/api/projects/${projeto.id}/ia`, { method: 'PUT', body: JSON.stringify({ modelo: 'modelo-y' }) });
    const resBranco = await api(`/api/projects/${projeto.id}/ia`, { method: 'PUT', body: JSON.stringify({ apiKey: '', modelo: 'modelo-z' }) });

    const { rows: depois } = await query('SELECT ia_openrouter_key_enc FROM projects WHERE id = $1', [projeto.id]);
    assert.equal(depois[0].ia_openrouter_key_enc, antes[0].ia_openrouter_key_enc, 'a chave cifrada não pode mudar quando apiKey vem em branco/ausente');
    const corpoBranco = await resBranco.json();
    assert.equal(corpoBranco.ia.modelo, 'modelo-z');
    assert.equal(corpoBranco.ia.hasIaKey, true);
  });

  test('operador (não-admin) é barrado', async () => {
    const projeto = await createProject({ name: 'Projeto IA Operador', domain: 'projeto-ia-operador.com' });
    const res = await api(`/api/projects/${projeto.id}/ia`, {
      method: 'PUT', body: JSON.stringify({ apiKey: 'sk-or-x' }),
    }, cookieOperador);
    assert.equal(res.status, 403);
  });
});

// -------------------------------------------------------------- GET /projects/:id/ia/modelos

describe('GET /projects/:id/ia/modelos — proxy server-side, cacheado', () => {
  test('sem chave configurada, devolve erro claro (nunca chega a chamar a OpenRouter)', async () => {
    const projeto = await createProject({ name: 'Projeto Modelos Sem Chave', domain: 'projeto-modelos-sem-chave.com' });
    const res = await api(`/api/projects/${projeto.id}/ia/modelos`);
    assert.equal(res.status, 400);
    const corpo = await res.json();
    assert.match(corpo.error, /chave/i);
    assert.equal(chamadasOpenRouter.length, 0);
  });

  test('com chave configurada, devolve a lista enxuta e ordenada, e usa cache no clique seguinte', async () => {
    const projeto = await createProject({ name: 'Projeto Modelos', domain: 'projeto-modelos.com' });
    await api(`/api/projects/${projeto.id}/ia`, { method: 'PUT', body: JSON.stringify({ apiKey: 'sk-or-modelos' }) });

    respostaModelos = {
      status: 200,
      data: [
        { id: 'zeta/modelo', name: 'Zeta Modelo', context_length: 32000, pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek v4 Flash', context_length: 128000, pricing: { prompt: '0.0000002', completion: '0.0000006' } },
      ],
    };

    const res1 = await api(`/api/projects/${projeto.id}/ia/modelos`);
    assert.equal(res1.status, 200);
    const corpo1 = await res1.json();
    assert.equal(corpo1.cache, false);
    assert.equal(corpo1.modelos.length, 2);
    assert.equal(corpo1.modelos[0].nome, 'DeepSeek v4 Flash', 'ordenado por nome');
    assert.equal(corpo1.modelos[0].preco_prompt, 0.2, 'preço por milhão de tokens, não por token');
    const chamadasApósPrimeira = chamadasOpenRouter.length;

    const res2 = await api(`/api/projects/${projeto.id}/ia/modelos`);
    const corpo2 = await res2.json();
    assert.equal(corpo2.cache, true);
    assert.equal(chamadasOpenRouter.length, chamadasApósPrimeira, 'segunda chamada não bate na OpenRouter de novo — usa cache');
  });

  test('operador (não-admin) é barrado', async () => {
    const projeto = await createProject({ name: 'Projeto Modelos Operador', domain: 'projeto-modelos-operador.com' });
    const res = await api(`/api/projects/${projeto.id}/ia/modelos`, {}, cookieOperador);
    assert.equal(res.status, 403);
  });
});

// -------------------------------------------------------------- POST /projects/:id/ia/mapear

describe('POST /projects/:id/ia/mapear — nunca salva, sempre valida', () => {
  async function projetoComIaConfigurada(nome, dominio) {
    const projeto = await createProject({ name: nome, domain: dominio });
    await api(`/api/projects/${projeto.id}/ia`, {
      method: 'PUT', body: JSON.stringify({ apiKey: 'sk-or-mapear', modelo: 'deepseek/deepseek-v4-flash' }),
    });
    return projeto;
  }

  test('JSON inválido: retenta uma vez e, se continuar inválido, devolve erro legível (nunca 500)', async () => {
    const projeto = await projetoComIaConfigurada('Projeto Mapear JSON Invalido', 'projeto-mapear-json-invalido.com');
    filaRespostasChat = [
      { status: 200, choices: [{ message: { content: 'isto não é json nenhum' } }], usage: { cost: 0.0002 } },
      { status: 200, choices: [{ message: { content: 'ainda não é json' } }], usage: { cost: 0.0002 } },
    ];

    const res = await api(`/api/projects/${projeto.id}/ia/mapear`, {
      method: 'POST', body: JSON.stringify({ amostra: { tipo: 'x' } }),
    });
    assert.notEqual(res.status, 500);
    assert.equal(res.status, 502);
    const corpo = await res.json();
    assert.match(corpo.error, /JSON/i);

    // Retentativa de verdade: duas chamadas de /chat/completions, não uma.
    const chamadasChat = chamadasOpenRouter.filter((c) => c.url.includes('/chat/completions'));
    assert.equal(chamadasChat.length, 2);
  });

  test('REGRA MAIS IMPORTANTE: mapeamento da IA que produz "purchase" sem condição de pagamento é RECUSADO', async () => {
    const projeto = await projetoComIaConfigurada('Projeto Mapear Purchase Sem Condicao', 'projeto-mapear-purchase-sem-condicao.com');
    filaRespostasChat = [{
      status: 200,
      choices: [{
        message: {
          content: JSON.stringify({
            deteccao: { obrigatorias: ['tipo', 'id'], qualquerUma: [] },
            mapeamento: {
              evento: { de: 'tipo', transformar: 'constante', args: { valor: 'purchase' } },
              regras: [],
            },
          }),
        },
      }],
      usage: { cost: 0.0003 },
    }];

    const res = await api(`/api/projects/${projeto.id}/ia/mapear`, {
      method: 'POST', body: JSON.stringify({ amostra: { tipo: 'pedido.pago', id: 1 } }),
    });
    assert.equal(res.status, 200, 'a IA errar não é um erro HTTP — é devolvido com validacao.valido=false para o operador corrigir');
    const corpo = await res.json();
    assert.equal(corpo.validacao.valido, false);
    assert.ok(corpo.validacao.erros.some((e) => /não é permitida/.test(e)));
    // O rascunho inválido ainda é devolvido — o operador PRECISA vê-lo para corrigir à mão.
    assert.equal(corpo.mapeamento.evento.transformar, 'constante');

    // Nada foi persistido: este endpoint NUNCA salva adaptador nenhum.
    const { rows } = await query('SELECT COUNT(*)::int AS n FROM adaptadores_projeto WHERE project_id = $1', [projeto.id]);
    assert.equal(rows[0].n, 0);
  });

  test('mapeamento válido: aceito, com preview, e nada é persistido', async () => {
    const projeto = await projetoComIaConfigurada('Projeto Mapear Valido', 'projeto-mapear-valido.com');
    filaRespostasChat = [{
      status: 200,
      choices: [{
        message: {
          content: JSON.stringify({
            deteccao: { obrigatorias: ['tipo', 'id'], qualquerUma: [] },
            mapeamento: {
              evento: {
                de: 'tipo', transformar: 'mapear_valores',
                condicaoPagamento: { de: 'status', valoresConfirmados: ['pago'] },
                args: { dicionario: { compra: { sePago: 'purchase', senaoPago: 'checkout_concluido' } } },
              },
              regras: [{ de: 'cliente.email', para: 'user_data.email', transformar: 'texto' }],
            },
          }),
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0005 },
    }];

    const res = await api(`/api/projects/${projeto.id}/ia/mapear`, {
      method: 'POST',
      body: JSON.stringify({ amostra: { tipo: 'compra', status: 'pago', id: 1, cliente: { email: 'a@b.com' } } }),
    });
    assert.equal(res.status, 200);
    const corpo = await res.json();
    assert.equal(corpo.validacao.valido, true);
    assert.equal(corpo.preview.event_name, 'purchase');
    assert.equal(corpo.preview.user_data.email, 'a@b.com');
    assert.equal(corpo.custo.custoUsd, 0.0005);
    assert.ok(corpo.promptVersao);

    const { rows } = await query('SELECT COUNT(*)::int AS n FROM adaptadores_projeto WHERE project_id = $1', [projeto.id]);
    assert.equal(rows[0].n, 0, 'POST /ia/mapear nunca persiste adaptador');

    // Custo foi registrado para o mês corrente.
    const uso = await (await api(`/api/projects/${projeto.id}/ia/uso`)).json();
    assert.equal(uso.custoUsd, 0.0005);
    assert.equal(uso.chamadas, 1);
  });

  test('operador (não-admin) é barrado', async () => {
    const projeto = await projetoComIaConfigurada('Projeto Mapear Operador', 'projeto-mapear-operador.com');
    const res = await api(`/api/projects/${projeto.id}/ia/mapear`, {
      method: 'POST', body: JSON.stringify({ amostra: { a: 1 } }),
    }, cookieOperador);
    assert.equal(res.status, 403);
  });
});

// -------------------------------------------------------------- allowlist de host

describe('allowlist de host — o cliente da OpenRouter só fala com openrouter.ai', () => {
  test('toda chamada feita durante os testes acima tem host openrouter.ai', async () => {
    const projeto = await createProject({ name: 'Projeto Allowlist', domain: 'projeto-allowlist.com' });
    await api(`/api/projects/${projeto.id}/ia`, { method: 'PUT', body: JSON.stringify({ apiKey: 'sk-or-allow' }) });
    respostaModelos = { status: 200, data: [{ id: 'x', name: 'X', pricing: {} }] };
    await api(`/api/projects/${projeto.id}/ia/modelos`);

    assert.ok(chamadasOpenRouter.length > 0);
    for (const chamada of chamadasOpenRouter) {
      const host = new URL(chamada.url).host;
      assert.equal(host, 'openrouter.ai', `chamada foi para host inesperado: ${chamada.url}`);
      assert.ok(chamada.url.startsWith('https://openrouter.ai/api/v1/'), 'sempre o mesmo prefixo fixo, nunca composto por configuração');
    }
  });
});

// -------------------------------------------------------------- modo "IA por evento" no dispatcher

describe('modo "IA por evento" — roda no worker, nunca na ingestão', () => {
  async function eventoIaPendente(projeto, { iaBruto, eventId }) {
    const { row } = await recordEvent({
      project: projeto,
      event: {
        event_id: eventId,
        event_name: 'pendente_estruturacao_ia',
        source: 'webhook',
        ia_por_evento: true,
        ia_bruto: iaBruto,
      },
      destinationTypes: ['meta'],
    });
    const { rows } = await query('SELECT * FROM deliveries WHERE event_row_id = $1 AND destination_type = $2', [row.id, 'meta']);
    return { event: row, delivery: rows[0] };
  }

  test('PII é hasheada antes do prompt — o texto enviado à IA nunca contém o e-mail em claro', async () => {
    const projeto = await createProject({ name: 'Projeto Ia Evento Pii', domain: 'projeto-ia-evento-pii.com' });
    await api(`/api/projects/${projeto.id}/ia`, { method: 'PUT', body: JSON.stringify({ apiKey: 'sk-or-evento', modelo: 'modelo-evento' }) });
    await api(`/api/projects/${projeto.id}/meta`, { method: 'PUT', body: JSON.stringify({ enabled: true, pixelId: '123', accessToken: 'tok' }) });

    filaRespostasChat = [{
      status: 200,
      choices: [{ message: { content: JSON.stringify({ evento: { event_name: 'lead', user_data: { email: 'hash-vai-aqui' } } }) } }],
      usage: { cost: 0.0001 },
    }];

    const { event, delivery } = await eventoIaPendente(projeto, {
      eventId: 'evt-pii-1',
      iaBruto: { status: 'novo', cliente: { email: 'realmente-secreto@exemplo.com', nome: 'Fulano da Silva' } },
    });

    await processDelivery({ delivery, event });

    const chamadaChat = chamadasOpenRouter.find((c) => c.url.includes('/chat/completions'));
    assert.ok(chamadaChat);
    const textoEnviado = JSON.stringify(chamadaChat.corpo);
    assert.equal(textoEnviado.includes('realmente-secreto@exemplo.com'), false, 'e-mail em claro nunca pode ir para o prompt');
    assert.equal(textoEnviado.includes('Fulano da Silva'), false, 'nome em claro nunca pode ir para o prompt');
  });

  test('purchase sem sinal de pagamento no payload bruto é rebaixado, mesmo que a IA tenha dito "purchase"', async () => {
    const projeto = await createProject({ name: 'Projeto Ia Evento Purchase Falso', domain: 'projeto-ia-evento-purchase-falso.com' });
    await api(`/api/projects/${projeto.id}/ia`, { method: 'PUT', body: JSON.stringify({ apiKey: 'sk-or-evento2', modelo: 'modelo-evento' }) });
    await api(`/api/projects/${projeto.id}/meta`, { method: 'PUT', body: JSON.stringify({ enabled: true, pixelId: '123', accessToken: 'tok' }) });

    filaRespostasChat = [{
      status: 200,
      choices: [{
        message: {
          content: JSON.stringify({
            evento: {
              event_name: 'purchase',
              event_time: Math.floor(Date.now() / 1000),
              action_source: 'website',
              custom_data: { value: 100 },
            },
          }),
        },
      }],
      usage: { cost: 0.0001 },
    }];

    const { event, delivery } = await eventoIaPendente(projeto, {
      eventId: 'evt-purchase-falso',
      iaBruto: { tipo: 'algo', sem_status_nenhum: true },
    });

    await processDelivery({ delivery, event });

    // A prova concreta de que a regra dura funcionou: o que de fato saiu para a Meta
    // NÃO é "Purchase" — mesmo a IA tendo dito "purchase" no JSON que devolveu.
    assert.equal(chamadasMeta.length, 1);
    assert.notEqual(chamadasMeta[0].body.data[0].event_name, 'Purchase');
    assert.equal(chamadasMeta[0].body.data[0].event_name, 'estruturado_por_ia_sem_confirmacao_pagamento');
  });

  test('timeout da IA vira entrega "error" (não "dead", não trava a fila) com last_error prefixado "ia:"', async () => {
    const projeto = await createProject({ name: 'Projeto Ia Evento Timeout', domain: 'projeto-ia-evento-timeout.com' });
    await api(`/api/projects/${projeto.id}/ia`, { method: 'PUT', body: JSON.stringify({ apiKey: 'sk-or-timeout', modelo: 'modelo-lento' }) });
    await api(`/api/projects/${projeto.id}/meta`, { method: 'PUT', body: JSON.stringify({ enabled: true, pixelId: '123', accessToken: 'tok' }) });

    // As duas tentativas (TENTATIVAS_MAX_IA_EVENTO) abortam — simula timeout sem
    // esperar 15s de verdade.
    filaRespostasChat = [{ abortar: true }, { abortar: true }];

    const { event, delivery } = await eventoIaPendente(projeto, {
      eventId: 'evt-timeout-1',
      iaBruto: { qualquer: 'coisa' },
    });

    const resultado = await processDelivery({ delivery, event });
    assert.equal(resultado.status, 'retry', 'não pode virar "dead" na primeira falha — só "error"/retry');

    const { rows } = await query('SELECT status, last_error FROM deliveries WHERE id = $1', [delivery.id]);
    assert.equal(rows[0].status, 'error');
    assert.match(rows[0].last_error, /^ia:/);
  });
});
