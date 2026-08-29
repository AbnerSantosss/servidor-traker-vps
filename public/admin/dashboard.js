// Dashboard: orquestração de carga, KPIs (faixa 1), série temporal (faixa 2) e
// operação — funil e entregas por destino (faixa 4). Atribuição (faixa 3) e compras
// sem atribuição (faixa 5) ficam em dashboard-atribuicao.js; EMQ continua em
// dashboard-emq.js. Parte do painel admin — carregado por admin.html na ordem
// definida lá (ver docs/15-convencoes-do-painel.md §2.2).
'use strict';

// ---------------- Utilidades compartilhadas pelas faixas do dashboard ----------------

// Lê uma cor do :root já pintado pelo app.css. Necessário sempre que uma cor precisa
// ir para dentro de uma opção do ECharts: o canvas não entende `var(--token)`, só o
// valor resolvido — graficos.js faz o mesmo internamente, mas só para o tema, não para
// series individuais que precisam de uma cor semântica fixa (ok/âmbar/perigo).
function dashCor(token) {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

// 'dd/mm', o mesmo formato curto que o dashboard antigo usava nos eixos.
function dashDataCurta(iso) {
  const [, m, d] = String(iso).split('-');
  return `${d}/${m}`;
}

// Período dos filtros no formato YYYY-MM-DD que todos os endpoints (antigos e novos)
// esperam em `from`/`to`. Extraído para função porque agora seis chamadas usam a
// mesma janela, não só uma.
function dashPeriodo() {
  const period = $('#filterPeriod').value;
  let from = '';
  let to = '';
  if (period !== 'all') {
    const days = parseInt(period, 10);
    const dFrom = new Date();
    dFrom.setDate(dFrom.getDate() - days);
    from = dFrom.toISOString().split('T')[0];
    to = new Date().toISOString().split('T')[0];
  }
  return { from, to };
}

function dashQS(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v) usp.append(k, v); }
  const qs = usp.toString();
  return qs ? '?' + qs : '';
}

// Marca todas as faixas como "carregando" assim que uma nova busca começa — sem isso,
// trocar de filtro deixaria o gráfico antigo na tela por um instante enganando o
// operador sobre o que está vendo.
function dashFaixasCarregando() {
  for (const nome of ['Serie', 'Utm', 'Qualidade', 'Funil', 'Destinos']) {
    const g = document.getElementById('grafico' + nome);
    const f = document.getElementById('fallback' + nome);
    if (g) g.hidden = true;
    if (f) dashCarregando(f);
  }
  $('#destinosInfo').innerHTML = '';
  $('#semAtribResumo').textContent = 'Carregando…';
  $('#semAtribTable').querySelector('tbody').innerHTML = '<tr><td colspan="5" class="empty">Carregando…</td></tr>';
}

// ---------------- Orquestração ----------------
// As seis chamadas (as duas antigas — /metrics e /emq — mais as quatro novas) saem
// juntas: uma faixa que falha mostra o próprio erro e o resto do dashboard continua de
// pé, por isso allSettled em vez de Promise.all (que rejeitaria tudo no primeiro erro).
async function loadDashboard() {
  if (!state.selectedId) return;
  const pid = state.selectedId;
  const { from, to } = dashPeriodo();
  const utm = $('#filterUtmSource').value;
  const eventName = $('#filterEventName').value;

  dashFaixasCarregando();

  const [metricsR, utmR, atribR, funilR, destinosR, serieR] = await Promise.allSettled([
    api('/projects/' + pid + '/metrics' + dashQS({ from, to, utm_source: utm, event_name: eventName })),
    api('/projects/' + pid + '/metrics/utm' + dashQS({ from, to })),
    api('/projects/' + pid + '/metrics/atribuicao' + dashQS({ from, to, event_name: eventName })),
    api('/projects/' + pid + '/metrics/funil' + dashQS({ from, to })),
    api('/projects/' + pid + '/metrics/destinos' + dashQS({ from, to })),
    api('/projects/' + pid + '/metrics/serie' + dashQS({ from, to, utm_source: utm, event_name: eventName })),
  ]);

  // Projeto sem nenhum evento no período: nenhuma das cinco faixas abaixo tem o que
  // desenhar, e cinco "sem dados" ao mesmo tempo não orientam ninguém — a tela vira
  // uma única frase com o próximo passo.
  const semEventoNenhum = metricsR.status === 'fulfilled' && (metricsR.value.totals.events || 0) === 0;
  $('#dashVazio').hidden = !semEventoNenhum;
  $('#dashConteudo').hidden = semEventoNenhum;
  if (semEventoNenhum) { loadEmq(); return; }

  dashRenderKpis(metricsR, atribR);
  if (metricsR.status === 'fulfilled') populateUtmFilter(metricsR.value.byUtmSource);

  dashSerieRenderizar(serieR);
  dashUtmRenderizar(utmR);           // dashboard-atribuicao.js
  dashQualidadeRenderizar(atribR);   // dashboard-atribuicao.js
  dashSemAtribRenderizar(atribR);    // dashboard-atribuicao.js
  dashFunilRenderizar(funilR);
  dashDestinosRenderizar(destinosR);

  loadEmq(); // dashboard-emq.js — chamada própria, trata o próprio erro
}

