// Templates de e-mail transacional do Servidor Traker (marca Código Vencedor).
//
// Regras que valem para TODO este arquivo (HTML de e-mail é HTML de 2005):
//   - layout só com <table role="presentation"> aninhadas e larguras fixas;
//   - 100% do CSS inline em atributo style — nada de flexbox, grid, <link> ou var(--x);
//   - nenhuma imagem remota (a assinatura "///" do logotipo é feita com texto);
//   - fontes web sempre com fallback seguro, porque nenhum cliente vai baixar Space Grotesk;
//   - cada função devolve { assunto, html, texto } — o texto puro é escrito à mão, não é
//     um strip de tags, senão o e-mail fica ilegível em cliente text-only e cai em spam.
//
// Sobre cor: variáveis CSS não existem em e-mail, então cada hexadecimal vai escrito na
// marra em cada atributo. Só entram aqui as cores oficiais da marca — nenhum tom
// intermediário inventado, para o e-mail não destoar do site.

/** Paleta oficial Código Vencedor. */
const c = {
  fundo: '#0A0A0A',      // fundo da página (quase preto)
  cartao: '#141414',     // fundo do cartão / corpo do e-mail
  linha: '#262626',      // bordas e divisórias
  dourado: '#E5B94E',    // destaque principal — títulos, logo, acento do usuário
  douradoEsc: '#C9982F', // variante escura para degradê/detalhe
  cta: '#F02649',        // CTA sólido (fallback do gradiente) e vermelho de alerta
  ctaClaro: '#FF2D55',   // início do gradiente do CTA
  ctaEscuro: '#E01B41',  // fim do gradiente do CTA
  texto: '#FFFFFF',      // texto principal
  apoio: '#B3B3B3',      // texto secundário / rótulos
  ok: '#22C55E',         // status positivo
};

// Pilhas de fonte: a família do produto primeiro, depois a rede de segurança.
// Sem @import e sem <link> para Google Fonts — Gmail, Outlook e Yahoo bloqueiam, e o
// e-mail precisa ficar bonito já no fallback.
const FONTE_TITULO = "'Space Grotesk', 'IBM Plex Sans', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const FONTE_TEXTO = "'IBM Plex Sans', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const FONTE_MONO = "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Consolas, 'Courier New', monospace";

const PRODUTO = 'Servidor Traker';
const AUTOR = 'Código Vencedor';

/* ────────────────────────────── helpers de segurança ────────────────────────────── */

/**
 * Escapa texto para interpolação segura em HTML.
 * Obrigatório em TODO valor que venha de fora (nome, e-mail, mensagem de erro do destino):
 * um nome como `Ana <script>` quebraria o layout e seria vetor de injeção — e a mensagem
 * de erro do Meta/Google é resposta de terceiro, ou seja, entrada não confiável por definição.
 */
export function esc(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Limpa o assunto. Quebra de linha em header de e-mail é injeção de cabeçalho
 * (o atacante emenda um Bcc:), então CR/LF viram espaço antes de sair daqui.
 */
function assuntoSeguro(texto) {
  return String(texto).replace(/[\r\n]+/g, ' ').trim();
}

/** Texto de uma linha, sem HTML — usado nas versões em texto puro. */
function limpo(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor).replace(/[\r\n]+/g, ' ').trim();
}

/* ────────────────────────────── helpers de formatação ───────────────────────────── */

function plural(n, singular, pluralForma) {
  return Number(n) === 1 ? singular : pluralForma;
}

function numero(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n ?? '');
  return v.toLocaleString('pt-BR');
}

/** Descrição do papel — o convidado precisa saber o que ele pode e o que ele NÃO pode. */
function descricaoPapel(papel) {
  const p = String(papel || '').trim().toLowerCase();
  if (p === 'admin') {
    return 'acesso total ao painel: configura projetos e destinos, vê e edita credenciais (tokens do Meta e do Google) e gerencia os usuários da conta.';
  }
  if (p === 'operador') {
    return 'acompanha os projetos, os eventos e os logs de entrega. Não gerencia usuários e não visualiza as credenciais dos destinos.';
  }
  return 'acesso conforme definido pelo administrador da conta.';
}

function rotuloPapel(papel) {
  const p = String(papel || '').trim().toLowerCase();
  if (p === 'admin') return 'Administrador';
  if (p === 'operador') return 'Operador';
  return limpo(papel) || 'não definido';
}

/* ─────────────────────────────── blocos reutilizáveis ───────────────────────────── */

/**
 * Preheader: o trecho que o cliente mostra ao lado do assunto na caixa de entrada.
 * O rabo de &zwnj;&nbsp; empurra o texto do corpo para fora da prévia — sem ele, o
 * Gmail completa a linha com "Código Vencedor", "Ver no navegador" etc.
 */
function preheaderHtml(texto) {
  const enchimento = '&#847;&zwnj;&nbsp;'.repeat(60);
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${c.fundo}">${esc(texto)}${enchimento}</div>`;
}

/**
 * Etiqueta arredondada de contexto (e-mails do usuário).
 * Fundo sólido em preto da marca: rgba() é ignorado pelo Outlook desktop, então tinta
 * translúcida viraria buraco no layout.
 */
function etiqueta({ texto, cor }) {
  return `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">
                <tr>
                  <td bgcolor="${c.fundo}" style="background-color:${c.fundo};border:1px solid ${cor};border-radius:100px;padding:6px 14px;font-family:${FONTE_MONO};font-size:11px;line-height:14px;letter-spacing:1.6px;text-transform:uppercase;color:${cor};white-space:nowrap">${esc(texto)}</td>
                </tr>
              </table>`;
}

function titulo(html) {
  // mso-line-height-rule:exactly evita o Outlook inflar a entrelinha de títulos grandes.
  return `<h1 style="margin:0;font-family:${FONTE_TITULO};font-size:25px;line-height:32px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:-0.4px;color:${c.texto}">${html}</h1>`;
}

function paragrafo(html, { cor = c.apoio, tamanho = 15, topo = 16 } = {}) {
  return `<p style="margin:${topo}px 0 0;font-family:${FONTE_TEXTO};font-size:${tamanho}px;line-height:24px;mso-line-height-rule:exactly;color:${cor}">${html}</p>`;
}

function espaco(altura) {
  // Célula vazia com altura fixa: mais confiável que margin, que o Outlook ignora.
  return `<tr><td style="height:${altura}px;line-height:${altura}px;font-size:0">&nbsp;</td></tr>`;
}

/**
 * Botão "bulletproof" no CTA da marca.
 * Duas decisões deliberadas:
 *   1) o padding vive no <td>, não no <a> — o Outlook desktop (motor Word) ignora padding
 *      em elemento inline, e o botão viraria um link sem área clicável;
 *   2) o gradiente vermelho-rosa entra como background-image DEPOIS do background-color
 *      sólido #F02649. Quem entende gradiente vê o degradê; quem não entende (Outlook,
 *      Gmail app antigo) fica com o vermelho sólido, que já é cor de marca.
 */
function botao({ url, rotulo }) {
  const gradiente = `background-image:linear-gradient(135deg, ${c.ctaClaro} 0%, ${c.ctaEscuro} 100%)`;
  return `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate">
                <tr>
                  <td align="center" bgcolor="${c.cta}" style="background-color:${c.cta};${gradiente};border-radius:9px;padding:15px 30px;mso-padding-alt:15px 30px">
                    <a href="${esc(url)}" target="_blank" style="display:block;font-family:${FONTE_MONO};font-size:15px;line-height:18px;font-weight:600;letter-spacing:0.2px;color:${c.texto};text-decoration:none">${esc(rotulo)}</a>
                  </td>
                </tr>
              </table>`;
}

