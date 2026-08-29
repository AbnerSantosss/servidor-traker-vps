// Testes do Webhook Studio (F4 do Plano-Melhorias-Painel.md, seção 7): a DSL
// declarativa e seu interpretador (src/ingest/mapeamento.js), a captura de amostras e
// o CRUD de adaptadores dinâmicos (src/db/repos/webhooks.js), e os endpoints novos de
// src/admin/router.js. Segue o estilo de test/falhas.test.js e test/unit.test.js:
// parte unitária pura (sem banco) e parte de integração (API real contra Postgres real).
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  obterCaminho, definirCaminho, aplicarMapeamento, validarMapeamento, validarDeteccao,
  detectarComMapeamento, sugerirMapeamento, TRANSFORMACOES,
} from '../src/ingest/mapeamento.js';
import { adaptarPayload, nomeDoEvento } from '../src/ingest/adaptadores.js';
import {
  capturarAmostra, mascararAmostra, hashEstrutura, headersRelevantes,
  MAX_AMOSTRAS_POR_DIA, MAX_AMOSTRAS_POR_HASH,
  invalidarCacheAdaptadores,
} from '../src/db/repos/webhooks.js';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { createUser } from '../src/db/repos/users.js';
import { createProject } from '../src/db/repos/projects.js';

// ============================================================== fixture do checkout
// (idêntica à de test/unit.test.js — "os mesmos payloads de exemplo dos testes
// existentes", exigido pela prova de suficiência)

const baseCodigoVencedor = () => ({
  lead: { name: 'Joao marcos rocha de araujo', email: 'joaomarcosflamengo32@gmail.com', phone: '83996031060', taxId: '04970261474' },
  event: 'checkout.session.completed',
  method: 'pix',
  eventId: '9a712a559fe0431182894719ac73f825',
  pricing: { couponCode: 'TESTE99', discountMinor: 9699, originalAmountMinor: 9700 },
  currency: 'BRL',
  paymentId: 'bedd9a1c-79f3-418f-9387-fa3ff4f96c38',
  sessionId: 'e4e3439c-72a1-4176-b943-4f9cae5c8c0a',
  occurredAt: '2026-08-12T16:56:03.9253407+00:00',
  productIds: ['plan-4'],
  amountMinor: 1,
  attribution: {
    utm: { term: null, medium: null, source: null, content: null, campaign: null },
    cookies: { ga: 'GA1.1.121717542.1784724157', fbc: null, fbp: 'fb.1.1784724156950.41423591235669370.AQYAAQIB', gclAu: null, gclid: null, fbclid: null, gbraid: null, wbraid: null },
    ipAddress: '::ffff:10.244.16.187',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/151.0.0.0',
    eventSourceUrl: 'https://codigovencedor.com/',
  },
  paymentStatus: 'paid',
  customerReference: null,
});

