// Roteamento das abas do painel.
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// ---------------- Abas ----------------

// Pontos de extensão para os módulos de aba.
//
// Sem isto, toda tela nova precisaria acrescentar um `if (name === 'x')` aqui e uma
// chamada no boot — dois arquivos compartilhados que todo mundo edita ao mesmo tempo, com
// o resultado previsível de um sobrescrever o outro. Com o registro, cada módulo declara
// sozinho o que fazer quando a sua aba abre e quando o projeto muda, no próprio arquivo.
//
// O callback é chamado dentro de try/catch: uma aba que quebra ao abrir não pode impedir a
// troca de aba nem derrubar as outras telas.
const _aoAbrirAba = new Map();   // nome da aba -> [callback]
const _aoTrocarProjeto = [];     // [callback(projeto)]

function registrarAoAbrirAba(nome, callback) {
  if (!_aoAbrirAba.has(nome)) _aoAbrirAba.set(nome, []);
  _aoAbrirAba.get(nome).push(callback);
}

function registrarAoTrocarProjeto(callback) {
  _aoTrocarProjeto.push(callback);
}

function notificarTrocaDeProjeto(projeto) {
  for (const cb of _aoTrocarProjeto) {
    try { cb(projeto); } catch (e) { console.error('[painel] erro ao reagir à troca de projeto', e); }
  }
}

function activateTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((pan) => pan.classList.toggle('active', pan.dataset.panel === name));
  // A lista de usuários não é do projeto: carrega ao abrir a aba, sempre fresca.
  if (name === 'usuarios') loadUsuarios();
  // Os modelos de payload só são buscados quando o console é aberto de fato.
  if (name === 'testar') carregarModelosTeste();
  // O cartão de estado da Meta mostra a taxa de sucesso dos envios: revalida ao abrir.
  if (name === 'meta') loadMetaStatus();

  for (const cb of _aoAbrirAba.get(name) || []) {
    try { cb(name); } catch (e) { console.error(`[painel] erro ao abrir a aba ${name}`, e); }
  }
}

// ---------------- Sub-navegação reutilizável ----------------
// As abas Meta/Google/Configurações (fases seguintes) vão ter sub-seções internas
// (ex.: "Credenciais" / "Mapeamento" / "Falhas"). Em vez de cada uma reimplementar o
// próprio conjunto de abinhas, este componente cuida do HTML, do teclado e de qual
// [data-subpainel] fica visível — quem chama só descreve os itens.

// Item ativo de cada sub-nav, por uma chave estável (id do elemento). Guardado aqui —
// não no DOM — porque trocar de aba principal reconstrói o painel ao redor, mas o
// módulo continua vivo, então é o único lugar em que "o operador estava na sub-aba
// Falhas" sobrevive à troca.
const _subNavEstado = new Map();
// Itens e callback de cada sub-nav renderizada, para o clique/teclado saberem o que
// fazer sem precisar re-receber esses dados a cada interação.
const _subNavDados = new WeakMap();

function _subNavResolveContainer(containerOuId) {
  return typeof containerOuId === 'string' ? document.getElementById(containerOuId) : containerOuId;
}

function _subNavChave(container) {
  return container.id || container;
}

/**
 * Renderiza (ou re-renderiza, preservando a escolha do operador) uma sub-navegação.
 * `itens`: [{ id, rotulo, icone, badge }]. `ativo` só decide a seleção inicial — depois
 * disso quem manda é o estado guardado em _subNavEstado. `aoTrocar(id)` é chamado toda
 * vez que a sub-aba muda, inclusive na renderização inicial.
 */
function subNav(containerOuId, itens, { ativo, aoTrocar } = {}) {
  const container = _subNavResolveContainer(containerOuId);
  if (!container || !Array.isArray(itens) || !itens.length) return;
  const chave = _subNavChave(container);

  const salvo = _subNavEstado.get(chave);
  const idAtivo = itens.some((i) => i.id === salvo)
    ? salvo
    : (itens.some((i) => i.id === ativo) ? ativo : itens[0].id);

  _subNavDados.set(container, { itens, aoTrocar });
  _subNavGarantirListeners(container);
  _subNavRenderizar(container, idAtivo);
}