/** Link cru embaixo do botão — para cliente que remove o <a> ou para copiar e colar. */
function linkAlternativo(url, acento) {
  return `
              <p style="margin:18px 0 0;font-family:${FONTE_TEXTO};font-size:13px;line-height:20px;color:${c.apoio}">
                Se o botão não funcionar, copie e cole este endereço no navegador:<br />
                <a href="${esc(url)}" target="_blank" style="font-family:${FONTE_MONO};font-size:12px;line-height:20px;color:${acento};text-decoration:underline;word-break:break-all">${esc(url)}</a>
              </p>`;
}

/**
 * Tabela chave→valor: rótulo em #B3B3B3, valor em #FFFFFF.
 * `linhas` = [[chave, valorJaEscapado, { mono?, cor? }], ...]
 */
function tabelaDados(linhas) {
  const corpo = linhas
    .map(([chave, valor, opts = {}], i) => {
      // Zebra alternando entre os dois pretos da marca — sem inventar tom intermediário.
      const fundo = i % 2 === 0 ? c.fundo : c.cartao;
      const fonte = opts.mono ? FONTE_MONO : FONTE_TEXTO;
      const cor = opts.cor || c.texto;
      return `
                  <tr>
                    <td width="150" bgcolor="${fundo}" style="width:150px;background-color:${fundo};border-bottom:1px solid ${c.linha};padding:11px 14px;font-family:${FONTE_MONO};font-size:11px;line-height:16px;letter-spacing:1px;text-transform:uppercase;color:${c.apoio};vertical-align:top">${esc(chave)}</td>
                    <td bgcolor="${fundo}" style="background-color:${fundo};border-bottom:1px solid ${c.linha};padding:11px 14px;font-family:${fonte};font-size:14px;line-height:20px;color:${cor};vertical-align:top;word-break:break-word">${valor}</td>
                  </tr>`;
    })
    .join('');

  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;border:1px solid ${c.linha};border-radius:9px">
                ${corpo}
              </table>`;
}

/** Bloco monoespaçado (payload de erro do destino). Conteúdo precisa vir escapado. */
function blocoMono(conteudo) {
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">
                <tr>
                  <td bgcolor="${c.fundo}" style="background-color:${c.fundo};border:1px solid ${c.linha};border-left:3px solid ${c.cta};border-radius:9px;padding:14px 16px;font-family:${FONTE_MONO};font-size:12px;line-height:19px;color:${c.apoio};word-break:break-word">${conteudo}</td>
                </tr>
              </table>`;
}

/** Callout com barra colorida à esquerda. Fundo sólido pelo mesmo motivo do rgba acima. */
function aviso({ html, cor }) {
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">
                <tr>
                  <td bgcolor="${c.fundo}" style="background-color:${c.fundo};border:1px solid ${c.linha};border-left:3px solid ${cor};border-radius:9px;padding:13px 16px;font-family:${FONTE_TEXTO};font-size:13px;line-height:20px;color:${c.apoio}">${html}</td>
                </tr>
              </table>`;
}

/** Rodapé padrão. Sem endereço físico e sem descadastro: é transacional, não marketing. */
function rodapePadrao() {
  return `
              <p style="margin:0;font-family:${FONTE_TITULO};font-size:13px;line-height:20px;font-weight:600;color:${c.apoio}">${PRODUTO} <span style="color:${c.douradoEsc}">·</span> ${AUTOR} <span style="color:${c.dourado};letter-spacing:-1px">///</span></p>
              <p style="margin:7px 0 0;font-family:${FONTE_MONO};font-size:11px;line-height:18px;color:${c.apoio}">Mensagem automática do painel — não responda a este e-mail.</p>`;
}

/* ─────────────────────────────────── layout base ────────────────────────────────── */

/**
 * Esqueleto compartilhado por todos os e-mails: cabeçalho com a marca, corpo e rodapé.
 * Retorna a string HTML completa (documento inteiro, pronto para o transporte SMTP).
 *
 * @param {object} p
 * @param {string} p.titulo     <title> do documento (alguns webmails usam na aba/prévia).
 * @param {string} p.preheader  Texto de prévia na caixa de entrada.
 * @param {string} p.corpoHtml  HTML já montado do miolo (linhas <tr> de uma tabela).
 * @param {string} [p.rodapeHtml] Rodapé customizado; por padrão, o institucional.
 * @returns {string}
 */
export function layoutBase({ titulo: tituloDoc, preheader, corpoHtml, rodapeHtml }) {
  const rodape = rodapeHtml || rodapePadrao();

  // DOCTYPE XHTML 1.0 Transitional: é o que o motor do Outlook desktop entende melhor;
  // com HTML5 ele passa a aplicar margens próprias em <p> e <td>.
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="pt-BR" xml:lang="pt-BR">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no" />
<!-- Declara que o e-mail já sabe se virar nos dois esquemas; sem isso o Apple Mail e o
     Outlook.com aplicam inversão automática de cor e destroem o preto com dourado. -->
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${esc(tituloDoc)}</title>
<!--[if mso]>
<style type="text/css">
  /* O Outlook não carrega fonte web e, ao topar com uma família entre aspas que não tem,
     cai em Times New Roman. Forçar Arial aqui é mais previsível que o fallback dele. */
  body, table, td, p, a, h1 { font-family: Arial, Helvetica, sans-serif !important; }
</style>
<![endif]-->
<style type="text/css">
  /* Único <style> do documento e ele é dispensável: serve só para declarar o color-scheme
     e para o ajuste de respiro no celular. Todo o visual está inline logo abaixo. */
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media only screen and (max-width: 620px) {
    .px { padding-left: 22px !important; padding-right: 22px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:${c.fundo};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%" bgcolor="${c.fundo}">
${preheaderHtml(preheader)}
<!-- Tabela externa pinta o fundo: vários clientes descartam o style do <body>. -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background-color:${c.fundo}" bgcolor="${c.fundo}">
  <tr>
    <td align="center" style="padding:28px 12px">

      <!-- Container: width fixa para o Outlook, max-width para o resto respirar no celular. -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse">

        <!-- Fita dourada de assinatura no topo do cartão. -->
        <tr>
          <td style="font-size:0;line-height:0">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">
              <tr>
                <td width="62%" height="3" bgcolor="${c.dourado}" style="height:3px;font-size:0;line-height:3px;background-color:${c.dourado};border-radius:3px 0 0 0">&nbsp;</td>
                <td width="38%" height="3" bgcolor="${c.douradoEsc}" style="height:3px;font-size:0;line-height:3px;background-color:${c.douradoEsc};border-radius:0 3px 0 0">&nbsp;</td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Cabeçalho: as três barras inclinadas douradas do logotipo, feitas com texto.
             Imagem remota é bloqueada por padrão na maioria dos clientes: nada de bitmap. -->
        <tr>
          <td class="px" bgcolor="${c.cartao}" style="background-color:${c.cartao};border-left:1px solid ${c.linha};border-right:1px solid ${c.linha};border-bottom:1px solid ${c.linha};padding:22px 32px">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">
              <tr>
                <td valign="middle" style="padding-right:12px;font-family:${FONTE_TITULO};font-size:26px;line-height:30px;font-weight:700;letter-spacing:-2px;color:${c.dourado}">///</td>
                <td valign="middle" style="font-family:${FONTE_TITULO};font-size:18px;line-height:22px;font-weight:700;letter-spacing:-0.3px;color:${c.texto}">
                  ${PRODUTO}<br />
                  <span style="font-family:${FONTE_MONO};font-size:10px;line-height:16px;font-weight:400;letter-spacing:1.2px;text-transform:uppercase;color:${c.apoio}">${AUTOR} · rastreamento server-side</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Corpo -->
        <tr>
          <td class="px" bgcolor="${c.cartao}" style="background-color:${c.cartao};border-left:1px solid ${c.linha};border-right:1px solid ${c.linha};padding:30px 32px 34px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">
${corpoHtml}
            </table>
          </td>
        </tr>

        <!-- Rodapé -->
        <tr>
          <td class="px" align="center" bgcolor="${c.fundo}" style="background-color:${c.fundo};border:1px solid ${c.linha};border-radius:0 0 3px 3px;padding:22px 32px 24px;text-align:center">
${rodape}
          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>
</body>
</html>`;
}

