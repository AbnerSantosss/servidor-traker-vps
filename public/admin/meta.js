// Aba Meta: estado da integração, credenciais e mapeamento de eventos.
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// ════════════════════════════════════════════════════════════════════
// ABA META — estado da integração, credenciais e mapeamento de eventos
// ════════════════════════════════════════════════════════════════════

// Eventos padrão da Meta oferecidos no seletor. Qualquer outro nome continua
// possível pela opção "Personalizado" — a Meta aceita evento customizado, ele
// só não entra nas otimizações prontas.
const META_EVENTOS_PADRAO = [
  'PageView', 'ViewContent', 'Lead', 'CompleteRegistration',
  'AddToCart', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase',
];

// Eventos canônicos do produto. Aparecem sempre, mesmo sem mapeamento salvo —
// linha vazia é informação: mostra o que o servidor recebe e não está enviando.
const EVENTOS_CANONICOS = [
  { nome: 'page_view', dica: 'Único evento que nasce no navegador (Trilha A).' },
  { nome: 'view_content', dica: 'Página de produto, oferta ou conteúdo relevante.' },
  { nome: 'sign_up', dica: 'O visitante criou conta ou deixou os dados.' },
  { nome: 'lead', dica: 'Formulário de contato, orçamento ou interesse.' },
  { nome: 'add_to_cart', dica: 'Um item foi adicionado ao carrinho.' },
  { nome: 'begin_checkout', dica: 'O visitante começou a finalizar a compra.' },
  {
    nome: 'pix_gerado',
    dica: '<b class="nao-receita">Intenção, não receita.</b> O QR Code foi gerado e ainda pode não ser pago — vai como <b>AddPaymentInfo</b>, nunca como Purchase.',
  },
  { nome: 'abandoned_checkout', dica: 'Começou o checkout e não concluiu; seu backend dispara depois do prazo.' },
  { nome: 'purchase', dica: 'Pagamento confirmado. É a conversão que otimiza a campanha.' },
  { nome: 'checkout_concluido', dica: 'Sessão encerrada sem confirmação de pagamento. Sem mapeamento de fábrica: só você sabe se merece virar evento.' },
];

const NOMES_CANONICOS = EVENTOS_CANONICOS.map((e) => e.nome);

// ---------------- Estado da integração (cartão do topo, agora dentro de "Visão geral") ----------------

// A taxa de sucesso e a "última entrega com sucesso" agora vêm de /metrics/destinos
// (via falhasMetricasDestino, admin/falhas.js) em vez do antigo /metrics de 30 dias:
// é a mesma fonte que já alimenta o gráfico da Visão Geral, então o cartão de saúde e
// o gráfico logo abaixo dele nunca contam números diferentes para a mesma pergunta.
async function loadMetaStatus() {
  if (!state.selectedId || !state.project) return;
  const projetoNoInicio = state.selectedId;
  renderMetaStatus(state.project, undefined);
  let m = null;
  try {
    m = await falhasMetricasDestino('meta');
  } catch {
    m = null;
  }
  // O operador pode ter trocado de projeto enquanto a métrica vinha.
  if (state.selectedId !== projetoNoInicio) return;
  renderMetaStatus(state.project, m);
}