function _subNavRenderizar(container, idAtivo) {
  const dados = _subNavDados.get(container);
  if (!dados) return;
  const { itens, aoTrocar } = dados;
  _subNavEstado.set(_subNavChave(container), idAtivo);

  container.classList.add('subnav');
  container.setAttribute('role', 'tablist');
  container.innerHTML = '';

  for (const item of itens) {
    const ehAtivo = item.id === idAtivo;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'subnav-item' + (ehAtivo ? ' is-ativo' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', ehAtivo ? 'true' : 'false');
    btn.tabIndex = ehAtivo ? 0 : -1;
    btn.dataset.subnavId = item.id;

    if (item.icone) {
      const ic = document.createElement('i');
      ic.setAttribute('data-lucide', item.icone);
      ic.setAttribute('aria-hidden', 'true');
      btn.appendChild(ic);
    }

    const rotulo = document.createElement('span');
    rotulo.className = 'subnav-rotulo';
    rotulo.textContent = item.rotulo;
    rotulo.dataset.rotuloBase = item.rotulo;
    btn.appendChild(rotulo);

    const badge = document.createElement('span');
    badge.className = 'subnav-badge';
    badge.dataset.subnavBadge = item.id;
    const temBadge = item.badge !== undefined && item.badge !== null && item.badge !== 0;
    badge.hidden = !temBadge;
    if (temBadge) badge.textContent = String(item.badge);
    btn.appendChild(badge);

    container.appendChild(btn);
  }

  if (typeof aplicarIcones === 'function') aplicarIcones(container);
  _subNavMostrarPainel(container, itens, idAtivo);
  if (typeof aoTrocar === 'function') aoTrocar(idAtivo);
}

// Os painéis (`[data-subpainel="id"]`) normalmente vivem na mesma aba principal que a
// sub-nav, não necessariamente dentro dela — por isso a busca sobe até o .tab-panel
// mais próximo em vez de se limitar aos filhos do próprio <nav>.
function _subNavMostrarPainel(container, itens, idAtivo) {
  const escopo = container.closest('.tab-panel') || container.parentElement || document;
  for (const item of itens) {
    const painel = escopo.querySelector(`[data-subpainel="${item.id}"]`);
    if (painel) painel.hidden = item.id !== idAtivo;
  }
}

function _subNavAtivar(container, id) {
  _subNavRenderizar(container, id);
}

// Clique e seta esquerda/direita, ligados uma única vez por elemento <nav> (a marca em
// dataset evita duplicar o listener a cada chamada de subNav(), já que o container em
// si não é recriado — só o conteúdo dele).
function _subNavGarantirListeners(container) {
  if (container.dataset.subnavListeners) return;
  container.dataset.subnavListeners = '1';

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.subnav-item');
    if (!btn) return;
    _subNavAtivar(container, btn.dataset.subnavId);
  });

  container.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const botoes = $$('.subnav-item', container);
    const atualIdx = botoes.findIndex((b) => b.classList.contains('is-ativo'));
    if (atualIdx === -1) return;
    e.preventDefault();
    const delta = e.key === 'ArrowRight' ? 1 : -1;
    const proximo = botoes[(atualIdx + delta + botoes.length) % botoes.length];
    _subNavAtivar(container, proximo.dataset.subnavId);
    $(`.subnav-item[data-subnav-id="${proximo.dataset.subnavId}"]`, container).focus();
  });
}

/** Atualiza (ou esconde, quando `valor` é 0/nulo) o contador de um item da sub-nav. */
function subNavBadge(containerOuId, id, valor) {
  const container = _subNavResolveContainer(containerOuId);
  if (!container) return;
  const badge = $(`.subnav-badge[data-subnav-badge="${id}"]`, container);
  if (!badge) return;

  const semValor = valor === undefined || valor === null || valor === 0 || valor === '';
  badge.hidden = semValor;
  if (!semValor) badge.textContent = String(valor);

  // O rótulo textual também carrega o número — leitor de tela não enxerga o badge
  // circular, então "Falhas (3)" precisa estar no texto, não só na bolinha visual.
  const rotulo = $('.subnav-rotulo', badge.closest('.subnav-item') || container);
  if (rotulo) {
    const base = rotulo.dataset.rotuloBase || rotulo.textContent;
    rotulo.textContent = semValor ? base : `${base} (${valor})`;
  }
}
