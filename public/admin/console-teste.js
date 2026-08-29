// Aba Testar: console de testes (modo, destino, payload, disparo e leitura do resultado).
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// ════════════════════════════════════════════════════════════════════
// ABA TESTAR — console de testes
//
// Três decisões (o que fazer · para onde · com qual payload) e três leituras
// do resultado (como foi interpretado · o que saiu no fio · o que faltou).
// A regra que organiza a tela: o operador precisa ver o JSON exato ANTES de
// aceitar mandá-lo para a conta de produção.
// ════════════════════════════════════════════════════════════════════

// Os três modos são uma ESCALA DE GRAVIDADE, e a escala precisa aparecer em três
// canais ao mesmo tempo: a palavra (rótulo do botão), o desenho (ícone Lucide) e a cor
// (a pílula da nota e a classe do botão). Cor sozinha não serve — quem não separa
// vermelho de verde ficaria com "Simular" e "Enviar de verdade" com a mesma cara, e a
// diferença entre os dois é dinheiro real gasto no pixel de produção.
const MODOS_TESTE = {
  simular: {
    rotulo: 'Simular envio',
    classe: 'btn-primary',
    icone: 'eye',
    pill: 'info',
    nota: 'nada é enviado para a plataforma',
    risco: '<b>Nada sai daqui.</b> O servidor monta o payload, mostra a URL de destino e o JSON exato — e para. Pode repetir quantas vezes quiser.',
  },
  teste: {
    rotulo: 'Enviar para Eventos de teste',
    classe: 'btn-primary',
    icone: 'flask-conical',
    pill: 'pending',
    nota: 'não entra nos dados de produção',
    risco: 'Envia junto o <code>test_event_code</code>. O evento aparece só em <b>Eventos de teste</b> do Gerenciador de Eventos — não entra nos dados da conta nem na otimização das campanhas.',
  },
  real: {
    rotulo: 'Enviar de verdade (produção)',
    classe: 'btn-cta',
    icone: 'triangle-alert',
    pill: 'error',
    nota: 'entra na conta de produção — não dá para desfazer',
    risco: '<b>Vai para a conta de produção.</b> O evento entra nos dados, conta como conversão e influencia a otimização das campanhas. Não dá para desfazer.',
  },
};

const DESTINOS_TESTE = [
  { id: 'meta', nome: 'Meta', aba: 'meta' },
  { id: 'google', nome: 'Google', aba: 'google' },
  { id: 'postback', nome: 'Postback', aba: 'postback' },
];

// Modelos de reserva: só entram se o servidor não devolver os dele. Reproduzem os
// dois formatos que a ingestão reconhece hoje — o do checkout e o canônico.
const MODELOS_LOCAIS = [
  {
    id: 'local-compra-checkout',
    titulo: 'Compra aprovada (formato do checkout)',
    descricao: 'Payload do checkout, com atribuição e cookies.',
    payload: {
      event: 'payment.approved',
      eventId: 'evt-9271',
      paymentId: 'pay-9271',
      sessionId: 'sess-4821',
      paymentStatus: 'paid',
      occurredAt: new Date().toISOString(),
      amountMinor: 19990,
      currency: 'BRL',
      method: 'pix',
      customerReference: 'player-4821',
      lead: { name: 'Maria Silva', email: 'cliente@exemplo.com', phone: '5511999999999', taxId: '12345678909' },
      attribution: {
        eventSourceUrl: 'https://loja.exemplo.com/checkout',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        ipAddress: '189.40.12.34',
        cookies: { fbp: 'fb.1.1696000000.1234567890', fbc: 'fb.1.1696000000.AbCdEf123456', fbclid: 'AbCdEf123456' },
        utm: { source: 'facebook', medium: 'cpc', campaign: 'black-friday' },
      },
    },
  },
  {
    id: 'local-pix-checkout',
    titulo: 'PIX gerado (formato do checkout)',
    descricao: 'Intenção de pagamento — vira AddPaymentInfo, não Purchase.',
    payload: {
      event: 'checkout.pix.generated',
      eventId: 'evt-9272',
      sessionId: 'sess-4822',
      occurredAt: new Date().toISOString(),
      amountMinor: 19990,
      currency: 'BRL',
      method: 'pix',
      customerReference: 'player-4822',
      lead: { name: 'João Rocha', email: 'joao@exemplo.com', phone: '5511988887777' },
      attribution: {
        eventSourceUrl: 'https://loja.exemplo.com/checkout',
        userAgent: 'Mozilla/5.0 (Linux; Android 13)',
        ipAddress: '189.40.12.35',
        cookies: { fbp: 'fb.1.1696000000.1234567890' },
        utm: { source: 'facebook', medium: 'cpc' },
      },
    },
  },
  {
    id: 'local-compra-canonico',
    titulo: 'Compra (formato canônico)',
    descricao: 'O formato próprio do servidor, sem tradução.',
    payload: {
      event_name: 'purchase',
      event_id: 'pedido-9271',
      user_id: 'player-4821',
      user_data: { email: 'cliente@exemplo.com', phone: '5511999999999' },
      custom_data: { value: 199.9, currency: 'BRL', order_id: 'pedido-9271' },
    },
  },
  {
    id: 'local-lead-canonico',
    titulo: 'Lead (formato canônico)',
    descricao: 'Formulário preenchido, sem valor monetário.',
    payload: {
      event_name: 'lead',
      event_id: 'lead-5510',
      user_id: 'player-5510',
      user_data: { email: 'interessado@exemplo.com' },
      custom_data: {},
    },
  },
];

