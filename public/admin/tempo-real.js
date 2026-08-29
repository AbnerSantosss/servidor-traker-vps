// Aba "Ao vivo": feed de eventos chegando na plataforma em tempo real, via SSE
// (GET /api/projects/:id/stream). Parte do painel admin — carregado por admin.html na
// ordem definida lá (ver docs/15-convencoes-do-painel.md §2.2).
//
// Regra de ouro deste arquivo: a conexão SSE só pode existir enquanto a aba "Ao vivo"
// está de fato na tela, do projeto certo. O servidor aceita no máximo 20 conexões
// simultâneas (src/admin/stream.js) — uma aba trocada sem fechar a conexão anterior
// estoura esse teto em poucos minutos de uso normal do painel.
'use strict';

// ════════════════════════════════════════════════════════════════════
// ESTADO — tudo em memória do módulo, nunca em `state` (nucleo.js): é sessão da aba,
// não do projeto, e reseta a cada troca de projeto (ver aoVivoResetarSessao).
// ════════════════════════════════════════════════════════════════════

let _aoVivoEs = null;                 // EventSource ativo, ou null (fechado/nunca aberto)
let _aoVivoPollTimer = null;          // setInterval do fallback por polling, ou null
let _aoVivoSparkTimer = null;         // setInterval que redesenha a sparkline
let _aoVivoFalhas = 0;                // falhas consecutivas de conexão SSE, zera ao abrir
let _aoVivoAbaAtiva = false;          // a aba "Ao vivo" está na tela agora?
let _aoVivoProjetoAtual = null;       // projeto da sessão atual, para saber quando resetar

const _aoVivoCartoes = new Map();     // event_row_id -> modelo normalizado do card
const _aoVivoOrdem = [];              // ids em ordem de chegada, mais recente primeiro
const _aoVivoEntregasPendentes = new Map(); // event_row_id -> {destino: dados} (entrega chegou antes do evento)
const AOVIVO_LIMITE_CARDS = 200;      // teto de memória: aba aberta a noite toda não pode crescer sem fim

let _aoVivoContadores = { eventos: 0, conversoes: 0, receita: 0 };
let _aoVivoEventosTimestamps = [];    // epoch ms de cada evento, para a sparkline de 15 min

let _aoVivoPausado = false;
let _aoVivoPendentesExibicao = 0;     // quantos cards chegaram desde que a rolagem foi pausada
let _aoVivoFiltroTipo = '';
let _aoVivoSomenteConversoes = false;
let _aoVivoDetalheAbertoId = null;

const AOVIVO_ROTULO_DESTINO = { meta: 'Meta', google: 'Google', postback: 'Postback' };

// ════════════════════════════════════════════════════════════════════
// CICLO DE VIDA — abrir ao entrar na aba, fechar ao sair ou trocar de projeto
// ════════════════════════════════════════════════════════════════════

function aoVivoAbrirAba() {
  if (!state.selectedId) return;
  aoVivoMontarEsqueleto();
  _aoVivoAbaAtiva = true;
  if (_aoVivoProjetoAtual !== state.selectedId) {
    aoVivoResetarSessao();
    _aoVivoProjetoAtual = state.selectedId;
  }
  aoVivoIniciarSparkTimer();
  aoVivoConectar();
}

function aoVivoFechar() {
  _aoVivoAbaAtiva = false;
  clearTimeout(_aoVivoEsperaTimer);
  if (_aoVivoEs) { try { _aoVivoEs.close(); } catch { /* já fechado */ } _aoVivoEs = null; }
  if (_aoVivoPollTimer) { clearInterval(_aoVivoPollTimer); _aoVivoPollTimer = null; }
  aoVivoPararSparkTimer();
}

registrarAoAbrirAba('aovivo', aoVivoAbrirAba);

// Troca de projeto sempre fecha a conexão — mesmo que a aba "Ao vivo" nem esteja aberta,
// não custa nada checar, e é a rede de segurança contra qualquer caminho que eu não
// tenha previsto de deixar uma conexão presa a um projeto que não existe mais na tela.
registrarAoTrocarProjeto(() => { aoVivoFechar(); _aoVivoProjetoAtual = null; });

// navegacao.js não avisa "saindo da aba X" — só "abrindo a aba Y". Delegar o clique nos
// botões de aba supre essa lacuna sem tocar em navegacao.js: qualquer clique em uma aba
// que não seja "aovivo" implica que estamos saindo dela (ou já tínhamos saído).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn && btn.dataset.tab !== 'aovivo') aoVivoFechar();
});

// Fechamento de página: o navegador mata a conexão de qualquer jeito, mas parar o timer
// de sparkline e o cronômetro de polling evita um instante de trabalho inútil no unload.
window.addEventListener('beforeunload', aoVivoFechar);

