// Postback genérico: repassa o evento para um endpoint HTTP do cliente (CRM, planilha,
// n8n, plataforma de afiliados). Serve de escape hatch para destinos que ainda não têm
// integração dedicada.
import { credential } from '../db/repos/projects.js';
import { applyConsent } from '../ingest/consent.js';
import { log } from '../config/log.js';

// Substitui {{campo}} na URL/headers por valores do evento — permite postbacks no
// formato exigido por plataformas de afiliado (ex.: .../conv?click_id={{clickid}}).
//
// Os identificadores explícitos novos (msclkid, twclid, li_fat_id, epik, sccid, _scid,
// rdt_cid, irclickid, obclid, kwai_click_id — F9/E9) já chegam achatados dentro de
// `event.user_data` (normalize.js), então viram macro pelo MESMO mecanismo genérico de
// baixo — nenhuma linha nova precisa saber o nome de cada um.
// A camada ABERTA é diferente: vive aninhada em `user_data.click_ids` (objeto), então
// precisa de um alias (`click_id`, no singular) para o `path.split('.')` conseguir
// descer um nível — é o que habilita a macro `{{click_id.nome}}` da seção 16.4 do plano.
export function interpolate(template, event) {
  const contexto = {
    ...event,
    ...event.user_data,
    ...event.custom_data,
    click_id: event.user_data?.click_ids || {},
  };
  return String(template || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const value = path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), contexto);
    return value === undefined || value === null ? '' : encodeURIComponent(String(value));
  });
}

export async function sendPostback(rawEvent, project) {
  const config = project.destinations.postback?.config || {};
  const url = String(config.url || '').trim();

  // O postback não é plataforma de anúncio, mas continua sendo transferência de dado
  // pessoal para um terceiro: as mesmas regras de consentimento valem.
  const event = applyConsent(rawEvent);

  if (!url) {
    return { ok: false, retriable: false, response: { error: 'postback sem URL configurada' } };
  }

  // Filtro por evento: lista vazia significa "todos".
  const eventos = Array.isArray(config.events) ? config.events : [];
  if (eventos.length && !eventos.includes(event.event_name)) {
    return { skipped: true, reason: 'skipped_unmapped', response: { error: `evento ${event.event_name} fora do filtro do postback` } };
  }

  const method = String(config.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const finalUrl = interpolate(url, event);

  const headers = { 'User-Agent': 'ServidorTraker/1.0' };
  for (const [key, value] of Object.entries(config.headers || {})) {
    headers[key] = interpolate(value, event);
  }
  // Token opcional guardado cifrado, para não expor segredo no campo de headers do painel.
  const bearer = credential(project, 'postback', 'bearer_token');
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  try {
    const options = { method, headers, signal: AbortSignal.timeout(15_000) };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify({
        event_name: event.event_name,
        event_id: event.event_id,
        event_time: event.event_time,
        user_id: event.user_id,
        user_data: event.user_data,
        custom_data: event.custom_data,
      });
    }

    const res = await fetch(finalUrl, options);
    const body = await res.text().catch(() => '');
    log(res.ok ? 'debug' : 'warn', 'postback', { status: res.status, evento: event.event_name });

    return {
      ok: res.ok,
      httpStatus: res.status,
      retriable: res.status >= 500 || res.status === 429,
      response: res.ok ? { status: res.status, body: body.slice(0, 200) } : { error: `HTTP ${res.status}`, body: body.slice(0, 500) },
    };
  } catch (err) {
    return { ok: false, retriable: true, response: { error: String(err?.message || err) } };
  }
}
