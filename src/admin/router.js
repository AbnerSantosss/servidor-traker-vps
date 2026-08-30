// API do painel administrativo.
// Contrato mantido compatível com o painel existente (arrays puros, projeto completo
// em toda resposta de escrita, erros em { error }).
import { Router } from 'express';
import {
  listProjects, getProject, createProject, deleteProject, setProjectStatus, rotateSlug,
  updateDestination, listDomains, addDomain, removeDomain, isDomainAuthorized, setDomainStatus,
  updateIaConfig, hasIaKey, iaKey, obterUsoIAMesAtual, registrarUsoIA,
} from '../db/repos/projects.js';
import {
  listEvents, requeueEvent, computeMetrics, computeMatchCoverage, queueHealth,
  computeUtmMetrics, computeAtribuicao, computeFunil, computeDestinos, computeSerieDiaria,
  listFailedDeliveries, countFailuresByDestination,
} from '../db/repos/events.js';
import { countIdentities, forgetUser } from '../db/repos/identities.js';
import { estadoInstalacao } from '../db/repos/instalacao.js';
import { requireAuth, requireAdmin } from './auth.js';
import { publicBaseUrl, env } from '../config/env.js';
import { baseFirstParty } from '../tenancy/first-party.js';
import { log } from '../config/log.js';
import { resolveDns, identidadeDoServidor } from '../tenancy/dns-check.js';
import { clearTokenCache } from '../destinations/google-ads.js';
import { explicarErro, truncarEMascarar } from '../destinations/erros-explicados.js';
import {
  listarAmostrasAgrupadas, excluirAmostra, obterAmostraPorId,
  listarAdaptadores, criarAdaptador, atualizarAdaptador, excluirAdaptador,
} from '../db/repos/webhooks.js';
import { aplicarMapeamento, validarMapeamento, validarDeteccao, detectarComMapeamento, sugerirMapeamento } from '../ingest/mapeamento.js';
import { listarModelos, completar, TIMEOUT_MAPEAMENTO_MS } from '../ia/openrouter.js';
import { PROMPT_MAPEAMENTO_SISTEMA, VERSAO_PROMPT_MAPEAMENTO, montarPromptMapeamentoUsuario } from '../ia/prompts.js';

export const adminRouter = Router();

/**
 * Projeto no formato do painel. Segredos NUNCA saem daqui — apenas flags has*,
 * para a interface saber se já existe algo salvo sem nunca transportar o valor.
 *
 * `comToken` controla o envio do ingestToken (segredo do webhook server-to-server):
 * ele só acompanha a resposta de UM projeto, nunca a listagem — não há motivo para
 * o segredo de todos os projetos trafegar toda vez que a barra lateral recarrega.
 */
function publicProject(p, base = publicBaseUrl()) {
  if (!p) return null;
  const meta = p.destinations.meta;
  const google = p.destinations.google;
  const postback = p.destinations.postback;
  const has = (dest, key) => Boolean(p.destinations[dest]?.credentialsEnc?.[key]);

  return {
    id: p.id,
    name: p.name,
    domain: p.domain,
    slug: p.slug,
    status: p.status,
    createdAt: p.createdAt,
    // O ingestToken NÃO viaja aqui. É o segredo que autentica o webhook do backend do
    // cliente; mandá-lo junto de toda leitura de projeto o espalharia por cache do
    // navegador, histórico de DevTools e qualquer log de intermediário. Quem precisa
    // dele busca sob demanda em GET /projects/:id/ingest-token, que é auditado.
    temIngestToken: Boolean(p.ingestToken),
    // URLs prontas para copiar na tela de instalação, no domínio first-party do
    // projeto quando existe um verificado (ver projetoPublico, logo abaixo).
    urls: {
      base,
      evento: `${base}/e/${p.slug}`,
      coleta: `${base}/c/${p.slug}`,
      scriptColetor: `${base}/s/${p.slug}.js`,
      scriptTag: `${base}/t/${p.slug}.js`,
      // Tag única do GTM (coletor + snippet + page_view) e tag única sem GTM.
      // Precisam sair daqui e não ser deduzidas no painel: o painel só conhece a base
      // da API (o host do serviço), e era justamente essa dedução que colocava o
      // endereço errado no trecho de copiar-e-colar.
      scriptGtm: `${base}/g/${p.slug}.js`,
      scriptUnica: `${base}/w/${p.slug}.js`,
    },
    meta: {
      enabled: meta.enabled,
      pixelId: meta.config.pixelId || '',
      testEventCode: meta.config.testEventCode || '',
      eventMap: meta.config.eventMap || {},
      hasAccessToken: has('meta', 'access_token'),
    },
    google: {
      enabled: google.enabled,
      route: google.config.route || 'ga4_mp',
      measurementId: google.config.measurementId || '',
      ga4ClientId: google.config.ga4ClientId || '',
      clientId: google.config.clientId || '',
      customerId: google.config.customerId || '',
      loginCustomerId: google.config.loginCustomerId || '',
      conversionActions: google.config.conversionActions || {},
      eventMap: google.config.eventMap || {},
      hasApiSecret: has('google', 'api_secret'),
      hasClientSecret: has('google', 'client_secret'),
      hasRefreshToken: has('google', 'refresh_token'),
      hasDeveloperToken: has('google', 'developer_token'),
    },
    postback: {
      enabled: postback.enabled,
      url: postback.config.url || '',
      method: postback.config.method || 'GET',
      headers: postback.config.headers || {},
      events: postback.config.events || [],
      hasBearerToken: has('postback', 'bearer_token'),
    },
    // Configuração de IA (OpenRouter, F5). Só a flag hasIaKey sai daqui — a chave
    // cifrada nunca viaja para o front (I-7), do mesmo jeito que os outros segredos.
    ia: {
      enabled: p.ia.enabled,
      modelo: p.ia.modelo,
      hasIaKey: hasIaKey(p),
    },
  };
}

