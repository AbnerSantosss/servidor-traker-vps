// Aba Domínios: por que existe, tutorial guiado, cadastro, verificação de DNS e remoção.
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// ════════════════════════════════════════════════════════════════════
// ABA DOMÍNIOS — domínios first-party do projeto
// ════════════════════════════════════════════════════════════════════
// A tela antiga jogava o formulário antes de explicar por que ele existe — quem
// nunca ouviu falar de CNAME não tinha motivo para confiar no que estava preenchendo.
// Esta versão inverte a ordem: motivo → tutorial numerado → formulário → lista com
// linha do tempo de status (em vez de um rótulo seco tipo "verified").

// Estado do domínio numa palavra, com ícone junto da cor — cor sozinha não serve para
// quem não separa verde de vermelho, e este é o selo que diz se o domínio já atende
// tráfego. A linha do tempo logo abaixo detalha em qual etapa ele parou.
const DOMAIN_STATUS = {
  pending:     { label: 'aguardando DNS', cls: 'aviso',  icone: 'clock' },
  verificando: { label: 'verificando…',   cls: 'info',   icone: 'refresh-cw' },
  verified:    { label: 'DNS verificado', cls: 'info',   icone: 'search-check' },
  active:      { label: 'ativo',          cls: 'ok',     icone: 'circle-check-big' },
  failed:      { label: 'falhou',         cls: 'erro',   icone: 'circle-x' },
};

function domSeloStatusHtml(status) {
  const s = DOMAIN_STATUS[status] || DOMAIN_STATUS.pending;
  return `<span class="badge-sem dom-selo ${s.cls}"><i data-lucide="${s.icone}" aria-hidden="true"></i>${s.label}</span>`;
}

// Troca o selo no lugar (a verificação de DNS muda o estado sem recarregar a lista).
function domAtualizarSelo(card, status) {
  const el = card && card.querySelector('.dom-selo');
  if (!el) return;
  el.outerHTML = domSeloStatusHtml(status);
  if (typeof aplicarIcones === 'function') aplicarIcones(card);
}

const POINTING_LABEL = { a_record: 'registro A', cname: 'CNAME' };

// Host do serviço, sem protocolo — é o alvo do CNAME que o cliente precisa criar.
// Prioriza o que o servidor informa; cai no base do projeto e, por último, no origin.
function baseHostname() {
  if (state.servidor && state.servidor.publicHost) return state.servidor.publicHost;
  const base = (state.project && state.project.urls && state.project.urls.base) || location.origin;
  return String(base).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

// IPs do servidor para o registro A: primeiro o /api/servidor, depois o que o último
// /verify devolveu em `esperado.ips`.
function serverIps() {
  if (state.servidor && Array.isArray(state.servidor.ips) && state.servidor.ips.length) return state.servidor.ips;
  if (state.dnsEsperado && Array.isArray(state.dnsEsperado.ips) && state.dnsEsperado.ips.length) return state.dnsEsperado.ips;
  return [];
}

// ---------------- Sugestão automática de subdomínio (Passo 1 do tutorial) ----------------

// "t." + domínio do projeto é a convenção mais comum (curta, não colide com nada do
// site) — mas é só sugestão: o campo continua editável para quem preferir outro nome.
function domSugestaoSubdominio() {
  const raw = (state.project && state.project.domain) || '';
  const host = String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host) return '';
  return host.startsWith('t.') ? host : 't.' + host;
}

function domAtualizarSugestao() {
  const sugestao = domSugestaoSubdominio();
  const span = $('#domSugestaoTexto');
  const btn = $('#btnUsarSugestaoDominio');
  if (span) span.textContent = sugestao || '—';
  if (btn) btn.hidden = !sugestao;
}

// ---------------- Carregamento e lista ----------------

// Estado vazio/erro no componente global: ícone, uma frase e uma saída (§2.9).
function domEstado(el, { icone, titulo, texto }) {
  if (!el) return;
  el.innerHTML = `
    <div class="estado-vazio">
      <span class="estado-vazio-icone"><i data-lucide="${icone}" aria-hidden="true"></i></span>
      <h4>${escHtml(titulo)}</h4>
      <p>${escHtml(texto)}</p>
    </div>`;
  if (typeof aplicarIcones === 'function') aplicarIcones(el);
}

