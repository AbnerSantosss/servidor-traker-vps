// Meta Conversions API.
// POST https://graph.facebook.com/{versão}/{pixel_id}/events
//
// Ver wiki: integracoes/Meta Conversions API.md e, no vault de Trakeamento Avançado,
// `Payload Conversions API Meta Ads` (tabela completa de campos e normalização).
import { env } from '../config/env.js';
import { credential } from '../db/repos/projects.js';
import {
  hashEmail, hashName, hashCityState, hashExternalId, hashPhone, hashZip, hashCountry,
  hashDataNascimento, hashGenero,
} from '../config/crypto.js';
import { applyConsent } from '../ingest/consent.js';
import { log } from '../config/log.js';

/**
 * Extrai o fbclid de dentro de um _fbc (`fb.<versão>.<timestamp_ms>.<fbclid>`).
 * O fbclid é a QUARTA parte em diante: ele nunca contém ponto, mas juntar o resto em vez
 * de pegar só `p[3]` mantém a função honesta se algum dia contiver.
 * Devolve string vazia quando o valor não está no formato — nunca inventa nada.
 */
export function fbclidDeFbc(fbc) {
  if (!fbc) return '';
  const p = String(fbc).split('.');
  return p.length >= 4 ? p.slice(3).join('.') : '';
}

/**
 * Monta o _fbc que vai para a Meta.
 *
 * Duas responsabilidades, e a segunda é a que custa dinheiro quando falha:
 *
 * 1. **Derivar** o fbc quando só temos o fbclid (cookie ausente, Pixel bloqueado, ITP).
 *    Formato oficial: `fb.1.<timestamp_ms>.<fbclid>`.
 * 2. **Corrigir** o fbc que veio do navegador quando o fbclid dentro dele NÃO é o do
 *    clique deste evento. A Meta compara o fbc com o `fbclid` da URL do evento e, quando
 *    divergem, marca "o servidor está enviando um valor fbclid modificado no parâmetro
 *    fbc" — alerta de alta prioridade que degrada atribuição e otimização.
 *
 *    A divergência é o caso NORMAL na página de entrada de um clique novo: a tag roda
 *    ANTES do Pixel (prioridade alta no GTM, de propósito — ela precisa capturar o
 *    fbclid antes de qualquer navegação interna), e quem reescreve o `_fbc` é o Pixel.
 *    Ou seja, no page_view do clique novo o cookie ainda carrega o clique ANTERIOR.
 *    Preferir o cookie cegamente era mandar o fbclid velho para a Meta com a URL do
 *    clique novo do lado — exatamente o que ela detecta.
 *
 * O que NUNCA acontece aqui: alterar o fbclid. Ele é copiado byte a byte (base64url é
 * sensível a maiúsculas), sem trim, sem lowercase, sem corte.
 *
 * Quando o fbc e o fbclid CONCORDAM, o cookie é preservado inteiro — o timestamp dele é
 * o do clique de verdade, e é melhor que o do evento.
 */
export function deriveFbc(userData, eventTime) {
  const fbc = userData.fbc;
  const fbclid = userData.fbclid;

  // Sem fbclid para comparar, o que veio do navegador é o melhor que temos.
  if (!fbclid) return fbc || undefined;

  // Cookie coerente com o clique: preserva o carimbo de tempo original.
  if (fbc && fbclidDeFbc(fbc) === fbclid) return fbc;

  // Sem cookie, cookie malformado ou cookie de OUTRO clique: refaz a partir do fbclid.
  const ts = eventTime ? eventTime * 1000 : Date.now();
  return `fb.1.${ts}.${fbclid}`;
}

/**
 * Monta o user_data no formato da Meta.
 * Regra que quebra match silenciosamente se errada: PII vai hasheada (SHA-256 após
 * normalizar), mas fbp/fbc/IP/User-Agent vão em TEXTO PLANO. Hashear fbp/fbc é um dos
 * erros mais comuns e não gera nenhum aviso da Meta.
 */
