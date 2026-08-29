// Aba Postback: URL, método e prévia das macros.
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// ---------------- Hierarquia do formulário ----------------
// A aba era uma pilha plana: ligar/desligar, URL, método, headers, token e lista de
// eventos, tudo com o mesmo peso. São quatro perguntas distintas ("liga?", "para onde?",
// "como se autentica?", "quando dispara?") e agrupá-las é o que permite responder uma de
// cada vez. Mesma moldura `.bloco/.bloco-h` da aba Meta, aplicada uma única vez sobre o
// HTML existente — nenhum id muda, só ganham cabeçalho e caixa.
function postbackFormEstruturar() {
  const form = $('#postbackForm');
  if (!form || form.dataset.estruturado) return;
  form.dataset.estruturado = '1';

  const bloco = (k, titulo, descricao, nos) => {
    const validos = nos.filter(Boolean);
    if (!validos.length) return;
    const sec = document.createElement('section');
    sec.className = 'bloco';
    form.insertBefore(sec, validos[0]);
    const h = document.createElement('div');
    h.className = 'bloco-h';
    h.innerHTML = '<span class="bloco-k"></span><h3></h3><p></p>';
    h.querySelector('.bloco-k').textContent = k;
    h.querySelector('h3').textContent = titulo;
    h.querySelector('p').textContent = descricao;
    sec.appendChild(h);
    validos.forEach((n) => sec.appendChild(n));
  };

  const switchEl = $('.field.switch', form);
  const callout = $('.callout', form);
  const campoUrl = $('#pbUrl').closest('.field');
  const linhaMetodo = $('#pbMethod').closest('.row');
  const campoToken = $('#pbBearerToken').closest('.field');
  const campoEventos = $('#pbEventFilters').closest('.field');

  bloco('Postback', 'Disparar um callback quando a conversão chegar',
    'O servidor faz uma chamada HTTP para um sistema externo (rede de afiliados, CRM) assim que o evento entra.',
    [switchEl, callout]);
  bloco('Endereço', 'Para onde o callback vai',
    'A URL aceita macros entre chaves; elas são trocadas pelos dados reais do evento no momento do disparo.',
    [campoUrl, linhaMetodo]);
  bloco('Autenticação', 'Como o destino sabe que é você',
    'Opcional. O token vai no cabeçalho Authorization, fora da URL — URL viaja em log de servidor e de proxy.',
    [campoToken]);
  bloco('Gatilho', 'Quais eventos disparam',
    'Evento desmarcado é simplesmente ignorado por este destino; ele continua sendo gravado e enviado aos demais.',
    [campoEventos]);
}

// ---------------- Form Postback ----------------
function fillPostbackForm(p) {
  const pb = p.postback || {};
  postbackFormEstruturar();
  campoLimparErros('#postbackForm');
  blindarAutofill('#postbackForm');
  $('#pbEnabled').checked = !!pb.enabled;
  $('#pbUrl').value = pb.url || '';
  $('#pbMethod').value = pb.method || 'GET';
  $('#pbHeaders').value = pb.headers && Object.keys(pb.headers).length ? JSON.stringify(pb.headers) : '';
  $('#pbBearerToken').value = '';
  // Segredo: o painel recebe só a flag `hasBearerToken` (I-7). A frase de "em branco =
  // mantém" precisa estar na tela toda vez, senão salvar com o campo vazio parece apagar.
  dicaSegredo('#pbBearerHint', pb.hasBearerToken, SEGREDO_MANTEM,
    'Opcional. Se preenchido, o servidor envia Authorization: Bearer <token> no postback — mais seguro do que pôr o segredo nos headers acima. Cifrado em repouso.');
  // Preenche checkboxes de eventos
  const evList = pb.events || [];
  $$('.pb-ev').forEach((cb) => {
    cb.checked = evList.includes(cb.value);
  });
  updatePostbackPreview();
}

