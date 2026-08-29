// Hub compartilhado por Meta e Google (F2/F3): fluxo pedagógico, métricas de "Visão
// geral" e a tela de "Falhas" explicadas. Tudo aqui é parametrizado por `destino`
// ('meta' | 'google') — nenhuma função deste arquivo hardcoda qual dos dois está sendo
// exibido, só os rótulos visuais. Postback pode reaproveitar tudo aqui numa fase
// seguinte sem duplicar nada.
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

const FALHAS_ROTULO_DESTINO = { meta: 'Meta', google: 'Google', postback: 'Postback' };
// Concordância de gênero em pt-BR: "a Meta" (a plataforma), mas "o Google" — hardcodar
// o artigo no texto do fluxo quebraria um dos dois destinos, por isso é tabela também.
const FALHAS_ARTIGO_DESTINO = { meta: 'a', google: 'o', postback: 'o' };

// Mesmo padrão de dashQS (dashboard.js), com nome próprio para não sugerir dependência
// entre os dois arquivos além do que já existe (funções de formatação/gráfico).
function falhasQS(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v) usp.append(k, v); }
  const qs = usp.toString();
  return qs ? '?' + qs : '';
}

// ════════════════════════════════════════════════════════════════════
// ESTADOS DE TELA — esqueleto, vazio e erro (§2.9 das convenções do painel)
// ════════════════════════════════════════════════════════════════════
// Todos os três eram a mesma `<div class="dash-empty">` com um texto diferente dentro,
// o que fazia "carregando", "está tudo certo" e "quebrou" terem exatamente a mesma cara.

function falhasEsqueletoLista(el, linhas = 3) {
  if (!el) return;
  el.innerHTML = '<span class="skeleton" style="height:52px;margin-bottom:10px"></span>'.repeat(linhas);
}

function falhasEstadoHtml({ icone, titulo, texto, variante = '' }) {
  return `
    <div class="estado-vazio ${variante}">
      <span class="estado-vazio-icone"><i data-lucide="${icone}" aria-hidden="true"></i></span>
      <h4>${escHtml(titulo)}</h4>
      <p>${escHtml(texto)}</p>
    </div>`;
}

function falhasEstado(el, opcoes) {
  if (!el) return;
  el.innerHTML = falhasEstadoHtml(opcoes);
  aplicarIcones(el);
}

// ════════════════════════════════════════════════════════════════════
// BADGES — "Meta (3)" na aba principal e no item "Falhas" da sub-nav
// ════════════════════════════════════════════════════════════════════
// Chamada tanto por metaHubMontar() quanto por googleHubMontar(): como os dois hubs
// se montam em sequência (fillMetaForm depois fillGoogleForm, em nucleo.js) e cada
// subNav só existe de verdade depois do próprio hub montar, chamar dos dois lugares
// garante que os dois badges fiquem certos não importa a ordem — o custo é só mais uma
// chamada leve a /deliveries/resumo, que nem carrega a lista de falhas.
async function falhasAtualizarBadges() {
  if (!state.selectedId) return;
  let resumo;
  try {
    resumo = await api('/projects/' + state.selectedId + '/deliveries/resumo');
  } catch {
    return; // badge é enfeite informativo — não vale um toast de erro a cada troca de projeto
  }
  for (const destino of ['meta', 'google']) {
    const contagem = (resumo.destinos && resumo.destinos[destino]) || { ultimos_7d: 0 };
    falhasBadgeAbaPrincipal(destino, contagem.ultimos_7d);
    subNavBadge(destino + 'Subnav', 'falhas', contagem.ultimos_7d);
  }
}

// A aba principal (o botão "Meta"/"Google" no topo) é markup de navegacao.js/admin.html,
// fora do escopo deste agente — o contador entra por manipulação direta do botão já
// existente (mesmo texto-base guardado em FALHAS_ROTULO_DESTINO), sem tocar no HTML dele.
function falhasBadgeAbaPrincipal(destino, valor) {
  const btn = document.querySelector(`.tab[data-tab="${destino}"]`);
  if (!btn) return;
  const base = FALHAS_ROTULO_DESTINO[destino] || destino;
  btn.textContent = valor ? `${base} (${valor})` : base;
}

