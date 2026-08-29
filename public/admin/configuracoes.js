// Configurações: rodapé da sidebar, view de perfil/usuários/notificações.
// Parte do painel admin — carregado por admin.html na ordem definida lá.
//
// Configurações é uma VIEW (substitui #projectView/#placeholder), não uma aba de
// projeto — perfil, usuários e notificações não pertencem a nenhum projeto específico.
'use strict';

// ════════════════════════════════════════════════════════════════════
// ESTADO PRÓPRIO — nunca em `state` (nucleo.js): é dado deste módulo, não do projeto
// selecionado. Segue o padrão de _falhasModalEl (falhas.js) e _subNavEstado (navegacao.js).
// ════════════════════════════════════════════════════════════════════

let _cfgPerfil = null;          // último /usuarios/me carregado
let _cfgAvatarPendente;         // data-URI escolhida mas ainda não salva (undefined = sem mudança, null = remover)
let _cfgCatalogo = null;        // GET /notificacoes/catalogo, cacheado (é fechado, não muda em runtime)
let _cfgDestinatarios = [];     // última leitura de /notificacoes/destinatarios
let _cfgModalEl = null;
let _cfgModalEditandoId = null; // id do destinatário em edição, ou null (criando)

// ════════════════════════════════════════════════════════════════════
// BOOT — roda no DOMContentLoaded, ANTES do bind de main.js (que também escuta o mesmo
// evento, mas foi registrado depois: tempo-real.js e configuracoes.js carregam antes de
// main.js em admin.html — listeners do mesmo evento disparam na ordem de registro). Isso
// importa porque a migração da aba Usuários precisa acontecer antes de main.js montar os
// binds de `.tab` e do formulário de convite.
// ════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  cfgMontarRodape();
  cfgMontarView();
  cfgCarregarPerfil(); // popula rodapé + formulário de perfil assim que a sessão permitir
});

// ════════════════════════════════════════════════════════════════════
// RODAPÉ DA SIDEBAR — identidade de quem está logado + porta de entrada
// ════════════════════════════════════════════════════════════════════

function cfgMontarRodape() {
  const el = $('#rodapeUsuario');
  if (!el || el.dataset.cfgMontado) return;
  el.dataset.cfgMontado = '1';
  el.innerHTML = `
    <button type="button" class="rodape-usuario-btn" id="cfgRodapeBtn" aria-label="Abrir configurações da conta">
      <span class="rodape-avatar" id="cfgRodapeAvatar">…</span>
      <span class="rodape-info">
        <span class="rodape-nome" id="cfgRodapeNome">Carregando…</span>
        <span class="rodape-email" id="cfgRodapeEmail"></span>
      </span>
      <span class="rodape-engrenagem"><i data-lucide="settings" aria-hidden="true"></i></span>
    </button>`;
  aplicarIcones(el);
  $('#cfgRodapeBtn').addEventListener('click', cfgAbrir);
}

