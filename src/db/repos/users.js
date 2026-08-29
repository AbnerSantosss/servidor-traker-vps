// Usuários do painel e sessões.
// A sessão é um token opaco enviado em cookie HttpOnly; o banco guarda apenas o SHA-256
// dele, de modo que um dump do banco não permite sequestrar sessões ativas.
import { query } from '../pool.js';
import { hashPassword, verifyPassword, randomToken, sha256Hex } from '../../config/crypto.js';
import { env } from '../../config/env.js';

export const PAPEIS = ['admin', 'operador'];

const normalizarEmail = (email) => String(email || '').trim().toLowerCase();

export async function createUser({ email, password, name, role = 'admin' }) {
  const cleanEmail = normalizarEmail(email);
  if (!cleanEmail) throw Object.assign(new Error('e-mail obrigatório'), { statusCode: 400 });
  if (!password || String(password).length < 8) {
    throw Object.assign(new Error('senha deve ter ao menos 8 caracteres'), { statusCode: 400 });
  }
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, name, role)
          VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name
       RETURNING id, email, name, role, created_at`,
    [cleanEmail, hashPassword(password), name || null, role]
  );
  return rows[0];
}

/**
 * Cria um usuário convidado, SEM senha. Ele só passa a conseguir entrar depois de
 * aceitar o convite e definir a própria senha — nenhuma senha provisória trafega
 * por e-mail.
 */
export async function inviteUser({ email, name, role = 'operador', createdBy = null }) {
  const cleanEmail = normalizarEmail(email);
  if (!cleanEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
    throw Object.assign(new Error('e-mail inválido'), { statusCode: 400 });
  }
  if (!PAPEIS.includes(role)) {
    throw Object.assign(new Error(`papel deve ser ${PAPEIS.join(' ou ')}`), { statusCode: 400 });
  }

  const existente = await getUserByEmail(cleanEmail);
  if (existente) throw Object.assign(new Error('já existe um usuário com esse e-mail'), { statusCode: 409 });

  const { rows } = await query(
    `INSERT INTO users (email, name, role, created_by)
          VALUES ($1,$2,$3,$4)
       RETURNING id, email, name, role, created_at, last_login_at`,
    [cleanEmail, String(name || '').trim() || null, role, createdBy]
  );
  return rows[0];
}

export async function getUserByEmail(email) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [normalizarEmail(email)]);
  return rows[0] || null;
}

export async function getUserById(id) {
  const { rows } = await query(
    `SELECT id, email, name, first_name, last_name, avatar, role, created_at, last_login_at, password_hash
       FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Lista os usuários para o painel. `status` distingue quem já definiu senha de quem
 * ainda tem convite pendente — sem isso o admin não sabe se precisa reenviar.
 */
export async function listUsers() {
  const { rows } = await query(
    `SELECT id, email, name, role, created_at, last_login_at,
            CASE WHEN password_hash IS NULL THEN 'convite_pendente' ELSE 'ativo' END AS status
       FROM users
      ORDER BY created_at ASC`
  );
  return rows;
}

export async function countAdmins() {
  const { rows } = await query(`SELECT COUNT(*)::int AS total FROM users WHERE role = 'admin'`);
  return rows[0]?.total || 0;
}

export async function updateUser(id, { name, role }) {
  if (role !== undefined && !PAPEIS.includes(role)) {
    throw Object.assign(new Error(`papel deve ser ${PAPEIS.join(' ou ')}`), { statusCode: 400 });
  }

  // Rebaixar o último admin deixaria o sistema sem ninguém capaz de gerenciar usuários
  // ou credenciais — e só daria para consertar por SQL na mão.
  if (role === 'operador') {
    const alvo = await getUserById(id);
    if (alvo?.role === 'admin' && (await countAdmins()) <= 1) {
      throw Object.assign(new Error('não é possível rebaixar o último administrador'), { statusCode: 400 });
    }
  }

  const { rows } = await query(
    `UPDATE users
        SET name = COALESCE($2, name),
            role = COALESCE($3, role)
      WHERE id = $1
      RETURNING id, email, name, role, created_at, last_login_at`,
    [id, name === undefined ? null : String(name).trim() || null, role === undefined ? null : role]
  );
  if (!rows.length) throw Object.assign(new Error('usuário não encontrado'), { statusCode: 404 });
  return rows[0];
}

