// Aba Google: GA4 Measurement Protocol e Google Ads.
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// ---------------- Estado da integração (cartão de saúde da "Visão geral") ----------------
// GA4 e Google Ads exigem campos bem diferentes (Measurement ID+API Secret de um lado,
// Customer ID+OAuth2 completo do outro) — por isso as duas células "específicas" do
// cartão trocam conforme `g.route`, mas a estrutura (int-grid, celulaStatus,
// celulaUltimoSucesso/celulaTaxaDestino) é a mesma da Meta, vinda de meta.js/falhas.js.
async function loadGoogleStatus() {
  if (!state.selectedId || !state.project) return;
  const projetoNoInicio = state.selectedId;
  renderGoogleStatus(state.project, undefined);
  let m = null;
  try {
    m = await falhasMetricasDestino('google');
  } catch {
    m = null;
  }
  if (state.selectedId !== projetoNoInicio) return;
  renderGoogleStatus(state.project, m);
}

function renderGoogleStatus(p, m) {
  const el = $('#googleStatus');
  if (!el) return;
  const g = (p && p.google) || {};
  const isAds = g.route === 'google_ads';

  const celulas = [
    celulaStatus('Destino', g.enabled
      ? { dot: 'ok', valor: 'ligado', badge: true, sub: 'as conversões saem daqui', ajuda: 'destino-ligado-desligado' }
      : { dot: 'off', valor: 'desligado', badge: true, sub: 'os eventos são gravados, mas não enviados', ajuda: 'destino-ligado-desligado' }),

    celulaStatus('Rota', {
      dot: 'off', mudo: true, ajuda: 'google-rota',
      valor: isAds ? 'Google Ads API' : 'GA4 Measurement Protocol',
      sub: isAds ? 'Enhanced Conversions' : 'eventos para o GA4',
    }),
  ];

  if (isAds) {
    celulas.push(
      celulaStatus('Customer ID', g.customerId
        ? { dot: 'ok', valor: g.customerId, sub: 'conta de anúncios', ajuda: 'customer-id' }
        : { dot: 'err', valor: 'não configurado', badge: true, sub: 'sem ele nada é enviado', ajuda: 'customer-id' }),
      celulaStatus('OAuth', (g.clientId && g.hasClientSecret && g.hasRefreshToken && g.hasDeveloperToken)
        ? { dot: 'ok', valor: 'conectado', badge: true, sub: 'client id/secret, refresh e developer token salvos', ajuda: 'google-oauth-completo' }
        : { dot: 'err', valor: 'incompleto', badge: true, sub: 'falta alguma credencial OAuth2', ajuda: 'google-oauth-completo' }),
    );
  } else {
    celulas.push(
      celulaStatus('Measurement ID', g.measurementId
        ? { dot: 'ok', valor: g.measurementId, sub: 'fluxo de dados do GA4', ajuda: 'measurement-id' }
        : { dot: 'err', valor: 'não configurado', badge: true, sub: 'sem ele nada é enviado', ajuda: 'measurement-id' }),
      celulaStatus('API Secret', g.hasApiSecret
        ? { dot: 'ok', valor: 'conectado', badge: true, sub: 'criptografado em repouso', ajuda: 'api-secret' }
        : { dot: 'err', valor: 'não configurado', badge: true, sub: 'o GA4 recusa o envio', ajuda: 'api-secret' }),
    );
  }

  celulas.push(celulaUltimoSucesso(m), celulaTaxaDestino(m));

  el.innerHTML = `<div class="int-grid">${celulas.join('')}</div>`;

  const alerta = alertaGoogle(g, isAds);
  if (alerta) {
    const faixa = document.createElement('div');
    faixa.className = 'int-alerta';
    faixa.innerHTML = `<i data-lucide="triangle-alert" aria-hidden="true"></i><span>${alerta}</span>`;
    el.appendChild(faixa);
  }
  aplicarIcones(el);
}

function alertaGoogle(g, isAds) {
  if (!g.enabled) {
    return '<b>Destino desligado.</b> Marque "Enviar conversões para o Google" em Credenciais para o servidor começar a entregar.';
  }
  if (isAds) {
    const faltando = [];
    if (!g.customerId) faltando.push('o Customer ID');
    if (!g.clientId) faltando.push('o OAuth Client ID');
    if (!g.hasClientSecret) faltando.push('o Client Secret');
    if (!g.hasRefreshToken) faltando.push('o Refresh Token');
    if (!g.hasDeveloperToken) faltando.push('o Developer Token');
    if (faltando.length) return `<b>Falta ${faltando.join(', ')}.</b> Enquanto isso, os eventos são recebidos e gravados, mas não chegam ao Google Ads.`;
  } else {
    const faltando = [];
    if (!g.measurementId) faltando.push('o Measurement ID');
    if (!g.hasApiSecret) faltando.push('o API Secret');
    if (faltando.length) return `<b>Falta ${faltando.join(' e ')}.</b> Enquanto isso, os eventos são recebidos e gravados, mas não chegam ao GA4.`;
  }
  return '';
}