// ════════════════════════════════════════════════════════════════════
// FLUXO PEDAGÓGICO — os 3 passos do dado, estático, no topo da Visão Geral
// ════════════════════════════════════════════════════════════════════
// Resolve "está confuso": antes de mexer em qualquer campo, a pessoa vê por onde o
// evento passa e para onde clicar se quiser ver aquele passo de perto. `alvos` diz para
// qual sub-aba cada passo aponta — Meta e Google divergem porque só a Meta tem uma
// sub-aba de Mapeamento própria (no Google o mapeamento mora dentro de Credenciais).
function falhasFluxoHtml(destino, alvos) {
  const nome = FALHAS_ROTULO_DESTINO[destino] || destino;
  const art = FALHAS_ARTIGO_DESTINO[destino] || 'o';
  return `
    <ol class="fluxo-passos">
      <li class="fluxo-passo">
        <span class="fluxo-icone"><i data-lucide="webhook" aria-hidden="true"></i></span>
        <div>
          <h5>1 · O evento chega</h5>
          <p>Pelo pixel do navegador (tag do GTM) ou por um webhook do seu backend, no endpoint de ingestão deste projeto.</p>
          <button type="button" class="btn btn-ghost fluxo-link" data-fluxo-tab="setup">Ver Instalação</button>
        </div>
      </li>
      <li class="fluxo-passo">
        <span class="fluxo-icone"><i data-lucide="shuffle" aria-hidden="true"></i></span>
        <div>
          <h5>2 · O servidor estrutura</h5>
          <p>O nome do evento do seu site é traduzido para o nome que ${art} ${escHtml(nome)} espera, segundo o mapeamento configurado.</p>
          <button type="button" class="btn btn-ghost fluxo-link" data-fluxo-subaba="${alvos.estruturaSubaba}">Ver ${alvos.estruturaSubaba === 'mapeamento' ? 'Mapeamento' : 'Credenciais'}</button>
        </div>
      </li>
      <li class="fluxo-passo">
        <span class="fluxo-icone"><i data-lucide="send" aria-hidden="true"></i></span>
        <div>
          <h5>3 · O evento sai para ${art} ${escHtml(nome)}</h5>
          <p>Usando as credenciais salvas. Se ${art} ${escHtml(nome)} recusar, a entrega vira uma falha explicada, com o motivo e a ação.</p>
          <button type="button" class="btn btn-ghost fluxo-link" data-fluxo-subaba="${alvos.saidaSubaba}">Ver Credenciais</button>
        </div>
      </li>
    </ol>`;
}

// Delegado no document (mesmo padrão de tooltip.js): o fluxo é recriado a cada troca de
// projeto, então um bind por elemento se perderia a cada re-render.
document.addEventListener('click', (e) => {
  const btnTab = e.target.closest('[data-fluxo-tab]');
  if (btnTab) { activateTab(btnTab.dataset.fluxoTab); return; }

  const btnSub = e.target.closest('[data-fluxo-subaba]');
  if (!btnSub) return;
  const painel = btnSub.closest('.tab-panel');
  const nav = painel && painel.querySelector('.subnav');
  const alvo = nav && nav.querySelector(`.subnav-item[data-subnav-id="${btnSub.dataset.fluxoSubaba}"]`);
  if (alvo) alvo.click(); // reaproveita o clique real do item — não existe API própria para "ativar sub-aba X" fora disso
});

// ════════════════════════════════════════════════════════════════════
// VISÃO GERAL — métricas do destino (gráfico empilhado + latência + top erros)
// ════════════════════════════════════════════════════════════════════

// Janela fixa de 30 dias: cobre "hoje" e "últimos 7 dias" (usados no cartão de saúde)
// e ainda dá corpo suficiente ao gráfico, com um único fetch por troca de sub-aba.
function falhasJanela30d() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return { from: from.toISOString().split('T')[0], to: to.toISOString().split('T')[0] };
}

