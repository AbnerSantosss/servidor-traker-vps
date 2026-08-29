// Criptografia, hashing de PII e utilitarios de identificadores.
//
//  - encrypt/decrypt : AES-256-GCM para as credenciais em repouso (access token Meta, api secret GA4,
//                      refresh token Google Ads). O prefixo `v1` marca o FORMATO do valor cifrado,
//                      nao qual chave o cifrou: a rotacao funciona tentando a chave atual e, se a
//                      tag GCM nao fechar, a anterior (APP_SECRET_PREVIOUS). Ver docs/06.
//  - hash*           : normalizacao + SHA-256 exigidos pela Meta CAPI. Normalizar ANTES de hashear
//                      e o erro classico que quebra o match silenciosamente.
//
// Ver wiki: integracoes/Meta Conversions API.md
import crypto from 'node:crypto';
import { env } from './env.js';

const KEY_VERSION = 'v1';
const KEY = crypto.createHash('sha256').update(env.APP_SECRET).digest();

// Durante a rotação de APP_SECRET, a chave anterior continua disponível apenas para
// leitura. Assim a troca é feita sem downtime: tudo que for regravado já sai com a
// chave nova, e o que ainda estiver com a antiga continua legível. Ver docs/06.
const PREVIOUS_KEY = env.APP_SECRET_PREVIOUS
  ? crypto.createHash('sha256').update(env.APP_SECRET_PREVIOUS).digest()
  : null;