// Nomes de campo como a plataforma escreve → como a pessoa entende.
const CAMPO_LABEL = {
  em: 'E-mail (hasheado)', ph: 'Telefone (hasheado)', fn: 'Primeiro nome (hasheado)',
  ln: 'Sobrenome (hasheado)', ct: 'Cidade', st: 'Estado', zp: 'CEP', country: 'País',
  db: 'Data de nascimento', ge: 'Gênero',
  email: 'E-mail', phone: 'Telefone', first_name: 'Primeiro nome', last_name: 'Sobrenome',
  external_id: 'ID externo do cliente',
  fbc: 'Cookie de clique (_fbc)', fbp: 'Cookie de navegador (_fbp)', fbclid: 'Facebook Click ID',
  gclid: 'Google Click ID', gbraid: 'Google gbraid', wbraid: 'Google wbraid',
  ga_client_id: 'Client ID do GA4',
  client_ip_address: 'IP do visitante', client_user_agent: 'User-Agent do visitante',
  event_id: 'ID do evento', event_time: 'Horário do evento', event_name: 'Nome do evento',
  action_source: 'Origem da ação', event_source_url: 'URL de origem',
  value: 'Valor da conversão', currency: 'Moeda', order_id: 'ID do pedido',
  content_ids: 'IDs de produto', num_items: 'Quantidade de itens',
};

const PESO_NORM = {
  alto: 'alto', alta: 'alto', high: 'alto',
  medio: 'medio', média: 'medio', media: 'medio', medium: 'medio', médio: 'medio',
  baixo: 'baixo', baixa: 'baixo', low: 'baixo',
};
const PESO_ORDEM = { alto: 0, medio: 1, baixo: 2 };
const normalizarPeso = (p) => PESO_NORM[String(p || '').toLowerCase()] || 'baixo';

let consoleTeste = {
  modo: 'simular',
  destino: 'meta',
  modelos: [],
  modelosDe: null,       // projeto para o qual os modelos foram buscados
  carregando: false,
  modeloAtivo: null,
  usandoLocais: false,
  ultimoPayloadEnviado: null,
};

// ---------------- ciclo de vida ----------------

function resetConsoleTestes(p) {
  consoleTeste.modo = 'simular';
  consoleTeste.modelos = [];
  consoleTeste.modelosDe = null;
  consoleTeste.modeloAtivo = null;
  consoleTeste.usandoLocais = false;
  consoleTeste.ultimoPayloadEnviado = null;
  consoleTeste.destino = (destinoPronto(p, 'meta') && 'meta')
    || (destinoPronto(p, 'google') && 'google')
    || (destinoPronto(p, 'postback') && 'postback')
    || 'meta';

  $('#resultado').hidden = true;
  fecharConfirmacaoReal();
  $('#modelosBar').innerHTML = '<span class="muted">Carregando modelos…</span>';
  $('#testPayload').value = JSON.stringify(MODELOS_LOCAIS[0].payload, null, 2);
  renderModoTeste();
  renderDestinosTeste();
  validarPayloadNaTela();
}

// Estado de cada destino: um destino sem credencial não pode ser testado, e dizer
// o motivo na própria etiqueta poupa a viagem até a aba para descobrir o porquê.
function estadoDestino(p, id) {
  if (!p) return { pronto: false, nota: 'projeto não carregado' };
  if (id === 'meta') {
    const m = p.meta || {};
    if (!m.pixelId) return { pronto: false, nota: 'sem Pixel ID' };
    if (!m.hasAccessToken) return { pronto: false, nota: 'sem Access Token' };
    return { pronto: true, nota: m.enabled ? 'pronto' : 'pronto · destino desligado' };
  }
  if (id === 'google') {
    const g = p.google || {};
    if (g.route === 'google_ads') {
      if (!g.customerId) return { pronto: false, nota: 'sem Customer ID' };
      if (!g.hasDeveloperToken || !g.hasRefreshToken) return { pronto: false, nota: 'credenciais da API incompletas' };
      return { pronto: true, nota: g.enabled ? 'pronto · Google Ads' : 'pronto · destino desligado' };
    }
    if (!g.measurementId) return { pronto: false, nota: 'sem Measurement ID' };
    if (!g.hasApiSecret) return { pronto: false, nota: 'sem API Secret' };
    return { pronto: true, nota: g.enabled ? 'pronto · GA4' : 'pronto · destino desligado' };
  }
  const pb = p.postback || {};
  if (!pb.url) return { pronto: false, nota: 'sem URL de postback' };
  return { pronto: true, nota: pb.enabled ? 'pronto' : 'pronto · destino desligado' };
}