function aoVivoResetarSessao() {
  _aoVivoContadores = { eventos: 0, conversoes: 0, receita: 0 };
  _aoVivoCartoes.clear();
  _aoVivoOrdem.length = 0;
  _aoVivoEntregasPendentes.clear();
  _aoVivoEventosTimestamps = [];
  _aoVivoPendentesExibicao = 0;
  _aoVivoFalhas = 0;
  _aoVivoFiltroTipo = '';
  _aoVivoSomenteConversoes = false;
  _aoVivoPausado = false;
  aoVivoFecharDetalhe();

  // Esqueleto e não vazio: trocar de projeto sempre reabre a conexão logo em seguida,
  // e "esperando o stream" é uma mensagem diferente de "nada chegou".
  const feed = $('#aoVivoFeed');
  if (feed) aoVivoFeedEsperando(feed);
  const selTipo = $('#aoVivoFiltroTipo');
  if (selTipo) selTipo.innerHTML = '<option value="">Todos</option>';
  const chkConv = $('#aoVivoSomenteConversoes');
  if (chkConv) chkConv.checked = false;
  const btnPausar = $('#aoVivoBtnPausar');
  if (btnPausar) { btnPausar.textContent = 'Pausar'; btnPausar.classList.remove('is-ativo'); }
  aoVivoAtualizarBotaoNovos();

  $('#aoVivoCEventos').textContent = '0';
  $('#aoVivoCConversoes').textContent = '0';
  $('#aoVivoCReceita').textContent = fmtMoedaBR(0);
}

// ════════════════════════════════════════════════════════════════════
// CONEXÃO SSE — com fallback honesto para polling depois de 3 falhas
// ════════════════════════════════════════════════════════════════════

function aoVivoConectar() {
  if (!state.selectedId || _aoVivoEs || _aoVivoPollTimer) return;
  aoVivoSetIndicador('reconectando');

  const projetoDestaConexao = state.selectedId;
  const es = new EventSource('/api/projects/' + projetoDestaConexao + '/stream');
  _aoVivoEs = es;

  es.addEventListener('open', () => {
    if (es !== _aoVivoEs) return;
    _aoVivoFalhas = 0;
    aoVivoSetIndicador('ao-vivo');
  });

  es.addEventListener('evento_novo', (ev) => {
    if (es !== _aoVivoEs || state.selectedId !== projetoDestaConexao) return;
    try { aoVivoReceberEvento(aoVivoAdaptarSSE(JSON.parse(ev.data))); }
    catch (err) { console.error('[ao vivo] evento_novo malformado', err); }
  });

  es.addEventListener('entrega_atualizada', (ev) => {
    if (es !== _aoVivoEs || state.selectedId !== projetoDestaConexao) return;
    try { aoVivoReceberEntrega(JSON.parse(ev.data)); }
    catch (err) { console.error('[ao vivo] entrega_atualizada malformada', err); }
  });

  es.onerror = () => {
    if (es !== _aoVivoEs) return; // conexão antiga, já substituída ou fechada — eco tardio
    _aoVivoFalhas++;
    aoVivoSetIndicador('reconectando');

    if (_aoVivoFalhas >= 3) {
      es.close();
      _aoVivoEs = null;
      aoVivoIniciarPolling();
      return;
    }

    // readyState CLOSED = o navegador NÃO vai tentar de novo sozinho — é o que acontece
    // quando a resposta inicial já chega recusada (ex.: 503 de limite de conexões), sem
    // nunca virar de fato um stream. readyState CONNECTING = ele já está retentando por
    // conta própria; não precisamos fazer nada além de esperar o próximo 'error'.
    if (es.readyState === EventSource.CLOSED) {
      _aoVivoEs = null;
      setTimeout(() => {
        if (_aoVivoAbaAtiva && state.selectedId === projetoDestaConexao) aoVivoConectar();
      }, 2000);
    }
  };
}

// Único fim honesto de diagnosticar POR QUE a conexão SSE não vingou: o EventSource não
// expõe o status HTTP da resposta (é uma limitação da própria API do navegador). Uma
// requisição comum ao mesmo endpoint devolve isso — e como o servidor só registra o
// cliente DEPOIS de checar o limite (src/admin/stream.js), este diagnóstico não consome
// uma vaga de conexão real quando a resposta é 503.
async function aoVivoDiagnosticarFalha() {
  try {
    const res = await fetch('/api/projects/' + state.selectedId + '/stream', { credentials: 'same-origin' });
    if (res.body && typeof res.body.cancel === 'function') {
      try { await res.body.cancel(); } catch { /* stream já pode ter fechado sozinho */ }
    }
    return res.status === 503 ? '503' : null;
  } catch {
    return null;
  }
}

