// Normaliza o payload cru (GTM Web ou webhook) para o "Evento Interno" canônico —
// o único formato do qual derivam TODOS os payloads de saída (Meta, Google, postback).
// Ver docs/01-arquitetura.md, seção "Evento Interno".
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { ipPublico } from './adaptadores.js';
// sanitizeClickIds mora no repo de identidades (não aqui) porque é lá que vive a lista
// fechada MARKETING_KEYS — mesma fonte de verdade para "o que é aceito como
// identificador de clique", só que para a camada ABERTA (chave arbitrária por allowlist
// de formato). collect.js já importa MARKETING_KEYS de lá pelo mesmo motivo.
import { sanitizeClickIds } from '../db/repos/identities.js';

/**
 * IP real do visitante. Só confiamos em X-Forwarded-For quando há proxy declarado
 * (TRUST_PROXY): aceitar o header sempre permitiria a qualquer cliente forjar o IP,
 * e o IP é campo de match da Meta. Pegamos o primeiro da lista (o cliente original).
 */
export function extractClientIp(req) {
  if (env.TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return normalizeIp(first);
    }
    const real = req.headers['x-real-ip'];
    if (real) return normalizeIp(String(real).trim());
  }
  return normalizeIp(req.socket?.remoteAddress || '');
}

// ::ffff:187.1.2.3 -> 187.1.2.3 (a Meta espera IPv4 puro quando for IPv4).
function normalizeIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

const CONSENT_VALUES = new Set(['granted', 'denied']);

function normalizeConsent(raw) {
  const c = raw || {};
  const norm = (v) => {
    if (v === true) return 'granted';
    if (v === false) return 'denied';
    const s = String(v || '').toLowerCase();
    return CONSENT_VALUES.has(s) ? s : undefined;
  };
  return {
    ad_storage: norm(c.ad_storage),
    analytics_storage: norm(c.analytics_storage),
    ad_user_data: norm(c.ad_user_data),
    ad_personalization: norm(c.ad_personalization),
  };
}

const first = (...values) => values.find((v) => v !== undefined && v !== null && String(v).trim() !== '') || undefined;

/**
 * Extrai o gclid de dentro do cookie _gcl_aw.
 * O cookie NÃO guarda o gclid puro: o formato é `GCL.<timestamp>.<gclid>`. Mandar o
 * valor bruto para o Google significa enviar um identificador de clique inválido — a
 * conversão é aceita e simplesmente não casa com nenhum clique.
 */
export function gclidFromCookie(value) {
  if (!value) return undefined;
  const parts = String(value).split('.');
  return parts.length >= 3 ? parts.slice(2).join('.') : String(value);
}

/**
 * Extrai o client_id do cookie _ga (formato `GA1.1.<client_id>` — as duas primeiras
 * partes são versão e profundidade de domínio). Sem ele, o GA4 trata cada evento do
 * Measurement Protocol como um usuário novo.
 */
export function gaClientIdFromCookie(value) {
  if (!value) return undefined;
  const parts = String(value).split('.');
  return parts.length >= 4 ? `${parts[2]}.${parts[3]}` : undefined;
}

/**
 * Gera o event_id quando o cliente não mandou.
 * Se houver um identificador de negócio (order_id / transaction_id), derivamos um ID
 * DETERMINÍSTICO — assim a mesma compra que chega pelo navegador e pelo webhook produz
 * o mesmo event_id e a Meta deduplica. Sem ID de negócio, cai para UUID aleatório.
 * Ver docs/01-arquitetura.md, seção 7 (desduplicação).
 */
export function deriveEventId(body, eventName) {
  const explicit = first(body.event_id, body.eventID, body.eventId);
  if (explicit) return String(explicit);

  const businessId = first(
    body.custom_data?.order_id,
    body.custom_data?.transaction_id,
    body.order_id,
    body.transaction_id
  );
  if (businessId) return `${eventName}-${businessId}`;

  return crypto.randomUUID();
}

