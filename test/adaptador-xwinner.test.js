// Adaptador do formato do backoffice do xWinner.
//
// Os payloads aqui são os EXEMPLOS OFICIAIS do "Catálogo de eventos (24)" da aba
// Integrações → Webhooks de `admin.codigovencedor.com` — copiados literalmente, não
// inventados. Se o backoffice mudar o contrato, é este arquivo que precisa quebrar
// primeiro; um adaptador que só é exercitado por payload escrito por quem escreveu o
// adaptador não prova nada.
//
// Contexto do que estes testes protegem: antes deles, o servidor não reconhecia NENHUM
// dos 24 eventos (a detecção exigia `eventId` camelCase e `lead`/`attribution` no topo,
// e o formato real usa `event_id` com tudo dentro de `data`). Todo webhook do backoffice
// caía como formato desconhecido e a ingestão respondia 400.
import './setup-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { adaptarPayload, nomeDoEvento } from '../src/ingest/adaptadores.js';
import { normalizeEvent, redactForStorage } from '../src/ingest/normalize.js';
import { buildUserData } from '../src/destinations/meta.js';
import { hashEmail, hashName, hashCityState, hashPhone, hashZip, hashCountry, hashDataNascimento } from '../src/config/crypto.js';

// Reduz ruído: só o `data` muda entre um exemplo e outro.
const envelope = (event, data, extra = {}) => ({
  event,
  event_id: `evt_${event}_0001`,
  version: '1.0',
  created_at: '2026-08-16T03:21:49+00:00',
  data,
  ...extra,
});

const ATRIBUICAO = {
  utm: { source: 'facebook', medium: 'cpc', campaign: 'black-friday', term: 'aposta-esportiva', content: 'anuncio-a' },
  cookies: {
    fbp: 'fb.1.1699999999999.1234567890',
    fbc: 'fb.1.1699999999999.IwAR0abc',
    gclid: 'Cj0KCQjw...',
    ga: '1699999999.1699999999',
  },
  referrer: 'https://google.com/',
  landing_page: 'https://exemplo.com/lp/aposta-inteligente',
  ip: '187.10.20.30',
  user_agent: 'Mozilla/5.0 (iPhone; ...)',
};

const LEAD = { email: 'lead@example.com', name: 'Lead Convidado', phone: '11988887777', birth_date: '1990-05-15' };
const PRODUTO = { id: '6', slug: 'codigo-vencedor', name: 'Acesso Código Vencedor' };

const compraAprovada = () => envelope('purchase_approved', {
  purchase_id: '9',
  order_id: '5',
  product: PRODUTO,
  amount: 1990,
  currency: 'BRL',
  payment_method: 'pix',
  original_amount: 2490,
  discount: 500,
  coupon_code: 'BEMVINDO10',
  buyer: { external_id: '14' },
  approved_at: '2026-07-01T20:12:00Z',
  credit_pack: { id: '3', credits: 500 },
  lead: LEAD,
  attribution: ATRIBUICAO,
});