// `m === undefined` = ainda carregando; `null` = não deu para ler.
function renderMetaStatus(p, m) {
  const el = $('#metaStatus');
  if (!el) return;
  const meta = (p && p.meta) || {};

  const celulas = [
    celulaStatus('Pixel ID', meta.pixelId
      ? { dot: 'ok', valor: meta.pixelId, sub: 'fonte de dados da Meta', ajuda: 'pixel-id' }
      : { dot: 'err', valor: 'não configurado', badge: true, sub: 'sem ele nada é enviado', ajuda: 'pixel-id' }),

    celulaStatus('Access Token', meta.hasAccessToken
      ? { dot: 'ok', valor: 'conectado', badge: true, sub: 'criptografado em repouso', ajuda: 'access-token' }
      : { dot: 'err', valor: 'não configurado', badge: true, sub: 'a Meta recusa o envio', ajuda: 'access-token' }),

    celulaStatus('Destino', meta.enabled
      ? { dot: 'ok', valor: 'ligado', badge: true, sub: 'as conversões saem daqui', ajuda: 'destino-ligado-desligado' }
      : { dot: 'off', valor: 'desligado', badge: true, sub: 'os eventos são gravados, mas não enviados', ajuda: 'destino-ligado-desligado' }),

    celulaStatus('Test Event Code', meta.testEventCode
      ? { dot: 'ok', valor: 'configurado', badge: true, sub: 'modo Teste do console disponível', ajuda: 'test-event-code' }
      : { dot: 'off', valor: 'não configurado', badge: true, sub: 'modo Teste do console indisponível', ajuda: 'test-event-code' }),

    celulaUltimoSucesso(m),
    celulaTaxaDestino(m),
  ];

  el.innerHTML = `<div class="int-grid">${celulas.join('')}</div>`;

  const alerta = alertaMeta(meta);
  if (alerta) {
    const faixa = document.createElement('div');
    faixa.className = 'int-alerta';
    faixa.innerHTML = `<i data-lucide="triangle-alert" aria-hidden="true"></i><span>${alerta}</span>`;
    el.appendChild(faixa);
  }
  aplicarIcones(el);
}

// Vocabulário do estado de um destino, em DOIS canais: a cor da pílula e o desenho do
// ícone. Cor sozinha reprova — uma em doze pessoas não separa vermelho de verde, e o
// cartão de saúde é justamente onde a leitura precisa ser instantânea.
const INT_ESTADO = {
  ok:   { pill: 'success', icone: 'circle-check-big', nome: 'conectado' },
  warn: { pill: 'pending', icone: 'triangle-alert',   nome: 'atenção' },
  err:  { pill: 'error',   icone: 'circle-x',         nome: 'não configurado' },
  off:  { pill: 'off',     icone: 'circle-minus',     nome: 'desligado' },
};

// `ajuda` é opcional: quando presente, entra um botão de ajuda contextual ao lado do
// rótulo — reaproveitado por google.js (loaded depois, mesmo escopo global) para o
// cartão de saúde do Google, que usa esta mesma função.
//
// `badge: true` diz que o próprio VALOR é o estado ("salvo", "ligado", "não
// configurado"): nesse caso a palavra entra dentro da pílula colorida, em vez de ficar
// ao lado dela. Os chamadores de falhas.js (última entrega, taxa de sucesso) não passam
// `badge`, porque ali o valor é um dado — a pílula fica só com o ícone e um aria-label.
function celulaStatus(rotulo, { dot, valor, sub, mudo, ajuda, badge }) {
  const ajudaHtml = ajuda ? `<button type="button" class="ajuda" data-ajuda="${escHtml(ajuda)}"></button>` : '';
  const est = INT_ESTADO[dot] || INT_ESTADO.off;
  const icone = `<i data-lucide="${est.icone}" aria-hidden="true"></i>`;
  const pilula = badge
    ? `<span class="pill ${est.pill}">${icone}${escHtml(valor)}</span>`
    // Pílula só de ícone (a célula mostra um dado, não um estado): recolhe o padding
    // lateral para não roubar largura de um valor que já vive com reticências.
    : `<span class="pill ${est.pill}" style="padding:.16rem .3rem" role="img" aria-label="${escHtml(est.nome)}" title="${escHtml(est.nome)}">${icone}</span>`;
  return `
    <div class="int-cell">
      <span class="int-k">${escHtml(rotulo)}${ajudaHtml}</span>
      <span class="int-v${mudo ? ' is-muted' : ''}" title="${escHtml(valor)}">
        ${pilula}${badge ? '' : escHtml(valor)}
      </span>
      <span class="int-sub">${escHtml(sub)}</span>
    </div>`;
}

