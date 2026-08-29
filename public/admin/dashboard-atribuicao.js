// Dashboard: atribuição — receita por UTM com drill-down (faixa 3a), qualidade de
// atribuição por dia (faixa 3b) e compras sem atribuição (faixa 5). Depende dos
// helpers de dashboard.js (dashCor, dashDataCurta) — carregado logo depois dele.
// Parte do painel admin — carregado por admin.html na ordem definida lá
// (ver docs/15-convencoes-do-painel.md §2.2).
'use strict';

// ---------------- Faixa 3a · Receita por UTM (com drill-down) ----------------
// `linhas` guarda a resposta crua de /metrics/utm (uma linha por combinação
// source×medium×campaign); a visão exibida é sempre uma agregação dela — por origem
// no nível de topo, por campanha depois que o operador clica numa origem. Guardar cru
// e agregar na hora de desenhar evita um novo fetch a cada clique de drill-down.
let _dashUtmLinhas = [];
let _dashUtmFonteAtiva = null; // null = por origem; string = por campanha desta origem

function dashUtmRenderizar(utmR) {
  const elG = $('#graficoUtm');
  const elF = $('#fallbackUtm');
  const btnVoltar = $('#btnUtmVoltar');
  descartarGrafico(elG);

  if (utmR.status !== 'fulfilled') {
    elG.hidden = true; elF.hidden = false; btnVoltar.hidden = true;
    dashErro(elF, utmR.reason.message, loadDashboard);
    return;
  }
  _dashUtmLinhas = utmR.value.linhas || [];
  _dashUtmFonteAtiva = null;
  dashUtmDesenhar();
}

// Separado de dashUtmRenderizar porque o clique numa barra/linha só troca o nível do
// drill-down — não vale a pena buscar tudo de novo na API para isso.
function dashUtmDesenhar() {
  const elG = $('#graficoUtm');
  const elF = $('#fallbackUtm');
  const btnVoltar = $('#btnUtmVoltar');
  btnVoltar.hidden = !_dashUtmFonteAtiva;

  const base = _dashUtmFonteAtiva
    ? _dashUtmLinhas.filter((l) => l.utm_source === _dashUtmFonteAtiva)
    : _dashUtmLinhas;
  const agruparPor = _dashUtmFonteAtiva ? 'utm_campaign' : 'utm_source';

  const agregados = new Map();
  for (const l of base) {
    const chave = l[agruparPor];
    if (!agregados.has(chave)) agregados.set(chave, { chave, eventos: 0, compras: 0, receita: 0, comAtribPeso: 0 });
    const a = agregados.get(chave);
    a.eventos += l.eventos;
    a.compras += l.compras;
    a.receita += l.receita;
    a.comAtribPeso += (l.pct_com_atribuicao || 0) * l.eventos;
  }
  const linhas = [...agregados.values()]
    .map((a) => ({ ...a, pct_com_atribuicao: a.eventos ? a.comAtribPeso / a.eventos : 0 }))
    .sort((a, b) => b.receita - a.receita)
    .slice(0, 15);

  if (!linhas.length) {
    elG.hidden = true; elF.hidden = false;
    dashVazio(elF, 'Sem receita por UTM no período.');
    return;
  }

  if (temGraficos()) {
    elG.hidden = false; elF.hidden = true;
    const inst = grafico(elG, {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (p) => `${p[0].name}<br>${fmtMoedaBR(p[0].value)}` },
      // `containLabel: true` porque o rótulo do eixo X é moeda ("R$ 1.234,00") e com
      // o grid fixo ele saía cortado pela borda do card — o valor aparecia como
      // "-- ---". O `left` fixo continua, para os nomes de origem alinharem entre si.
      grid: { left: 140, right: 24, top: 10, bottom: 6, containLabel: true },
      xAxis: { type: 'value', splitNumber: 3, axisLabel: { formatter: (v) => fmtMoedaBR(v) } },
      yAxis: { type: 'category', inverse: true, data: linhas.map((l) => l.chave).slice().reverse(), axisLabel: { width: 120, overflow: 'truncate' } },
      // Receita é sempre índigo (--dado-1) neste painel, em qualquer gráfico: a mesma
      // grandeza mudando de cor entre dois cartões da mesma tela é o que faz a pessoa
      // ler a legenda toda vez em vez de reconhecer o número de relance.
      series: [{
        type: 'bar',
        barMaxWidth: 22,
        itemStyle: { color: corDado(1), borderRadius: [0, 3, 3, 0] },
        data: linhas.map((l) => l.receita).slice().reverse(),
      }],
      // Uma barra de 180px de altura para uma única origem é moldura, não gráfico:
      // a altura passa a acompanhar a quantidade de linhas, com piso baixo o
      // bastante para o caso de uma origem só.
    }, { altura: Math.min(320, Math.max(84, linhas.length * 34 + 20)) });

    // O clique só faz drill-down no nível "por origem" — clicar numa campanha (nível
    // já mais fundo) não tem para onde descer, então nem registra o handler.
    if (inst) {
      inst.off('click');
      if (!_dashUtmFonteAtiva) {
        inst.on('click', (params) => {
          const idx = linhas.length - 1 - params.dataIndex; // eixo veio invertido
          _dashUtmFonteAtiva = linhas[idx].chave;
          dashUtmDesenhar();
        });
      }
    }
  } else {
    elG.hidden = true; elF.hidden = false;
    elF.innerHTML = dashUtmTabela(linhas, agruparPor);
  }
}

