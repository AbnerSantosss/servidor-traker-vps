// Componente único de tooltip acessível do painel — todo `<button class="ajuda"
// data-ajuda="chave">` usa este mesmo componente, em vez de cada tela reimplementar o
// próprio balão. Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// TUDO por delegação de evento no `document`: o painel troca de aba e re-renderiza
// tabelas o tempo todo, então um bind por elemento (addEventListener em cada botão)
// perderia o gatilho assim que a tela fosse redesenhada. Delegar no document funciona
// para qualquer botão .ajuda que existir agora ou vier a existir depois.

const _TOOLTIP_ID = 'tooltipBalao';
let _balaoEl = null;
let _gatilhoAberto = null;

/** Outras telas reaproveitam o mesmo texto em title=/mensagens, sem duplicar o dicionário. */
function ajudaTexto(chave) {
  return AJUDAS[chave];
}

// ---------------- preencher o conteúdo visual do gatilho ----------------
// Isso não é uma interação (não precisa de listener) — é conteúdo estático que precisa
// existir assim que o botão aparece no DOM, então um MutationObserver cobre tanto o
// HTML já presente no admin.html quanto os botões que telas futuras injetarem.
function _prepararGatilho(btn) {
  if (btn.dataset.ajudaPronto) return;
  btn.dataset.ajudaPronto = '1';
  if (!btn.getAttribute('type')) btn.setAttribute('type', 'button');
  btn.setAttribute('aria-label', 'Ajuda');
  if (window.lucide) {
    btn.innerHTML = '<i data-lucide="help-circle" aria-hidden="true"></i>';
    if (typeof aplicarIcones === 'function') aplicarIcones(btn);
  } else {
    // Sem Lucide (falha de carga do vendor), cai num "?" simples — nunca some.
    btn.textContent = '?';
  }
}

function _prepararGatilhosDe(raiz) {
  if (raiz.matches && raiz.matches('.ajuda[data-ajuda]')) _prepararGatilho(raiz);
  if (raiz.querySelectorAll) raiz.querySelectorAll('.ajuda[data-ajuda]').forEach(_prepararGatilho);
}

const _observadorGatilhos = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType === 1) _prepararGatilhosDe(node);
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  _prepararGatilhosDe(document.body);
  _observadorGatilhos.observe(document.body, { childList: true, subtree: true });
});

// ---------------- balão ----------------
function _garantirBalao() {
  if (_balaoEl) return _balaoEl;
  _balaoEl = document.createElement('div');
  _balaoEl.className = 'tooltip-balao';
  _balaoEl.id = _TOOLTIP_ID;
  _balaoEl.setAttribute('role', 'tooltip');
  _balaoEl.hidden = true;
  document.body.appendChild(_balaoEl);
  return _balaoEl;
}

function _posicionarBalao(gatilho, balao) {
  const margem = 8;
  const rectG = gatilho.getBoundingClientRect();
  // Mede o balão já visível, ainda em 0,0, para conhecer o tamanho real do texto
  // antes de decidir onde ele cabe.
  balao.style.left = '0px';
  balao.style.top = '0px';
  const rectB = balao.getBoundingClientRect();

  let top = rectG.bottom + margem;
  let paraCima = false;
  if (top + rectB.height > window.innerHeight - margem) {
    top = rectG.top - rectB.height - margem;
    paraCima = true;
  }
  // Se nem virando para cima coube (gatilho colado no topo da janela), não deixa
  // vazar por cima — prende na margem em vez de sair da tela.
  if (top < margem) top = margem;

  let left = rectG.left + rectG.width / 2 - rectB.width / 2;
  if (left < margem) left = margem;
  if (left + rectB.width > window.innerWidth - margem) left = window.innerWidth - rectB.width - margem;

  balao.style.left = `${Math.round(left)}px`;
  balao.style.top = `${Math.round(top)}px`;
  balao.classList.toggle('tooltip-balao--cima', paraCima);
}

function _abrirTooltip(gatilho) {
  const chave = gatilho.dataset.ajuda;
  const texto = ajudaTexto(chave);
  if (!texto) {
    // Chave errada não pode virar um balão vazio e silencioso — falha alto em
    // desenvolvimento, onde o console é olhado, para o erro ser corrigido antes de
    // chegar em produção.
    console.warn('[tooltip] chave de ajuda desconhecida: "' + chave + '"');
    return;
  }
  const balao = _garantirBalao();
  balao.textContent = texto;
  balao.hidden = false;
  _gatilhoAberto = gatilho;
  gatilho.setAttribute('aria-describedby', _TOOLTIP_ID);
  _posicionarBalao(gatilho, balao);
}

function _fecharTooltip() {
  if (_gatilhoAberto) _gatilhoAberto.removeAttribute('aria-describedby');
  _gatilhoAberto = null;
  if (_balaoEl) _balaoEl.hidden = true;
}

function _gatilhoDoEvento(e) {
  return e.target && e.target.closest ? e.target.closest('.ajuda[data-ajuda]') : null;
}

// mouseenter/mouseleave não fazem bubbling, mas a fase de captura ainda os alcança —
// por isso o `true` no fim: é o que permite delegar estes dois eventos num único
// listener no document em vez de um por botão.
document.addEventListener('mouseenter', (e) => {
  const gatilho = _gatilhoDoEvento(e);
  if (gatilho) _abrirTooltip(gatilho);
}, true);

document.addEventListener('mouseleave', (e) => {
  const gatilho = _gatilhoDoEvento(e);
  if (gatilho && gatilho === _gatilhoAberto) _fecharTooltip();
}, true);

// focusin/focusout (ao contrário de focus/blur) fazem bubbling, então funcionam por
// delegação simples — é o caminho de teclado equivalente ao hover do mouse.
document.addEventListener('focusin', (e) => {
  const gatilho = _gatilhoDoEvento(e);
  if (gatilho) _abrirTooltip(gatilho);
});

document.addEventListener('focusout', (e) => {
  const gatilho = _gatilhoDoEvento(e);
  if (gatilho && gatilho === _gatilhoAberto) _fecharTooltip();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _gatilhoAberto) _fecharTooltip();
});

// Toque não dispara mouseenter/mouseleave de forma confiável — por isso o clique vira
// o gatilho de abrir/fechar no toque, e dobra como "fecha ao clicar fora" no desktop.
document.addEventListener('click', (e) => {
  const gatilho = _gatilhoDoEvento(e);
  if (gatilho) {
    e.preventDefault();
    if (_gatilhoAberto === gatilho) _fecharTooltip();
    else _abrirTooltip(gatilho);
    return;
  }
  if (_balaoEl && !_balaoEl.hidden && !_balaoEl.contains(e.target)) _fecharTooltip();
});