// Mapeamento declarativo que reproduz o adaptador `codigo-vencedor` INTEIRO (a "prova
// de suficiência" pedida). Espelha, campo a campo, src/ingest/adaptadores.js:
// codigoVencedor.adaptar + nomeDoEvento.
const mapeamentoCodigoVencedor = {
  evento: {
    de: 'event',
    transformar: 'mapear_valores',
    condicaoPagamento: { de: 'paymentStatus', valoresConfirmados: ['paid', 'approved', 'confirmed', 'succeeded', 'completed'] },
    args: {
      dicionario: {
        user_registered: 'sign_up',
        onboarding_completed: 'onboarding_concluido',
        precheckout_opened: 'lead',
        precheckout_expired: 'precheckout_expirado',
        checkout_session_opened: 'begin_checkout',
        payment_generated: 'pix_gerado',
        checkout_card_attempted: 'cartao_tentado',
        checkout_abandoned: 'abandoned_checkout',
        checkout_lead_abandoned: 'lead_abandonado',
        purchase_approved: 'purchase',
        purchase_refunded: 'compra_estornada',
        chargeback_opened: 'chargeback',
        subscription_started: 'assinatura_iniciada',
        subscription_renewed: 'assinatura_renovada',
        subscription_cancelled: 'assinatura_cancelada',
        subscription_expired: 'assinatura_expirada',
        ebook_completed: 'ebook_concluido',
        tool_used: 'ferramenta_usada',
        'checkout.pix.generated': 'pix_gerado',
        'checkout.session.created': 'begin_checkout',
        'checkout.session.opened': 'begin_checkout',
        'checkout.session.expired': 'abandoned_checkout',
        'checkout.lead.abandoned': 'lead_abandonado',
        'pre.checkout.session.opened': 'lead',
        'pre.checkout.session.expired': 'precheckout_expirado',
        'checkout.session.completed': { sePago: 'purchase', senaoPago: 'checkout_concluido' },
        'payment.approved': 'purchase',
        'payment.confirmed': 'purchase',
        'payment.paid': 'purchase',
        'checkout.payment.approved': 'purchase',
        'order.paid': 'purchase',
        'lead.created': 'lead',
        'subscription.created': 'assinatura_iniciada',
      },
    },
  },
  regras: [
    { de: ['eventId', 'paymentId', 'sessionId'], para: 'event_id', transformar: 'primeiro_preenchido' },
    { de: 'occurredAt', para: 'event_time', transformar: 'unix_de_iso' },
    { para: 'action_source', transformar: 'constante', args: { valor: 'website' } },
    { de: 'attribution.eventSourceUrl', para: 'event_source_url', transformar: 'texto' },
    { de: ['customerReference', 'lead.taxId', 'sessionId'], para: 'user_id', transformar: 'primeiro_preenchido' },

    { de: 'lead.email', para: 'user_data.email', transformar: 'texto' },
    { de: 'lead.phone', para: 'user_data.phone', transformar: 'texto' },
    { de: 'lead.name', para: 'user_data', transformar: 'separar_nome' },
    { de: ['customerReference', 'lead.taxId'], para: 'user_data.external_id', transformar: 'primeiro_preenchido' },

    { de: 'attribution.cookies.fbp', para: 'user_data.fbp', transformar: 'texto' },
    { de: 'attribution.cookies.fbc', para: 'user_data.fbc', transformar: 'texto' },
    { de: 'attribution.cookies.fbclid', para: 'user_data.fbclid', transformar: 'texto' },
    { de: ['attribution.cookies.gclid', 'attribution.cookies.gclAu'], para: 'user_data.gclid', transformar: 'primeiro_preenchido' },
    { de: 'attribution.cookies.gbraid', para: 'user_data.gbraid', transformar: 'texto' },
    { de: 'attribution.cookies.wbraid', para: 'user_data.wbraid', transformar: 'texto' },
    { de: 'attribution.cookies.ga', para: 'user_data.ga_client_id', transformar: 'ga_client_id' },

    { de: 'attribution.utm.source', para: 'user_data.utm_source', transformar: 'texto' },
    { de: 'attribution.utm.medium', para: 'user_data.utm_medium', transformar: 'texto' },
    { de: 'attribution.utm.campaign', para: 'user_data.utm_campaign', transformar: 'texto' },
    { de: 'attribution.utm.content', para: 'user_data.utm_content', transformar: 'texto' },
    { de: 'attribution.utm.term', para: 'user_data.utm_term', transformar: 'texto' },

    { de: 'attribution.userAgent', para: 'user_data.client_user_agent', transformar: 'texto' },
    { de: 'attribution.ipAddress', para: 'user_data.client_ip_address', transformar: 'ip_publico' },

    { de: 'amountMinor', para: 'custom_data.value', transformar: 'centavos_para_reais' },
    { de: 'currency', para: 'custom_data.currency', transformar: 'primeiro_preenchido', args: { padrao: 'BRL' } },
    { de: ['paymentId', 'sessionId'], para: 'custom_data.order_id', transformar: 'primeiro_preenchido' },
    { de: 'productIds', para: 'custom_data.content_ids', transformar: 'primeiro_preenchido' },
    { de: 'productIds', para: 'custom_data.content_type', transformar: 'marcador_presenca', args: { valor: 'product' } },
    { de: 'productIds', para: 'custom_data.num_items', transformar: 'contagem' },
    { de: 'method', para: 'custom_data.payment_method', transformar: 'texto' },
    { de: 'pricing.couponCode', para: 'custom_data.coupon', transformar: 'texto' },
    { de: 'pricing.originalAmountMinor', para: 'custom_data.valor_original', transformar: 'centavos_para_reais' },
    { de: 'pricing.discountMinor', para: 'custom_data.desconto', transformar: 'centavos_para_reais' },
  ],
};

const mapeamentoValido = () => JSON.parse(JSON.stringify(mapeamentoCodigoVencedor));

// O adaptador hardcoded monta o objeto inteiro na unha, então campos ausentes viram
// chave com valor `undefined` (ex.: `fbc: texto(cookies.fbc)` quando não há fbc); a
// DSL, por design (ver definirCaminho), nunca escreve uma chave para valor
// `undefined` — "melhor faltar do que mandar chave vazia". As duas formas são
// EQUIVALENTES em tudo que importa (JSON.stringify — o que de fato viaja para o banco
// e para as APIs de destino — trata `{x: undefined}` e `{}` da mesma forma), então a
// comparação da prova de suficiência normaliza por esse round-trip antes de comparar.
const semChavesUndefined = (obj) => JSON.parse(JSON.stringify(obj));

// ============================================================== prova de suficiência