export function buildUserData(u = {}, eventTime) {
  const ud = {};
  const put = (key, value) => { if (value) ud[key] = [value]; };

  // Cada campo tem regra própria de normalização — usar a mesma para todos faz o hash
  // divergir do que a Meta calcula, e o match some sem nenhum erro de retorno.
  put('em', hashEmail(u.email));
  put('ph', hashPhone(u.phone));
  put('fn', hashName(u.first_name));
  put('ln', hashName(u.last_name));
  put('ct', hashCityState(u.city));
  put('st', hashCityState(u.state));
  put('zp', hashZip(u.zip));
  put('country', hashCountry(u.country));
  put('external_id', hashExternalId(u.external_id));
  put('db', hashDataNascimento(u.birth_date || u.date_of_birth));
  put('ge', hashGenero(u.gender));

  // Texto plano — nunca hashear.
  if (u.fbp) ud.fbp = u.fbp;
  const fbc = deriveFbc(u, eventTime);
  if (fbc) ud.fbc = fbc;
  if (u.client_ip_address) ud.client_ip_address = u.client_ip_address;
  if (u.client_user_agent) ud.client_user_agent = u.client_user_agent;

  return ud;
}

// Parâmetros padrão da Meta. Estes têm significado próprio no Gerenciador de Eventos.
const CAMPOS_PADRAO_META = [
  'value', 'currency', 'content_name', 'content_category', 'content_ids', 'content_type',
  'contents', 'num_items', 'order_id', 'predicted_ltv', 'search_string', 'status', 'delivery_category',
];

/**
 * Monta o custom_data.
 *
 * Além dos parâmetros padrão, repassa os campos extras do evento (forma de pagamento,
 * cupom, valor de tabela…). A Meta aceita chaves adicionais dentro de custom_data e as
 * expõe na criação de conversões personalizadas — é assim que se consegue, por exemplo,
 * uma conversão só de quem pagou por PIX, ou segmentar por cupom usado.
 *
 * Só passam valores escalares: objeto aninhado ou array de objeto seriam rejeitados
 * pela API e derrubariam o evento inteiro por causa de um campo acessório.
 */
function buildCustomData(cd = {}, eventName) {
  const out = {};

  for (const key of CAMPOS_PADRAO_META) {
    if (cd[key] !== undefined && cd[key] !== null && cd[key] !== '') out[key] = cd[key];
  }
  if (out.value !== undefined) out.value = Number(out.value);

  // A documentação restringe num_items a InitiateCheckout; fora dele, é ruído.
  if (eventName !== 'InitiateCheckout') delete out.num_items;

  for (const [key, valor] of Object.entries(cd)) {
    if (CAMPOS_PADRAO_META.includes(key)) continue;
    if (valor === undefined || valor === null || valor === '') continue;
    const tipo = typeof valor;
    if (tipo === 'string' || tipo === 'number' || tipo === 'boolean') out[key] = valor;
  }

  return out;
}

export function buildMetaPayload(event, project, { config }) {
  const withConsent = applyConsent(event);
  const flags = withConsent._consentFlags || {};

  // Tradução do nome do site para o nome da plataforma. Precisa bater EXATAMENTE com o
  // nome usado pelo Pixel do navegador, senão a deduplicação não acontece.
  const eventName = config.eventMap?.[withConsent.event_name] || withConsent.event_name;

  const serverEvent = {
    event_name: eventName,
    event_time: withConsent.event_time,
    event_id: withConsent.event_id,
    action_source: withConsent.action_source || 'website',
    user_data: buildUserData(withConsent.user_data, withConsent.event_time),
  };

  // URL de origem: campo esperado em evento de site. Quando a conversão vem por webhook
  // e o checkout não informa a página, o domínio do projeto é uma aproximação honesta —
  // melhor que omitir um campo que a Meta pede.
  serverEvent.event_source_url = withConsent.event_source_url
    || (project?.domain ? `https://${project.domain}/` : undefined);
  if (!serverEvent.event_source_url) delete serverEvent.event_source_url;
  // A Meta documenta referrer_url como parâmetro do evento; já coletamos o referrer na
  // normalização e não custava nada aproveitá-lo.
  if (withConsent.page?.referrer) serverEvent.referrer_url = withConsent.page.referrer;

  const customData = buildCustomData(withConsent.custom_data, eventName);
  // Moeda ausente com valor presente: assume a moeda padrão do projeto em vez de deixar
  // a Meta recusar. Um `value` sem `currency` é ambíguo e a API não adivinha.
  if (customData.value !== undefined && !customData.currency) {
    customData.currency = config.defaultCurrency || 'BRL';
  }
  if (Object.keys(customData).length) serverEvent.custom_data = customData;

  if (flags.limitedDataUse) {
    serverEvent.data_processing_options = ['LDU'];
    serverEvent.data_processing_options_country = 0;
    serverEvent.data_processing_options_state = 0;
  }

  const payload = { data: [serverEvent] };
  if (config.testEventCode) payload.test_event_code = config.testEventCode;
  return payload;
}

