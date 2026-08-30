// Camada de separação entre o painel (front) e a API (back).
//
// O painel é um cliente estático burro: não recebe nada renderizado pelo servidor,
// não guarda segredo e conversa com a API só pelos endpoints documentados. Este módulo
// concentra as regras que garantem isso na prática.
import { env } from '../config/env.js';
import { log } from '../config/log.js';

// Cabeçalho que o painel envia em toda chamada de escrita. Não é um token secreto —
// é um marcador que um formulário HTML de outro site NÃO consegue forjar (só XHR/fetch
// com CORS aprovado consegue), e por isso barra CSRF quando o cookie precisa ser
// SameSite=None (front hospedado em outra origem).
export const CABECALHO_PAINEL = 'x-traker-painel';

/**
 * Nenhuma resposta da API pode ser guardada em cache.
 * Sem isto, a resposta de um endpoint com dado sensível pode ficar no cache de disco do
 * navegador ou de um intermediário e sobreviver ao logout.
 */
export function semCache(_req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  next();
}

/**
 * CORS do painel. Só entra em cena quando o front é servido de OUTRA origem
 * (PANEL_ORIGIN definido) — no modo padrão, front e API compartilham o mesmo host e
 * nenhum cabeçalho de CORS é necessário.
 *
 * Diferente do CORS da ingestão, aqui a lista é fechada: eventos vêm de qualquer site
 * de cliente, mas o painel vem de um lugar só.
 */
export function corsDoPainel(req, res, next) {
  const origensPermitidas = env.PANEL_ORIGINS;
  if (!origensPermitidas.length) return next();

  const origin = req.headers.origin;
  if (origin && origensPermitidas.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', `Content-Type, ${CABECALHO_PAINEL}`);
    res.set('Access-Control-Max-Age', '600');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

/**
 * O painel roda em outra ORIGEM, mas no mesmo SITE?
 *
 * Isto decide o `SameSite` do cookie de sessão, e a distinção importa porque `SameSite`
 * é avaliado por *site* (domínio registrável), não por origem. `app.zyraflow.site` e
 * `zyraflow.site` são origens diferentes — logo precisam de CORS — e o mesmo site — logo
 * o cookie pode continuar `Lax`, preservando a defesa nativa contra CSRF de sites
 * externos em vez de cair para `None`.
 *
 * A regra é deliberadamente conservadora: só considera mesmo site quando um host é igual
 * ao outro ou é subdomínio dele. Decidir "mesmo domínio registrável" no caso geral exige
 * a Public Suffix List (sem ela, `a.com.br` e `b.com.br` pareceriam o mesmo site, o que
 * seria um `Lax` indevido e uma brecha). Quando a regra não reconhece, cai para `None` —
 * que funciona igual, só sem o ganho do `Lax`. Errar para o lado seguro aqui significa,
 * no pior caso, abrir mão de uma defesa extra; errar para o outro lado quebraria o login.
 */
export function painelEhSameSite() {
  if (!env.PANEL_ORIGINS.length) return true; // mesma origem: nem se aplica

  const hostDaApi = semPorta(env.PUBLIC_HOST);
  if (!hostDaApi) return false;

  // TODAS as origens do painel precisam ser same-site. Basta uma cross-site para que o
  // cookie `Lax` não chegue nela — e um login que funciona em um host e falha em outro é
  // pior de diagnosticar que um que nunca funciona.
  return env.PANEL_ORIGINS.every((origem) => {
    let host;
    try { host = semPorta(new URL(origem).hostname); } catch { return false; }
    if (!host) return false;
    return host === hostDaApi
      || host.endsWith('.' + hostDaApi)
      || hostDaApi.endsWith('.' + host);
  });
}

function semPorta(host) {
  return String(host || '').toLowerCase().split(':')[0].replace(/\.$/, '');
}

/**
 * Proteção contra CSRF nas rotas de escrita.
 *
 * Com o front na mesma origem, o cookie é SameSite=Lax e o navegador já bloqueia envio
 * cross-site — a checagem aqui é redundante e não é aplicada. Quando o front está em
 * outra origem, o cookie precisa ser SameSite=None e essa proteção some; então passamos
 * a exigir um cabeçalho que só código nosso, com CORS aprovado, consegue mandar.
 */
export function exigirOrigemDoPainel(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!env.PANEL_ORIGINS.length) return next();

  const origin = req.headers.origin;
  const marcador = req.headers[CABECALHO_PAINEL];

  if (origin && !env.PANEL_ORIGINS.includes(origin)) {
    log('warn', 'escrita bloqueada: origem não autorizada', { origin, rota: req.originalUrl });
    return res.status(403).json({ error: 'origem não autorizada' });
  }
  if (!marcador) {
    return res.status(403).json({ error: 'requisição sem identificação do painel' });
  }
  next();
}

/**
 * Cabeçalhos de segurança das páginas do painel.
 *
 * A CSP é o que impede um XSS de virar exfiltração: mesmo que alguém consiga injetar
 * script, ele não pode carregar código de fora nem mandar dado para outro servidor.
 *
 * `script-src 'self'` só funciona porque não há JavaScript inline nas páginas — todo
 * script vive em arquivo próprio. Manter assim é requisito, não estilo.
 */
export function cabecalhosDePagina(_req, res, next) {
  const destinos = ["'self'", ...env.PANEL_ORIGINS].join(' ');

  // As páginas HTML sempre revalidam. Uma página velha em cache referenciando script
  // que não existe mais (ou script inline, que a CSP bloqueia) é indistinguível de
  // "o sistema parou de funcionar" para quem está usando.
  res.set('Cache-Control', 'no-cache');

  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    // Atributos style= são usados à vontade na marcação; injeção de estilo é um risco
    // muito menor que injeção de script, então 'unsafe-inline' fica só aqui.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${destinos}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '));

  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
  next();
}