/* ══════════════════════════════ E-MAILS DO USUÁRIO ══════════════════════════════ */
/* Tom de boas-vindas, acento DOURADO #E5B94E, botão no vermelho da marca.           */

/**
 * Convite para um novo usuário definir a senha e entrar no painel.
 * @returns {{assunto: string, html: string, texto: string}}
 */
export function emailConvite({ nome, email, urlDefinirSenha, convidadoPor, papel, expiraEmHoras }) {
  const horas = Number(expiraEmHoras) || 24;
  const janela = `${numero(horas)} ${plural(horas, 'hora', 'horas')}`;
  const papelRotulo = rotuloPapel(papel);

  const corpoHtml = `
              <tr><td>${etiqueta({ texto: 'Convite de acesso', cor: c.dourado })}</td></tr>
              ${espaco(18)}
              <tr><td>${titulo(`Bem-vindo(a) ao <span style="color:${c.dourado}">${PRODUTO}</span>, ${esc(limpo(nome))}.`)}</td></tr>
              <tr><td>${paragrafo(
                `O ${PRODUTO} é o servidor de rastreamento server-side da operação: seus sites mandam as conversões para ele, e ele reenvia para o Meta e o Google pela API de Conversões, sem depender do navegador do visitante.`
              )}</td></tr>
              <tr><td>${paragrafo(
                `<strong style="color:${c.texto};font-weight:600">${esc(limpo(convidadoPor))}</strong> criou um acesso para você.`
              )}</td></tr>
              ${espaco(22)}
              <tr><td>${tabelaDados([
                ['Seu e-mail', esc(limpo(email)), { mono: true }],
                ['Seu papel', `<strong style="color:${c.dourado};font-weight:600">${esc(papelRotulo)}</strong> — ${esc(descricaoPapel(papel))}`],
              ])}</td></tr>
              ${espaco(26)}
              <tr><td>${botao({ url: urlDefinirSenha, rotulo: 'Definir minha senha' })}</td></tr>
              <tr><td>${linkAlternativo(urlDefinirSenha, c.dourado)}</td></tr>
              ${espaco(22)}
              <tr><td>${aviso({
                cor: c.dourado,
                html: `<strong style="color:${c.texto};font-weight:600">Este convite expira em ${esc(janela)}.</strong> Depois disso o link para de funcionar e será preciso pedir um novo convite a quem administra a conta.`,
              })}</td></tr>
              ${espaco(14)}
              <tr><td>${paragrafo(
                'Se você não esperava este convite, ignore esta mensagem — sem definir a senha, nenhuma conta é ativada.',
                { tamanho: 13, topo: 0 }
              )}</td></tr>`;

  const texto = [
    `${PRODUTO} — convite de acesso`,
    '',
    `Olá, ${limpo(nome)}.`,
    '',
    `O ${PRODUTO} é o servidor de rastreamento server-side da operação: seus sites mandam as`,
    'conversões para ele, e ele reenvia para o Meta e o Google pela API de Conversões, sem',
    'depender do navegador do visitante.',
    '',
    `${limpo(convidadoPor)} criou um acesso para você.`,
    '',
    `E-mail de acesso: ${limpo(email)}`,
    `Papel: ${papelRotulo} — ${descricaoPapel(papel)}`,
    '',
    'Para começar, defina sua senha neste endereço:',
    '',
    limpo(urlDefinirSenha),
    '',
    `Atenção: o convite expira em ${janela}. Depois disso o link para de funcionar e será`,
    'preciso pedir um novo convite a quem administra a conta.',
    '',
    'Se você não esperava este convite, ignore esta mensagem — sem definir a senha,',
    'nenhuma conta é ativada.',
    '',
    '—',
    `${PRODUTO} · ${AUTOR}`,
    'Mensagem automática do painel — não responda a este e-mail.',
  ].join('\n');

  return {
    assunto: assuntoSeguro(`${limpo(convidadoPor)} convidou você para o ${PRODUTO}`),
    html: layoutBase({
      titulo: `Convite para o ${PRODUTO}`,
      preheader: `Defina sua senha e ative seu acesso como ${papelRotulo.toLowerCase()}. O link vale por ${janela}.`,
      corpoHtml,
    }),
    texto,
  };
}

/**
 * Link de redefinição de senha solicitado pelo próprio usuário.
 * @returns {{assunto: string, html: string, texto: string}}
 */
export function emailRedefinirSenha({ nome, urlDefinirSenha, expiraEmHoras }) {
  const horas = Number(expiraEmHoras) || 1;
  const janela = `${numero(horas)} ${plural(horas, 'hora', 'horas')}`;

  const corpoHtml = `
              <tr><td>${etiqueta({ texto: 'Redefinição de senha', cor: c.dourado })}</td></tr>
              ${espaco(18)}
              <tr><td>${titulo('Vamos criar uma nova senha.')}</td></tr>
              <tr><td>${paragrafo(
                `Olá, ${esc(limpo(nome))}. Recebemos um pedido para redefinir a senha da sua conta no ${PRODUTO}. Clique no botão abaixo para escolher uma nova.`
              )}</td></tr>
              ${espaco(26)}
              <tr><td>${botao({ url: urlDefinirSenha, rotulo: 'Redefinir minha senha' })}</td></tr>
              <tr><td>${linkAlternativo(urlDefinirSenha, c.dourado)}</td></tr>
              ${espaco(22)}
              <tr><td>${aviso({
                cor: c.dourado,
                html: `<strong style="color:${c.texto};font-weight:600">O link vale por ${esc(janela)}</strong> e só pode ser usado uma vez. Depois disso, é só pedir outro na tela de login.`,
              })}</td></tr>
              ${espaco(14)}
              <tr><td>${paragrafo(
                `Não foi você quem pediu? Então não precisa fazer nada: <strong style="color:${c.texto};font-weight:600">sua senha atual continua valendo</strong> e nada na sua conta foi alterado. O link simplesmente expira sozinho.`,
                { tamanho: 13, topo: 0 }
              )}</td></tr>`;

  const texto = [
    `${PRODUTO} — redefinição de senha`,
    '',
    `Olá, ${limpo(nome)}.`,
    '',
    `Recebemos um pedido para redefinir a senha da sua conta no ${PRODUTO}.`,
    'Escolha uma nova senha neste endereço:',
    '',
    limpo(urlDefinirSenha),
    '',
    `O link vale por ${janela} e só pode ser usado uma vez. Depois disso, é só pedir`,
    'outro na tela de login.',
    '',
    'Não foi você quem pediu? Então não precisa fazer nada: sua senha atual continua',
    'valendo e nada na sua conta foi alterado. O link expira sozinho.',
    '',
    '—',
    `${PRODUTO} · ${AUTOR}`,
    'Mensagem automática do painel — não responda a este e-mail.',
  ].join('\n');

  return {
    assunto: assuntoSeguro(`Redefinição de senha — ${PRODUTO}`),
    html: layoutBase({
      titulo: `Redefinir senha — ${PRODUTO}`,
      preheader: `Link para criar uma nova senha, válido por ${janela}.`,
      corpoHtml,
    }),
    texto,
  };
}

