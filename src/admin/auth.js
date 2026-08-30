// Autenticação do painel por sessão em cookie HttpOnly.
//
// Encerra a dívida técnica do MVP (botão "Entrar" sem autenticação). O painel guarda
// access tokens de Pixel de clientes reais — deixá-lo aberto seria expor credenciais de
// anúncio de terceiros.
import { Router } from 'express';
import {
  authenticate, createSession, getSessionUser, destroySession, countUsers, createUser,
  getUserByEmail, createUserToken, getUserToken, consumeUserToken, setPassword,
  REMEMBER_TTL_HORAS,
} from '../db/repos/users.js';
import { parseCookies } from '../ingest/cookies.js';
// Mesmo extrator de IP usado na ingestão — de propósito, e não uma segunda convenção:
// aqui o IP vai para o log de auditoria de login, para o e-mail de "sua senha mudou" e
// para a chave do rate limit. Ler `x-forwarded-for` cru (como era feito nas três rotas
// abaixo) deixa qualquer cliente escolher o IP que aparece na auditoria e, pior, trocar
// de "identidade" a cada tentativa para escapar do limite de força bruta. O helper só
// aceita o cabeçalho quando TRUST_PROXY declara que existe um proxy na frente.
import { extractClientIp } from '../ingest/normalize.js';
import { env, publicBaseUrl } from '../config/env.js';
import { log } from '../config/log.js';
import { rateLimit } from '../ingest/rate-limit.js';
import { enviarEmail } from '../config/mailer.js';
import { emailRedefinirSenha, emailSenhaAlterada } from '../emails/templates.js';
import { painelEhSameSite } from './seguranca.js';

export const SESSION_COOKIE = 'traker_sess';

// Atributos do cookie de sessão, num lugar só.
//
// Setar e limpar PRECISAM usar os mesmos atributos: o navegador só aceita um Set-Cookie
// cross-site se ele vier `SameSite=None; Secure`, então um logout que respondesse com
// `SameSite=Lax` seria descartado em silêncio e a sessão continuaria valendo no navegador.
// Era exatamente o que acontecia antes desta função existir.
function atributosDoCookie() {
  const separado = env.PANEL_ORIGINS.length > 0;

  // O painel em outra origem NÃO obriga SameSite=None: `SameSite` é avaliado por site, e
  // um painel em subdomínio do host da API (app.zyraflow.site ↔ zyraflow.site) é o mesmo
  // site. Nesse caso o cookie fica `Lax` e a defesa nativa contra CSRF de sites externos
  // continua de pé — o cabeçalho X-Traker-Painel segue exigido como defesa em
  // profundidade. Só painel em outro domínio registrável cai para `None`.
  const sameSite = (!separado || painelEhSameSite()) ? 'Lax' : 'None';

  const attrs = ['Path=/', 'HttpOnly', `SameSite=${sameSite}`];
  // SameSite=None só é aceito junto de Secure. Em https, Secure sempre.
  if (env.PUBLIC_SCHEME === 'https' || sameSite === 'None') attrs.push('Secure');
  return attrs;
}

function setSessionCookie(res, token, expiresAt) {
  const parts = [`${SESSION_COOKIE}=${token}`, ...atributosDoCookie(), `Expires=${expiresAt.toUTCString()}`];
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', [`${SESSION_COOKIE}=`, ...atributosDoCookie(), 'Max-Age=0'].join('; '));
}

// Middleware: exige sessão válida. Responde 401 em JSON para o painel saber redirecionar.
export async function requireAuth(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = await getSessionUser(token);
    if (!user) return res.status(401).json({ error: 'não autenticado' });
    req.user = user;
    next();
  } catch (err) {
    log('error', 'falha ao validar sessão', { error: err.message });
    res.status(500).json({ error: 'falha ao validar sessão' });
  }
}

/**
 * Exige sessão de administrador. Operador enxerga projetos, métricas e logs, mas não
 * gerencia usuários nem toca em credenciais — as duas coisas que dão acesso a contas
 * de anúncio de terceiros.
 */
export async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'ação restrita a administradores' });
    }
    next();
  });
}

export const authRouter = Router();

// ---------------------------------------------------------------- senha por e-mail

/**
 * Solicitação de redefinição de senha.
 * Responde 200 SEMPRE, mesmo para e-mail inexistente: dizer "esse e-mail não existe"
 * transformaria a tela num verificador de contas cadastradas.
 */
authRouter.post('/esqueci-senha', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const ip = extractClientIp(req) || 'desconhecido';

  if (!rateLimit(`reset:${ip}`, 10)) {
    return res.status(429).json({ error: 'muitas tentativas, tente novamente em um minuto' });
  }

  try {
    const usuario = email ? await getUserByEmail(email) : null;
    if (usuario) {
      const { token, horas } = await createUserToken(usuario.id, 'redefinicao');
      const url = `${publicBaseUrl()}/definir-senha?token=${token}`;
      const msg = emailRedefinirSenha({
        nome: usuario.name || usuario.email,
        urlDefinirSenha: url,
        expiraEmHoras: horas,
      });
      await enviarEmail({ para: usuario.email, ...msg });
      log('info', 'link de redefinição enviado', { para: usuario.email });
    } else {
      log('debug', 'redefinição solicitada para e-mail inexistente', { email, ip });
    }
  } catch (err) {
    log('error', 'falha ao processar redefinição', { error: err.message });
  }

  res.json({ ok: true });
});

