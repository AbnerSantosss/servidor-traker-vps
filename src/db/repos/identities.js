// Ponte de identidade: user_id do site -> identificadores de marketing do navegador.
// Ver docs/01-arquitetura.md (Fluxo B) e a wiki: arquitetura/Ponte de Identidade.md
import { query } from '../pool.js';

// Chaves aceitas do coletor. Lista fechada: nada fora daqui é persistido,
// para o coletor não virar um canal aberto de gravação de dado arbitrário.
export const MARKETING_KEYS = [
  'fbc', 'fbp', 'fbclid',
  'gclid', 'gbraid', 'wbraid',
  'ttclid', 'ttp', 'clickid', 'tblci',
  // client_id do GA4: sem ele, a conversão que chega por webhook cai na derivação a
  // partir do user_id e o GA4 a trata como um usuário diferente do que navegou no site.
  'ga_client_id',
  // Identificadores de clique de plataformas "de cauda longa" (F9/E9 — instalação sem
  // GTM). Cada um tem seu próprio parâmetro de URL e sua própria API de conversão, mas
  // para a ponte de identidade são todos iguais: uma string opaca que precisa sobreviver
  // até a conversão chegar pelo backend. Entram na MESMA lista fechada (e na mesma
  // coluna `params`) que fbclid/gclid — não precisam de coluna própria, porque `params`
  // já é JSONB e quem decide o que é aceito é este array, não o schema.
  'msclkid', 'twclid', 'li_fat_id', 'epik', 'sccid', '_scid', 'rdt_cid', 'irclickid', 'obclid', 'kwai_click_id',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'client_ip_address', 'client_user_agent',
  'landing_page', 'referrer',
];

// ---------------------------------------------------------------- camada aberta (click_ids)
//
// Diferente da MARKETING_KEYS (lista fechada, cada chave com significado conhecido e
// mapeada nos destinos), `click_ids` aceita QUALQUER chave — mas nunca a URL inteira.
// O allowlist aqui é sobre a FORMA da chave (padrão típico de parâmetro de clique:
// minúsculas, dígitos, underscore, curto) e sobre o TAMANHO do valor — não é uma
// blocklist de nomes sensíveis. Isso barra o caso óbvio de varredura acidental (uma
// query string com um valor de e-mail/telefone completo como CHAVE não cabe no
// `[a-z0-9_]{1,40}`), mas não impede alguém de configurar deliberadamente uma chave
// chamada "email" — essa responsabilidade é de quem cadastra a lista de chaves aceitas
// no painel (allowlist é opt-in por projeto, não automática a partir da URL inteira).
// Quantidade e tamanho do VALOR são sempre limitados, então mesmo uma chave "inocente"
// não vira um jeito de gravar payloads grandes.
const CLICK_ID_KEY_RE = /^[a-z0-9_]{1,40}$/;
export const CLICK_IDS_MAX_KEYS = 20;
export const CLICK_ID_VALUE_MAX_LEN = 256;
// Teto do objeto inteiro: 20 chaves x (40 + 256) já passaria de 5KB no pior caso.
// Cortamos bem antes disso — o caso real é 1 a 3 identificadores por clique.
const CLICK_IDS_MAX_BYTES = 4096;

/**
 * Sanitiza um objeto candidato a `click_ids` (camada aberta). Roda tanto no lado do
 * coletor (o que o navegador mandou) quanto na normalização de evento (o que veio no
 * payload de ingestão) — a mesma regra vale para as duas entradas, porque as duas são
 * dado não confiável vindo de fora.
 */
export function sanitizeClickIds(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let bytes = 0;
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    if (Object.keys(out).length >= CLICK_IDS_MAX_KEYS) break;
    const key = String(rawKey).toLowerCase();
    if (!CLICK_ID_KEY_RE.test(key)) continue; // fora do padrão de nome: descarta sem aviso
    if (rawValue === undefined || rawValue === null) continue;
    const value = String(rawValue).trim().slice(0, CLICK_ID_VALUE_MAX_LEN);
    if (!value) continue;
    bytes += key.length + value.length;
    if (bytes > CLICK_IDS_MAX_BYTES) break;
    out[key] = value;
  }
  return out;
}