// ---------------------------------------------------------------- perfil pessoal

// data:image/(png|jpeg|webp);base64,... — os três formatos que o redimensionamento
// client-side (canvas) do painel pode produzir. Qualquer outro MIME (svg, gif animado
// etc.) é rejeitado: um SVG em data-URI pode carregar <script>, e a CSP do painel
// (img-src 'self' data:) não distingue "imagem" de "SVG com payload".
const AVATAR_REGEX = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const AVATAR_MAX_BYTES = 128 * 1024;

/**
 * Valida um avatar em data-URI. O redimensionamento para 256×256 acontece no navegador
 * (canvas, sem dependência nova), mas o servidor não pode confiar nisso: um cliente
 * adulterado poderia mandar qualquer coisa. `null`/string vazia é um valor válido — é
 * como o painel remove a foto atual.
 */
export function validarAvatar(dataUri) {
  if (dataUri === null || dataUri === undefined || dataUri === '') return null;

  const m = AVATAR_REGEX.exec(String(dataUri));
  if (!m) {
    throw Object.assign(
      new Error('avatar precisa ser uma imagem PNG, JPEG ou WEBP em data-URI (data:image/...;base64,...)'),
      { statusCode: 400 }
    );
  }

  // Bytes do binário decodificado, não do texto base64 (que é ~33% maior) — o limite é
  // sobre o que efetivamente vai para o banco, não sobre o tamanho da string recebida.
  const bytes = Buffer.byteLength(m[2], 'base64');
  if (bytes > AVATAR_MAX_BYTES) {
    throw Object.assign(
      new Error(`avatar não pode passar de ${AVATAR_MAX_BYTES / 1024} KB (recebido ${Math.ceil(bytes / 1024)} KB)`),
      { statusCode: 400 }
    );
  }
  return dataUri;
}

/**
 * Salva nome/sobrenome/avatar do próprio usuário e deriva `name` = first_name + last_name.
 * `name` continua sendo a coluna que todo código antigo lê (convite, e-mails, listagem) —
 * I-3 do painel: nada que já existia pode quebrar por causa desta tela nova.
 *
 * Cada campo é tratado como tri-estado (omitido = mantém; string vazia = limpa; valor =
 * grava) em vez de COALESCE no SQL, porque COALESCE nunca deixaria o usuário APAGAR o
 * sobrenome ou a foto — uma string vazia viraria NULL e o COALESCE manteria o valor
 * antigo para sempre.
 */
export async function updateProfile(id, { firstName, lastName, avatar } = {}) {
  const atual = await getUserById(id);
  if (!atual) throw Object.assign(new Error('usuário não encontrado'), { statusCode: 404 });

  const novoFirst = firstName === undefined ? atual.first_name : (String(firstName || '').trim().slice(0, 120) || null);
  const novoLast = lastName === undefined ? atual.last_name : (String(lastName || '').trim().slice(0, 120) || null);
  const novoAvatar = avatar === undefined ? atual.avatar : validarAvatar(avatar);
  const nomeCompleto = [novoFirst, novoLast].filter(Boolean).join(' ').trim() || atual.name;

  const { rows } = await query(
    `UPDATE users
        SET first_name = $2, last_name = $3, avatar = $4, name = $5
      WHERE id = $1
      RETURNING id, email, name, first_name, last_name, avatar, role, created_at, last_login_at`,
    [id, novoFirst, novoLast, novoAvatar, nomeCompleto]
  );
  return rows[0];
}

export async function deleteUser(id, { solicitanteId } = {}) {
  if (String(id) === String(solicitanteId)) {
    throw Object.assign(new Error('você não pode remover a própria conta'), { statusCode: 400 });
  }
  const alvo = await getUserById(id);
  if (!alvo) throw Object.assign(new Error('usuário não encontrado'), { statusCode: 404 });
  if (alvo.role === 'admin' && (await countAdmins()) <= 1) {
    throw Object.assign(new Error('não é possível remover o último administrador'), { statusCode: 400 });
  }
  await query('DELETE FROM users WHERE id = $1', [id]);
  return true;
}

