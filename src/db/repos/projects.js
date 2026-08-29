// Repositório de projetos, domínios first-party e destinos.
// Toda leitura devolve um "agregado" hidratado: o projeto já com seus destinos,
// para que ingestão e workers não precisem de segunda query.
import { query, transaction } from '../pool.js';
import { encrypt, decrypt, randomToken, randomSlug } from '../../config/crypto.js';
import crypto from 'node:crypto';

export const DESTINATION_TYPES = ['meta', 'google', 'postback'];

// Eventos canônicos do produto e o mapeamento sugerido por plataforma.
// Pré-preenchidos na criação do projeto para que funcione de fábrica.
export const DEFAULT_META_MAP = {
  page_view: 'PageView',
  view_content: 'ViewContent',
  sign_up: 'CompleteRegistration',
  lead: 'Lead',
  add_to_cart: 'AddToCart',
  begin_checkout: 'InitiateCheckout',
  // PIX gerado = o comprador escolheu como pagar, mas ainda não pagou. AddPaymentInfo
  // é o evento padrão da Meta para esse momento — e deliberadamente NÃO é Purchase.
  pix_gerado: 'AddPaymentInfo',
  // Cartão tentado é o equivalente do PIX gerado no outro meio de pagamento. Os dois
  // são excludentes num mesmo checkout, então mapear ambos não duplica o funil.
  cartao_tentado: 'AddPaymentInfo',
  assinatura_iniciada: 'Subscribe',
  purchase: 'Purchase',
  // Ficam sem mapeamento de propósito:
  //   abandoned_checkout — "AbandonedCheckout" NÃO existe entre os eventos padrão da
  //     Meta. Mapear para lá criaria um evento personalizado com cara de padrão, que
  //     não entra nas otimizações nem nos relatórios agregados. Se o operador quiser
  //     usá-lo, precisa criar uma Conversão Personalizada no Events Manager.
  //   checkout_concluido — só o operador sabe se, no funil dele, "sessão concluída"
  //     merece virar evento na Meta.
};

export const DEFAULT_GA4_MAP = {
  page_view: 'page_view',
  view_content: 'view_item',
  sign_up: 'sign_up',
  lead: 'generate_lead',
  add_to_cart: 'add_to_cart',
  begin_checkout: 'begin_checkout',
  pix_gerado: 'add_payment_info',
  cartao_tentado: 'add_payment_info',
  abandoned_checkout: 'abandoned_checkout',
  assinatura_iniciada: 'purchase',
  purchase: 'purchase',
};

const DEFAULT_POSTBACK_EVENTS = ['purchase', 'sign_up', 'begin_checkout', 'abandoned_checkout', 'page_view'];

function shortProjectId() {
  return `prj_${crypto.randomBytes(6).toString('hex')}`;
}

// Monta o agregado a partir das linhas de projects + destinations.
function hydrate(projectRow, destinationRows = []) {
  if (!projectRow) return null;
  const destinations = {};
  for (const type of DESTINATION_TYPES) {
    const row = destinationRows.find((d) => d.type === type);
    destinations[type] = {
      enabled: row ? row.enabled : false,
      config: row ? row.config || {} : {},
      credentialsEnc: row ? row.credentials_enc || {} : {},
    };
  }
  return {
    id: projectRow.id,
    name: projectRow.name,
    domain: projectRow.domain,
    slug: projectRow.slug,
    status: projectRow.status,
    ingestToken: projectRow.ingest_token,
    allowedOrigins: projectRow.allowed_origins || [],
    createdAt: projectRow.created_at,
    // Marca da empresa (F-V5): data-URI da logo e cor de fallback. Vive no agregado
    // porque é atributo do projeto como nome e domínio — quem hidrata um projeto para
    // desenhar tela já leva a identidade junto, sem segunda query.
    logo: projectRow.logo || null,
    cor: projectRow.cor || null,
    destinations,
    // Configuração de IA (OpenRouter, F5) — colunas próprias em `projects`, não um
    // "destino": não há N tipos para discriminar, é um-para-um com o projeto (ver
    // comentário da migração 008_ia.sql).
    ia: {
      enabled: Boolean(projectRow.ia_habilitada),
      modelo: projectRow.ia_modelo || '',
      keyEnc: projectRow.ia_openrouter_key_enc || '',
    },
  };
}