async function aoVivoIniciarPolling() {
  if (_aoVivoPollTimer) return;
  aoVivoSetIndicador('polling');
  const projetoAtual = state.selectedId;

  const diagnostico = await aoVivoDiagnosticarFalha();
  if (!_aoVivoAbaAtiva || state.selectedId !== projetoAtual) return; // saiu enquanto diagnosticava

  toast(
    diagnostico === '503'
      ? 'Muitas conexões de tempo real abertas agora — atualizando a cada 10s. Feche outra aba do painel para voltar ao modo ao vivo.'
      : 'Não foi possível manter a conexão ao vivo — atualizando a cada 10 segundos.',
    'warn', 6200
  );

  aoVivoPollUmaVez();
  _aoVivoPollTimer = setInterval(aoVivoPollUmaVez, 10000);
}

// GET /api/projects/:id/events não tem o mesmo detalhe do stream (sem payload completo,
// sem tem_fbc/tem_gclid, sem utm_medium/campaign) — é a lista "crua" que a aba Logs já
// usa, reaproveitada aqui como o melhor substituto disponível enquanto o SSE não volta.
async function aoVivoPollUmaVez() {
  if (!state.selectedId || !_aoVivoAbaAtiva) return;
  const projetoAtual = state.selectedId;
  try {
    const eventos = await api('/projects/' + projetoAtual + '/events?limit=50');
    if (state.selectedId !== projetoAtual) return; // projeto trocou enquanto a busca corria
    // Mais antigo primeiro: cada um entra no feed na ordem certa (o mais novo por último
    // acaba no topo, exatamente como o SSE entregaria em tempo real).
    for (const ev of [...eventos].reverse()) {
      if (_aoVivoCartoes.has(ev.id)) {
        aoVivoAtualizarDestinosPolling(ev.id, ev.destinations);
      } else {
        aoVivoReceberEvento(aoVivoAdaptarPolling(ev));
      }
    }
  } catch (err) {
    console.error('[ao vivo] falha ao atualizar por polling', err);
  }
}

// ════════════════════════════════════════════════════════════════════
// ADAPTADORES — normalizam a linha crua do stream e a linha da lista de eventos para o
// mesmo modelo de card, escondendo do resto do arquivo a diferença de formato das duas
// fontes possíveis (SSE vs. polling).
// ════════════════════════════════════════════════════════════════════

function aoVivoAdaptarSSE(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    eventName: row.event_name,
    source: row.source,
    receivedAt: row.received_at,
    value: row.value,
    currency: row.currency,
    utmSource: row.utm_source,
    payload: row.payload || null,
    temFbc: row.tem_fbc,
    temGclid: row.tem_gclid,
    destinos: {},
  };
}

function aoVivoAdaptarPolling(ev) {
  const destinos = {};
  for (const [tipo, d] of Object.entries(ev.destinations || {})) {
    destinos[tipo] = { status: d.status, httpStatus: d.httpStatus, attempts: d.attempts, response: d.response };
  }
  return {
    id: ev.id,
    eventId: ev.event_id,
    eventName: ev.event_name,
    source: ev.source,
    receivedAt: ev.receivedAt,
    value: ev.value,
    currency: ev.currency,
    utmSource: ev.utm_source,
    payload: null, // não vem no /events — o painel de detalhe explica essa limitação
    temFbc: null,
    temGclid: null,
    destinos,
  };
}

// ════════════════════════════════════════════════════════════════════
// RECEBER DADOS — evento novo e atualização de entrega
// ════════════════════════════════════════════════════════════════════

function aoVivoReceberEvento(modelo) {
  if (!modelo || _aoVivoCartoes.has(modelo.id)) return;

  const pendentes = _aoVivoEntregasPendentes.get(modelo.id);
  if (pendentes) {
    Object.assign(modelo.destinos, pendentes);
    _aoVivoEntregasPendentes.delete(modelo.id);
  }

  _aoVivoCartoes.set(modelo.id, modelo);
  _aoVivoOrdem.unshift(modelo.id);
  aoVivoAtualizarContadores(modelo);
  _aoVivoEventosTimestamps.push(Date.now());
  aoVivoAtualizarFiltroTipo(modelo.eventName);

  if (_aoVivoPausado) {
    _aoVivoPendentesExibicao++;
    aoVivoAtualizarBotaoNovos();
  } else {
    aoVivoInserirCardNoFeed(modelo);
  }

  aoVivoAplicarLimiteMemoria();
}