// Redesenha o dashboard quando o tema muda. As cores das séries são resolvidas dos
// tokens no momento em que a opção é montada, então a única forma de o canvas sair
// com a paleta certa é montá-la de novo — graficos.js já descartou as instâncias.
//
// Sim, isto refaz as chamadas da API. É aceitável porque a troca de tema é um clique
// deliberado e raro; guardar o último payload em memória só para isto acrescentaria
// um segundo estado para manter em dia, e estado duplicado envelhece.
document.addEventListener('temaTrocado', () => {
  if (state.selectedId && document.querySelector('.tab[data-tab="dashboard"]')?.classList.contains('active')) loadDashboard();
});

// ---------------- Estados das faixas ----------------
//
// Carregando, vazio e erro tinham exatamente a mesma cara: um texto cinza
// centralizado, com o erro se distinguindo só por um `style="color:…"` inline.
// São três situações com respostas diferentes — esperar, agir, tentar de novo —
// e a mais acionável delas era a que menos se destacava.
//
// Estão aqui, e não num módulo próprio, porque as três faixas do dashboard
// (dashboard.js, -atribuicao, -emq) compartilham o escopo global dos scripts
// clássicos e este arquivo carrega primeiro.

/** Esqueleto de carregamento no lugar de "Carregando…". */
function dashCarregando(el, tipo = 'grafico') {
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `<div class="skeleton skeleton-${tipo}"></div>`;
}

/** Vazio: não há dado, e não há nada a fazer além de esperar ou ajustar o filtro. */
function dashVazio(el, texto) {
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `
    <div class="estado-vazio">
      <span class="estado-vazio-icone" aria-hidden="true"><i data-lucide="inbox"></i></span>
      <p>${escHtml(texto)}</p>
    </div>`;
  aplicarIcones(el);
}

/** Erro: existe uma ação a tomar, então ela aparece como botão. */
function dashErro(el, mensagem, aoTentarDeNovo) {
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `
    <div class="estado-vazio is-erro">
      <span class="estado-vazio-icone" aria-hidden="true"><i data-lucide="triangle-alert"></i></span>
      <h4>Não foi possível carregar</h4>
      <p>${escHtml(mensagem)}</p>
      ${aoTentarDeNovo ? '<button type="button" class="btn btn-sm" data-tentar>Tentar de novo</button>' : ''}
    </div>`;
  aplicarIcones(el);
  if (aoTentarDeNovo) el.querySelector('[data-tentar]')?.addEventListener('click', aoTentarDeNovo);
}

// ---------------- Faixa 1 · KPIs ----------------
// A linha herói é o funil de dinheiro, na ordem em que o dinheiro anda: visita →
// checkout → pix → venda, com os dois abandonos ao lado do passo que eles medem. Os
// KPIs antigos (ticket médio, taxa de sucesso, cadastros, % sem fbc) não sumiram —
// desceram para a linha secundária. Informação rebaixada, não deletada: continuam
// respondendo perguntas reais, só não são a primeira pergunta.