describe('prova de suficiência — DSL reproduz o adaptador codigo-vencedor inteiro', () => {
  test('mapeamento declarado é válido pela própria regra dura', () => {
    const { valido, erros } = validarMapeamento(mapeamentoCodigoVencedor);
    assert.equal(valido, true, erros.join('; '));
  });

  test('o evento canônico produzido pela DSL é IGUAL ao do adaptador hardcoded (payload base)', () => {
    const corpo = baseCodigoVencedor();
    const { corpo: esperado } = adaptarPayload(corpo);
    const { evento: obtido } = aplicarMapeamento(corpo, mapeamentoCodigoVencedor);
    assert.deepEqual(semChavesUndefined(obtido), semChavesUndefined(esperado));
  });

  test('PIX gerado: mesmo resultado, incluindo valor pretendido sem virar receita', () => {
    const pix = {
      ...baseCodigoVencedor(),
      event: 'checkout.pix.generated',
      eventId: '36781fb1509a47b4b2424f13c6a70147',
      amountMinor: 9700,
      pricing: { couponCode: null, discountMinor: 0, originalAmountMinor: 9700 },
    };
    delete pix.paymentStatus;

    const { corpo: esperado } = adaptarPayload(pix);
    const { evento: obtido } = aplicarMapeamento(pix, mapeamentoCodigoVencedor);
    assert.deepEqual(semChavesUndefined(obtido), semChavesUndefined(esperado));
    assert.equal(obtido.event_name, 'pix_gerado');
    assert.equal(obtido.custom_data.value, 97);
  });

  test('IP privado descartado e User-Agent do comprador preservado — igual ao hardcoded', () => {
    const corpo = baseCodigoVencedor();
    const { evento } = aplicarMapeamento(corpo, mapeamentoCodigoVencedor);
    assert.equal(evento.user_data.client_ip_address, undefined);
    assert.match(evento.user_data.client_user_agent, /Chrome/);
  });

  test('IP público é aproveitado — igual ao hardcoded', () => {
    const corpo = baseCodigoVencedor();
    corpo.attribution.ipAddress = '::ffff:187.45.22.10';
    const { evento } = aplicarMapeamento(corpo, mapeamentoCodigoVencedor);
    assert.equal(evento.user_data.client_ip_address, '187.45.22.10');
  });

  test('separa nome em fn/ln e extrai o client_id do GA4 — igual ao hardcoded', () => {
    const { evento } = aplicarMapeamento(baseCodigoVencedor(), mapeamentoCodigoVencedor);
    assert.equal(evento.user_data.first_name, 'Joao');
    assert.equal(evento.user_data.last_name, 'araujo');
    assert.equal(evento.user_data.ga_client_id, '121717542.1784724157');
  });

  test('detecção reproduz o marcador event + eventId + (lead|attribution)', () => {
    const deteccao = { obrigatorias: ['event', 'eventId'], qualquerUma: ['lead', 'attribution'] };
    assert.equal(validarDeteccao(deteccao).valido, true);
    assert.equal(detectarComMapeamento(baseCodigoVencedor(), deteccao), true);
    assert.equal(detectarComMapeamento({ event_name: 'purchase' }, deteccao), false);
  });

  describe('catálogo completo de nomeDoEvento — DSL bate 1:1 com o hardcoded', () => {
    const casos = [
      ['purchase_approved', {}], ['payment_generated', {}], ['checkout_card_attempted', {}],
      ['checkout_session_opened', {}], ['checkout_abandoned', {}], ['precheckout_opened', {}],
      ['checkout_lead_abandoned', {}], ['user_registered', {}], ['subscription_started', {}],
      ['subscription_renewed', {}], ['purchase_refunded', {}], ['chargeback_opened', {}],
      ['checkout.pix.generated', {}], ['checkout.session.completed', {}],
      ['checkout.session.completed', { paymentStatus: 'paid' }],
      ['payment.approved', {}], ['order.paid', {}],
      ['algo.novo.qualquer', { paymentStatus: 'approved' }],
      ['checkout.boleto.generated', {}],
    ];

    for (const [evento, extra] of casos) {
      test(`"${evento}" ${JSON.stringify(extra)}`, () => {
        const corpoHardcoded = { event: evento, ...extra };
        const corpoDsl = { event: evento, ...extra };
        assert.equal(
          derivarViaDsl(corpoDsl),
          nomeDoEvento(corpoHardcoded)
        );
      });
    }

    function derivarViaDsl(corpo) {
      // aplicarMapeamento monta o evento inteiro; aqui só nos importa event_name.
      return aplicarMapeamento(corpo, mapeamentoCodigoVencedor).evento.event_name;
    }
  });
});

// ============================================================== caminho seguro

describe('obterCaminho/definirCaminho — acesso seguro, sem poluir protótipo', () => {
  test('__proto__/constructor/prototype nunca são atravessados na leitura', () => {
    assert.equal(obterCaminho({}, '__proto__.polluido'), undefined);
    assert.equal(obterCaminho({}, 'a.constructor.prototype.x'), undefined);
  });

  test('tentativa de escrever em __proto__ não polui Object.prototype', () => {
    const alvo = {};
    definirCaminho(alvo, '__proto__.polluido', 'x');
    definirCaminho(alvo, 'a.__proto__.polluido', 'x');
    definirCaminho(alvo, 'constructor.prototype.polluido', 'x');
    assert.equal({}.polluido, undefined);
    assert.equal(Object.prototype.polluido, undefined);
  });

  test('caminho inexistente devolve undefined sem lançar', () => {
    assert.doesNotThrow(() => obterCaminho({ a: { b: 1 } }, 'a.b.c.d.e'));
    assert.equal(obterCaminho({ a: { b: 1 } }, 'a.b.c.d.e'), undefined);
    assert.equal(obterCaminho(null, 'a.b'), undefined);
    assert.equal(obterCaminho(undefined, 'a.b'), undefined);
  });

  test('acessa índice de array por caminho numérico', () => {
    assert.equal(obterCaminho({ itens: [{ nome: 'x' }, { nome: 'y' }] }, 'itens.1.nome'), 'y');
  });

  test('definirCaminho cria os objetos intermediários e nunca escreve undefined', () => {
    const alvo = {};
    definirCaminho(alvo, 'user_data.email', 'a@b.com');
    assert.equal(alvo.user_data.email, 'a@b.com');
    definirCaminho(alvo, 'user_data.phone', undefined);
    assert.equal('phone' in alvo.user_data, false);
  });
});