function aoVivoReceberEntrega(delivery) {
  const id = delivery.event_row_id;
  const dados = {
    status: delivery.status, httpStatus: delivery.http_status,
    attempts: delivery.attempts, response: delivery.response, lastError: delivery.last_error,
  };

  const card = _aoVivoCartoes.get(id);
  if (!card) {
    // A entrega pode chegar antes do próprio evento_novo (mesma corrida descrita na
    // fase) — guarda e aplica assim que o card existir.
    if (!_aoVivoEntregasPendentes.has(id)) _aoVivoEntregasPendentes.set(id, {});
    _aoVivoEntregasPendentes.get(id)[delivery.destination_type] = dados;
    if (_aoVivoEntregasPendentes.size > 300) {
      _aoVivoEntregasPendentes.delete(_aoVivoEntregasPendentes.keys().next().value);
    }
    return;
  }

  card.destinos[delivery.destination_type] = dados;
  aoVivoAtualizarSeloDestino(id, delivery.destination_type, dados);
  if (_aoVivoDetalheAbertoId === id) aoVivoRenderizarDetalhe(card);
}

function aoVivoAtualizarDestinosPolling(id, destinations) {
  const card = _aoVivoCartoes.get(id);
  if (!card || !destinations) return;
  for (const [tipo, d] of Object.entries(destinations)) {
    const anterior = card.destinos[tipo];
    if (anterior && anterior.status === d.status) continue; // nada mudou, não reanima à toa
    card.destinos[tipo] = { status: d.status, httpStatus: d.httpStatus, attempts: d.attempts, response: d.response };
    aoVivoAtualizarSeloDestino(id, tipo, card.destinos[tipo]);
  }
  if (_aoVivoDetalheAbertoId === id) aoVivoRenderizarDetalhe(card);
}

// ════════════════════════════════════════════════════════════════════
// CONTADORES E SPARKLINE
// ════════════════════════════════════════════════════════════════════

function aoVivoAtualizarContadores(modelo) {
  _aoVivoContadores.eventos++;
  if (modelo.eventName === 'purchase') {
    _aoVivoContadores.conversoes++;
    if (modelo.value != null) _aoVivoContadores.receita += Number(modelo.value) || 0;
  }
  $('#aoVivoCEventos').textContent = fmtNumBR(_aoVivoContadores.eventos);
  $('#aoVivoCConversoes').textContent = fmtNumBR(_aoVivoContadores.conversoes);
  $('#aoVivoCReceita').textContent = fmtMoedaBR(_aoVivoContadores.receita);
}

function aoVivoIniciarSparkTimer() {
  if (_aoVivoSparkTimer) return;
  aoVivoDesenharSpark();
  _aoVivoSparkTimer = setInterval(aoVivoDesenharSpark, 15000);
}

function aoVivoPararSparkTimer() {
  if (_aoVivoSparkTimer) { clearInterval(_aoVivoSparkTimer); _aoVivoSparkTimer = null; }
}

function aoVivoDesenharSpark() {
  const el = $('#aoVivoSpark');
  if (!el) return;
  if (!temGraficos()) { el.hidden = true; return; } // degradação sem ECharts: só some, contadores continuam

  const agora = Date.now();
  const janela = 15 * 60 * 1000;
  _aoVivoEventosTimestamps = _aoVivoEventosTimestamps.filter((t) => agora - t <= janela);

  const baldes = 15; // um por minuto
  const contagem = new Array(baldes).fill(0);
  for (const t of _aoVivoEventosTimestamps) {
    const minutosAtras = Math.floor((agora - t) / 60000);
    if (minutosAtras >= 0 && minutosAtras < baldes) contagem[baldes - 1 - minutosAtras]++;
  }

  el.hidden = false;
  grafico(el, {
    grid: { left: 2, right: 2, top: 4, bottom: 2 },
    xAxis: { type: 'category', show: false, data: contagem.map((_, i) => i) },
    yAxis: { type: 'value', show: false },
    tooltip: { show: false },
    series: [{ type: 'line', data: contagem, smooth: true, symbol: 'none', areaStyle: { opacity: .18 }, lineStyle: { width: 2 } }],
  }, { altura: 40 });
}

// ════════════════════════════════════════════════════════════════════
// INDICADOR DE CONEXÃO
// ════════════════════════════════════════════════════════════════════

// Os bullets tipográficos (●/○/↻) saíram: o ponto ao lado já é o mesmo sinal, agora com
// cor semântica e animação própria por estado, e o texto sozinho já distingue os três —
// que é o canal que sobra para quem não separa verde de âmbar.
const AOVIVO_INDICADOR_TEXTO = {
  'ao-vivo': 'ao vivo',
  'reconectando': 'reconectando…',
  'polling': 'polling (10s)',
};

