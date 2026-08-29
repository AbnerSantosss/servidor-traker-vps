// Aba Usuários: convites, papéis e remoção (somente admin).
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// ════════════════════════════════════════════════════════════════════
// ABA USUÁRIOS — quem entra no painel (somente admin)
// ════════════════════════════════════════════════════════════════════

const USUARIO_STATUS = {
  ativo:             { label: 'ativo', cls: 'success' },
  convite_pendente:  { label: 'convite pendente', cls: 'pending' },
};

function usuarioEhVoce(u) {
  return !!(state.user && String(state.user.id) === String(u.id));
}

function rotuloUsuario(u) {
  return u.name || u.email || 'usuário';
}

async function loadUsuarios() {
  if (!isAdmin()) return;
  const body = $('#usuariosBody');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="6" class="empty">Carregando…</td></tr>';
  try {
    const lista = await api('/usuarios');
    state.usuarios = Array.isArray(lista) ? lista : [];
    renderUsuarios();
  } catch (err) {
    state.usuarios = [];
    body.innerHTML = '';
    const tr = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'empty';
    cell.textContent = 'Não foi possível carregar os usuários: ' + err.message;
    tr.appendChild(cell);
    body.appendChild(tr);
    $('#usuariosCount').textContent = '';
    toast('Erro ao carregar usuários: ' + err.message, 'err');
  }
}

function renderUsuarios() {
  const body = $('#usuariosBody');
  const lista = state.usuarios || [];
  $('#usuariosCount').textContent = lista.length ? `${lista.length} usuário(s)` : '';
  body.innerHTML = '';
  if (!lista.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">Nenhum usuário cadastrado.</td></tr>';
    return;
  }
  for (const u of lista) {
    for (const linha of usuarioRows(u)) body.appendChild(linha);
  }
}

// Devolve as duas linhas do usuário: a da tabela e a de confirmação (oculta) logo abaixo.
function usuarioRows(u) {
  const voce = usuarioEhVoce(u);
  const tr = document.createElement('tr');

  // --- Nome (+ marcador "você")
  const tdNome = document.createElement('td');
  const nome = document.createElement('span');
  nome.textContent = u.name || '—';
  tdNome.appendChild(nome);
  if (voce) {
    const tag = document.createElement('span');
    tag.className = 'badge-dev usr-voce';
    tag.textContent = 'você';
    tdNome.append(' ', tag);
  }
  tr.appendChild(tdNome);

  // --- E-mail
  tr.appendChild(td(u.email || '—'));

  // --- Papel: select inline que salva na hora via PUT
  const tdPapel = document.createElement('td');
  const select = document.createElement('select');
  select.className = 'usr-role';
  for (const [valor, rotulo] of Object.entries(ROLE_LABEL)) {
    const opt = document.createElement('option');
    opt.value = valor;
    opt.textContent = rotulo;
    select.appendChild(opt);
  }
  select.value = u.role || 'operador';
  select.setAttribute('aria-label', `Papel de ${rotuloUsuario(u)}`);
  if (voce) {
    // Rebaixar a si mesmo tira o acesso a esta tela — e o último admin ficaria sem volta.
    select.disabled = true;
    select.title = 'Você não pode alterar o próprio papel.';
  } else {
    select.addEventListener('change', () => alterarPapel(u, select));
  }
  tdPapel.appendChild(select);
  tr.appendChild(tdPapel);

  // --- Status
  const st = USUARIO_STATUS[u.status] || { label: u.status || '—', cls: 'off' };
  const tdStatus = document.createElement('td');
  const pill = document.createElement('span');
  pill.className = 'pill ' + st.cls;
  pill.textContent = st.label;
  tdStatus.appendChild(pill);
  tr.appendChild(tdStatus);

  // --- Último acesso
  tr.appendChild(td(u.last_login_at ? fmtDate(u.last_login_at) : '—'));

  // --- Linha de confirmação (inline; o painel não usa confirm() nativo)
  const trConfirm = document.createElement('tr');
  trConfirm.hidden = true;
  const tdConfirm = document.createElement('td');
  tdConfirm.colSpan = 6;
  tdConfirm.style.padding = '0 14px 12px';
  const caixaConfirm = document.createElement('div');
  caixaConfirm.className = 'usr-confirm';
  tdConfirm.appendChild(caixaConfirm);
  trConfirm.appendChild(tdConfirm);

  // --- Ações
  const tdAcoes = document.createElement('td');
  const acoes = document.createElement('div');
  acoes.className = 'usr-actions';

  if (u.status === 'convite_pendente') {
    const btnConvite = document.createElement('button');
    btnConvite.className = 'btn btn-ghost';
    btnConvite.type = 'button';
    btnConvite.textContent = 'Reenviar convite';
    btnConvite.addEventListener('click', () => reenviarConvite(u, btnConvite));
    acoes.appendChild(btnConvite);
  }

  if (!voce) {
    const btnRemover = document.createElement('button');
    btnRemover.className = 'btn btn-ghost';
    btnRemover.type = 'button';
    btnRemover.textContent = 'Remover';
    btnRemover.addEventListener('click', () => askRemoveUsuario(u, trConfirm, caixaConfirm, btnRemover));
    acoes.appendChild(btnRemover);
  }

  tdAcoes.appendChild(acoes);
  tr.appendChild(tdAcoes);
  return [tr, trConfirm];
}