export function encrypt(plainText) {
  if (plainText == null || plainText === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [KEY_VERSION, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function tryDecrypt(key, ivB64, tagB64, dataB64) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function decrypt(payload) {
  if (!payload) return '';
  const parts = String(payload).split(':');
  // formato legado (sem versão): iv:tag:data
  const [ivB64, tagB64, dataB64] = parts.length === 4 ? parts.slice(1) : parts;

  try {
    return tryDecrypt(KEY, ivB64, tagB64, dataB64);
  } catch {
    // A tag GCM falha quando a chave está errada — sinal de valor cifrado com a
    // chave anterior. Só então tentamos a antiga.
    if (!PREVIOUS_KEY) return '';
    try {
      return tryDecrypt(PREVIOUS_KEY, ivB64, tagB64, dataB64);
    } catch {
      return '';
    }
  }
}

// ---------- Hashing de PII para a Meta CAPI ----------
// Regras oficiais: trim, lowercase, remover formatacao. Depois SHA-256 em hex minusculo.

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Valor que ja chegou hasheado (64 hex) nao deve ser hasheado de novo.
const jaHasheado = (v) => /^[a-f0-9]{64}$/.test(v);

/**
 * E-mail: trim + lowercase. Pontuacao e legitima aqui (o ponto faz parte do endereco),
 * entao NAO se remove nada alem de espaco nas bordas.
 */
export function hashEmail(value) {
  if (value == null || value === '') return undefined;
  const v = String(value).trim().toLowerCase();
  if (!v) return undefined;
  return jaHasheado(v) ? v : sha256(v);
}

/**
 * Nome e sobrenome: minusculo e SEM PONTUACAO.
 * Regra literal da Meta ("Lowercase only with no punctuation"). Se nao removermos,
 * "D'Angelo" vira hash de `d'angelo` enquanto a Meta calcula o de `dangelo` — os
 * hashes divergem, o match some e NENHUM erro e retornado. E o modo mais silencioso
 * de perder correspondencia que existe.
 * Acentos sao preservados: a doc manda remover pontuacao, nao transliterar.
 */
export function hashName(value) {
  if (value == null || value === '') return undefined;
  let v = String(value).trim().toLowerCase();
  if (jaHasheado(v)) return v;
  v = v.replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  return v ? sha256(v) : undefined;
}

/**
 * Cidade e estado: minusculo, sem pontuacao E SEM ESPACOS.
 * "São Paulo" precisa virar `saopaulo`; mandar `são paulo` nao casa com nada.
 */
export function hashCityState(value) {
  if (value == null || value === '') return undefined;
  let v = String(value).trim().toLowerCase();
  if (jaHasheado(v)) return v;
  v = v.replace(/[^\p{L}\p{N}]/gu, '');
  return v ? sha256(v) : undefined;
}

/**
 * Identificador proprio do cliente. A regra oficial nao e "minusculo": e usar o MESMO
 * formato em todos os canais. Normalizamos para minusculo porque e o que o fbq faz no
 * Advanced Matching do navegador — o que importa e os dois lados aplicarem a mesma
 * transformacao.
 */
export function hashExternalId(value) {
  if (value == null || value === '') return undefined;
  const v = String(value).trim().toLowerCase();
  if (!v) return undefined;
  return jaHasheado(v) ? v : sha256(v);
}

// Mantida por compatibilidade: encaminha para a regra de e-mail (trim + lowercase).
export function hashPII(value, { normalize = true } = {}) {
  if (value == null || value === '') return undefined;
  let v = String(value);
  if (normalize) v = v.trim().toLowerCase();
  if (!v) return undefined;
  return jaHasheado(v) ? v : sha256(v);
}

// Telefone: so digitos, sem zeros a esquerda, com codigo do pais.
// Numero de 10-11 digitos (nacional, sem DDI) recebe o codigo padrao automaticamente —
// erro comum de dataLayer. O padrao e 55 (Brasil); ajuste DEFAULT_COUNTRY_CODE para
// operacao em outro pais, ou defina como vazio para nunca acrescentar nada.
export function hashPhone(value, { defaultCountryCode = env.DEFAULT_COUNTRY_CODE } = {}) {
  if (value == null || value === '') return undefined;
  const raw = String(value).trim();
  if (/^[a-f0-9]{64}$/.test(raw)) return raw;
  let digits = raw.replace(/[^0-9]/g, '').replace(/^0+/, '');
  if (!digits) return undefined;
  // 10 ou 11 digitos = numero nacional brasileiro (DDD + numero) sem o DDI.
  if (defaultCountryCode && (digits.length === 10 || digits.length === 11)) {
    digits = defaultCountryCode + digits;
  }
  return sha256(digits);
}

// CEP: so digitos (Meta usa os 5 primeiros nos EUA; no Brasil mandamos os 8 sem hifen).
export function hashZip(value) {
  if (value == null || value === '') return undefined;
  const v = String(value).trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(v)) return v;
  const digits = v.replace(/[^0-9a-z]/g, '');
  return digits ? sha256(digits) : undefined;
}

// Nomes de pais que aparecem na pratica em formulario brasileiro.
const PAISES = {
  brasil: 'br', brazil: 'br', br: 'br',
  portugal: 'pt', pt: 'pt',
  'estados unidos': 'us', 'united states': 'us', eua: 'us', usa: 'us', us: 'us',
  argentina: 'ar', chile: 'cl', paraguai: 'py', paraguay: 'py',
  uruguai: 'uy', uruguay: 'uy', mexico: 'mx', 'méxico': 'mx',
  espanha: 'es', spain: 'es', 'reino unido': 'gb', 'united kingdom': 'gb',
};

/**
 * Pais: ISO 3166-1 alpha-2 minusculo.
 *
 * Valor desconhecido devolve `undefined` em vez de ser truncado.
 * Truncar era pior do que nao mandar nada: "estados unidos".slice(0,2) produz `es`,
 * que e um codigo VALIDO — o da Espanha. A Meta aceitaria o hash sem reclamar e o
 * match sairia errado, sem nenhum sinal de erro.
 */
export function hashCountry(value) {
  if (value == null || value === '') return undefined;
  const v = String(value).trim().toLowerCase();
  if (jaHasheado(v)) return v;

  const codigo = PAISES[v] || (/^[a-z]{2}$/.test(v) ? v : undefined);
  return codigo ? sha256(codigo) : undefined;
}

/**
 * Data de nascimento no formato YYYYMMDD (regra da Meta).
 * Aceita ISO (`1990-05-17`), brasileiro (`17/05/1990`) e o proprio YYYYMMDD.
 */
export function hashDataNascimento(value) {
  if (value == null || value === '') return undefined;
  const v = String(value).trim();
  if (jaHasheado(v)) return v;

  let iso;
  if (/^\d{8}$/.test(v)) iso = v;
  else if (/^\d{4}-\d{2}-\d{2}/.test(v)) iso = v.slice(0, 10).replace(/-/g, '');
  else {
    const br = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (br) iso = `${br[3]}${br[2]}${br[1]}`;
  }
  return iso ? sha256(iso) : undefined;
}

// Genero: `f` ou `m` minusculo. Qualquer outro valor e omitido em vez de adivinhado.
export function hashGenero(value) {
  if (value == null || value === '') return undefined;
  const v = String(value).trim().toLowerCase();
  if (jaHasheado(v)) return v;
  const mapa = { f: 'f', m: 'm', feminino: 'f', masculino: 'm', female: 'f', male: 'm', mulher: 'f', homem: 'm' };
  const codigo = mapa[v];
  return codigo ? sha256(codigo) : undefined;
}

// ---------- Identificadores ----------

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

// Slug curto e neutro usado no caminho de ingestao (mitigacao de AdBlocker — ver docs/03).
// Alfabeto sem vogais para nao formar palavras acidentais e sem caracteres ambiguos.
export function randomSlug(length = 8) {
  const alphabet = '23456789bcdfghjkmnpqrstvwxyz';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// Hash de senha com scrypt (sem dependencia nativa como bcrypt).
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64);
  return `scrypt:${salt.toString('base64')}:${derived.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, saltB64, hashB64] = String(stored).split(':');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const derived = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
    return crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

// Comparacao de strings resistente a timing attack (tokens de API, sessao).
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export const sha256Hex = sha256;