/**
 * Confirmação de que a senha foi alterada — e alerta caso não tenha sido o dono da conta.
 * @returns {{assunto: string, html: string, texto: string}}
 */
export function emailSenhaAlterada({ nome, urlPainel, quando, ip }) {
  const ipHtml = esc(limpo(ip)) || `<span style="color:${c.apoio}">não registrado</span>`;

  const corpoHtml = `
              <tr><td>${etiqueta({ texto: 'Senha atualizada', cor: c.ok })}</td></tr>
              ${espaco(18)}
              <tr><td>${titulo('Sua senha foi alterada.')}</td></tr>
              <tr><td>${paragrafo(
                `Olá, ${esc(limpo(nome))}. A senha da sua conta no ${PRODUTO} acabou de ser trocada. A partir de agora, use a nova senha para entrar no painel.`
              )}</td></tr>
              ${espaco(22)}
              <tr><td>${tabelaDados([
                ['Quando', esc(limpo(quando)), { mono: true }],
                ['Endereço IP', ipHtml, { mono: true }],
              ])}</td></tr>
              ${espaco(24)}
              <tr><td>${aviso({
                cor: c.cta,
                html: `<strong style="color:${c.texto};font-weight:600">Não foi você?</strong><br />Fale com o administrador da conta imediatamente para revogar o acesso. Se a troca não partiu de você, alguém pode estar com o controle da sua conta — e o painel dá acesso aos dados de conversão dos projetos.`,
              })}</td></tr>
              ${espaco(24)}
              <tr><td>${botao({ url: urlPainel, rotulo: 'Abrir o painel' })}</td></tr>
              <tr><td>${linkAlternativo(urlPainel, c.dourado)}</td></tr>`;

  const texto = [
    `${PRODUTO} — sua senha foi alterada`,
    '',
    `Olá, ${limpo(nome)}.`,
    '',
    `A senha da sua conta no ${PRODUTO} acabou de ser trocada. A partir de agora, use`,
    'a nova senha para entrar no painel.',
    '',
    `Quando: ${limpo(quando)}`,
    `Endereço IP: ${limpo(ip) || 'não registrado'}`,
    '',
    'NÃO FOI VOCÊ? Fale com o administrador da conta imediatamente para revogar o acesso.',
    'Se a troca não partiu de você, alguém pode estar com o controle da sua conta.',
    '',
    'Painel:',
    '',
    limpo(urlPainel),
    '',
    '—',
    `${PRODUTO} · ${AUTOR}`,
    'Mensagem automática do painel — não responda a este e-mail.',
  ].join('\n');

  return {
    assunto: assuntoSeguro(`Sua senha do ${PRODUTO} foi alterada`),
    html: layoutBase({
      titulo: `Senha alterada — ${PRODUTO}`,
      preheader: `Alteração registrada em ${limpo(quando)}. Se não foi você, avise o administrador.`,
      corpoHtml,
    }),
    texto,
  };
}

/* ═══════════════════════════════ E-MAILS DO ADMIN ═══════════════════════════════ */
/* Tom operacional: faixa larga em vermelho da marca com o texto em branco, e os      */
/* dados sempre em tabela chave-valor (rótulo #B3B3B3, valor #FFFFFF).                */