// O balão do pix abandonado muda de texto conforme o método que o servidor conseguiu
// usar. Um número derivado sem o método declarado é um número que ninguém consegue
// auditar — e o operador precisa saber que, no modo agregado, é estimativa.
function dashFunilAjudaPix(f) {
  const base = 'Derivado: soma do valor dos pix gerados que não viraram compra no período. ';
  if (f.pix_metodo === 'order_id') {
    return base + `Método: correlação por order_id/transaction_id — cada pix foi casado com a compra de mesmo identificador, e sobrou o que não casou (${fmtNumBR(f.pix_abandonado_qtd || 0)} de ${fmtNumBR(f.pix_gerados || 0)} pix). É o cálculo exato.`;
  }
  return base + `Método: agregado (estimativa) — soma dos pix menos soma das compras do período, com piso zero, porque ${f.pix_gerados ? `só ${fmtNumBR(f.pix_com_chave || 0)} de ${fmtNumBR(f.pix_gerados)} pix trouxeram` : 'nenhum pix trouxe'} order_id/transaction_id. Inclua order_id no webhook do pix e no da compra para o painel passar a casar um a um.`;
}

function dashRenderKpis(metricsR, atribR) {
  const grid = $('#kpiGrid');
  if (metricsR.status !== 'fulfilled') {
    dashErro(grid, metricsR.reason.message, loadDashboard);
    return;
  }
  const totals = metricsR.value.totals;
  const fmtPct = (v) => ((v || 0) * 100).toFixed(1) + '%';

  // % de compras com atribuição e eventos sem fbc/fbclid dependem da faixa de
  // atribuição, que é uma chamada à parte — se ela falhar, só esses dois KPIs saem
  // como "—"; os outros seis, que só dependem de /metrics, continuam normais.
  let pctAtrib = null;
  let semFbcAbs = null;
  let semFbcPct = null;
  if (atribR.status === 'fulfilled') {
    const r = atribR.value.resumo;
    pctAtrib = r.total_eventos ? 1 - r.sem_atribuicao / r.total_eventos : null;
    let comFbc = 0;
    let semFbc = 0;
    for (const dia of atribR.value.serie) { comFbc += dia.com_fbc || 0; semFbc += dia.sem_fbc || 0; }
    const totalFbc = comFbc + semFbc;
    semFbcAbs = semFbc;
    semFbcPct = totalFbc ? semFbc / totalFbc : null;
  }
  const alerta = semFbcPct !== null && semFbcPct > 0.2;

  // O bloco novo é aditivo na API: um servidor mais antigo (ou um erro parcial) não
  // pode derrubar a faixa inteira, então a ausência vira um funil zerado.
  const f = metricsR.value.funilDinheiro || {};
  AJUDAS['kpi-pix-abandonado'] = dashFunilAjudaPix(f);

  // Limiar de atenção do abandono de checkout. Metade dos checkouts virando nada é o
  // ponto em que a operação para de ser "normal do e-commerce" e vira problema para
  // investigar — abaixo disso, pintar de âmbar seria alarme falso permanente.
  const abandonoAlto = (f.taxa_abandono_checkout || 0) >= 0.5 && (f.checkouts_iniciados || 0) > 0;

  const heroi = [
    {
      icone: 'banknote',
      rotulo: 'Vendas',
      valor: fmtMoedaBR(f.vendas_valor),
      sub: `${fmtNumBR(f.vendas)} compra(s) confirmada(s)`,
      ajuda: 'kpi-vendas',
      classe: 'kpi-f--heroi',
    },
    {
      icone: 'eye',
      rotulo: 'Visualizações de página',
      valor: fmtNumBR(f.page_views),
      sub: 'evento page_view',
      ajuda: 'kpi-page-views',
    },
    {
      icone: 'shopping-cart',
      rotulo: 'Checkouts iniciados',
      valor: fmtNumBR(f.checkouts_iniciados),
      sub: 'evento begin_checkout',
      ajuda: 'kpi-checkouts-iniciados',
    },
    {
      icone: 'package-x',
      rotulo: 'Checkouts abandonados',
      valor: fmtNumBR(f.checkouts_abandonados),
      sub: `${fmtPct(f.taxa_abandono_checkout)} dos iniciados`,
      ajuda: 'kpi-checkouts-abandonados',
      classe: abandonoAlto ? 'kpi-f--atencao' : '',
    },
    {
      icone: 'qr-code',
      rotulo: 'Pix gerados',
      valor: fmtMoedaBR(f.pix_valor),
      sub: `${fmtNumBR(f.pix_gerados)} cobrança(s) criada(s)`,
      ajuda: 'kpi-pix-gerados',
    },
    {
      icone: 'timer-off',
      rotulo: 'Pix abandonado',
      valor: fmtMoedaBR(f.pix_abandonado_valor),
      // No modo agregado não existe "quantos pix" — dizer 0 mentiria, então a linha
      // de apoio conta qual método produziu o número.
      sub: f.pix_metodo === 'order_id'
        ? `${fmtNumBR(f.pix_abandonado_qtd || 0)} pix sem compra`
        : 'estimativa agregada',
      ajuda: 'kpi-pix-abandonado',
      classe: (f.pix_abandonado_valor || 0) > 0 ? 'kpi-f--atencao' : '',
    },
  ];

  const secundarios = [
    { icon: ICON.pulso, label: 'Total de eventos', value: fmtNumBR(totals.events), ajuda: 'kpi-eventos' },
    { icon: ICON.pessoa, label: 'Cadastros', value: fmtNumBR(totals.signUps), ajuda: 'kpi-cadastros' },
    { icon: ICON.etiqueta, label: 'Ticket médio', value: fmtMoedaBR(totals.avgTicket), ajuda: 'kpi-ticket-medio' },
    { icon: ICON.certo, label: 'Taxa de sucesso', value: fmtPct(totals.successRate), ajuda: 'kpi-taxa-sucesso' },
    {
      icone: 'link-2',
      label: '% de compras com atribuição',
      value: pctAtrib === null ? '—' : fmtPct(pctAtrib),
      ajuda: 'kpi-pct-atribuicao',
    },
    {
      icon: ICON.alerta,
      label: 'Sem fbc/fbclid no período',
      value: semFbcAbs === null ? '—' : `${fmtNumBR(semFbcAbs)} (${fmtPct(semFbcPct)})`,
      ajuda: 'kpi-sem-fbc',
      amber: alerta,
    },
  ];

  const heroiHtml = heroi.map((k) => `
    <article class="kpi-f ${k.classe || ''}">
      <span class="kpi-f-icone" aria-hidden="true"><i data-lucide="${k.icone}"></i></span>
      <span class="kpi-f-rotulo">${escHtml(k.rotulo)} <button type="button" class="ajuda" data-ajuda="${k.ajuda}"></button></span>
      <span class="kpi-f-valor num">${k.valor}</span>
      <span class="kpi-f-sub">${escHtml(k.sub)}</span>
    </article>
  `).join('');

  const secHtml = secundarios.map((k) => `
    <div class="kpi kpi-sec${k.amber ? ' is-amber' : ''}">
      <span class="kpi-icon">${k.icon || `<i data-lucide="${k.icone}" aria-hidden="true"></i>`}</span>
      <div class="kpi-data">
        <span class="kpi-value">${k.value}</span>
        <span class="kpi-label">${k.label} <button type="button" class="ajuda" data-ajuda="${k.ajuda}"></button></span>
      </div>
    </div>
  `).join('');

  grid.innerHTML = `
    <div class="kpi-funil">${heroiHtml}</div>
    <div class="kpi-secundarios">${secHtml}</div>
  `;
  aplicarIcones(grid);
  animarNumeros(grid);
}