// ============================================================== lista fechada

describe('lista fechada de transformações', () => {
  test('TRANSFORMACOES não contém eval/função — só nomes de string', () => {
    for (const t of TRANSFORMACOES) assert.equal(typeof t, 'string');
  });

  test('validarMapeamento RECUSA transformação desconhecida (não ignora em silêncio)', () => {
    const mapeamento = {
      evento: { de: 'event', transformar: 'mapear_valores', args: { dicionario: {} } },
      regras: [{ de: 'x', para: 'custom_data.x', transformar: 'executar_codigo_arbitrario' }],
    };
    const { valido, erros } = validarMapeamento(mapeamento);
    assert.equal(valido, false);
    assert.ok(erros.some((e) => e.includes('transformação desconhecida')));
  });

  test('aplicarMapeamento lança (não produz valor silencioso) para transformação fora da lista', () => {
    const mapeamento = {
      evento: { de: 'event', transformar: 'mapear_valores', args: { dicionario: {} } },
      regras: [{ de: 'x', para: 'custom_data.x', transformar: 'executar_codigo_arbitrario' }],
    };
    assert.throws(() => aplicarMapeamento({ x: 1 }, mapeamento), /transformação desconhecida/);
  });
});

// ============================================================== regra dura: purchase

describe('regra dura — nada vira "purchase" sem confirmação explícita de pagamento', () => {
  test('bloco evento por "constante" nunca é aceito', () => {
    const { valido, erros } = validarMapeamento({
      evento: { de: 'event', transformar: 'constante', args: { valor: 'purchase' } },
      regras: [],
    });
    assert.equal(valido, false);
    assert.ok(erros.some((e) => /não é permitida/.test(e)));
  });

  test('bloco evento com transformação diferente de mapear_valores é sempre recusado', () => {
    const { valido } = validarMapeamento({
      evento: { de: 'event', transformar: 'texto' },
      regras: [],
    });
    assert.equal(valido, false);
  });

  test('dicionário condicional "senaoPago: purchase" é recusado (purchase SEM pagamento)', () => {
    const { valido, erros } = validarMapeamento({
      evento: {
        de: 'event', transformar: 'mapear_valores',
        condicaoPagamento: { de: 'status', valoresConfirmados: ['paid'] },
        args: { dicionario: { 'algum.evento': { sePago: 'purchase', senaoPago: 'purchase' } } },
      },
      regras: [],
    });
    assert.equal(valido, false);
    assert.ok(erros.some((e) => /SEM pagamento confirmado/.test(e)));
  });

  test('dicionário condicional "sePago: purchase" sem condicaoPagamento é recusado', () => {
    const { valido, erros } = validarMapeamento({
      evento: {
        de: 'event', transformar: 'mapear_valores',
        args: { dicionario: { 'algum.evento': { sePago: 'purchase', senaoPago: 'pendente' } } },
      },
      regras: [],
    });
    assert.equal(valido, false);
    assert.ok(erros.some((e) => /condicaoPagamento/.test(e)));
  });

  test('entrada literal "purchase" no dicionário é PERMITIDA (curada explicitamente pelo operador)', () => {
    const { valido } = validarMapeamento({
      evento: { de: 'event', transformar: 'mapear_valores', args: { dicionario: { pago_confirmado: 'purchase' } } },
      regras: [],
    });
    assert.equal(valido, true);
  });

  test('sem condicaoPagamento, evento fora do dicionário NUNCA vira purchase em tempo de execução', () => {
    const mapeamento = {
      evento: { de: 'event', transformar: 'mapear_valores', args: { dicionario: {} } },
      regras: [],
    };
    const { evento } = aplicarMapeamento({ event: 'algo_totalmente_desconhecido', paymentStatus: 'paid' }, mapeamento);
    assert.notEqual(evento.event_name, 'purchase');
  });

  test('sugerirMapeamento NUNCA propõe um evento capaz de virar purchase sozinho', () => {
    const { mapeamento } = sugerirMapeamento({ status: 'paid', valor: 100, email: 'a@b.com' });
    assert.equal(mapeamento.evento.condicaoPagamento, undefined);
    assert.deepEqual(mapeamento.evento.args.dicionario, {});
    assert.equal(validarMapeamento(mapeamento).valido, true);
  });
});

// ============================================================== máscara de PII e hash de estrutura