// ---------------- Hub: sub-navegação Google (Visão geral / Falhas / Credenciais) ----------------
// Sem "Mapeamento" próprio: no GA4/Google Ads o mapeamento de eventos é um campo JSON
// dentro do próprio formulário de credenciais (ver #gEventMap), não uma tabela separada
// como na Meta — por isso só 3 itens aqui, ao contrário dos 4 de META_SUBNAV_ITENS.
const GOOGLE_SUBNAV_ITENS = [
  { id: 'visao-geral', rotulo: 'Visão geral', icone: 'layout-dashboard' },
  { id: 'falhas', rotulo: 'Falhas', icone: 'octagon-alert' },
  { id: 'credenciais', rotulo: 'Credenciais', icone: 'key-round' },
];

function googleHubMontar() {
  const fluxoEl = $('#googleFluxo');
  if (fluxoEl) {
    fluxoEl.innerHTML = falhasFluxoHtml('google', { estruturaSubaba: 'credenciais', saidaSubaba: 'credenciais' });
    aplicarIcones(fluxoEl);
  }

  subNav('googleSubnav', GOOGLE_SUBNAV_ITENS, {
    ativo: 'visao-geral',
    aoTrocar: (id) => {
      if (id === 'visao-geral') falhasVisaoGeralMetricas('google', 'google');
      if (id === 'falhas') falhasMontar('google', '#googleFalhas', 'google');
    },
  });
  falhasAtualizarBadges();
}

// ---------------- Form Google ----------------

// O formulário do Google nasceu como uma pilha plana de campos: ligar/desligar, rota,
// GA4 e Google Ads, tudo com o mesmo peso visual. São TRÊS decisões diferentes, e a do
// meio (a rota) determina qual das outras duas vale — por isso cada uma vira um bloco
// com título, no mesmo padrão `.bloco/.bloco-h` que a aba Meta já usa. A estrutura é
// aplicada uma vez sobre o HTML existente (o markup é de outro dono nesta fase):
// nenhum id muda de lugar, só ganham moldura e cabeçalho.
function googleFormEstruturar() {
  const form = $('#googleForm');
  if (!form || form.dataset.estruturado) return;
  form.dataset.estruturado = '1';

  const blocoH = (k, titulo, descricao) => {
    const h = document.createElement('div');
    h.className = 'bloco-h';
    h.innerHTML = `<span class="bloco-k"></span><h3></h3><p></p>`;
    h.querySelector('.bloco-k').textContent = k;
    h.querySelector('h3').textContent = titulo;
    h.querySelector('p').textContent = descricao;
    return h;
  };

  // 1 · Destino e rota — as duas escolhas que valem para as duas rotas.
  const secaoRota = document.createElement('section');
  secaoRota.className = 'bloco';
  form.insertBefore(secaoRota, form.firstChild);
  secaoRota.appendChild(blocoH('Destino', 'Para onde as conversões vão',
    'A rota decide qual conjunto de credenciais abaixo é usado — o outro fica oculto.'));
  const campoAtivo = $('.field.switch', form);
  const campoRota = $('#gRoute').closest('.field');
  if (campoAtivo) secaoRota.appendChild(campoAtivo);
  if (campoRota) secaoRota.appendChild(campoRota);

  // 2 e 3 · As duas rotas ganham a mesma moldura, e continuam sendo escondidas
  // inteiras por `hidden` em toggleGoogleRoute — a moldura vai junto.
  const ga4 = $('#ga4Fields');
  if (ga4) {
    ga4.classList.add('bloco');
    ga4.insertBefore(blocoH('Credenciais · GA4', 'GA4 Measurement Protocol',
      'Os dois campos saem do mesmo lugar: Admin do GA4 → Fluxos de dados → o fluxo do site.'), ga4.firstChild);
  }
  const ads = $('#adsFields');
  if (ads) {
    ads.classList.add('bloco');
    ads.insertBefore(blocoH('Credenciais · Google Ads', 'Google Ads API — Enhanced Conversions',
      'Exige conta com acesso à API aprovado. Os quatro segredos ficam cifrados em repouso.'), ads.firstChild);
  }
}