/**
 * Faz os números do funil subirem até o valor final em vez de aparecerem prontos.
 *
 * Feito à mão, sem GSAP: o painel não carrega a biblioteca e não vale acrescentar
 * 72 KB ao carregamento de uma ferramenta de trabalho para animar seis números —
 * a landing, que é vitrine, é outro caso.
 *
 * O texto de partida é preservado e reposto ao final, e não recalculado a partir
 * do número: é ele que carrega "R$", separador de milhar e o sufixo entre
 * parênteses. Reconstruir isso aqui seria uma segunda formatação capaz de
 * divergir da primeira — e um dashboard que mostra o valor errado por 400ms é
 * pior que um dashboard sem animação.
 */
function animarNumeros(raiz) {
  const menosMovimento = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (menosMovimento) return;

  for (const el of raiz.querySelectorAll('.kpi-f-valor')) {
    const textoFinal = el.textContent;
    // Só anima quando há exatamente um número no rótulo. "3 (75.0%)" e "—" ficam
    // como estão: animar dois números independentes deixaria a linha inconsistente
    // no meio do caminho.
    const numeros = textoFinal.match(/[\d.,]+/g);
    if (!numeros || numeros.length !== 1) continue;

    const alvo = Number(numeros[0].replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(alvo) || alvo === 0) continue;

    const casas = (numeros[0].split(',')[1] || '').length;
    const molde = textoFinal.split(numeros[0]);
    const inicio = performance.now();
    const duracao = 520;

    const passo = (agora) => {
      const t = Math.min(1, (agora - inicio) / duracao);
      // Desaceleração cúbica: o número corre no início e "assenta" no fim, que é
      // o que dá a impressão de contagem em vez de interpolação linear.
      const valor = alvo * (1 - (1 - t) ** 3);
      el.textContent = molde[0] + valor.toLocaleString('pt-BR', {
        minimumFractionDigits: casas,
        maximumFractionDigits: casas,
      }) + (molde[1] || '');
      if (t < 1) requestAnimationFrame(passo);
      else el.textContent = textoFinal; // repõe a formatação original, sem reconstruí-la
    };
    requestAnimationFrame(passo);
  }
}

