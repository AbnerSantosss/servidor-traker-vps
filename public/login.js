// Login / primeiro acesso / recuperacao de senha — vanilla JS, mesmo padrao do admin.js.
// Arquivo separado (nao inline): a CSP do servidor manda script-src 'self', que bloqueia
// <script> com conteudo embutido. Carregado com defer, entao roda antes do DOMContentLoaded.
'use strict';
(function () {
  const $ = (sel) => document.querySelector(sel);

  // Identifica a chamada como vinda do painel — exigido nas rotas de escrita quando o
  // painel roda em outra origem (substitui a proteção do SameSite com cookie SameSite=None).
  const PAINEL_HEADER = { 'X-Traker-Painel': '1' };

  let modo = 'login';        // 'login' | 'setup' | 'recuperar'
  let setupNecessario = false;

  function erro(msg) {
    const el = $('#authError');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function aviso(msg) {
    const el = $('#authOk');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function definirTitulo(inicio, destaque) {
    const h1 = $('#authTitle');
    h1.textContent = inicio;
    const em = document.createElement('em');
    em.textContent = destaque;
    h1.appendChild(em);
  }

  // Alterna entre "entrar", "criar primeiro acesso" (quando ainda nao existe usuario)
  // e "recuperar senha".
  function aplicarModo(novoModo) {
    modo = novoModo;
    const setup = modo === 'setup';
    const recuperar = modo === 'recuperar';

    // O título tem uma palavra em dourado (o <em>), no eco da identidade da marca.
    // Montado com nós de texto em vez de innerHTML: o conteúdo é fixo, mas manter o
    // hábito evita que alguém acrescente interpolação aqui um dia.
    definirTitulo(...(recuperar
      ? ['Recuperar ', 'acesso']
      : setup ? ['Criar ', 'primeiro acesso'] : ['Entrar no ', 'painel']));
    $('#authSub').textContent = recuperar
      ? 'Informe o e-mail da sua conta. Enviaremos um link para você definir uma nova senha.'
      : setup
        ? 'Ainda não existe nenhum usuário neste servidor. Crie o administrador — depois disso esta tela vira o login normal.'
        : 'Informe suas credenciais de administrador para continuar.';
    $('#authFoot').textContent = recuperar
      ? 'o link de redefinição vale por tempo limitado e só pode ser usado uma vez'
      : setup
        ? 'esta janela fecha sozinha assim que o primeiro usuário existir'
        : 'sessão por cookie HttpOnly · rastreamento server-side';

    $('#fieldName').hidden = !setup;
    $('#fieldConfirm').hidden = !setup;
    $('#fieldPassword').hidden = recuperar;
    // "Manter conectado" só faz sentido em login: no setup a sessão já nasce junto
    // da criação da conta, e recuperar senha não abre sessão nenhuma.
    $('#blocoRemember').hidden = setup || recuperar;
    $('#name').required = setup;
    $('#password2').required = setup;
    $('#password').required = !recuperar;
    $('#password').setAttribute('autocomplete', setup ? 'new-password' : 'current-password');
    $('#btnSubmit').textContent = recuperar ? 'Enviar link' : setup ? 'Criar acesso' : 'Entrar';
    $('#btnSubmit').disabled = false;
    $('#authForm').hidden = false;

    // O primeiro acesso nao tem senha para recuperar ainda.
    $('#linkEsqueci').hidden = setup || recuperar;
    $('#linkVoltar').hidden = !recuperar;

    document.title = recuperar
      ? 'Servidor Traker · Recuperar acesso'
      : setup ? 'Servidor Traker · Primeiro acesso' : 'Servidor Traker · Entrar';

    erro('');
    aviso('');
  }

  async function detectarModo() {
    try {
      const res = await fetch('/api/auth/setup-necessario', {
        headers: { ...PAINEL_HEADER },
        credentials: 'same-origin',
      });
      const data = await res.json();
      setupNecessario = !!(data && data.setupNecessario);
    } catch {
      setupNecessario = false; // na duvida, login normal
    }
    aplicarModo(setupNecessario ? 'setup' : 'login');
  }

  // Mostrar/ocultar senha. Alterna só o `type` do campo — a senha nunca sai do
  // input, não é copiada para lugar nenhum e o foco volta para onde o usuário estava.
  function alternarVisibilidade(idCampo, idBotao) {
    const campo = $(idCampo);
    const btn = $(idBotao);
    if (!campo || !btn) return;
    const mostrando = campo.type === 'text';
    campo.type = mostrando ? 'password' : 'text';
    btn.textContent = mostrando ? 'Mostrar' : 'Ocultar';
    btn.setAttribute('aria-pressed', mostrando ? 'false' : 'true');
    btn.setAttribute('aria-label', mostrando ? 'Mostrar a senha' : 'Ocultar a senha');
    campo.focus();
  }

  // O e-mail é lembrado entre visitas; a SENHA nunca. Quem guarda senha com
  // segurança é o gerenciador do navegador, via autocomplete — não este script.
  const EMAIL_LEMBRADO = 'traker_ultimo_email';

  function lembrarEmail(email) {
    try {
      if (email) localStorage.setItem(EMAIL_LEMBRADO, email);
      else localStorage.removeItem(EMAIL_LEMBRADO);
    } catch { /* modo anônimo ou storage bloqueado: seguir sem lembrar */ }
  }

  function preencherEmailLembrado() {
    try {
      const salvo = localStorage.getItem(EMAIL_LEMBRADO);
      if (salvo && !$('#email').value) {
        $('#email').value = salvo;
        // Com o e-mail já preenchido, o campo útil é o da senha.
        if (!$('#fieldPassword').hidden) $('#password').focus();
      }
    } catch { /* idem */ }
  }

  // Recuperacao de senha: a resposta e sempre a mesma, exista o e-mail ou nao —
  // e de proposito, para nao virar um oraculo de quais e-mails estao cadastrados.
  async function enviarRecuperacao(email) {
    const btn = $('#btnSubmit');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      await fetch('/api/auth/esqueci-senha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...PAINEL_HEADER },
        credentials: 'same-origin',
        body: JSON.stringify({ email }),
      });
    } catch {
      /* mesmo com falha de rede mantemos a mensagem neutra */
    }
    $('#authForm').hidden = true;
    $('#linkEsqueci').hidden = true;
    $('#linkVoltar').hidden = false;
    aviso('Se esse e-mail estiver cadastrado, você receberá um link em instantes.');
    $('#linkVoltar').focus();
  }

  async function enviar(e) {
    e.preventDefault();
    erro('');
    aviso('');

    const email = $('#email').value.trim();
    const password = $('#password').value;

    if (!email) { erro('Informe o e-mail.'); $('#email').focus(); return; }

    if (modo === 'recuperar') {
      await enviarRecuperacao(email);
      return;
    }

    if (!password) { erro('Informe a senha.'); $('#password').focus(); return; }

    let path = '/api/auth/login';
    // `remember` é só um booleano: quem transforma isso em prazo de sessão é o
    // servidor. Nenhuma credencial atravessa o localStorage.
    let body = { email, password, remember: $('#remember').checked };

    if (modo === 'setup') {
      const name = $('#name').value.trim();
      const confirm = $('#password2').value;
      if (!name) { erro('Informe o seu nome.'); $('#name').focus(); return; }
      if (password.length < 8) { erro('A senha precisa ter no mínimo 8 caracteres.'); $('#password').focus(); return; }
      if (password !== confirm) { erro('As senhas não conferem.'); $('#password2').focus(); return; }
      path = '/api/auth/setup';
      body = { email, password, name };
    }

    const btn = $('#btnSubmit');
    const rotulo = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Enviando…';

    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...PAINEL_HEADER },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      let data = null;
      try { data = await res.json(); } catch { /* pode nao ter corpo */ }
      if (!res.ok) throw new Error((data && data.error) ? data.error : `Erro ${res.status}`);
      lembrarEmail(email);
      location.href = '/painel';
    } catch (err) {
      erro(err.message || 'Não foi possível entrar.');
      btn.disabled = false;
      btn.textContent = rotulo;
      $('#password').focus();
      $('#password').select();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#authForm').addEventListener('submit', enviar);
    $('#pwToggle').addEventListener('click', () => alternarVisibilidade('#password', '#pwToggle'));
    $('#pwToggle2').addEventListener('click', () => alternarVisibilidade('#password2', '#pwToggle2'));
    $('#linkEsqueci').addEventListener('click', () => {
      aplicarModo('recuperar');
      $('#email').focus();
    });
    $('#linkVoltar').addEventListener('click', () => {
      aplicarModo(setupNecessario ? 'setup' : 'login');
      $('#password').value = '';
      $('#email').focus();
    });
    detectarModo().then(preencherEmailLembrado);
  });
})();