async function loadDomains() {
  if (!state.selectedId) return;
  domAtualizarSugestao();
  const list = $('#domainList');
  // Um esqueleto do tamanho de um cartão de domínio: a lista quase sempre tem 0 ou 1
  // item, então reservar mais espaço que isso seria mentir sobre o que vem.
  list.innerHTML = '<span class="skeleton" style="height:120px"></span>';
  try {
    state.domains = await api('/projects/' + state.selectedId + '/domains');
    renderDomains();
  } catch (err) {
    domEstado(list, {
      icone: 'plug-zap',
      titulo: 'Não foi possível carregar os domínios',
      texto: err.message,
    });
  }
  updateDomainInstruction();
}

function renderDomains() {
  const list = $('#domainList');
  list.innerHTML = '';
  if (!state.domains.length) {
    domEstado(list, {
      icone: 'globe',
      titulo: 'Nenhum domínio próprio ainda',
      texto: 'O projeto continua funcionando pelo domínio deste servidor — siga o tutorial acima para apontar um subdomínio seu e ganhar cookies first-party.',
    });
    return;
  }
  for (const d of state.domains) list.appendChild(domainCard(d));
}

// ---------------- Linha do tempo de status (substitui o rótulo seco) ----------------

// 4 estágios fixos, na ordem em que acontecem de verdade no backend: o /verify marca
// "verified" assim que o DNS resolve para cá; "active" só chega quando o Caddy emite o
// certificado sob demanda na primeira requisição HTTPS de verdade — os dois últimos
// estágios (certificado emitido / ativo) acendem juntos porque é assim que o servidor
// realmente registra esse momento (ver setDomainStatus em src/admin/router.js).
const DOM_ESTAGIOS = ['pendente', 'DNS ok', 'certificado emitido', 'ativo'];

function domEstagiosConcluidos(status) {
  if (status === 'active') return 4;
  if (status === 'verified') return 2;
  return 0;
}

function domTimelineHtml(d) {
  const concluidos = domEstagiosConcluidos(d.verification_status);
  const falhou = d.verification_status === 'failed';
  const itens = DOM_ESTAGIOS.map((label, i) => {
    const feito = i < concluidos;
    const atual = i === concluidos;
    const comErro = falhou && i === 0;
    let cls = 'is-pendente';
    let icone = 'circle';
    if (feito) { cls = 'is-feito'; icone = 'circle-check-big'; }
    else if (comErro) { cls = 'is-erro'; icone = 'circle-alert'; }
    else if (atual) { cls = 'is-atual'; icone = 'circle-dot'; }
    return `<li class="dom-timeline-item ${cls}"><i data-lucide="${icone}" aria-hidden="true"></i><span>${label}</span></li>`;
  });
  return `<ol class="dom-timeline">${itens.join('')}</ol>`;
}

function domAtualizarTimeline(container, d) {
  if (!container) return;
  container.innerHTML = domTimelineHtml(d);
  if (typeof aplicarIcones === 'function') aplicarIcones(container);
}

// Traduz as strings de erro que src/tenancy/dns-check.js grava em `last_error`/`error`
// para uma frase que quem nunca configurou DNS entende — sem inventar diagnóstico:
// erro que não bate com nenhum padrão conhecido aparece cru, rotulado como tal
// (mesmo princípio do dicionário de erros da aba Falhas: honestidade > adivinhação).
function domTraduzirErro(erroCru) {
  if (!erroCru) return '';
  const apontaMatch = erroCru.match(/^aponta para (.+), esperado (.+)$/);
  if (apontaMatch) {
    return `O DNS ainda aponta para <b>${escHtml(apontaMatch[1])}</b>; o esperado é <b>${escHtml(apontaMatch[2])}</b> — a propagação pode levar de alguns minutos a algumas horas.`;
  }
  if (/não resolve/.test(erroCru)) {
    return 'O domínio ainda não responde a nenhuma consulta de DNS — confirme se o registro foi salvo no provedor e aguarde a propagação (pode levar até algumas horas).';
  }
  if (/PUBLIC_HOST não configurado/.test(erroCru)) {
    return 'Este servidor ainda não tem o host público configurado — fale com quem administra a infraestrutura.';
  }
  if (/hostname vazio/.test(erroCru)) {
    return 'Hostname vazio — isso não deveria acontecer; tente remover e adicionar o domínio de novo.';
  }
  return 'Erro não traduzido: ' + escHtml(erroCru);
}