/**
 * Busca a série de entregas de UM destino em /metrics/destinos e devolve tanto os
 * dados crus (para o gráfico) quanto agregados prontos para o cartão de saúde.
 *
 * A API só tem granularidade DIÁRIA (ver computeDestinos em src/db/repos/events.js) —
 * por isso "hoje" e "últimos 7 dias" aqui são janelas de dias corridos, não uma janela
 * rolante de 24h como a de /deliveries/resumo. Os rótulos na tela dizem isso com
 * todas as letras: prometer uma precisão que a fonte não tem seria o tipo de
 * "adivinhação" que este projeto evita (ver src/destinations/erros-explicados.js).
 */
async function falhasMetricasDestino(destino) {
  const { from, to } = falhasJanela30d();
  const dados = await api('/projects/' + state.selectedId + '/metrics/destinos' + falhasQS({ from, to }));
  const serie = (dados.serie || [])
    .filter((l) => l.destino === destino)
    .sort((a, b) => a.data.localeCompare(b.data));
  const latencia = (dados.latencia_media_segundos && dados.latencia_media_segundos[destino]) || 0;
  const erros = (dados.top_erros && dados.top_erros[destino]) || [];

  const hojeStr = new Date().toISOString().split('T')[0];
  const seteDiasAtras = new Date();
  seteDiasAtras.setDate(seteDiasAtras.getDate() - 7);
  const seteDiasStr = seteDiasAtras.toISOString().split('T')[0];

  const somar = (linhas) => linhas.reduce((acc, l) => {
    acc.sucesso += l.status.success || 0;
    acc.total += (l.status.success || 0) + (l.status.error || 0) + (l.status.dead || 0);
    return acc;
  }, { sucesso: 0, total: 0 });

  const hoje = somar(serie.filter((l) => l.data === hojeStr));
  const seteDias = somar(serie.filter((l) => l.data >= seteDiasStr));
  const ultimoDiaComSucesso = [...serie].reverse().find((l) => (l.status.success || 0) > 0);

  return {
    serie, latencia, erros,
    taxaHoje: hoje.total ? hoje.sucesso / hoje.total : null,
    taxaSeteDias: seteDias.total ? seteDias.sucesso / seteDias.total : null,
    ultimoSucessoEm: ultimoDiaComSucesso ? ultimoDiaComSucesso.data : null,
  };
}

// "hoje"/"ontem" lê melhor que "13/08" quando é recente — só cai na data curta a
// partir de dois dias atrás.
function falhasDataRelativa(diaISO) {
  const hoje = new Date().toISOString().split('T')[0];
  const ontem = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  if (diaISO === hoje) return 'hoje';
  if (diaISO === ontem) return 'ontem';
  return dashDataCurta(diaISO);
}

// Célula do cartão de saúde: quando foi a última entrega com sucesso. Compartilhada
// entre meta.js e google.js — só o `m` (saída de falhasMetricasDestino) muda.
function celulaUltimoSucesso(m) {
  if (m === undefined) {
    return celulaStatus('Última entrega com sucesso', { dot: 'off', valor: 'lendo…', mudo: true, sub: '', ajuda: 'ultima-entrega-sucesso' });
  }
  if (!m) {
    return celulaStatus('Última entrega com sucesso', { dot: 'off', valor: 'indisponível', mudo: true, sub: 'não foi possível ler as métricas', ajuda: 'ultima-entrega-sucesso' });
  }
  if (!m.ultimoSucessoEm) {
    return celulaStatus('Última entrega com sucesso', { dot: 'off', valor: 'nenhuma nos últimos 30 dias', mudo: true, sub: '', ajuda: 'ultima-entrega-sucesso' });
  }
  return celulaStatus('Última entrega com sucesso', {
    dot: 'ok', valor: falhasDataRelativa(m.ultimoSucessoEm), sub: dashDataCurta(m.ultimoSucessoEm), ajuda: 'ultima-entrega-sucesso',
  });
}