// ---------------- Faixa 2 · Série temporal ----------------
// A agregação vem pronta de /metrics/serie. A primeira versão desta faixa baixava a lista
// crua de eventos (teto de 1.000 linhas) e contava no navegador, com um aviso visível
// quando o período tinha mais que isso. Funcionava, mas o gráfico passava a contar só uma
// fatia justamente nos projetos em que ele mais importa — e um aviso não conserta um
// número errado. Contar linha é trabalho de banco.

// Abaixo deste número de dias a série não tem tendência para mostrar: vira barras
// discretas, separadas e estreitas, com a nota de "coletando dados desde". O defeito que
// isto corrige é concreto — com 4 eventos num dia só, o gráfico desenhava um bloco
// gigante de cor única ocupando a largura inteira do card, que parece um dado
// consolidado e não é.
const DASH_POUCOS_PONTOS = 5;

// 'dd/mm/aaaa' a partir do ISO — o fmtDate compartilhado inclui hora, que não faz
// sentido numa frase sobre desde quando o projeto coleta.
function dashDataLonga(iso) {
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleDateString('pt-BR');
}

/**
 * Nota discreta acima do gráfico da série. Vive fora do admin.html de propósito: só
 * existe enquanto for verdade (poucos pontos), e um elemento fixo no HTML precisaria
 * ser escondido/mostrado por quem nem sempre lembra de escondê-lo.
 */
function dashNotaSerie(texto) {
  const elG = $('#graficoSerie');
  if (!elG || !elG.parentNode) return;
  let nota = document.getElementById('notaSerie');
  if (!texto) { if (nota) nota.remove(); return; }
  if (!nota) {
    nota = document.createElement('p');
    nota.id = 'notaSerie';
    nota.className = 'dash-nota';
    elG.parentNode.insertBefore(nota, elG);
  }
  nota.textContent = texto;
}