/** Faixa larga de contexto usada só nos e-mails de admin. */
function faixaAdmin(texto) {
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">
                <tr>
                  <td align="center" bgcolor="${c.cta}" style="background-color:${c.cta};border-radius:7px;padding:10px 14px;font-family:${FONTE_MONO};font-size:11px;line-height:15px;letter-spacing:2px;text-transform:uppercase;font-weight:600;color:${c.texto};text-align:center">${esc(texto)}</td>
                </tr>
              </table>`;
}

/**
 * Aviso ao administrador de que um usuário novo entrou na conta.
 * @returns {{assunto: string, html: string, texto: string}}
 */
export function emailNovoUsuarioParaAdmin({ nomeNovo, emailNovo, papel, criadoPor, urlPainel }) {
  const papelRotulo = rotuloPapel(papel);
  const ehAdmin = String(papel || '').trim().toLowerCase() === 'admin';

  const corpoHtml = `
              <tr><td>${faixaAdmin('Admin · gestão de acessos')}</td></tr>
              ${espaco(24)}
              <tr><td>${titulo('Novo usuário na conta.')}</td></tr>
              <tr><td>${paragrafo(
                `Um acesso foi criado no ${PRODUTO}. Confira abaixo e revogue no painel se não estiver de acordo.`
              )}</td></tr>
              ${espaco(22)}
              <tr><td>${tabelaDados([
                ['Nome', `<strong style="color:${c.texto};font-weight:600">${esc(limpo(nomeNovo))}</strong>`],
                ['E-mail', esc(limpo(emailNovo)), { mono: true }],
                ['Papel', `<strong style="color:${c.dourado};font-weight:600">${esc(papelRotulo)}</strong>`, { mono: true }],
                ['Criado por', esc(limpo(criadoPor))],
              ])}</td></tr>
              ${
                ehAdmin
                  ? `${espaco(20)}
              <tr><td>${aviso({
                cor: c.dourado,
                html: `Este usuário entrou como <strong style="color:${c.texto};font-weight:600">administrador</strong>: ele enxerga e edita as credenciais dos destinos (tokens do Meta e do Google) e pode criar ou remover outros usuários.`,
              })}</td></tr>`
                  : ''
              }
              ${espaco(26)}
              <tr><td>${botao({ url: urlPainel, rotulo: 'Abrir painel de usuários' })}</td></tr>
              <tr><td>${linkAlternativo(urlPainel, c.dourado)}</td></tr>`;

  const texto = [
    `${PRODUTO} — ADMIN — novo usuário na conta`,
    '',
    `Um acesso foi criado no ${PRODUTO}. Confira abaixo e revogue no painel se não`,
    'estiver de acordo.',
    '',
    `Nome:       ${limpo(nomeNovo)}`,
    `E-mail:     ${limpo(emailNovo)}`,
    `Papel:      ${papelRotulo}`,
    `Criado por: ${limpo(criadoPor)}`,
    '',
    ...(ehAdmin
      ? [
          'Atenção: este usuário entrou como ADMINISTRADOR — ele enxerga e edita as',
          'credenciais dos destinos (tokens do Meta e do Google) e pode criar ou remover',
          'outros usuários.',
          '',
        ]
      : []),
    'Painel de usuários:',
    '',
    limpo(urlPainel),
    '',
    '—',
    `${PRODUTO} · ${AUTOR}`,
    'Mensagem automática do painel — não responda a este e-mail.',
  ].join('\n');

  return {
    assunto: assuntoSeguro(`[Admin] Novo usuário: ${limpo(nomeNovo)} (${papelRotulo.toLowerCase()})`),
    html: layoutBase({
      titulo: `Novo usuário — ${PRODUTO}`,
      preheader: `${limpo(nomeNovo)} <${limpo(emailNovo)}> entrou como ${papelRotulo.toLowerCase()}, criado por ${limpo(criadoPor)}.`,
      corpoHtml,
    }),
    texto,
  };
}

/**
 * Alerta operacional: acúmulo de entregas mortas de um projeto para um destino.
 * É o e-mail mais importante do conjunto — projeto, destino e volume de conversões
 * perdidas têm que ser lidos de relance, antes de qualquer texto.
 * @returns {{assunto: string, html: string, texto: string}}
 */
export function emailAlertaEntregas({ projeto, destino, falhas, periodo, ultimoErro, urlPainel }) {
  const qtd = numero(falhas);
  const palavraEntrega = plural(falhas, 'entrega', 'entregas');
  const palavraFalhou = plural(falhas, 'falhou', 'falharam');
  const palavraConversao = plural(falhas, 'conversão', 'conversões');
  const erro = limpo(ultimoErro) || 'sem detalhe registrado para a última tentativa.';

  const corpoHtml = `
              <tr><td>${faixaAdmin('Alerta operacional')}</td></tr>
              ${espaco(24)}

              <!-- Painel de leitura rápida: o número grande é o que o admin precisa ver primeiro. -->
              <tr><td>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">
                  <tr>
                    <td bgcolor="${c.fundo}" style="background-color:${c.fundo};border:1px solid ${c.linha};border-left:3px solid ${c.cta};border-radius:9px;padding:22px 22px 20px">
                      <p style="margin:0;font-family:${FONTE_MONO};font-size:11px;line-height:16px;letter-spacing:1.6px;text-transform:uppercase;color:${c.apoio}">${esc(palavraEntrega)} mortas</p>
                      <p style="margin:6px 0 0;font-family:${FONTE_TITULO};font-size:40px;line-height:44px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:-1px;color:${c.cta}">${esc(qtd)}</p>
                      <p style="margin:10px 0 0;font-family:${FONTE_TEXTO};font-size:15px;line-height:23px;color:${c.texto}">
                        no projeto <strong style="color:${c.dourado};font-weight:600">${esc(limpo(projeto))}</strong>,
                        com destino <strong style="color:${c.dourado};font-weight:600">${esc(limpo(destino))}</strong>.
                      </p>
                      <p style="margin:8px 0 0;font-family:${FONTE_MONO};font-size:12px;line-height:18px;color:${c.apoio}">período: ${esc(limpo(periodo))}</p>
                    </td>
                  </tr>
                </table>
              </td></tr>

              ${espaco(20)}
              <tr><td>${paragrafo(
                `Estas entregas esgotaram as tentativas e foram para a fila morta: <strong style="color:${c.texto};font-weight:600">até ${esc(qtd)} ${esc(palavraConversao)} ${esc(palavraFalhou)} em chegar ao ${esc(limpo(destino))}</strong> e podem estar faltando na otimização das campanhas.`,
                { topo: 0 }
              )}</td></tr>
              ${espaco(22)}
              <tr><td>${tabelaDados([
                ['Projeto', `<strong style="color:${c.texto};font-weight:600">${esc(limpo(projeto))}</strong>`],
                ['Destino', esc(limpo(destino)), { mono: true, cor: c.dourado }],
                ['Falhas', `${esc(qtd)} ${esc(palavraEntrega)}`, { mono: true, cor: c.cta }],
                ['Período', esc(limpo(periodo)), { mono: true }],
              ])}</td></tr>
              ${espaco(22)}
              <tr><td>
                <p style="margin:0 0 8px;font-family:${FONTE_MONO};font-size:11px;line-height:16px;letter-spacing:1.6px;text-transform:uppercase;color:${c.apoio}">Último erro registrado</p>
                ${blocoMono(esc(erro))}
              </td></tr>
              ${espaco(20)}
              <tr><td>${aviso({
                cor: c.dourado,
                html: 'Causas mais comuns: token de acesso expirado ou revogado, identificador do destino trocado, ou payload recusado por campo obrigatório ausente. Os logs do projeto mostram a requisição completa de cada tentativa.',
              })}</td></tr>
              ${espaco(26)}
              <tr><td>${botao({ url: urlPainel, rotulo: 'Ver logs no painel' })}</td></tr>
              <tr><td>${linkAlternativo(urlPainel, c.dourado)}</td></tr>`;

  const texto = [
    `${PRODUTO} — ALERTA OPERACIONAL`,
    '',
    `${qtd} ${palavraEntrega} ${palavraFalhou} definitivamente.`,
    '',
    `Projeto:  ${limpo(projeto)}`,
    `Destino:  ${limpo(destino)}`,
    `Falhas:   ${qtd} ${palavraEntrega} (fila morta)`,
    `Período:  ${limpo(periodo)}`,
    '',
    `Estas entregas esgotaram as tentativas: até ${qtd} ${palavraConversao} ${palavraFalhou} em chegar`,
    `ao ${limpo(destino)} e podem estar faltando na otimização das campanhas.`,
    '',
    'Último erro registrado:',
    `  ${erro}`,
    '',
    'Causas mais comuns: token de acesso expirado ou revogado, identificador do destino',
    'trocado, ou payload recusado por campo obrigatório ausente. Os logs do projeto',
    'mostram a requisição completa de cada tentativa.',
    '',
    'Ver os logs no painel:',
    '',
    limpo(urlPainel),
    '',
    '—',
    `${PRODUTO} · ${AUTOR}`,
    'Mensagem automática do painel — não responda a este e-mail.',
  ].join('\n');

  return {
    assunto: assuntoSeguro(`[Alerta] ${qtd} ${palavraEntrega} ${palavraFalhou} em ${limpo(projeto)} → ${limpo(destino)}`),
    html: layoutBase({
      titulo: `Alerta de entregas — ${PRODUTO}`,
      preheader: `${qtd} ${palavraEntrega} na fila morta (${limpo(periodo)}). Último erro: ${erro}`,
      corpoHtml,
    }),
    texto,
  };
}

/* ═══════════════════ E-MAILS DE NOTIFICAÇÃO (assinatura por e-mail — épico E8) ═══════════ */
/* Motor: src/notificacoes/motor.js. Vão para gente com E sem acesso ao painel — todo       */
/* e-mail deste grupo carrega o rodapé de descadastro de um clique (LGPD).                   */

/** meta/google/postback -> rótulo legível. Erro desconhecido não trava o e-mail. */
function rotuloDestino(tipo) {
  const mapa = { meta: 'Meta', google: 'Google Ads', postback: 'Postback' };
  return mapa[String(tipo || '').toLowerCase()] || limpo(tipo) || 'destino desconhecido';
}

/**
 * Rodapé específico dos e-mails de notificação: link de descadastro de um clique e, só
 * no primeiro contato com quem nunca pediu para receber (destinatário externo, sem
 * acesso ao painel), a explicação de quem inscreveu o endereço — sem isso a mensagem tem
 * toda a cara de spam. `inscritoPor` vem vazio em qualquer envio que não seja o primeiro.
 */
export function rodapeNotificacao({ inscritoPor, urlDescadastro }) {
  const linhaOrigem = inscritoPor
    ? `<p style="margin:10px 0 0;font-family:${FONTE_TEXTO};font-size:12px;line-height:18px;color:${c.apoio}">Você recebe este e-mail porque <strong style="color:${c.texto};font-weight:600">${esc(limpo(inscritoPor))}</strong> inscreveu este endereço nas notificações do ${PRODUTO}.</p>`
    : '';
  return `${rodapePadrao()}
              ${linhaOrigem}
              <p style="margin:8px 0 0;font-family:${FONTE_MONO};font-size:11px;line-height:18px;color:${c.apoio}"><a href="${esc(urlDescadastro)}" target="_blank" style="color:${c.apoio};text-decoration:underline">Cancelar este tipo de notificação</a></p>`;
}

/** Versão em texto puro do rodapé de descadastro — usada nas variantes `texto` abaixo. */
function rodapeNotificacaoTexto({ inscritoPor, urlDescadastro }) {
  const linhas = [];
  if (inscritoPor) linhas.push(`Você recebe este e-mail porque ${limpo(inscritoPor)} inscreveu este endereço nas notificações do ${PRODUTO}.`, '');
  linhas.push('Cancelar este tipo de notificação:', limpo(urlDescadastro));
  return linhas.join('\n');
}

/**
 * Digest de entregas mortas de um projeto (tipo `entrega_morta`). Um e-mail por projeto,
 * agrupando todos os destinos que morreram na janela — é o motor quem garante o máximo
 * de 1 a cada 30 minutos, este template só desenha o que ele mandar.
 * @returns {{assunto: string, html: string, texto: string}}
 */
export function emailEntregasMortas({ projeto, janelaMinutos, itens, urlPainel, inscritoPor, urlDescadastro }) {
  const total = itens.reduce((acc, i) => acc + Number(i.quantidade || 0), 0);
  const linhasTabela = itens.map((i) => [
    rotuloDestino(i.destino),
    `${numero(i.quantidade)} ${plural(i.quantidade, 'entrega morta', 'entregas mortas')}`,
    { mono: true, cor: c.cta },
  ]);

  const corpoHtml = `
              <tr><td>${faixaAdmin('Alerta operacional')}</td></tr>
              ${espaco(24)}
              <tr><td>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">
                  <tr>
                    <td bgcolor="${c.fundo}" style="background-color:${c.fundo};border:1px solid ${c.linha};border-left:3px solid ${c.cta};border-radius:9px;padding:22px 22px 20px">
                      <p style="margin:0;font-family:${FONTE_MONO};font-size:11px;line-height:16px;letter-spacing:1.6px;text-transform:uppercase;color:${c.apoio}">Entregas mortas</p>
                      <p style="margin:6px 0 0;font-family:${FONTE_TITULO};font-size:40px;line-height:44px;mso-line-height-rule:exactly;font-weight:700;letter-spacing:-1px;color:${c.cta}">${esc(numero(total))}</p>
                      <p style="margin:10px 0 0;font-family:${FONTE_TEXTO};font-size:15px;line-height:23px;color:${c.texto}">no projeto <strong style="color:${c.dourado};font-weight:600">${esc(limpo(projeto))}</strong>, nos últimos ${esc(numero(janelaMinutos))} minutos.</p>
                    </td>
                  </tr>
                </table>
              </td></tr>
              ${espaco(20)}
              <tr><td>${paragrafo(
                'Estas entregas esgotaram as tentativas: as conversões correspondentes não chegaram ao destino e podem estar faltando na otimização das campanhas.',
                { topo: 0 }
              )}</td></tr>
              ${espaco(20)}
              <tr><td>${tabelaDados(linhasTabela)}</td></tr>
              ${espaco(26)}
              <tr><td>${botao({ url: urlPainel, rotulo: 'Ver logs no painel' })}</td></tr>
              <tr><td>${linkAlternativo(urlPainel, c.dourado)}</td></tr>`;

  const texto = [
    `${PRODUTO} — ALERTA — entregas mortas`,
    '',
    `${total} entrega(s) morta(s) no projeto ${limpo(projeto)}, nos últimos ${janelaMinutos} minutos.`,
    '',
    ...itens.map((i) => `  ${rotuloDestino(i.destino)}: ${i.quantidade}`),
    '',
    'Ver os logs no painel:',
    '',
    limpo(urlPainel),
    '',
    '—',
    rodapeNotificacaoTexto({ inscritoPor, urlDescadastro }),
  ].join('\n');

  return {
    assunto: assuntoSeguro(`[Alerta] ${total} ${plural(total, 'entrega morta', 'entregas mortas')} em ${limpo(projeto)}`),
    html: layoutBase({
      titulo: `Entregas mortas — ${PRODUTO}`,
      preheader: `${total} ${plural(total, 'entrega morta', 'entregas mortas')} em ${limpo(projeto)} nos últimos ${janelaMinutos} min.`,
      corpoHtml,
      rodapeHtml: rodapeNotificacao({ inscritoPor, urlDescadastro }),
    }),
    texto,
  };
}

/**
 * Abertura do alerta de falha recorrente (tipo `falha_recorrente`): um destino específico
 * de um projeto acumulou muitos erros seguidos.
 * @returns {{assunto: string, html: string, texto: string}}
 */
export function emailFalhaRecorrente({ projeto, destino, quantidade, janelaMinutos, urlPainel, inscritoPor, urlDescadastro }) {
  const rotulo = rotuloDestino(destino);
  const corpoHtml = `
              <tr><td>${faixaAdmin('Falha recorrente')}</td></tr>
              ${espaco(24)}
              <tr><td>${titulo(`${esc(rotulo)} está falhando repetidamente.`)}</td></tr>
              <tr><td>${paragrafo(
                `<strong style="color:${c.texto};font-weight:600">${esc(numero(quantidade))} ${esc(plural(quantidade, 'erro', 'erros'))}</strong> nos últimos ${esc(numero(janelaMinutos))} minutos, no projeto <strong style="color:${c.dourado};font-weight:600">${esc(limpo(projeto))}</strong>, destino <strong style="color:${c.dourado};font-weight:600">${esc(rotulo)}</strong>.`
              )}</td></tr>
              ${espaco(20)}
              <tr><td>${aviso({
                cor: c.cta,
                html: 'Volume alto de erro no mesmo destino costuma ser token expirado, credencial revogada ou o destino fora do ar — não um problema pontual de um evento. Vale checar os logs antes que a fila inteira desse destino comece a morrer.',
              })}</td></tr>
              ${espaco(24)}
              <tr><td>${botao({ url: urlPainel, rotulo: 'Ver logs no painel' })}</td></tr>
              <tr><td>${linkAlternativo(urlPainel, c.dourado)}</td></tr>`;

  const texto = [
    `${PRODUTO} — FALHA RECORRENTE`,
    '',
    `${rotulo} está falhando repetidamente no projeto ${limpo(projeto)}.`,
    `${quantidade} erro(s) nos últimos ${janelaMinutos} minutos.`,
    '',
    'Ver os logs no painel:',
    '',
    limpo(urlPainel),
    '',
    '—',
    rodapeNotificacaoTexto({ inscritoPor, urlDescadastro }),
  ].join('\n');

  return {
    assunto: assuntoSeguro(`[Alerta] ${rotulo} falhando em ${limpo(projeto)} (${numero(quantidade)} erros)`),
    html: layoutBase({
      titulo: `Falha recorrente — ${PRODUTO}`,
      preheader: `${quantidade} erros de ${rotulo} em ${limpo(projeto)} nos últimos ${janelaMinutos} min.`,
      corpoHtml,
      rodapeHtml: rodapeNotificacao({ inscritoPor, urlDescadastro }),
    }),
    texto,
  };
}

/**
 * Encerramento do alerta de falha recorrente (tipo derivado `falha_recorrente_resolvido`):
 * o destino voltou a entregar normalmente. Mesmos assinantes do alerta de abertura.
 * @returns {{assunto: string, html: string, texto: string}}
 */
export function emailFalhaResolvida({ projeto, destino, urlPainel, inscritoPor, urlDescadastro }) {
  const rotulo = rotuloDestino(destino);
  const corpoHtml = `
              <tr><td>${etiqueta({ texto: 'Normalizado', cor: c.ok })}</td></tr>
              ${espaco(18)}
              <tr><td>${titulo(`${esc(rotulo)} voltou ao normal.`)}</td></tr>
              <tr><td>${paragrafo(
                `As entregas para <strong style="color:${c.dourado};font-weight:600">${esc(rotulo)}</strong> no projeto <strong style="color:${c.dourado};font-weight:600">${esc(limpo(projeto))}</strong> pararam de acumular erro. Nenhuma ação necessária — este e-mail é só a confirmação de que o alerta anterior se resolveu sozinho.`
              )}</td></tr>
              ${espaco(24)}
              <tr><td>${botao({ url: urlPainel, rotulo: 'Ver o painel' })}</td></tr>
              <tr><td>${linkAlternativo(urlPainel, c.dourado)}</td></tr>`;

  const texto = [
    `${PRODUTO} — NORMALIZADO`,
    '',
    `${rotulo} voltou ao normal no projeto ${limpo(projeto)}. Nenhuma ação necessária.`,
    '',
    'Painel:', '', limpo(urlPainel),
    '',
    '—',
    rodapeNotificacaoTexto({ inscritoPor, urlDescadastro }),
  ].join('\n');

  return {
    assunto: assuntoSeguro(`[Resolvido] ${rotulo} normalizado em ${limpo(projeto)}`),
    html: layoutBase({
      titulo: `Normalizado — ${PRODUTO}`,
      preheader: `${rotulo} voltou a entregar normalmente em ${limpo(projeto)}.`,
      corpoHtml,
      rodapeHtml: rodapeNotificacao({ inscritoPor, urlDescadastro }),
    }),
    texto,
  };
}

/**
 * Fila de entrega represada (tipo `fila_acumulada`) — alerta de SISTEMA, não de um
 * projeto: sinal de que o worker parou ou um destino compartilhado está fora do ar.
 * @returns {{assunto: string, html: string, texto: string}}
 */
export function emailFilaAcumulada({ quantidade, limiar, minutos, urlPainel, inscritoPor, urlDescadastro }) {
  const corpoHtml = `
              <tr><td>${faixaAdmin('Alerta de sistema')}</td></tr>
              ${espaco(24)}
              <tr><td>${titulo('A fila de entrega está represada.')}</td></tr>
              <tr><td>${paragrafo(
                `<strong style="color:${c.texto};font-weight:600">${esc(numero(quantidade))} ${esc(plural(quantidade, 'entrega', 'entregas'))}</strong> aguardam há mais de ${esc(numero(minutos))} minutos — acima do limite de ${esc(numero(limiar))} configurado para este alerta.`
              )}</td></tr>
              ${espaco(20)}
              <tr><td>${aviso({
                cor: c.cta,
                html: 'Causas típicas: o processo worker parou de rodar, o banco está indisponível, ou um destino comum a muitos eventos está recusando tudo. Isto afeta TODOS os projetos ao mesmo tempo, não só um.',
              })}</td></tr>
              ${espaco(24)}
              <tr><td>${botao({ url: urlPainel, rotulo: 'Abrir o painel' })}</td></tr>
              <tr><td>${linkAlternativo(urlPainel, c.dourado)}</td></tr>`;

  const texto = [
    `${PRODUTO} — ALERTA DE SISTEMA — fila represada`,
    '',
    `${quantidade} entrega(s) aguardam há mais de ${minutos} minutos (limite: ${limiar}).`,
    'Isto afeta todos os projetos, não só um.',
    '',
    'Painel:', '', limpo(urlPainel),
    '',
    '—',
    rodapeNotificacaoTexto({ inscritoPor, urlDescadastro }),
  ].join('\n');

  return {
    assunto: assuntoSeguro(`[Alerta] Fila represada — ${numero(quantidade)} entregas aguardando`),
    html: layoutBase({
      titulo: `Fila represada — ${PRODUTO}`,
      preheader: `${quantidade} entregas aguardam há mais de ${minutos} minutos.`,
      corpoHtml,
      rodapeHtml: rodapeNotificacao({ inscritoPor, urlDescadastro }),
    }),
    texto,
  };
}

/**
 * Domínio ativo parou de resolver ou o certificado falhou (tipo `dominio_problema`).
 * @returns {{assunto: string, html: string, texto: string}}
 */
export function emailDominioProblema({ hostname, projeto, erro, urlPainel, inscritoPor, urlDescadastro }) {
  const detalhe = limpo(erro) || 'sem detalhe registrado na última verificação.';
  const corpoHtml = `
              <tr><td>${faixaAdmin('Alerta de domínio')}</td></tr>
              ${espaco(24)}
              <tr><td>${titulo(`${esc(limpo(hostname))} está com problema.`)}</td></tr>
              <tr><td>${paragrafo(
                `O domínio deixou de resolver ou o certificado TLS falhou, no projeto <strong style="color:${c.dourado};font-weight:600">${esc(limpo(projeto))}</strong>. Enquanto isso durar, o rastreamento server-side deste domínio não funciona.`
              )}</td></tr>
              ${espaco(20)}
              <tr><td>
                <p style="margin:0 0 8px;font-family:${FONTE_MONO};font-size:11px;line-height:16px;letter-spacing:1.6px;text-transform:uppercase;color:${c.apoio}">Último erro registrado</p>
                ${blocoMono(esc(detalhe))}
              </td></tr>
              ${espaco(24)}
              <tr><td>${botao({ url: urlPainel, rotulo: 'Ver domínios no painel' })}</td></tr>
              <tr><td>${linkAlternativo(urlPainel, c.dourado)}</td></tr>`;

  const texto = [
    `${PRODUTO} — ALERTA — domínio com problema`,
    '',
    `${limpo(hostname)} está com problema no projeto ${limpo(projeto)}.`,
    `Último erro: ${detalhe}`,
    '',
    'Painel:', '', limpo(urlPainel),
    '',
    '—',
    rodapeNotificacaoTexto({ inscritoPor, urlDescadastro }),
  ].join('\n');

  return {
    assunto: assuntoSeguro(`[Alerta] Domínio ${limpo(hostname)} com problema`),
    html: layoutBase({
      titulo: `Domínio com problema — ${PRODUTO}`,
      preheader: `${limpo(hostname)} (${limpo(projeto)}) parou de resolver ou o certificado falhou.`,
      corpoHtml,
      rodapeHtml: rodapeNotificacao({ inscritoPor, urlDescadastro }),
    }),
    texto,
  };
}

/** Uma linha do quadro de KPIs usado nos resumos diário/semanal. */
function linhaKpi(rotulo, valor) {
  return `
                  <tr>
                    <td style="padding:9px 0;border-bottom:1px solid ${c.linha};font-family:${FONTE_TEXTO};font-size:13px;line-height:18px;color:${c.apoio}">${esc(rotulo)}</td>
                    <td align="right" style="padding:9px 0;border-bottom:1px solid ${c.linha};font-family:${FONTE_MONO};font-size:14px;line-height:18px;color:${c.texto};text-align:right">${valor}</td>
                  </tr>`;
}

function formatarMoeda(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function formatarPct(v) {
  return `${(Number(v || 0) * 100).toFixed(1)}%`;
}

function blocoKpis(kpis) {
  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse">
                ${linhaKpi('Eventos recebidos', esc(numero(kpis.events)))}
                ${linhaKpi('Compras', esc(numero(kpis.purchases)))}
                ${linhaKpi('Receita', esc(formatarMoeda(kpis.revenue)))}
                ${linhaKpi('Ticket médio', esc(formatarMoeda(kpis.avgTicket)))}
                ${linhaKpi('Taxa de entrega', esc(formatarPct(kpis.successRate)))}
              </table>`;
}