// Decifra uma credencial específica de um destino do agregado.
export function credential(project, destinationType, key) {
  const enc = project?.destinations?.[destinationType]?.credentialsEnc?.[key];
  return enc ? decrypt(enc) : '';
}

export function hasCredential(project, destinationType, key) {
  return Boolean(project?.destinations?.[destinationType]?.credentialsEnc?.[key]);
}

// ---------------------------------------------------------------- IA (OpenRouter, F5)

export function iaKey(project) {
  return project?.ia?.keyEnc ? decrypt(project.ia.keyEnc) : '';
}

export function hasIaKey(project) {
  return Boolean(project?.ia?.keyEnc);
}

/**
 * Salva a configuração de IA do projeto. Regra de segredo (mesmo contrato de
 * `updateDestination`, mas propositalmente MAIS conservadora): campo `apiKey` AUSENTE
 * OU EM BRANCO mantém a chave atual — nunca apaga. Diferente de `updateDestination`
 * (onde uma string vazia APAGA a credencial), aqui não existe um jeito de "desligar
 * só a chave" pelo formulário: perder a chave por engano ao salvar apenas o modelo
 * derrubaria a estruturação por IA em silêncio (e, no modo por evento, F5/7.4, isso
 * roda sem ninguém olhando). Quem quiser trocar de chave digita uma nova; quem quiser
 * desligar a IA usa `habilitada: false`, que não mexe na chave guardada.
 */
export async function updateIaConfig(projectId, { apiKey, modelo, habilitada } = {}) {
  await transaction(async (client) => {
    const { rows } = await client.query(
      'SELECT ia_openrouter_key_enc, ia_modelo, ia_habilitada FROM projects WHERE id = $1 FOR UPDATE',
      [projectId]
    );
    if (!rows.length) throw Object.assign(new Error('projeto não encontrado'), { statusCode: 404 });
    const atual = rows[0];

    const chaveLimpa = apiKey === undefined ? '' : String(apiKey).trim();
    const novaChaveEnc = chaveLimpa ? encrypt(chaveLimpa) : atual.ia_openrouter_key_enc;
    const novoModelo = modelo === undefined ? atual.ia_modelo : String(modelo).trim();
    const novaHabilitada = habilitada === undefined ? atual.ia_habilitada : Boolean(habilitada);

    await client.query(
      `UPDATE projects
          SET ia_openrouter_key_enc = $2, ia_modelo = $3, ia_habilitada = $4, updated_at = now()
        WHERE id = $1`,
      [projectId, novaChaveEnc, novoModelo, novaHabilitada]
    );
  });
  return getProject(projectId);
}

// Custo acumulado por projeto/mês (7.4) — granularidade mensal por design, ver
// comentário da migração 008_ia.sql.
function anoMesAtual() {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM', UTC
}

export async function registrarUsoIA(projectId, { custoUsd = 0 } = {}) {
  const custo = Number(custoUsd);
  await query(
    `INSERT INTO ia_uso_mensal (project_id, ano_mes, custo_usd, chamadas)
          VALUES ($1, $2, $3, 1)
     ON CONFLICT (project_id, ano_mes) DO UPDATE
          SET custo_usd = ia_uso_mensal.custo_usd + EXCLUDED.custo_usd,
              chamadas = ia_uso_mensal.chamadas + 1,
              atualizado_em = now()`,
    [projectId, anoMesAtual(), Number.isFinite(custo) ? custo : 0]
  );
}

export async function obterUsoIAMesAtual(projectId) {
  const anoMes = anoMesAtual();
  const { rows } = await query(
    'SELECT custo_usd, chamadas FROM ia_uso_mensal WHERE project_id = $1 AND ano_mes = $2',
    [projectId, anoMes]
  );
  return { anoMes, custoUsd: Number(rows[0]?.custo_usd || 0), chamadas: rows[0]?.chamadas || 0 };
}

const SELECT_PROJECT = 'SELECT * FROM projects';