export async function setPassword(userId, password) {
  if (!password || String(password).length < 8) {
    throw Object.assign(new Error('senha deve ter ao menos 8 caracteres'), { statusCode: 400 });
  }
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hashPassword(password)]);
  // Trocar a senha derruba as demais sessões: se a troca foi por suspeita de invasão,
  // manter a sessão do invasor aberta anularia o efeito.
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

// ---------------------------------------------------------------- tokens de e-mail

/**
 * Gera um token de uso único para convite ou redefinição.
 * Só o hash vai para o banco; o valor em claro existe apenas dentro do link do e-mail.
 * Tokens anteriores do mesmo propósito são invalidados — reenviar convite não pode
 * deixar dois links válidos circulando.
 */
export async function createUserToken(userId, purpose, { createdBy = null, ttlHours } = {}) {
  const horas = ttlHours ?? (purpose === 'convite' ? env.CONVITE_TTL_HORAS : env.RESET_TTL_HORAS);
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + horas * 3600_000);

  await query('DELETE FROM user_tokens WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL', [userId, purpose]);
  await query(
    'INSERT INTO user_tokens (token_hash, user_id, purpose, expires_at, created_by) VALUES ($1,$2,$3,$4,$5)',
    [sha256Hex(token), userId, purpose, expiresAt, createdBy]
  );
  return { token, expiresAt, horas };
}

export async function getUserToken(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT t.*, u.email, u.name, u.role
       FROM user_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()
      LIMIT 1`,
    [sha256Hex(token)]
  );
  return rows[0] || null;
}

export async function consumeUserToken(token) {
  await query('UPDATE user_tokens SET used_at = now() WHERE token_hash = $1', [sha256Hex(token)]);
}

export async function purgeExpiredTokens() {
  const { rowCount } = await query('DELETE FROM user_tokens WHERE expires_at < now()');
  return rowCount;
}

export async function countUsers() {
  const { rows } = await query('SELECT COUNT(*)::int AS total FROM users');
  return rows[0]?.total || 0;
}

export async function authenticate(email, password) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [String(email || '').trim().toLowerCase()]);
  const user = rows[0];
  // Mesmo sem usuário, gastamos o tempo de verificação para não vazar por timing
  // quais e-mails existem.
  const ok = user
    ? verifyPassword(password, user.password_hash)
    : verifyPassword(password, hashPassword('senha-inexistente-para-timing'));
  if (!user || !ok) return null;
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

/**
 * Cria a sessão. `ttlHours` permite estender a validade quando o usuário marca
 * "manter conectado" no login — a decisão é do servidor, não do navegador: o valor
 * enviado pelo cliente é apenas um booleano, e é aqui que ele vira prazo.
 * O teto de 30 dias existe para que um bug (ou um cliente adulterado) não consiga
 * fabricar uma sessão eterna.
 */
export const REMEMBER_TTL_HORAS = 720; // 30 dias

export async function createSession(userId, { userAgent, ip, ttlHours } = {}) {
  const token = randomToken(32);
  const horas = Math.min(Number(ttlHours) || env.SESSION_TTL_HOURS, REMEMBER_TTL_HORAS);
  const expiresAt = new Date(Date.now() + horas * 3600_000);
  await query(
    'INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5)',
    [sha256Hex(token), userId, expiresAt, String(userAgent || '').slice(0, 300), ip || null]
  );
  return { token, expiresAt };
}

export async function getSessionUser(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
      LIMIT 1`,
    [sha256Hex(token)]
  );
  return rows[0] || null;
}

export async function destroySession(token) {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token_hash = $1', [sha256Hex(token)]);
}

export async function purgeExpiredSessions() {
  const { rowCount } = await query('DELETE FROM sessions WHERE expires_at < now()');
  return rowCount;
}