/**
 * Resumo diário (tipo `resumo_diario`), agendado para 08h. `escopo` é o nome do projeto
 * ou "todos os projetos" (assinatura com project_id NULL agrega os dois números).
 * @returns {{assunto: string, html: string, texto: string}}
 */
export function emailResumoDiario({ escopo, data, kpis, urlPainel, inscritoPor, urlDescadastro }) {
  const corpoHtml = `
              <tr><td>${etiqueta({ texto: 'Resumo diário', cor: c.dourado })}</td></tr>
              ${espaco(18)}
              <tr><td>${titulo(`Como foi ${esc(limpo(data))}.`)}</td></tr>
              <tr><td>${paragrafo(`Fechamento de ontem para <strong style="color:${c.dourado};font-weight:600">${esc(limpo(escopo))}</strong>.`)}</td></tr>
              ${espaco(18)}
              <tr><td>${blocoKpis(kpis)}</td></tr>
              ${espaco(26)}
              <tr><td>${botao({ url: urlPainel, rotulo: 'Abrir o dashboard' })}</td></tr>
              <tr><td>${linkAlternativo(urlPainel, c.dourado)}</td></tr>`;

  const texto = [
    `${PRODUTO} — resumo diário — ${limpo(data)}`,
    '',
    `Escopo: ${limpo(escopo)}`,
    '',
    `Eventos recebidos: ${numero(kpis.events)}`,
    `Compras: ${numero(kpis.purchases)}`,
    `Receita: ${formatarMoeda(kpis.revenue)}`,
    `Ticket médio: ${formatarMoeda(kpis.avgTicket)}`,
    `Taxa de entrega: ${formatarPct(kpis.successRate)}`,
    '',
    'Dashboard:', '', limpo(urlPainel),
    '',
    '—',
    rodapeNotificacaoTexto({ inscritoPor, urlDescadastro }),
  ].join('\n');

  return {
    assunto: assuntoSeguro(`Resumo diário — ${limpo(escopo)} (${limpo(data)})`),
    html: layoutBase({
      titulo: `Resumo diário — ${PRODUTO}`,
      preheader: `${limpo(escopo)}: ${numero(kpis.purchases)} compras, ${formatarMoeda(kpis.revenue)} em receita.`,
      corpoHtml,
      rodapeHtml: rodapeNotificacao({ inscritoPor, urlDescadastro }),
    }),
    texto,
  };
}