function dashUtmTabela(linhas, agruparPor) {
  const rotuloColuna = agruparPor === 'utm_source' ? 'Origem' : 'Campanha';
  const corpo = linhas.map((l) => {
    const drill = agruparPor === 'utm_source'
      ? `<button type="button" class="btn btn-ghost dash-drill-btn" data-utm-fonte="${escHtml(l.chave)}">Ver campanhas</button>`
      : '';
    return `
      <tr>
        <td>${escHtml(l.chave)}</td>
        <td>${fmtNumBR(l.eventos)}</td>
        <td>${fmtNumBR(l.compras)}</td>
        <td>${fmtMoedaBR(l.receita)}</td>
        <td>${(l.pct_com_atribuicao * 100).toFixed(0)}%</td>
        <td>${drill}</td>
      </tr>`;
  }).join('');
  const html = `<div class="table-wrap"><table>
    <thead><tr><th>${rotuloColuna}</th><th>Eventos</th><th>Compras</th><th>Receita</th><th>% atribuição</th><th></th></tr></thead>
    <tbody>${corpo}</tbody>
  </table></div>`;

  // A tabela é recriada a cada render (innerHTML), então o bind do drill-down também
  // precisa ser refeito aqui — não há elemento estável para delegar o clique.
  requestAnimationFrame(() => {
    $$('.dash-drill-btn', $('#fallbackUtm')).forEach((b) => {
      b.addEventListener('click', () => {
        _dashUtmFonteAtiva = b.dataset.utmFonte;
        dashUtmDesenhar();
      });
    });
  });
  return html;
}

// ---------------- Faixa 3b · Qualidade de atribuição (com/sem fbc por dia) ----------------
function dashQualidadeRenderizar(atribR) {
  const elG = $('#graficoQualidade');
  const elF = $('#fallbackQualidade');
  descartarGrafico(elG);

  if (atribR.status !== 'fulfilled') {
    elG.hidden = true; elF.hidden = false;
    dashErro(elF, atribR.reason.message, loadDashboard);
    return;
  }
  const serie = atribR.value.serie || [];
  if (!serie.length) {
    elG.hidden = true; elF.hidden = false;
    dashVazio(elF, 'Sem eventos no período.');
    return;
  }

  if (temGraficos()) {
    elG.hidden = false; elF.hidden = true;
    // Poucos dias: mesma regra da série principal — com dois ou três pontos a linha
    // some sem o símbolo desenhado, e uma área suavizada sugere uma curva que não foi
    // medida.
    const poucos = serie.length < DASH_POUCOS_PONTOS;
    const corOk = dashCor('--ok');
    const corSem = dashCor('--danger');
    grafico(elG, {
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { left: 40, right: 16, top: 30, bottom: 24 },
      xAxis: { type: 'category', boundaryGap: poucos, data: serie.map((s) => dashDataCurta(s.data)) },
      // Contagem de eventos: sem minInterval o eixo inventa "meio evento".
      yAxis: { type: 'value', minInterval: 1 },
      // Área empilhada sobre dois ou três dias desenha duas cunhas coloridas que
      // parecem tendência e não são. Com poucos pontos, barra empilhada — a forma
      // que a contagem por dia realmente tem.
      series: [
        {
          name: 'Com fbc/fbclid',
          type: poucos ? 'bar' : 'line',
          stack: 'total',
          barMaxWidth: 34,
          showSymbol: false, symbol: 'circle', symbolSize: 6, lineStyle: { width: 2 },
          areaStyle: poucos ? undefined : { color: areaGradiente(corOk) },
          itemStyle: { color: corOk },
          data: serie.map((s) => s.com_fbc),
        },
        {
          name: 'Sem fbc/fbclid',
          type: poucos ? 'bar' : 'line',
          stack: 'total',
          barMaxWidth: 34,
          showSymbol: false, symbol: 'circle', symbolSize: 6, lineStyle: { width: 2 },
          areaStyle: poucos ? undefined : { color: areaGradiente(corSem) },
          itemStyle: { color: corSem, borderRadius: poucos ? [3, 3, 0, 0] : 0 },
          data: serie.map((s) => s.sem_fbc),
        },
      ],
    }, { altura: poucos ? 150 : 190 });
  } else {
    elG.hidden = true; elF.hidden = false;
    elF.innerHTML = dashQualidadeTabela(serie);
  }
}

