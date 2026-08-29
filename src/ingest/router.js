// Endpoints públicos de ingestão.
//
//   POST /e/:slug            evento (caminho curto e aleatório por projeto — anti-adblock)
//   POST /ingest/:projectId  alias legado, mantido para compatibilidade
//
// A resposta é imediata (202): a entrega a Meta/Google roda no worker, então uma
// lentidão da API da Meta nunca segura a página do cliente.
import { Router, json, text } from 'express';
import { getProject, getProjectBySlug, getProjectByHostname } from '../db/repos/projects.js';
import { getIdentity, mergeIdentityIntoUserData } from '../db/repos/identities.js';
import { recordEvent } from '../db/repos/events.js';
import { normalizeEvent, extractClientIp, redactForStorage } from './normalize.js';
import { parseCookies, refreshFirstPartyCookies } from './cookies.js';
import { hashEmail, hashName, hashCityState, hashPhone, hashZip, hashCountry, hashDataNascimento, safeEqual } from '../config/crypto.js';
import { applyConsent } from './consent.js';
import { adaptarPayload } from './adaptadores.js';
import { capturarAmostra, carregarAdaptadoresAtivos } from '../db/repos/webhooks.js';
import { hashearPiiParaPrompt } from '../ia/pii.js';
import { log } from '../config/log.js';
import { rateLimit } from './rate-limit.js';

export const ingestRouter = Router();

// sendBeacon manda text/plain para evitar preflight CORS; aceitamos os dois formatos.
//
// Os parsers são escopados aos caminhos DESTE router — e não aplicados com um
// `use()` solto — porque o router é montado na raiz (`app.use(ingestRouter)`).
// Um `use()` sem caminho aqui vale para toda requisição do processo, `/api`
// inclusive: o limite de 256 KB da ingestão passava a ser, silenciosamente, o
// limite do painel também, e um corpo maior morria como 413 genérico dentro do
// parser — antes de chegar à rota que saberia explicar o que estava errado.
//
// Ficam declarados por rota (e não em `use`) porque uma das rotas de ingestão é a
// própria raiz: `use('/')` casaria por prefixo e o problema voltaria inteiro.
const parsers = [
  json({ limit: '256kb' }),
  text({ type: ['text/plain', 'text/*'], limit: '256kb' }),
];

/**
 * Completa o user_data com o que foi capturado no navegador para este user_id.
 * É isto que faz uma conversão vinda do backend (que não conhece fbc/fbp) sair com
 * qualidade de match de evento web.
 *
 * Nunca sobrescreve o que veio no evento, só preenche lacuna. Isso vale inclusive para
 * `client_ip_address` e `client_user_agent`: num webhook a normalização deixa esses
 * campos vazios quando o payload não traz os dados reais do comprador (ver normalize.js),
 * e é justamente essa lacuna que a identidade guardada no navegador preenche aqui.
 */
async function enrichFromIdentity(event, projectId) {
  if (!event.user_id) return event;
  const identity = await getIdentity(projectId, event.user_id);
  if (!identity) return event;

  // A regra de mesclagem mora em identities.js e é usada por aqui e pelos testes — uma
  // cópia dela neste arquivo viraria duas verdades que divergem na primeira correção.
  // Ela cobre tanto os campos de `params` quanto a camada aberta `click_ids`, que fica em
  // coluna própria porque a lista de redes de anúncio cresce com o mercado e não se faz
  // migração a cada uma.
  event.user_data = mergeIdentityIntoUserData(event.user_data, identity);

  event._enrichedFromIdentity = true;
  return event;
}

/**
 * O payload já veio no formato canônico do servidor?
 *
 * `adaptarPayload` devolve `formato: null` em dois casos muito diferentes: quando o corpo
 * já é canônico (nada a traduzir) e quando nenhum adaptador o reconheceu. Só o segundo
 * interessa ao Webhook Studio, e o marcador que separa os dois é o `event_name`/`event`
 * no topo — é a única coisa que o formato canônico exige e que um payload de plataforma
 * de terceiro raramente traz com esse nome exato.
 */
function pareceCanonico(corpo) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return false;
  const nome = corpo.event_name ?? corpo.event;
  return nome !== undefined && nome !== null && String(nome).trim() !== '';
}

/**
 * Validação mínima na borda. Não é schema completo de propósito: o payload é
 * deliberadamente aberto (cada site manda seus próprios custom_data). O que barramos é
 * o que produziria lixo silencioso no banco — corpo vazio virando "custom_event" com
 * UUID aleatório, ou campos gigantes/malformados vindos de tag mal configurada.
 * Devolve a mensagem de erro, ou null quando está tudo bem.
 */
export function validarPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'corpo deve ser um objeto JSON';

  const nome = body.event_name ?? body.event;
  if (nome === undefined || nome === null || String(nome).trim() === '') {
    return 'event_name é obrigatório';
  }
  if (typeof nome !== 'string' && typeof nome !== 'number') return 'event_name deve ser texto';
  if (String(nome).length > 100) return 'event_name muito longo (máximo 100 caracteres)';

  if (body.event_id !== undefined && String(body.event_id).length > 200) {
    return 'event_id muito longo (máximo 200 caracteres)';
  }
  if (body.user_data !== undefined && (typeof body.user_data !== 'object' || Array.isArray(body.user_data))) {
    return 'user_data deve ser um objeto';
  }
  if (body.custom_data !== undefined && (typeof body.custom_data !== 'object' || Array.isArray(body.custom_data))) {
    return 'custom_data deve ser um objeto';
  }
  return null;
}