// ---------------- Estados de campo (erro/limpeza) ----------------
// Compartilhados pelas três abas de credenciais (meta/google/postback carregam nesta
// ordem, mesmo escopo global). O par obrigatório é sempre `aria-invalid` + `.field-erro`:
// a borda vermelha é o canal rápido, o texto é o canal que todo mundo lê.

// Aceita seletor ou o próprio elemento: nem todo campo do painel tem id (a linha do
// dicionário do Webhook Studio, por exemplo, nasce em série), e montar "#" + id vazio
// seria um seletor inválido que derruba a função inteira.
const campoEl = (alvo) => (typeof alvo === 'string' ? $(alvo) : alvo);

function campoErro(sel, mensagem) {
  const input = campoEl(sel);
  if (!input) return;
  input.setAttribute('aria-invalid', 'true');
  const campo = input.closest('.field');
  if (!campo) return;
  campo.classList.add('is-erro');

  let msg = campo.querySelector('.field-erro');
  if (!msg) {
    msg = document.createElement('p');
    msg.className = 'field-erro';
    msg.id = (input.id || 'campo') + 'Erro';
    campo.appendChild(msg);
  }
  msg.innerHTML = '<i data-lucide="circle-alert" aria-hidden="true"></i><span></span>';
  msg.querySelector('span').textContent = mensagem;
  aplicarIcones(msg);
  input.setAttribute('aria-describedby', msg.id);

  // O erro some assim que a pessoa volta a digitar: manter a borda vermelha enquanto
  // ela corrige transforma um aviso em acusação. Um listener só por campo, para sempre.
  if (!input.dataset.erroLigado) {
    input.dataset.erroLigado = '1';
    input.addEventListener('input', () => campoLimparErro(input));
  }
}

function campoLimparErro(sel) {
  const input = campoEl(sel);
  if (!input) return;
  input.removeAttribute('aria-invalid');
  input.removeAttribute('aria-describedby');
  const campo = input.closest('.field');
  if (!campo) return;
  campo.classList.remove('is-erro');
  const msg = campo.querySelector('.field-erro');
  if (msg) msg.remove();
}

function campoLimparErros(seletorDoForm) {
  const form = $(seletorDoForm);
  if (!form) return;
  $$('[aria-invalid="true"]', form).forEach((el) => campoLimparErro(el));
}

// Botão de submit em estado "carregando": largura preservada pelo CSS global
// (`[data-carregando]`), então nada ao lado dele se desloca no meio do clique.
async function comBotaoCarregando(btn, tarefa) {
  if (!btn) return tarefa();
  btn.dataset.carregando = 'true';
  btn.disabled = true;
  try {
    return await tarefa();
  } finally {
    delete btn.dataset.carregando;
    // Quem manda no `disabled` daqui em diante é o papel do usuário (applyRole),
    // não este helper — reabilitar cegamente devolveria o botão ao operador.
    btn.disabled = !isAdmin();
  }
}

function alertaMeta(m) {
  const faltando = [];
  if (!m.pixelId) faltando.push('o Pixel ID');
  if (!m.hasAccessToken) faltando.push('o Access Token');
  if (faltando.length) {
    return `<b>Falta ${faltando.join(' e ')}.</b> Enquanto isso, os eventos são recebidos e gravados, mas não chegam à Meta.`;
  }
  if (!m.enabled) {
    return '<b>Destino desligado.</b> Marque "Enviar conversões para a Meta" abaixo para o servidor começar a entregar.';
  }
  if (!m.testEventCode) {
    return '<b>Sem Test Event Code.</b> O modo <b>Teste</b> do console fica indisponível — você só consegue simular ou enviar de verdade.';
  }
  return '';
}

// ---------------- Hub: sub-navegação Meta (Visão geral / Falhas / Credenciais / Mapeamento) ----------------

