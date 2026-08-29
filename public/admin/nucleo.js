// Painel Admin — vanilla JS, consome a API /api/*.
// Sem framework, sem build. Trata erros mostrando toasts amigaveis.
'use strict';

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Ícones desenhados, em traço único de 1.75 e herdando a cor do contexto.
// Emoji não serve aqui: cada sistema operacional desenha o seu, chega colorido
// por conta própria e some do relatório impresso — três coisas que um painel
// operacional não pode ter num indicador.
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  pulso:    svg('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  carrinho: svg('<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2 2h2l2.7 12.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L21 7H5"/>'),
  dinheiro: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>'),
  pessoa:   svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>'),
  etiqueta: svg('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V4a1.2 1.2 0 0 1 1.2-1.2h8a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.8Z"/><path d="M7.5 7.5h.01"/>'),
  certo:    svg('<path d="M21.8 10.9V12a10 10 0 1 1-5.9-9.1"/><path d="m9 11 3 3 10-10"/>'),
  alerta:   svg('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>'),
  vazio:    svg('<circle cx="12" cy="12" r="9"/>'),
};

let state = {
  projects: [],
  selectedId: null,
  project: null,   // detalhe do projeto selecionado
  user: null,      // usuario logado (GET /api/auth/me)
  servidor: null,  // { publicHost, scheme, baseUrl, ips } (GET /api/servidor)
  domains: [],     // dominios first-party do projeto selecionado
  dnsEsperado: null, // { host, ips } devolvido pela ultima verificacao de DNS
  usuarios: [],    // usuarios do painel (so carrega para admin)
};

// Papeis do painel. admin = acesso total (credenciais + gestao de usuarios);
// operador = acompanha projetos e logs, sem tocar em credencial nem em usuario.
const ROLE_LABEL = { admin: 'Administrador', operador: 'Operador' };
const ROLE_DESC = {
  admin: 'Acesso total: cria projetos, altera credenciais (Meta, Google, Postback) e gerencia os usuários do painel.',
  operador: 'Acompanha dashboard, instalação, domínios e logs. Não altera credenciais nem gerencia usuários.',
};

function isAdmin() { return !!(state.user && state.user.role === 'admin'); }

// ---------------- API helper ----------------
// X-Traker-Painel identifica a chamada como vinda do painel. As rotas de escrita exigem
// esse cabeçalho quando o painel roda em outra origem — é o que substitui a proteção do
// SameSite quando o cookie precisa ser SameSite=None. No modo mesma-origem é inofensivo.
const PAINEL_HEADER = { 'X-Traker-Painel': '1' };

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: { ...PAINEL_HEADER }, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  // Sessao ausente/expirada: manda para o login em vez de mostrar erro tecnico.
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('sessão expirada');
  }
  let data = null;
  try { data = await res.json(); } catch { /* pode nao ter corpo */ }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : `Erro ${res.status}`;
    // O status viaja junto: o console de testes precisa distinguir "faltou o
    // test_event_code" (400, tem conserto na tela) de qualquer outra falha.
    const erro = new Error(msg);
    erro.status = res.status;
    throw erro;
  }
  return data;
}

// ---------------- Sessão ----------------
async function checkSession() {
  try {
    const data = await api('/auth/me');
    state.user = data && data.user ? data.user : null;
    $('#userEmail').textContent = state.user ? state.user.email : '';
    renderUserRole();
    applyRole();
    return true;
  } catch {
    location.href = '/login';
    return false;
  }
}

// Papel do usuário logado, ao lado do e-mail no cabeçalho.
function renderUserRole() {
  const el = $('#userRole');
  if (!el) return;
  const role = state.user && state.user.role;
  el.hidden = !role;
  if (!role) return;
  el.textContent = ROLE_LABEL[role] || role;
  el.className = 'admin-user-role' + (role === 'admin' ? ' is-admin' : '');
  el.title = ROLE_DESC[role] || '';
}

// Aplica as restrições de papel na interface. Operador enxerga tudo que é de
// acompanhamento (dashboard, instalação, domínios, logs) mas não edita credencial
// nem vê a aba de usuários. É conveniência de UI — quem barra de verdade é o backend.
function applyRole() {
  const admin = isAdmin();

  const tab = $('#tabUsuarios');
  if (tab) tab.hidden = !admin;

  $$('.js-cred-note').forEach((nota) => { nota.hidden = admin; });

  for (const sel of ['#metaForm', '#googleForm', '#postbackForm']) {
    const form = $(sel);
    if (!form) continue;
    form.classList.toggle('form-readonly', !admin);
    $$('input, select, textarea, button', form).forEach((campo) => { campo.disabled = !admin; });
  }
}

