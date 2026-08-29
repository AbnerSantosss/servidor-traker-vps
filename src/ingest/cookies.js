// Cookies first-party — camada 1 da mitigação de ITP.
//
// O Safari (ITP) limita a 7 dias os cookies gravados por JavaScript. Cookies definidos
// pelo servidor via cabeçalho Set-Cookie em resposta de um host first-party não sofrem
// esse corte. Como o nosso endpoint responde no subdomínio do próprio site, podemos
// renovar _fbp/_fbc por HTTP e esticar a validade que o Pixel sozinho não conseguiria.
//
// Detalhe crítico: estes cookies NÃO podem ser HttpOnly — o Pixel da Meta precisa
// lê-los via JavaScript. Marcá-los HttpOnly quebraria o pixel do navegador.
import { env } from '../config/env.js';

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/**
 * Domínio registrável a partir do host, para o cookie valer em todo o site
 * (ex.: traker.codigovencedor.com -> .codigovencedor.com).
 * Heurística simples que cobre os casos reais: dois rótulos finais, ou três quando
 * o penúltimo é um sufixo composto conhecido (com.br, co.uk...).
 */
export function registrableDomain(hostname) {
  const host = String(hostname || '').split(':')[0].toLowerCase();
  if (!host || /^[\d.]+$/.test(host) || host === 'localhost') return null;
  const parts = host.split('.');
  if (parts.length < 2) return null;
  const compound = new Set(['com', 'net', 'org', 'gov', 'edu', 'co', 'ind', 'adv', 'art']);
  const takeThree = parts.length >= 3 && parts.at(-1).length === 2 && compound.has(parts.at(-2));
  return '.' + parts.slice(takeThree ? -3 : -2).join('.');
}

/**
 * Reescreve _fbp/_fbc no navegador com validade longa.
 * Só grava o que já existe (vindo do payload ou do próprio cookie): o servidor nunca
 * inventa um _fbp — fabricar um identificador que o Pixel não conhece degradaria o
 * match em vez de melhorar.
 */
export function refreshFirstPartyCookies(req, res, userData = {}) {
  if (!env.SET_FIRST_PARTY_COOKIES) return;

  const domain = registrableDomain(req.headers.host);
  const maxAge = env.COOKIE_MAX_AGE_DAYS * 24 * 3600;
  const secure = env.PUBLIC_SCHEME === 'https' || req.headers['x-forwarded-proto'] === 'https';
  const existing = parseCookies(req.headers.cookie);

  const values = {
    _fbp: userData.fbp || existing._fbp,
    _fbc: userData.fbc || existing._fbc,
  };

  const headers = [];
  for (const [name, value] of Object.entries(values)) {
    if (!value) continue;
    const parts = [
      `${name}=${encodeURIComponent(value)}`,
      'Path=/',
      `Max-Age=${maxAge}`,
      'SameSite=Lax',
    ];
    if (domain) parts.push(`Domain=${domain}`);
    if (secure) parts.push('Secure');
    // Sem HttpOnly, de propósito: o Pixel precisa ler.
    headers.push(parts.join('; '));
  }

  if (headers.length) res.append('Set-Cookie', headers);
}