function aoVivoSetIndicador(estado) {
  const el = $('#aoVivoIndicador');
  if (!el) return;
  el.dataset.estado = estado;
  const texto = el.querySelector('.aovivo-indicador-texto');
  if (texto) texto.textContent = AOVIVO_INDICADOR_TEXTO[estado] || estado;

  // Conexão de pé e nenhum card ainda: a espera deixa de ser "carregando" e passa a ser
  // "não chegou nada", que são duas mensagens diferentes para o operador.
  if (estado !== 'reconectando' && !_aoVivoOrdem.length) {
    const feed = $('#aoVivoFeed');
    if (feed && feed.querySelector('.skeleton')) aoVivoFeedVazio(feed);
  }
}

// ════════════════════════════════════════════════════════════════════
// FEED — inserção, filtros, limite de memória
// ════════════════════════════════════════════════════════════════════

function aoVivoHoraCurta(iso) {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  return isNaN(d) ? '--:--:--' : d.toLocaleTimeString('pt-BR');
}

// Enquanto a conexão não abre não há "nada" a mostrar, mas também não há erro: as
// silhuetas ocupam a altura exata dos cards que vão chegar, então o feed não salta no
// primeiro evento.
//
// O esqueleto tem prazo. O evento `open` do EventSource depende de o servidor mandar o
// primeiro byte, e o heartbeat do stream é de 25s (src/admin/stream.js) — atrás de um
// proxy que faz buffer, "conectando" duraria esses 25s inteiros. Um esqueleto que
// brilha por meio minuto deixa de dizer "já vem" e passa a dizer "travou", então depois
// de alguns segundos ele cede lugar ao estado vazio, que é a informação verdadeira: a
// conexão continua sendo tentada (o indicador diz isso) e nada chegou ainda.
const AOVIVO_ESPERA_MAX_MS = 4000;
let _aoVivoEsperaTimer = null;

function aoVivoFeedEsperando(feed) {
  if (!feed) return;
  feed.innerHTML = '<div class="skeleton aovivo-skeleton-card"></div>'.repeat(3);
  clearTimeout(_aoVivoEsperaTimer);
  _aoVivoEsperaTimer = setTimeout(() => {
    const atual = $('#aoVivoFeed');
    if (atual && atual.querySelector('.skeleton')) aoVivoFeedVazio(atual);
  }, AOVIVO_ESPERA_MAX_MS);
}

// "Nenhum dado" seco não ajuda ninguém: o operador precisa saber que a espera é normal
// e por onde disparar o primeiro evento (§2.9 das convenções do painel).
function aoVivoFeedVazio(feed) {
  if (!feed) return;
  clearTimeout(_aoVivoEsperaTimer);
  feed.innerHTML = `
    <div class="estado-vazio">
      <span class="estado-vazio-icone"><i data-lucide="radio" aria-hidden="true"></i></span>
      <h4>Aguardando o primeiro evento</h4>
      <p>Esta aba mostra cada evento no instante em que ele chega. Enquanto ninguém navega no site nem o backend dispara um webhook, ela fica assim mesmo.</p>
      <button type="button" class="btn btn-ghost" id="aoVivoIrTestar">Disparar um evento de teste</button>
    </div>`;
  aplicarIcones(feed);
  const btn = feed.querySelector('#aoVivoIrTestar');
  if (btn) btn.addEventListener('click', () => activateTab('testar'));
}

// Três estados que precisam ser lidos sem depender de cor: presente, ausente e
// desconhecido (o polling não traz o payload, então "não sei" é uma resposta honesta).
function aoVivoMarcaBool(v) {
  if (v === true) return { cls: 'is-on', icone: 'check' };
  if (v === false) return { cls: 'is-off', icone: 'minus' };
  return { cls: 'is-desconhecido', icone: 'help-circle' };
}

// fbc e gclid têm coluna própria (tem_fbc/tem_gclid); fbp não — é lido direto do payload
// quando ele está disponível (não está no modo polling, daí o "?" honesto nesse caso).
function aoVivoBadgesIdentificadores(modelo) {
  const u = (modelo.payload && modelo.payload.user_data) || null;
  const fbc = aoVivoMarcaBool(modelo.temFbc);
  const gclid = aoVivoMarcaBool(modelo.temGclid);
  const fbp = aoVivoMarcaBool(u ? Boolean(u.fbp) : null);
  return `
    <span class="aovivo-selo ${fbc.cls}" title="fbc — cookie de clique da Meta"><i data-lucide="${fbc.icone}" aria-hidden="true"></i>fbc</span>
    <span class="aovivo-selo ${fbp.cls}" title="fbp — cookie do navegador da Meta"><i data-lucide="${fbp.icone}" aria-hidden="true"></i>fbp</span>
    <span class="aovivo-selo ${gclid.cls}" title="gclid — clique do Google Ads"><i data-lucide="${gclid.icone}" aria-hidden="true"></i>gclid</span>`;
}