/**
 * Projeto para o painel com os endereços já no domínio first-party dele.
 *
 * Toda resposta de projeto passa por aqui: os endereços de copiar-e-colar do painel
 * precisam ser os mesmos que o servidor escreve dentro da tag (src/ingest/scripts.js),
 * senão o operador colaria um endereço e o script chamaria outro. Sem domínio verificado,
 * cai no host do serviço, como antes.
 */
const projetoPublico = async (p) => publicProject(p, await baseFirstParty(p?.id));

// Envolve um handler async e converte exceção em resposta { error } com status certo.
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    log('error', 'erro na API do painel', { rota: req.originalUrl, error: err.message, stack: err.stack });
    const status = err.statusCode || 500;
    // Erro esperado (4xx) leva a mensagem ao operador; erro interno não vaza detalhe
    // do driver do banco nem stack para o cliente — isso fica só no log.
    res.status(status).json({ error: status < 500 ? err.message : 'erro interno' });
  }
};

// Carrega o projeto da rota ou responde 404. Devolve null quando já respondeu.
async function loadProject(req, res) {
  const project = await getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'projeto não encontrado' });
    return null;
  }
  return project;
}

// ---------------------------------------------------------------- rota pública (Caddy)

/**
 * Gate de emissão de certificado do TLS on-demand.
 *
 * Fica FORA da autenticação porque quem chama é o Caddy, e nega por padrão. Estar
 * cadastrado no painel não basta: exigimos que o DNS realmente aponte para cá. Do
 * contrário, bastaria alguém convencer um operador a cadastrar um hostname qualquer
 * para disparar emissões em nosso nome — e cada handshake com SNI desconhecido vira
 * uma tentativa, queimando a cota da Let's Encrypt.
 *
 * Domínio ainda `pending` recebe uma verificação de DNS ao vivo: se já resolve para
 * nós, é promovido a `verified` na hora. Isso evita o impasse de precisar clicar em
 * "Verificar DNS" no painel antes de o certificado poder ser emitido.
 */
adminRouter.get('/caddy/ask', wrap(async (req, res) => {
  const domain = String(req.query.domain || '').trim().toLowerCase();
  if (!domain) return res.status(400).send('domínio ausente');

  // O host principal do serviço sempre pode.
  if (domain === String(env.PUBLIC_HOST).split(':')[0].toLowerCase()) return res.status(200).send('ok');

  const situacao = await isDomainAuthorized(domain);
  if (!situacao) {
    log('warn', 'emissão de certificado negada: domínio não cadastrado', { domain });
    return res.status(403).send('domínio não autorizado');
  }

  if (situacao === 'pending') {
    const dns = await resolveDns(domain);
    // Só prova positiva (`ok`) destrava. `inconclusivo` — o domínio resolve para um
    // proxy anycast e a comparação por IP não decide nada — é NEGADO de propósito, e é
    // aqui que este gate difere do painel: o painel só precisa parar de mentir, mas o
    // gate precisa continuar negando por padrão.
    //
    // A tentação seria aceitar por "o handshake TLS com este SNI chegou até nós, logo o
    // domínio aponta para cá". Não aponta: qualquer um abre uma conexão TLS contra o
    // nosso IP com o SNI que quiser. Aceitar transformaria cada handshake forjado numa
    // tentativa de emissão junto à Let's Encrypt — exatamente a cota que este gate
    // existe para proteger.
    //
    // Consequência de onboarding, deliberada: um domínio com o proxy da Cloudflare
    // LIGADO não consegue se provar por DNS. O caminho suportado é criar o CNAME com o
    // proxy desligado ao menos até o domínio ficar `verified` — que é o que o painel
    // instrui no texto do estado inconclusivo.
    if (!dns.ok) {
      log('warn', 'emissão de certificado negada: DNS ainda não aponta para cá', {
        domain, situacao: dns.status, motivo: dns.error,
      });
      return res.status(403).send('DNS não aponta para este servidor');
    }
    await setDomainStatus(domain, 'verified').catch(() => {});
  }

  await setDomainStatus(domain, 'active', { sslIssuedAt: new Date() }).catch(() => {});
  res.status(200).send('ok');
}));

// A partir daqui, tudo exige sessão.
adminRouter.use(requireAuth);

// ---------------------------------------------------------------- projetos

adminRouter.get('/projects', wrap(async (_req, res) => {
  const projects = await listProjects();
  res.json(await Promise.all(projects.map(projetoPublico)));
}));