function fillGoogleForm(p) {
  const g = p.google;
  googleFormEstruturar();
  campoLimparErros('#googleForm');
  blindarAutofill('#googleForm');
  $('#gEnabled').checked = !!g.enabled;
  $('#gRoute').value = g.route || 'ga4_mp';
  // GA4 MP
  $('#gMeasurementId').value = g.measurementId || '';
  $('#gApiSecret').value = '';
  $('#gEventMap').value = objToJson(g.eventMap);
  // Google Ads API
  $('#gCustomerId').value = g.customerId || '';
  $('#gLoginCustomerId').value = g.loginCustomerId || '';
  $('#gClientId').value = g.clientId || '';
  $('#gClientSecret').value = '';
  $('#gRefreshToken').value = '';
  $('#gDeveloperToken').value = '';
  $('#gConversionActions').value = objToJson(g.conversionActions);
  // Dicas de "já salvo": pílula de estado (cor + ícone) e, sempre, a regra de que o
  // campo em branco MANTÉM o segredo atual. O painel só conhece a flag `has*` (I-7).
  hint('#gApiSecretHint', g.hasApiSecret);
  hint('#gClientSecretHint', g.hasClientSecret);
  hint('#gRefreshHint', g.hasRefreshToken);
  hint('#gDevTokenHint', g.hasDeveloperToken);
  toggleGoogleRoute();
  googleHubMontar();
  loadGoogleStatus();
}

function hint(sel, saved) {
  dicaSegredo(sel, saved, SEGREDO_MANTEM,
    'Nenhum valor salvo. Cifrado em repouso e obrigatório para o upload real — nunca volta para esta tela depois de salvo.');
}

function toggleGoogleRoute() {
  const isAds = $('#gRoute').value === 'google_ads';
  $('#adsFields').hidden = !isAds;
  $('#ga4Fields').hidden = isAds;
}

// Só barra o que é comprovadamente inválido, e apenas na rota ativa: reprovar o
// Customer ID enquanto a rota é GA4 seria brigar com um campo que nem está na tela.
function validarCamposGoogle() {
  campoLimparErros('#googleForm');
  const isAds = $('#gRoute').value === 'google_ads';
  let ok = true;

  if (isAds) {
    const cid = $('#gCustomerId').value.trim();
    if (cid && !/^\d{3}-?\d{3}-?\d{4}$/.test(cid)) {
      campoErro('#gCustomerId', 'O Customer ID tem 10 dígitos, com ou sem traços. Ex.: 123-456-7890.');
      ok = false;
    }
    const clientId = $('#gClientId').value.trim();
    if (clientId && !/\.apps\.googleusercontent\.com$/.test(clientId)) {
      campoErro('#gClientId', 'O OAuth Client ID termina em .apps.googleusercontent.com — confira se copiou o valor inteiro.');
      ok = false;
    }
  } else {
    const mid = $('#gMeasurementId').value.trim();
    if (mid && !/^G-[A-Z0-9]{6,12}$/i.test(mid)) {
      campoErro('#gMeasurementId', 'O Measurement ID do GA4 começa com "G-". Ex.: G-ABC1234567.');
      ok = false;
    }
  }

  if (!ok) {
    const primeiro = $('#googleForm [aria-invalid="true"]');
    if (primeiro) { primeiro.focus(); primeiro.scrollIntoView({ block: 'center' }); }
  }
  return ok;
}

async function saveGoogle(e) {
  e.preventDefault();
  if (bloqueadoParaOperador()) return;
  if (!validarCamposGoogle()) {
    toast('Confira os campos destacados antes de salvar.', 'warn');
    return;
  }
  const eventMap = parseJsonField('#gEventMap');
  if (eventMap === undefined) { campoErro('#gEventMap', 'Este campo precisa ser um objeto JSON, no formato {"evento_do_site":"nome_no_ga4"}.'); return; }
  const conversionActions = parseJsonField('#gConversionActions');
  if (conversionActions === undefined) { campoErro('#gConversionActions', 'Este campo precisa ser um objeto JSON, no formato {"purchase":"customers/123/conversionActions/456"}.'); return; }
  const body = {
    enabled: $('#gEnabled').checked,
    route: $('#gRoute').value,
    // GA4 MP
    measurementId: $('#gMeasurementId').value.trim(),
    eventMap,
    // Google Ads API
    customerId: $('#gCustomerId').value.trim(),
    loginCustomerId: $('#gLoginCustomerId').value.trim(),
    clientId: $('#gClientId').value.trim(),
    conversionActions,
  };
  const secret = $('#gApiSecret').value.trim();
  if (secret) body.apiSecret = secret;
  const clientSecret = $('#gClientSecret').value.trim();
  if (clientSecret) body.clientSecret = clientSecret;
  const refreshToken = $('#gRefreshToken').value.trim();
  if (refreshToken) body.refreshToken = refreshToken;
  const developerToken = $('#gDeveloperToken').value.trim();
  if (developerToken) body.developerToken = developerToken;

  await comBotaoCarregando(e.submitter, async () => {
    try {
      state.project = await api('/projects/' + state.selectedId + '/google', { method: 'PUT', body });
      fillGoogleForm(state.project);
      renderChecklist(state.project);
      renderDestinosTeste();
      toast('Configuração do Google salva.', 'ok');
    } catch (err) {
      if (/measurement/i.test(err.message)) campoErro('#gMeasurementId', err.message);
      else if (/customer/i.test(err.message)) campoErro('#gCustomerId', err.message);
      toast('Erro ao salvar Google: ' + err.message, 'err');
    }
  });
}