const destinoPronto = (p, id) => estadoDestino(p, id).pronto;

// ---------------- modo ----------------

function renderModoTeste() {
  const modo = consoleTeste.modo;
  for (const btn of $$('#modoSwitch .modo')) {
    const ligado = btn.dataset.modo === modo;
    btn.classList.toggle('is-on', ligado);
    btn.setAttribute('aria-checked', ligado ? 'true' : 'false');
    modoIconeNoBotao(btn);
  }
  const cfg = MODOS_TESTE[modo];
  $('#modoRisco').innerHTML = cfg.risco;

  // O rótulo do botão diz o que vai acontecer, o ícone repete em desenho e a classe
  // repete em cor. `.btn-cta` é o vermelho da ação grave — só o modo Real a usa.
  const btn = $('#btnDisparar');
  btn.className = 'btn btn-lg ' + cfg.classe;
  btn.innerHTML = `<i data-lucide="${cfg.icone}" aria-hidden="true"></i><span></span>`;
  btn.querySelector('span').textContent = cfg.rotulo;
  aplicarIcones(btn);

  const nota = $('#disparoNota');
  nota.innerHTML = `<span class="pill ${cfg.pill}"><i data-lucide="${cfg.icone}" aria-hidden="true"></i><span></span></span>`;
  nota.querySelector('.pill span').textContent = cfg.nota;
  aplicarIcones(nota);

  fecharConfirmacaoReal();
  renderAvisoModo();
}

// O ícone entra uma vez por botão de modo e fica: o rótulo do modo não muda, só o
// estado `is-on`. Reinjetar a cada render descartaria o SVG já criado pelo Lucide.
function modoIconeNoBotao(btn) {
  const cfg = MODOS_TESTE[btn.dataset.modo];
  const nome = btn.querySelector('.modo-nome');
  if (!cfg || !nome || nome.dataset.comIcone) return;
  nome.dataset.comIcone = '1';
  nome.style.display = 'inline-flex';
  nome.style.alignItems = 'center';
  nome.style.gap = '6px';
  const i = document.createElement('i');
  i.dataset.lucide = cfg.icone;
  i.setAttribute('aria-hidden', 'true');
  nome.insertBefore(i, nome.firstChild);
  aplicarIcones(nome);
}

function escolherModoTeste(modo) {
  if (!MODOS_TESTE[modo]) return;
  consoleTeste.modo = modo;
  renderModoTeste();
}

// Aviso que aparece quando o modo escolhido não tem como funcionar com o que
// está configurado — com o atalho para resolver, não só o diagnóstico.
function renderAvisoModo() {
  const caixa = $('#modoAviso');
  caixa.innerHTML = '';
  caixa.hidden = true;
  if (consoleTeste.modo !== 'teste') return;

  if (consoleTeste.destino !== 'meta') {
    caixa.hidden = false;
    caixa.innerHTML = '<i data-lucide="triangle-alert" aria-hidden="true"></i><span></span>';
    caixa.querySelector('span').textContent = 'Eventos de teste é um recurso da Meta. Para Google e Postback, use Simular para conferir o payload ou Real para enviar de fato.';
    aplicarIcones(caixa);
    return;
  }
  if (state.project && state.project.meta && state.project.meta.testEventCode) return;

  caixa.hidden = false;
  const alerta = document.createElement('i');
  alerta.dataset.lucide = 'triangle-alert';
  alerta.setAttribute('aria-hidden', 'true');
  caixa.appendChild(alerta);
  const txt = document.createElement('span');
  txt.innerHTML = 'Este projeto ainda não tem um <b>Test Event Code</b>. Sem ele o servidor recusa o modo Teste.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost';
  btn.textContent = 'Configurar na aba Meta';
  btn.addEventListener('click', () => {
    activateTab('meta');
    const campo = $('#metaTestEventCode');
    campo.focus();
    campo.scrollIntoView({ block: 'center' });
  });
  caixa.append(txt, btn);
  aplicarIcones(caixa);
}