// Valida o token antes de mostrar o formulário, para não pedir senha em vão.
authRouter.get('/token/:token', async (req, res) => {
  const registro = await getUserToken(req.params.token);
  if (!registro) return res.json({ valido: false });
  res.json({
    valido: true,
    tipo: registro.purpose,
    email: registro.email,
    nome: registro.name,
  });
});

// Define a senha (aceite de convite ou redefinição) e já autentica.
authRouter.post('/definir-senha', async (req, res) => {
  const { token, password } = req.body || {};
  const registro = await getUserToken(token);
  if (!registro) {
    return res.status(400).json({ error: 'link inválido, expirado ou já utilizado' });
  }

  try {
    await setPassword(registro.user_id, password);
    await consumeUserToken(token);

    const ip = extractClientIp(req) || undefined;
    const { token: sessao, expiresAt } = await createSession(registro.user_id, {
      userAgent: req.headers['user-agent'],
      ip,
    });
    setSessionCookie(res, sessao, expiresAt);

    // Confirmação por e-mail: é assim que o titular descobre uma troca que não fez.
    enviarEmail({
      para: registro.email,
      ...emailSenhaAlterada({
        nome: registro.name || registro.email,
        urlPainel: `${publicBaseUrl()}/painel`,
        quando: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
        ip: ip || 'desconhecido',
      }),
    }).catch(() => {});

    log('info', 'senha definida', { user: registro.email, tipo: registro.purpose });
    res.json({ user: { id: registro.user_id, email: registro.email, name: registro.name, role: registro.role } });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'falha ao definir senha' });
  }
});

authRouter.post('/login', async (req, res) => {
  const { email, password, remember } = req.body || {};

  // Limite por IP: trava tentativa de força bruta sem depender de infraestrutura externa.
  // O IP vem do extrator comum, e não do cabeçalho cru: com `x-forwarded-for` livre, um
  // atacante rodaria 20 tentativas por IP inventado e o limite não limitaria nada.
  const ip = extractClientIp(req) || 'desconhecido';
  if (!rateLimit(`login:${ip}`, 20)) {
    return res.status(429).json({ error: 'muitas tentativas, tente novamente em um minuto' });
  }

  try {
    const user = await authenticate(email, password);
    if (!user) {
      log('warn', 'tentativa de login inválida', { ip, email: String(email || '').slice(0, 60) });
      return res.status(401).json({ error: 'e-mail ou senha inválidos' });
    }
    // "Manter conectado" estende a SESSÃO, nunca guarda a senha: o navegador só
    // devolve um booleano, e quem decide o prazo é o servidor (REMEMBER_TTL_HORAS).
    const { token, expiresAt } = await createSession(user.id, {
      userAgent: req.headers['user-agent'],
      ip,
      ttlHours: remember === true ? REMEMBER_TTL_HORAS : undefined,
    });
    setSessionCookie(res, token, expiresAt);
    log('info', 'login realizado', { user: user.email, prolongada: remember === true });
    res.json({ user });
  } catch (err) {
    log('error', 'falha no login', { error: err.message });
    res.status(500).json({ error: 'falha ao autenticar' });
  }
});

authRouter.post('/logout', async (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  await destroySession(token).catch(() => {});
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', async (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const user = await getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'não autenticado' });
  res.json({ user });
});

/**
 * Primeiro acesso: se ainda não existe nenhum usuário, permite criar o primeiro sem
 * autenticação. A janela fecha sozinha assim que o usuário existe — não é um backdoor
 * permanente. Alternativa para quem prefere não expor isso: `npm run criar-usuario`.
 */
authRouter.get('/setup-necessario', async (_req, res) => {
  res.json({
    setupNecessario: (await countUsers()) === 0,
  });
});

/*
 * NÃO EXISTE MAIS: `POST /login-rapido` — o atalho que entrava como administrador
 * sem senha, protegido pela variável LOGIN_RAPIDO.
 *
 * Removido do código em 2026-08-13, e não apenas desligado por configuração: uma
 * porta dos fundos que depende de uma variável estar correta é uma porta que um
 * `.env` copiado errado reabre. Sem código, não há o que configurar errado.
 *
 * O teste de integração "a rota de login sem senha não existe" fixa essa decisão:
 * se alguém reintroduzir a rota, a suíte quebra.
 */

authRouter.post('/setup', async (req, res) => {
  if ((await countUsers()) > 0) {
    return res.status(403).json({ error: 'já existe usuário cadastrado; use o login' });
  }
  try {
    const user = await createUser({
      email: req.body?.email,
      password: req.body?.password,
      name: req.body?.name,
    });
    const { token, expiresAt } = await createSession(user.id, { userAgent: req.headers['user-agent'] });
    setSessionCookie(res, token, expiresAt);
    log('info', 'primeiro usuário criado', { user: user.email });
    res.status(201).json({ user });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});