// Iniciais para quando não há foto — 2 letras (nome+sobrenome, ou as duas primeiras do
// que existir), sempre em maiúsculo. Evita um avatar vazio ou um "?" sem identidade.
function cfgIniciais(perfil) {
  const base = [perfil.firstName, perfil.lastName].filter(Boolean).join(' ').trim() || perfil.name || perfil.email || '';
  const partes = base.trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

function cfgRenderizarAvatarEm(el, perfil, avatarOverride) {
  if (!el) return;
  const avatar = avatarOverride !== undefined ? avatarOverride : perfil.avatar;
  if (avatar) {
    el.innerHTML = '';
    const img = document.createElement('img');
    img.src = avatar;
    img.alt = '';
    el.appendChild(img);
  } else {
    el.textContent = cfgIniciais(perfil);
  }
}

function cfgAtualizarRodape(perfil) {
  cfgRenderizarAvatarEm($('#cfgRodapeAvatar'), perfil);
  const nome = [perfil.firstName, perfil.lastName].filter(Boolean).join(' ').trim() || perfil.name || perfil.email;
  $('#cfgRodapeNome').textContent = nome;
  $('#cfgRodapeEmail').textContent = perfil.email || '';
}

// ════════════════════════════════════════════════════════════════════
// ABRIR / FECHAR A VIEW
// ════════════════════════════════════════════════════════════════════

function cfgAbrir() {
  // Configurações some do projeto por baixo — a conexão de tempo real não pode
  // continuar viva atrás de uma tela que não está mais na página (mesmo risco de
  // vazamento de conexão descrito em tempo-real.js).
  if (typeof aoVivoFechar === 'function') aoVivoFechar();

  $('#placeholder').hidden = true;
  $('#projectView').hidden = true;
  $('#viewConfiguracoes').hidden = false;

  cfgRenderizarSubnav(); // reavalia isAdmin() agora — no boot a sessão pode não ter carregado ainda
  cfgCarregarPerfil();
  const abaAtual = $('#cfgSubnav .subnav-item.is-ativo');
  if (abaAtual && abaAtual.dataset.subnavId === 'usuarios' && isAdmin()) loadUsuarios();
  if (abaAtual && abaAtual.dataset.subnavId === 'notificacoes' && isAdmin()) cfgCarregarNotificacoes();
}

function cfgFechar() {
  $('#viewConfiguracoes').hidden = true;
  if (state.selectedId) $('#projectView').hidden = false;
  else $('#placeholder').hidden = false;
}

// ════════════════════════════════════════════════════════════════════
// MONTAGEM DA VIEW — construída uma vez (fica escondida via [hidden] até cfgAbrir),
// para que a remoção da aba antiga "Usuários" já aconteça no boot, não só no primeiro
// clique na engrenagem (ver cfgMigrarUsuariosDom).
// ════════════════════════════════════════════════════════════════════

function cfgMontarView() {
  const view = $('#viewConfiguracoes');
  if (!view || view.dataset.cfgMontado) return;
  view.dataset.cfgMontado = '1';

  view.innerHTML = `
    <div class="cfg-topo">
      <button class="btn btn-ghost" type="button" id="cfgVoltar"><i data-lucide="arrow-left" aria-hidden="true"></i> Voltar aos projetos</button>
      <h2>Configurações</h2>
    </div>
    <nav id="cfgSubnav"></nav>
    <div data-subpainel="perfil" id="cfgPerfil"></div>
    <div data-subpainel="usuarios" id="cfgUsuarios" hidden></div>
    <div data-subpainel="notificacoes" id="cfgNotificacoes" hidden></div>`;
  aplicarIcones(view);
  $('#cfgVoltar').addEventListener('click', cfgFechar);

  cfgMontarPerfil();
  cfgMigrarUsuariosDom($('#cfgUsuarios'));
  cfgMontarNotificacoes();
  cfgRenderizarSubnav();
}

// Move (não clona) a marcação existente da antiga aba "Usuários" para dentro de
// Configurações — mesmos ids, mesma lógica em usuarios.js, sem reescrever nada dela e
// sem duplicar elemento algum no documento. É uma manipulação de DOM em tempo de
// execução, não uma edição do admin.html estático (fora do escopo deste agente nessa
// parte do arquivo). A aba antiga some do topo para todo mundo, admin ou operador — a
// gestão de usuários agora só existe aqui dentro, atrás do item de sub-navegação
// "Usuários" (que só aparece para admin).
function cfgMigrarUsuariosDom(destino) {
  const tabBtn = document.querySelector('.tab[data-tab="usuarios"]');
  if (tabBtn) tabBtn.remove();

  const secaoAntiga = document.querySelector('.tab-panel[data-panel="usuarios"]');
  if (!secaoAntiga || !destino) return;
  while (secaoAntiga.firstChild) destino.appendChild(secaoAntiga.firstChild);
  secaoAntiga.remove();
}

function cfgRenderizarSubnav() {
  const itens = [{ id: 'perfil', rotulo: 'Meu perfil', icone: 'user' }];
  if (isAdmin()) {
    itens.push({ id: 'usuarios', rotulo: 'Usuários', icone: 'users' });
    itens.push({ id: 'notificacoes', rotulo: 'Notificações', icone: 'bell' });
  }
  subNav('cfgSubnav', itens, { ativo: 'perfil', aoTrocar: cfgAoTrocarSubaba });
}

function cfgAoTrocarSubaba(id) {
  if (id === 'usuarios' && isAdmin()) loadUsuarios();
  if (id === 'notificacoes' && isAdmin()) cfgCarregarNotificacoes();
}

// ════════════════════════════════════════════════════════════════════
// MEU PERFIL
// ════════════════════════════════════════════════════════════════════

function cfgMontarPerfil() {
  const el = $('#cfgPerfil');
  if (!el) return;
  el.innerHTML = `
    <section class="bloco cfg-perfil">
      <div class="bloco-h">
        <span class="bloco-k">Meu perfil</span>
        <h3>Seus dados neste painel</h3>
        <p>A foto e o nome aparecem no rodapé da barra lateral e em qualquer lugar do painel que mostrar quem fez uma ação.</p>
      </div>

      <div class="cfg-avatar-row">
        <div class="cfg-avatar-preview" id="cfgAvatarPreview">…</div>
        <div class="cfg-avatar-acoes">
          <div class="cfg-avatar-botoes">
            <label class="btn btn-ghost" for="cfgAvatarInput">Escolher foto</label>
            <input type="file" id="cfgAvatarInput" accept="image/png,image/jpeg,image/webp" hidden />
            <button class="btn btn-ghost" type="button" id="cfgAvatarRemover" hidden>Remover foto</button>
            <button type="button" class="ajuda" data-ajuda="cfg-avatar-upload"></button>
          </div>
          <p class="desc" id="cfgAvatarInfo">PNG, JPEG ou WEBP. É redimensionada para 256×256 e comprimida no seu navegador antes de enviar (o servidor recusa fotos acima de 128 KB).</p>
        </div>
      </div>

      <form id="cfgPerfilForm">
        <div class="row">
          <div class="field"><label for="cfgFirstName">Nome</label><input type="text" id="cfgFirstName" autocomplete="given-name" /></div>
          <div class="field"><label for="cfgLastName">Sobrenome</label><input type="text" id="cfgLastName" autocomplete="family-name" /></div>
        </div>
        <div class="row">
          <div class="field"><label for="cfgEmail">E-mail</label><input type="email" id="cfgEmail" disabled /></div>
          <div class="field"><label for="cfgPapel">Papel <button type="button" class="ajuda" data-ajuda="papeis-usuario"></button></label><input type="text" id="cfgPapel" disabled /></div>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">Salvar perfil</button>
          <button class="btn btn-ghost" type="button" id="cfgBtnTrocarSenha">Trocar senha <button type="button" class="ajuda" data-ajuda="cfg-trocar-senha"></button></button>
        </div>
      </form>
    </section>`;
  aplicarIcones(el);

  $('#cfgAvatarInput').addEventListener('change', cfgAoEscolherAvatar);
  $('#cfgAvatarRemover').addEventListener('click', cfgRemoverAvatar);
  $('#cfgPerfilForm').addEventListener('submit', cfgSalvarPerfil);
  $('#cfgBtnTrocarSenha').addEventListener('click', cfgTrocarSenha);
}

async function cfgCarregarPerfil() {
  try {
    const r = await api('/usuarios/me');
    _cfgPerfil = r.user;
    cfgAplicarPerfil(_cfgPerfil);
  } catch {
    // Sessão ainda não pronta (boot muito cedo) ou erro de rede — o rodapé fica com o
    // "Carregando…" e tenta de novo na próxima vez que Configurações for aberta.
  }
}

function cfgAplicarPerfil(perfil) {
  cfgAtualizarRodape(perfil);
  cfgRenderizarAvatarEm($('#cfgAvatarPreview'), perfil);
  $('#cfgAvatarRemover').hidden = !perfil.avatar;
  $('#cfgFirstName').value = perfil.firstName || '';
  $('#cfgLastName').value = perfil.lastName || '';
  $('#cfgEmail').value = perfil.email || '';
  $('#cfgPapel').value = ROLE_LABEL[perfil.role] || perfil.role || '';
}

// ---------------- avatar: recorte central + redimensionamento + compressão no navegador ----------------

// Carrega o arquivo como data-URI (FileReader), não como blob: (URL.createObjectURL) —
// a CSP deste painel é `img-src 'self' data:` (ver src/admin/seguranca.js), sem `blob:`
// na lista. Uma <img>/Image() apontando para um blob: URL é bloqueada silenciosamente
// pelo navegador e só aparece como onerror, sem mensagem no console que aponte a causa.
function cfgCarregarImagem(file) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('não foi possível ler a imagem escolhida'));
      img.src = leitor.result;
    };
    leitor.onerror = () => reject(new Error('não foi possível ler o arquivo escolhido'));
    leitor.readAsDataURL(file);
  });
}