// Array de itens — de propósito, para o dia em que "Webhooks" (fase seguinte) só
// precisar de mais uma entrada aqui, sem reescrever subNav() nem esta função.
const META_SUBNAV_ITENS = [
  { id: 'visao-geral', rotulo: 'Visão geral', icone: 'layout-dashboard' },
  { id: 'falhas', rotulo: 'Falhas', icone: 'octagon-alert' },
  { id: 'credenciais', rotulo: 'Credenciais', icone: 'key-round' },
  { id: 'mapeamento', rotulo: 'Mapeamento', icone: 'shuffle' },
  { id: 'webhooks', rotulo: 'Webhooks', icone: 'webhook' },
];

// Chamada a cada fillMetaForm (troca de projeto e depois de salvar) — subNav()
// preserva sozinho a sub-aba em que o operador estava (ver navegacao.js).
function metaHubMontar() {
  const fluxoEl = $('#metaFluxo');
  if (fluxoEl) {
    fluxoEl.innerHTML = falhasFluxoHtml('meta', { estruturaSubaba: 'mapeamento', saidaSubaba: 'credenciais' });
    aplicarIcones(fluxoEl);
  }

  subNav('metaSubnav', META_SUBNAV_ITENS, {
    ativo: 'visao-geral',
    aoTrocar: (id) => {
      // Credenciais/Mapeamento não pedem nada aqui: fillMetaForm já preencheu os
      // campos antes de chamar esta função. Só Visão Geral e Falhas buscam dado à parte.
      if (id === 'visao-geral') falhasVisaoGeralMetricas('meta', 'meta');
      if (id === 'falhas') falhasMontar('meta', '#metaFalhas', 'meta');
      // Webhook Studio (F4/F5) cuida do próprio ciclo de vida a partir daqui — ver
      // admin/webhook-studio.js.
      if (id === 'webhooks') studioMontar();
    },
  });
  falhasAtualizarBadges();
}

// ---------------- Formulário ----------------

// O painel NUNCA recebe o valor de um segredo — só a flag `has*` (I-7). A dica de
// preenchimento é, portanto, a única coisa que conta ao operador se existe algo salvo
// ali; ela carrega a pílula de estado (cor + ícone) e repete, sempre, a regra que
// governa este campo: campo em branco mantém o segredo atual, nada é apagado por
// omissão. Sem essa frase, "salvar" com o campo vazio parece apagar a credencial.
function dicaSegredo(sel, salvo, textoSalvo, textoVazio) {
  const el = $(sel);
  if (!el) return;
  el.innerHTML = salvo
    ? `<span class="pill success"><i data-lucide="lock" aria-hidden="true"></i>salvo</span> <span></span>`
    : `<span class="pill off"><i data-lucide="circle-minus" aria-hidden="true"></i>vazio</span> <span></span>`;
  el.querySelector('span:last-child').textContent = salvo ? textoSalvo : textoVazio;
  aplicarIcones(el);
}

const SEGREDO_MANTEM = 'Já existe um valor salvo (cifrado, nunca reexibido). Deixe o campo em branco para manter o atual; preencha só para substituir.';

// O Chrome trata QUALQUER formulário com <input type=password> como formulário de login
// e oferece a senha salva do painel — e aqui isso é grave: um Access Token ou API Secret
// preenchido em silêncio pelo gerenciador de senhas seria salvo como credencial nova no
// próximo clique em Salvar, derrubando a entrega sem ninguém ter digitado nada.
// `new-password` faz o Chrome ler o formulário como cadastro e parar de preencher — é o
// mesmo motivo pelo qual o campo nasce vazio e "em branco = mantém o atual".
function blindarAutofill(seletorDoForm) {
  const form = $(seletorDoForm);
  if (!form) return;
  $$('input[type=password]', form).forEach((el) => { el.autocomplete = 'new-password'; });
  $$('input[type=text]', form).forEach((el) => { if (!el.autocomplete) el.autocomplete = 'off'; });
}