export function parseBody(req) {
  let data = req.body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = {}; }
  }
  return data && typeof data === 'object' ? data : {};
}

// CORS: reflete a Origin quando o projeto a autoriza. Lista vazia = qualquer origem
// (a tag pode estar em subdomínios variados); o controle real de abuso é o rate limit.
export function applyCors(req, res, project) {
  const origin = req.headers.origin;
  const allowed = project?.allowedOrigins || [];
  if (!origin) return;
  if (!allowed.length || allowed.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '86400');
}

// Resolve o projeto por slug (rota nova) ou por id (rota legada).
export async function resolveProject(req) {
  const { slug, projectId } = req.params;
  if (slug) return getProjectBySlug(slug);
  if (projectId) return getProject(projectId);
  // Sem slug nem id no caminho: identifica o projeto pelo hostname que recebeu a
  // requisição. É o que permite receber webhook numa URL sem path — o caso de
  // plataformas que só aceitam "https://dominio.com" no campo de endpoint.
  //
  // `req.hostname` respeita X-Forwarded-Host quando o Express confia no proxy, que é
  // o valor correto atrás do Caddy; o header Host cru fica como último recurso.
  return getProjectByHostname(req.hostname || req.headers.host);
}

/**
 * Fonte do evento. Um POST com Bearer token do projeto é webhook server-to-server
 * (backend do cliente); sem token é navegador. A distinção importa para action_source
 * e para o diagnóstico no painel.
 */
function detectSource(req, project) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (safeEqual(token, project.ingestToken)) return { source: 'webhook', authenticated: true };
    return { source: 'webhook', authenticated: false };
  }
  return { source: 'web', authenticated: true };
}