describe('mascararAmostra — PII mascarada por chave e por padrão de valor', () => {
  test('e-mail, telefone e nome são mascarados mesmo aninhados em listas', () => {
    const amostra = mascararAmostra({
      lead: { email: 'pessoa@exemplo.com', phone: '11999998888', nome: 'Maria da Silva' },
      contatos: [{ email: 'outro@exemplo.com' }],
      pedido_id: 'PED-12345',
    });
    assert.notEqual(amostra.lead.email, 'pessoa@exemplo.com');
    assert.notEqual(amostra.lead.phone, '11999998888');
    assert.notEqual(amostra.lead.nome, 'Maria da Silva');
    assert.notEqual(amostra.contatos[0].email, 'outro@exemplo.com');
    // Campo claramente não-PII passa intacto — não é para mascarar tudo.
    assert.equal(amostra.pedido_id, 'PED-12345');
  });

  test('valor com formato de e-mail é mascarado mesmo em chave sem nome sugestivo', () => {
    const amostra = mascararAmostra({ campo_generico: 'contato@dominio.com' });
    assert.notEqual(amostra.campo_generico, 'contato@dominio.com');
  });

  test('campos de segredo (token/senha) são ocultados, não hasheados', () => {
    const amostra = mascararAmostra({ access_token: 'abc123', senha: 'hunter2' });
    assert.equal(amostra.access_token, '[oculto]');
    assert.equal(amostra.senha, '[oculto]');
  });

  test('números e booleanos não são tocados (não carregam PII de texto)', () => {
    const amostra = mascararAmostra({ total: 199.9, pago: true, quantidade: 3 });
    assert.equal(amostra.total, 199.9);
    assert.equal(amostra.pago, true);
    assert.equal(amostra.quantidade, 3);
  });
});

describe('hashEstrutura — hash de FORMATO, não de valor', () => {
  test('dois payloads com a mesma estrutura e valores diferentes têm o MESMO hash', () => {
    const a = hashEstrutura({ lead: { email: 'a@b.com', phone: '111' }, valor: 10 });
    const b = hashEstrutura({ lead: { email: 'z@y.com', phone: '222' }, valor: 999 });
    assert.equal(a, b);
  });

  test('estruturas diferentes (chave a mais) têm hash diferente', () => {
    const a = hashEstrutura({ lead: { email: 'a@b.com' } });
    const b = hashEstrutura({ lead: { email: 'a@b.com', telefone: '111' } });
    assert.notEqual(a, b);
  });
});

describe('headersRelevantes — allowlist estrita', () => {
  test('nunca inclui authorization nem cookie', () => {
    const h = headersRelevantes({
      authorization: 'Bearer segredo', cookie: 'sessao=x', 'content-type': 'application/json',
      'x-webhook-signature': 'abc', 'user-agent': 'algum-cliente/1.0',
    });
    assert.equal('authorization' in h, false);
    assert.equal('cookie' in h, false);
    assert.equal(h['content-type'], 'application/json');
    assert.equal(h['x-webhook-signature'], 'abc');
    assert.equal(h['user-agent'], 'algum-cliente/1.0');
  });
});

// ============================================================== precedência hardcoded > dinâmico

describe('adaptarPayload — precedência hardcoded > dinâmico', () => {
  test('payload reconhecido pelo hardcoded NUNCA é desviado por um adaptador dinâmico', () => {
    const corpo = baseCodigoVencedor();
    const dinamicoQueTambemBateria = {
      id: 999, nome: 'concorrente-fake', ativo: true, modo: 'nativo',
      deteccao: { obrigatorias: ['event', 'eventId'], qualquerUma: [] },
      mapeamento: {
        evento: { de: 'event', transformar: 'mapear_valores', args: { dicionario: {} } },
        regras: [{ para: 'event_name', transformar: 'constante', args: { valor: 'SEQUESTRADO' } }],
      },
    };
    const resultado = adaptarPayload(corpo, { adaptadoresDoProjeto: [dinamicoQueTambemBateria] });
    assert.equal(resultado.formato, 'codigo-vencedor');
    assert.notEqual(resultado.corpo.event_name, 'SEQUESTRADO');
  });

  test('sem adaptadoresDoProjeto, comportamento idêntico ao de antes (I-4)', () => {
    assert.equal(adaptarPayload({ event_name: 'purchase' }).formato, null);
    assert.equal(adaptarPayload(baseCodigoVencedor()).formato, 'codigo-vencedor');
  });

  test('adaptador dinâmico ativo roda quando nenhum hardcoded reconhece', () => {
    const dinamico = {
      id: 1, nome: 'plataforma-x', ativo: true, modo: 'nativo',
      deteccao: { obrigatorias: ['tipo', 'cliente'], qualquerUma: [] },
      mapeamento: {
        evento: { de: 'tipo', transformar: 'mapear_valores', args: { dicionario: { compra: 'purchase' } }, condicaoPagamento: { de: 'status', valoresConfirmados: ['pago'] } },
        regras: [{ de: 'cliente.email', para: 'user_data.email', transformar: 'texto' }],
      },
    };
    const payload = { tipo: 'algo_nao_mapeado', status: 'pago', cliente: { email: 'x@y.com' } };
    const resultado = adaptarPayload(payload, { adaptadoresDoProjeto: [dinamico] });
    assert.equal(resultado.formato, 'dinamico:plataforma-x');
    assert.equal(resultado.corpo.event_name, 'purchase'); // condicaoPagamento bateu
    assert.equal(resultado.corpo.user_data.email, 'x@y.com');
  });

  test('modo sombra NUNCA altera o evento — só sinaliza o que teria batido', () => {
    const dinamico = {
      id: 2, nome: 'em-validacao', ativo: false, modo: 'sombra',
      deteccao: { obrigatorias: ['tipo', 'cliente'], qualquerUma: [] },
      mapeamento: {
        evento: { de: 'tipo', transformar: 'mapear_valores', args: { dicionario: {} } },
        regras: [],
      },
    };
    const payload = { tipo: 'x', cliente: {} };
    const resultado = adaptarPayload(payload, { adaptadoresDoProjeto: [dinamico] });
    assert.equal(resultado.formato, null); // evento não foi alterado
    assert.deepEqual(resultado.corpo, payload); // corpo intacto
    assert.equal(resultado.sombra, 'em-validacao'); // mas foi sinalizado
  });
});