function fillMetaForm(p) {
  $('#metaEnabled').checked = !!p.meta.enabled;
  $('#metaPixelId').value = p.meta.pixelId || '';
  $('#metaTestEventCode').value = p.meta.testEventCode || '';
  $('#metaAccessToken').value = '';
  campoLimparErros('#metaForm');
  blindarAutofill('#metaForm');
  dicaSegredo('#metaTokenHint', p.meta.hasAccessToken, SEGREDO_MANTEM,
    'Nenhum token salvo. Cole o Access Token da Conversions API — ele fica cifrado em repouso e nunca volta para esta tela.');
  // Edição pendente do JSON não sobrevive à troca de projeto nem ao recarregar o
  // formulário: o que vale a partir daqui é o que veio do servidor.
  mapaJsonSujo = false;
  $('#metaMapJsonBox').classList.remove('is-dirty');
  renderMapaMeta(p.meta.eventMap || {});
  // As linhas da tabela nascem depois do applyRole do boot: reaplica o papel para
  // o operador não receber campos editáveis que o backend vai recusar.
  applyRole();
  metaHubMontar();
}

// Monta a tabela: primeiro os canônicos na ordem do funil, depois o que o
// operador tiver acrescentado por conta própria.
function renderMapaMeta(mapa) {
  const rows = $('#metaMapRows');
  rows.innerHTML = '';
  for (const ev of EVENTOS_CANONICOS) {
    rows.appendChild(linhaMapa({ origem: ev.nome, destino: mapa[ev.nome] || '', dica: ev.dica, fixa: true }));
  }
  for (const [origem, destino] of Object.entries(mapa)) {
    if (NOMES_CANONICOS.includes(origem)) continue;
    rows.appendChild(linhaMapa({ origem, destino: destino || '', dica: '', fixa: false }));
  }
  sincronizarMapaJson();
}

function linhaMapa({ origem, destino, dica, fixa }) {
  const row = document.createElement('div');
  row.className = 'map-row';

  // --- coluna 1: evento do seu site
  const org = document.createElement('div');
  org.className = 'map-org';
  const inpOrigem = document.createElement('input');
  inpOrigem.type = 'text';
  inpOrigem.className = 'map-origem';
  inpOrigem.value = origem;
  inpOrigem.placeholder = 'nome_do_evento';
  inpOrigem.setAttribute('aria-label', 'Evento do seu site');
  if (fixa) {
    inpOrigem.readOnly = true;
    inpOrigem.title = 'Evento canônico do produto — o nome não muda.';
  }
  org.appendChild(inpOrigem);
  if (dica) {
    const d = document.createElement('span');
    d.className = 'map-hint';
    d.innerHTML = dica;
    org.appendChild(d);
  }
  row.appendChild(org);

  const seta = document.createElement('span');
  seta.className = 'map-arrow';
  seta.textContent = '→';
  seta.setAttribute('aria-hidden', 'true');
  row.appendChild(seta);

  // --- coluna 2: evento na Meta
  const dest = document.createElement('div');
  dest.className = 'map-dest';
  const sel = document.createElement('select');
  sel.className = 'map-destino';
  sel.setAttribute('aria-label', `Evento na Meta para ${origem || 'este evento'}`);
  sel.appendChild(opcao('', 'Não enviar'));
  for (const nome of META_EVENTOS_PADRAO) sel.appendChild(opcao(nome, nome));
  sel.appendChild(opcao('__custom__', 'Personalizado…'));

  const inpCustom = document.createElement('input');
  inpCustom.type = 'text';
  inpCustom.className = 'map-custom';
  inpCustom.placeholder = 'NomeDoEventoNaMeta';
  inpCustom.setAttribute('aria-label', 'Nome personalizado do evento na Meta');

  const personalizado = destino && !META_EVENTOS_PADRAO.includes(destino);
  sel.value = personalizado ? '__custom__' : destino;
  inpCustom.value = personalizado ? destino : '';
  inpCustom.hidden = !personalizado;

  sel.addEventListener('change', () => {
    const custom = sel.value === '__custom__';
    inpCustom.hidden = !custom;
    if (custom) inpCustom.focus();
    atualizarLinhaMapa(row);
  });
  inpCustom.addEventListener('input', sincronizarMapaJson);
  inpOrigem.addEventListener('input', sincronizarMapaJson);

  dest.append(sel, inpCustom);
  row.appendChild(dest);

  // --- coluna 3: remover (só as linhas que o operador criou)
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'map-del';
  del.textContent = 'remover';
  if (fixa) {
    del.disabled = true;
    del.title = 'Evento canônico: para parar de enviar, escolha "Não enviar".';
  } else {
    del.addEventListener('click', () => { row.remove(); sincronizarMapaJson(); });
  }
  row.appendChild(del);

  atualizarLinhaMapa(row);
  return row;
}

