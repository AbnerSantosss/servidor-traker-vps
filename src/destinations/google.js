// Destino Google. Duas rotas possíveis, escolhidas por projeto em config.route:
//
//   ga4_mp     -> GA4 Measurement Protocol. Alimenta o GA4; a conversão chega ao Google
//                 Ads pela importação de conversões do GA4. É a rota mais simples de
//                 operar: exige apenas measurement id + api secret.
//   google_ads -> Google Ads API (UploadClickConversions), implementada em google-ads.js.
//                 Envia direto para a conta de anúncios, sem passar pelo GA4, mas exige
//                 OAuth2 e um developer token aprovado pelo Google.
//
// Ver wiki: integracoes/Google Ads Conversion API.md
import { credential } from '../db/repos/projects.js';
import { uploadClickConversion } from './google-ads.js';
import { hashPII, hashPhone } from '../config/crypto.js';
import { applyConsent } from '../ingest/consent.js';
import { log } from '../config/log.js';

// O GA4 exige um client_id. Se o site não mandou o _ga, derivamos um pseudo-id estável
// a partir do user_id para que os eventos do mesmo usuário caiam na mesma sessão lógica.
function resolveClientId(event, config) {
  // Preferência: o client_id real do cookie _ga (extraído na normalização). Sem ele,
  // o GA4 conta cada evento como um usuário novo e a sessão não se junta à do site.
  const fromCookie = event.user_data?.ga_client_id || event.custom_data?.client_id;
  if (fromCookie) return String(fromCookie);
  if (config.ga4ClientId) return String(config.ga4ClientId);
  if (event.user_id) {
    // formato aceito pelo GA4: <numero>.<numero>
    let hash = 0;
    const s = String(event.user_id);
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return `${hash}.${event.event_time}`;
  }
  return `${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
}

export function buildGa4Payload(event, config) {
  const withConsent = applyConsent(event);
  const eventName = config.eventMap?.[withConsent.event_name] || withConsent.event_name;

  const params = { ...withConsent.custom_data };
  if (params.value !== undefined) params.value = Number(params.value);
  params.engagement_time_msec = params.engagement_time_msec || 100;
  if (withConsent.event_source_url) params.page_location = withConsent.event_source_url;

  const payload = {
    client_id: resolveClientId(withConsent, config),
    timestamp_micros: withConsent.event_time * 1_000_000,
    non_personalized_ads: withConsent.consent_state?.ad_personalization === 'denied',
    events: [{ name: eventName, params }],
  };

  if (withConsent.user_id) payload.user_id = String(withConsent.user_id);

  // user_data para Enhanced Conversions do GA4 (aceita e-mail/telefone hasheados SHA-256).
  const sha256Email = hashPII(withConsent.user_data?.email);
  const sha256Phone = hashPhone(withConsent.user_data?.phone);
  if (sha256Email || sha256Phone) {
    payload.user_data = {};
    if (sha256Email) payload.user_data.sha256_email_address = [sha256Email];
    if (sha256Phone) payload.user_data.sha256_phone_number = [sha256Phone];
  }

  return payload;
}

async function sendGa4(event, project, config) {
  const measurementId = String(config.measurementId || '').trim();
  const apiSecret = credential(project, 'google', 'api_secret');

  if (!measurementId || !apiSecret) {
    return { ok: false, retriable: false, response: { error: 'GA4 não configurado (measurement id ou api secret ausente)' } };
  }

  const payload = buildGa4Payload(event, config);
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });

    // O Measurement Protocol responde 204 sem corpo em caso de sucesso e NÃO valida o
    // payload — erro de schema passa silencioso. Use o endpoint /debug/mp/collect ao
    // configurar (ver docs/04) para validar de verdade.
    const ok = res.status === 204 || res.ok;
    log(ok ? 'debug' : 'warn', 'ga4 measurement protocol', { status: res.status, evento: payload.events[0].name });

    return {
      ok,
      httpStatus: res.status,
      retriable: res.status >= 500 || res.status === 429,
      response: ok ? { accepted: true, event: payload.events[0].name } : { error: `HTTP ${res.status}` },
    };
  } catch (err) {
    return { ok: false, retriable: true, response: { error: String(err?.message || err) } };
  }
}

export async function sendToGoogle(event, project) {
  const config = project.destinations.google?.config || {};
  // A rota google_ads exige credenciais OAuth2 e um developer token aprovado; sem eles
  // o próprio módulo devolve erro explícito listando o que falta.
  return config.route === 'google_ads'
    ? uploadClickConversion(event, project)
    : sendGa4(event, project, config);
}