async function hydrateMany(projectRows) {
  if (!projectRows.length) return [];
  const ids = projectRows.map((p) => p.id);
  const { rows: dests } = await query('SELECT * FROM destinations WHERE project_id = ANY($1)', [ids]);
  return projectRows.map((p) => hydrate(p, dests.filter((d) => d.project_id === p.id)));
}

export async function listProjects() {
  const { rows } = await query(`${SELECT_PROJECT} ORDER BY created_at DESC`);
  return hydrateMany(rows);
}

async function loadOne(whereSql, params) {
  const { rows } = await query(`${SELECT_PROJECT} WHERE ${whereSql} LIMIT 1`, params);
  if (!rows.length) return null;
  const { rows: dests } = await query('SELECT * FROM destinations WHERE project_id = $1', [rows[0].id]);
  return hydrate(rows[0], dests);
}

export const getProject = (id) => loadOne('id = $1', [id]);
export const getProjectBySlug = (slug) => loadOne('slug = $1', [String(slug || '').toLowerCase()]);
export const getProjectByDomain = (domain) => loadOne('domain = $1', [String(domain || '').trim().toLowerCase()]);

// Resolve o projeto pelo hostname que recebeu a requisição (multi-tenant por Host header).
export async function getProjectByHostname(hostname) {
  const host = String(hostname || '').split(':')[0].trim().toLowerCase();
  if (!host) return null;
  const { rows } = await query(
    `SELECT p.* FROM projects p
       JOIN project_domains d ON d.project_id = p.id
      WHERE d.hostname = $1
      LIMIT 1`,
    [host]
  );
  if (!rows.length) return null;
  const { rows: dests } = await query('SELECT * FROM destinations WHERE project_id = $1', [rows[0].id]);
  return hydrate(rows[0], dests);
}

export async function createProject({ name, domain }) {
  const cleanDomain = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!cleanDomain) throw Object.assign(new Error('domínio obrigatório'), { statusCode: 400 });

  const existing = await getProjectByDomain(cleanDomain);
  if (existing) throw Object.assign(new Error('domínio já cadastrado'), { statusCode: 409 });

  const id = shortProjectId();
  const project = {
    id,
    name: String(name || '').trim() || cleanDomain,
    domain: cleanDomain,
    slug: randomSlug(8),
    ingestToken: randomToken(),
  };

  await transaction(async (client) => {
    await client.query(
      `INSERT INTO projects (id, name, domain, slug, ingest_token) VALUES ($1,$2,$3,$4,$5)`,
      [project.id, project.name, project.domain, project.slug, project.ingestToken]
    );
    // Destinos criados desligados, já com o mapeamento padrão preenchido.
    await client.query(
      `INSERT INTO destinations (project_id, type, enabled, config) VALUES
         ($1,'meta',false,$2), ($1,'google',false,$3), ($1,'postback',false,$4)`,
      [
        id,
        JSON.stringify({ pixelId: '', testEventCode: '', eventMap: DEFAULT_META_MAP }),
        JSON.stringify({ route: 'ga4_mp', measurementId: '', ga4ClientId: '', clientId: '', customerId: '', loginCustomerId: '', conversionActions: {}, eventMap: DEFAULT_GA4_MAP }),
        JSON.stringify({ url: '', method: 'GET', headers: {}, events: DEFAULT_POSTBACK_EVENTS }),
      ]
    );
  });

  return getProject(id);
}

export async function deleteProject(id) {
  const { rowCount } = await query('DELETE FROM projects WHERE id = $1', [id]);
  return rowCount > 0;
}