describe('adaptador xwinner — detecção', () => {
  test('reconhece o envelope do backoffice', () => {
    const { formato } = adaptarPayload(compraAprovada());
    assert.equal(formato, 'xwinner');
  });

  test('reconhece os eventos SEM lead nem attribution', () => {
    // Oito dos dezoito eventos que disparam não trazem nenhum dos dois. Se a detecção
    // exigisse qualquer um deles — como faz o adaptador irmão `codigo-vencedor` —,
    // assinatura, estorno, chargeback, e-book e ferramenta ficariam de fora.
    const semAtribuicao = [
      envelope('purchase_refunded', { purchase_id: '9', order_id: '5', buyer: { external_id: '14' }, status: 'refunded', occurred_at: '2026-07-01T20:20:00Z' }),
      envelope('chargeback_opened', { purchase_id: '9', order_id: '5', buyer: { external_id: '14' }, status: 'chargeback', occurred_at: '2026-07-01T20:20:00Z' }),
      envelope('subscription_started', { subscription_id: '5', user: { external_id: '14', email: 'maria@example.com' }, plan: { id: '1' }, product: { id: '6' }, status: 'active', current_period_end: '2026-08-01T00:00:00Z', started_at: '2026-07-01T20:00:00Z' }),
      envelope('ebook_completed', { user: { external_id: '14', email: 'maria@example.com' }, product: { id: '6', slug: 'codigo-vencedor' }, chapters_completed: 24 }),
      envelope('tool_used', { user: { external_id: '14', email: 'maria@example.com' }, product: { id: '6', slug: 'codigo-vencedor' }, tool: 'martingale' }),
    ];
    for (const p of semAtribuicao) {
      assert.equal(adaptarPayload(p).formato, 'xwinner', `${p.event} deveria ser reconhecido`);
    }
  });

  test('não rouba o payload canônico nem o formato camelCase da Checkout Platform', () => {
    // Um payload já canônico não tem `data`; o da Checkout Platform usa `eventId`.
    const canonico = { event_name: 'purchase', event_id: 'x', user_data: { email: 'a@b.com' } };
    assert.equal(adaptarPayload(canonico).formato, null);

    const checkoutPlatform = {
      event: 'checkout.session.completed', eventId: 'cs_1', paymentStatus: 'paid',
      occurredAt: '2026-07-01T20:12:00Z', amountMinor: 9700, currency: 'BRL',
      lead: { email: 'a@b.com' }, attribution: { utm: {} },
    };
    assert.equal(adaptarPayload(checkoutPlatform).formato, 'codigo-vencedor');
  });

  test('`data` que não é objeto não conta como envelope', () => {
    assert.equal(adaptarPayload({ event: 'x', event_id: '1', data: [] }).formato, null);
    assert.equal(adaptarPayload({ event: 'x', event_id: '1', data: 'texto' }).formato, null);
    assert.equal(adaptarPayload({ event: 'x', event_id: '1' }).formato, null);
  });
});

