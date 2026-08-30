// Testes unitários: regras que, quando erradas, quebram o match SILENCIOSAMENTE
// (a Meta aceita o evento e devolve 200, mas a correspondência não acontece).
// Não precisam de banco.
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { hashPII, hashPhone, hashZip, hashCountry, hashDataNascimento, encrypt, decrypt, randomSlug } from '../src/config/crypto.js';
import { buildUserData, deriveFbc, fbclidDeFbc, buildMetaPayload, validarEventoMeta } from '../src/destinations/meta.js';
import { DEFAULT_META_MAP } from '../src/db/repos/projects.js';
import { normalizeEvent, deriveEventId, extractClientIp, fbclidDaUrl } from '../src/ingest/normalize.js';
import { applyConsent } from '../src/ingest/consent.js';
import { registrableDomain, parseCookies } from '../src/ingest/cookies.js';
import { buildConversion, formatConversionDateTime, uploadClickConversion } from '../src/destinations/google-ads.js';
import { adaptarPayload, nomeDoEvento, ipPublico, separarNome } from '../src/ingest/adaptadores.js';
import { parsePgConnectionString } from '../src/db/pool.js';

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

describe('normalização e hash de PII', () => {
  test('normaliza (trim + lowercase) ANTES de hashear', () => {
    assert.equal(hashPII('  Cliente@Exemplo.COM '), sha256('cliente@exemplo.com'));
  });

  test('não hasheia de novo um valor que já chegou hasheado', () => {
    const jaHasheado = sha256('cliente@exemplo.com');
    assert.equal(hashPII(jaHasheado), jaHasheado);
  });

  test('telefone: remove formatação e acrescenta DDI brasileiro quando falta', () => {
    // (11) 98765-4321 -> 5511987654321
    assert.equal(hashPhone('(11) 98765-4321'), sha256('5511987654321'));
    // já com DDI, não duplica
    assert.equal(hashPhone('+55 11 98765-4321'), sha256('5511987654321'));
  });

  test('CEP e país seguem as regras da Meta', () => {
    assert.equal(hashZip('01310-100'), sha256('01310100'));
    assert.equal(hashCountry('Brasil'), sha256('br'));
    assert.equal(hashCountry('BR'), sha256('br'));
  });

  test('valores vazios não viram hash de string vazia', () => {
    for (const vazio of [undefined, null, '', '   ']) {
      assert.equal(hashPII(vazio), undefined);
      assert.equal(hashPhone(vazio), undefined);
    }
  });
});