function domainCard(d) {
  const card = document.createElement('div');
  card.className = 'dom-card';

  const head = document.createElement('div');
  head.className = 'dom-head';
  head.innerHTML = `
    <span class="dom-host"></span>
    ${domSeloStatusHtml(d.verification_status)}
    ${d.is_primary ? '<span class="badge-dev">principal</span>' : ''}
    <span class="dom-actions"></span>`;
  head.querySelector('.dom-host').textContent = d.hostname;

  const btnVerify = document.createElement('button');
  btnVerify.className = 'btn btn-ghost';
  btnVerify.type = 'button';
  btnVerify.textContent = 'Verificar DNS';

  const btnRemove = document.createElement('button');
  btnRemove.className = 'btn btn-ghost';
  btnRemove.type = 'button';
  btnRemove.textContent = 'Remover';

  head.querySelector('.dom-actions').append(btnVerify, btnRemove);
  card.appendChild(head);

  // Linha do tempo no lugar do status seco: "verified" sozinho não diz se falta o
  // certificado ou se já está tudo pronto — os 4 estágios deixam isso visível de relance.
  const timelineWrap = document.createElement('div');
  timelineWrap.className = 'dom-timeline-wrap';
  card.appendChild(timelineWrap);
  domAtualizarTimeline(timelineWrap, d);

  const meta = document.createElement('div');
  meta.className = 'dom-meta';
  meta.innerHTML = `
    <span>método: ${POINTING_LABEL[d.pointing_method] || d.pointing_method || '—'}</span>
    <span>última checagem: ${escHtml(d.last_checked_at ? fmtDate(d.last_checked_at) : 'nunca')}</span>
    <span>TLS: ${escHtml(d.ssl_issued_at ? 'emitido em ' + fmtDate(d.ssl_issued_at) : 'ainda não emitido')} <button type="button" class="ajuda" data-ajuda="certificado-tls"></button></span>`;
  card.appendChild(meta);

  if (d.last_error) {
    const err = document.createElement('div');
    err.className = 'dom-error';
    err.innerHTML = domTraduzirErro(d.last_error);
    card.appendChild(err);
  }

  const confirmBox = document.createElement('div');
  confirmBox.className = 'dom-confirm';
  confirmBox.hidden = true;
  card.appendChild(confirmBox);

  const verifyBox = document.createElement('div');
  verifyBox.className = 'dom-verify';
  verifyBox.hidden = true;
  card.appendChild(verifyBox);

  btnVerify.addEventListener('click', () => verifyDomain(d, btnVerify, verifyBox, timelineWrap, card));
  btnRemove.addEventListener('click', () => askRemoveDomain(d, confirmBox, btnRemove));

  // Os ícones dos selos e da linha do tempo só existem depois que o cartão está montado.
  if (typeof aplicarIcones === 'function') aplicarIcones(card);

  return card;
}

async function addDomain(e) {
  e.preventDefault();
  if (!state.selectedId) { toast('Selecione um projeto primeiro.', 'warn'); return; }
  const hostname = $('#domHostname').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!hostname) { toast('Informe o hostname do domínio.', 'warn'); return; }
  const pointingMethod = $('#domMethod').value;
  try {
    await api('/projects/' + state.selectedId + '/domains', { method: 'POST', body: { hostname, pointingMethod } });
    $('#domHostname').value = '';
    toast('Domínio adicionado. Crie o registro no DNS (Passo 2 acima) e clique em "Verificar DNS".', 'ok');
    loadDomains();
  } catch (err) {
    toast('Erro ao adicionar domínio: ' + err.message, 'err');
  }
}

async function verifyDomain(d, btn, box, timelineWrap, card) {
  btn.disabled = true;
  box.hidden = false;
  box.className = 'dom-verify';
  box.textContent = 'Consultando o DNS…';
  // "Verificando" é um estado de verdade (a consulta de DNS leva segundos) e o selo
  // precisa dizer isso — senão o cartão fica mostrando o estado antigo como se nada
  // estivesse acontecendo.
  domAtualizarSelo(card, 'verificando');
  try {
    const r = await api(`/projects/${state.selectedId}/domains/${d.id}/verify`, { method: 'POST' });
    if (r.esperado) {
      state.dnsEsperado = r.esperado;
      updateDomainInstruction();
    }
    box.className = 'dom-verify ' + (r.ok ? 'ok' : 'err');
    box.innerHTML = verifyResultHtml(r);
    if (typeof aplicarIcones === 'function') aplicarIcones(box);

    // Reflete na hora o status que o backend acabou de gravar.
    const novo = r.ok ? 'verified' : 'pending';
    d.verification_status = novo;
    domAtualizarTimeline(timelineWrap, d);
    domAtualizarSelo(card, novo);
    toast(r.ok ? `DNS de ${d.hostname} verificado.` : `${d.hostname} ainda não aponta para cá.`, r.ok ? 'ok' : 'warn');
  } catch (err) {
    box.className = 'dom-verify err';
    box.textContent = 'Falha ao verificar: ' + err.message;
    domAtualizarSelo(card, 'failed');
  } finally {
    btn.disabled = false;
  }
}

