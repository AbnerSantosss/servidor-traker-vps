// Google Ads API — ConversionUploadService.UploadClickConversions.
//
// Portado do spike validado em 2026-07-22 (ver wiki: integracoes/Google Ads Conversion API.md).
//   Auth      : OAuth2 (client_id + client_secret + refresh_token -> access_token) e
//               developer-token no cabeçalho.
//   Conversão : gclid | gbraid | wbraid  OU  user_identifiers (e-mail/telefone SHA-256).
//   Campos    : conversion_action (resource name), conversion_date_time, valor e moeda.
//
// O client está completo, mas o upload só funciona com uma conta Google Ads cujo acesso à
// API tenha sido aprovado (developer token). Sem isso a troca de token falha com erro
// tratado e visível no log do evento — nunca há sucesso silencioso e falso.
import { credential } from '../db/repos/projects.js';
import { hashPII, hashPhone } from '../config/crypto.js';
import { applyConsent } from '../ingest/consent.js';
import { log } from '../config/log.js';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Versão validada no spike. A Google descontinua versões da Ads API periodicamente;
// por isso fica configurável, para atualizar sem mexer no código.
const ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v17';

// Cache de access_token por refresh_token (vale ~1h; renovamos com folga de 1 min).
const tokenCache = new Map();

async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const detalhe = json.error_description || json.error || `status ${res.status}`;
    const err = new Error(`OAuth falhou: ${detalhe}`);
    err.retriable = res.status >= 500;
    throw err;
  }

  tokenCache.set(refreshToken, {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
  });
  return json.access_token;
}

// Formato exigido pela Google Ads API: "yyyy-mm-dd hh:mm:ss+00:00".
export function formatConversionDateTime(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+00:00`;
}

export function buildConversion(event, conversionActionResource) {
  const conv = {
    conversionAction: conversionActionResource,
    conversionDateTime: formatConversionDateTime(event.event_time),
  };

  const value = event.custom_data?.value;
  if (value != null && Number.isFinite(Number(value))) {
    conv.conversionValue = Number(value);
    conv.currencyCode = event.custom_data?.currency || 'BRL';
  }
  if (event.custom_data?.order_id) conv.orderId = String(event.custom_data.order_id);

  // Identificação do clique, em ordem de preferência.
  const u = event.user_data || {};
  if (u.gclid) conv.gclid = u.gclid;
  else if (u.gbraid) conv.gbraid = u.gbraid;
  else if (u.wbraid) conv.wbraid = u.wbraid;

  // Enhanced Conversions: reforço quando não há click id, ou complemento quando há.
  const identifiers = [];
  const em = hashPII(u.email);
  if (em) identifiers.push({ hashedEmail: em });
  const ph = hashPhone(u.phone);
  if (ph) identifiers.push({ hashedPhoneNumber: ph });
  if (identifiers.length) conv.userIdentifiers = identifiers;

  return conv;
}

export async function uploadClickConversion(event, project) {
  const config = project.destinations.google?.config || {};
  const withConsent = applyConsent(event);

  const clientId = String(config.clientId || '').trim();
  const clientSecret = credential(project, 'google', 'client_secret');
  const refreshToken = credential(project, 'google', 'refresh_token');
  const developerToken = credential(project, 'google', 'developer_token');
  const customerId = String(config.customerId || '').replace(/[^0-9]/g, '');
  const loginCustomerId = String(config.loginCustomerId || '').replace(/[^0-9]/g, '');

  // Resource name da conversion action mapeada para este evento, com fallback.
  const conversionAction =
    config.conversionActions?.[withConsent.event_name] || config.conversionActions?.default;

  const faltando = [];
  if (!clientId) faltando.push('client_id');
  if (!clientSecret) faltando.push('client_secret');
  if (!refreshToken) faltando.push('refresh_token');
  if (!developerToken) faltando.push('developer_token');
  if (!customerId) faltando.push('customer_id');
  if (!conversionAction) faltando.push('conversion_action');
  if (faltando.length) {
    return {
      ok: false,
      retriable: false,
      response: { error: `Google Ads não configurado: faltam ${faltando.join(', ')}` },
    };
  }

  let accessToken;
  try {
    accessToken = await getAccessToken({ clientId, clientSecret, refreshToken });
  } catch (err) {
    return { ok: false, retriable: Boolean(err.retriable), response: { error: String(err.message || err) } };
  }

  const url = `https://googleads.googleapis.com/${ADS_API_VERSION}/customers/${customerId}:uploadClickConversions`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        conversions: [buildConversion(withConsent, conversionAction)],
        partialFailure: true,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const json = await res.json().catch(() => ({}));
    // Com partialFailure, a conversão pode falhar mesmo com HTTP 200 — o erro real
    // vem em partialFailureError. Tratar 200 como sucesso aqui esconderia a falha.
    const partialErr = json.partialFailureError;
    const ok = res.ok && !partialErr;

    log(ok ? 'debug' : 'warn', 'google ads upload', {
      status: res.status,
      ok,
      evento: withConsent.event_name,
      erro: partialErr?.message,
    });

    return {
      ok,
      httpStatus: res.status,
      retriable: res.status >= 500 || res.status === 429,
      response: ok
        ? { uploaded: true, results: json.results?.length || 0 }
        : { error: partialErr?.message || json.error?.message || `HTTP ${res.status}`, detalhe: partialErr || json.error },
    };
  } catch (err) {
    return { ok: false, retriable: true, response: { error: String(err?.message || err) } };
  }
}

// Limpa o cache de token — usado ao trocar credenciais no painel.
export function clearTokenCache() {
  tokenCache.clear();
}
