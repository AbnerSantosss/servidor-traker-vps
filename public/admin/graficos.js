// Camada única sobre o ECharts (vendor/echarts.min.js) — nenhuma tela deste painel
// chama `echarts` direto. Parte do painel admin — carregado por admin.html na ordem
// definida lá.
'use strict';

// Uma instância por elemento DOM, para telas que re-renderizam (troca de projeto, troca
// de filtro) reaproveitarem o canvas em vez de vazar instâncias órfãs a cada chamada.
const _graficosPorElemento = new Map();

// O tema não é um arquivo de config solto: ele lê os tokens que o design system já
// definiu no :root de app.css. O canvas do ECharts não entende `var(--token)` — só o
// valor resolvido — então a ponte precisa existir em algum lugar; existe aqui, uma vez,
// em vez de espalhada por cada tela. Se a paleta mudar em app.css, o gráfico muda junto;
// se um token sumir, cai num fallback literal em vez de quebrar o desenho.
function _corToken(nome, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
  return v || fallback;
}

// Paleta categórica de dados — separada da paleta de ação de propósito (ver o cabeçalho
// de app.css). Convenções fixas do projeto, que as telas devem respeitar ao escolher a
// cor de uma série específica: receita/vendas = --dado-1, abandono = âmbar (--dado-5),
// erro = o vermelho semântico (--danger), nunca uma cor de série.
//
// O fallback só entra em cena se `getComputedStyle` falhar, e por isso precisa
// acompanhar a paleta de verdade — um fallback desatualizado pinta o gráfico com as
// cores de dois temas atrás e ninguém percebe, porque o caminho normal funciona.
const _PALETA_DADOS_FALLBACK = ['#A8B4F5', '#22D3EE', '#A78BFA', '#34D399', '#FBBF24', '#F472B6', '#B8B8B8', '#A3E635'];

/** Cor da n-ésima série da paleta categórica (1 a 8), já resolvida em hex. */
function corDado(n) {
  const i = Math.min(Math.max(Math.trunc(n) || 1, 1), 8);
  return _corToken(`--dado-${i}`, _PALETA_DADOS_FALLBACK[i - 1]);
}

function _paletaDados() {
  return _PALETA_DADOS_FALLBACK.map((_, i) => corDado(i + 1));
}

/**
 * Converte uma cor de token em rgba com a opacidade pedida. Só entende hex porque é o
 * formato em que a paleta está escrita; qualquer outro formato volta como veio (o
 * gradiente perde a transparência, mas nada quebra).
 */