// ---------------- destino ----------------

function renderDestinosTeste() {
  const grid = $('#destinoGrid');
  if (!grid) return;
  const p = state.project;
  grid.innerHTML = '';

  for (const d of DESTINOS_TESTE) {
    const est = estadoDestino(p, d.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'destino-opt' + (consoleTeste.destino === d.id ? ' is-on' : '');
    btn.disabled = !est.pronto;
    // "pronto" x "sem credencial" também em dois canais: a pílula colorida carrega o
    // ícone, e o texto ao lado diz o que falta — o operador não precisa abrir a aba
    // para descobrir por que o destino está desabilitado.
    btn.innerHTML = `<span class="destino-nome"></span>
      <span class="destino-est" style="display:inline-flex;align-items:center;gap:5px">
        <span class="pill ${est.pronto ? 'success' : 'error'}">
          <i data-lucide="${est.pronto ? 'circle-check-big' : 'circle-x'}" aria-hidden="true"></i>
        </span>
        <span class="destino-est-txt"></span>
      </span>`;
    btn.querySelector('.destino-nome').textContent = d.nome;
    btn.querySelector('.destino-est-txt').textContent = est.nota;
    if (!est.pronto) btn.title = `Configure ${d.nome} para poder testar este destino.`;
    aplicarIcones(btn);
    btn.addEventListener('click', () => {
      consoleTeste.destino = d.id;
      renderDestinosTeste();
      renderAvisoModo();
    });
    grid.appendChild(btn);
  }

  // Se o destino escolhido deixou de estar pronto, cai para o primeiro que estiver.
  if (!destinoPronto(p, consoleTeste.destino)) {
    const alternativa = DESTINOS_TESTE.find((d) => destinoPronto(p, d.id));
    if (alternativa && alternativa.id !== consoleTeste.destino) {
      consoleTeste.destino = alternativa.id;
      renderDestinosTeste();
    }
  }
}

// ---------------- modelos ----------------

async function carregarModelosTeste() {
  if (!state.selectedId) return;
  if (consoleTeste.modelosDe === state.selectedId || consoleTeste.carregando) return;
  consoleTeste.carregando = true;
  const projetoNoInicio = state.selectedId;

  let modelos = null;
  try {
    const r = await api('/projects/' + state.selectedId + '/testar/modelos');
    if (r && Array.isArray(r.modelos) && r.modelos.length) modelos = r.modelos;
  } catch {
    modelos = null; // o servidor pode não expor modelos ainda; seguimos com os locais
  }
  consoleTeste.carregando = false;
  if (state.selectedId !== projetoNoInicio) return;

  consoleTeste.modelos = modelos || MODELOS_LOCAIS;
  consoleTeste.usandoLocais = !modelos;
  consoleTeste.modelosDe = state.selectedId;
  renderModelosTeste();
}

function renderModelosTeste() {
  const bar = $('#modelosBar');
  bar.innerHTML = '';

  const rotulo = document.createElement('span');
  rotulo.className = 'muted';
  rotulo.style.fontSize = '.8rem';
  rotulo.textContent = 'Carregar modelo:';
  bar.appendChild(rotulo);

  for (const m of consoleTeste.modelos) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'modelo-chip' + (consoleTeste.modeloAtivo === m.id ? ' is-on' : '');
    chip.textContent = m.titulo || m.id;
    if (m.descricao) chip.title = m.descricao;
    chip.addEventListener('click', () => aplicarModeloTeste(m));
    bar.appendChild(chip);
  }

  if (consoleTeste.usandoLocais) {
    const nota = document.createElement('span');
    nota.className = 'muted';
    nota.style.fontSize = '.76rem';
    nota.textContent = '· modelos de exemplo (o servidor não devolveu os dele)';
    bar.appendChild(nota);
  }
}

function aplicarModeloTeste(m) {
  $('#testPayload').value = JSON.stringify(m.payload, null, 2);
  consoleTeste.modeloAtivo = m.id;
  renderModelosTeste();
  validarPayloadNaTela();
  toast(`Modelo "${m.titulo || m.id}" carregado no editor.`, 'ok');
}

// ---------------- payload ----------------