function cfgTelaParaBlob(tela, tipo, qualidade) {
  return new Promise((resolve) => tela.toBlob(resolve, tipo, qualidade));
}

function cfgBlobParaDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('falha ao converter a imagem processada'));
    reader.readAsDataURL(blob);
  });
}

const CFG_AVATAR_LADO = 256;
const CFG_AVATAR_MAX_BYTES = 128 * 1024; // mesmo teto validado em src/db/repos/users.js

/**
 * Recorta ao quadrado central, redimensiona para 256×256 e comprime em WEBP, baixando a
 * qualidade até caber no teto de 128 KB do servidor. Sem isso, qualquer foto tirada por
 * um celular atual (que já nasce grande mesmo em baixa resolução) seria rejeitada.
 */
async function cfgProcessarAvatar(file) {
  const img = await cfgCarregarImagem(file);
  const tela = document.createElement('canvas');
  tela.width = CFG_AVATAR_LADO;
  tela.height = CFG_AVATAR_LADO;
  const ctx = tela.getContext('2d');
  const lado = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - lado) / 2;
  const sy = (img.naturalHeight - lado) / 2;
  ctx.drawImage(img, sx, sy, lado, lado, 0, 0, CFG_AVATAR_LADO, CFG_AVATAR_LADO);

  let qualidade = 0.9;
  let blob = await cfgTelaParaBlob(tela, 'image/webp', qualidade);
  while (blob && blob.size > CFG_AVATAR_MAX_BYTES && qualidade > 0.35) {
    qualidade -= 0.12;
    blob = await cfgTelaParaBlob(tela, 'image/webp', qualidade);
  }
  if (!blob || blob.size > CFG_AVATAR_MAX_BYTES) {
    throw new Error('não foi possível comprimir a foto abaixo de 128 KB — tente uma imagem mais simples');
  }
  const dataUri = await cfgBlobParaDataUri(blob);
  return { dataUri, tamanho: blob.size };
}