/**
 * Revela o token de ingestão (segredo do webhook server-to-server).
 * Endpoint próprio, restrito a administradores e registrado em log: o operador só o
 * recebe quando pede explicitamente, e fica rastro de quem pediu. É a diferença entre
 * um segredo que trafega o tempo todo e um segredo que trafega quando é necessário.
 */
adminRouter.get('/projects/:id/ingest-token', requireAdmin, wrap(async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  log('warn', 'token de ingestão revelado', { project: project.id, por: req.user.email });
  res.json({ ingestToken: project.ingestToken });
}));

/**
 * Identidade pública do servidor: o host configurado e os IPs para os quais ele
 * resolve. É o dado que o painel precisa para dizer ao operador, com o número na
 * mão, qual registro A criar no DNS do cliente.
 *
 * `proxy` e `metodoRecomendado` completam a instrução: se o nosso host está atrás de
 * um proxy compartilhado (Cloudflare), o IP que resolvemos é anycast e um registro A
 * com ele NÃO entrega o tráfego aqui — a instrução correta passa a ser o CNAME.
 */
adminRouter.get('/servidor', wrap(async (_req, res) => {
  const identidade = await identidadeDoServidor();
  res.json({
    publicHost: identidade.host,
    scheme: env.PUBLIC_SCHEME,
    baseUrl: publicBaseUrl(),
    ips: identidade.ips,
    proxy: identidade.proxy,
    metodoRecomendado: identidade.metodoRecomendado,
  });
}));

adminRouter.post('/projects', wrap(async (req, res) => {
  const project = await createProject({ name: req.body?.name, domain: req.body?.domain });
  // Cadastra o domínio informado como domínio first-party do projeto, já pendente
  // de verificação — é o começo do fluxo de onboarding de DNS.
  await addDomain(project.id, project.domain, { isPrimary: true }).catch(() => {});
  log('info', 'projeto criado', { project: project.id, domain: project.domain });
  res.status(201).json(await projetoPublico(project));
}));

adminRouter.get('/projects/:id', wrap(async (req, res) => {
  const project = await loadProject(req, res);
  if (project) res.json(await projetoPublico(project));
}));

adminRouter.delete('/projects/:id', wrap(async (req, res) => {
  const ok = await deleteProject(req.params.id);
  if (!ok) return res.status(404).json({ error: 'projeto não encontrado' });
  log('info', 'projeto removido', { project: req.params.id });
  res.json({ ok: true });
}));

adminRouter.put('/projects/:id/status', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  const status = req.body?.status === 'paused' ? 'paused' : 'active';
  res.json(await projetoPublico(await setProjectStatus(req.params.id, status)));
}));

// Regenera o caminho de ingestão (quando uma blocklist aprende o caminho antigo).
adminRouter.post('/projects/:id/rotate-slug', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  const project = await rotateSlug(req.params.id);
  log('info', 'slug de ingestão rotacionado', { project: project.id });
  res.json(await projetoPublico(project));
}));

// ---------------------------------------------------------------- destinos

adminRouter.put('/projects/:id/meta', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  const b = req.body || {};
  const project = await updateDestination(req.params.id, 'meta', {
    enabled: b.enabled,
    config: {
      ...(b.pixelId !== undefined && { pixelId: String(b.pixelId).trim() }),
      ...(b.testEventCode !== undefined && { testEventCode: String(b.testEventCode).trim() }),
      ...(b.eventMap !== undefined && { eventMap: b.eventMap || {} }),
    },
    // Chave ausente = mantém o token atual (contrato do painel).
    credentials: { ...(b.accessToken !== undefined && { access_token: b.accessToken }) },
  });
  res.json(await projetoPublico(project));
}));

adminRouter.put('/projects/:id/google', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  const b = req.body || {};
  const str = (v) => String(v).trim();
  const project = await updateDestination(req.params.id, 'google', {
    enabled: b.enabled,
    config: {
      ...(b.route !== undefined && { route: b.route }),
      ...(b.measurementId !== undefined && { measurementId: str(b.measurementId) }),
      ...(b.ga4ClientId !== undefined && { ga4ClientId: str(b.ga4ClientId) }),
      ...(b.clientId !== undefined && { clientId: str(b.clientId) }),
      ...(b.customerId !== undefined && { customerId: str(b.customerId) }),
      ...(b.loginCustomerId !== undefined && { loginCustomerId: str(b.loginCustomerId) }),
      ...(b.conversionActions !== undefined && { conversionActions: b.conversionActions || {} }),
      ...(b.eventMap !== undefined && { eventMap: b.eventMap || {} }),
    },
    credentials: {
      ...(b.apiSecret !== undefined && { api_secret: b.apiSecret }),
      ...(b.clientSecret !== undefined && { client_secret: b.clientSecret }),
      ...(b.refreshToken !== undefined && { refresh_token: b.refreshToken }),
      ...(b.developerToken !== undefined && { developer_token: b.developerToken }),
    },
  });

  // O access token do Google Ads fica em cache por ~1h. Sem limpar aqui, trocar o
  // refresh token no painel não teria efeito até o cache expirar sozinho — e o
  // operador veria o erro antigo persistir depois de já ter corrigido a credencial.
  if (b.refreshToken || b.clientSecret) clearTokenCache();

  res.json(await projetoPublico(project));
}));