// Célula do cartão de saúde: taxa de sucesso hoje/7 dias. O pior dos dois números
// decide a cor — um "hoje" ruim não pode ficar escondido atrás de um "7 dias" ainda
// razoável (nem o contrário).
function celulaTaxaDestino(m) {
  if (m === undefined) {
    return celulaStatus('Taxa de sucesso', { dot: 'off', valor: 'lendo…', mudo: true, sub: 'hoje · últimos 7 dias', ajuda: 'falhas-taxa-sucesso-destino' });
  }
  if (!m) {
    return celulaStatus('Taxa de sucesso', { dot: 'off', valor: 'indisponível', mudo: true, sub: 'não foi possível ler as métricas', ajuda: 'falhas-taxa-sucesso-destino' });
  }
  const fmtPct = (v) => (v === null ? '—' : (v * 100).toFixed(0) + '%');
  const validos = [m.taxaHoje, m.taxaSeteDias].filter((v) => v !== null);
  const pior = validos.length ? Math.min(...validos) : null;
  const dot = pior === null ? 'off' : pior >= 0.95 ? 'ok' : pior >= 0.8 ? 'warn' : 'err';
  return celulaStatus('Taxa de sucesso', {
    dot, mudo: pior === null,
    valor: `${fmtPct(m.taxaHoje)} hoje · ${fmtPct(m.taxaSeteDias)} 7d`,
    sub: 'granularidade diária, não janela rolante de 24h',
    ajuda: 'falhas-taxa-sucesso-destino',
  });
}

// Painel de texto ao lado do gráfico: latência média + top erros deste destino. Não
// depende do ECharts para existir — é dado, não enfeite (mesma regra do dashboard).
function falhasInfoDestinoHtml(m) {
  const latTxt = m.latencia
    ? `${m.latencia.toFixed(1)}s de latência média até o sucesso`
    : 'sem entregas com sucesso no período';
  const errosHtml = m.erros.length
    ? '<ul class="dash-erros-lista">' + m.erros.map((e) => `<li>${escHtml(e.erro)}<span class="dash-erros-qtd num">×${fmtNumBR(e.quantidade)}</span></li>`).join('') + '</ul>'
    : '<p class="dash-destino-lat">Sem erros no período.</p>';
  return `<p class="dash-destino-lat">${latTxt}</p>${errosHtml}`;
}