// O motor nem sempre diz onde o JSON quebrou: dependendo do tamanho do texto, o
// V8 troca "at position N" por um trecho do conteúdo. Como apontar o caractere é
// justamente o que resolve o problema de quem está editando, percorremos o texto
// por conta própria e devolvemos o índice exato — e uma explicação em português.
function localizarErroJson(s) {
  let i = 0;
  const fim = s.length;
  const branco = () => { while (i < fim && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++; };
  const falha = (msg) => { throw { pos: Math.min(i, fim), msg }; };
  const digito = (c) => c >= '0' && c <= '9';

  function valor() {
    branco();
    if (i >= fim) falha('o texto acaba antes do valor esperado');
    const c = s[i];
    if (c === '{') return objeto();
    if (c === '[') return lista();
    if (c === '"') return cadeia();
    if (c === '-' || digito(c)) return numero();
    for (const lit of ['true', 'false', 'null']) {
      if (s.startsWith(lit, i)) { i += lit.length; return; }
    }
    falha(`"${c}" não pode começar um valor`);
  }

  function objeto() {
    i++; branco();
    if (s[i] === '}') { i++; return; }
    for (;;) {
      branco();
      if (s[i] !== '"') falha('esperava o nome de um campo entre aspas');
      cadeia();
      branco();
      if (s[i] !== ':') falha('esperava ":" depois do nome do campo');
      i++;
      valor();
      branco();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '}') { i++; return; }
      falha('esperava "," para o próximo campo ou "}" para fechar o objeto');
    }
  }

  function lista() {
    i++; branco();
    if (s[i] === ']') { i++; return; }
    for (;;) {
      valor();
      branco();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ']') { i++; return; }
      falha('esperava "," para o próximo item ou "]" para fechar a lista');
    }
  }

  function cadeia() {
    i++;
    while (i < fim) {
      const c = s[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '"') { i++; return; }
      if (c === '\n') falha('a aspa de fechamento não apareceu antes da quebra de linha');
      i++;
    }
    falha('a aspa de fechamento não apareceu');
  }

  function numero() {
    const inicio = i;
    if (s[i] === '-') i++;
    while (i < fim && digito(s[i])) i++;
    if (s[i] === '.') { i++; while (i < fim && digito(s[i])) i++; }
    if (s[i] === 'e' || s[i] === 'E') {
      i++;
      if (s[i] === '+' || s[i] === '-') i++;
      while (i < fim && digito(s[i])) i++;
    }
    if (i === inicio) falha('número inválido');
  }

  try {
    valor();
    branco();
    if (i < fim) return { pos: i, msg: 'há conteúdo sobrando depois do fim do JSON' };
    return null;
  } catch (e) {
    return (e && typeof e.pos === 'number') ? e : null;
  }
}

// Devolve { ok, valor } ou { ok:false, msg, pos }. A posição é o que permite levar
// o cursor até o caractere que quebrou — dizer "JSON inválido" e parar por aí
// deixa o operador procurando vírgula em 60 linhas.
function analisarPayload(bruto) {
  const texto = bruto.trim();
  if (!texto) return { ok: false, msg: 'O editor está vazio. Carregue um modelo ou cole um payload.' };
  let valor;
  try {
    valor = JSON.parse(texto);
  } catch (err) {
    const local = localizarErroJson(bruto);
    const m = /position (\d+)/.exec(err.message);
    const pos = local ? local.pos : (m ? Math.min(Number(m[1]), bruto.length) : null);
    const motivo = local ? local.msg : err.message
      .replace(/^JSON\.parse:\s*/, '')
      .replace(/\s*in JSON at position \d+.*$/, '')
      .replace(/,?\s*"[\s\S]*" is not valid JSON$/, '')
      .trim();
    if (pos === null) return { ok: false, msg: 'JSON inválido: ' + motivo };
    const ate = bruto.slice(0, pos);
    const linha = ate.split('\n').length;
    const coluna = pos - ate.lastIndexOf('\n');
    return { ok: false, msg: motivo, pos, linha, coluna };
  }
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) {
    return { ok: false, msg: 'O payload precisa ser um objeto JSON (começar com "{").' };
  }
  return { ok: true, valor };
}

function validarPayloadNaTela() {
  const editor = $('#testPayload');
  const status = $('#jsonStatus');
  const r = analisarPayload(editor.value);
  if (r.ok) {
    editor.classList.remove('is-invalid');
    status.className = 'json-status ok';
    status.textContent = 'JSON válido';
    return r;
  }
  editor.classList.add('is-invalid');
  status.className = 'json-status err';
  status.innerHTML = r.linha
    ? `Erro de sintaxe na <span class="pos">linha ${r.linha}, coluna ${r.coluna}</span> — ${escHtml(r.msg)}`
    : escHtml(r.msg);
  return r;
}

// Leva o cursor até o ponto exato do erro.
function irParaErroJson(pos) {
  const editor = $('#testPayload');
  editor.focus();
  const fim = Math.min(pos + 1, editor.value.length);
  editor.setSelectionRange(Math.max(0, pos), fim);
}