// Valida forma antes de gastar uma viagem ao servidor. A URL é o único campo em que um
// erro é silencioso na produção: um postback para um endereço malformado falha evento a
// evento, no worker, longe de quem configurou.
function validarCamposPostback() {
  campoLimparErros('#postbackForm');
  let ok = true;

  const url = $('#pbUrl').value.trim();
  if ($('#pbEnabled').checked && !url) {
    campoErro('#pbUrl', 'Com o postback ligado, a URL é obrigatória — sem ela não há para onde disparar.');
    ok = false;
  } else if (url) {
    // As macros ({fbclid} etc.) não são URL válida para o parser nativo: troca-se cada
    // uma por um valor de mentira só para conferir o esqueleto do endereço.
    const semMacros = url.replace(/\{[a-z_]+\}/gi, 'x');
    let u = null;
    try { u = new URL(semMacros); } catch { u = null; }
    if (!u || !/^https?:$/.test(u.protocol)) {
      campoErro('#pbUrl', 'A URL precisa ser absoluta e começar com http:// ou https://.');
      ok = false;
    }
  }

  const rawHeaders = $('#pbHeaders').value.trim();
  if (rawHeaders) {
    try {
      const h = JSON.parse(rawHeaders);
      if (typeof h !== 'object' || h === null || Array.isArray(h)) throw new Error('objeto');
    } catch {
      campoErro('#pbHeaders', 'Os headers precisam ser um objeto JSON. Ex.: {"X-Chave": "valor"}.');
      ok = false;
    }
  }

  if (!ok) {
    const primeiro = $('#postbackForm [aria-invalid="true"]');
    if (primeiro) { primeiro.focus(); primeiro.scrollIntoView({ block: 'center' }); }
  }
  return ok;
}

async function savePostback(e) {
  e.preventDefault();
  if (bloqueadoParaOperador()) return;
  if (!validarCamposPostback()) {
    toast('Confira os campos destacados antes de salvar.', 'warn');
    return;
  }
  let headers = {};
  const rawHeaders = $('#pbHeaders').value.trim();
  if (rawHeaders) {
    try { headers = JSON.parse(rawHeaders); } catch (err) {
      campoErro('#pbHeaders', 'Headers inválidos (JSON): ' + err.message);
      return;
    }
  }
  const events = $$('.pb-ev').filter((cb) => cb.checked).map((cb) => cb.value);
  const body = {
    enabled: $('#pbEnabled').checked,
    url: $('#pbUrl').value.trim(),
    method: $('#pbMethod').value,
    headers,
    events,
  };
  // Campo em branco = mantém o token atual. O painel não conhece o valor salvo e não
  // teria como reenviá-lo — omitir é o único jeito de preservar.
  const bearerToken = $('#pbBearerToken').value.trim();
  if (bearerToken) body.bearerToken = bearerToken; // so envia se preenchido

  await comBotaoCarregando(e.submitter, async () => {
    try {
      state.project = await api('/projects/' + state.selectedId + '/postback', { method: 'PUT', body });
      fillPostbackForm(state.project);
      renderChecklist(state.project);
      renderDestinosTeste();
      toast('Configuração de Postback salva.', 'ok');
    } catch (err) {
      if (/url/i.test(err.message)) campoErro('#pbUrl', err.message);
      toast('Erro ao salvar Postback: ' + err.message, 'err');
    }
  });
}

function updatePostbackPreview() {
  const url = $('#pbUrl').value.trim();
  const method = $('#pbMethod').value;
  if (!url) {
    $('#pbPreview').textContent = 'Configure a URL acima para ver a pré-visualização.';
    return;
  }
  // Substitui macros com valores de exemplo
  const exampleData = {
    event_name: 'purchase', event_id: 'ped-92710', event_time: '1722045600',
    user_id: 'player-4821', email: 'cliente%40exemplo.com', phone: '5511999999999',
    fbclid: 'AbCdEf123456', fbp: 'fb.1.1696000000.1234567890',
    fbc: 'fb.1.1696000000.AbCdEf123456', gclid: 'Cj0KCQjw_abc',
    ttclid: 'E.C.P.xxx', utm_source: 'facebook',
    value: '199.90', currency: 'BRL', ip: '189.40.12.34',
    ua: 'Mozilla%2F5.0', page_url: 'https%3A%2F%2Floja.com%2Fcheckout',
    content_name: 'Curso%20Pro', first_name: 'João', last_name: 'Silva',
    external_id: 'player-4821', gbraid: '', wbraid: '', content_ids: '',
  };
  const resolved = url.replace(/\{([a-z_]+)\}/gi, (m, key) => exampleData[key.toLowerCase()] || m);
  let preview = `${method} ${resolved}`;
  if (method === 'POST') {
    preview += '\n\nBody (JSON automático):\n' + JSON.stringify({
      event_name: 'purchase', event_id: 'ped-92710', user_id: 'player-4821',
      value: '199.90', currency: 'BRL', email: 'cliente@exemplo.com',
      fbclid: 'AbCdEf123456', fbp: 'fb.1.1696000000.1234567890',
      gclid: 'Cj0KCQjw_abc', utm_source: 'facebook', ip: '189.40.12.34',
    }, null, 2);
  }
  $('#pbPreview').textContent = preview;
}