/**
 * Merge da identidade. Regra central: NUNCA sobrescrever um valor bom com vazio.
 * O visitante pode voltar por tráfego direto depois de ter clicado no anúncio —
 * nessa segunda visita o fbclid não existe, e perder o valor antigo destruiria a atribuição.
 * O merge acontece no próprio Postgres (jsonb ||) para ser atômico sob concorrência.
 *
 * `clickIds` (camada aberta, F9/E9) é opcional e vive numa coluna JSONB própria
 * (`click_ids`), separada de `params`: misturar as duas faria a ponte de identidade
 * perder a distinção entre "identificador que conhecemos e mapeamos nos destinos" e
 * "veio de uma query string desconhecida, só existe para o postback". Uma coluna por
 * plataforma nunca foi opção — a lista de redes de anúncio muda mais rápido que
 * qualquer ciclo de migração (ver 007_click_ids.sql).
 */
export async function saveIdentity(projectId, userKey, params, clickIds) {
  if (!userKey) return null;

  const clean = {};
  for (const key of MARKETING_KEYS) {
    const value = params?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      clean[key] = String(value);
    }
  }
  const clickIdsClean = sanitizeClickIds(clickIds);

  if (!Object.keys(clean).length && !Object.keys(clickIdsClean).length) return null;

  const { rows } = await query(
    `INSERT INTO identities (project_id, user_key, params, click_ids)
          VALUES ($1, $2, $3::jsonb, $4::jsonb)
     ON CONFLICT (project_id, user_key) DO UPDATE
          SET params    = identities.params || EXCLUDED.params,
              click_ids = identities.click_ids || EXCLUDED.click_ids,
              last_seen_at = now()
       RETURNING *`,
    [projectId, String(userKey), JSON.stringify(clean), JSON.stringify(clickIdsClean)]
  );
  return rows[0];
}

/**
 * Mescla o que a ponte de identidade guardou para dentro de user_data de um evento —
 * a mesma regra do merge acima (navegador só perde para identidade quando não trouxe
 * nada). Hoje o enriquecimento automático do fluxo de ingestão (src/ingest/router.js,
 * enrichFromIdentity) já faz isso para os campos de `params` genericamente, campo a
 * campo; esta função existe para o `click_ids` (coluna própria, formato de objeto
 * aninhado) e para permitir testar a mesclagem sem depender do servidor HTTP inteiro.
 * click_ids do EVENTO sempre vence sobre o da identidade quando as duas trazem a mesma
 * chave — o clique mais recente (o do próprio evento) é mais confiável que o salvo.
 */
export function mergeIdentityIntoUserData(userData, identity) {
  const u = { ...(userData || {}) };
  const params = identity?.params || {};
  const vazio = (v) => v === undefined || v === null || v === '';

  for (const [key, value] of Object.entries(params)) {
    if (vazio(u[key])) u[key] = value;
  }

  const identityClickIds = identity?.click_ids || {};
  if (Object.keys(identityClickIds).length) {
    u.click_ids = { ...identityClickIds, ...(u.click_ids || {}) };
  }
  return u;
}

export async function getIdentity(projectId, userKey) {
  if (!userKey) return null;
  const { rows } = await query(
    'SELECT * FROM identities WHERE project_id = $1 AND user_key = $2 LIMIT 1',
    [projectId, String(userKey)]
  );
  return rows[0] || null;
}

export async function countIdentities(projectId) {
  const { rows } = await query('SELECT COUNT(*)::int AS total FROM identities WHERE project_id = $1', [projectId]);
  return rows[0]?.total || 0;
}

// Expurgo por titular (LGPD): remove a identidade e os eventos daquele user_id.
export async function forgetUser(projectId, userKey) {
  const { rowCount } = await query('DELETE FROM identities WHERE project_id = $1 AND user_key = $2', [projectId, String(userKey)]);
  await query(`DELETE FROM events WHERE project_id = $1 AND payload->>'user_id' = $2`, [projectId, String(userKey)]);
  return rowCount > 0;
}