function formatarPayload() {
  const r = validarPayloadNaTela();
  if (!r.ok) {
    if (r.pos !== undefined && r.pos !== null) irParaErroJson(r.pos);
    toast('Não dá para formatar um JSON com erro de sintaxe.', 'warn');
    return;
  }
  $('#testPayload').value = JSON.stringify(r.valor, null, 2);
  toast('Payload formatado.', 'ok');
}

// ---------------- disparo ----------------

function aoClicarDisparar() {
  if (consoleTeste.modo === 'real') {
    pedirConfirmacaoReal();
    return;
  }
  enviarTeste();
}

// Confirmação inline — o painel não usa confirm() nativo.
function pedirConfirmacaoReal() {
  const caixa = $('#disparoConfirm');
  if (!caixa.hidden) { fecharConfirmacaoReal(); return; }

  const destino = DESTINOS_TESTE.find((d) => d.id === consoleTeste.destino);
  caixa.hidden = false;
  caixa.innerHTML = '<span><i data-lucide="triangle-alert" aria-hidden="true"></i> </span>';
  caixa.querySelector('span').insertAdjacentHTML('beforeend',
    `<b>Evento REAL para ${escHtml(destino ? destino.nome : consoleTeste.destino)}.</b> `
    + 'Ele entra nos dados da conta, conta como conversão, influencia a otimização das campanhas '
    + 'e não pode ser removido depois. Para só conferir o JSON, volte ao modo <b>Simular</b>.');

  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'btn btn-cta';
  ok.innerHTML = '<i data-lucide="triangle-alert" aria-hidden="true"></i><span>Enviar de verdade</span>';

  const cancelar = document.createElement('button');
  cancelar.type = 'button';
  cancelar.className = 'btn btn-ghost';
  cancelar.textContent = 'Cancelar';

  cancelar.addEventListener('click', () => { fecharConfirmacaoReal(); $('#btnDisparar').focus(); });
  ok.addEventListener('click', () => { fecharConfirmacaoReal(); enviarTeste(); });

  caixa.append(ok, cancelar);
  aplicarIcones(caixa);
  // O foco vai para Cancelar: quem chegou aqui sem querer sai com Enter, não dispara.
  cancelar.focus();
}

function fecharConfirmacaoReal() {
  const caixa = $('#disparoConfirm');
  if (!caixa) return;
  caixa.hidden = true;
  caixa.innerHTML = '';
}

async function enviarTeste() {
  if (!state.selectedId) { toast('Selecione um projeto primeiro.', 'warn'); return; }

  const r = validarPayloadNaTela();
  if (!r.ok) {
    if (r.pos !== undefined && r.pos !== null) irParaErroJson(r.pos);
    toast('Corrija o JSON antes de enviar.', 'err');
    return;
  }

  const p = state.project;
  const est = estadoDestino(p, consoleTeste.destino);

  // Credencial só é exigida para quem realmente envia. Simular existe justamente para
  // conferir o payload ANTES de configurar o destino — exigir Pixel ID aqui inverteria
  // a ordem natural (só dá para ver o que vai sair depois de ter tudo pronto) e tiraria
  // o valor da tela para quem está começando a integração.
  if (!est.pronto && consoleTeste.modo !== 'simular') {
    toast(`O destino escolhido não está configurado: ${est.nota}.`, 'err');
    return;
  }

  // Falta previsível: avisamos aqui em vez de gastar uma ida ao servidor para
  // receber o mesmo 400 de volta.
  if (consoleTeste.modo === 'teste' && consoleTeste.destino === 'meta'
      && !(p.meta && p.meta.testEventCode)) {
    renderAvisoModo();
    $('#modoAviso').scrollIntoView({ block: 'nearest' });
    toast('O modo Teste precisa de um Test Event Code configurado na aba Meta.', 'err');
    return;
  }

  // Estado "carregando" pelo atributo, não trocando o texto: o rótulo continua
  // ocupando lugar (o botão não encolhe no meio do clique) e o ícone do modo sobrevive.
  const btn = $('#btnDisparar');
  btn.dataset.carregando = 'true';
  btn.disabled = true;
  try {
    const resposta = await api('/projects/' + state.selectedId + '/testar', {
      method: 'POST',
      body: { modo: consoleTeste.modo, destino: consoleTeste.destino, payload: r.valor },
    });
    renderResultadoTeste(resposta);
    toast(resposta.enviado ? 'Evento enviado. Confira a resposta da plataforma abaixo.' : 'Simulação pronta. Confira o JSON que sairia.', 'ok');
  } catch (err) {
    if (err.status === 400 && /test.?event.?code/i.test(err.message)) {
      renderAvisoModo();
      $('#modoAviso').scrollIntoView({ block: 'nearest' });
    }
    toast('Falha no teste: ' + err.message, 'err');
  } finally {
    delete btn.dataset.carregando;
    btn.disabled = false;
  }
}