describe('adaptador xwinner — extração de campos', () => {
  test('compra aprovada, campo a campo', () => {
    const { corpo } = adaptarPayload(compraAprovada());

    assert.equal(corpo.event_name, 'purchase');
    assert.equal(corpo.event_id, 'evt_purchase_approved_0001');
    // approved_at, não created_at do envelope.
    assert.equal(corpo.event_time, Math.floor(Date.parse('2026-07-01T20:12:00Z') / 1000));
    assert.equal(corpo.action_source, 'website');
    assert.equal(corpo.event_source_url, 'https://exemplo.com/lp/aposta-inteligente');
    assert.equal(corpo.referrer, 'https://google.com/');

    // Ponte de identidade: external_id do comprador, decisão do cliente.
    assert.equal(corpo.user_id, '14');
    assert.equal(corpo.user_data.external_id, '14');

    assert.equal(corpo.user_data.email, 'lead@example.com');
    assert.equal(corpo.user_data.phone, '11988887777');
    assert.equal(corpo.user_data.first_name, 'Lead');
    assert.equal(corpo.user_data.last_name, 'Convidado');
    assert.equal(corpo.user_data.birth_date, '1990-05-15');

    assert.equal(corpo.user_data.fbp, 'fb.1.1699999999999.1234567890');
    assert.equal(corpo.user_data.fbc, 'fb.1.1699999999999.IwAR0abc');
    assert.equal(corpo.user_data.gclid, 'Cj0KCQjw...');
    assert.equal(corpo.user_data.utm_source, 'facebook');
    assert.equal(corpo.user_data.utm_term, 'aposta-esportiva');
    assert.equal(corpo.user_data.client_user_agent, 'Mozilla/5.0 (iPhone; ...)');
    assert.equal(corpo.user_data.client_ip_address, '187.10.20.30');

    assert.equal(corpo.custom_data.value, 19.9);
    assert.equal(corpo.custom_data.currency, 'BRL');
    assert.equal(corpo.custom_data.order_id, '5');
    assert.deepEqual(corpo.custom_data.content_ids, ['6']);
    assert.equal(corpo.custom_data.content_name, 'Acesso Código Vencedor');
    assert.equal(corpo.custom_data.payment_method, 'pix');
    assert.equal(corpo.custom_data.coupon, 'BEMVINDO10');
    assert.equal(corpo.custom_data.valor_original, 24.9);
    assert.equal(corpo.custom_data.desconto, 5);
    assert.equal(corpo.custom_data.pacote_creditos, 500);
  });

  test('`amount` é centavos — errar é 100x', () => {
    const { corpo } = adaptarPayload(compraAprovada());
    // Confirmado com o cliente e coerente com a própria aritmética do catálogo:
    // original_amount 2490 − discount 500 = amount 1990.
    assert.equal(corpo.custom_data.value, 19.9);
    assert.notEqual(corpo.custom_data.value, 1990);
  });

  test('`_gcl_au` NUNCA vira gclid', () => {
    // `_gcl_au` é o cookie de mensuração do Google (1.1.<aleatório>.<timestamp>) e não
    // contém gclid. Enviá-lo como identificador de clique faz o Google aceitar a
    // conversão e não casar com clique nenhum — falha cara porque é silenciosa.
    const p = envelope('user_registered', {
      user: { external_id: '14', email: 'maria@example.com' },
      method: 'password',
      registered_at: '2026-07-01T20:00:00Z',
      attribution: { utm: { source: 'facebook' }, cookies: { gcl_au: '1.1.1234567890.1699999999' } },
    });
    const { corpo } = adaptarPayload(p);
    assert.equal(corpo.user_data.gclid, undefined);
  });

  test('IP de rede privada é descartado', () => {
    const p = compraAprovada();
    p.data.attribution = { ...ATRIBUICAO, ip: '10.244.16.187' };
    const { corpo } = adaptarPayload(p);
    assert.equal(corpo.user_data.client_ip_address, undefined);
  });

  test('`status` do pedido não invade o campo padrão `status` da Meta', () => {
    // `status` é parâmetro padrão da Meta (usado em Lead). Mandar "refunded" ali
    // significaria outra coisa para a plataforma.
    const p = envelope('purchase_refunded', {
      purchase_id: '9', order_id: '5', buyer: { external_id: '14' },
      status: 'refunded', occurred_at: '2026-07-01T20:20:00Z',
    });
    const { corpo } = adaptarPayload(p);
    assert.equal(corpo.custom_data.status, undefined);
    assert.equal(corpo.custom_data.situacao, 'refunded');
  });

  test('evento sem carimbo próprio cai no created_at do envelope', () => {
    // subscription_cancelled é o único evento do catálogo sem timestamp em `data`.
    const p = envelope('subscription_cancelled', {
      subscription_id: '5', user: { external_id: '14' }, plan: { id: '1' },
      product: { id: '6' }, status: 'cancelled', current_period_end: '2026-08-01T00:00:00Z',
      cancel_at_period_end: true,
    });
    const { corpo } = adaptarPayload(p);
    assert.equal(corpo.event_time, Math.floor(Date.parse('2026-08-16T03:21:49+00:00') / 1000));
  });

  test('identifica por `user` quando não há `buyer`', () => {
    const p = envelope('tool_used', {
      user: { external_id: '14', email: 'maria@example.com' },
      product: { id: '6', slug: 'codigo-vencedor' },
      tool: 'martingale',
    });
    const { corpo } = adaptarPayload(p);
    assert.equal(corpo.user_id, '14');
    assert.equal(corpo.user_data.email, 'maria@example.com');
    assert.equal(corpo.custom_data.ferramenta, 'martingale');
  });

  test('pré-checkout usa product_ids e precheckout_id', () => {
    const p = envelope('precheckout_opened', {
      precheckout_id: 'pchk_abc123',
      payment_link_id: 'plink_xyz789',
      product: PRODUTO,
      product_ids: ['prod_cp_1'],
      amount: 9700,
      currency: 'BRL',
      lead: { name: 'Lead Convidado', email: 'lead@example.com', phone: '11988887777', phone_country_code: '55' },
      last_activity_at: '2026-07-24T14:05:00Z',
      occurred_at: '2026-07-24T14:20:00Z',
      attribution: ATRIBUICAO,
    });
    const { corpo } = adaptarPayload(p);
    assert.equal(corpo.event_name, 'lead');
    assert.deepEqual(corpo.custom_data.content_ids, ['prod_cp_1']);
    assert.equal(corpo.custom_data.order_id, 'pchk_abc123');
    assert.equal(corpo.custom_data.value, 97);
    // occurred_at vence last_activity_at: um é o instante do fato, o outro é a última
    // interação do lead.
    assert.equal(corpo.event_time, Math.floor(Date.parse('2026-07-24T14:20:00Z') / 1000));
  });
});