describe('user_data da Meta', () => {
  const base = {
    email: 'Cliente@Exemplo.com',
    phone: '(11) 98765-4321',
    fbp: 'fb.1.1700000000000.1234567890',
    fbc: 'fb.1.1700000000000.AbCdEfGh',
    external_id: 'user-8842',
    client_ip_address: '187.1.2.3',
    client_user_agent: 'Mozilla/5.0',
  };

  test('fbp e fbc NUNCA são hasheados — erro clássico que zera o match', () => {
    const ud = buildUserData(base, 1700000000);
    assert.equal(ud.fbp, base.fbp);
    assert.equal(ud.fbc, base.fbc);
    assert.doesNotMatch(ud.fbp, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(ud.fbc, /^[a-f0-9]{64}$/);
  });

  test('IP e User-Agent vão em texto plano', () => {
    const ud = buildUserData(base, 1700000000);
    assert.equal(ud.client_ip_address, '187.1.2.3');
    assert.equal(ud.client_user_agent, 'Mozilla/5.0');
  });

  test('PII vai hasheada e dentro de array', () => {
    const ud = buildUserData(base, 1700000000);
    assert.deepEqual(ud.em, [sha256('cliente@exemplo.com')]);
    assert.deepEqual(ud.ph, [sha256('5511987654321')]);
    assert.deepEqual(ud.external_id, [sha256('user-8842')]);
  });

  test('deriva o fbc a partir do fbclid no formato oficial fb.1.<ts>.<fbclid>', () => {
    const fbc = deriveFbc({ fbclid: 'IwAR123' }, 1700000000);
    assert.equal(fbc, 'fb.1.1700000000000.IwAR123');
  });

  test('preserva o fbc do navegador quando ele já carrega o fbclid deste clique', () => {
    // O carimbo de tempo do cookie é o do clique de verdade — melhor que o do evento.
    const fbc = 'fb.1.999.IwAR123';
    assert.equal(deriveFbc({ fbc, fbclid: 'IwAR123' }, 1700000000), fbc);
  });

  test('sem fbclid para comparar, o fbc que veio do navegador é mantido intacto', () => {
    assert.equal(deriveFbc({ fbc: 'fb.1.999.original' }, 1700000000), 'fb.1.999.original');
  });

  // ESTE é o bug que a Meta acusou como "o servidor está enviando um valor fbclid
  // modificado no parâmetro fbc": na página de entrada de um clique NOVO, o cookie _fbc
  // do navegador ainda é o do clique ANTERIOR (a tag roda antes do Pixel, e quem
  // reescreve o cookie é o Pixel). Preferir o cookie cegamente mandava o fbclid velho
  // junto com a event_source_url do clique novo — divergência que a Meta detecta.
  test('refaz o fbc quando ele carrega o fbclid de OUTRO clique', () => {
    const fbc = deriveFbc({ fbc: 'fb.1.999.CLIQUE_ANTIGO', fbclid: 'CLIQUE_NOVO' }, 1700000000);
    assert.equal(fbc, 'fb.1.1700000000000.CLIQUE_NOVO');
  });

  test('fbc malformado (sem as quatro partes) não impede a reconstrução pelo fbclid', () => {
    assert.equal(deriveFbc({ fbc: 'lixo', fbclid: 'IwAR123' }, 1700000000), 'fb.1.1700000000000.IwAR123');
  });

  test('fbclidDeFbc extrai o fbclid do cookie e não inventa nada fora do formato', () => {
    assert.equal(fbclidDeFbc('fb.1.1700000000000.IwAR-abc_DEF'), 'IwAR-abc_DEF');
    assert.equal(fbclidDeFbc('fb.1.1700000000000.'), '');
    assert.equal(fbclidDeFbc('qualquer-coisa'), '');
    assert.equal(fbclidDeFbc(''), '');
    assert.equal(fbclidDeFbc(undefined), '');
  });

  test('campos ausentes não viram chave vazia no payload', () => {
    const ud = buildUserData({ email: 'a@b.com' }, 1700000000);
    assert.ok(!('ph' in ud));
    assert.ok(!('fbp' in ud));
  });
});

// Alerta de ALTA PRIORIDADE do Gerenciador de Eventos: "o servidor está enviando um valor
// fbclid modificado no parâmetro fbc (como um valor que foi convertido para letras
// minúsculas ou truncado)". O fbclid é base64url e SENSÍVEL A MAIÚSCULAS: qualquer
// normalização de PII aplicada a ele (trim, lowercase, corte) quebra a atribuição em
// silêncio, e a Meta ainda devolve 200. Estes testes existem para que nenhum refactor
// futuro volte a tratar identificador de clique como se fosse texto de formulário.
describe('fbclid: integridade byte a byte dentro do fbc', () => {
  // fbclid real moderno: prefixo IwZXh, 250+ caracteres, maiúsculas, minúsculas,
  // sublinhado e hífen. É o formato que quebrava quando alguém truncava em 200 ou
  // baixava a caixa.
  const FBCLID = 'IwZXh0bgNhZW0BMABhZGlkAasdF-_QWERTYuiop1234567890AbCdEfGhIjKlMnOpQrStUvWxYz'
    + '_-1234567890AbCdEfGhIjKlMnOpQrStUvWxYzABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop'
    + 'qrstuvwxyz0123456789_-QWERTYuiopASDFGHJKLzxcvbnm-_0987654321IwAR'
    + '_aem_AbCdEfGhIjKlMnOpQrStUvWxYz-0123456789ZyXwVuTsRqPoNmLkJiHgFeDcBa_-';
  const URL_DO_CLIQUE = `https://loja.com/oferta?utm_source=facebook&fbclid=${FBCLID}&utm_medium=cpc`;
  const projeto = { destinations: { meta: { config: {} } } };
  // Dentro da janela de 7 dias da Meta: normalizeEvent troca por "agora" qualquer
  // event_time mais velho que isso, e o carimbo do fbc derivado sai do event_time.
  const AGORA = Math.floor(Date.now() / 1000) - 60;

  const fbclidDoPayloadMeta = (evento) => {
    const fbc = buildMetaPayload(evento, projeto, { config: { eventMap: DEFAULT_META_MAP } }).data[0].user_data.fbc;
    return fbc ? fbc.split('.').slice(3).join('.') : undefined;
  };

  test('o fbclid de teste é mesmo longo e de caixa mista (senão o teste não prova nada)', () => {
    assert.ok(FBCLID.length > 250, 'precisa passar de 250 caracteres');
    assert.notEqual(FBCLID, FBCLID.toLowerCase(), 'precisa ter maiúsculas');
    assert.ok(FBCLID.includes('_') && FBCLID.includes('-'), 'precisa ter _ e -');
  });

  test('fbclidDaUrl extrai o valor cru da query string, sem tocar em nada', () => {
    assert.equal(fbclidDaUrl(URL_DO_CLIQUE), FBCLID);
    assert.equal(fbclidDaUrl(`https://loja.com/?fbclid=${FBCLID}#secao`), FBCLID);
    assert.equal(fbclidDaUrl(`https://loja.com/?fbclid=${FBCLID}`), FBCLID);
  });

  test('fbclidDaUrl ignora URL sem fbclid e valor fora do alfabeto base64url', () => {
    assert.equal(fbclidDaUrl('https://loja.com/oferta'), undefined);
    assert.equal(fbclidDaUrl('https://loja.com/?utm_source=fb'), undefined);
    assert.equal(fbclidDaUrl(''), undefined);
    assert.equal(fbclidDaUrl(undefined), undefined);
    // Percent-encoding aqui significa valor adulterado no caminho: melhor não ter fbclid
    // do que decodificar e mandar bytes diferentes dos que a Meta emitiu.
    assert.equal(fbclidDaUrl('https://loja.com/?fbclid=abc%3Ddef'), undefined);
  });

  test('normalizeEvent devolve o fbclid da URL byte a byte', () => {
    const e = normalizeEvent({ event_name: 'page_view', page_location: URL_DO_CLIQUE });
    assert.equal(e.user_data.fbclid, FBCLID);
    assert.equal(e.user_data.fbclid.length, FBCLID.length, 'nada de truncar');
    assert.notEqual(e.user_data.fbclid, FBCLID.toLowerCase(), 'nada de baixar a caixa');
  });

  test('o fbclid da URL vence o sticky do localStorage (é o clique DESTA visita)', () => {
    const e = normalizeEvent({
      event_name: 'page_view',
      page_location: URL_DO_CLIQUE,
      user_data: { fbclid: 'CLIQUE_ANTIGO_DO_LOCALSTORAGE' },
    });
    assert.equal(e.user_data.fbclid, FBCLID);
  });

  test('sem fbclid na URL, o que a tag capturou continua valendo', () => {
    const e = normalizeEvent({
      event_name: 'page_view',
      page_location: 'https://loja.com/carrinho',
      user_data: { fbclid: FBCLID },
    });
    assert.equal(e.user_data.fbclid, FBCLID);
  });

  test('page_view sem cookie _fbc: o fbc derivado leva o fbclid INTACTO até a Meta', () => {
    const e = normalizeEvent({ event_name: 'page_view', event_time: AGORA, page_location: URL_DO_CLIQUE });
    assert.equal(fbclidDoPayloadMeta(e), FBCLID);
  });

  test('page_view com cookie _fbc do mesmo clique: fbc preservado, fbclid intacto', () => {
    const e = normalizeEvent(
      { event_name: 'page_view', event_time: AGORA, page_location: URL_DO_CLIQUE },
      { cookies: { _fbc: `fb.1.1699999999999.${FBCLID}` } }
    );
    const payload = buildMetaPayload(e, projeto, { config: { eventMap: DEFAULT_META_MAP } });
    assert.equal(payload.data[0].user_data.fbc, `fb.1.1699999999999.${FBCLID}`);
  });

  // O caso de produção: clique NOVO na URL, cookie _fbc ainda do clique anterior porque
  // a tag roda antes do Pixel. Sem a correção, o fbc saía com o fbclid velho ao lado de
  // uma event_source_url com o novo — e era isso que a Meta acusava.
  test('cookie _fbc de um clique ANTERIOR não contamina o fbc do clique atual', () => {
    const e = normalizeEvent(
      { event_name: 'page_view', event_time: AGORA, page_location: URL_DO_CLIQUE },
      { cookies: { _fbc: 'fb.1.1600000000000.FbclidDeUmCliqueBemMaisAntigo' } }
    );
    const payload = buildMetaPayload(e, projeto, { config: { eventMap: DEFAULT_META_MAP } });
    assert.equal(payload.data[0].user_data.fbc, `fb.1.${AGORA * 1000}.${FBCLID}`);
    assert.equal(fbclidDoPayloadMeta(e), fbclidDaUrl(payload.data[0].event_source_url),
      'o fbclid do fbc precisa bater com o da event_source_url — é a comparação que a Meta faz');
  });

  test('a ponte de identidade também entrega o fbclid intacto', () => {
    const e = normalizeEvent({ event_name: 'purchase', event_time: AGORA, custom_data: { value: 1, currency: 'BRL' } });
    e.user_data.fbclid = FBCLID; // é o que mergeIdentityIntoUserData faz ao preencher a lacuna
    assert.equal(fbclidDoPayloadMeta(e), FBCLID);
  });

  test('o fbc nunca sai hasheado, por mais longo que o fbclid seja', () => {
    const e = normalizeEvent({ event_name: 'page_view', event_time: AGORA, page_location: URL_DO_CLIQUE });
    const fbc = buildMetaPayload(e, projeto, { config: { eventMap: DEFAULT_META_MAP } }).data[0].user_data.fbc;
    assert.doesNotMatch(fbc, /^[a-f0-9]{64}$/);
    assert.ok(fbc.startsWith('fb.1.'));
  });
});

describe('payload completo da Meta', () => {
  const projeto = { destinations: { meta: { config: {} } } };
  const evento = {
    event_id: 'evt-1',
    event_name: 'purchase',
    event_time: 1700000000,
    action_source: 'website',
    event_source_url: 'https://loja.com/obrigado',
    user_data: { email: 'a@b.com', fbp: 'fb.1.1.1' },
    custom_data: { value: '199.90', currency: 'BRL', campo_solto: 'ignorar' },
    consent_state: {},
  };

  test('traduz o nome do evento pelo mapeamento configurado', () => {
    const payload = buildMetaPayload(evento, projeto, { config: { eventMap: { purchase: 'Purchase' } } });
    assert.equal(payload.data[0].event_name, 'Purchase');
  });

  test('sem mapeamento, mantém o nome original (não inventa tradução)', () => {
    const payload = buildMetaPayload(evento, projeto, { config: {} });
    assert.equal(payload.data[0].event_name, 'purchase');
  });

  test('preserva o event_id — é a chave de deduplicação com o pixel do navegador', () => {
    const payload = buildMetaPayload(evento, projeto, { config: {} });
    assert.equal(payload.data[0].event_id, 'evt-1');
  });

  test('value vira número e campos extras seguem para conversões personalizadas', () => {
    // Campos fora do padrão da Meta (forma de pagamento, cupom) são repassados: é o
    // que permite criar uma conversão personalizada só de quem pagou por PIX.
    const cd = buildMetaPayload(evento, projeto, { config: {} }).data[0].custom_data;
    assert.equal(cd.value, 199.9);
    assert.equal(cd.currency, 'BRL');
    assert.equal(cd.campo_solto, 'ignorar');
  });

  test('campo aninhado não é repassado — derrubaria o evento inteiro na API', () => {
    const comObjeto = { ...evento, custom_data: { value: 10, metadados: { a: 1 }, lista: [{ b: 2 }] } };
    const cd = buildMetaPayload(comObjeto, projeto, { config: {} }).data[0].custom_data;
    assert.ok(!('metadados' in cd));
    assert.ok(!('lista' in cd));
    assert.equal(cd.value, 10);
  });

  test('test_event_code fica fora do objeto de evento', () => {
    const payload = buildMetaPayload(evento, projeto, { config: { testEventCode: 'TEST123' } });
    assert.equal(payload.test_event_code, 'TEST123');
    assert.ok(!('test_event_code' in payload.data[0]));
  });
});

describe('Consent Mode v2', () => {
  const evento = () => ({
    event_name: 'purchase',
    user_data: { email: 'a@b.com', phone: '11999999999', fbp: 'fb.1.1.1', external_id: 'u1' },
    consent_state: {},
  });

  test('ad_user_data negado remove a PII, mas preserva fbp', () => {
    const e = evento();
    e.consent_state.ad_user_data = 'denied';
    const out = applyConsent(e);
    assert.equal(out.user_data.email, undefined);
    assert.equal(out.user_data.phone, undefined);
    assert.equal(out.user_data.external_id, undefined);
    assert.equal(out.user_data.fbp, 'fb.1.1.1');
  });

  test('ad_personalization negado mantém o evento e sinaliza LDU', () => {
    const e = evento();
    e.consent_state.ad_personalization = 'denied';
    const projeto = { destinations: { meta: { config: {} } } };
    const serverEvent = buildMetaPayload({ ...e, event_time: 1, event_id: 'x', custom_data: {} }, projeto, { config: {} }).data[0];
    assert.deepEqual(serverEvent.data_processing_options, ['LDU']);
    assert.equal(serverEvent.data_processing_options_country, 0);
  });

  test('consentimento concedido não altera nada', () => {
    const e = evento();
    e.consent_state.ad_user_data = 'granted';
    assert.equal(applyConsent(e).user_data.email, 'a@b.com');
  });

  test('modo estrito remove PII quando o consentimento não veio', () => {
    const out = applyConsent(evento(), { strictConsent: true });
    assert.equal(out.user_data.email, undefined);
    assert.equal(out._consentFlags.consentMissing, true);
  });

  test('não muta o evento original', () => {
    const e = evento();
    e.consent_state.ad_user_data = 'denied';
    applyConsent(e);
    assert.equal(e.user_data.email, 'a@b.com');
  });
});

describe('event_id e deduplicação', () => {
  test('usa o event_id enviado pelo cliente quando existe', () => {
    assert.equal(deriveEventId({ event_id: 'do-navegador' }, 'purchase'), 'do-navegador');
  });

  test('deriva id determinístico do order_id — navegador e webhook geram o MESMO id', () => {
    const doNavegador = deriveEventId({ custom_data: { order_id: '8812' } }, 'purchase');
    const doWebhook = deriveEventId({ order_id: '8812' }, 'purchase');
    assert.equal(doNavegador, 'purchase-8812');
    assert.equal(doWebhook, 'purchase-8812');
  });

  test('sem id de negócio, gera UUID distinto a cada chamada', () => {
    assert.notEqual(deriveEventId({}, 'page_view'), deriveEventId({}, 'page_view'));
  });
});

describe('normalização do evento', () => {
  test('IP e User-Agent vêm do servidor, nunca do que o cliente mandou', () => {
    const e = normalizeEvent(
      { user_data: { client_ip_address: '1.2.3.4', client_user_agent: 'forjado' } },
      { clientIp: '187.9.9.9', userAgent: 'real' }
    );
    assert.equal(e.user_data.client_ip_address, '187.9.9.9');
    assert.equal(e.user_data.client_user_agent, 'real');
  });

  test('event_time fora da janela de 7 dias da Meta cai para a hora do servidor', () => {
    const antigo = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    const e = normalizeEvent({ event_time: antigo });
    assert.ok(e.event_time > antigo);
  });

  test('event_time no futuro é descartado', () => {
    const futuro = Math.floor(Date.now() / 1000) + 86400;
    assert.ok(normalizeEvent({ event_time: futuro }).event_time < futuro);
  });

  test('cookie da requisição serve de fallback quando o JS não conseguiu ler', () => {
    const e = normalizeEvent({}, { cookies: { _fbp: 'fb.1.1.1', _fbc: 'fb.1.2.abc' } });
    assert.equal(e.user_data.fbp, 'fb.1.1.1');
    assert.equal(e.user_data.fbc, 'fb.1.2.abc');
  });

  test('o que veio no payload tem precedência sobre o cookie', () => {
    const e = normalizeEvent({ user_data: { fbp: 'do-payload' } }, { cookies: { _fbp: 'do-cookie' } });
    assert.equal(e.user_data.fbp, 'do-payload');
  });

  test('user_id vira external_id automaticamente', () => {
    assert.equal(normalizeEvent({ user_id: 'jogador-42' }).user_data.external_id, 'jogador-42');
  });

  test('normaliza IPv4 mapeado em IPv6', () => {
    const req = { headers: {}, socket: { remoteAddress: '::ffff:187.1.2.3' } };
    assert.equal(extractClientIp(req), '187.1.2.3');
  });

  test('pega o primeiro IP da cadeia do X-Forwarded-For', () => {
    const req = { headers: { 'x-forwarded-for': '187.1.2.3, 10.0.0.1, 172.17.0.1' }, socket: {} };
    assert.equal(extractClientIp(req), '187.1.2.3');
  });
});

describe('cookies first-party', () => {
  test('deriva o domínio registrável para o cookie valer em todo o site', () => {
    assert.equal(registrableDomain('traker.codigovencedor.com'), '.codigovencedor.com');
    assert.equal(registrableDomain('ct.loja.com.br'), '.loja.com.br');
    assert.equal(registrableDomain('codigovencedor.com'), '.codigovencedor.com');
  });

  test('não define domínio para localhost nem para IP', () => {
    assert.equal(registrableDomain('localhost'), null);
    assert.equal(registrableDomain('192.168.0.10'), null);
  });

  test('lê os cookies do cabeçalho', () => {
    const c = parseCookies('_fbp=fb.1.1.1; _fbc=fb.1.2.abc; outro=x');
    assert.equal(c._fbp, 'fb.1.1.1');
    assert.equal(c._fbc, 'fb.1.2.abc');
  });
});

describe('conformidade com a documentação da Meta', () => {
  const projeto = { domain: 'codigovencedor.com', destinations: { meta: { config: {} } } };
  const base = {
    event_id: 'x', event_time: 1700000000, action_source: 'website',
    user_data: { email: 'a@b.com', client_user_agent: 'Mozilla/5.0' },
    consent_state: {},
  };

  test('nome e sobrenome vão sem pontuação — senão o hash diverge do da Meta', () => {
    const ud = buildUserData({ first_name: "D'Angelo", last_name: 'Silva-Souza' }, 1700000000);
    assert.deepEqual(ud.fn, [sha256('dangelo')]);
    assert.deepEqual(ud.ln, [sha256('silvasouza')]);
  });

  test('cidade e estado vão sem espaços', () => {
    const ud = buildUserData({ city: 'São Paulo', state: 'Rio de Janeiro' }, 1700000000);
    assert.deepEqual(ud.ct, [sha256('sãopaulo')]);
    assert.deepEqual(ud.st, [sha256('riodejaneiro')]);
  });

  test('país desconhecido é omitido em vez de virar código errado', () => {
    // "estados unidos".slice(0,2) daria "es" — a Espanha. Aceito sem erro, match errado.
    assert.equal(hashCountry('estados unidos'), sha256('us'));
    assert.equal(hashCountry('paisquenaoexiste'), undefined);
    assert.equal(hashCountry('Brasil'), sha256('br'));
  });

  test('data de nascimento aceita os formatos usuais e vira YYYYMMDD', () => {
    assert.equal(hashDataNascimento('1990-05-17'), sha256('19900517'));
    assert.equal(hashDataNascimento('17/05/1990'), sha256('19900517'));
    assert.equal(hashDataNascimento('texto qualquer'), undefined);
  });

  test('Purchase sem valor é bloqueado antes de sair', () => {
    const payload = buildMetaPayload({ ...base, event_name: 'purchase', custom_data: {} }, projeto, { config: { eventMap: { purchase: 'Purchase' } } });
    const { bloqueios } = validarEventoMeta(payload.data[0]);
    assert.ok(bloqueios.some((b) => /value/.test(b)));
  });

  test('moeda ausente assume o padrão em vez de derrubar a conversão', () => {
    const payload = buildMetaPayload({ ...base, event_name: 'purchase', custom_data: { value: 97 } }, projeto, { config: { eventMap: { purchase: 'Purchase' } } });
    assert.equal(payload.data[0].custom_data.currency, 'BRL');
    assert.equal(validarEventoMeta(payload.data[0]).bloqueios.length, 0);
  });

  test('event_source_url cai para o domínio do projeto quando o checkout não informa', () => {
    const payload = buildMetaPayload({ ...base, event_name: 'lead', custom_data: {} }, projeto, { config: {} });
    assert.equal(payload.data[0].event_source_url, 'https://codigovencedor.com/');
  });

  test('falta de User-Agent avisa, mas não impede o envio', () => {
    // Trocar um evento fraco por evento nenhum seria perda maior que o problema.
    const semUa = { ...base, event_name: 'lead', user_data: { email: 'a@b.com' }, custom_data: {} };
    const payload = buildMetaPayload(semUa, projeto, { config: {} });
    const { bloqueios, avisos } = validarEventoMeta(payload.data[0]);
    assert.equal(bloqueios.length, 0);
    assert.ok(avisos.some((a) => /client_user_agent/.test(a)));
  });

  test('num_items só acompanha InitiateCheckout', () => {
    const comum = { ...base, custom_data: { value: 10, currency: 'BRL', num_items: 3 } };
    const compra = buildMetaPayload({ ...comum, event_name: 'purchase' }, projeto, { config: { eventMap: { purchase: 'Purchase' } } });
    const checkout = buildMetaPayload({ ...comum, event_name: 'begin_checkout' }, projeto, { config: { eventMap: { begin_checkout: 'InitiateCheckout' } } });
    assert.equal(compra.data[0].custom_data.num_items, undefined);
    assert.equal(checkout.data[0].custom_data.num_items, 3);
  });

  test('referrer_url é aproveitado quando existe', () => {
    const ev = { ...base, event_name: 'lead', custom_data: {}, page: { referrer: 'https://google.com/' } };
    assert.equal(buildMetaPayload(ev, projeto, { config: {} }).data[0].referrer_url, 'https://google.com/');
  });

  test('AbandonedCheckout não é mapeado por padrão — não existe como evento padrão', () => {
    assert.equal(DEFAULT_META_MAP.abandoned_checkout, undefined);
    assert.equal(DEFAULT_META_MAP.pix_gerado, 'AddPaymentInfo');
  });
});

describe('Google Ads — UploadClickConversions', () => {
  const evento = {
    event_name: 'purchase',
    event_time: 1700000000,
    user_data: { gclid: 'Cj0KCQ-abc', email: 'Cliente@Exemplo.com', phone: '(11) 98765-4321' },
    custom_data: { value: 199.9, currency: 'BRL', order_id: '8812' },
    consent_state: {},
  };

  test('formata a data no padrão exigido pela API', () => {
    assert.equal(formatConversionDateTime(1700000000), '2023-11-14 22:13:20+00:00');
  });

  test('usa o gclid como identificador do clique', () => {
    const c = buildConversion(evento, 'customers/123/conversionActions/456');
    assert.equal(c.gclid, 'Cj0KCQ-abc');
    assert.equal(c.conversionAction, 'customers/123/conversionActions/456');
    assert.equal(c.conversionValue, 199.9);
    assert.equal(c.currencyCode, 'BRL');
    assert.equal(c.orderId, '8812');
  });

  test('cai para gbraid/wbraid quando não há gclid (tráfego de app/iOS)', () => {
    assert.equal(buildConversion({ ...evento, user_data: { gbraid: 'gb-1' } }, 'x').gbraid, 'gb-1');
    assert.equal(buildConversion({ ...evento, user_data: { wbraid: 'wb-1' } }, 'x').wbraid, 'wb-1');
  });

  test('Enhanced Conversions: e-mail e telefone vão hasheados', () => {
    const ids = buildConversion(evento, 'x').userIdentifiers;
    assert.deepEqual(ids[0], { hashedEmail: sha256('cliente@exemplo.com') });
    assert.deepEqual(ids[1], { hashedPhoneNumber: sha256('5511987654321') });
  });

  test('sem credenciais, diz exatamente o que falta em vez de falhar em silêncio', async () => {
    const projeto = { destinations: { google: { config: { route: 'google_ads' } } } };
    const r = await uploadClickConversion(evento, projeto);
    assert.equal(r.ok, false);
    assert.equal(r.retriable, false, 'falta de configuração não deve ser retentada');
    for (const campo of ['client_id', 'client_secret', 'refresh_token', 'developer_token', 'customer_id', 'conversion_action']) {
      assert.match(r.response.error, new RegExp(campo));
    }
  });
});

describe('adaptador do checkout Código Vencedor', () => {
  const base = () => ({
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

  test('reconhece o formato pelo conjunto event + lead + attribution', () => {
    assert.equal(adaptarPayload(base()).formato, 'codigo-vencedor');
    // Payload já canônico não é tocado.
    assert.equal(adaptarPayload({ event_name: 'purchase' }).formato, null);
  });

  test('valores em centavos viram unidade principal — erro de 100x se esquecido', () => {
    const { corpo } = adaptarPayload(base());
    assert.equal(corpo.custom_data.value, 0.01, 'amountMinor 1 = um centavo');
    assert.equal(corpo.custom_data.valor_original, 97);
    assert.equal(corpo.custom_data.desconto, 96.99);
  });

  test('usa o valor cobrado, não o valor de tabela', () => {
    // Com cupom de 99,99%, a receita real é R$ 0,01. Mandar os R$ 97 infla o ROAS.
    const { corpo } = adaptarPayload(base());
    assert.notEqual(corpo.custom_data.value, 97);
  });

  test('IP de rede privada é descartado em vez de virar sinal errado', () => {
    const { corpo } = adaptarPayload(base());
    assert.equal(corpo.user_data.client_ip_address, undefined);
    // Mas o User-Agent do navegador do comprador é aproveitado.
    assert.match(corpo.user_data.client_user_agent, /Chrome/);
  });

  test('reconhece IP público quando o checkout envia o certo', () => {
    const p = base();
    p.attribution.ipAddress = '::ffff:187.45.22.10';
    assert.equal(adaptarPayload(p).corpo.user_data.client_ip_address, '187.45.22.10');
  });

  test('separa nome em fn/ln e extrai o client_id do GA4', () => {
    const { corpo } = adaptarPayload(base());
    assert.equal(corpo.user_data.first_name, 'Joao');
    assert.equal(corpo.user_data.last_name, 'araujo');
    assert.equal(corpo.user_data.ga_client_id, '121717542.1784724157');
  });

  test('fbp com o formato novo (5 segmentos) passa intacto', () => {
    const { corpo } = adaptarPayload(base());
    assert.equal(corpo.user_data.fbp, 'fb.1.1784724156950.41423591235669370.AQYAAQIB');
  });

  describe('catálogo real de eventos do backoffice', () => {
    const nome = (evento, extra = {}) => nomeDoEvento({ event: evento, ...extra });

    test('purchase_approved é a compra — o resto do funil não é', () => {
      assert.equal(nome('purchase_approved'), 'purchase');
      assert.equal(nome('payment_generated'), 'pix_gerado');
      assert.equal(nome('checkout_card_attempted'), 'cartao_tentado');
      assert.equal(nome('checkout_session_opened'), 'begin_checkout');
      assert.equal(nome('checkout_abandoned'), 'abandoned_checkout');
    });

    test('leads do pré-checkout entram como lead', () => {
      assert.equal(nome('precheckout_opened'), 'lead');
      assert.equal(nome('checkout_lead_abandoned'), 'lead_abandonado');
    });

    test('cadastro e assinatura têm nomes próprios', () => {
      assert.equal(nome('user_registered'), 'sign_up');
      assert.equal(nome('subscription_started'), 'assinatura_iniciada');
      assert.equal(nome('subscription_renewed'), 'assinatura_renovada');
    });

    test('estorno e chargeback nunca viram compra', () => {
      assert.equal(nome('purchase_refunded'), 'compra_estornada');
      assert.equal(nome('chargeback_opened'), 'chargeback');
      assert.notEqual(nome('purchase_refunded'), 'purchase');
    });

    test('o mapeamento padrão só manda à Meta o que tem evento correspondente', () => {
      assert.equal(DEFAULT_META_MAP.purchase, 'Purchase');
      assert.equal(DEFAULT_META_MAP.pix_gerado, 'AddPaymentInfo');
      assert.equal(DEFAULT_META_MAP.cartao_tentado, 'AddPaymentInfo');
      assert.equal(DEFAULT_META_MAP.assinatura_iniciada, 'Subscribe');
      // Sem evento padrão equivalente: ficam para o operador decidir.
      for (const semMapa of ['compra_estornada', 'chargeback', 'abandoned_checkout', 'ferramenta_usada']) {
        assert.equal(DEFAULT_META_MAP[semMapa], undefined, `${semMapa} não deveria ter mapeamento padrão`);
      }
    });
  });

  describe('classificação de eventos — o que é e o que não é receita', () => {
    const nome = (evento, extra = {}) => nomeDoEvento({ event: evento, ...extra });

    test('PIX gerado NÃO é compra', () => {
      // Gerar o QR Code é intenção; boa parte nunca é paga. Contar como compra
      // inflaria o ROAS e ensinaria a Meta a buscar quem gera PIX e não paga.
      assert.equal(nome('checkout.pix.generated'), 'pix_gerado');
      assert.equal(nome('checkout.pix.generated', { amountMinor: 9700 }), 'pix_gerado');
    });

    test('sessão de checkout concluída sem pagamento NÃO é compra', () => {
      assert.equal(nome('checkout.session.completed'), 'checkout_concluido');
      assert.equal(nome('checkout.session.completed', { paymentStatus: 'pending' }), 'checkout_concluido');
    });

    test('só vira compra com pagamento declarado como concluído', () => {
      assert.equal(nome('checkout.session.completed', { paymentStatus: 'paid' }), 'purchase');
      assert.equal(nome('payment.approved'), 'purchase');
      assert.equal(nome('order.paid'), 'purchase');
      // Evento desconhecido, mas com pagamento confirmado, também conta.
      assert.equal(nome('algo.novo.qualquer', { paymentStatus: 'approved' }), 'purchase');
    });

    test('evento desconhecido não some — vira nome legível para mapear no painel', () => {
      assert.equal(nome('checkout.boleto.generated'), 'checkout_boleto_generated');
    });
  });

  test('PIX gerado carrega o valor pretendido e o prazo, sem virar receita', () => {
    const pix = {
      ...base(),
      event: 'checkout.pix.generated',
      eventId: '36781fb1509a47b4b2424f13c6a70147',
      amountMinor: 9700,
      pricing: { couponCode: null, discountMinor: 0, originalAmountMinor: 9700 },
      gatewayId: 'mercadopago',
      chargeExpiresAt: '2026-08-12T13:50:11.5250647+00:00',
      paymentStatus: undefined,
    };
    delete pix.paymentStatus;

    const { corpo } = adaptarPayload(pix);
    assert.equal(corpo.event_name, 'pix_gerado');
    assert.equal(corpo.custom_data.value, 97);
    assert.equal(corpo.event_id, '36781fb1509a47b4b2424f13c6a70147');
  });
});

describe('criptografia de credenciais', () => {
  test('ida e volta preserva o valor', () => {
    const token = 'EAABsb...token-super-secreto';
    const cifrado = encrypt(token);
    assert.notEqual(cifrado, token);
    assert.equal(decrypt(cifrado), token);
  });

  test('cada cifragem gera saída diferente (IV aleatório)', () => {
    assert.notEqual(encrypt('mesmo-valor'), encrypt('mesmo-valor'));
  });

  test('valor adulterado não decifra (tag GCM)', () => {
    const cifrado = encrypt('token');
    const adulterado = cifrado.slice(0, -4) + 'AAAA';
    assert.equal(decrypt(adulterado), '');
  });

  test('slug de ingestão não forma palavra e é distinto a cada chamada', () => {
    const slug = randomSlug(8);
    assert.match(slug, /^[23456789bcdfghjkmnpqrstvwxyz]{8}$/);
    assert.notEqual(randomSlug(8), randomSlug(8));
  });
});

describe('DATABASE_URL: quebra em campos antes de entregar ao driver', () => {
  // Estes testes existem por causa de uma falha de produção: o parser de connection string
  // do `pg` trata `#` como início de fragmento, então uma senha com `#` chegava truncada e
  // o Postgres recusava a autenticação — sem nada no erro apontando para a senha.
  test('senha com # sobrevive inteira (o defeito que quebrou o deploy)', () => {
    const c = parsePgConnectionString('postgres://traker:se#nha#123@db:5432/traker');
    assert.equal(c.password, 'se#nha#123');
    assert.equal(c.database, 'traker');
    assert.equal(c.host, 'db');
    assert.equal(c.port, 5432);
  });

  test('percent-encoding é desfeito (senha com @ cadastrada como %40)', () => {
    assert.equal(parsePgConnectionString('postgres://u:p%40ss@host/banco').password, 'p@ss');
  });

  test('porta ausente cai no padrão 5432', () => {
    assert.equal(parsePgConnectionString('postgres://u:p@host/banco').port, 5432);
  });

  test('sslmode segue a semântica do libpq, não a do driver', () => {
    // require = cifra sem validar cadeia. `ssl: true` no pg validaria e a conexão morreria
    // com "self signed certificate" em banco gerenciado com certificado próprio.
    assert.deepEqual(parsePgConnectionString('postgres://u:p@h/b?sslmode=require').ssl, { rejectUnauthorized: false });
    assert.deepEqual(parsePgConnectionString('postgres://u:p@h/b?sslmode=verify-full').ssl, { rejectUnauthorized: true });
    assert.equal(parsePgConnectionString('postgres://u:p@h/b?sslmode=disable').ssl, false);
  });

  test('aceita o esquema postgresql:// além de postgres://', () => {
    assert.equal(parsePgConnectionString('postgresql://u:p@h:6432/b').port, 6432);
  });

  test('URL inválida falha no boot, e a mensagem não vaza a senha', () => {
    for (const ruim of ['', '   ', 'mysql://u:p@h/b', 'sem-esquema']) {
      assert.throws(() => parsePgConnectionString(ruim), (err) => {
        assert.match(err.message, /DATABASE_URL/);
        assert.ok(!err.message.includes('p@h'), 'a mensagem de erro não pode conter a URL');
        return true;
      });
    }
  });
});