function aoVivoInfoStatus(status) {
  switch (status) {
    case 'success': return { cls: 'ok', icone: 'check', titulo: 'entregue com sucesso' };
    case 'error': return { cls: 'retry', icone: 'rotate-cw', titulo: 'falhou, tentando de novo' };
    case 'dead': return { cls: 'dead', icone: 'x', titulo: 'falhou e parou de tentar' };
    case 'pending':
    case 'processing': return { cls: 'pending', icone: 'loader', titulo: 'enviando…' };
    case 'skipped_consent':
    case 'skipped_unmapped': return { cls: 'skip', icone: 'minus', titulo: 'não enviado (comportamento esperado)' };
    default: return { cls: 'vazio', icone: 'minus', titulo: 'sem registro de entrega ainda' };
  }
}

function aoVivoSeloDestinoHtml(tipo, dados) {
  const rot = AOVIVO_ROTULO_DESTINO[tipo] || tipo;
  const info = aoVivoInfoStatus(dados && dados.status);
  return `<span class="aovivo-destino aovivo-destino--${info.cls}" data-destino="${escHtml(tipo)}" title="${escHtml(rot + ': ' + info.titulo)}">
    <i data-lucide="${info.icone}" aria-hidden="true"></i>${escHtml(rot)}
  </span>`;
}

function aoVivoCardHtml(modelo) {
  const badges = aoVivoBadgesIdentificadores(modelo);
  const destinos = ['meta', 'google', 'postback'].map((t) => aoVivoSeloDestinoHtml(t, modelo.destinos[t])).join('');
  const valorTxt = modelo.value != null ? fmtMoedaBR(modelo.value) : '';
  const hora = aoVivoHoraCurta(modelo.receivedAt);
  const classeTipo = modelo.eventName === 'purchase' ? ' aovivo-card--purchase' : '';
  return `
    <article class="aovivo-card${classeTipo} aovivo-entrando" data-card-id="${escHtml(String(modelo.id))}" data-evento="${escHtml(modelo.eventName || '')}" tabindex="0" role="button" aria-label="Ver detalhe do evento ${escHtml(modelo.eventName || '')}">
      <div class="aovivo-card-topo">
        <span class="aovivo-card-nome">${escHtml(modelo.eventName || '—')}</span>
        <span class="aovivo-card-origem">${modelo.source === 'webhook' ? 'webhook' : 'web'}</span>
        <span class="aovivo-card-hora">${hora}</span>
      </div>
      <div class="aovivo-card-meio">
        ${valorTxt ? `<span class="aovivo-card-valor">${valorTxt}</span>` : '<span class="aovivo-card-valor aovivo-card-valor--vazio">—</span>'}
        <div class="aovivo-card-selos">${badges}</div>
      </div>
      <div class="aovivo-card-destinos">${destinos}</div>
    </article>`;
}

function aoVivoCardPassaFiltro(modelo) {
  if (_aoVivoSomenteConversoes && modelo.eventName !== 'purchase') return false;
  if (_aoVivoFiltroTipo && modelo.eventName !== _aoVivoFiltroTipo) return false;
  return true;
}

function aoVivoInserirCardNoFeed(modelo) {
  const feed = $('#aoVivoFeed');
  if (!feed) return;
  // O estado vazio (ou o esqueleto de espera) sai inteiro no primeiro card: ele não é
  // uma linha da lista, é o lugar da lista.
  const placeholder = feed.querySelector('.estado-vazio, .skeleton');
  if (placeholder) feed.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.innerHTML = aoVivoCardHtml(modelo);
  const el = wrapper.firstElementChild;
  el.hidden = !aoVivoCardPassaFiltro(modelo);
  el.addEventListener('click', () => aoVivoAbrirDetalhe(modelo.id));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); aoVivoAbrirDetalhe(modelo.id); }
  });
  feed.prepend(el);
  aplicarIcones(el);
}

function aoVivoReaplicarFiltros() {
  const feed = $('#aoVivoFeed');
  if (!feed) return;
  for (const id of _aoVivoOrdem) {
    const modelo = _aoVivoCartoes.get(id);
    const el = feed.querySelector(`.aovivo-card[data-card-id="${CSS.escape(String(id))}"]`);
    if (modelo && el) el.hidden = !aoVivoCardPassaFiltro(modelo);
  }
}

function aoVivoAtualizarFiltroTipo(nome) {
  if (!nome) return;
  const sel = $('#aoVivoFiltroTipo');
  if (!sel || sel.querySelector(`option[value="${CSS.escape(nome)}"]`)) return;
  const opt = document.createElement('option');
  opt.value = nome;
  opt.textContent = nome;
  sel.appendChild(opt);
}