adminRouter.put('/projects/:id/postback', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  const b = req.body || {};
  const project = await updateDestination(req.params.id, 'postback', {
    enabled: b.enabled,
    config: {
      ...(b.url !== undefined && { url: String(b.url).trim() }),
      ...(b.method !== undefined && { method: String(b.method).toUpperCase() === 'POST' ? 'POST' : 'GET' }),
      ...(b.headers !== undefined && { headers: b.headers || {} }),
      ...(b.events !== undefined && { events: Array.isArray(b.events) ? b.events : [] }),
    },
    credentials: { ...(b.bearerToken !== undefined && { bearer_token: b.bearerToken }) },
  });
  res.json(await projetoPublico(project));
}));

// ---------------------------------------------------------------- domínios first-party

adminRouter.get('/projects/:id/domains', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  res.json(await listDomains(req.params.id));
}));

adminRouter.post('/projects/:id/domains', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  const domain = await addDomain(req.params.id, req.body?.hostname, {
    pointingMethod: req.body?.pointingMethod === 'cname' ? 'cname' : 'a_record',
  });
  res.status(201).json(domain);
}));

adminRouter.delete('/projects/:id/domains/:domainId', wrap(async (req, res) => {
  const ok = await removeDomain(req.params.id, Number(req.params.domainId));
  if (!ok) return res.status(404).json({ error: 'domínio não encontrado' });
  res.json({ ok: true });
}));

/**
 * Verifica se o DNS do domínio já aponta para cá. É o passo que destrava a emissão do
 * certificado e o principal ponto de suporte no onboarding.
 */
adminRouter.post('/projects/:id/domains/:domainId/verify', wrap(async (req, res) => {
  const domains = await listDomains(req.params.id);
  const domain = domains.find((d) => d.id === Number(req.params.domainId));
  if (!domain) return res.status(404).json({ error: 'domínio não encontrado' });

  const resultado = await resolveDns(domain.hostname);
  await setDomainStatus(domain.hostname, resultado.ok ? 'verified' : 'pending', { error: resultado.error });
  res.json({ hostname: domain.hostname, ...resultado });
}));

// ---------------------------------------------------------------- eventos e métricas

adminRouter.get('/projects/:id/events', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  res.json(await listEvents(req.params.id, { limit: Number(req.query.limit) || 200 }));
}));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

adminRouter.post('/events/:eventDbId/requeue', wrap(async (req, res) => {
  // Sem esta checagem, um id malformado chega ao Postgres e volta como erro 500 com a
  // mensagem crua do driver — vazando detalhe interno por uma rota trivial.
  if (!UUID_RE.test(req.params.eventDbId)) {
    return res.status(400).json({ error: 'identificador de evento inválido' });
  }
  const n = await requeueEvent(req.params.eventDbId);
  if (!n) return res.status(404).json({ error: 'evento não encontrado ou já entregue' });
  log('info', 'reenvio manual solicitado', { evento: req.params.eventDbId, entregas: n });
  res.json({ ok: true, requeued: n });
}));

// Métricas do dashboard. Além de `totals` (inalterado), a resposta traz `funilDinheiro`
// com os seis indicadores do funil de dinheiro — vendas (contagem e valor), page_views,
// checkouts iniciados, checkouts abandonados (derivado, piso 0), pix gerados (contagem e
// valor) e pix abandonado em R$ (derivado) — mais `pix_metodo`/`pix_com_chave`, que
// dizem COMO o derivado do pix foi calculado. Tudo agregado no banco: contar evento no
// navegador só funciona enquanto o projeto é pequeno.
adminRouter.get('/projects/:id/metrics', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  res.json(await computeMetrics(req.params.id, req.query));
}));

// Origem de tráfego: receita e cobertura de atribuição por utm_source × medium × campaign.
adminRouter.get('/projects/:id/metrics/utm', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  res.json(await computeUtmMetrics(req.params.id, {
    from: req.query.from, to: req.query.to, limit: req.query.limit,
  }));
}));

// Cobertura de clique (fbc/gclid) por dia e a "receita invisível" — compras sem
// nenhum identificador de clique, que chegam à plataforma de anúncio sem atribuição.
adminRouter.get('/projects/:id/metrics/atribuicao', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  res.json(await computeAtribuicao(req.params.id, {
    from: req.query.from, to: req.query.to, event_name: req.query.event_name, limit: req.query.limit,
  }));
}));

// Funil configurável: contagem por etapa e taxa de conversão, numa única varredura.
adminRouter.get('/projects/:id/metrics/funil', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  res.json(await computeFunil(req.params.id, {
    from: req.query.from, to: req.query.to, etapas: req.query.etapas,
  }));
}));

// Saúde de entrega por destino: status por dia, latência média e erros mais frequentes.
adminRouter.get('/projects/:id/metrics/destinos', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  res.json(await computeDestinos(req.params.id, { from: req.query.from, to: req.query.to }));
}));