describe('adaptador xwinner — classificação de eventos', () => {
  test('os 18 eventos que disparam têm nome canônico próprio', () => {
    const esperado = {
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
    };
    for (const [origem, canonico] of Object.entries(esperado)) {
      assert.equal(nomeDoEvento({ event: origem }), canonico, origem);
    }
  });

  test('pré-checkout expirado e lead abandonado são eventos DIFERENTES', () => {
    // Pré-checkout e checkout são etapas distintas do funil, e os dois abandonos também.
    // Colapsá-los no mesmo nome canônico contaria um abandono duas vezes, e a
    // idempotência por event_id não pegaria — são eventos distintos na origem.
    assert.notEqual(nomeDoEvento({ event: 'precheckout_expired' }), nomeDoEvento({ event: 'checkout_lead_abandoned' }));
    assert.notEqual(nomeDoEvento({ event: 'precheckout_expired' }), nomeDoEvento({ event: 'checkout_abandoned' }));
  });

  test('nada vira purchase sem confirmação de pagamento', () => {
    // O envelope do backoffice não tem `paymentStatus`; `data.status` vale "active" numa
    // assinatura e "refunded" num estorno. Se o fallback antigo por status tivesse sido
    // portado, assinatura iniciada viraria compra.
    for (const evento of ['payment_generated', 'checkout_card_attempted', 'checkout_session_opened', 'subscription_started', 'purchase_refunded']) {
      assert.notEqual(nomeDoEvento({ event: evento }), 'purchase', evento);
    }
    assert.equal(nomeDoEvento({ event: 'purchase_approved' }), 'purchase');
  });

  test('evento fora do catálogo não é descartado em silêncio', () => {
    const { corpo, formato } = adaptarPayload(envelope('promo.spin.completed', { user: { external_id: '14' } }));
    assert.equal(formato, 'xwinner');
    assert.equal(corpo.event_name, 'promo_spin_completed');
  });
});

describe('adaptador xwinner — caminho completo até a Meta', () => {
  test('a data de nascimento atravessa a normalização e vira `db` hasheado', () => {
    const { corpo } = adaptarPayload(compraAprovada());
    const evento = normalizeEvent(corpo, { source: 'webhook' });
    assert.equal(evento.user_data.birth_date, '1990-05-15');

    const ud = buildUserData(evento.user_data, evento.event_time);
    assert.equal(ud.db?.[0], hashDataNascimento('1990-05-15'));
  });

  test('a data de nascimento não fica em claro no banco', () => {
    const { corpo } = adaptarPayload(compraAprovada());
    const evento = normalizeEvent(corpo, { source: 'webhook' });
    const guardado = redactForStorage(evento, { hashEmail, hashName, hashCityState, hashPhone, hashZip, hashCountry, hashDataNascimento });
    assert.equal(guardado.user_data.birth_date, hashDataNascimento('1990-05-15'));
    assert.notEqual(guardado.user_data.birth_date, '1990-05-15');
  });

  test('a normalização preserva IP e User-Agent do comprador, não os da requisição', () => {
    const { corpo } = adaptarPayload(compraAprovada());
    const evento = normalizeEvent(corpo, {
      source: 'webhook',
      clientIp: '203.0.113.9',            // seria o IP do n8n
      userAgent: 'node-fetch/1.0',        // seria o UA da biblioteca HTTP
    });
    assert.equal(evento.user_data.client_ip_address, '187.10.20.30');
    assert.equal(evento.user_data.client_user_agent, 'Mozilla/5.0 (iPhone; ...)');
  });

  test('o event_id do envelope vira a chave de idempotência', () => {
    const { corpo } = adaptarPayload(compraAprovada());
    const evento = normalizeEvent(corpo, { source: 'webhook' });
    assert.equal(evento.event_id, 'evt_purchase_approved_0001');
  });
});