// Contagem é número: à direita e com largura tabular nas duas pontas (cabeçalho e
// célula), senão as colunas ficam com o título de um lado e o dígito do outro.
function falhasTabelaSerie(serie) {
  const linhas = serie.map((l) => `
    <tr>
      <td>${dashDataCurta(l.data)}</td>
      <td class="num">${fmtNumBR(l.status.success)}</td>
      <td class="num">${fmtNumBR(l.status.error)}</td>
      <td class="num">${fmtNumBR(l.status.dead)}</td>
      <td class="num">${fmtNumBR((l.status.pending || 0) + (l.status.processing || 0))}</td>
    </tr>`).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Data</th><th class="num">Sucesso</th><th class="num">Erro</th><th class="num">Morto</th><th class="num">Em andamento</th></tr></thead>
    <tbody>${linhas}</tbody>
  </table></div>`;
}

function falhasRenderizarGraficoSerie(elGraficoId, elFallbackId, serie) {
  const elG = $(elGraficoId);
  const elF = $(elFallbackId);
  if (!elG || !elF) return;
  descartarGrafico(elG);

  if (!serie.length) {
    elG.hidden = true; elF.hidden = false;
    falhasEstado(elF, {
      icone: 'calendar-off',
      titulo: 'Sem entregas nos últimos 30 dias',
      texto: 'Nada foi enviado a este destino no período — nem sucesso, nem falha. Confira se o destino está ativo e recebendo eventos.',
    });
    return;
  }

  if (temGraficos()) {
    elG.hidden = false; elF.hidden = true;
    grafico(elG, {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 0 },
      grid: { left: 44, right: 16, top: 34, bottom: 30 },
      xAxis: { type: 'category', data: serie.map((l) => dashDataCurta(l.data)) },
      yAxis: { type: 'value' },
      series: [
        { name: 'Sucesso', type: 'bar', stack: 'status', itemStyle: { color: dashCor('--ok') }, data: serie.map((l) => l.status.success || 0) },
        // Retentativa é atenção, não erro definitivo: âmbar semântico (--warning), não o
        // dourado da marca antiga que o alias --amber ainda carregava.
        { name: 'Erro (retentando)', type: 'bar', stack: 'status', itemStyle: { color: dashCor('--warning') }, data: serie.map((l) => l.status.error || 0) },
        { name: 'Morto', type: 'bar', stack: 'status', itemStyle: { color: dashCor('--danger') }, data: serie.map((l) => l.status.dead || 0) },
      ],
    }, { altura: 220 });
  } else {
    elG.hidden = true; elF.hidden = false;
    elF.innerHTML = falhasTabelaSerie(serie);
  }
}

/**
 * Monta a faixa de métricas da Visão Geral (gráfico + latência + erros) de UM destino.
 * `prefixo` nomeia os elementos no HTML (ex.: "meta" → #metaVgGrafico/#metaVgFallback/
 * #metaVgInfo). Devolve o `m` agregado para quem chamou reaproveitar no cartão de saúde
 * sem precisar buscar de novo.
 */
async function falhasVisaoGeralMetricas(destino, prefixo) {
  const elFallback = '#' + prefixo + 'VgFallback';
  const elF = $(elFallback);
  falhasEsqueletoLista(elF, 1);
  if (elF) elF.querySelector('.skeleton').style.height = '220px'; // a altura exata do gráfico que vem depois

  let m;
  try {
    m = await falhasMetricasDestino(destino);
  } catch (err) {
    falhasEstado(elF, {
      icone: 'plug-zap',
      titulo: 'Não foi possível ler as métricas',
      texto: err.message,
    });
    return null;
  }
  if (!state.selectedId) return null;

  falhasRenderizarGraficoSerie('#' + prefixo + 'VgGrafico', elFallback, m.serie);
  const elInfo = $('#' + prefixo + 'VgInfo');
  if (elInfo) elInfo.innerHTML = falhasInfoDestinoHtml(m);
  return m;
}

// ════════════════════════════════════════════════════════════════════
// FALHAS — lista de grupos agrupados por causa, já pronta em GET /deliveries
// ════════════════════════════════════════════════════════════════════

// Gravidade agora usa o badge semântico global (.badge-sem) em vez de um selo próprio:
// ele já traz o par cor/fundo do tema claro, o tamanho certo de ícone e o mesmo desenho
// que o resto do painel usa para dizer "erro", "atenção" e "informação". A cor vem
// acompanhada do ícone porque cor não pode ser o único canal (daltonismo).
const FALHAS_GRAVIDADE = {
  critica:     { label: 'Crítica',     cls: 'erro',   icone: 'octagon-alert' },
  atencao:     { label: 'Atenção',     cls: 'aviso',  icone: 'triangle-alert' },
  informativa: { label: 'Informativa', cls: 'info',   icone: 'info' },
};

function falhasSeloGravidadeHtml(gravidade) {
  const g = FALHAS_GRAVIDADE[gravidade];
  if (!g) return `<span class="badge-sem neutro"><i data-lucide="circle-help" aria-hidden="true"></i>${escHtml(gravidade || '—')}</span>`;
  return `<span class="badge-sem ${g.cls}"><i data-lucide="${g.icone}" aria-hidden="true"></i>${g.label}</span>`;
}

function falhasPeriodoTexto(dias) {
  if (dias === 1) return 'nas últimas 24h';
  if (dias === 0) return 'no período selecionado';
  return `nos últimos ${dias} dias`;
}

function falhasEsqueletoHtml(prefixo) {
  return `
    <div class="falhas-filtros">
      <div class="filter-group">
        <label for="${prefixo}FalhasPeriodo">Período</label>
        <select id="${prefixo}FalhasPeriodo">
          <option value="1">Últimas 24h</option>
          <option value="7" selected>Últimos 7 dias</option>
          <option value="30">Últimos 30 dias</option>
          <option value="0">Todo o período</option>
        </select>
      </div>
      <label class="falhas-check">
        <input type="checkbox" id="${prefixo}FalhasIncluirPulados" />
        Incluir eventos pulados (consentimento / sem mapeamento)
        <button type="button" class="ajuda" data-ajuda="falhas-incluir-pulados"></button>
      </label>
      <button class="btn btn-ghost" type="button" id="${prefixo}FalhasAtualizar">Atualizar</button>
    </div>
    <div class="falhas-legenda">
      ${falhasSeloGravidadeHtml('critica')}
      ${falhasSeloGravidadeHtml('atencao')}
      ${falhasSeloGravidadeHtml('informativa')}
      <button type="button" class="ajuda" data-ajuda="falhas-gravidade"></button>
    </div>
    <div id="${prefixo}FalhasLista"></div>`;
}

/**
 * Ponto de entrada da tela de falhas: constrói o esqueleto (uma vez) e carrega os
 * dados (toda vez que a sub-aba é aberta — mesmo padrão de loadUsuarios/loadMetaStatus
 * em navegacao.js, que recarregam a cada ativação em vez de cachear para sempre).
 */
function falhasMontar(destino, containerSel, prefixo) {
  const container = $(containerSel);
  if (!container) return;
  if (!container.dataset.falhasMontado) {
    container.dataset.falhasMontado = '1';
    container.innerHTML = falhasEsqueletoHtml(prefixo);
    aplicarIcones(container);
    $('#' + prefixo + 'FalhasPeriodo').addEventListener('change', () => falhasCarregar(destino, prefixo));
    $('#' + prefixo + 'FalhasIncluirPulados').addEventListener('change', () => falhasCarregar(destino, prefixo));
    $('#' + prefixo + 'FalhasAtualizar').addEventListener('click', () => falhasCarregar(destino, prefixo));
  }
  falhasCarregar(destino, prefixo);
}

async function falhasCarregar(destino, prefixo) {
  const listaEl = $('#' + prefixo + 'FalhasLista');
  if (!listaEl) return;
  const pid = state.selectedId;
  falhasEsqueletoLista(listaEl);

  const dias = Number($('#' + prefixo + 'FalhasPeriodo').value || 7);
  const incluirPulados = $('#' + prefixo + 'FalhasIncluirPulados').checked;
  let from = '';
  if (dias > 0) {
    const d = new Date();
    d.setDate(d.getDate() - dias);
    from = d.toISOString().split('T')[0];
  }
  // skipped_* ficam fora por padrão (I-6: são comportamento correto, não falha) — só
  // entram quando o operador pede explicitamente, para auditoria.
  const status = incluirPulados ? 'error,dead,skipped_consent,skipped_unmapped' : 'error,dead';

  let dados;
  try {
    dados = await api('/projects/' + pid + '/deliveries' + falhasQS({ destination: destino, status, from, limit: 500 }));
  } catch (err) {
    falhasEstado(listaEl, {
      icone: 'plug-zap',
      titulo: 'Não foi possível carregar as falhas',
      texto: err.message,
    });
    return;
  }
  if (state.selectedId !== pid) return; // projeto trocou enquanto a busca corria

  falhasRenderizarLista(listaEl, destino, prefixo, dados.grupos, dias);
}

function falhasRenderizarLista(el, destino, prefixo, grupos, dias) {
  if (!grupos.length) {
    // Estado vazio POSITIVO: a variante `.is-ok` do componente global pinta o verde —
    // "sem falha" é uma boa notícia, não um cinza neutro que parece "não sei te dizer nada".
    falhasEstado(el, {
      variante: 'is-ok',
      icone: 'circle-check-big',
      titulo: `Nenhuma falha ${falhasPeriodoTexto(dias)}`,
      texto: 'Todas as entregas deste destino foram aceitas no período. Nada a fazer aqui.',
    });
    return;
  }
  el.innerHTML = grupos.map((g, idx) => falhasGrupoHtml(g, prefixo, idx)).join('');
  aplicarIcones(el);
  grupos.forEach((g, idx) => falhasWireGrupo(el, g, destino, prefixo, idx));
}

function falhasGrupoHtml(g, prefixo, idx) {
  const gid = `${prefixo}Grupo${idx}`;
  const periodoTxt = g.primeira_em === g.ultima_em
    ? fmtDate(g.ultima_em)
    : `${fmtDate(g.primeira_em)} – ${fmtDate(g.ultima_em)}`;
  const rotuloReenviar = g.truncado
    ? `Reenviar os ${fmtNumBR(g.event_row_ids.length)} carregados (de ${fmtNumBR(g.quantidade)})`
    : `Reenviar todos (${fmtNumBR(g.quantidade)})`;

  return `
    <details class="falha-grupo falha-grav-${escHtml(g.gravidade)}" id="${gid}">
      <summary>
        ${falhasSeloGravidadeHtml(g.gravidade)}
        ${g.catalogado === false ? '<span class="badge-sem neutro"><i data-lucide="circle-help" aria-hidden="true"></i>não catalogado</span>' : ''}
        <span class="falha-resumo">${escHtml(g.resumo)}</span>
        <span class="falha-contador num">${fmtNumBR(g.quantidade)}</span>
        <span class="falha-periodo">${escHtml(periodoTxt)}</span>
      </summary>
      <div class="falha-corpo">
        <p class="falha-detalhe">${escHtml(g.detalhe)}</p>
        <p class="falha-acao"><b>Ação:</b> ${escHtml(g.acao)}</p>
        ${g.truncado ? `<p class="dash-aviso">Este grupo tem ${fmtNumBR(g.quantidade)} entregas, mas só as ${fmtNumBR(g.event_row_ids.length)} mais recentes foram carregadas aqui — "reenviar" processa só estas. Repita a ação depois de concluído para tratar o restante; nunca fingimos ter reenviado o grupo inteiro de uma vez.</p>` : ''}
        <div class="falha-acoes-grupo">
          <button class="btn btn-primary" type="button" data-reenviar-grupo="${gid}">${rotuloReenviar}</button>
          <button type="button" class="ajuda" data-ajuda="falhas-reenviar-todos"></button>
          <span class="falha-progresso" id="${gid}Progresso" hidden></span>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Recebido</th><th>Evento</th><th>event_id</th><th class="num">Valor</th><th>UTM</th><th class="num">HTTP</th><th class="num">Tentativas</th><th></th></tr></thead>
            <tbody>${g.amostras.map((a, i) => falhasAmostraLinhaHtml(a, gid, i)).join('')}</tbody>
          </table>
        </div>
      </div>
    </details>`;
}

function falhasAmostraLinhaHtml(a, gid, i) {
  return `
    <tr>
      <td>${escHtml(fmtDate(a.received_at))}</td>
      <td>${escHtml(a.event_name || '—')}</td>
      <td title="${escHtml(a.event_id || '')}">${escHtml(shorten(a.event_id))}</td>
      <td class="num">${a.value != null ? escHtml(fmtMoedaBR(a.value)) : '—'}</td>
      <td>${escHtml(a.utm_source || '—')}</td>
      <td class="num">${a.http_status != null ? a.http_status : '—'}</td>
      <td class="num">${a.attempts != null ? a.attempts : '—'}</td>
      <td><button type="button" class="btn btn-ghost falha-ver-payload" data-payload-grupo="${gid}" data-payload-idx="${i}">ver payload enviado</button></td>
    </tr>`;
}

function falhasWireGrupo(container, g, destino, prefixo, idx) {
  const gid = `${prefixo}Grupo${idx}`;
  const btnReenviar = container.querySelector(`[data-reenviar-grupo="${gid}"]`);
  if (btnReenviar) {
    const progressoEl = container.querySelector(`#${gid}Progresso`);
    btnReenviar.addEventListener('click', () => falhasReenviarGrupo(g, btnReenviar, progressoEl, destino, prefixo));
  }
  container.querySelectorAll(`[data-payload-grupo="${gid}"]`).forEach((btn) => {
    btn.addEventListener('click', () => falhasAbrirPayload(g.amostras[Number(btn.dataset.payloadIdx)]));
  });
}