// Série diária do gráfico principal: eventos por tipo (topN, o resto somado em "outros")
// e receita por dia. Existe para o dashboard não precisar baixar a lista de eventos e
// contar no navegador — o que funciona no volume pequeno e passa a mentir por omissão
// assim que o projeto cresce além do teto da listagem.
// Traz também `coletandoDesde` (data do 1º evento do projeto, fora do período filtrado),
// que o painel usa para dizer "coletando dados desde …" quando a série tem poucos pontos.
adminRouter.get('/projects/:id/metrics/serie', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  res.json(await computeSerieDiaria(req.params.id, {
    from: req.query.from,
    to: req.query.to,
    utm_source: req.query.utm_source,
    event_name: req.query.event_name,
    topN: req.query.top_n,
  }));
}));

// ---------------------------------------------------------------- falhas de entrega explicadas

// Nomes de destino conhecidos — a resposta sempre traz os três, mesmo com contagem 0.
// Sem isso, "zero falhas" devolveria um objeto vazio que o painel teria que tratar como
// caso especial em vez de simplesmente renderizar zeros.
const DESTINOS_CONHECIDOS = ['meta', 'google', 'postback'];

// Ordem que o operador quer ver primeiro: o que está bloqueando entrega (critica), depois
// o que está degradando parcialmente (atencao), por último o informativo.
const PESO_GRAVIDADE = { critica: 0, atencao: 1, informativa: 2 };

// Teto de ids por grupo para o "Reenviar todos" do painel (via requeue existente, que não
// muda). Acima disso o painel precisa AVISAR que só reenviou parte, nunca fingir que
// reenviou tudo — daí o campo `truncado`.
const MAX_IDS_REENVIO = 200;
const MAX_AMOSTRAS_POR_GRUPO = 5;

/**
 * Agrupa entregas falhas por CAUSA (não pelo texto cru do erro) usando o tradutor de
 * src/destinations/erros-explicados.js. O agrupamento mora aqui, não no repositório,
 * porque é aqui que mora o tradutor — o repositório só devolve linhas.
 */
function agruparFalhasPorCausa(entregas) {
  const grupos = new Map();
  const porDestino = Object.fromEntries(DESTINOS_CONHECIDOS.map((d) => [d, 0]));

  for (const entrega of entregas) {
    const explicacao = explicarErro({
      destino: entrega.destination_type,
      status: entrega.status,
      http_status: entrega.http_status,
      last_error: entrega.last_error,
      // O corpo da resposta do destino é o que carrega os detalhes que a mensagem sozinha
      // não tem — no caso da Meta, o `error_subcode` que separa "event_time fora da janela
      // de 7 dias" de "campo mal formatado", ambos com o mesmo error code 100.
      response: entrega.response,
    });

    if (entrega.destination_type in porDestino) porDestino[entrega.destination_type] += 1;

    // A chave do grupo combina a causa com o destino: causas genéricas (rede.timeout,
    // dead, desconhecido) podem acontecer em mais de um destino ao mesmo tempo, e o
    // painel precisa mostrar cada uma separada (o botão "reenviar todos" é por destino).
    const chaveGrupo = `${explicacao.chave}::${entrega.destination_type}`;
    let grupo = grupos.get(chaveGrupo);
    if (!grupo) {
      grupo = {
        chave: explicacao.chave,
        resumo: explicacao.resumo,
        detalhe: explicacao.detalhe,
        acao: explicacao.acao,
        gravidade: explicacao.gravidade,
        catalogado: explicacao.catalogado,
        destino: entrega.destination_type,
        quantidade: 0,
        primeira_em: entrega.updated_at,
        ultima_em: entrega.updated_at,
        event_row_ids: [],
        amostras: [],
      };
      grupos.set(chaveGrupo, grupo);
    }

    grupo.quantidade += 1;
    if (entrega.updated_at < grupo.primeira_em) grupo.primeira_em = entrega.updated_at;
    if (entrega.updated_at > grupo.ultima_em) grupo.ultima_em = entrega.updated_at;
    if (grupo.event_row_ids.length < MAX_IDS_REENVIO) grupo.event_row_ids.push(entrega.event_row_id);
    if (grupo.amostras.length < MAX_AMOSTRAS_POR_GRUPO) {
      // last_error pode carregar fragmento de resposta de um terceiro — nunca sai daqui
      // sem truncar e mascarar (I-7/I-8), mesmo que o resto da entrega seja inofensivo.
      //
      // `response` é descartado de propósito: ele existe para o TRADUTOR de erros ler o
      // error_subcode aqui no servidor, e é o corpo cru devolvido pela plataforma — que
      // pode ecoar trecho do que foi enviado, incluindo credencial. O painel não precisa
      // dele: já recebe a explicação traduzida, que é a informação útil.
      const { response: _naoVaiParaOFront, ...semResposta } = entrega;
      grupo.amostras.push({ ...semResposta, last_error: truncarEMascarar(entrega.last_error) });
    }
  }

  const lista = [...grupos.values()].map((g) => ({
    ...g,
    truncado: g.event_row_ids.length < g.quantidade,
  }));
  lista.sort((a, b) => (PESO_GRAVIDADE[a.gravidade] - PESO_GRAVIDADE[b.gravidade]) || (b.quantidade - a.quantidade));

  return { grupos: lista, total: entregas.length, por_destino: porDestino };
}