/**
 * Confere o evento antes de gastar uma chamada de rede.
 *
 * A separação entre bloqueio e aviso é deliberada:
 *
 * **Bloqueio** é só para o que torna o evento inútil ou certamente recusado — e que o
 * servidor não tem como consertar sozinho. Um `Purchase` sem valor é o caso clássico:
 * pode ser recusado com erro genérico ou, pior, aceito e contabilizado com receita
 * zero, o que ninguém percebe até o relatório não fechar.
 *
 * **Aviso** é para o que degrada a correspondência mas ainda vale enviar. Barrar uma
 * conversão real porque falta o User-Agent seria trocar um evento fraco por evento
 * nenhum — perda maior do que o problema que se queria evitar.
 */
export function validarEventoMeta(serverEvent) {
  const bloqueios = [];
  const avisos = [];

  if (!serverEvent.event_name) bloqueios.push('event_name ausente');
  if (!serverEvent.event_time) bloqueios.push('event_time ausente');
  if (!serverEvent.action_source) bloqueios.push('action_source ausente');

  if (serverEvent.event_name === 'Purchase') {
    const valor = serverEvent.custom_data?.value;
    if (valor === undefined || valor === null || Number.isNaN(Number(valor))) {
      bloqueios.push('Purchase exige custom_data.value — sem valor, a conversão entra com receita zero');
    }
  }

  if (serverEvent.action_source === 'website') {
    if (!serverEvent.event_source_url) avisos.push('evento de site sem event_source_url');
    if (!serverEvent.user_data?.client_user_agent) avisos.push('evento de site sem client_user_agent (a Meta pede para eventos de site)');
  }

  return { bloqueios, avisos };
}

export async function sendToMeta(event, project) {
  const dest = project.destinations.meta;
  const config = dest?.config || {};
  const pixelId = String(config.pixelId || '').trim();
  const token = credential(project, 'meta', 'access_token');

  if (!pixelId || !token) {
    return { ok: false, retriable: false, response: { error: 'Meta não configurado (pixel id ou access token ausente)' } };
  }

  const payload = buildMetaPayload(event, project, { config });

  const { bloqueios, avisos } = validarEventoMeta(payload.data[0]);
  if (bloqueios.length) {
    // Não é retriável: reenviar o mesmo payload incompleto daria o mesmo resultado.
    log('warn', 'evento bloqueado antes do envio à Meta', { evento: payload.data[0].event_name, bloqueios });
    return {
      ok: false,
      retriable: false,
      response: { error: `evento incompleto para a Meta: ${bloqueios.join('; ')}`, problemas: bloqueios },
    };
  }
  if (avisos.length) {
    log('warn', 'evento enviado com campos faltando', { evento: payload.data[0].event_name, avisos });
  }
  const url = `https://graph.facebook.com/${env.META_API_VERSION}/${pixelId}/events`;

  try {
    // access_token no corpo, não na query string: evita o token aparecer em log de proxy.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, access_token: token }),
      signal: AbortSignal.timeout(15_000),
    });

    const json = await res.json().catch(() => ({}));
    const ok = res.ok && !json.error;

    log(ok ? 'debug' : 'warn', `meta ${payload.data[0].event_name}`, {
      status: res.status,
      ok,
      eventos_recebidos: json.events_received,
      erro: json.error?.message,
    });

    return {
      ok,
      httpStatus: res.status,
      // 5xx e 429 valem retry; 4xx de configuração (token inválido, pixel errado) não —
      // insistir só queima rate limit.
      retriable: res.status >= 500 || res.status === 429,
      // No erro, guardamos MAIS do que a mensagem: o `error_subcode` é o que distingue
      // causas que compartilham o mesmo `code` (o 100 cobre desde `event_time` fora da
      // janela de 7 dias — subcode 2804019 — até campo mal formatado), e o
      // `error_user_msg` é o texto que a própria Meta escreveu para ser lido por uma
      // pessoa. Sem esses campos, o painel só consegue mostrar "erro 100", que não diz
      // a ninguém o que fazer. Ver src/destinations/erros-explicados.js.
      response: ok
        ? { events_received: json.events_received, fbtrace_id: json.fbtrace_id }
        : {
            error: json.error?.message || json.error || `HTTP ${res.status}`,
            code: json.error?.code,
            error_subcode: json.error?.error_subcode,
            error_user_title: json.error?.error_user_title,
            error_user_msg: json.error?.error_user_msg,
            fbtrace_id: json.fbtrace_id,
          },
    };
  } catch (err) {
    // Timeout / falha de rede: sempre vale nova tentativa.
    return { ok: false, retriable: true, response: { error: String(err?.message || err) } };
  }
}
