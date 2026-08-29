// Definir senha (convite ou redefinicao) — vanilla JS, mesmo padrao do login.js.
// Arquivo separado (nao inline): a CSP do servidor manda script-src 'self', que bloqueia
// <script> com conteudo embutido. Carregado com defer, entao roda antes do DOMContentLoaded.
'use strict';
(function () {
  const $ = (sel) => document.querySelector(sel);

  // Identifica a chamada como vinda do painel — exigido nas rotas de escrita quando o
  // painel roda em outra origem (substitui a proteção do SameSite com cookie SameSite=None).
  const PAINEL_HEADER = { 'X-Traker-Painel': '1' };

  const token = new URLSearchParams(location.search).get('token') || '';

  function mostrarEstado(id) {
    for (const s of ['stateLoading', 'stateInvalid', 'stateForm']) {
      $('#' + s).hidden = (s !== id);
    }
  }

  function invalido(msg) {
    if (msg) $('#invalidMsg').textContent = msg;
    mostrarEstado('stateInvalid');
    document.title = 'Servidor Traker · Link inválido';
  }

  function erro(msg) {
    const el = $('#formError');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  // Força da senha: comprimento + variedade de caracteres. Heuristica simples e
  // honesta — serve de orientacao visual, nao e uma promessa de seguranca.
  function forcaSenha(senha) {
    let pontos = 0;
    if (senha.length >= 8) pontos++;
    if (senha.length >= 12) pontos++;
    if (/[a-z]/.test(senha) && /[A-Z]/.test(senha)) pontos++;
    if (/[0-9]/.test(senha)) pontos++;
    if (/[^A-Za-z0-9]/.test(senha)) pontos++;
    if (senha.length < 8) return { nivel: 'fraca', pct: Math.min(senha.length / 8, 1) * 30, pontos };
    if (pontos <= 2) return { nivel: 'fraca', pct: 34, pontos };
    if (pontos === 3) return { nivel: 'média', pct: 67, pontos };
    return { nivel: 'forte', pct: 100, pontos };
  }

  function atualizarForca() {
    const senha = $('#password').value;
    const caixa = $('#pwStrength');
    if (!senha) {
      caixa.hidden = true;
      return;
    }
    const f = forcaSenha(senha);
    const classe = f.nivel === 'forte' ? 'forte' : f.nivel === 'média' ? 'media' : 'fraca';
    caixa.hidden = false;
    $('#pwFill').className = 'pw-meter-fill ' + classe;
    $('#pwFill').style.width = f.pct + '%';
    $('#pwLabel').className = 'pw-label ' + classe;
    $('#pwLabel').textContent = senha.length < 8
      ? `Senha fraca — faltam ${8 - senha.length} caractere(s)`
      : 'Senha ' + f.nivel;
  }

  function alternarVisibilidade() {
    const campo = $('#password');
    const btn = $('#btnToggle');
    const mostrando = campo.type === 'text';
    campo.type = mostrando ? 'password' : 'text';
    btn.textContent = mostrando ? 'Mostrar' : 'Ocultar';
    btn.setAttribute('aria-pressed', mostrando ? 'false' : 'true');
    btn.setAttribute('aria-label', mostrando ? 'Mostrar a senha' : 'Ocultar a senha');
    campo.focus();
  }

  async function validarToken() {
    if (!token) {
      invalido('Este endereço não trouxe nenhum token. Abra o link exatamente como você recebeu no e-mail.');
      return;
    }
    let data = null;
    try {
      const res = await fetch('/api/auth/token/' + encodeURIComponent(token), {
        headers: { ...PAINEL_HEADER },
        credentials: 'same-origin',
      });
      data = await res.json();
    } catch {
      invalido('Não conseguimos falar com o servidor para validar este link. Verifique sua conexão e tente de novo.');
      return;
    }
    if (!data || data.valido === false) {
      invalido();
      return;
    }

    const convite = data.tipo === 'convite';
    $('#formTitle').textContent = convite
      ? `Bem-vindo${data.nome ? ', ' + data.nome : ''}, defina sua senha`
      : 'Defina uma nova senha';
    $('#formSub').textContent = convite
      ? 'Esta é a sua primeira entrada no painel. Escolha uma senha e você já entra direto.'
      : 'Escolha a nova senha da sua conta. Ao confirmar, você já entra no painel.';
    $('#email').value = data.email || '';
    $('#btnSubmit').textContent = convite ? 'Criar senha e entrar' : 'Salvar senha e entrar';
    document.title = convite ? 'Servidor Traker · Bem-vindo' : 'Servidor Traker · Nova senha';

    mostrarEstado('stateForm');
    $('#password').focus();
  }

  async function enviar(e) {
    e.preventDefault();
    erro('');

    const password = $('#password').value;
    const confirmacao = $('#password2').value;

    if (password.length < 8) {
      erro('A senha precisa ter no mínimo 8 caracteres.');
      $('#password').focus();
      return;
    }
    if (password !== confirmacao) {
      erro('As senhas não conferem.');
      $('#password2').focus();
      $('#password2').select();
      return;
    }

    const btn = $('#btnSubmit');
    const rotulo = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Salvando…';

    try {
      const res = await fetch('/api/auth/definir-senha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...PAINEL_HEADER },
        credentials: 'same-origin',
        body: JSON.stringify({ token, password }),
      });
      let data = null;
      try { data = await res.json(); } catch { /* pode nao ter corpo */ }
      if (!res.ok) throw new Error((data && data.error) ? data.error : `Erro ${res.status}`);
      // O backend ja cria a sessao — segue direto para o painel.
      location.href = '/painel';
    } catch (err) {
      erro(err.message || 'Não foi possível definir a senha.');
      btn.disabled = false;
      btn.textContent = rotulo;
      $('#password').focus();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#pwForm').addEventListener('submit', enviar);
    $('#password').addEventListener('input', atualizarForca);
    $('#btnToggle').addEventListener('click', alternarVisibilidade);
    validarToken();
  });
})();
