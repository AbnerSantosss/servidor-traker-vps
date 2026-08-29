// Gestão de usuários do painel: convite por e-mail, papéis, reenvio e remoção.
//
// Modelo de convite (e não de "criar com senha provisória"): o admin cadastra o e-mail,
// o convidado recebe um link de uso único e define a própria senha. Nenhuma senha
// trafega por e-mail em momento algum.
import { Router } from 'express';
import {
  listUsers, inviteUser, updateUser, deleteUser, getUserById, updateProfile,
  createUserToken, PAPEIS,
} from '../db/repos/users.js';
import { requireAuth, requireAdmin } from './auth.js';
import { enviarEmail, emailConfigurado } from '../config/mailer.js';
import { emailConvite, emailNovoUsuarioParaAdmin, emailRedefinirSenha } from '../emails/templates.js';
import { publicBaseUrl } from '../config/env.js';
import { log } from '../config/log.js';

export const usuariosRouter = Router();

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) log('error', 'erro na gestão de usuários', { rota: req.originalUrl, error: err.message });
    res.status(status).json({ error: status < 500 ? err.message : 'erro interno' });
  }
};

// A seção inteira exige sessão; só as rotas de administração (mais abaixo) também
// exigem papel admin. As rotas de perfil pessoal (/me) são do próprio usuário logado,
// qualquer papel — é por isso que requireAdmin não pode mais ficar no `use()` do topo
// como estava antes desta fase.
usuariosRouter.use(requireAuth);

const publico = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  status: u.status || (u.password_hash ? 'ativo' : 'convite_pendente'),
  created_at: u.created_at,
  last_login_at: u.last_login_at,
});

/** Forma pública do PERFIL do próprio usuário — inclui foto e nome/sobrenome. */
const perfilPublico = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  firstName: u.first_name,
  lastName: u.last_name,
  avatar: u.avatar,
  role: u.role,
  createdAt: u.created_at,
  lastLoginAt: u.last_login_at,
});

// ---------------------------------------------------------------- perfil pessoal (/me)
//
// Precisa vir ANTES das rotas /:id abaixo: o Express casa rotas na ordem de registro,
// não por especificidade — um PUT /:id definido primeiro capturaria "/me" como se `me`
// fosse um id.

usuariosRouter.get('/me', wrap(async (req, res) => {
  const usuario = await getUserById(req.user.id);
  if (!usuario) return res.status(404).json({ error: 'usuário não encontrado' });
  res.json({ user: perfilPublico(usuario) });
}));

usuariosRouter.put('/me', wrap(async (req, res) => {
  const { firstName, lastName, avatar } = req.body || {};
  const usuario = await updateProfile(req.user.id, { firstName, lastName, avatar });
  res.json({ user: perfilPublico(usuario) });
}));

/**
 * Troca de senha a partir do perfil: NÃO é um fluxo de autenticação novo — só dispara o
 * e-mail de redefinição (já existente, purpose `redefinicao`) para o próprio e-mail do
 * usuário logado. A definição da senha nova continua acontecendo em POST /api/auth/definir-senha.
 */
usuariosRouter.post('/me/trocar-senha', wrap(async (req, res) => {
  const usuario = await getUserById(req.user.id);
  if (!usuario) return res.status(404).json({ error: 'usuário não encontrado' });

  const { token, horas } = await createUserToken(usuario.id, 'redefinicao');
  const url = `${publicBaseUrl()}/definir-senha?token=${token}`;

  if (!emailConfigurado()) {
    return res.json({ enviado: false, motivo: 'SMTP não configurado', urlRedefinicao: url });
  }

  const msg = emailRedefinirSenha({ nome: usuario.name || usuario.email, urlDefinirSenha: url, expiraEmHoras: horas });
  const resultado = await enviarEmail({ para: usuario.email, ...msg });
  log('info', 'troca de senha solicitada pelo próprio usuário', { user: usuario.email, enviado: resultado.enviado });
  res.json({ enviado: resultado.enviado, ...(!resultado.enviado && { motivo: resultado.erro }) });
}));