// ---------------- resultado ----------------

function renderResultadoTeste(r) {
  $('#resultado').hidden = false;
  consoleTeste.ultimoPayloadEnviado = r.payloadEnviado;

  renderInterpretado(r);
  renderPayloadEnviado(r);
  renderDiagnostico(r.diagnostico);
  renderRespostaPlataforma(r);

  $('#resultado').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function renderInterpretado(r) {
  const ev = r.eventoInterno || {};
  const ud = ev.user_data || {};
  const cd = ev.custom_data || {};
  const presentes = Object.entries(ud)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([k]) => k);

  const linhas = [
    par('Formato detectado', escHtml(r.formatoDetectado || 'canônico (nenhuma tradução necessária)')),
    par('Evento canônico', escHtml(ev.event_name || '—')),
    par('event_id', escHtml(ev.event_id || '—')),
  ];

  if (cd.value !== undefined && cd.value !== null && cd.value !== '') {
    linhas.push(par('Valor', `${escHtml(String(cd.value))} ${escHtml(cd.currency || '')}`.trim()));
  }

  linhas.push(`
    <span class="kv-k">Correspondência</span>
    <span class="kv-v">${presentes.length
      ? `<span class="kv-chips">${presentes.map((c) => `<span title="${escHtml(CAMPO_LABEL[c] || c)}">${escHtml(c)}</span>`).join('')}</span>`
      : '<span class="res-vazio">nenhum campo de correspondência foi montado</span>'}</span>`);

  const body = $('#resInterpretadoBody');
  body.innerHTML = `<div class="kv">${linhas.join('')}</div>`;

  const det = document.createElement('details');
  det.style.marginTop = '14px';
  det.innerHTML = '<summary style="cursor:pointer;font-family:var(--font-mono);font-size:.78rem;color:var(--muted)">Ver o evento interno completo</summary>';
  const pre = document.createElement('pre');
  pre.className = 'json-view is-curto';
  pre.style.marginTop = '10px';
  pre.textContent = JSON.stringify(ev, null, 2);
  det.appendChild(pre);
  body.appendChild(det);
}

function par(chave, valorHtml) {
  return `<span class="kv-k">${escHtml(chave)}</span><span class="kv-v">${valorHtml}</span>`;
}

function renderPayloadEnviado(r) {
  const body = $('#resEnviadoBody');
  body.innerHTML = '';

  if (r.urlDestino) {
    const url = document.createElement('div');
    url.className = 'url-alvo';
    url.innerHTML = '<span class="verbo">POST</span><span></span>';
    url.querySelector('span:last-child').textContent = r.urlDestino;
    body.appendChild(url);
  }

  const pre = document.createElement('pre');
  pre.className = 'json-view';
  pre.textContent = r.payloadEnviado === undefined || r.payloadEnviado === null
    ? 'O servidor não devolveu o payload.'
    : JSON.stringify(r.payloadEnviado, null, 2);
  body.appendChild(pre);

  // A pergunta que o operador faz olhando para este cartão é "isso saiu ou não saiu?".
  // A resposta vira pílula: cor + ícone + a frase, os três dizendo a mesma coisa.
  const nota = document.createElement('p');
  nota.style.margin = '10px 0 0';
  nota.innerHTML = r.enviado
    ? '<span class="pill error"><i data-lucide="radio-tower" aria-hidden="true"></i>saiu deste servidor</span> <span class="res-vazio">Este JSON foi enviado de fato para a plataforma.</span>'
    : '<span class="pill info"><i data-lucide="eye" aria-hidden="true"></i>simulação</span> <span class="res-vazio">Este JSON não saiu daqui — é o que seria enviado.</span>';
  body.appendChild(nota);
  aplicarIcones(body);
}