/**
 * Reenvia, em sequência, cada event_row_id do grupo pela mesma rota de reenvio manual
 * (POST /events/:eventDbId/requeue — já existe, não muda). Tolerante a falha
 * individual: um evento que não pôde ser reenfileirado não interrompe o laço, só entra
 * na contagem de falhas do resumo final.
 */
async function falhasReenviarGrupo(g, btn, progressoEl, destino, prefixo) {
  if (btn.disabled) return;
  btn.disabled = true;
  const ids = g.event_row_ids;
  let ok = 0;
  let falhou = 0;
  for (let i = 0; i < ids.length; i++) {
    if (progressoEl) { progressoEl.hidden = false; progressoEl.textContent = `Reenviando ${i + 1} de ${ids.length}…`; }
    try {
      await api('/events/' + ids[i] + '/requeue', { method: 'POST' });
      ok++;
    } catch {
      falhou++;
    }
  }
  const resumoTxt = falhou
    ? `${ok} de ${ids.length} reenviados; ${falhou} não puderam ser reenviados agora.`
    : `${ok} de ${ids.length} reenviados.`;
  if (progressoEl) { progressoEl.hidden = false; progressoEl.textContent = resumoTxt; }
  toast(
    g.truncado
      ? `${resumoTxt} Este grupo tinha mais entregas do que o teto de um lote — repita a ação para tratar o restante.`
      : resumoTxt,
    falhou ? 'warn' : 'ok', 5200
  );
  btn.disabled = false;
  // Dá tempo do worker processar antes de trazer a lista de novo — mesmo intervalo
  // usado no reenvio individual da aba Logs (requeue() em admin/logs.js).
  setTimeout(() => falhasCarregar(destino, prefixo), 1500);
}