// ============================================================== integração (Postgres real)

let servidor;
let base;
let cookie = '';

const api = (caminho, opcoes = {}) =>
  fetch(`${base}${caminho}`, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...opcoes.headers },
  });

before(async () => {
  await runMigrations();
  await query('TRUNCATE webhook_amostras, adaptadores_projeto, events, deliveries, identities, destinations, project_domains, projects, sessions, user_tokens, users CASCADE');
  await createUser({ email: 'teste-webhook-studio@empresa.com', password: 'senha-de-teste-123', name: 'Teste' });

  servidor = createApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'teste-webhook-studio@empresa.com', password: 'senha-de-teste-123' }),
  });
  cookie = login.headers.getSetCookie().find((c) => c.startsWith('traker_sess=')).split(';')[0];
});

after(async () => {
  await new Promise((r) => servidor.close(r));
  await closePool();
});

describe('captura de amostra — side-effect isolado', () => {
  test('grava a amostra com PII mascarada e hash de estrutura preenchido', async () => {
    const projeto = await createProject({ name: 'Projeto Amostras', domain: 'projeto-amostras.com' });
    const salva = await capturarAmostra({
      projectId: projeto.id,
      corpo: { cliente: { email: 'real@exemplo.com', telefone: '11988887777' }, pedido: 'X1' },
      headers: { 'content-type': 'application/json', authorization: 'Bearer nao-pode-vazar', cookie: 'sessao=segredo' },
    });
    assert.ok(salva);
    assert.notEqual(JSON.stringify(salva.body_mascarado), JSON.stringify({ cliente: { email: 'real@exemplo.com', telefone: '11988887777' }, pedido: 'X1' }));
    assert.equal(salva.body_mascarado.cliente.email.includes('real@exemplo.com'), false);
    assert.equal('authorization' in salva.headers_relevantes, false);
    assert.equal('cookie' in salva.headers_relevantes, false);
    assert.ok(salva.hash_estrutura);
    assert.equal(salva.formato_detectado, null);
  });

  test('falha de captura (projeto inexistente) rejeita a Promise — quem chama PRECISA envolver em try/catch', async () => {
    // Documenta o contrato: capturarAmostra não é "seguro por padrão" sozinha — a
    // segurança do webhook vem de quem a invoca no ponto de ingestão nunca deixar essa
    // rejeição escapar (ver comentário de capturarAmostra e o relato de wiring pendente).
    await assert.rejects(() => capturarAmostra({
      projectId: 'prj_inexistente_xyz',
      corpo: { a: 1 },
      headers: {},
    }));
  });

  test('teto por hash_estrutura: a 6ª amostra do MESMO formato não é gravada', async () => {
    const projeto = await createProject({ name: 'Projeto Teto Hash', domain: 'projeto-teto-hash.com' });
    let gravadas = 0;
    for (let i = 0; i < MAX_AMOSTRAS_POR_HASH + 1; i++) {
      const r = await capturarAmostra({ projectId: projeto.id, corpo: { campo_fixo: `valor-${i}` }, headers: {} });
      if (r) gravadas++;
    }
    assert.equal(gravadas, MAX_AMOSTRAS_POR_HASH);
  });

  test('teto por dia: acima de MAX_AMOSTRAS_POR_DIA (estruturas diferentes), novas capturas não são gravadas', async () => {
    const projeto = await createProject({ name: 'Projeto Teto Dia', domain: 'projeto-teto-dia.com' });
    let gravadas = 0;
    for (let i = 0; i < MAX_AMOSTRAS_POR_DIA + 3; i++) {
      // Estrutura DIFERENTE a cada iteração (número de campos varia) para não esbarrar
      // no teto por hash antes do teto diário.
      const corpo = {};
      for (let k = 0; k <= i; k++) corpo[`campo_${k}`] = i;
      const r = await capturarAmostra({ projectId: projeto.id, corpo, headers: {} });
      if (r) gravadas++;
    }
    assert.equal(gravadas, MAX_AMOSTRAS_POR_DIA);
  });
});

