// Escolha de tema (escuro/claro), aplicada ANTES do primeiro pixel.
//
// Este arquivo é carregado no <head> SEM `defer` de propósito. Ele bloqueia o
// parse por alguns milissegundos e, em troca, o atributo `data-tema` já está no
// <html> quando a primeira regra de CSS é avaliada. Com `defer`, quem escolheu o
// tema claro veria a tela escura piscar antes de clarear — e um flash de tema é
// daquelas coisas que ninguém consegue "desver" depois.
//
// A solução usual para isso é um <script> inline no <head>. Aqui não dá: a CSP
// é `script-src 'self'`, sem `unsafe-inline`, e essa rigidez é o que torna um
// eventual XSS inofensivo. Um arquivo externo custa uma requisição (já em cache,
// mesma origem) e não abre mão de nada.
'use strict';

const TEMA_CHAVE = 'traker:tema';
const TEMAS = ['escuro', 'claro'];

/** Lê a preferência salva. Escuro é o padrão do produto, não do sistema. */
function temaSalvo() {
  try {
    const t = localStorage.getItem(TEMA_CHAVE);
    return TEMAS.includes(t) ? t : 'escuro';
  } catch {
    // localStorage lança quando cookies de terceiros estão bloqueados num
    // contexto embutido. Tema é preferência, não função: cair no padrão é
    // resposta suficiente, e derrubar o boot do painel por isso não seria.
    return 'escuro';
  }
}

function aplicarTema(tema) {
  document.documentElement.setAttribute('data-tema', tema);
  // Faz o navegador pintar de acordo os controles nativos que não passam pelo
  // nosso CSS: barra de rolagem, campos de data, menus de <select>.
  document.documentElement.style.colorScheme = tema === 'claro' ? 'light' : 'dark';
}

function definirTema(tema) {
  if (!TEMAS.includes(tema)) return;
  aplicarTema(tema);
  try { localStorage.setItem(TEMA_CHAVE, tema); } catch { /* ver nota acima */ }

  // Os gráficos são desenhados em canvas: eles não herdam a troca de tokens do
  // CSS e precisam ser redesenhados com as cores novas. O evento existe para
  // que este módulo não precise conhecer o dashboard.
  document.dispatchEvent(new CustomEvent('temaTrocado', { detail: { tema } }));
}

function temaAtual() {
  return document.documentElement.getAttribute('data-tema') || 'escuro';
}

// Aplicado imediatamente, ainda durante o parse do <head>.
aplicarTema(temaSalvo());