function verifyResultHtml(r) {
  const lista = (arr) => (arr && arr.length ? arr.map(escHtml).join(', ') : '—');
  const linhas = [
    `<b class="dom-verify-veredito ${r.ok ? 'is-ok' : 'is-warn'}"><i data-lucide="${r.ok ? 'circle-check-big' : 'triangle-alert'}" aria-hidden="true"></i>${r.ok ? 'Aponta para este servidor' : 'Ainda não aponta para este servidor'}</b>`,
    `Resolveu (A/AAAA): ${lista(r.ips)}`,
    `Resolveu (CNAME): ${lista(r.cnames)}`,
  ];
  if (r.esperado) {
    linhas.push(`Esperado: host <b>${escHtml(r.esperado.host)}</b> · IP(s) ${lista(r.esperado.ips)}`);
  }
  if (r.metodo) linhas.push(`Método detectado: ${POINTING_LABEL[r.metodo] || escHtml(r.metodo)}`);
  if (r.error) linhas.push(`<span class="dom-verify-erro">${domTraduzirErro(r.error)}</span>`);
  return linhas.join('<br>');
}

// Confirmação inline (o painel não usa confirm() nativo).
function askRemoveDomain(d, box, btnRemove) {
  if (!box.hidden) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<span></span>';
  box.querySelector('span').textContent = `Remover ${d.hostname}? O tráfego desse domínio para de ser aceito.`;

  const ok = document.createElement('button');
  ok.className = 'btn btn-primary';
  ok.type = 'button';
  ok.textContent = 'Remover mesmo assim';

  const cancel = document.createElement('button');
  cancel.className = 'btn btn-ghost';
  cancel.type = 'button';
  cancel.textContent = 'Cancelar';

  cancel.addEventListener('click', () => { box.hidden = true; box.innerHTML = ''; btnRemove.focus(); });
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    cancel.disabled = true;
    try {
      await api(`/projects/${state.selectedId}/domains/${d.id}`, { method: 'DELETE' });
      toast(`Domínio ${d.hostname} removido.`, 'ok');
      loadDomains();
    } catch (err) {
      ok.disabled = false;
      cancel.disabled = false;
      toast('Erro ao remover domínio: ' + err.message, 'err');
    }
  });

  box.append(ok, cancel);
  ok.focus();
}

// Instrução dinâmica (Passo 2 do tutorial): diz exatamente qual registro criar no DNS.
function updateDomainInstruction() {
  const el = $('#domInstruction');
  if (!el) return;
  const host = $('#domHostname').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const alvo = escHtml(host || 'seu-subdominio.exemplo.com');

  if ($('#domMethod').value === 'cname') {
    el.innerHTML = `<b>No painel de DNS do domínio:</b> crie um registro <b>CNAME</b> de <code>${alvo}</code> `
      + `apontando para <code>${escHtml(baseHostname())}</code>.`;
    return;
  }

  const ips = serverIps();
  const rotulo = ips.length > 1 ? 'os IPs do servidor' : 'o IP do servidor';
  el.innerHTML = `<b>No painel de DNS do domínio:</b> crie um registro <b>A</b> de <code>${alvo}</code> `
    + (ips.length
      ? `apontando para ${rotulo}: <code>${ips.map(escHtml).join('</code>, <code>')}</code>.`
        + (ips.length > 1 ? ' Crie um registro A para cada IP.' : '')
      : 'apontando para o IP do servidor. Clique em <b>Verificar DNS</b> em qualquer domínio já cadastrado para o painel descobrir e mostrar o IP exato.');
}

// ---------------- Bind (elemento estático do admin.html — ligado uma vez só) ----------------

const _domBtnUsarSugestao = $('#btnUsarSugestaoDominio');
if (_domBtnUsarSugestao) {
  _domBtnUsarSugestao.addEventListener('click', () => {
    const sugestao = domSugestaoSubdominio();
    if (!sugestao) return;
    $('#domHostname').value = sugestao;
    updateDomainInstruction();
  });
}