export async function setProjectStatus(id, status) {
  await query('UPDATE projects SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  return getProject(id);
}

// Regenera o slug de ingestão (usado quando uma blocklist aprende o caminho antigo).
export async function rotateSlug(id) {
  const slug = randomSlug(8);
  await query('UPDATE projects SET slug = $2, updated_at = now() WHERE id = $1', [id, slug]);
  return getProject(id);
}

// ---------------------------------------------------------------- marca do projeto (F-V5)

// MIMEs aceitos para a logo. É a mesma lista da foto de perfil (validarAvatar em
// users.js) e pelo mesmo motivo: são os três formatos que o `canvas.toBlob` do painel
// sabe produzir.
//
// SVG fica DE FORA de propósito. Um SVG pode conter <script>, e a decisão aqui não é
// "confiar na CSP": é verdade que a logo só é renderizada em <img src="data:...">, um
// contexto onde o navegador não executa script embutido no SVG — mas essa garantia
// depende de todo consumidor futuro continuar usando <img>. Basta alguém, um dia,
// inserir a mesma string com innerHTML (ou servi-la como página) para o mesmo dado
// virar execução de código com a sessão do administrador. Rejeitar na porta de entrada
// custa uma linha e não depende de ninguém lembrar disso depois. Quem tem a marca em
// SVG exporta em PNG — o painel exibe em 24×24, onde vetor não faz diferença.
const LOGO_REGEX = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const LOGO_MAX_BYTES = 200 * 1024;
const COR_REGEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Valida a logo em data-URI. O redimensionamento para 128×128 acontece no navegador
 * (canvas, sem dependência nova), mas o servidor não confia nisso: um cliente adulterado
 * mandaria qualquer coisa. `null`/string vazia é valor VÁLIDO — é como o painel remove a
 * logo e volta ao fallback de iniciais.
 */
export function validarLogoMarca(dataUri) {
  if (dataUri === null || dataUri === undefined || dataUri === '') return null;

  const m = LOGO_REGEX.exec(String(dataUri));
  if (!m) {
    throw Object.assign(
      new Error('a logo precisa ser uma imagem PNG, JPEG ou WEBP em data-URI (data:image/...;base64,...) — SVG não é aceito'),
      { statusCode: 400 }
    );
  }

  // Bytes do binário decodificado, não do texto base64 (~33% maior): o teto é sobre o
  // que de fato vai para a linha do banco.
  const bytes = Buffer.byteLength(m[2], 'base64');
  if (bytes > LOGO_MAX_BYTES) {
    throw Object.assign(
      new Error(`a logo não pode passar de ${LOGO_MAX_BYTES / 1024} KB (recebido ${Math.ceil(bytes / 1024)} KB)`),
      { statusCode: 400 }
    );
  }
  return String(dataUri);
}

/** Valida a cor da marca em hex `#RRGGBB`. Normaliza para maiúsculas. */
export function validarCorMarca(cor) {
  if (cor === null || cor === undefined || cor === '') return null;
  const limpa = String(cor).trim();
  if (!COR_REGEX.test(limpa)) {
    throw Object.assign(new Error('a cor precisa estar no formato hexadecimal #RRGGBB'), { statusCode: 400 });
  }
  return limpa.toUpperCase();
}

/**
 * Marca de todos os projetos, em uma query só. A barra lateral precisa da logo de cada
 * item da lista; sem isto seriam N chamadas para desenhar um menu.
 */
export async function listBrands() {
  const { rows } = await query('SELECT id, name, logo, cor FROM projects ORDER BY created_at DESC');
  return rows.map((r) => ({ id: r.id, name: r.name, logo: r.logo || null, cor: r.cor || null }));
}

export async function getBrand(projectId) {
  const { rows } = await query('SELECT id, name, logo, cor FROM projects WHERE id = $1', [projectId]);
  if (!rows.length) return null;
  return { id: rows[0].id, name: rows[0].name, logo: rows[0].logo || null, cor: rows[0].cor || null };
}

/**
 * Salva a marca do projeto. Cada campo é tri-estado, o mesmo contrato de `updateProfile`
 * (users.js): campo AUSENTE mantém o valor atual; string vazia/null APAGA. Sem os dois
 * estados separados não haveria como remover a logo — um COALESCE no SQL guardaria a
 * imagem antiga para sempre, e "Remover logo" viraria um botão que não faz nada.
 */
export async function updateBrand(projectId, { logo, cor } = {}) {
  const atual = await getBrand(projectId);
  if (!atual) throw Object.assign(new Error('projeto não encontrado'), { statusCode: 404 });

  const novaLogo = logo === undefined ? atual.logo : validarLogoMarca(logo);
  const novaCor = cor === undefined ? atual.cor : validarCorMarca(cor);

  await query('UPDATE projects SET logo = $2, cor = $3, updated_at = now() WHERE id = $1', [
    projectId, novaLogo, novaCor,
  ]);
  return { id: projectId, name: atual.name, logo: novaLogo, cor: novaCor };
}

/**
 * Atualiza um destino. Regra de segredo (contrato com o painel):
 *   - chave AUSENTE em `credentials`  -> mantém o valor cifrado atual
 *   - chave presente com valor vazio  -> apaga a credencial
 *   - chave presente com valor        -> re-cifra
 * Campos não-secretos em `config` são sobrescritos por merge raso.
 */
export async function updateDestination(projectId, type, { enabled, config, credentials } = {}) {
  if (!DESTINATION_TYPES.includes(type)) {
    throw Object.assign(new Error('tipo de destino inválido'), { statusCode: 400 });
  }

  await transaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM destinations WHERE project_id = $1 AND type = $2 FOR UPDATE',
      [projectId, type]
    );
    const current = rows[0] || { enabled: false, config: {}, credentials_enc: {} };

    const nextConfig = { ...(current.config || {}), ...(config || {}) };
    const nextCreds = { ...(current.credentials_enc || {}) };
    for (const [key, value] of Object.entries(credentials || {})) {
      if (value === undefined) continue;
      if (value === null || value === '') delete nextCreds[key];
      else nextCreds[key] = encrypt(String(value).trim());
    }

    await client.query(
      `INSERT INTO destinations (project_id, type, enabled, config, credentials_enc)
            VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (project_id, type) DO UPDATE
            SET enabled = EXCLUDED.enabled,
                config = EXCLUDED.config,
                credentials_enc = EXCLUDED.credentials_enc,
                updated_at = now()`,
      [
        projectId,
        type,
        enabled === undefined ? current.enabled : Boolean(enabled),
        JSON.stringify(nextConfig),
        JSON.stringify(nextCreds),
      ]
    );
  });

  return getProject(projectId);
}

