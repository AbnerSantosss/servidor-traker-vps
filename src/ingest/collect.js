// Coletor da ponte de identidade.
//
//   POST /c/:slug            (rota curta)
//   POST /collect/:projectId (alias legado)
//
// NÃO envia conversão. Só grava a associação user_id -> {fbc, fbp, fbclid, gclid, ...}
// capturada no navegador, para que a conversão que depois chega pelo backend consiga
// ser enviada com qualidade de match de evento web.
// Ver wiki: arquitetura/Ponte de Identidade.md
import { Router, json, text } from 'express';
import { saveIdentity, MARKETING_KEYS, sanitizeClickIds } from '../db/repos/identities.js';
import { extractClientIp } from './normalize.js';
import { refreshFirstPartyCookies, parseCookies } from './cookies.js';
import { applyCors, resolveProject, parseBody } from './router.js';
import { rateLimit } from './rate-limit.js';
import { log } from '../config/log.js';

export const collectRouter = Router();

// Escopados por rota, não em `use` solto: este router também é montado na raiz, e
// um parser global de 64 KB aqui viraria o teto de corpo de TODA requisição do
// processo — o painel inteiro incluído. Ver a nota equivalente em router.js.
const parsers = [
  json({ limit: '64kb' }),
  text({ type: ['text/plain', 'text/*'], limit: '64kb' }),
];

async function handleCollect(req, res) {
  const project = await resolveProject(req);
  applyCors(req, res, project);

  if (!project || project.status !== 'active') {
    return res.status(404).json({ error: 'projeto não encontrado' });
  }
  if (!rateLimit(`collect:${project.id}`)) {
    return res.status(429).json({ error: 'limite de requisições excedido' });
  }

  const data = parseBody(req);
  const cookies = parseCookies(req.headers.cookie);
  const userKey = data.user_id || data.userId || data.external_id;

  // Sem chave não há o que amarrar. Ainda assim renovamos os cookies e respondemos 202:
  // o coletor roda em toda página, inclusive antes do login, e não é erro.
  if (!userKey) {
    refreshFirstPartyCookies(req, res, { fbp: data.fbp, fbc: data.fbc });
    return res.status(202).json({ status: 'ignored', reason: 'sem user_id' });
  }

  const params = {};
  for (const key of MARKETING_KEYS) {
    if (data[key]) params[key] = String(data[key]);
  }
  // Fallback pelos cookies da própria requisição, caso o JS não tenha conseguido ler.
  params.fbp = params.fbp || cookies._fbp || undefined;
  params.fbc = params.fbc || cookies._fbc || undefined;

  // IP e User-Agent do próprio request: são campos de match e só o servidor os conhece
  // com confiança.
  params.client_ip_address = extractClientIp(req);
  params.client_user_agent = req.headers['user-agent'] || '';
  if (data.landing_page || req.headers.referer) {
    params.landing_page = data.landing_page || req.headers.referer;
  }

  // Camada aberta de identificadores (F9/E9): a tag manda o que capturou da query
  // string por allowlist do PRÓPRIO site (data-click-ids / trkConfig.clickIds); aqui
  // sanitizamos de novo — nunca se confia em filtro feito só do lado do cliente.
  const clickIds = sanitizeClickIds(data.click_ids);

  try {
    await saveIdentity(project.id, userKey, params, clickIds);
    refreshFirstPartyCookies(req, res, params);
    log('debug', 'identidade gravada', {
      project: project.id,
      chaves: Object.keys(params).filter((k) => params[k]).join(','),
      clickIds: Object.keys(clickIds).length,
    });
    return res.status(202).json({ status: 'stored' });
  } catch (err) {
    log('error', 'falha ao gravar identidade', { project: project.id, error: err.message });
    return res.status(500).json({ error: 'falha ao gravar identidade' });
  }
}

async function handleOptions(req, res) {
  applyCors(req, res, await resolveProject(req));
  res.sendStatus(204);
}

collectRouter.options('/c/:slug', handleOptions);
collectRouter.post('/c/:slug', parsers, handleCollect);

collectRouter.options('/collect/:projectId', handleOptions);
collectRouter.post('/collect/:projectId', parsers, handleCollect);
