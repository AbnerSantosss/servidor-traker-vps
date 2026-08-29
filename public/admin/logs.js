// Aba Logs: tabela de eventos e reenvio manual.
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// ---------------- Logs ----------------

const LOGS_COLUNAS = 9;

// Coluna de dinheiro alinhada à direita e com largura tabular. O cabeçalho vive no
// admin.html (que não é editável nesta fase), então a classe entra daqui — sem ela o
// título ficaria à esquerda e os valores à direita, que lê como desalinhamento.
function logsMarcarColunaNumerica() {
  const th = document.querySelector('#logsTable thead th:nth-child(3)');
  if (th) th.classList.add('num');
}

// Esqueleto no lugar de "Carregando…": a tabela já nasce com a altura que vai ter, então
// nada salta quando as linhas chegam (§2.9 das convenções do painel).
function logsEsqueleto(linhas = 6) {
  const body = $('#logsBody');
  if (!body) return;
  body.innerHTML = '';
  for (let i = 0; i < linhas; i++) {
    const tr = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = LOGS_COLUNAS;
    cell.style.padding = '0';
    cell.innerHTML = '<span class="skeleton skeleton-linha"></span>';
    tr.appendChild(cell);
    body.appendChild(tr);
  }
}

// Estado vazio (ou de erro) ocupando a tabela inteira: sempre com uma frase e uma saída,
// nunca um "Nenhum dado" seco.
function logsEstado({ icone, titulo, texto, acao }) {
  const body = $('#logsBody');
  if (!body) return;
  body.innerHTML = '';
  const tr = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = LOGS_COLUNAS;
  cell.className = 'empty';
  cell.style.padding = '0';
  cell.innerHTML = `
    <div class="estado-vazio">
      <span class="estado-vazio-icone"><i data-lucide="${icone}" aria-hidden="true"></i></span>
      <h4></h4>
      <p></p>
      ${acao ? '<button type="button" class="btn btn-ghost" id="logsEstadoAcao"></button>' : ''}
    </div>`;
  cell.querySelector('h4').textContent = titulo;
  cell.querySelector('p').textContent = texto;
  tr.appendChild(cell);
  body.appendChild(tr);
  aplicarIcones(cell);
  if (acao) {
    const btn = cell.querySelector('#logsEstadoAcao');
    btn.textContent = acao.rotulo;
    btn.addEventListener('click', acao.aoClicar);
  }
}

async function loadLogs() {
  logsMarcarColunaNumerica();
  logsEsqueleto();
  $('#logsCount').textContent = '';
  try {
    const events = await api('/projects/' + state.selectedId + '/events');
    renderLogs(events);
  } catch (err) {
    logsEstado({
      icone: 'plug-zap',
      titulo: 'Não foi possível carregar os logs',
      texto: err.message,
      acao: { rotulo: 'Tentar de novo', aoClicar: loadLogs },
    });
    toast('Erro ao carregar logs: ' + err.message, 'err');
  }
}

function renderLogs(events) {
  const body = $('#logsBody');
  logsMarcarColunaNumerica();
  $('#logsCount').textContent = events.length ? `${events.length} evento(s)` : '';
  if (!events.length) {
    logsEstado({
      icone: 'inbox',
      titulo: 'Nenhum evento recebido ainda',
      texto: 'Assim que a tag do site ou um webhook do seu backend disparar, cada evento aparece aqui com o status de entrega em cada destino.',
      acao: { rotulo: 'Ir para a Instalação', aoClicar: () => activateTab('setup') },
    });
    return;
  }
  body.innerHTML = '';
  for (const ev of events) {
    const tr = document.createElement('tr');
    tr.appendChild(td(fmtDate(ev.receivedAt)));
    tr.appendChild(td(ev.event_name || '—'));
    tr.appendChild(valorCell(ev));
    tr.appendChild(origemCell(ev));
    tr.appendChild(eventIdCell(ev));
    tr.appendChild(destCell(ev.destinations, 'meta'));
    tr.appendChild(destCell(ev.destinations, 'google'));
    tr.appendChild(destCell(ev.destinations, 'postback'));

    const actionTd = document.createElement('td');
    const needsRequeue = Object.values(ev.destinations || {}).some((d) => d && d.status !== 'success');
    if (needsRequeue && Object.keys(ev.destinations || {}).length) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost';
      btn.textContent = 'Reenviar';
      btn.addEventListener('click', () => requeue(ev.id, btn));
      actionTd.appendChild(btn);
    }
    tr.appendChild(actionTd);
    body.appendChild(tr);
  }
  aplicarIcones(body);
}

// Formas de pagamento conhecidas → rótulo legível. O que não estiver aqui aparece
// como veio do backend (não inventamos tradução para o que não conhecemos).
const PAGAMENTO_LABEL = {
  pix: 'Pix',
  credit_card: 'Cartão de crédito',
  creditcard: 'Cartão de crédito',
  debit_card: 'Cartão de débito',
  debitcard: 'Cartão de débito',
  boleto: 'Boleto',
  bank_transfer: 'Transferência',
  bank_slip: 'Boleto',
  paypal: 'PayPal',
  applepay: 'Apple Pay',
  googlepay: 'Google Pay',
  wallet: 'Carteira digital',
  cash: 'Dinheiro',
  free: 'Gratuito',
};