function aoVivoAtualizarSeloDestino(id, tipo, dados) {
  const card = document.querySelector(`.aovivo-card[data-card-id="${CSS.escape(String(id))}"]`);
  if (!card) return; // card pode já ter saído do feed pelo teto de memória — não é erro
  const seloAntigo = card.querySelector(`.aovivo-destino[data-destino="${CSS.escape(tipo)}"]`);
  if (!seloAntigo) return;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = aoVivoSeloDestinoHtml(tipo, dados);
  const novo = wrapper.firstElementChild;
  novo.classList.add('aovivo-destino--mudou');
  seloAntigo.replaceWith(novo);
  aplicarIcones(card);
}

function aoVivoAplicarLimiteMemoria() {
  while (_aoVivoOrdem.length > AOVIVO_LIMITE_CARDS) {
    const idAntigo = _aoVivoOrdem.pop();
    _aoVivoCartoes.delete(idAntigo);
    const el = document.querySelector(`.aovivo-card[data-card-id="${CSS.escape(String(idAntigo))}"]`);
    if (el) el.remove();
    if (_aoVivoDetalheAbertoId === idAntigo) aoVivoFecharDetalhe();
  }
}

// ════════════════════════════════════════════════════════════════════
// CONTROLES — pausar/retomar, "N novos"
// ════════════════════════════════════════════════════════════════════

function aoVivoTogglePausa() {
  _aoVivoPausado = !_aoVivoPausado;
  const btn = $('#aoVivoBtnPausar');
  if (btn) {
    btn.textContent = _aoVivoPausado ? 'Retomar' : 'Pausar';
    btn.classList.toggle('is-ativo', _aoVivoPausado);
  }
  if (!_aoVivoPausado) aoVivoExibirPendentes();
}

function aoVivoAtualizarBotaoNovos() {
  const btn = $('#aoVivoBtnNovos');
  if (!btn) return;
  btn.hidden = _aoVivoPendentesExibicao === 0;
  btn.textContent = `${_aoVivoPendentesExibicao} novo${_aoVivoPendentesExibicao === 1 ? '' : 's'}`;
}

function aoVivoExibirPendentes() {
  // Insere, do mais antigo para o mais novo, todos os cards acumulados enquanto a
  // rolagem estava pausada — sem isso "pausar" viraria "perder", que é exatamente o
  // comportamento que a fase pediu para evitar.
  const idsPendentes = _aoVivoOrdem.slice(0, _aoVivoPendentesExibicao).reverse();
  for (const id of idsPendentes) {
    const modelo = _aoVivoCartoes.get(id);
    if (modelo && !document.querySelector(`.aovivo-card[data-card-id="${CSS.escape(String(id))}"]`)) {
      aoVivoInserirCardNoFeed(modelo);
    }
  }
  _aoVivoPendentesExibicao = 0;
  aoVivoAtualizarBotaoNovos();
}

// ════════════════════════════════════════════════════════════════════
// PAINEL LATERAL DE DETALHE
// ════════════════════════════════════════════════════════════════════

function aoVivoAbrirDetalhe(id) {
  const modelo = _aoVivoCartoes.get(id);
  if (!modelo) return;
  _aoVivoDetalheAbertoId = id;
  aoVivoRenderizarDetalhe(modelo);
  const painel = $('#aoVivoDetalhe');
  if (painel) painel.hidden = false;
}

function aoVivoRenderizarDetalhe(modelo) {
  const corpo = $('#aoVivoDetalheCorpo');
  if (!corpo) return;

  const destinosHtml = ['meta', 'google', 'postback'].map((t) => {
    const d = modelo.destinos[t];
    const info = aoVivoInfoStatus(d && d.status);
    const http = d && d.httpStatus != null ? ` (HTTP ${d.httpStatus})` : '';
    return `<li><b>${escHtml(AOVIVO_ROTULO_DESTINO[t])}:</b> ${escHtml(info.titulo)}${escHtml(http)}</li>`;
  }).join('');

  const payloadHtml = modelo.payload
    ? `<pre class="falha-payload-json">${escHtml(JSON.stringify(modelo.payload, null, 2))}</pre>`
    : `<p class="aovivo-detalhe-nota">O payload completo não vem no modo de atualização por polling — volte ao modo ao vivo (reabra a aba) para ver o payload inteiro.</p>`;

  corpo.innerHTML = `
    <dl class="aovivo-detalhe-meta">
      <div><dt>Evento</dt><dd>${escHtml(modelo.eventName || '—')}</dd></div>
      <div><dt>Recebido</dt><dd>${escHtml(fmtDate(modelo.receivedAt))}</dd></div>
      <div><dt>Origem</dt><dd>${modelo.source === 'webhook' ? 'webhook (backend)' : 'navegador'}</dd></div>
      ${modelo.value != null ? `<div><dt>Valor</dt><dd>${escHtml(fmtMoedaBR(modelo.value))} ${escHtml(modelo.currency || '')}</dd></div>` : ''}
      ${modelo.utmSource ? `<div><dt>UTM source</dt><dd>${escHtml(modelo.utmSource)}</dd></div>` : ''}
      <div><dt>event_id</dt><dd>${escHtml(modelo.eventId || '—')}</dd></div>
    </dl>
    <h5>Entregas</h5>
    <ul class="aovivo-detalhe-entregas">${destinosHtml}</ul>
    <h5>Payload (já mascarado)</h5>
    ${payloadHtml}`;
}