describe('GET /projects/:id/webhooks/amostras — agrupamento e isolamento entre projetos', () => {
  test('agrupa por hash_estrutura e isola por projeto', async () => {
    const projA = await createProject({ name: 'Isolamento Amostras A', domain: 'isolamento-amostras-a.com' });
    const projB = await createProject({ name: 'Isolamento Amostras B', domain: 'isolamento-amostras-b.com' });

    await capturarAmostra({ projectId: projA.id, corpo: { x: 1, y: 2 }, headers: {} });
    await capturarAmostra({ projectId: projA.id, corpo: { x: 9, y: 9 }, headers: {} }); // mesma estrutura -> mesmo grupo
    await capturarAmostra({ projectId: projA.id, corpo: { totalmente: 'diferente', com: 'mais campos', do: 'que a acima' }, headers: {} });
    await capturarAmostra({ projectId: projB.id, corpo: { x: 1, y: 2 }, headers: {} });

    const rA = await (await api(`/api/projects/${projA.id}/webhooks/amostras`)).json();
    const rB = await (await api(`/api/projects/${projB.id}/webhooks/amostras`)).json();

    assert.equal(rA.length, 2, 'projeto A: dois formatos distintos');
    const grupoXY = rA.find((g) => g.quantidade === 2);
    assert.ok(grupoXY, 'as duas amostras {x,y} viram um único grupo');

    assert.equal(rB.length, 1, 'projeto B só vê a própria amostra');
    assert.equal(rB[0].amostra_representativa.body_mascarado.x, 1);
  });
});

describe('DELETE /projects/:id/webhooks/amostras/:amostraId', () => {
  test('descarta a amostra do projeto correto e nunca a de outro projeto', async () => {
    const projA = await createProject({ name: 'Delete Amostra A', domain: 'delete-amostra-a.com' });
    const projB = await createProject({ name: 'Delete Amostra B', domain: 'delete-amostra-b.com' });
    const amostra = await capturarAmostra({ projectId: projA.id, corpo: { z: 1 }, headers: {} });

    const tentativaCruzada = await api(`/api/projects/${projB.id}/webhooks/amostras/${amostra.id}`, { method: 'DELETE' });
    assert.equal(tentativaCruzada.status, 404);

    const ok = await api(`/api/projects/${projA.id}/webhooks/amostras/${amostra.id}`, { method: 'DELETE' });
    assert.equal(ok.status, 200);

    const restante = await (await api(`/api/projects/${projA.id}/webhooks/amostras`)).json();
    assert.equal(restante.length, 0);
  });
});