function opcao(valor, rotulo) {
  const o = document.createElement('option');
  o.value = valor;
  o.textContent = rotulo;
  return o;
}

// Linha sem destino fica visualmente apagada: "não enviar" precisa parecer
// desligado, não parecer um campo que alguém esqueceu de preencher.
function atualizarLinhaMapa(row) {
  const sel = row.querySelector('.map-destino');
  row.classList.toggle('is-off', !sel.value);
  sincronizarMapaJson();
}

// Lê a tabela e devolve o objeto que vai no campo eventMap.
function lerMapaMeta() {
  const mapa = {};
  for (const row of $$('#metaMapRows .map-row')) {
    const origem = row.querySelector('.map-origem').value.trim();
    if (!origem) continue;
    const sel = row.querySelector('.map-destino');
    const destino = sel.value === '__custom__'
      ? row.querySelector('.map-custom').value.trim()
      : sel.value;
    if (!destino) continue; // "não enviar" = fora do mapa
    mapa[origem] = destino;
  }
  return mapa;
}

// A tabela é a fonte da verdade; o textarea é a visão em JSON dela. Se o operador
// editar o JSON, marcamos como sujo e exigimos "Aplicar à tabela" antes de salvar —
// salvar silenciosamente a tabela descartaria a edição sem avisar.
let mapaJsonSujo = false;

function sincronizarMapaJson() {
  if (mapaJsonSujo) return;
  const mapa = lerMapaMeta();
  $('#metaEventMap').value = Object.keys(mapa).length ? JSON.stringify(mapa, null, 2) : '{}';
  const n = Object.keys(mapa).length;
  $('#metaMapCount').textContent = n
    ? `${n} evento(s) sendo enviado(s) à Meta`
    : 'nenhum evento sendo enviado à Meta';
}

function marcarMapaJsonSujo() {
  mapaJsonSujo = true;
  $('#metaMapJsonBox').classList.add('is-dirty');
}

function aplicarMapaJson() {
  const bruto = $('#metaEventMap').value.trim();
  let mapa;
  try {
    mapa = bruto ? JSON.parse(bruto) : {};
  } catch (err) {
    toast('JSON do mapeamento inválido: ' + err.message, 'err');
    return;
  }
  if (typeof mapa !== 'object' || mapa === null || Array.isArray(mapa)) {
    toast('O mapeamento precisa ser um objeto, no formato {"evento_do_site":"EventoNaMeta"}.', 'err');
    return;
  }
  const limpo = {};
  for (const [k, v] of Object.entries(mapa)) {
    if (String(k).trim() && v) limpo[String(k).trim()] = String(v).trim();
  }
  mapaJsonSujo = false;
  $('#metaMapJsonBox').classList.remove('is-dirty');
  renderMapaMeta(limpo);
  applyRole();
  toast('Mapeamento aplicado à tabela. Revise e clique em Salvar Meta.', 'ok');
}