async function alterarPapel(u, select) {
  const anterior = u.role;
  const novo = select.value;
  if (novo === anterior) return;
  select.disabled = true;
  try {
    const r = await api('/usuarios/' + u.id, { method: 'PUT', body: { role: novo } });
    if (r && r.user) Object.assign(u, r.user);
    else u.role = novo;
    select.value = u.role;
    toast(`${rotuloUsuario(u)} agora é ${ROLE_LABEL[u.role] || u.role}.`, 'ok');
  } catch (err) {
    select.value = anterior; // desfaz visualmente o que o backend recusou
    toast('Erro ao alterar papel: ' + err.message, 'err');
  } finally {
    select.disabled = false;
  }
}

async function reenviarConvite(u, btn) {
  btn.disabled = true;
  try {
    const r = await api(`/usuarios/${u.id}/reenviar-convite`, { method: 'POST' });
    if (r && r.enviado === false) {
      mostrarLinkConvite(r.urlConvite, u.email);
      toast('O e-mail não saiu — copie o link do convite e envie manualmente.', 'warn', 5200);
    } else {
      esconderLinkConvite();
      toast(`Convite reenviado para ${u.email}.`, 'ok');
    }
  } catch (err) {
    toast('Erro ao reenviar convite: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// Confirmação inline de remoção. O backend devolve 400 com a mensagem pronta quando
// é o próprio usuário logado ou o último admin — mostramos essa mensagem no toast.
function askRemoveUsuario(u, linha, caixa, btnRemover) {
  if (!linha.hidden) {
    linha.hidden = true;
    caixa.innerHTML = '';
    btnRemover.focus();
    return;
  }
  linha.hidden = false;
  caixa.innerHTML = '<span></span>';
  caixa.querySelector('span').textContent =
    `Remover ${rotuloUsuario(u)} (${u.email})? A pessoa perde o acesso ao painel imediatamente.`;

  const ok = document.createElement('button');
  ok.className = 'btn btn-primary';
  ok.type = 'button';
  ok.textContent = 'Remover mesmo assim';

  const cancelar = document.createElement('button');
  cancelar.className = 'btn btn-ghost';
  cancelar.type = 'button';
  cancelar.textContent = 'Cancelar';

  cancelar.addEventListener('click', () => {
    linha.hidden = true;
    caixa.innerHTML = '';
    btnRemover.focus();
  });

  ok.addEventListener('click', async () => {
    ok.disabled = true;
    cancelar.disabled = true;
    try {
      await api('/usuarios/' + u.id, { method: 'DELETE' });
      toast(`Usuário ${u.email} removido.`, 'ok');
      loadUsuarios();
    } catch (err) {
      ok.disabled = false;
      cancelar.disabled = false;
      toast(err.message, 'err');
    }
  });

  caixa.append(ok, cancelar);
  ok.focus();
}

async function convidarUsuario(e) {
  e.preventDefault();
  if (!isAdmin()) { toast('Apenas administradores podem convidar usuários.', 'err'); return; }

  const name = $('#usrName').value.trim();
  const email = $('#usrEmail').value.trim();
  const role = $('#usrRole').value;

  if (!name) { toast('Informe o nome da pessoa convidada.', 'warn'); $('#usrName').focus(); return; }
  if (!email) { toast('Informe o e-mail da pessoa convidada.', 'warn'); $('#usrEmail').focus(); return; }

  const btn = $('#usrInviteSubmit');
  btn.disabled = true;
  try {
    const r = await api('/usuarios', { method: 'POST', body: { email, name, role } });
    $('#usrInviteForm').reset();
    atualizarDescricaoPapel();
    if (r && r.conviteEnviado === false) {
      mostrarLinkConvite(r.urlConvite, email);
      toast('Usuário criado, mas o e-mail não saiu — envie o link manualmente.', 'warn', 5200);
    } else {
      esconderLinkConvite();
      toast(`Convite enviado para ${email}.`, 'ok');
    }
    loadUsuarios();
  } catch (err) {
    toast('Erro ao convidar usuário: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// Caixa copiável do link de convite — só aparece quando o e-mail não pôde ser enviado.
function mostrarLinkConvite(url, email) {
  const caixa = $('#usrInviteLink');
  if (!caixa) return;
  if (!url) {
    // Sem link não há o que copiar; avisa e não abre uma caixa vazia.
    toast(`O e-mail para ${email} não pôde ser enviado e o servidor não devolveu o link do convite.`, 'err', 5200);
    return;
  }
  $('#usrInviteUrl').textContent = url;
  $('#usrInviteMsg').textContent =
    `O convite de ${email} não saiu por e-mail. Copie o link abaixo e envie manualmente — ele dá acesso à criação da senha, então trate como segredo.`;
  caixa.hidden = false;
  caixa.scrollIntoView({ block: 'nearest' });
}

function esconderLinkConvite() {
  const caixa = $('#usrInviteLink');
  if (!caixa) return;
  caixa.hidden = true;
  $('#usrInviteUrl').textContent = '';
}

function atualizarDescricaoPapel() {
  const sel = $('#usrRole');
  const desc = $('#usrRoleDesc');
  if (!sel || !desc) return;
  desc.textContent = ROLE_DESC[sel.value] || '';
}