describe('CRUD /projects/:id/adaptadores', () => {
  test('cria, lista, atualiza e remove um adaptador — só admin escreve', async () => {
    const projeto = await createProject({ name: 'Projeto Adaptadores', domain: 'projeto-adaptadores.com' });

    const criado = await api(`/api/projects/${projeto.id}/adaptadores`, {
      method: 'POST',
      body: JSON.stringify({
        nome: 'plataforma-y',
        deteccao: { obrigatorias: ['tipo', 'cliente'], qualquerUma: [] },
        mapeamento: mapeamentoValido(),
      }),
    });
    assert.equal(criado.status, 201);
    const adaptador = await criado.json();
    assert.equal(adaptador.nome, 'plataforma-y');
    assert.equal(adaptador.ativo, false);

    const listados = await (await api(`/api/projects/${projeto.id}/adaptadores`)).json();
    assert.equal(listados.length, 1);

    const atualizado = await api(`/api/projects/${projeto.id}/adaptadores/${adaptador.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ativo: true }),
    });
    assert.equal(atualizado.status, 200);
    assert.equal((await atualizado.json()).ativo, true);

    const removido = await api(`/api/projects/${projeto.id}/adaptadores/${adaptador.id}`, { method: 'DELETE' });
    assert.equal(removido.status, 200);
    assert.equal((await (await api(`/api/projects/${projeto.id}/adaptadores`)).json()).length, 0);
  });

  test('recusa criar adaptador com mapeamento que produziria purchase sem confirmação', async () => {
    const projeto = await createProject({ name: 'Projeto Adaptador Inválido', domain: 'projeto-adaptador-invalido.com' });
    const r = await api(`/api/projects/${projeto.id}/adaptadores`, {
      method: 'POST',
      body: JSON.stringify({
        nome: 'perigoso',
        deteccao: { obrigatorias: ['a', 'b'], qualquerUma: [] },
        mapeamento: { evento: { de: 'event', transformar: 'constante', args: { valor: 'purchase' } }, regras: [] },
      }),
    });
    assert.equal(r.status, 400);
    const corpo = await r.json();
    assert.ok(corpo.detalhes.some((e) => /não é permitida/.test(e)));
  });

  test('recusa detecção fraca (menos de 2 chaves discriminantes)', async () => {
    const projeto = await createProject({ name: 'Projeto Deteccao Fraca', domain: 'projeto-deteccao-fraca.com' });
    const r = await api(`/api/projects/${projeto.id}/adaptadores`, {
      method: 'POST',
      body: JSON.stringify({
        nome: 'fraco',
        deteccao: { obrigatorias: ['a'], qualquerUma: [] },
        mapeamento: mapeamentoValido(),
      }),
    });
    assert.equal(r.status, 400);
  });

  test('isolamento entre projetos: adaptador de um projeto nunca aparece no outro', async () => {
    const projA = await createProject({ name: 'Isolamento Adaptadores A', domain: 'isolamento-adaptadores-a.com' });
    const projB = await createProject({ name: 'Isolamento Adaptadores B', domain: 'isolamento-adaptadores-b.com' });

    await api(`/api/projects/${projA.id}/adaptadores`, {
      method: 'POST',
      body: JSON.stringify({ nome: 'so-de-a', deteccao: { obrigatorias: ['a', 'b'], qualquerUma: [] }, mapeamento: mapeamentoValido() }),
    });

    const listaB = await (await api(`/api/projects/${projB.id}/adaptadores`)).json();
    assert.equal(listaB.length, 0);
  });
});

describe('POST /projects/:id/adaptadores/preview — nunca persiste nada', () => {
  test('devolve o evento canônico e não cria linha nenhuma no banco', async () => {
    const projeto = await createProject({ name: 'Projeto Preview', domain: 'projeto-preview.com' });

    const antesAdaptadores = (await query('SELECT COUNT(*)::int AS n FROM adaptadores_projeto WHERE project_id = $1', [projeto.id])).rows[0].n;
    const antesAmostras = (await query('SELECT COUNT(*)::int AS n FROM webhook_amostras WHERE project_id = $1', [projeto.id])).rows[0].n;

    const r = await api(`/api/projects/${projeto.id}/adaptadores/preview`, {
      method: 'POST',
      body: JSON.stringify({ mapeamento: mapeamentoCodigoVencedor, amostra: baseCodigoVencedor() }),
    });
    assert.equal(r.status, 200);
    const corpo = await r.json();
    assert.equal(corpo.evento.event_name, 'purchase');
    assert.ok(corpo.diagnostico.camposPreenchidos.length > 0);
    assert.equal(corpo.validacao.valido, true);

    const depoisAdaptadores = (await query('SELECT COUNT(*)::int AS n FROM adaptadores_projeto WHERE project_id = $1', [projeto.id])).rows[0].n;
    const depoisAmostras = (await query('SELECT COUNT(*)::int AS n FROM webhook_amostras WHERE project_id = $1', [projeto.id])).rows[0].n;
    assert.equal(depoisAdaptadores, antesAdaptadores);
    assert.equal(depoisAmostras, antesAmostras);
  });

  test('mapeamento inválido: preview devolve a validação, evento nulo, sem 500', async () => {
    const projeto = await createProject({ name: 'Projeto Preview Invalido', domain: 'projeto-preview-invalido.com' });
    const r = await api(`/api/projects/${projeto.id}/adaptadores/preview`, {
      method: 'POST',
      body: JSON.stringify({ mapeamento: { evento: { de: 'event', transformar: 'constante', args: { valor: 'purchase' } }, regras: [] }, amostra: { event: 'x' } }),
    });
    assert.equal(r.status, 200);
    const corpo = await r.json();
    assert.equal(corpo.validacao.valido, false);
    assert.equal(corpo.evento, null);
  });
});

describe('POST /projects/:id/adaptadores/sugerir — heurística sem IA', () => {
  test('reconhece campos comuns por nome e propõe detecção com discriminantes', async () => {
    const projeto = await createProject({ name: 'Projeto Sugerir', domain: 'projeto-sugerir.com' });
    const r = await api(`/api/projects/${projeto.id}/adaptadores/sugerir`, {
      method: 'POST',
      body: JSON.stringify({ amostra: { email: 'cliente@exemplo.com', telefone: '11999998888', valor: 100, order_id: 'PED-1', status: 'pago' } }),
    });
    assert.equal(r.status, 200);
    const corpo = await r.json();
    const paras = corpo.mapeamento.regras.map((reg) => reg.para);
    assert.ok(paras.includes('user_data.email'));
    assert.ok(paras.includes('custom_data.value'));
    assert.ok(corpo.deteccao.obrigatorias.length + corpo.deteccao.qualquerUma.length >= 2);
    assert.equal(validarMapeamento(corpo.mapeamento).valido, true);
  });

  test('funciona a partir de uma amostra já capturada (amostraId)', async () => {
    const projeto = await createProject({ name: 'Projeto Sugerir AmostraId', domain: 'projeto-sugerir-amostraid.com' });
    const amostra = await capturarAmostra({ projectId: projeto.id, corpo: { email: 'x@y.com' }, headers: {} });

    const r = await api(`/api/projects/${projeto.id}/adaptadores/sugerir`, {
      method: 'POST',
      body: JSON.stringify({ amostraId: amostra.id }),
    });
    assert.equal(r.status, 200);
    const corpo = await r.json();
    assert.ok(corpo.mapeamento.regras.some((reg) => reg.para === 'user_data.email'));
  });
});

describe('cache de adaptadores ativos — invalidação explícita', () => {
  test('invalidarCacheAdaptadores não lança para projeto nunca cacheado', () => {
    assert.doesNotThrow(() => invalidarCacheAdaptadores('projeto-nunca-visto'));
  });
});
