// Administração de destinatários e assinaturas de notificação (épico E8).
//
// Este arquivo só cuida do CADASTRO — quem existe, o que cada um assina. O disparo de
// verdade (avaliar gatilho, montar e-mail, respeitar idempotência) é
// src/notificacoes/motor.js, que roda no worker; aqui a única ponte com ele é o botão
// "enviar teste" e o link público de descadastro.
import { Router } from 'express';
import {
  CATALOGO_NOTIFICACOES, listDestinatarios, getDestinatario, getDestinatarioComAssinaturas,
  criarDestinatario, atualizarDestinatario, removerDestinatario, desativarPorToken,
} from '../db/repos/notificacoes.js';
import { getUserById } from '../db/repos/users.js';
import { requireAuth, requireAdmin } from './auth.js';
import { enviarNotificacaoTeste } from '../notificacoes/motor.js';
import { log } from '../config/log.js';

export const notificacoesRouter = Router();

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) log('error', 'erro na gestão de notificações', { rota: req.originalUrl, error: err.message });
    res.status(status).json({ error: status < 500 ? err.message : 'erro interno' });
  }
};

/**
 * Forma pública de um destinatário para o painel. `token_descadastro` NUNCA sai daqui —
 * é uma capacidade de auto-descadastro sem login; expor o token na listagem admin
 * daria a qualquer sessão com acesso de leitura o poder de desinscrever qualquer um.
 */
const publico = (d) => ({
  id: d.id,
  nome: d.nome,
  email: d.email,
  userId: d.user_id,
  interno: d.user_id !== null,
  papel: d.usuario_role || null,
  ativo: d.ativo,
  createdAt: d.created_at,
  assinaturas: (d.assinaturas || []).map((a) => ({ tipo: a.tipo, projectId: a.projectId })),
});

// Toda esta seção exige sessão — o catálogo é leitura de qualquer papel (o operador
// também pode consultar quais tipos existem), o resto é admin only.
notificacoesRouter.use(requireAuth);

notificacoesRouter.get('/catalogo', wrap(async (_req, res) => {
  res.json(CATALOGO_NOTIFICACOES);
}));

notificacoesRouter.get('/destinatarios', requireAdmin, wrap(async (_req, res) => {
  res.json((await listDestinatarios()).map(publico));
}));

notificacoesRouter.post('/destinatarios', requireAdmin, wrap(async (req, res) => {
  const { nome, email, userId, assinaturas } = req.body || {};

  // Destinatário "interno": vinculado a um usuário do painel existente — nome e e-mail
  // vêm de lá quando não informados no corpo, para não deixar os dois cadastros divergir
  // por um typo no modal.
  let dados = { nome, email };
  if (userId) {
    const usuario = await getUserById(Number(userId));
    if (!usuario) return res.status(404).json({ error: 'usuário não encontrado' });
    dados = { nome: nome || usuario.name || usuario.email, email: usuario.email };
  }

  const destinatario = await criarDestinatario({
    ...dados,
    userId: userId ? Number(userId) : null,
    criadoPor: req.user.id,
    assinaturas,
  });
  log('info', 'destinatário de notificação criado', {
    por: req.user.email, destinatario: destinatario.email, externo: !userId,
  });
  res.status(201).json({ destinatario: publico(destinatario) });
}));

notificacoesRouter.put('/destinatarios/:id', requireAdmin, wrap(async (req, res) => {
  const { nome, email, assinaturas } = req.body || {};
  await atualizarDestinatario(Number(req.params.id), { nome, email, assinaturas });
  const destinatario = await getDestinatarioComAssinaturas(Number(req.params.id));
  res.json({ destinatario: publico(destinatario) });
}));

notificacoesRouter.delete('/destinatarios/:id', requireAdmin, wrap(async (req, res) => {
  const ok = await removerDestinatario(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'destinatário não encontrado' });
  log('info', 'destinatário de notificação removido', { por: req.user.email, id: req.params.id });
  res.json({ ok: true });
}));

notificacoesRouter.post('/destinatarios/:id/teste', requireAdmin, wrap(async (req, res) => {
  const destinatario = await getDestinatario(Number(req.params.id));
  if (!destinatario) return res.status(404).json({ error: 'destinatário não encontrado' });
  const resultado = await enviarNotificacaoTeste(destinatario);
  res.json(resultado);
}));

// ---------------------------------------------------------------- descadastro (público)

/**
 * Confirmação HTML minimalista, sem CSS/JS externo (mesma disciplina de CSP do resto do
 * produto, mesmo que esta página fique fora do middleware que aplica os cabeçalhos —
 * ver src/admin/seguranca.js). Nenhum dado do usuário é interpolado sem passar por texto
 * fixo: `ok` é um booleano interno, não algo vindo da query string.
 */
function paginaDescadastro(ok) {
  const titulo = ok ? 'Notificações canceladas' : 'Link inválido';
  const mensagem = ok
    ? 'Você não vai mais receber este tipo de notificação por e-mail. Se mudar de ideia, peça para o administrador da conta te inscrever de novo.'
    : 'Este link de descadastro é inválido ou já foi usado. Se você continua recebendo e-mails indesejados, fale com o administrador da conta.';
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${titulo} — Servidor Traker</title>
<style>
  body { margin:0; padding:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0A0A0A; color:#FFFFFF; font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; }
  main { max-width:420px; margin:24px; padding:32px; border:1px solid #262626; border-radius:12px;
         background:#141414; text-align:center; }
  h1 { font-size:20px; margin:0 0 12px; color:#E5B94E; }
  p { font-size:14px; line-height:22px; color:#B3B3B3; margin:0; }
</style>
</head>
<body><main><h1>${titulo}</h1><p>${mensagem}</p></main></body>
</html>`;
}

// Router SEM requireAuth — é o link de e-mail, precisa funcionar sem sessão nenhuma
// (LGPD: sair da lista não pode depender de fazer login). Montado FORA de /api pelo
// server.js, então nunca passa por corsDoPainel/exigirOrigemDoPainel.
export const descadastroRouter = Router();

descadastroRouter.get('/descadastro', wrap(async (req, res) => {
  const destinatario = await desativarPorToken(String(req.query.token || ''));
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.status(destinatario ? 200 : 400).send(paginaDescadastro(Boolean(destinatario)));
}));