/**
 * Resumo semanal (tipo `resumo_semanal`), agendado para segunda 08h, com comparativo
 * frente à semana anterior.
 * @returns {{assunto: string, html: string, texto: string}}
 */
export function emailResumoSemanal({ escopo, periodo, atual, anterior, urlPainel, inscritoPor, urlDescadastro }) {
  const variacao = (chave) => {
    const a = Number(atual[chave] || 0);
    const b = Number(anterior[chave] || 0);
    if (!b) return a > 0 ? 'novo' : '—';
    const pct = ((a - b) / b) * 100;
    const sinal = pct >= 0 ? '+' : '';
    return `${sinal}${pct.toFixed(0)}%`;
  };

  const corpoHtml = `
              <tr><td>${etiqueta({ texto: 'Resumo semanal', cor: c.dourado })}</td></tr>
              ${espaco(18)}
              <tr><td>${titulo(`Semana de ${esc(limpo(periodo))}.`)}</td></tr>
              <tr><td>${paragrafo(`Comparativo com a semana anterior para <strong style="color:${c.dourado};font-weight:600">${esc(limpo(escopo))}</strong>.`)}</td></tr>
              ${espaco(18)}
              <tr><td>${blocoKpis(atual)}</td></tr>
              ${espaco(14)}
              <tr><td>${paragrafo(
                `Receita: ${esc(variacao('revenue'))} · Compras: ${esc(variacao('purchases'))} · Eventos: ${esc(variacao('events'))} — frente à semana anterior.`,
                { tamanho: 13 }
              )}</td></tr>
              ${espaco(26)}
              <tr><td>${botao({ url: urlPainel, rotulo: 'Abrir o dashboard' })}</td></tr>
              <tr><td>${linkAlternativo(urlPainel, c.dourado)}</td></tr>`;

  const texto = [
    `${PRODUTO} — resumo semanal — ${limpo(periodo)}`,
    '',
    `Escopo: ${limpo(escopo)}`,
    '',
    `Eventos recebidos: ${numero(atual.events)} (${variacao('events')})`,
    `Compras: ${numero(atual.purchases)} (${variacao('purchases')})`,
    `Receita: ${formatarMoeda(atual.revenue)} (${variacao('revenue')})`,
    `Ticket médio: ${formatarMoeda(atual.avgTicket)}`,
    `Taxa de entrega: ${formatarPct(atual.successRate)}`,
    '',
    'Dashboard:', '', limpo(urlPainel),
    '',
    '—',
    rodapeNotificacaoTexto({ inscritoPor, urlDescadastro }),
  ].join('\n');

  return {
    assunto: assuntoSeguro(`Resumo semanal — ${limpo(escopo)} (${limpo(periodo)})`),
    html: layoutBase({
      titulo: `Resumo semanal — ${PRODUTO}`,
      preheader: `${limpo(escopo)}: receita ${variacao('revenue')} frente à semana anterior.`,
      corpoHtml,
      rodapeHtml: rodapeNotificacao({ inscritoPor, urlDescadastro }),
    }),
    texto,
  };
}