function renderDiagnostico(diag) {
  const body = $('#resDiagnosticoBody');
  if (!diag) {
    body.innerHTML = '<p class="res-vazio">O servidor não devolveu diagnóstico para este envio.</p>';
    return;
  }

  const nota = Math.max(0, Math.min(100, Number(diag.pontuacao) || 0));
  const cls = nota >= 70 ? 'hi' : nota >= 40 ? 'mid' : 'lo';
  const leitura = nota >= 70
    ? 'Correspondência boa: a Meta tem sinal suficiente para casar este evento com uma pessoa.'
    : nota >= 40
      ? 'Correspondência média: dá para melhorar acrescentando os campos ausentes de peso alto.'
      : 'Correspondência fraca: com estes campos, boa parte dos eventos não vai casar com ninguém.';

  const presentes = [...(diag.camposPresentes || [])].sort(ordenarPorPeso);
  const ausentes = [...(diag.camposAusentes || [])].sort(ordenarPorPeso);

  body.innerHTML = `
    <div class="score">
      <span class="score-num">${nota}<small>/100</small></span>
      <div class="score-meter">
        <div class="score-track"><div class="score-fill ${cls}" style="width:${nota}%"></div></div>
        <div class="score-ticks"><span>0</span><span>50</span><span>100</span></div>
      </div>
    </div>
    <p class="score-leitura">${escHtml(leitura)}</p>
    <div class="campos-grid" style="margin-top:16px">
      <div class="campos-col">
        <h5>Chegaram (${presentes.length})</h5>
        <div class="campos">${presentes.length
          ? presentes.map((c) => campoHtml(c, true)).join('')
          : '<p class="res-vazio">Nenhum campo de correspondência chegou.</p>'}</div>
      </div>
      <div class="campos-col">
        <h5>Faltaram (${ausentes.length})</h5>
        <div class="campos">${ausentes.length
          ? ausentes.map((c) => campoHtml(c, false)).join('')
          : '<p class="res-vazio">Nada faltou. Este evento saiu completo.</p>'}</div>
      </div>
    </div>`;

  const alertas = diag.alertas || [];
  if (alertas.length) {
    const caixa = document.createElement('div');
    caixa.className = 'alertas';
    for (const a of alertas) {
      const item = document.createElement('div');
      item.className = 'alerta';
      item.textContent = String(a);
      caixa.appendChild(item);
    }
    body.appendChild(caixa);
  }
}

function ordenarPorPeso(a, b) {
  return PESO_ORDEM[normalizarPeso(a && a.peso)] - PESO_ORDEM[normalizarPeso(b && b.peso)];
}

function campoHtml(c, presente) {
  const campo = (c && c.campo) || '—';
  const peso = normalizarPeso(c && c.peso);
  const rotulo = CAMPO_LABEL[campo] || '';
  const dica = presente ? rotulo : (c && c.dica) || rotulo;
  return `
    <div class="campo ${presente ? 'ok' : 'falta peso-' + peso}">
      <span class="campo-nome">${escHtml(campo)}</span>
      <span class="campo-peso">peso ${escHtml(peso)}</span>
      ${dica ? `<span class="campo-dica">${escHtml(dica)}</span>` : ''}
    </div>`;
}

function renderRespostaPlataforma(r) {
  const card = $('#resResposta');
  const body = $('#resRespostaBody');
  if (!r.enviado) {
    card.hidden = true;
    body.innerHTML = '';
    return;
  }
  card.hidden = false;
  body.innerHTML = '';

  const resp = r.resposta;
  const status = resp && (resp.status || resp.httpStatus);
  if (status) {
    const ok = Number(status) >= 200 && Number(status) < 300;
    const pill = document.createElement('span');
    pill.className = 'pill ' + (ok ? 'success' : 'error');
    pill.innerHTML = `<i data-lucide="${ok ? 'circle-check-big' : 'circle-x'}" aria-hidden="true"></i><span></span>`;
    pill.querySelector('span').textContent = `HTTP ${status}`;
    const linha = document.createElement('div');
    linha.style.marginBottom = '12px';
    linha.appendChild(pill);
    body.appendChild(linha);
    aplicarIcones(linha);
  }

  const pre = document.createElement('pre');
  pre.className = 'json-view is-curto';
  pre.textContent = resp === undefined || resp === null
    ? 'A plataforma não devolveu corpo.'
    : (typeof resp === 'string' ? resp : JSON.stringify(resp, null, 2));
  body.appendChild(pre);
}

function copiarPayloadEnviado() {
  const p = consoleTeste.ultimoPayloadEnviado;
  if (p === undefined || p === null) {
    toast('Nada para copiar ainda — dispare um teste primeiro.', 'warn');
    return;
  }
  copyText(JSON.stringify(p, null, 2), 'JSON enviado copiado.');
}

// ---------------- avançado: pipeline completo ----------------

// O console fala direto com a plataforma. Este caminho exercita a ingestão inteira
// (ponte de identidade, fila, os três destinos) e deixa rastro na aba Logs.
async function enviarPeloIngest(btn) {
  if (!state.selectedId) return;
  const r = validarPayloadNaTela();
  if (!r.ok) {
    if (r.pos !== undefined && r.pos !== null) irParaErroJson(r.pos);
    toast('Corrija o JSON antes de enviar.', 'err');
    return;
  }
  btn.disabled = true;
  try {
    const res = await fetch(eventoUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(r.valor),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    toast('Evento aceito pela ingestão. Veja o resultado na aba Logs.', 'ok');
    activateTab('logs');
    setTimeout(loadLogs, 800);
  } catch (err) {
    toast('Falha na ingestão: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}