// Pedido e cupom não ganham coluna (poluiriam a tabela) — viram tooltip da célula
// de valor, que é justamente onde o operador olha quando quer conferir a venda.
function detalhePedido(ev) {
  const partes = [];
  if (ev.order_id) partes.push('Pedido: ' + ev.order_id);
  if (ev.coupon) partes.push('Cupom: ' + ev.coupon);
  return partes.join(' · ');
}

// Valor monetário. Cuidado com dois pontos: `0` é um valor legítimo (não pode virar
// "—"), e valores minúsculos (R$ 0,01, comuns com cupom de desconto alto) precisam
// dos centavos — por isso nada de arredondar. A moeda vem do payload do cliente,
// então uma sigla inválida derrubaria o Intl: caímos em BRL nesse caso.
function valorCell(ev) {
  const cell = document.createElement('td');
  cell.className = 'log-valor num';

  const detalhe = detalhePedido(ev);
  if (detalhe) cell.title = detalhe;

  const bruto = ev.value;
  if (bruto === null || bruto === undefined || bruto === '') {
    cell.textContent = '—';
    cell.classList.add('vazio');
    return cell;
  }

  const num = Number(bruto);
  if (!Number.isFinite(num)) {
    cell.textContent = '—';
    cell.classList.add('vazio');
    return cell;
  }

  const moeda = /^[A-Za-z]{3}$/.test(String(ev.currency || '')) ? String(ev.currency).toUpperCase() : 'BRL';
  try {
    cell.textContent = num.toLocaleString('pt-BR', { style: 'currency', currency: moeda });
  } catch {
    cell.textContent = num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  return cell;
}

// "De onde veio este evento": forma de pagamento quando a conversão tem uma;
// senão a origem de tráfego (utm_source). Uma coluna só, sem duplicar informação.
function origemCell(ev) {
  const cell = document.createElement('td');
  cell.className = 'log-origem col-origem';

  if (ev.payment_method) {
    const chave = String(ev.payment_method).toLowerCase().replace(/[\s-]/g, '_');
    const badge = document.createElement('span');
    badge.className = 'pay-badge';
    badge.textContent = PAGAMENTO_LABEL[chave] || ev.payment_method;
    badge.title = 'Forma de pagamento: ' + ev.payment_method;
    cell.appendChild(badge);
    return cell;
  }

  if (ev.utm_source) {
    cell.textContent = ev.utm_source;
    cell.title = 'utm_source: ' + ev.utm_source;
    return cell;
  }

  cell.textContent = '—';
  cell.classList.add('vazio');
  return cell;
}

// event_id encurtado + de onde a requisição entrou. Saber se o evento veio do
// navegador ou do backend é o primeiro passo para diagnosticar deduplicação.
function eventIdCell(ev) {
  const cell = document.createElement('td');

  const id = document.createElement('span');
  id.textContent = shorten(ev.event_id);
  if (ev.event_id) id.title = String(ev.event_id); // o id completo, já que a célula corta
  cell.appendChild(id);

  if (ev.source) {
    const web = ev.source === 'web';
    const badge = document.createElement('span');
    badge.className = 'src-badge' + (web ? ' web' : '');
    badge.textContent = ev.source;
    badge.title = web
      ? 'Chegou pelo navegador (tag do GTM)'
      : 'Chegou pelo backend (webhook server-to-server)';
    cell.append(' ', badge);
  }

  return cell;
}

// Cada status de entrega vira cor + ícone. Cor sozinha não serve: uma em doze pessoas
// não separa verde de vermelho, e esta é a coluna que decide se a venda foi entregue.
const LOGS_DEST_ESTADO = {
  success: { cls: 'success', icone: 'check', label: 'sucesso' },
  error:   { cls: 'error',   icone: 'x',     label: 'erro' },
};

function destCell(destinations, key) {
  const d = destinations && destinations[key];
  const cell = document.createElement('td');
  if (!d) {
    cell.innerHTML = '<span class="pill off"><i data-lucide="minus" aria-hidden="true"></i>desativado</span>';
    return cell;
  }
  const info = LOGS_DEST_ESTADO[d.status] || { cls: 'pending', icone: 'clock', label: d.status };
  const span = document.createElement('span');
  span.className = 'pill ' + info.cls;
  span.innerHTML = `<i data-lucide="${info.icone}" aria-hidden="true"></i>`;
  span.append(info.label + (d.httpStatus ? ` (${d.httpStatus})` : ''));
  if (d.response) span.title = String(d.response);
  cell.appendChild(span);
  return cell;
}

async function requeue(eventDbId, btn) {
  btn.disabled = true;
  try {
    await api('/events/' + eventDbId + '/requeue', { method: 'POST' });
    toast('Reenvio enfileirado. Recarregando logs…', 'ok');
    setTimeout(loadLogs, 1500);
  } catch (err) {
    btn.disabled = false;
    toast('Erro no reenvio: ' + err.message, 'err');
  }
}