function dashSerieRenderizar(serieR) {
  const elG = $('#graficoSerie');
  const elF = $('#fallbackSerie');
  descartarGrafico(elG);
  dashNotaSerie('');

  if (serieR.status !== 'fulfilled') {
    elG.hidden = true; elF.hidden = false;
    dashErro(elF, serieR.reason.message, loadDashboard);
    return;
  }

  const { serie, tipos: tiposPrincipais, temOutros, coletandoDesde } = serieR.value;

  if (!serie.length) {
    elG.hidden = true; elF.hidden = false;
    dashVazio(elF, 'Sem eventos no período para montar a série diária.');
    return;
  }

  const poucosDados = serie.length < DASH_POUCOS_PONTOS;
  if (poucosDados) {
    dashNotaSerie(
      (coletandoDesde ? `Coletando dados desde ${dashDataLonga(coletandoDesde)}. ` : '') +
      `Só ${serie.length} dia(s) com eventos no período — os valores são exatos, mas ainda não desenham tendência.`
    );
  }

  // "outros" só entra como série quando existe de fato — o servidor agrupa nele o que
  // ficou fora dos tipos mais frequentes, e uma faixa sempre zerada seria só ruído.
  const tipos = [...tiposPrincipais].sort();
  if (temOutros) tipos.push('outros');

  const dias = serie.map((d) => d.dia);
  const porDia = new Map(serie.map((d) => [
    d.dia,
    { tipos: new Map([...Object.entries(d.tipos || {}), ...(temOutros ? [['outros', d.outros || 0]] : [])]), receita: Number(d.receita) || 0 },
  ]));

  if (temGraficos()) {
    elG.hidden = false; elF.hidden = true;
    const corReceita = corDado(1); // convenção fixa do projeto: receita/vendas = índigo
    const series = tipos.map((tipo) => ({
      name: tipo,
      type: 'bar',
      stack: 'eventos',
      // Teto de largura: sem ele, um único dia no período vira uma barra do tamanho do
      // card. Com o teto, uma barra estreita e centralizada diz "é um ponto só".
      barMaxWidth: poucosDados ? 40 : 28,
      itemStyle: { borderRadius: [3, 3, 0, 0] },
      data: dias.map((d) => porDia.get(d).tipos.get(tipo) || 0),
    }));
    // A receita só ganha linha própria quando há série para desenhar. Com dois ou
    // três dias, uma linha ligando os pontos é uma reta diagonal atravessando o
    // gráfico — forma de tendência sobre um dado que não tem tendência nenhuma, e
    // ainda obriga a um segundo eixo Y que dobra o que o operador precisa ler. Nesse
    // caso a receita fica no tooltip, onde o número é exato.
    const receitaTemSerie = !poucosDados && dias.length >= 4;
    if (receitaTemSerie) {
      series.push({
        name: 'Receita (purchase)',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbol: 'circle',
        showSymbol: false,
        symbolSize: 7,
        lineStyle: { width: 2 },
        itemStyle: { color: corReceita },
        areaStyle: { color: areaGradiente(corReceita) },
        data: dias.map((d) => porDia.get(d).receita),
      });
    }
    grafico(elG, {
      tooltip: {
        trigger: 'axis',
        // Sem a linha de receita, o valor do dia entraria só no eixo que não existe
        // mais — então ele é acrescentado ao balão, que é onde se lê número exato.
        formatter: receitaTemSerie ? undefined : (params) => {
          const dia = params[0]?.axisValue ?? '';
          const linhas = params.filter((p) => p.value).map((p) => `${p.marker} ${p.seriesName}: <b>${fmtNumBR(p.value)}</b>`);
          const receita = porDia.get(dias[params[0]?.dataIndex])?.receita || 0;
          if (receita) linhas.push(`Receita: <b>${fmtMoedaBR(receita)}</b>`);
          return `${dia}<br>${linhas.join('<br>')}`;
        },
      },
      legend: { top: 0 },
      // Com dois ou três dias, o gráfico é recolhido ao centro: esticar duas barras
      // por 1200px de card não mostra mais informação, só mais vazio — e o vazio
      // sugere que falta dado que na verdade está ali.
      grid: poucosDados
        ? { left: '30%', right: '30%', top: 40, bottom: 34 }
        : { left: 46, right: receitaTemSerie ? 58 : 18, top: 40, bottom: 64 },
      xAxis: { type: 'category', data: dias.map(dashDataCurta), boundaryGap: true },
      // `minInterval: 1` no eixo de contagem: sem ele, um dia com 3 eventos rende um
      // eixo com 0,5 / 1,5 / 2,5 — e meio evento não existe. É o tipo de detalhe que
      // faz o gráfico inteiro parecer errado sem que se saiba dizer por quê.
      yAxis: receitaTemSerie
        ? [
            { type: 'value', name: 'eventos', minInterval: 1 },
            { type: 'value', name: 'receita', axisLabel: { formatter: (v) => fmtMoedaBR(v) } },
          ]
        : [{ type: 'value', name: 'eventos', minInterval: 1 }],
      // Recortar um trecho de três dias não é recorte nenhum: o controle deslizante só
      // aparece quando existe série para navegar.
      dataZoom: poucosDados ? [] : [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }],
      series,
    }, { altura: poucosDados ? 200 : 320 });
  } else {
    elG.hidden = true; elF.hidden = false;
    elF.innerHTML = dashSerieTabela(dias, tipos, porDia);
  }
}