/**
 * E-mail de teste disparado pelo admin (POST /api/notificacoes/destinatarios/:id/teste) —
 * a pessoa confirma que o endereço está certo e que o e-mail não caiu em spam.
 * @returns {{assunto: string, html: string, texto: string}}
 */
export function emailTesteNotificacao({ nome, urlPainel, inscritoPor, urlDescadastro }) {
  const corpoHtml = `
              <tr><td>${etiqueta({ texto: 'E-mail de teste', cor: c.dourado })}</td></tr>
              ${espaco(18)}
              <tr><td>${titulo('Chegou certinho.')}</td></tr>
              <tr><td>${paragrafo(
                `Olá, ${esc(limpo(nome))}. Este é um envio de teste das notificações do ${PRODUTO} — se você está lendo isto, o endereço está correto e configurado.`
              )}</td></tr>
              ${espaco(20)}
              <tr><td>${paragrafo(
                'Quando um alerta de verdade acontecer, ele chega neste mesmo formato.',
                { tamanho: 13, topo: 0 }
              )}</td></tr>
              ${espaco(24)}
              <tr><td>${botao({ url: urlPainel, rotulo: 'Abrir o painel' })}</td></tr>
              <tr><td>${linkAlternativo(urlPainel, c.dourado)}</td></tr>`;

  const texto = [
    `${PRODUTO} — e-mail de teste`,
    '',
    `Olá, ${limpo(nome)}.`,
    '',
    `Este é um envio de teste das notificações do ${PRODUTO}. Se você está lendo isto, o`,
    'endereço está correto e configurado.',
    '',
    'Painel:', '', limpo(urlPainel),
    '',
    '—',
    rodapeNotificacaoTexto({ inscritoPor, urlDescadastro }),
  ].join('\n');

  return {
    assunto: assuntoSeguro(`Teste de notificação — ${PRODUTO}`),
    html: layoutBase({
      titulo: `Teste de notificação — ${PRODUTO}`,
      preheader: 'Envio de teste: se você está lendo isto, o endereço está certo.',
      corpoHtml,
      rodapeHtml: rodapeNotificacao({ inscritoPor, urlDescadastro }),
    }),
    texto,
  };
}