adminRouter.get('/projects/:id/deliveries', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  const entregas = await listFailedDeliveries(req.params.id, {
    status: req.query.status,
    destination: req.query.destination,
    from: req.query.from,
    to: req.query.to,
    limit: req.query.limit,
  });
  res.json(agruparFalhasPorCausa(entregas));
}));

// Badge do painel (ex.: "Meta (3)") sem carregar a lista inteira de falhas.
adminRouter.get('/projects/:id/deliveries/resumo', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  const porDestino = await countFailuresByDestination(req.params.id);

  const destinos = {};
  let total24h = 0;
  let total7d = 0;
  for (const d of DESTINOS_CONHECIDOS) {
    const contagem = porDestino[d] || { ultimas_24h: 0, ultimos_7d: 0 };
    destinos[d] = contagem;
    total24h += contagem.ultimas_24h;
    total7d += contagem.ultimos_7d;
  }
  res.json({ destinos, total_24h: total24h, total_7d: total7d });
}));

// Diagnóstico de EMQ: cobertura de cada campo de match nos eventos recentes.
adminRouter.get('/projects/:id/emq', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  const cobertura = await computeMatchCoverage(req.params.id, { days: Number(req.query.days) || 7 });
  res.json({ ...cobertura, identidades: await countIdentities(req.params.id) });
}));

/**
 * Confirmação de instalação: os sinais que provam que o rastreamento está de pé.
 *
 * Rota de LEITURA pura, sem efeito colateral e sem chamar terceiro — a evidência toda
 * já está no banco (ver src/db/repos/instalacao.js para o porquê de cada sinal). Se
 * ela falhar, o painel degrada para "não foi possível checar" e o operador continua
 * com os passos navegáveis; nada da instalação depende dela para funcionar.
 */
adminRouter.get('/projects/:id/instalacao', wrap(async (req, res) => {
  const projeto = await loadProject(req, res);
  if (!projeto) return;
  const sinais = await estadoInstalacao(req.params.id);
  // `test_event_code` preenchido não é sinal — é uma ressalva sobre o que os sinais
  // significam: com ele ativo, a Meta recebe tudo em "Eventos de teste" e NADA entra
  // nos dados da conta. Um operador que vê "Meta confirmou" sem essa nota conclui que
  // a campanha está otimizando, e não está.
  const meta = projeto.destinations?.meta || {};
  res.json({
    sinais,
    ressalvas: {
      meta_em_modo_teste: !!(meta.enabled && meta.config?.testEventCode),
      // O GA4 Measurement Protocol responde 2xx mesmo para payload inválido: "entregue"
      // ali é mais fraco do que na Meta, e quem lê precisa saber disso.
      google_aceita_em_silencio: !!projeto.destinations?.google?.enabled,
    },
  });
}));

// Expurgo por titular (LGPD).
adminRouter.delete('/projects/:id/identities/:userKey', wrap(async (req, res) => {
  const ok = await forgetUser(req.params.id, req.params.userKey);
  res.json({ ok });
}));

// ---------------------------------------------------------------- Webhook Studio (F4)

const ID_NUMERICO_RE = /^\d+$/;

// Amostras de webhooks que nenhum adaptador reconheceu (Inbox de webhooks).
adminRouter.get('/projects/:id/webhooks/amostras', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  res.json(await listarAmostrasAgrupadas(req.params.id, { limit: Number(req.query.limit) || 50 }));
}));

// Descarte manual de uma amostra — operação de limpeza, não de configuração de
// conversão, por isso requireAuth (não requireAdmin) já cobre.
adminRouter.delete('/projects/:id/webhooks/amostras/:amostraId', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  if (!ID_NUMERICO_RE.test(req.params.amostraId)) return res.status(400).json({ error: 'id de amostra inválido' });
  const ok = await excluirAmostra(req.params.id, Number(req.params.amostraId));
  if (!ok) return res.status(404).json({ error: 'amostra não encontrada' });
  res.json({ ok: true });
}));

// Forma pública de um adaptador dinâmico — nada aqui é segredo (mapeamento/detecção
// são configuração, não credencial), então devolve o registro inteiro.
function publicAdaptador(a) {
  if (!a) return null;
  return {
    id: a.id,
    nome: a.nome,
    deteccao: a.deteccao,
    mapeamento: a.mapeamento,
    ativo: a.ativo,
    modo: a.modo,
    criadoVia: a.criado_via,
    createdBy: a.created_by,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

adminRouter.get('/projects/:id/adaptadores', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  res.json((await listarAdaptadores(req.params.id)).map(publicAdaptador));
}));

// Escrita restrita a admin (I-10): mexer no mapeamento muda o significado dos dados de
// conversão — não é ação de operador.
adminRouter.post('/projects/:id/adaptadores', requireAdmin, wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  const b = req.body || {};
  if (!b.nome || !String(b.nome).trim()) return res.status(400).json({ error: 'nome é obrigatório' });

  const vMapeamento = validarMapeamento(b.mapeamento || {});
  const vDeteccao = validarDeteccao(b.deteccao || {});
  const erros = [...vMapeamento.erros, ...vDeteccao.erros];
  if (erros.length) return res.status(400).json({ error: 'adaptador inválido', detalhes: erros });

  const adaptador = await criarAdaptador(req.params.id, {
    nome: b.nome, deteccao: b.deteccao || {}, mapeamento: b.mapeamento || {},
    ativo: b.ativo, modo: b.modo, criadoVia: b.criadoVia, createdBy: req.user.id,
  });
  log('info', 'adaptador dinâmico criado', { project: req.params.id, adaptador: adaptador.id, por: req.user.email });
  res.status(201).json(publicAdaptador(adaptador));
}));

