// Dashboard: qualidade de correspondência (EMQ).
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// ════════════════════════════════════════════════════════════════════
// DASHBOARD — Qualidade de correspondência (EMQ)
// ════════════════════════════════════════════════════════════════════

const EMQ_LABELS = {
  email: 'E-mail',
  phone: 'Telefone',
  fbc: 'Cookie de clique (fbc)',
  fbp: 'Cookie de navegador (fbp)',
  external_id: 'ID externo',
  client_ip_address: 'IP do cliente',
  client_user_agent: 'User-Agent',
};

async function loadEmq() {
  if (!state.selectedId) return;
  const body = $('#emqBody');
  dashCarregando(body);
  $('#emqMeta').textContent = '';
  try {
    renderEmq(await api('/projects/' + state.selectedId + '/emq?days=7'));
  } catch (err) {
    dashErro(body, err.message, loadEmq);
  }
}

function renderEmq(data) {
  const body = $('#emqBody');
  const donutEl = $('#graficoEmqDonut');
  const fmtNum = (v) => new Intl.NumberFormat('pt-BR').format(v || 0);
  const total = data.total || 0;
  const dias = data.days || 7;

  $('#emqMeta').textContent =
    `${fmtNum(total)} evento(s) nos últimos ${dias} dias · ${fmtNum(data.identidades)} identidade(s) guardada(s) pela ponte`;

  if (donutEl) descartarGrafico(donutEl);

  if (!total) {
    dashVazio(body, 'Nenhum evento no período — envie um evento de teste pela aba Instalação.');
    if (donutEl) donutEl.hidden = true;
    return;
  }

  const linhas = [...(data.coverage || [])].sort((a, b) => (b.pct || 0) - (a.pct || 0));
  body.innerHTML = linhas.map((c) => {
    const pct = (c.pct || 0) * 100;
    const cls = pct >= 70 ? 'hi' : pct >= 30 ? 'mid' : 'lo';
    return `
      <div class="emq-row">
        <span class="emq-name" title="${escHtml(c.field)}">${escHtml(EMQ_LABELS[c.field] || c.field)}<small>${escHtml(c.field)}</small></span>
        <div class="emq-track">
          <div class="emq-fill ${cls}" style="width:${pct.toFixed(1)}%"></div>
        </div>
        <span class="emq-val">${pct.toFixed(1)}%<small>${fmtNum(c.count)} ev.</small></span>
      </div>
    `;
  }).join('');

  // O donut é só a mesma informação das barras acima, resumida num único número — se
  // o ECharts não carregou, as barras (que já são texto/HTML, nunca dependem dele)
  // continuam sendo a fonte de verdade sozinhas, então o donut só entra quando pode.
  if (donutEl && linhas.length) {
    const media = linhas.reduce((acc, c) => acc + (c.pct || 0), 0) / linhas.length;
    const pctTxt = (media * 100).toFixed(0) + '%';
    const inst = grafico(donutEl, {
      tooltip: { formatter: () => `Cobertura média dos campos: ${pctTxt}` },
      series: [{
        type: 'pie',
        radius: ['64%', '88%'],
        avoidLabelOverlap: false,
        silent: true,
        label: {
          show: true, position: 'center', formatter: () => pctTxt,
          fontSize: 18, fontWeight: 700, color: dashCor('--text'),
        },
        labelLine: { show: false },
        data: [
          // Índigo da paleta de dados: o donut mede cobertura, não alerta — pintá-lo de
          // âmbar (como era no tema antigo) dava ar de problema a um número saudável.
          { name: 'Cobertura', value: media, itemStyle: { color: corDado(1) } },
          { name: 'Restante', value: Math.max(0, 1 - media), itemStyle: { color: dashCor('--surface-2') } },
        ],
      }],
    });
    donutEl.hidden = !inst;
  } else if (donutEl) {
    donutEl.hidden = true;
  }
}