export function normalizeEvent(body, { clientIp, userAgent, source = 'web', cookies = {} } = {}) {
  const b = body || {};
  const nowSec = Math.floor(Date.now() / 1000);

  const event_name = String(first(b.event_name, b.event, 'custom_event'));
  const event_id = deriveEventId(b, event_name);

  // event_time do cliente, com sanidade: a Meta rejeita eventos com mais de 7 dias
  // e não aceita futuro. Fora da janela, usamos a hora do servidor.
  const rawTime = Number(b.event_time);
  const sevenDaysAgo = nowSec - 7 * 24 * 3600;
  const event_time = Number.isFinite(rawTime) && rawTime > sevenDaysAgo && rawTime <= nowSec + 60 ? Math.floor(rawTime) : nowSec;

  const u = b.user_data || {};
  const user_id = first(b.user_id, u.user_id, u.external_id);

  // Camada aberta (F9/E9): qualquer identificador que o servidor não conhece nomeado,
  // capturado pelo site por allowlist de query string e repassado aqui. Sanitizado de
  // novo no servidor mesmo que a tag já filtre no navegador — nunca se confia em
  // validação feita só do lado do cliente. Chave ausente (em vez de objeto vazio)
  // quando não há nada: consistente com o resto do arquivo ("melhor faltar do que
  // mandar errado") e é o que permite ao merge da ponte de identidade (mergeIdentityIntoUserData)
  // saber que este campo ainda está livre para ser preenchido.
  const clickIds = sanitizeClickIds(u.click_ids || b.click_ids);

  return {
    event_id,
    event_name,
    event_time,
    source,
    event_source_url: first(b.page_location, b.event_source_url, b.url) || '',
    // `action_source` descreve ONDE a conversão aconteceu, não quem enviou o evento.
    // Uma compra feita no site e apenas confirmada pelo backend é `website` —
    // `system_generated` é para conversão sem origem no site e atribui pior.
    action_source: b.action_source || 'website',
    user_id,
    user_data: {
      // PII crua — só é normalizada/hasheada na montagem do payload de cada destino,
      // porque cada plataforma tem regra própria.
      email: first(u.email, u.em, b.email),
      phone: first(u.phone, u.ph, b.phone),
      first_name: first(u.first_name, u.fn, b.first_name),
      last_name: first(u.last_name, u.ln, b.last_name),
      city: first(u.city, u.ct),
      state: first(u.state, u.st),
      zip: first(u.zip, u.zp),
      country: first(u.country),
      // `buildUserData` da Meta já sabe hashear isto em `db` (hashDataNascimento) — o
      // campo só não atravessava a normalização, então nenhuma origem conseguia
      // entregá-lo. O catálogo do xWinner traz `lead.birth_date` de graça.
      birth_date: first(u.birth_date, u.date_of_birth, b.birth_date),
      external_id: first(u.external_id, user_id),

      // Identificadores de navegador — NUNCA hasheados, formato exato do cookie.
      // Cookie da requisição entra como fallback: se o JS não conseguiu ler (ITP,
      // bloqueador), o valor ainda chega pelo header Cookie.
      fbp: first(u.fbp, b.fbp, cookies._fbp),
      fbc: first(u.fbc, b.fbc, cookies._fbc),
      fbclid: first(u.fbclid, b.fbclid),
      gclid: first(u.gclid, b.gclid, gclidFromCookie(cookies._gcl_aw)),
      // client_id do GA4, necessário para o Measurement Protocol.
      ga_client_id: first(u.ga_client_id, b.ga_client_id, gaClientIdFromCookie(cookies._ga)),
      gbraid: first(u.gbraid, b.gbraid),
      wbraid: first(u.wbraid, b.wbraid),
      ttclid: first(u.ttclid, b.ttclid),
      ttp: first(u.ttp, b.ttp, cookies._ttp),
      clickid: first(u.clickid, b.clickid),
      tblci: first(u.tblci, b.tblci),

      // Camada explícita de identificadores de outras plataformas de anúncio (F9/E9).
      // Mesmo tratamento dos identificadores acima: string opaca, nunca hasheada,
      // repassada como veio. Meta/Google/GA4 simplesmente ignoram o que não conhecem —
      // quem consome de verdade é o postback (ver src/destinations/postback.js).
      msclkid: first(u.msclkid, b.msclkid),           // Microsoft/Bing Ads
      twclid: first(u.twclid, b.twclid),               // X (Twitter) Ads
      li_fat_id: first(u.li_fat_id, b.li_fat_id),       // LinkedIn
      epik: first(u.epik, b.epik),                      // Pinterest
      sccid: first(u.sccid, b.sccid),                   // Snapchat
      _scid: first(u._scid, b._scid),                   // Snapchat (cookie de pixel)
      rdt_cid: first(u.rdt_cid, b.rdt_cid),             // Reddit
      irclickid: first(u.irclickid, b.irclickid),       // Impact (afiliados)
      obclid: first(u.obclid, b.obclid),                // Outbrain
      kwai_click_id: first(u.kwai_click_id, b.kwai_click_id), // Kwai

      utm_source: first(u.utm_source, b.utm_source),
      utm_medium: first(u.utm_medium, b.utm_medium),
      utm_campaign: first(u.utm_campaign, b.utm_campaign),
      utm_content: first(u.utm_content, b.utm_content),
      utm_term: first(u.utm_term, b.utm_term),

      // Origem do IP e do User-Agent, por tipo de evento:
      //
      // Navegador  — quem faz a requisição É o visitante, então os dados da conexão são
      //              a verdade e não se confia no que o payload alega.
      // Webhook    — quem faz a requisição é o servidor do cliente. O IP da conexão
      //              seria o do datacenter dele e o User-Agent o da biblioteca HTTP.
      //              Aqui o payload vale mais: plataformas de checkout costumam carregar
      //              o IP e o navegador reais do comprador, capturados na hora da compra.
      //              O IP passa por filtro de rede privada antes de ser aceito.
      //              Sobrando vazio, a ponte de identidade completa depois; se nem ela
      //              tiver, o campo fica AUSENTE — melhor faltar do que mandar errado.
      client_ip_address: source === 'webhook'
        ? ipPublico(u.client_ip_address)
        : (clientIp || undefined),
      client_user_agent: source === 'webhook'
        ? first(u.client_user_agent)
        : (userAgent || undefined),

      // Camada aberta de identificadores (ver comentário acima, junto de `clickIds`).
      ...(Object.keys(clickIds).length ? { click_ids: clickIds } : {}),
    },
    custom_data: b.custom_data || {},
    consent_state: normalizeConsent(b.consent_state || b.consent),
    page: {
      path: b.page_path,
      title: b.page_title,
      referrer: b.page_referrer || b.referrer,
    },
  };
}

/**
 * Versão do evento segura para persistir no log: PII de texto vira hash,
 * de modo que o banco nunca guarda e-mail ou telefone em claro (LGPD).
 * Os identificadores de navegador continuam em claro — não são PII direta e
 * são necessários para reprocessar o evento.
 */
export function redactForStorage(event, hashers) {
  const copy = structuredClone(event);
  const u = copy.user_data || {};
  const map = {
    email: hashers.hashEmail,
    phone: hashers.hashPhone,
    first_name: hashers.hashName,
    last_name: hashers.hashName,
    city: hashers.hashCityState,
    state: hashers.hashCityState,
    zip: hashers.hashZip,
    country: hashers.hashCountry,
    // Data de nascimento é PII: não pode ficar em claro no log de eventos.
    birth_date: hashers.hashDataNascimento,
  };
  for (const [field, fn] of Object.entries(map)) {
    if (u[field]) u[field] = fn(u[field]);
  }
  return copy;
}