adminRouter.put('/projects/:id/adaptadores/:adaptadorId', requireAdmin, wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  if (!ID_NUMERICO_RE.test(req.params.adaptadorId)) return res.status(400).json({ error: 'id de adaptador inválido' });
  const b = req.body || {};

  const erros = [];
  if (b.mapeamento !== undefined) erros.push(...validarMapeamento(b.mapeamento).erros);
  if (b.deteccao !== undefined) erros.push(...validarDeteccao(b.deteccao).erros);
  if (erros.length) return res.status(400).json({ error: 'adaptador inválido', detalhes: erros });

  const adaptador = await atualizarAdaptador(req.params.id, Number(req.params.adaptadorId), b);
  if (!adaptador) return res.status(404).json({ error: 'adaptador não encontrado' });
  log('info', 'adaptador dinâmico atualizado', { project: req.params.id, adaptador: adaptador.id, por: req.user.email });
  res.json(publicAdaptador(adaptador));
}));

adminRouter.delete('/projects/:id/adaptadores/:adaptadorId', requireAdmin, wrap(async (req, res) => {
  if (!ID_NUMERICO_RE.test(req.params.adaptadorId)) return res.status(400).json({ error: 'id de adaptador inválido' });
  const ok = await excluirAdaptador(req.params.id, Number(req.params.adaptadorId));
  if (!ok) return res.status(404).json({ error: 'adaptador não encontrado' });
  log('info', 'adaptador dinâmico removido', { project: req.params.id, adaptador: req.params.adaptadorId, por: req.user.email });
  res.json({ ok: true });
}));

/**
 * Preview: mostra o evento canônico resultante de um mapeamento contra uma amostra,
 * SEM SALVAR NADA. É o coração da UI de mapeamento — o operador vê o resultado antes
 * de aceitar. `deteccao` é opcional só para informar se a amostra teria sido
 * reconhecida por essa detecção (diagnóstico extra, não obrigatório no contrato).
 */
adminRouter.post('/projects/:id/adaptadores/preview', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  const { mapeamento, amostra, deteccao } = req.body || {};

  const validacao = validarMapeamento(mapeamento || {});
  let evento = null;
  let diagnostico = null;
  let erroExecucao = null;
  if (validacao.valido) {
    try {
      ({ evento, diagnostico } = aplicarMapeamento(amostra || {}, mapeamento || {}));
    } catch (err) {
      erroExecucao = err.message;
    }
  }

  const resposta = { evento, diagnostico, validacao, erroExecucao };
  if (deteccao !== undefined) {
    try { resposta.deteccaoBateu = detectarComMapeamento(amostra || {}, deteccao); }
    catch { resposta.deteccaoBateu = false; }
  }
  res.json(resposta);
}));

/**
 * Mapeamento inicial HEURÍSTICO (sem IA — casamento de nome de campo). Aceita
 * `{ amostraId }` (amostra já capturada, buscada no banco) ou `{ amostra }` (corpo
 * fornecido direto, ex.: colado manualmente pelo operador). Mesma FORMA de resposta
 * que a F5 (assistente via OpenRouter) vai usar — o editor do painel não precisa saber
 * qual dos dois caminhos gerou o rascunho.
 */
adminRouter.post('/projects/:id/adaptadores/sugerir', wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  const { amostraId, amostra } = req.body || {};

  let corpoAmostra = amostra;
  if (!corpoAmostra && amostraId !== undefined) {
    if (!Number.isInteger(amostraId)) return res.status(400).json({ error: 'amostraId inválido' });
    const registro = await obterAmostraPorId(req.params.id, amostraId);
    if (!registro) return res.status(404).json({ error: 'amostra não encontrada' });
    corpoAmostra = registro.body_mascarado;
  }
  if (!corpoAmostra || typeof corpoAmostra !== 'object') {
    return res.status(400).json({ error: 'informe "amostra" (objeto) ou "amostraId" de uma amostra existente' });
  }

  res.json(sugerirMapeamento(corpoAmostra));
}));

// ---------------------------------------------------------------- IA / OpenRouter (F5)
//
// Tudo aqui é requireAdmin (I-10): a chave da OpenRouter é uma credencial de terceiro
// (paga, por chamada) e o resultado da IA muda o significado do dado de conversão —
// nada disso é ação de operador. O navegador NUNCA fala com a OpenRouter (I-7): estes
// três endpoints são o único ponto do painel que chama `src/ia/openrouter.js`.

adminRouter.put('/projects/:id/ia', requireAdmin, wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  const b = req.body || {};
  const project = await updateIaConfig(req.params.id, {
    apiKey: b.apiKey,
    modelo: b.modelo,
    habilitada: b.habilitada,
  });
  // A chave pode ter mudado — uma lista de modelos cacheada da chave ANTERIOR não
  // pode continuar servida como se fosse da chave nova (ou pior, sobreviver depois
  // que a chave foi removida/trocada por uma inválida).
  cacheModelosIA.delete(req.params.id);
  log('info', 'configuração de IA atualizada', { project: req.params.id, por: req.user.email });
  res.json(await projetoPublico(project));
}));