function _hexParaRgba(cor, alfa) {
  const m = String(cor).trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return cor;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alfa})`;
}

/**
 * Preenchimento de área com gradiente vertical (12% → 0% de opacidade) — a assinatura
 * visual das séries deste painel. A área existe para dar volume à linha sem competir
 * com ela; um preenchimento chapado vira um bloco de cor que esconde a grade e, com
 * duas séries, uma tapa a outra.
 *
 * Devolve o objeto de gradiente cru do ECharts (não usa `echarts.graphic`) para
 * continuar funcionando mesmo se o vendor não tiver carregado quando isto for montado.
 */
function areaGradiente(cor, opacidadeTopo = 0.12) {
  return {
    type: 'linear',
    x: 0, y: 0, x2: 0, y2: 1,
    colorStops: [
      { offset: 0, color: _hexParaRgba(cor, opacidadeTopo) },
      { offset: 1, color: _hexParaRgba(cor, 0) },
    ],
  };
}

function _registrarTemaTraker() {
  if (!window.echarts) return;
  const cor = {
    texto: _corToken('--text', '#F0EEE9'),
    // Rótulo de eixo e legenda usam o terciário: são referência de leitura, não
    // conteúdo — o dado é a série, e um rótulo tão escuro quanto ela rouba atenção.
    rotulo: _corToken('--muted-2', '#9A948B'),
    linha: _corToken('--line', '#2A2A27'),
    surface: _corToken('--surface', '#171716'),
    surface3: _corToken('--surface-3', '#262623'),
  };
  const sombra = _corToken('--shadow-2', '0 4px 12px -2px rgb(16 24 40 / .10)');
  const raio = _corToken('--radius', '10px');

  window.echarts.registerTheme('traker', {
    color: _paletaDados(),
    backgroundColor: 'transparent',
    textStyle: { color: cor.texto, fontFamily: 'inherit' },
    title: { textStyle: { color: cor.texto } },
    legend: {
      textStyle: { color: cor.rotulo, fontSize: 11 },
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 14,
    },
    tooltip: {
      backgroundColor: cor.surface,
      borderColor: cor.linha,
      borderWidth: 1,
      textStyle: { color: cor.texto, fontSize: 12 },
      // Em tema claro a sombra é o que separa o balão do fundo branco do card — sem
      // ela, o tooltip "derrete" no gráfico. Borda junto porque sombra sozinha some
      // em monitor mal calibrado (mesma regra do resto do design system).
      extraCssText: `box-shadow: ${sombra}; border-radius: ${raio};`,
      axisPointer: {
        lineStyle: { color: cor.linha },
        crossStyle: { color: cor.linha },
        shadowStyle: { color: cor.surface3 },
      },
    },
    categoryAxis: {
      axisLine: { lineStyle: { color: cor.linha } },
      axisTick: { show: false },
      axisLabel: { color: cor.rotulo, fontSize: 11 },
      splitLine: { show: false },
    },
    valueAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: cor.rotulo, fontSize: 11 },
      nameTextStyle: { color: cor.rotulo, fontSize: 11 },
      splitLine: { lineStyle: { color: cor.linha } },
    },
  });
}

// Ícones e vendors carregam antes deste arquivo (ver ordem em admin.html), mas o registro
// do tema só faz sentido depois que app.css já pintou os tokens no :root — o que já
// aconteceu no momento em que qualquer script roda, então registrar aqui é seguro.
_registrarTemaTraker();

function _resolverElemento(idOuElemento) {
  return typeof idOuElemento === 'string' ? document.getElementById(idOuElemento) : idOuElemento;
}

/**
 * Cria ou reaproveita uma instância do ECharts no elemento dado, aplica `opcao` e
 * devolve a instância — ou `null` se o vendor não carregou. Toda tela que usa gráfico
 * PRECISA tratar o `null`: gráfico é enfeite, os dados brutos (tabela) são obrigação.
 */
function grafico(idOuElemento, opcao, { altura } = {}) {
  if (!window.echarts) return null;
  const el = _resolverElemento(idOuElemento);
  if (!el) return null;

  if (altura) el.style.height = typeof altura === 'number' ? `${altura}px` : altura;

  let instancia = _graficosPorElemento.get(el);
  if (!instancia || instancia.isDisposed()) {
    instancia = window.echarts.init(el, 'traker');
    _graficosPorElemento.set(el, instancia);
  }
  instancia.setOption(opcao, { notMerge: false });
  return instancia;
}

/** Descarta a instância de uma tela que vai ser recriada (evita vazar memória/listeners). */
function descartarGrafico(idOuElemento) {
  const el = _resolverElemento(idOuElemento);
  if (!el) return;
  const instancia = _graficosPorElemento.get(el);
  if (instancia && !instancia.isDisposed()) instancia.dispose();
  _graficosPorElemento.delete(el);
}

/**
 * Prepara os gráficos para o tema novo: re-registra o tema e DESCARTA as instâncias.
 *
 * O ECharts pinta em <canvas>, que não reage à troca de custom properties como o
 * resto da página — as cores foram resolvidas a partir dos tokens no instante em que
 * a opção foi montada e estão gravadas nela como hex.
 *
 * Reaproveitar `getOption()` aqui parece o caminho óbvio e está errado: o que ele
 * devolve já traz o tema ANTIGO mesclado dentro da opção, então reaplicá-lo faz os
 * valores velhos vencerem o tema novo — o gráfico volta com o texto do tema anterior
 * sobre o fundo do tema atual. Foi exatamente o que aconteceu na primeira tentativa.
 *
 * Por isso as instâncias só são descartadas; quem sabe montar a opção com as cores
 * certas é a tela, e é ela que redesenha (ver o ouvinte em dashboard.js).
 */
function reaplicarTemaGraficos() {
  if (!window.echarts) return;
  _registrarTemaTraker();
  for (const [el, instancia] of _graficosPorElemento) {
    if (!instancia.isDisposed()) instancia.dispose();
    _graficosPorElemento.delete(el);
  }
}

// O evento vem de admin/tema.js, que não conhece o dashboard — é o que mantém a
// troca de tema independente de quem desenha o quê.
document.addEventListener('temaTrocado', reaplicarTemaGraficos);

/** Reflui o tamanho de todas as instâncias vivas — chamado com debounce no resize da janela. */
function redimensionarGraficos() {
  for (const instancia of _graficosPorElemento.values()) {
    if (!instancia.isDisposed()) instancia.resize();
  }
}

let _resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  // Redimensionar a cada pixel de resize trava o layout em telas com muitos gráficos;
  // ~150ms é imperceptível para quem arrasta a janela e poupa dezenas de reflows.
  _resizeTimer = setTimeout(redimensionarGraficos, 150);
});

/** As telas usam para decidir entre desenhar o gráfico ou cair na tabela de fallback. */
function temGraficos() {
  return Boolean(window.echarts);
}

// ---------------- formatação compartilhada pelos tooltips do ECharts ----------------
// grep feito antes de nomear: nenhum outro arquivo em public/admin/ define fmtMoedaBR
// ou fmtNumBR (dashboard.js tem funções locais fmtNum/fmtCur, mas fechadas dentro de
// renderKPIs — não colidem em escopo global).
function fmtMoedaBR(n) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n || 0);
}

function fmtNumBR(n) {
  return new Intl.NumberFormat('pt-BR').format(n || 0);
}