function dashSerieTabela(dias, tipos, porDia) {
  const cabecalho = ['Data', ...tipos, 'Receita (purchase)'].map((c) => `<th>${escHtml(c)}</th>`).join('');
  const linhas = dias.map((d) => {
    const b = porDia.get(d);
    const cels = tipos.map((t) => `<td>${fmtNumBR(b.tipos.get(t) || 0)}</td>`).join('');
    return `<tr><td>${dashDataCurta(d)}</td>${cels}<td>${fmtMoedaBR(b.receita)}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr>${cabecalho}</tr></thead><tbody>${linhas}</tbody></table></div>`;
}

// ---------------- Faixa 4 · Funil ----------------
function dashFunilRenderizar(funilR) {
  const elG = $('#graficoFunil');
  const elF = $('#fallbackFunil');
  descartarGrafico(elG);

  if (funilR.status !== 'fulfilled') {
    elG.hidden = true; elF.hidden = false;
    dashErro(elF, funilR.reason.message, loadDashboard);
    return;
  }
  const etapas = funilR.value.etapas || [];
  if (!etapas.length || !etapas[0].eventos) {
    elG.hidden = true; elF.hidden = false;
    dashVazio(elF, 'Sem eventos suficientes para montar o funil.');
    return;
  }

  if (temGraficos()) {
    elG.hidden = false; elF.hidden = true;
    grafico(elG, {
      tooltip: { trigger: 'item', formatter: (p) => `${p.name}: ${fmtNumBR(p.value)}` },
      series: [{
        type: 'funnel',
        left: '8%', right: '12%', top: 12, bottom: 12,
        sort: 'none', gap: 3,
        label: {
          // O rótulo fica DENTRO da faixa, sobre a cor cheia da série — herdar o
          // --text do tema (escuro, feito para fundo branco) o tornaria ilegível.
          color: dashCor('--on-accent'),
          formatter: (p) => {
            const e = etapas[p.dataIndex];
            const taxa = e.taxa_da_etapa_anterior;
            const sufixo = taxa === null ? '' : ` · ${(taxa * 100).toFixed(0)}% da etapa anterior`;
            return `${e.nome}\n${fmtNumBR(e.eventos)}${sufixo}`;
          },
        },
        data: etapas.map((e) => ({ name: e.nome, value: e.eventos })),
      }],
    }, { altura: 280 });
  } else {
    elG.hidden = true; elF.hidden = false;
    elF.innerHTML = dashFunilTabela(etapas);
  }
}

function dashFunilTabela(etapas) {
  const linhas = etapas.map((e) => `
    <tr>
      <td>${escHtml(e.nome)}</td>
      <td>${fmtNumBR(e.eventos)}</td>
      <td>${e.taxa_da_etapa_anterior === null ? '—' : (e.taxa_da_etapa_anterior * 100).toFixed(1) + '%'}</td>
      <td>${(e.taxa_do_topo * 100).toFixed(1)}%</td>
    </tr>`).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Etapa</th><th>Eventos</th><th>Taxa da etapa anterior</th><th>Taxa do topo</th></tr></thead>
    <tbody>${linhas}</tbody>
  </table></div>`;
}

// ---------------- Faixa 4 · Entregas por destino ----------------
function dashDestinosRenderizar(destinosR) {
  const elG = $('#graficoDestinos');
  const elF = $('#fallbackDestinos');
  const info = $('#destinosInfo');
  descartarGrafico(elG);

  if (destinosR.status !== 'fulfilled') {
    elG.hidden = true; elF.hidden = false;
    dashErro(elF, destinosR.reason.message, loadDashboard);
    info.innerHTML = '';
    return;
  }

  const { serie, latencia_media_segundos: latenciaMedia, top_erros: topErros } = destinosR.value;
  info.innerHTML = dashDestinosInfoHtml(latenciaMedia, topErros);

  if (!serie.length) {
    elG.hidden = true; elF.hidden = false;
    dashVazio(elF, 'Sem entregas no período.');
    return;
  }

  const porDia = new Map();
  for (const linha of serie) {
    if (!porDia.has(linha.data)) porDia.set(linha.data, { success: 0, error: 0, dead: 0 });
    const acc = porDia.get(linha.data);
    acc.success += linha.status.success || 0;
    acc.error += linha.status.error || 0;
    acc.dead += linha.status.dead || 0;
  }
  const dias = [...porDia.keys()].sort();

  if (temGraficos()) {
    elG.hidden = false; elF.hidden = true;
    grafico(elG, {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 0 },
      grid: { left: 44, right: 16, top: 34, bottom: 30 },
      xAxis: { type: 'category', data: dias.map(dashDataCurta) },
      yAxis: { type: 'value', minInterval: 1 },
      // Cores semânticas, não cores de série: sucesso em verde, "vai tentar de novo" em
      // âmbar de atenção e "parou de tentar" no vermelho de erro. É a convenção que o
      // mundo inteiro usa — usar a paleta categórica aqui obrigaria a ler a legenda
      // para descobrir qual faixa é a ruim.
      series: [
        { name: 'Sucesso', type: 'bar', stack: 'status', barMaxWidth: 28, itemStyle: { color: dashCor('--ok') }, data: dias.map((d) => porDia.get(d).success) },
        { name: 'Erro (retentando)', type: 'bar', stack: 'status', barMaxWidth: 28, itemStyle: { color: dashCor('--warning') }, data: dias.map((d) => porDia.get(d).error) },
        { name: 'Morto', type: 'bar', stack: 'status', barMaxWidth: 28, itemStyle: { color: dashCor('--danger') }, data: dias.map((d) => porDia.get(d).dead) },
      ],
    }, { altura: 220 });
  } else {
    elG.hidden = true; elF.hidden = false;
    elF.innerHTML = dashDestinosTabela(serie);
  }
}

function dashDestinosTabela(serie) {
  const linhas = serie.slice()
    .sort((a, b) => a.data.localeCompare(b.data) || a.destino.localeCompare(b.destino))
    .map((l) => `
      <tr>
        <td>${dashDataCurta(l.data)}</td>
        <td>${escHtml(l.destino)}</td>
        <td>${fmtNumBR(l.status.success)}</td>
        <td>${fmtNumBR(l.status.error)}</td>
        <td>${fmtNumBR(l.status.dead)}</td>
        <td>${fmtNumBR((l.status.pending || 0) + (l.status.processing || 0))}</td>
      </tr>`).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Data</th><th>Destino</th><th>Sucesso</th><th>Erro</th><th>Morto</th><th>Em andamento</th></tr></thead>
    <tbody>${linhas}</tbody>
  </table></div>`;
}

// Latência média e top erros são só texto — nunca dependem do ECharts para existir,
// então ficam fora do par grafico/fallback (não são "enfeite", são o próprio dado).
function dashDestinosInfoHtml(latenciaMedia, topErros) {
  const destinos = new Set([...Object.keys(latenciaMedia || {}), ...Object.keys(topErros || {})]);
  if (!destinos.size) return '';
  return [...destinos].sort().map((dest) => {
    const lat = latenciaMedia && latenciaMedia[dest];
    const erros = (topErros && topErros[dest]) || [];
    const latTxt = lat ? `${lat.toFixed(1)}s de latência média até o sucesso` : 'sem entregas com sucesso no período';
    const errosHtml = erros.length
      ? '<ul class="dash-erros-lista">' + erros.map((e) => `<li>${escHtml(e.erro)}<span class="dash-erros-qtd">×${fmtNumBR(e.quantidade)}</span></li>`).join('') + '</ul>'
      : '<p class="dash-sem-erros">Sem erros no período.</p>';
    return `<div class="dash-destino-bloco"><h5>${escHtml(dest)}</h5><p class="dash-destino-lat">${latTxt}</p>${errosHtml}</div>`;
  }).join('');
}

// Preenche o filtro "UTM Source" com as origens que existem no período — mantido do
// dashboard antigo sem mudança de comportamento (I-4 não se aplica aqui, mas o
// combinado com o outro agente é não alterar o que os filtros já fazem).
function populateUtmFilter(byUtmSource) {
  const select = $('#filterUtmSource');
  const currentVal = select.value;

  if (!byUtmSource || !byUtmSource.length) {
    select.innerHTML = '<option value="">Todas</option>';
    return;
  }

  const options = byUtmSource.map((u) => {
    const s = u.source || '(vazio)';
    return `<option value="${escHtml(s)}">${escHtml(s)}</option>`;
  });

  select.innerHTML = '<option value="">Todas</option>' + options.join('');
  if (currentVal && byUtmSource.some((u) => (u.source || '(vazio)') === currentVal)) {
    select.value = currentVal;
  }
}

// ---------------- Binds próprios (fora de main.js, que não é escopo deste módulo) ----------------
document.addEventListener('DOMContentLoaded', () => {
  const btn = $('#btnDashIrInstalacao');
  if (btn) btn.addEventListener('click', () => activateTab('setup'));
});