function dashQualidadeTabela(serie) {
  const linhas = serie.map((s) => `
    <tr>
      <td>${dashDataCurta(s.data)}</td>
      <td>${fmtNumBR(s.com_fbc)}</td>
      <td>${fmtNumBR(s.sem_fbc)}</td>
      <td>${fmtNumBR(s.com_gclid)}</td>
      <td>${fmtNumBR(s.sem_gclid)}</td>
    </tr>`).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Data</th><th>Com fbc</th><th>Sem fbc</th><th>Com gclid</th><th>Sem gclid</th></tr></thead>
    <tbody>${linhas}</tbody>
  </table></div>`;
}

// ---------------- Faixa 5 · Compras sem atribuição ----------------
// `sem_atribuicao` do endpoint é sempre sobre purchase, independente do filtro de
// evento escolhido no topo da tela (decisão do backend — ver docs/15-convencoes) —
// por isso o resumo escreve isso explicitamente em vez de deixar a tabela sozinha
// dando a entender que segue o filtro de cima.
function dashSemAtribRenderizar(atribR) {
  const resumoEl = $('#semAtribResumo');
  const tbody = $('#semAtribTable').querySelector('tbody');

  if (atribR.status !== 'fulfilled') {
    resumoEl.textContent = 'Compras sem origem identificada — erro ao carregar';
    tbody.innerHTML = `<tr><td colspan="5" class="empty">Erro: ${escHtml(atribR.reason.message)}</td></tr>`;
    return;
  }

  const { resumo, sem_atribuicao: semAtribuicao } = atribR.value;
  resumoEl.textContent = resumo.sem_atribuicao
    ? `${fmtMoedaBR(resumo.receita_sem_atribuicao)} em ${fmtNumBR(resumo.sem_atribuicao)} compra(s) sem origem identificada — sempre sobre purchase, mesmo com outro evento selecionado no filtro acima`
    : 'Nenhuma compra sem atribuição no período — sempre sobre purchase, mesmo com outro evento selecionado no filtro acima';

  if (!semAtribuicao.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Nenhuma compra sem atribuição no período.</td></tr>';
    return;
  }
  tbody.innerHTML = semAtribuicao.map((r) => `
    <tr>
      <td>${escHtml(fmtDate(r.received_at))}</td>
      <td title="${escHtml(r.event_id)}">${escHtml(shorten(r.event_id))}</td>
      <td>${escHtml(fmtMoedaBR(r.value))}</td>
      <td>${escHtml(r.utm_source)}</td>
      <td>${escHtml(r.utm_campaign)}</td>
    </tr>`).join('');
}

// ---------------- Bind próprio do botão "voltar" do drill-down ----------------
// O botão é estático (nasce no admin.html), então o bind acontece uma única vez aqui
// — main.js não é escopo deste módulo, e delegar no document seria over-engineering
// para um único botão que nunca é recriado.
document.addEventListener('DOMContentLoaded', () => {
  $('#btnUtmVoltar').addEventListener('click', () => {
    _dashUtmFonteAtiva = null;
    dashUtmDesenhar();
  });
});