// ---------------------------------------------------------------- domínios first-party

export async function listDomains(projectId) {
  const { rows } = await query(
    'SELECT * FROM project_domains WHERE project_id = $1 ORDER BY is_primary DESC, created_at ASC',
    [projectId]
  );
  return rows;
}

export async function addDomain(projectId, hostname, { pointingMethod = 'a_record', isPrimary = false } = {}) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    throw Object.assign(new Error('hostname inválido'), { statusCode: 400 });
  }
  const { rows } = await query(
    `INSERT INTO project_domains (project_id, hostname, pointing_method, is_primary)
          VALUES ($1,$2,$3,$4)
     ON CONFLICT (hostname) DO NOTHING
       RETURNING *`,
    [projectId, host, pointingMethod, isPrimary]
  );
  if (!rows.length) throw Object.assign(new Error('hostname já cadastrado'), { statusCode: 409 });
  return rows[0];
}

export async function removeDomain(projectId, id) {
  const { rowCount } = await query('DELETE FROM project_domains WHERE project_id = $1 AND id = $2', [projectId, id]);
  return rowCount > 0;
}

export async function setDomainStatus(hostname, status, extra = {}) {
  await query(
    `UPDATE project_domains
        SET verification_status = $2,
            last_checked_at = now(),
            last_error = $3,
            ssl_issued_at = COALESCE($4, ssl_issued_at)
      WHERE hostname = $1`,
    [String(hostname).toLowerCase(), status, extra.error || null, extra.sslIssuedAt || null]
  );
}

/**
 * Gate de emissão de certificado (TLS on-demand do Caddy).
 * Só autoriza hostname já cadastrado e não-falho — sem isso, qualquer pessoa que
 * apontasse um domínio para o nosso IP conseguiria disparar emissões em nosso nome.
 */
export async function isDomainAuthorized(hostname) {
  const host = String(hostname || '').split(':')[0].trim().toLowerCase();
  if (!host) return false;
  const { rows } = await query(
    `SELECT d.verification_status FROM project_domains d
       JOIN projects p ON p.id = d.project_id
      WHERE d.hostname = $1
        AND d.verification_status <> 'failed'
        AND p.status = 'active'
      LIMIT 1`,
    [host]
  );
  return rows.length > 0 ? rows[0].verification_status : false;
}