async function handleIngest(req, res) {
  const project = await resolveProject(req);
  applyCors(req, res, project);

  if (!project || project.status !== 'active') {
    return res.status(404).json({ error: 'projeto não encontrado ou inativo' });
  }

  const { source, authenticated } = detectSource(req, project);
  if (!authenticated) {
    return res.status(401).json({ error: 'token de ingestão inválido' });
  }

  if (!rateLimit(`ingest:${project.id}`)) {
    return res.status(429).json({ error: 'limite de requisições excedido' });
  }

  // Origin declarada e fora da lista do projeto: recusa de verdade, no servidor.
  // Só o cabeçalho CORS não protege nada — ele instrui o navegador a esconder a
  // resposta, mas a requisição já foi processada.
  const origin = req.headers.origin;
  const permitidas = project.allowedOrigins || [];
  if (origin && permitidas.length && !permitidas.includes(origin)) {
    return res.status(403).json({ error: 'origem não autorizada para este projeto' });
  }

  // Traduz formatos conhecidos de plataforma (ex.: o checkout do Código Vencedor) para
  // o formato canônico. Payload já canônico passa direto. Além dos adaptadores em código,
  // entram aqui os que o operador montou no Webhook Studio — sempre DEPOIS dos hardcoded,
  // para que um mapeamento com detecção ampla demais nunca roube um formato conhecido.
  const corpoOriginal = parseBody(req);
  const adaptadoresDoProjeto = await carregarAdaptadoresAtivos(project.id).catch((err) => {
    log('warn', 'falha ao carregar adaptadores do projeto (seguindo sem eles)', { error: err.message });
    return [];
  });
  const { corpo: adaptado, formato, sombra, iaPorEvento } = adaptarPayload(corpoOriginal, { adaptadoresDoProjeto });

  // Modo "IA por evento": nenhum mapeamento determinístico dá conta deste formato, então
  // o evento é gravado como um registro NEUTRO e a estruturação de verdade acontece no
  // worker (contrato no topo de src/queue/dispatcher.js). Duas decisões aqui:
  //
  //   1. o `event_name` provisório NUNCA pode ser `purchase` — até um modelo rodar,
  //      ninguém confirmou pagamento nenhum, e um registro otimista já contaminaria o
  //      relatório de receita mesmo que a IA depois discordasse;
  //   2. o corpo bruto é guardado com a PII já hasheada. O worker hasheia de novo antes
  //      do prompt (a função é idempotente), mas se o hash acontecesse só lá, o banco
  //      teria e-mail em claro no meio-tempo — e "por pouco tempo" não é uma categoria
  //      que a LGPD reconheça.
  const body = iaPorEvento
    ? {
        event_name: 'aguardando_estruturacao_ia',
        // Reaproveita um id do próprio payload quando existir: é o que mantém a
        // idempotência funcionando se a plataforma de origem reenviar o mesmo webhook.
        event_id: corpoOriginal?.event_id || corpoOriginal?.eventId || corpoOriginal?.id || undefined,
      }
    : adaptado;

  // Payload que ninguém reconheceu vira amostra no Webhook Studio, para o operador poder
  // mapeá-lo depois. É side-effect puro: sem await no caminho da resposta e com o erro
  // engolido de propósito — a ingestão é a função crítica do sistema e não pode falhar
  // por causa de um recurso de conveniência do painel.
  //
  // Três condições, e todas importam:
  //   source === 'webhook'  — evento de navegador vem da nossa própria tag, no formato
  //                           canônico; capturá-lo encheria a tabela com o óbvio.
  //   !formato              — nenhum adaptador reconheceu (nem os do código, nem os do
  //                           projeto). Se algum reconheceu, não há o que mapear.
  //   !pareceCanonico       — `formato: null` também é o que sai quando o payload JÁ é
  //                           canônico e não precisou de tradução. Sem esta checagem, todo
  //                           webhook bem configurado viraria "formato desconhecido".
  //
  // A captura vem ANTES da validação de propósito: payload em formato desconhecido
  // normalmente não tem `event_name` e seria recusado com 400 — e é exatamente esse o
  // caso que o operador precisa ver no painel.
  if (source === 'webhook' && !formato && !pareceCanonico(corpoOriginal)) {
    capturarAmostra({
      projectId: project.id,
      corpo: corpoOriginal,
      formatoDetectado: sombra ? `sombra:${sombra}` : null,
      headers: req.headers,
    }).catch((err) => log('warn', 'falha ao capturar amostra de webhook (ignorada)', { error: err.message }));
  }

  const problema = validarPayload(body);
  if (problema) return res.status(400).json({ error: problema });

  const clientIp = extractClientIp(req);
  const userAgent = req.headers['user-agent'] || '';
  const cookies = parseCookies(req.headers.cookie);

  const event = normalizeEvent(body, { clientIp, userAgent, source, cookies });

  // `normalizeEvent` devolve um formato canônico fechado, então os marcadores do modo IA
  // são anexados aqui — é o objeto `event` que vira `events.payload` e chega ao worker.
  if (iaPorEvento) {
    event.ia_por_evento = true;
    event.ia_adaptador = iaPorEvento;
    event.ia_bruto = hashearPiiParaPrompt(corpoOriginal);
  }
  await enrichFromIdentity(event, project.id);

  // Renova _fbp/_fbc via HTTP antes de responder (mitigação de ITP).
  refreshFirstPartyCookies(req, res, event.user_data);

  const destinationTypes = ['meta', 'google', 'postback'].filter((t) => project.destinations[t]?.enabled);

  // Consentimento aplicado AQUI, uma vez, antes de persistir: o que o banco guarda já é
  // o evento permitido. Aplicar só na montagem de cada destino deixaria PII gravada no
  // log de um evento cujo titular negou consentimento — e cada destino novo precisaria
  // lembrar de repetir a regra.
  const permitido = applyConsent(event);

  // Guarda com PII hasheada — o banco nunca vê e-mail em claro.
  const stored = redactForStorage(permitido, { hashEmail, hashName, hashCityState, hashPhone, hashZip, hashCountry, hashDataNascimento });

  try {
    const result = await recordEvent({ project, event: stored, destinationTypes });

    if (result.duplicate) {
      log('debug', 'evento duplicado ignorado', { project: project.id, event_id: event.event_id });
      return res.status(202).json({ status: 'duplicate', id: result.id, event_id: event.event_id });
    }

    log('info', 'evento aceito', {
      project: project.id,
      event_name: event.event_name,
      event_id: event.event_id,
      source,
      formato: formato || 'canonico',
      destinos: destinationTypes.length,
    });

    return res.status(202).json({
      status: 'accepted',
      id: result.id,
      event_id: event.event_id,
      event_name: event.event_name,
      ...(formato && { formato }),
      destinations: destinationTypes,
    });
  } catch (err) {
    log('error', 'falha ao registrar evento', { project: project.id, error: err.message });
    return res.status(500).json({ error: 'falha ao registrar evento' });
  }
}

async function handleOptions(req, res) {
  applyCors(req, res, await resolveProject(req));
  res.sendStatus(204);
}

ingestRouter.options('/e/:slug', handleOptions);
ingestRouter.post('/e/:slug', parsers, handleIngest);

// Aliases legados (mantêm funcionando integrações já instaladas no GTM).
ingestRouter.options('/ingest/:projectId', handleOptions);
ingestRouter.post('/ingest/:projectId', parsers, handleIngest);

/**
 * Ingestão na raiz, resolvida pelo Host.
 *
 * Existe para plataformas cujo campo de webhook aceita só o domínio, sem caminho —
 * é o caso do backoffice do Código Vencedor, que já tem `https://tkr.codigovencedor.com`
 * cadastrado. Assim, migrar para este servidor não exige editar o endpoint lá: basta
 * apontar o DNS do hostname para cá e cadastrá-lo no projeto.
 *
 * Só responde quando o hostname está registrado em project_domains; caso contrário cai
 * no 404 normal. Fica DEPOIS das rotas com slug, que continuam sendo as recomendadas
 * por não exporem o domínio como identificador único.
 */
ingestRouter.post('/', parsers, handleIngest);