// Botão "Carregar modelos" do painel não pode virar uma chamada à OpenRouter a cada
// clique (custo e latência à toa) — cache curto em memória por projeto.
const CACHE_MODELOS_IA_TTL_MS = 5 * 60 * 1000;
const cacheModelosIA = new Map(); // projectId -> { data, expiraEm }

adminRouter.get('/projects/:id/ia/modelos', requireAdmin, wrap(async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  if (!hasIaKey(project)) {
    return res.status(400).json({ error: 'nenhuma chave da OpenRouter configurada para este projeto — salve uma chave antes de carregar os modelos' });
  }

  const agora = Date.now();
  const emCache = cacheModelosIA.get(req.params.id);
  if (emCache && emCache.expiraEm > agora) return res.json({ modelos: emCache.data, cache: true });

  try {
    const modelos = await listarModelos(iaKey(project));
    cacheModelosIA.set(req.params.id, { data: modelos, expiraEm: agora + CACHE_MODELOS_IA_TTL_MS });
    res.json({ modelos, cache: false });
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
}));

/**
 * Estrutura uma amostra em mapeamento via IA. NUNCA SALVA NADA — devolve o rascunho
 * para o mesmo editor do modo nativo revisar e, só então, salvar pelo
 * `POST /projects/:id/adaptadores` que já existe (Plano-Melhorias-Painel.md, 7.3,
 * passo 5). A validação que roda ao salvar de verdade (validarMapeamento/
 * validarDeteccao) roda AQUI TAMBÉM, sobre o que a IA devolveu: se ela inventar um
 * "purchase" sem confirmação de pagamento, ou qualquer outra coisa inválida, a
 * resposta traz os erros junto com o rascunho — o operador corrige à mão.
 */
adminRouter.post('/projects/:id/ia/mapear', requireAdmin, wrap(async (req, res) => {
  const project = await loadProject(req, res);
  if (!project) return;
  if (!hasIaKey(project)) {
    return res.status(400).json({ error: 'nenhuma chave da OpenRouter configurada para este projeto' });
  }
  if (!project.ia.modelo) {
    return res.status(400).json({ error: 'nenhum modelo selecionado — carregue os modelos e escolha um antes de estruturar' });
  }

  const { amostraId, amostra } = req.body || {};
  let corpoAmostra = amostra;
  if (!corpoAmostra && amostraId !== undefined) {
    if (!Number.isInteger(amostraId)) return res.status(400).json({ error: 'amostraId inválido' });
    const registro = await obterAmostraPorId(req.params.id, amostraId);
    if (!registro) return res.status(404).json({ error: 'amostra não encontrada' });
    corpoAmostra = registro.body_mascarado;
  }
  if (!corpoAmostra || typeof corpoAmostra !== 'object') {
    return res.status(400).json({ error: 'informe "amostra" (objeto) ou "amostraId" de uma amostra existente' });
  }

  let resultadoIA;
  try {
    resultadoIA = await completar(iaKey(project), {
      modelo: project.ia.modelo,
      system: PROMPT_MAPEAMENTO_SISTEMA,
      user: montarPromptMapeamentoUsuario(corpoAmostra),
      jsonEsperado: true,
      timeoutMs: TIMEOUT_MAPEAMENTO_MS,
    });
  } catch (err) {
    return res.status(err.statusCode || 502).json({ error: err.message });
  }

  // A chamada acontece (e é cobrada pela OpenRouter) mesmo quando a IA devolve algo
  // inválido — por isso o custo é registrado sempre que a API informou um valor,
  // independente do resultado da validação abaixo.
  if (resultadoIA.uso?.custoUsd) {
    await registrarUsoIA(req.params.id, { custoUsd: resultadoIA.uso.custoUsd }).catch(() => {});
  }

  const proposta = resultadoIA.json || {};
  const mapeamento = proposta.mapeamento || {};
  const deteccao = proposta.deteccao || {};

  const vMapeamento = validarMapeamento(mapeamento);
  const vDeteccao = validarDeteccao(deteccao);

  let preview = null;
  if (vMapeamento.valido) {
    try { preview = aplicarMapeamento(corpoAmostra, mapeamento).evento; } catch { preview = null; }
  }

  res.json({
    mapeamento,
    deteccao,
    preview,
    validacao: { valido: vMapeamento.valido && vDeteccao.valido, erros: [...vMapeamento.erros, ...vDeteccao.erros] },
    modelo: project.ia.modelo,
    custo: resultadoIA.uso,
    promptVersao: VERSAO_PROMPT_MAPEAMENTO,
  });
}));

// Telemetria de custo (7.4: "custo estimado acumulado no mês exibido na UI").
adminRouter.get('/projects/:id/ia/uso', requireAdmin, wrap(async (req, res) => {
  if (!(await loadProject(req, res))) return;
  res.json(await obterUsoIAMesAtual(req.params.id));
}));

adminRouter.get('/fila', wrap(async (_req, res) => {
  res.json(await queueHealth());
}));