function aoVivoFecharDetalhe() {
  _aoVivoDetalheAbertoId = null;
  const el = $('#aoVivoDetalhe');
  if (el) el.hidden = true;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _aoVivoDetalheAbertoId) aoVivoFecharDetalhe();
});

// ════════════════════════════════════════════════════════════════════
// ESQUELETO — montado uma vez, o resto é sempre re-render de conteúdo interno
// ════════════════════════════════════════════════════════════════════

function aoVivoMontarEsqueleto() {
  const painel = $('#painelAoVivo');
  if (!painel || painel.dataset.aovivoMontado) return;
  painel.dataset.aovivoMontado = '1';

  painel.innerHTML = `
    <div class="aovivo-topo">
      <div class="aovivo-contadores">
        <div class="aovivo-contador"><span class="aovivo-contador-valor num" id="aoVivoCEventos">0</span><span class="aovivo-contador-rotulo">eventos</span></div>
        <div class="aovivo-contador"><span class="aovivo-contador-valor num" id="aoVivoCConversoes">0</span><span class="aovivo-contador-rotulo">conversões</span></div>
        <div class="aovivo-contador"><span class="aovivo-contador-valor num" id="aoVivoCReceita">R$ 0,00</span><span class="aovivo-contador-rotulo">receita da sessão</span></div>
      </div>
      <div class="aovivo-spark-wrap">
        <div class="aovivo-spark" id="aoVivoSpark" hidden></div>
        <span class="aovivo-spark-rotulo muted">últimos 15 min</span>
      </div>
      <div class="aovivo-indicador" id="aoVivoIndicador" data-estado="reconectando">
        <span class="aovivo-indicador-ponto"></span>
        <span class="aovivo-indicador-texto">conectando…</span>
        <button type="button" class="ajuda" data-ajuda="aovivo-indicador"></button>
      </div>
    </div>

    <div class="aovivo-controles">
      <button type="button" class="btn btn-ghost" id="aoVivoBtnPausar">Pausar</button>
      <button type="button" class="ajuda" data-ajuda="aovivo-pausar-feed"></button>
      <div class="filter-group">
        <label for="aoVivoFiltroTipo">Tipo</label>
        <select id="aoVivoFiltroTipo"><option value="">Todos</option></select>
      </div>
      <label class="falhas-check">
        <input type="checkbox" id="aoVivoSomenteConversoes" />
        Somente conversões
      </label>
      <button type="button" class="btn btn-primary aovivo-btn-novos" id="aoVivoBtnNovos" hidden>0 novos</button>
    </div>

    <div class="aovivo-legenda">
      <span>Identificadores no card <button type="button" class="ajuda" data-ajuda="aovivo-selos-identificadores"></button></span>
      <span>Destinos no card <button type="button" class="ajuda" data-ajuda="aovivo-destinos-card"></button></span>
    </div>

    <div class="aovivo-corpo">
      <div class="aovivo-feed" id="aoVivoFeed"></div>
      <aside class="aovivo-detalhe" id="aoVivoDetalhe" hidden>
        <div class="aovivo-detalhe-topo">
          <h4>Detalhe do evento</h4>
          <button type="button" class="btn btn-ghost" id="aoVivoDetalheFechar">Fechar</button>
        </div>
        <div class="aovivo-detalhe-corpo" id="aoVivoDetalheCorpo"></div>
      </aside>
    </div>`;

  aplicarIcones(painel);
  aoVivoFeedEsperando($('#aoVivoFeed'));

  $('#aoVivoBtnPausar').addEventListener('click', aoVivoTogglePausa);
  $('#aoVivoBtnNovos').addEventListener('click', aoVivoExibirPendentes);
  $('#aoVivoFiltroTipo').addEventListener('change', (e) => { _aoVivoFiltroTipo = e.target.value; aoVivoReaplicarFiltros(); });
  $('#aoVivoSomenteConversoes').addEventListener('change', (e) => { _aoVivoSomenteConversoes = e.target.checked; aoVivoReaplicarFiltros(); });
  $('#aoVivoDetalheFechar').addEventListener('click', aoVivoFecharDetalhe);
}
