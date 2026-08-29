// Envio de e-mail transacional (convite, redefinição de senha, alertas operacionais).
//
// Provedor atual: Gmail via SMTP com "senha de app" — exige verificação em duas etapas
// ativa na conta Google e uma senha de app gerada especificamente para este servidor.
// A senha de app tem 16 caracteres e costuma ser exibida com espaços; removemos os
// espaços antes de usar, porque colar direto da tela do Google é o caminho natural.
//
// Limite honesto do Gmail: ~500 mensagens por dia numa conta comum. É folgado para
// convites e alertas, mas não serve para envio em massa. Trocar por um provedor
// transacional (Resend, SES, Postmark) é só mudar as variáveis SMTP_* — nenhuma outra
// parte do código conhece o provedor.
import nodemailer from 'nodemailer';
import { env } from './env.js';
import { log } from './log.js';

let transporte = null;
let avisouDesconfigurado = false;

function criarTransporte() {
  if (transporte) return transporte;
  if (!env.SMTP_USER || !env.SMTP_PASS) return null;

  transporte = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 = TLS implícito; 587 = STARTTLS.
    secure: env.SMTP_PORT === 465,
    auth: {
      user: env.SMTP_USER,
      pass: String(env.SMTP_PASS).replace(/\s+/g, ''),
    },
  });
  return transporte;
}

export function emailConfigurado() {
  return Boolean(env.SMTP_USER && env.SMTP_PASS);
}

/**
 * Envia um e-mail. NUNCA lança: uma falha de SMTP não pode derrubar o cadastro de um
 * usuário nem travar o worker. Devolve { enviado, erro } para quem chamou decidir —
 * no convite, por exemplo, o painel mostra o link para envio manual quando não sai.
 */
export async function enviarEmail({ para, assunto, html, texto }) {
  const transport = criarTransporte();

  if (!transport) {
    if (!avisouDesconfigurado) {
      log('warn', 'SMTP não configurado — e-mails não serão enviados', {
        dica: 'defina SMTP_USER e SMTP_PASS no .env',
      });
      avisouDesconfigurado = true;
    }
    return { enviado: false, erro: 'SMTP não configurado' };
  }

  try {
    const info = await transport.sendMail({
      from: env.SMTP_FROM || `"Servidor Traker" <${env.SMTP_USER}>`,
      to: para,
      subject: assunto,
      text: texto,
      html,
    });
    log('info', 'e-mail enviado', { para, assunto, messageId: info.messageId });
    return { enviado: true, messageId: info.messageId };
  } catch (err) {
    log('error', 'falha ao enviar e-mail', { para, assunto, error: err.message });
    return { enviado: false, erro: err.message };
  }
}

// Testa a conexão SMTP sem enviar nada — usado pelo painel e pelo boot em modo debug.
export async function verificarSmtp() {
  const transport = criarTransporte();
  if (!transport) return { ok: false, erro: 'SMTP não configurado' };
  try {
    await transport.verify();
    return { ok: true, host: env.SMTP_HOST, usuario: env.SMTP_USER };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
}