async function cfgAoEscolherAvatar(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const info = $('#cfgAvatarInfo');
  const original = info.textContent;
  info.textContent = 'Processando imagem…';
  try {
    const { dataUri, tamanho } = await cfgProcessarAvatar(file);
    _cfgAvatarPendente = dataUri;
    cfgRenderizarAvatarEm($('#cfgAvatarPreview'), _cfgPerfil || {}, dataUri);
    $('#cfgAvatarRemover').hidden = false;
    info.textContent = `Pronta para salvar — ${Math.ceil(tamanho / 1024)} KB depois de redimensionada e comprimida. Clique em "Salvar perfil" para confirmar.`;
  } catch (err) {
    toast('Erro ao processar a foto: ' + err.message, 'err');
    info.textContent = original;
  } finally {
    e.target.value = ''; // permite escolher o mesmo arquivo de novo, se precisar tentar outra vez
  }
}

function cfgRemoverAvatar() {
  _cfgAvatarPendente = null;
  cfgRenderizarAvatarEm($('#cfgAvatarPreview'), _cfgPerfil || {}, null);
  $('#cfgAvatarRemover').hidden = true;
  $('#cfgAvatarInfo').textContent = 'A foto será removida ao salvar o perfil.';
}

async function cfgSalvarPerfil(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  const body = {
    firstName: $('#cfgFirstName').value.trim(),
    lastName: $('#cfgLastName').value.trim(),
  };
  if (_cfgAvatarPendente !== undefined) body.avatar = _cfgAvatarPendente;
  try {
    const r = await api('/usuarios/me', { method: 'PUT', body });
    _cfgAvatarPendente = undefined;
    _cfgPerfil = r.user;
    cfgAplicarPerfil(_cfgPerfil);
    toast('Perfil salvo.', 'ok');
  } catch (err) {
    toast('Erro ao salvar perfil: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function cfgTrocarSenha() {
  const btn = $('#cfgBtnTrocarSenha');
  btn.disabled = true;
  try {
    const r = await api('/usuarios/me/trocar-senha', { method: 'POST' });
    if (r.enviado === false) {
      toast('O e-mail não saiu (' + (r.motivo || 'motivo desconhecido') + '). Link de redefinição: ' + (r.urlRedefinicao || '—'), 'warn', 7000);
    } else {
      toast('E-mail de redefinição enviado para o seu endereço cadastrado.', 'ok');
    }
  } catch (err) {
    toast('Erro ao solicitar troca de senha: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ════════════════════════════════════════════════════════════════════
// NOTIFICAÇÕES — destinatários (internos e externos) e suas assinaturas
// ════════════════════════════════════════════════════════════════════

function cfgMontarNotificacoes() {
  const el = $('#cfgNotificacoes');
  if (!el) return;
  el.innerHTML = `
    <section class="bloco">
      <div class="bloco-h">
        <span class="bloco-k">Notificações por e-mail</span>
        <h3>Quem recebe o quê</h3>
        <p>
          Pessoas <b>sem acesso a este painel</b> também podem receber notificações — cadastre-as como
          destinatário externo, com nome e e-mail. Elas nunca fazem login aqui, só recebem e-mail.
          <button type="button" class="ajuda" data-ajuda="notif-destinatario-externo"></button>
        </p>
      </div>
      <div class="form-actions" style="margin-top:0">
        <button class="btn btn-primary" type="button" id="cfgBtnNovoDestinatario">+ Adicionar pessoa</button>
        <button class="btn btn-ghost" type="button" id="cfgBtnRecarregarNotif">Recarregar</button>
        <span class="muted" id="cfgNotifCount"></span>
      </div>
      <div class="table-wrap">
        <table id="cfgNotifTable">
          <thead><tr><th>Nome</th><th>E-mail</th><th>Tipo</th><th>Assinaturas</th><th></th></tr></thead>
          <tbody id="cfgNotifBody"><tr><td colspan="5" class="empty">Carregando…</td></tr></tbody>
        </table>
      </div>
    </section>`;
  $('#cfgBtnNovoDestinatario').addEventListener('click', () => cfgAbrirModalNotif(null));
  $('#cfgBtnRecarregarNotif').addEventListener('click', cfgCarregarNotificacoes);
}

async function cfgGarantirCatalogo() {
  if (_cfgCatalogo) return _cfgCatalogo;
  _cfgCatalogo = await api('/notificacoes/catalogo');
  return _cfgCatalogo;
}

async function cfgCarregarNotificacoes() {
  if (!isAdmin()) return; // a interface não oferece isto a operador — dobra a checagem do servidor
  const body = $('#cfgNotifBody');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="5" class="empty">Carregando…</td></tr>';
  try {
    await cfgGarantirCatalogo();
    _cfgDestinatarios = await api('/notificacoes/destinatarios');
    cfgRenderizarNotificacoes();
  } catch (err) {
    body.innerHTML = '';
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.colSpan = 5; td1.className = 'empty'; td1.textContent = 'Erro ao carregar: ' + err.message;
    tr.appendChild(td1); body.appendChild(tr);
    $('#cfgNotifCount').textContent = '';
    toast('Erro ao carregar destinatários: ' + err.message, 'err');
  }
}

function cfgNomeProjeto(id) {
  if (id === null || id === undefined) return 'todos os projetos';
  const p = (state.projects || []).find((x) => String(x.id) === String(id));
  return p ? p.name : `projeto #${id}`;
}

function cfgResumoAssinaturas(assinaturas) {
  if (!assinaturas || !assinaturas.length) return '<span class="muted">nenhuma</span>';
  const catalogo = _cfgCatalogo || [];
  return assinaturas.map((a) => {
    const tipo = catalogo.find((t) => t.tipo === a.tipo);
    const rotulo = tipo ? tipo.rotulo : a.tipo;
    const escopo = tipo && tipo.porProjeto ? ` (${escHtml(cfgNomeProjeto(a.projectId))})` : '';
    return `<span class="cfg-notif-chip">${escHtml(rotulo)}${escopo}</span>`;
  }).join(' ');
}

function cfgRenderizarNotificacoes() {
  const body = $('#cfgNotifBody');
  const lista = _cfgDestinatarios || [];
  $('#cfgNotifCount').textContent = lista.length ? `${lista.length} destinatário(s)` : '';
  if (!lista.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Nenhum destinatário cadastrado ainda.</td></tr>';
    return;
  }
  body.innerHTML = lista.map((d) => `
    <tr>
      <td>${escHtml(d.nome)}</td>
      <td>${escHtml(d.email)}</td>
      <td><span class="pill ${d.interno ? 'info' : 'success'}">${d.interno ? 'interno' : 'externo'}</span></td>
      <td>${cfgResumoAssinaturas(d.assinaturas)}</td>
      <td class="cfg-notif-acoes">
        <button type="button" class="btn btn-ghost" data-notif-editar="${d.id}">Editar</button>
        <button type="button" class="btn btn-ghost" data-notif-teste="${d.id}">Enviar teste</button>
        <button type="button" class="btn btn-ghost" data-notif-remover="${d.id}">Remover</button>
      </td>
    </tr>
    <tr class="usr-confirm-row" id="cfgNotifConfirm${d.id}" hidden><td colspan="5" style="padding:0 14px 12px"><div class="usr-confirm" id="cfgNotifConfirmBox${d.id}"></div></td></tr>
  `).join('');

  body.querySelectorAll('[data-notif-editar]').forEach((btn) => {
    btn.addEventListener('click', () => cfgAbrirModalNotif(Number(btn.dataset.notifEditar)));
  });
  body.querySelectorAll('[data-notif-teste]').forEach((btn) => {
    btn.addEventListener('click', () => cfgEnviarTeste(Number(btn.dataset.notifTeste), btn));
  });
  body.querySelectorAll('[data-notif-remover]').forEach((btn) => {
    btn.addEventListener('click', () => cfgConfirmarRemocao(Number(btn.dataset.notifRemover), btn));
  });
}

async function cfgEnviarTeste(id, btn) {
  btn.disabled = true;
  try {
    const r = await api('/notificacoes/destinatarios/' + id + '/teste', { method: 'POST' });
    toast(r.enviado === false ? 'Não foi possível enviar (' + (r.motivo || 'motivo desconhecido') + ').' : 'E-mail de teste enviado.', r.enviado === false ? 'warn' : 'ok');
  } catch (err) {
    toast('Erro ao enviar teste: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function cfgConfirmarRemocao(id, btnRemover) {
  const linha = $('#cfgNotifConfirm' + id);
  const caixa = $('#cfgNotifConfirmBox' + id);
  if (!linha || !caixa) return;
  if (!linha.hidden) { linha.hidden = true; caixa.innerHTML = ''; btnRemover.focus(); return; }

  const d = (_cfgDestinatarios || []).find((x) => x.id === id);
  linha.hidden = false;
  caixa.innerHTML = '<span></span>';
  caixa.querySelector('span').textContent = `Remover ${d ? d.nome : 'este destinatário'}? Ele para de receber qualquer notificação imediatamente.`;

  const ok = document.createElement('button');
  ok.className = 'btn btn-primary'; ok.type = 'button'; ok.textContent = 'Remover mesmo assim';
  const cancelar = document.createElement('button');
  cancelar.className = 'btn btn-ghost'; cancelar.type = 'button'; cancelar.textContent = 'Cancelar';

  cancelar.addEventListener('click', () => { linha.hidden = true; caixa.innerHTML = ''; btnRemover.focus(); });
  ok.addEventListener('click', async () => {
    ok.disabled = true; cancelar.disabled = true;
    try {
      await api('/notificacoes/destinatarios/' + id, { method: 'DELETE' });
      toast('Destinatário removido.', 'ok');
      cfgCarregarNotificacoes();
    } catch (err) {
      ok.disabled = false; cancelar.disabled = false;
      toast('Erro ao remover: ' + err.message, 'err');
    }
  });

  caixa.append(ok, cancelar);
  ok.focus();
}

// ---------------- modal "adicionar pessoa" / editar ----------------

function _cfgGarantirModal() {
  if (_cfgModalEl) return _cfgModalEl;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'cfgNotifModalBackdrop';
  backdrop.innerHTML = `
    <div class="modal modal--notif">
      <h3 id="cfgNotifModalTitulo">Adicionar pessoa</h3>

      <div class="cfg-notif-tipo-pessoa" id="cfgNotifTipoPessoa" role="radiogroup" aria-label="Tipo de destinatário">
        <label><input type="radio" name="cfgNotifTipoPessoa" value="interno" checked /> Usuário existente do painel</label>
        <label><input type="radio" name="cfgNotifTipoPessoa" value="externo" /> Pessoa externa (sem acesso ao painel)</label>
      </div>

      <div class="field" id="cfgNotifCampoUsuario">
        <label for="cfgNotifUsuarioSel">Usuário</label>
        <select id="cfgNotifUsuarioSel"></select>
      </div>

      <div class="row" id="cfgNotifCamposExterno" hidden>
        <div class="field"><label for="cfgNotifNome">Nome</label><input type="text" id="cfgNotifNome" /></div>
        <div class="field"><label for="cfgNotifEmail">E-mail</label><input type="email" id="cfgNotifEmail" /></div>
      </div>

      <p class="callout amber" id="cfgNotifAvisoExterno" hidden>
        Pessoas externas recebem estas notificações por e-mail <b>sem ter acesso ao painel</b> — nenhum login é criado para elas.
      </p>

      <div class="field">
        <label>Notificações</label>
        <div id="cfgNotifTiposLista" class="cfg-notif-tipos"></div>
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" type="button" id="cfgNotifModalSalvar">Salvar</button>
        <button class="btn btn-ghost" type="button" id="cfgNotifModalCancelar">Cancelar</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  backdrop.querySelector('#cfgNotifModalCancelar').addEventListener('click', _cfgFecharModalNotif);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) _cfgFecharModalNotif(); });
  backdrop.querySelector('#cfgNotifTipoPessoa').addEventListener('change', cfgAoTrocarTipoPessoa);
  backdrop.querySelector('#cfgNotifTiposLista').addEventListener('change', (e) => {
    if (!e.target.classList.contains('cfg-notif-tipo-check')) return;
    const sel = backdrop.querySelector(`.cfg-notif-tipo-projeto[data-notif-projeto-de="${CSS.escape(e.target.dataset.notifTipo)}"]`);
    if (sel) sel.disabled = !e.target.checked;
  });
  backdrop.querySelector('#cfgNotifModalSalvar').addEventListener('click', cfgNotifSalvar);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _cfgModalEl && _cfgModalEl.classList.contains('open')) _cfgFecharModalNotif();
  });

  _cfgModalEl = backdrop;
  return backdrop;
}

function cfgAoTrocarTipoPessoa() {
  const tipo = document.querySelector('input[name=cfgNotifTipoPessoa]:checked').value;
  $('#cfgNotifCampoUsuario').hidden = tipo !== 'interno';
  $('#cfgNotifCamposExterno').hidden = tipo !== 'externo';
  $('#cfgNotifAvisoExterno').hidden = tipo !== 'externo';
}

async function cfgPreencherSelectUsuarios() {
  const sel = $('#cfgNotifUsuarioSel');
  sel.innerHTML = '<option value="">Carregando…</option>';
  try {
    const usuarios = await api('/usuarios');
    sel.innerHTML = usuarios.map((u) => `<option value="${u.id}">${escHtml(u.name || u.email)} (${escHtml(u.email)})</option>`).join('')
      || '<option value="">Nenhum usuário cadastrado</option>';
  } catch (err) {
    sel.innerHTML = '<option value="">Erro ao carregar usuários</option>';
    toast('Erro ao carregar usuários: ' + err.message, 'err');
  }
}

function cfgNotifTiposHtml(catalogo, assinaturasAtuais) {
  const porTipo = new Map((assinaturasAtuais || []).map((a) => [a.tipo, a.projectId]));
  return catalogo.map((t) => {
    const marcado = porTipo.has(t.tipo);
    const projetoAtual = porTipo.get(t.tipo);
    const seletor = t.porProjeto ? `
      <select class="cfg-notif-tipo-projeto" data-notif-projeto-de="${escHtml(t.tipo)}" ${marcado ? '' : 'disabled'}>
        <option value="">Todos os projetos</option>
        ${(state.projects || []).map((p) => `<option value="${p.id}" ${String(projetoAtual) === String(p.id) ? 'selected' : ''}>${escHtml(p.name)}</option>`).join('')}
      </select>` : '';
    return `
      <div class="cfg-notif-tipo-item">
        <label>
          <input type="checkbox" class="cfg-notif-tipo-check" data-notif-tipo="${escHtml(t.tipo)}" ${marcado ? 'checked' : ''} />
          <span><b>${escHtml(t.rotulo)} <button type="button" class="ajuda" data-ajuda="notif-tipo-${escHtml(t.tipo)}"></button></b><small>${escHtml(t.descricao)}</small></span>
        </label>
        ${seletor}
      </div>`;
  }).join('');
}

async function cfgAbrirModalNotif(id) {
  const backdrop = _cfgGarantirModal();
  const destinatario = id ? (_cfgDestinatarios || []).find((d) => d.id === id) : null;
  _cfgModalEditandoId = destinatario ? destinatario.id : null;
  const catalogo = await cfgGarantirCatalogo();

  $('#cfgNotifModalTitulo').textContent = destinatario ? 'Editar destinatário' : 'Adicionar pessoa';
  const grupoTipo = $('#cfgNotifTipoPessoa');

  if (destinatario) {
    grupoTipo.hidden = true;
    $('#cfgNotifCampoUsuario').hidden = true;
    $('#cfgNotifCamposExterno').hidden = false;
    $('#cfgNotifAvisoExterno').hidden = destinatario.interno;
    $('#cfgNotifNome').value = destinatario.nome || '';
    $('#cfgNotifEmail').value = destinatario.email || '';
  } else {
    grupoTipo.hidden = false;
    $('#cfgNotifNome').value = '';
    $('#cfgNotifEmail').value = '';
    document.querySelector('input[name=cfgNotifTipoPessoa][value=interno]').checked = true;
    await cfgPreencherSelectUsuarios();
    cfgAoTrocarTipoPessoa();
  }

  $('#cfgNotifTiposLista').innerHTML = cfgNotifTiposHtml(catalogo, destinatario ? destinatario.assinaturas : []);
  backdrop.classList.add('open');
}

function _cfgFecharModalNotif() {
  if (_cfgModalEl) _cfgModalEl.classList.remove('open');
  _cfgModalEditandoId = null;
}

async function cfgNotifSalvar() {
  const assinaturas = [];
  $$('.cfg-notif-tipo-check', _cfgModalEl).forEach((chk) => {
    if (!chk.checked) return;
    const tipo = chk.dataset.notifTipo;
    const sel = _cfgModalEl.querySelector(`.cfg-notif-tipo-projeto[data-notif-projeto-de="${CSS.escape(tipo)}"]`);
    assinaturas.push({ tipo, projectId: sel && sel.value ? Number(sel.value) : null });
  });
  if (!assinaturas.length) { toast('Marque ao menos uma notificação.', 'warn'); return; }

  let body;
  if (_cfgModalEditandoId) {
    body = { nome: $('#cfgNotifNome').value.trim(), email: $('#cfgNotifEmail').value.trim(), assinaturas };
  } else {
    const tipoPessoa = document.querySelector('input[name=cfgNotifTipoPessoa]:checked').value;
    if (tipoPessoa === 'interno') {
      const userId = $('#cfgNotifUsuarioSel').value;
      if (!userId) { toast('Escolha um usuário existente.', 'warn'); return; }
      body = { userId: Number(userId), assinaturas };
    } else {
      const nome = $('#cfgNotifNome').value.trim();
      const email = $('#cfgNotifEmail').value.trim();
      if (!nome || !email) { toast('Informe nome e e-mail da pessoa externa.', 'warn'); return; }
      body = { nome, email, assinaturas };
    }
  }

  const btn = $('#cfgNotifModalSalvar');
  btn.disabled = true;
  try {
    if (_cfgModalEditandoId) {
      await api('/notificacoes/destinatarios/' + _cfgModalEditandoId, { method: 'PUT', body });
      toast('Destinatário atualizado.', 'ok');
    } else {
      await api('/notificacoes/destinatarios', { method: 'POST', body });
      toast('Destinatário adicionado.', 'ok');
    }
    _cfgFecharModalNotif();
    cfgCarregarNotificacoes();
  } catch (err) {
    toast('Erro ao salvar destinatário: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}