function descartarMapaJson() {
  mapaJsonSujo = false;
  $('#metaMapJsonBox').classList.remove('is-dirty');
  sincronizarMapaJson();
  toast('Edição do JSON descartada. A tabela continua valendo.', 'ok');
}

function adicionarLinhaMapa() {
  const row = linhaMapa({ origem: '', destino: '', dica: '', fixa: false });
  $('#metaMapRows').appendChild(row);
  applyRole();
  row.querySelector('.map-origem').focus();
}

// Credenciais são exclusivas de admin — o backend recusa, mas evitamos a viagem em vão.
function bloqueadoParaOperador() {
  if (isAdmin()) return false;
  toast('Apenas administradores podem alterar credenciais.', 'err');
  return true;
}

// Validação de forma, feita antes da viagem ao servidor. Só recusa o que é
// comprovadamente inválido (Pixel ID é numérico na Meta) — palpite sobre formato de
// segredo fica de fora de propósito: um token que "parece errado" mas funciona não pode
// ser barrado por uma regra de tela.
function validarCamposMeta() {
  campoLimparErros('#metaForm');
  let ok = true;

  const pixel = $('#metaPixelId').value.trim();
  if (pixel && !/^\d{8,20}$/.test(pixel)) {
    campoErro('#metaPixelId', 'O Pixel ID é só números (15 a 16 dígitos, sem espaços nem traços).');
    ok = false;
  }

  const test = $('#metaTestEventCode').value.trim();
  if (test && /\s/.test(test)) {
    campoErro('#metaTestEventCode', 'O Test Event Code não tem espaços — copie o código exatamente como aparece em "Eventos de teste".');
    ok = false;
  }

  if (!ok) {
    const primeiro = $('#metaForm [aria-invalid="true"]');
    if (primeiro) { primeiro.focus(); primeiro.scrollIntoView({ block: 'center' }); }
  }
  return ok;
}

async function saveMeta(e) {
  e.preventDefault();
  if (bloqueadoParaOperador()) return;
  if (!validarCamposMeta()) {
    toast('Confira os campos destacados antes de salvar.', 'warn');
    return;
  }
  if (mapaJsonSujo) {
    toast('Você editou o mapeamento como JSON. Clique em "Aplicar à tabela" antes de salvar.', 'warn', 5200);
    $('#metaMapJsonBox').open = true;
    $('#metaEventMap').focus();
    return;
  }
  const body = {
    enabled: $('#metaEnabled').checked,
    pixelId: $('#metaPixelId').value.trim(),
    testEventCode: $('#metaTestEventCode').value.trim(),
    eventMap: lerMapaMeta(),
  };
  // Campo em branco = mantém o que está salvo. É contrato de segurança, não
  // conveniência: o painel não conhece o valor atual e não teria como reenviá-lo.
  const token = $('#metaAccessToken').value.trim();
  if (token) body.accessToken = token; // so envia se preenchido

  await comBotaoCarregando(e.submitter, async () => {
    try {
      state.project = await api('/projects/' + state.selectedId + '/meta', { method: 'PUT', body });
      fillMetaForm(state.project);
      renderChecklist(state.project);
      renderMetaStatus(state.project, undefined);
      loadMetaStatus();
      renderDestinosTeste();
      toast('Configuração da Meta salva.', 'ok');
    } catch (err) {
      // Erro do servidor sobre um campo conhecido volta para o próprio campo, não só
      // para o toast: o toast some, a borda vermelha fica onde há trabalho a fazer.
      if (/pixel/i.test(err.message)) campoErro('#metaPixelId', err.message);
      else if (/token/i.test(err.message)) campoErro('#metaAccessToken', err.message);
      toast('Erro ao salvar Meta: ' + err.message, 'err');
    }
  });
}