/**
 * Gera o link de convite e tenta enviá-lo.
 * Devolve sempre o link: se o SMTP falhar (ou nem estiver configurado), o painel
 * mostra o link para o admin repassar manualmente — melhor do que deixar o convidado
 * sem acesso porque o e-mail não saiu.
 */
async function enviarConvite(usuario, { convidadoPor, reenvio = false }) {
  const { token, horas } = await createUserToken(usuario.id, 'convite', { createdBy: convidadoPor?.id });
  const url = `${publicBaseUrl()}/definir-senha?token=${token}`;

  if (!emailConfigurado()) {
    return { enviado: false, urlConvite: url, motivo: 'SMTP não configurado' };
  }

  const msg = emailConvite({
    nome: usuario.name || usuario.email,
    email: usuario.email,
    urlDefinirSenha: url,
    convidadoPor: convidadoPor?.name || convidadoPor?.email || 'a equipe',
    papel: usuario.role,
    expiraEmHoras: horas,
  });

  const resultado = await enviarEmail({ para: usuario.email, ...msg });
  log('info', reenvio ? 'convite reenviado' : 'convite enviado', {
    para: usuario.email, enviado: resultado.enviado,
  });

  return resultado.enviado
    ? { enviado: true }
    : { enviado: false, urlConvite: url, motivo: resultado.erro };
}

// ---------------------------------------------------------------- administração (admin only)

usuariosRouter.get('/', requireAdmin, wrap(async (_req, res) => {
  res.json((await listUsers()).map(publico));
}));

usuariosRouter.post('/', requireAdmin, wrap(async (req, res) => {
  const { email, name, role } = req.body || {};
  const usuario = await inviteUser({ email, name, role: role || 'operador', createdBy: req.user.id });
  const convite = await enviarConvite(usuario, { convidadoPor: req.user });

  // Avisa os demais admins que alguém entrou no time — controle de acesso é assunto
  // de todos os administradores, não só de quem clicou.
  notificarAdmins(usuario, req.user).catch(() => {});

  res.status(201).json({
    user: publico(usuario),
    conviteEnviado: convite.enviado,
    ...(convite.urlConvite && { urlConvite: convite.urlConvite, motivo: convite.motivo }),
  });
}));

usuariosRouter.put('/:id', requireAdmin, wrap(async (req, res) => {
  const { name, role } = req.body || {};
  if (role !== undefined && !PAPEIS.includes(role)) {
    return res.status(400).json({ error: `papel deve ser ${PAPEIS.join(' ou ')}` });
  }
  res.json({ user: publico(await updateUser(Number(req.params.id), { name, role })) });
}));

usuariosRouter.delete('/:id', requireAdmin, wrap(async (req, res) => {
  await deleteUser(Number(req.params.id), { solicitanteId: req.user.id });
  log('info', 'usuário removido', { por: req.user.email, alvo: req.params.id });
  res.json({ ok: true });
}));

usuariosRouter.post('/:id/reenviar-convite', requireAdmin, wrap(async (req, res) => {
  const usuario = await getUserById(Number(req.params.id));
  if (!usuario) return res.status(404).json({ error: 'usuário não encontrado' });
  if (usuario.password_hash) {
    return res.status(400).json({ error: 'este usuário já definiu a senha; use "esqueci minha senha"' });
  }

  const convite = await enviarConvite(usuario, { convidadoPor: req.user, reenvio: true });
  res.json({ ok: true, enviado: convite.enviado, ...(convite.urlConvite && { urlConvite: convite.urlConvite }) });
}));

// Notificação silenciosa aos administradores (falha aqui nunca afeta o cadastro).
async function notificarAdmins(novoUsuario, autor) {
  if (!emailConfigurado()) return;
  const admins = (await listUsers()).filter(
    (u) => u.role === 'admin' && u.status === 'ativo' && u.id !== autor.id
  );
  if (!admins.length) return;

  const msg = emailNovoUsuarioParaAdmin({
    nomeNovo: novoUsuario.name || '(sem nome)',
    emailNovo: novoUsuario.email,
    papel: novoUsuario.role,
    criadoPor: autor.name || autor.email,
    urlPainel: `${publicBaseUrl()}/painel`,
  });

  await Promise.all(admins.map((a) => enviarEmail({ para: a.email, ...msg })));
}