// ---------------- "ver payload enviado" ----------------
// A aba Logs não guarda o payload bruto enviado ao destino (só o status/última
// resposta) e não há endpoint admin que devolva o payload completo de uma entrega —
// então, em vez de fingir reaproveitar algo que não existe, este painel mostra os
// dados que a própria entrega já carrega (eram exatamente os usados para montar o
// evento) e diz isso com todas as letras, honestidade que este projeto já pratica em
// src/destinations/erros-explicados.js.
let _falhasModalEl = null;

function _falhasGarantirModal() {
  if (_falhasModalEl) return _falhasModalEl;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'falhasPayloadBackdrop';
  backdrop.innerHTML = `
    <div class="modal modal--payload">
      <h3>Detalhe da entrega</h3>
      <p class="section-d">O payload completo enviado ao destino não fica armazenado — estes são os dados registrados desta tentativa.</p>
      <pre class="falha-payload-json" id="falhasPayloadJson"></pre>
      <div class="form-actions"><button class="btn btn-ghost" type="button" id="falhasPayloadFechar">Fechar</button></div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#falhasPayloadFechar').addEventListener('click', _falhasFecharPayload);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) _falhasFecharPayload(); });
  _falhasModalEl = backdrop;
  return backdrop;
}

function falhasAbrirPayload(amostra) {
  const backdrop = _falhasGarantirModal();
  backdrop.querySelector('#falhasPayloadJson').textContent = JSON.stringify(amostra, null, 2);
  backdrop.classList.add('open');
}

function _falhasFecharPayload() {
  if (_falhasModalEl) _falhasModalEl.classList.remove('open');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _falhasModalEl && _falhasModalEl.classList.contains('open')) _falhasFecharPayload();
});