// Host público e IPs deste servidor — alimentam a instrução de DNS da aba Domínios.
// Busca uma vez no boot; se falhar, a instrução cai no texto genérico.
async function loadServerInfo() {
  try {
    state.servidor = await api('/servidor');
  } catch {
    state.servidor = null;
  }
  updateDomainInstruction();
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* segue para o login mesmo assim */ }
  location.href = '/login';
}

// ---------------- Toast ----------------
function toast(message, type = 'ok', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'notice ' + type;
  el.textContent = message;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------------- Lista de projetos ----------------
async function loadProjects() {
  try {
    state.projects = await api('/projects');
    renderProjectList();
  } catch (err) {
    toast('Não foi possível carregar projetos: ' + err.message, 'err');
  }
}

function renderProjectList() {
  const ul = $('#projectList');
  ul.innerHTML = '';
  if (!state.projects.length) {
    ul.innerHTML = '<li class="empty">Nenhum projeto ainda.</li>';
    return;
  }
  for (const p of state.projects) {
    const li = document.createElement('li');
    li.className = 'project-item' + (p.id === state.selectedId ? ' active' : '');
    li.innerHTML = `<span class="p-name"></span><span class="p-domain"></span>`;
    li.querySelector('.p-name').textContent = p.name;
    li.querySelector('.p-domain').textContent = p.domain;
    li.addEventListener('click', () => selectProject(p.id));
    ul.appendChild(li);
  }
}

// ---------------- Selecionar projeto ----------------
async function selectProject(id) {
  state.selectedId = id;
  renderProjectList();
  try {
    state.project = await api('/projects/' + id);
  } catch (err) {
    toast('Erro ao abrir projeto: ' + err.message, 'err');
    return;
  }
  $('#placeholder').hidden = true;
  $('#projectView').hidden = false;
  renderProjectView();
}

// Mapa de status do projeto para a variante semântica do badge. Fora dessa lista,
// o status aparece em badge neutro em vez de sumir — status desconhecido é
// justamente o que o operador precisa ver.
const BADGE_DE_STATUS = { active: 'ok', paused: 'aviso', disabled: 'erro' };

function renderProjectView() {
  const p = state.project;
  $('#pvTitle').textContent = p.name;

  // A linha era uma string monoespaçada só: "dominio · status · project_id: prj_…".
  // Mono é ótima para identificador que se compara caractere a caractere e péssima
  // como texto de interface — dava ao cabeçalho cara de log de terminal. Agora cada
  // pedaço aparece no papel dele: domínio em texto normal, status em badge
  // semântico e o id em chip mono clicável para copiar.
  //
  // Montado por DOM, não por innerHTML: `domain` é digitado pelo operador e
  // chegaria aqui sem escape.
  const sub = $('#pvSubtitle');
  sub.textContent = '';
  sub.className = 'pvsub';

  const dominio = document.createElement('span');
  dominio.textContent = p.domain || 'sem domínio';
  sub.append(dominio);

  const status = document.createElement('span');
  status.className = `badge-sem ${BADGE_DE_STATUS[p.status] || 'info'}`;
  status.textContent = p.status;
  sub.append(status);

  const id = document.createElement('button');
  id.type = 'button';
  id.className = 'pv-id';
  id.textContent = p.id;
  id.title = 'Copiar o project_id';
  id.addEventListener('click', () => copyText(p.id, 'project_id copiado.'));
  sub.append(id);

  renderSetup(p);
  fillMetaForm(p);
  fillGoogleForm(p);
  fillPostbackForm(p);
  resetConsoleTestes(p);
  loadLogs();
  loadDashboard();
  loadEmq();
  loadDomains();
  loadMetaStatus();

  // Módulos registrados em navegacao.js (Ao vivo, Webhook Studio, etc.) reagem por aqui,
  // em vez de cada um acrescentar uma linha nesta função — ela é compartilhada por todas
  // as telas e viraria um ponto de conflito permanente.
  notificarTrocaDeProjeto(p);

  // volta sempre para a primeira aba ao trocar de projeto
  activateTab('dashboard');
}
