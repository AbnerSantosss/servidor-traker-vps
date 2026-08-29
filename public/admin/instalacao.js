// Aba Instalação: stepper (método → identidade/page_view → webhook → verificação),
// scripts do GTM, tag única sem GTM, webhook e token de ingestão.
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// ════════════════════════════════════════════════════════════════════
// ABA INSTALAÇÃO — Stepper de 4 passos (progressive disclosure)
// ════════════════════════════════════════════════════════════════════
//
// Por que um stepper e não a lista corrida de antes: a tela reunia checklist +
// duas trilhas completas + webhook + curl de uma vez só — tudo competia por
// atenção ao mesmo tempo, mesmo que só uma trilha valesse para quem estava
// instalando. Aqui só um passo fica aberto por vez (chunking de Miller: no
// máximo ~4 informações por bloco) e o Passo 1 decide o que o Passo 2 mostra.

// URLs oficiais do projeto (vindas do backend). Cai nas rotas legadas se o backend
// for antigo e nao mandar project.urls.
function projectUrls(p) {
  const base = location.origin;
  const u = (p && p.urls) || {};
  return {
    base: u.base || base,
    evento: u.evento || `${base}/ingest/${p.id}`,
    coleta: u.coleta || `${base}/collect/${p.id}`,
    scriptColetor: u.scriptColetor || `${base}/collector/${p.id}.js`,
    scriptTag: u.scriptTag || `${base}/snippet/${p.id}.js`,
    // Tag única do GTM: coletor + snippet + page_view num arquivo só, para o
    // container ter UMA tag de HTML personalizado em vez de duas.
    scriptGtm: u.scriptGtm || `${base}/g/${p.slug}.js`,
    // Tag única (instalação sem GTM, F9/E9) — só existe a rota nova por slug,
    // não há alias legado por project_id (ver src/ingest/scripts.js).
    scriptUnica: u.scriptUnica || `${base}/w/${p.slug}.js`,
  };
}

// ---------------- Destaque de sintaxe dos blocos de código ----------------
//
// Por que um destaque escrito à mão e não uma biblioteca: I-2 (sem build step) e I-1
// (CSP sem CDN) fariam qualquer highlighter entrar vendorizado, com dezenas de KB, para
// pintar cinco blocos curtos que o próprio painel gera. O que estes blocos têm é
// string, comentário, número, palavra-chave e tag HTML — cinco papéis, um regex.
//
// A regra que não pode ser quebrada aqui: TUDO que sai desta função passa por escape.
// O texto casado vira o conteúdo de um <span>, o texto não casado vira texto solto, e
// nos dois caminhos ele é escapado antes de virar HTML. Como o painel injeta aqui a URL
// do projeto e o conteúdo de um script servido pelo backend, um escape esquecido seria
// XSS, não um bug de cor.
const CB_REGEX = new RegExp([
  // URL vem PRIMEIRO, e é por um motivo concreto: sem ela, o `//` de `http://` casava
  // com a regra de comentário e o endpoint do projeto — a informação mais importante
  // do bloco de curl — aparecia em cinza itálico, como se fosse texto descartável.
  '(?<url>\\bhttps?:\\/\\/[^\\s\'"<>]+)',
  '(?<com>\\/\\/[^\\n]*)',                                        // comentário de linha
  '(?<str>\'(?:[^\'\\\\\\n]|\\\\.)*\'|"(?:[^"\\\\\\n]|\\\\.)*")', // string entre aspas
  '(?<tag><\\/?[A-Za-z][\\w-]*)',                                 // abertura de tag HTML
  '(?<key>\\b(?:window|const|let|var|function|return|new|await|async|true|false|null|curl)\\b)',
  '(?<num>\\b\\d+(?:\\.\\d+)?\\b)',
].join('|'), 'g');

function cbDestacar(texto) {
  let html = '';
  let fim = 0;
  for (const m of String(texto).matchAll(CB_REGEX)) {
    html += escHtml(texto.slice(fim, m.index));
    const [papel, valor] = Object.entries(m.groups).find(([, v]) => v !== undefined);
    html += `<span class="cb-${papel}">${escHtml(valor)}</span>`;
    fim = m.index + m[0].length;
  }
  return html + escHtml(texto.slice(fim));
}

// Escreve num `.codebox` já destacado. O texto continua recuperável por `textContent`
// (é o que os botões "Copiar" usam), então o destaque é puramente visual.
function cbEscrever(seletor, texto) {
  const el = $(seletor);
  if (!el) return;
  el.innerHTML = cbDestacar(texto);
}

// ---------------- Estado do stepper (por projeto, sobrevive ao F5) ----------------

const INST_PASSOS = [1, 2, 3, 4];

// true assim que o operador mexe manualmente num passo (clique no cabeçalho ou
// escolha de método) — a partir daí a detecção automática para de decidir sozinha
// qual passo fica aberto, porque isso brigaria com o que a pessoa está fazendo.
let _instPassoManual = false;

function instMetodoStorageKey(projectId) { return 'trkInstMetodo:' + projectId; }

function instMetodoSalvo(projectId) {
  try { return localStorage.getItem(instMetodoStorageKey(projectId)) || ''; } catch { return ''; }
}

function instSalvarMetodo(projectId, metodo) {
  // Modo privado/sem storage: a escolha simplesmente não sobrevive ao F5 — degrada
  // sem quebrar, não é motivo para travar a tela.
  try { localStorage.setItem(instMetodoStorageKey(projectId), metodo); } catch { /* noop */ }
}

// ---------------- Acordeão dos passos ----------------

function instAbrirPasso(n) {
  for (const i of INST_PASSOS) {
    const body = $('#instStep' + i + 'Body');
    const head = $('#instStep' + i + 'Head');
    const secao = $('#instStep' + i);
    if (!body || !head || !secao) continue;
    const aberto = i === n;
    body.hidden = !aberto;
    head.setAttribute('aria-expanded', aberto ? 'true' : 'false');
    secao.classList.toggle('is-aberto', aberto);
  }
}

const INST_STATUS_ICONE = { ok: 'circle-check-big', atual: 'circle-dot', pendente: 'circle-dashed' };

function instSetStepStatus(n, estadoStr) {
  const el = $('#instStep' + n + 'Status');
  if (!el) return;
  el.className = 'step-status is-' + estadoStr;
  el.innerHTML = `<i data-lucide="${INST_STATUS_ICONE[estadoStr] || 'circle'}" aria-hidden="true"></i>`;
  if (typeof aplicarIcones === 'function') aplicarIcones(el);
}

// ---------------- Passo 1: escolha de método ----------------

function instAplicarMetodo(metodo) {
  const gtm = $('#instTrilhaGtm');
  const propria = $('#instTrilhaPropria');
  const vazio = $('#instStep2Vazio');
  if (gtm) gtm.hidden = metodo !== 'gtm';
  if (propria) propria.hidden = metodo !== 'proprio';
  if (vazio) vazio.hidden = !!metodo;
}

function instEscolherMetodo(metodo) {
  if (!state.selectedId) return;
  instSalvarMetodo(state.selectedId, metodo);
  instAplicarMetodo(metodo);
  instSetStepStatus(1, 'ok');
  _instPassoManual = true;
  instAbrirPasso(2);
  // Recalcula a barra de progresso e os demais status — escolher o método também
  // conclui o Passo 1, então "X de 4" precisa refletir isso na hora, não só no
  // ícone do passo. `_instPassoManual` já está true, então isso não reabre nada sozinho.
  if (state.project) instAtualizarProgresso(state.project);
}

// ---------------- Passo 2 (trilha "código próprio"): conteúdo estático + urls ----------------

// Identificadores que a tag única já captura sozinha, sem nenhuma configuração —
// mesma lista de src/ingest/scripts.js (renderTagUnica). Fica fixo porque não
// depende do projeto: é o mesmo conjunto para qualquer instalação.
const INST_IDS_AUTO = [
  'fbclid', 'fbc', 'fbp', 'gclid', 'gbraid', 'wbraid', 'ttclid', 'ttp',
  'clickid', 'tblci', 'msclkid', 'twclid', 'li_fat_id', 'epik', 'sccid',
  '_scid', 'rdt_cid', 'irclickid', 'obclid', 'kwai_click_id',
];

function instPreencherIdsAuto() {
  const el = $('#instIdsAuto');
  // Lista fixa (não depende do projeto) — monta uma vez só, não a cada troca de projeto.
  if (!el || el.dataset.preenchido) return;
  el.dataset.preenchido = '1';
  el.innerHTML = INST_IDS_AUTO.map((id) => `<code class="id-badge">${id}</code>`).join('')
    + '<code class="id-badge id-badge-mais">utm_source/medium/campaign/content/term</code>';
}

function instPreencherTrilhaPropria(p, urls) {
  const tagUnica = [
    `<script async src="${urls.scriptUnica}"`,
    `        data-auto-pageview="1"`,
    `        data-debug="0"><\/script>`,
  ].join('\n');
  cbEscrever('#instTagUnicaBox', tagUnica);
  $('#btnOpenTagUnica').href = urls.scriptUnica;

  cbEscrever('#instExemploPurchase',
`window.trk('purchase', {
  custom_data: { value: 97, currency: 'BRL', order_id: 'pedido-9271' },
  user_data: { email: 'cliente@exemplo.com' }
});`);

  cbEscrever('#instExemploLead',
`window.trk('lead', {
  user_data: { email: 'cliente@exemplo.com', phone: '5511999999999' }
});`);

  cbEscrever('#instExemploConfig',
`window.trkConfig = {
  userIdKeys: ['meu_id_customizado'],      // globals extras onde procurar o user_id
  paramsGlobais: { affiliate_id: 'parceiro-42' }, // entra no custom_data de todo evento
  clickIds: ['msclkid', 'ttclid']          // identificadores extras a ler da query string
};`);

  instPreencherIdsAuto();
}

// ---------------- Passo 4: confirmação automática ----------------

// Uma chamada, um endpoint de leitura: `GET /projects/:id/instalacao` devolve os sinais
// já apurados no banco (ver src/db/repos/instalacao.js). Antes esta função baixava os
// últimos 100 eventos e deduzia três booleanos no navegador — o que não escala e, pior,
// não conseguia responder "quando" nem "de onde".
//
// Se a chamada falhar por qualquer razão, os passos continuam visíveis e navegáveis:
// só a confirmação fica indisponível, com o aviso correspondente. Degrada, não trava.
async function instAtualizarProgresso(p) {
  let dados = null;
  try {
    dados = await api('/projects/' + p.id + '/instalacao');
  } catch {
    dados = { falhou: true };
  }
  // O operador pode ter trocado de projeto enquanto a chamada estava no ar.
  if (!state.project || state.project.id !== p.id) return;
  instRenderizarStatus(dados, p);
}

/* Atualização periódica enquanto o Passo 4 está aberto.

   Por que intervalo e não SSE: o stream (`/projects/:id/stream`) existe e seria a via
   natural, mas ele só é aberto pela aba "Ao vivo" e o servidor limita conexões por
   cliente (src/admin/stream.js). Abrir um segundo EventSource aqui gastaria uma vaga
   que a aba de tempo real precisa. A confirmação é usada por alguns minutos durante a
   instalação, e o endpoint é barato — oito consultas indexadas com LIMIT 1 —, então um
   intervalo curto entrega a mesma sensação ("colei a tag, abri o site, a linha virou")
   sem disputar recurso com quem está monitorando.

   O timer só existe enquanto o passo está aberto: fechado, ele é desligado. Painel que
   consulta em segundo plano para sempre é como se descobre, meses depois, que o banco
   está recebendo mil consultas por minuto de abas esquecidas. */
const INST_INTERVALO_MS = 8000;
let _instTimer = null;

function instPararAtualizacao() {
  if (_instTimer) { clearInterval(_instTimer); _instTimer = null; }
}

function instIniciarAtualizacao() {
  instPararAtualizacao();
  _instTimer = setInterval(() => {
    const corpo = $('#instStep4Body');
    const aberto = corpo && !corpo.hidden && corpo.offsetParent !== null;
    // Aba escondida = ninguém olhando. Consultar aí só gasta bateria e conexão.
    if (!aberto || document.hidden || !state.project) { instPararAtualizacao(); return; }
    instAtualizarProgresso(state.project);
  }, INST_INTERVALO_MS);
}

function instRenderizarStatus(dados, projeto) {
  const sinais = (dados && dados.sinais) || {};
  const metodo = !!instMetodoSalvo((projeto || state.project || {}).id);

  // Cada passo é dado por concluído pela EVIDÊNCIA correspondente, não pelo que está
  // salvo na configuração — é a mesma regra dos sinais, aplicada à barra de progresso.
  const passo1Ok = metodo;
  const passo2Ok = !!sinais.tag_navegador?.ok;
  const passo3Ok = !!sinais.webhook_backend?.ok;
  const passo4Ok = passo2Ok && passo3Ok && (!!sinais.entrega_meta?.ok || !!sinais.entrega_google?.ok);
  const estados = [passo1Ok, passo2Ok, passo3Ok, passo4Ok];

  instSetStepStatus(1, passo1Ok ? 'ok' : 'atual');
  instSetStepStatus(2, passo2Ok ? 'ok' : (passo1Ok ? 'atual' : 'pendente'));
  instSetStepStatus(3, passo3Ok ? 'ok' : 'atual');
  instSetStepStatus(4, passo4Ok ? 'ok' : 'pendente');

  const concluidos = estados.filter(Boolean).length;
  const fill = $('#instProgressoFill');
  if (fill) fill.style.width = (concluidos / 4 * 100) + '%';
  const label = $('#instProgressoLabel');
  if (label) label.textContent = `${concluidos} de 4 passos concluídos`;

  instPreencherVerificacao(dados);

  // Só decide sozinho qual passo abrir se o operador ainda não escolheu um na mão.
  if (!_instPassoManual) {
    const primeiroPendente = INST_PASSOS.find((n) => !estados[n - 1]);
    instAbrirPasso(primeiroPendente || 4);
  }

  const corpo = $('#instStep4Body');
  if (corpo && !corpo.hidden) instIniciarAtualizacao();
}

/* ---------------- Passo 4: confirmação por evidência ----------------

   A versão anterior desta tela lia a CONFIGURAÇÃO do projeto ("Pixel ID preenchido ✓")
   e três booleanos sobre os últimos 100 eventos. O problema é que configuração não é
   instalação: dá para ter todo campo preenchido, a tag nunca ter sido publicada no GTM,
   e a tela mostrar verde. Agora cada linha vem de `GET /projects/:id/instalacao`, onde
   cada sinal é algo que só existe se aquele pedaço rodou — com a hora em que rodou.

   Cada sinal tem três textos, e os três importam:
   - `titulo`  — o que está sendo afirmado;
   - `feito()` — a evidência, com hora e origem. É o que separa "confirmado" de "achamos";
   - `falta`   — o diagnóstico honesto de quem ainda não viu evidência, dizendo o que
                 fazer. "Ainda não chegou" sem instrução é uma pendência sem saída. */

const INST_SINAIS = [
  {
    chave: 'tag_navegador',
    titulo: 'A tag está rodando no site',
    feito: (d) => 'Último evento do navegador ' + instQuando(d.em) +
      (d.onde ? ' · ' + d.onde : '') +
      (d.ultimas_24h ? ' · ' + d.ultimas_24h + ' nas últimas 24h' : ''),
    falta: 'Nenhum evento do navegador chegou ainda. Publique a tag do Passo 2 (salvar não basta) e abra o site.',
  },
  {
    chave: 'pixel_meta',
    titulo: 'O Pixel da Meta está na mesma página',
    feito: (d) => 'Cookie _fbp recebido ' + instQuando(d.em) + ' — só o fbq cria esse valor.',
    // Este é o diagnóstico mais valioso da tela: é a falha que NÃO dá erro em lugar
    // nenhum. Os eventos chegam, o dashboard enche, e a conversão vale menos.
    falta: 'Os eventos chegam, mas sem o cookie _fbp — o Pixel não está rodando nesta página. ' +
      'A CAPI continua funcionando, porém sem deduplicação e com correspondência menor.',
  },
  {
    chave: 'clique_anuncio',
    titulo: 'O clique do anúncio está sendo capturado',
    feito: (d) => 'Identificador de clique recebido ' + instQuando(d.em) +
      instLista([d.meta && 'Meta (fbc)', d.google && 'Google (gclid)']),
    falta: 'Nenhum fbclid ou gclid capturado ainda. É normal se ninguém entrou por um anúncio desde a instalação.',
  },
  {
    chave: 'ponte_identidade',
    titulo: 'A ponte de identidade está amarrando o visitante',
    feito: (d) => d.pessoas + ' visitante(s) com identificador guardado · último ' + instQuando(d.em),
    falta: 'Ninguém foi identificado ainda. O site precisa expor o user_id (no dataLayer, no GTM) ' +
      'para a conversão do backend saber de qual clique veio.',
  },
  {
    chave: 'webhook_backend',
    titulo: 'O backend está mandando as conversões',
    feito: (d) => 'Último ' + (d.evento ? '"' + d.evento + '" ' : '') + 'recebido ' + instQuando(d.em),
    falta: 'Nenhuma conversão chegou pelo webhook. Confira a URL e o token no Passo 3.',
  },
  {
    chave: 'entrega_meta',
    titulo: 'A Meta confirmou o recebimento',
    feito: (d) => 'Confirmado ' + instQuando(d.em) +
      (d.eventos_recebidos != null ? ' · ' + d.eventos_recebidos + ' evento(s) aceito(s)' : '') +
      (d.fbtrace_id ? ' · fbtrace ' + d.fbtrace_id : ''),
    falta: 'A Meta ainda não confirmou nenhum evento. Se o destino está ligado, confira as falhas na aba Logs.',
  },
  {
    chave: 'entrega_google',
    titulo: 'O Google confirmou o recebimento',
    feito: (d) => 'Confirmado ' + instQuando(d.em),
    falta: 'O Google ainda não confirmou nenhum evento. Normal enquanto o destino estiver desligado.',
  },
  {
    chave: 'dominio',
    titulo: 'O domínio próprio está com certificado',
    feito: (d) => d.hostname + ' ativo' + (d.em ? ' desde ' + instQuando(d.em) : ''),
    falta: (d) => (d && d.hostname)
      ? d.hostname + ' está em "' + d.situacao + '". Sem certificado, a tag continua no domínio do serviço — ' +
        'e o cookie nasce lá, ilegível para o Pixel na página do cliente.'
      : 'Nenhum domínio próprio cadastrado. Sem ele a tag responde, mas o cookie não é first-party.',
  },
];

/** "agora há pouco", "há 3 h", "em 21/08" — hora relativa responde "isso é recente?". */
function instQuando(iso) {
  if (!iso) return 'em momento desconhecido';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'em momento desconhecido';
  const seg = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (seg < 60) return 'agora há pouco';
  if (seg < 3600) return 'há ' + Math.round(seg / 60) + ' min';
  if (seg < 86400) return 'há ' + Math.round(seg / 3600) + ' h';
  return 'em ' + new Date(iso).toLocaleDateString('pt-BR');
}

function instLista(partes) {
  const uteis = partes.filter(Boolean);
  return uteis.length ? ' · ' + uteis.join(' e ') : '';
}

function instPreencherVerificacao(dados) {
  const el = $('#instVerifLista');
  if (!el) return;

  if (!dados || dados.falhou) {
    el.innerHTML = '<div class="callout amber inst-chk-alerta">' +
      '<i data-lucide="triangle-alert" aria-hidden="true"></i>' +
      '<span>Não foi possível conferir agora. Os passos continuam navegáveis; a aba Logs mostra o que chegou.</span></div>';
    if (typeof aplicarIcones === 'function') aplicarIcones(el);
    return;
  }

  const sinais = dados.sinais || {};
  el.innerHTML = INST_SINAIS.map((s) => {
    const d = sinais[s.chave] || { ok: false };
    const texto = d.ok ? s.feito(d) : (typeof s.falta === 'function' ? s.falta(d) : s.falta);
    return '<div class="inst-verif-row ' + (d.ok ? 'is-ok' : 'is-pendente') + '">' +
      '<i data-lucide="' + (d.ok ? 'circle-check-big' : 'circle-dashed') + '" aria-hidden="true"></i>' +
      '<div><b>' + escHtml(s.titulo) + '</b><span>' + escHtml(texto) + '</span></div></div>';
  }).join('') + instRessalvas(dados.ressalvas);

  if (typeof aplicarIcones === 'function') aplicarIcones(el);
}

/* As ressalvas não são sinais — são avisos que MUDAM o significado de um "confirmado".
   A mais cara é o modo de teste da Meta: com ele ativo tudo aparece como entregue e
   nada entra nos dados da conta, então a campanha não otimiza. Quem lê "Meta confirmou"
   sem esta linha vai embora achando que terminou. */
function instRessalvas(r) {
  if (!r) return '';
  const avisos = [];
  if (r.meta_em_modo_teste) {
    avisos.push('A Meta está em modo de teste (Test Event Code preenchido): os eventos aparecem em ' +
      '"Eventos de teste" e não entram nos dados da conta. Remova o código quando terminar de validar.');
  }
  if (r.google_aceita_em_silencio) {
    avisos.push('O Measurement Protocol do GA4 responde sucesso mesmo para payload inválido — ' +
      '"confirmado" ali é mais fraco que na Meta. Confira no DebugView do GA4.');
  }
  if (!avisos.length) return '';
  return avisos.map((a) => '<div class="callout amber inst-chk-alerta">' +
    '<i data-lucide="triangle-alert" aria-hidden="true"></i><span>' + escHtml(a) + '</span></div>').join('');
}

// ---------------- Render principal ----------------

function renderSetup(p) {
  const urls = projectUrls(p);

  _instPassoManual = false;

  // --- Checklist de configuração dos destinos (colapsado, ver admin.html) ---
  renderChecklist(p);

  // --- Webhook URL (endpoint de eventos) ---
  $('#whUrl').textContent = urls.evento;

  // --- Identificadores do projeto ---
  $('#pjSlug').textContent = p.slug || '—';
  $('#pjCollectUrl').textContent = urls.coleta;
  renderIngestToken(p);

  // --- Trilha GTM · tag única: identidade + page_view no mesmo arquivo ---
  $('#btnOpenCollector').href = urls.scriptGtm;

  // --- Trilha "código próprio" (tag única, sem GTM) ---
  instPreencherTrilhaPropria(p, urls);

  // --- Passo 3 · exemplo de chamada do backend ---
  cbEscrever('#curlBox', exemploCurl(urls.evento));

  // Se o script GTM já foi gerado anteriormente nesta sessão, mostra a área
  if ($('#gtmScriptArea').dataset.generated === 'true') {
    generateGTMScript();
  }

  // --- Passo 1: aplica o método salvo (a escolha sobrevive ao F5, por projeto) ---
  const metodoSalvo = instMetodoSalvo(p.id);
  const radioGtm = $('#instMetodoGtm');
  const radioPropria = $('#instMetodoProprio');
  if (radioGtm) radioGtm.checked = metodoSalvo === 'gtm';
  if (radioPropria) radioPropria.checked = metodoSalvo === 'proprio';
  instAplicarMetodo(metodoSalvo);

  // Chute inicial de qual passo abrir — a detecção automática (abaixo) substitui
  // por um valor real assim que a resposta do servidor chegar.
  instAbrirPasso(metodoSalvo ? 3 : 1);
  instAtualizarProgresso(p);
}

// Token de ingestão é segredo de webhook e não vem mais no payload do projeto — o
// detalhe traz só o booleano `temIngestToken`. O valor sai de um endpoint próprio,
// restrito a admin e auditado no servidor, buscado no clique. Guardamos o que foi
// revelado apenas em memória, e descartamos ao trocar de projeto.
let ingestTokenRevelado = null;

function renderIngestToken(p) {
  const el = $('#pjIngestToken');
  const btnMostrar = $('#btnToggleToken');
  const btnCopiar = $('#btnCopyToken');

  ingestTokenRevelado = null;
  el.classList.remove('ident-restrito');
  delete el.dataset.visible;

  if (!p || !p.temIngestToken) {
    el.textContent = '—';
    btnMostrar.hidden = true;
    btnCopiar.hidden = true;
    return;
  }

  // O endpoint de revelação responde 403 para operador — nem oferecemos o botão.
  if (!isAdmin()) {
    el.textContent = 'restrito a administradores';
    el.classList.add('ident-restrito');
    btnMostrar.hidden = true;
    btnCopiar.hidden = true;
    return;
  }

  btnMostrar.hidden = false;
  btnCopiar.hidden = false;
  ocultarIngestToken();
}

// Volta ao estado mascarado. O comprimento real do token não é conhecido aqui (ele
// não trafega no payload), então a máscara tem tamanho fixo — é só marcador visual.
function ocultarIngestToken() {
  const el = $('#pjIngestToken');
  el.textContent = '•'.repeat(32);
  el.dataset.visible = 'false';
  $('#btnToggleToken').textContent = 'Mostrar';
}

function exibirIngestToken(token) {
  const el = $('#pjIngestToken');
  el.textContent = token;
  el.dataset.visible = 'true';
  $('#btnToggleToken').textContent = 'Ocultar';
}

// Busca o token no endpoint dedicado. Reaproveita o valor já revelado neste projeto
// para não gerar uma entrada de auditoria nova a cada clique.
async function obterIngestToken() {
  if (ingestTokenRevelado) return ingestTokenRevelado;
  const r = await api('/projects/' + state.selectedId + '/ingest-token');
  ingestTokenRevelado = (r && r.ingestToken) || '';
  if (!ingestTokenRevelado) throw new Error('o servidor não devolveu o token');
  return ingestTokenRevelado;
}

async function toggleIngestToken() {
  if ($('#pjIngestToken').dataset.visible === 'true') {
    ocultarIngestToken();
    return;
  }
  const btn = $('#btnToggleToken');
  btn.disabled = true;
  try {
    exibirIngestToken(await obterIngestToken());
  } catch (err) {
    toast('Não foi possível revelar o token: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// Copiar também revela: como o valor só chega depois de uma ida ao servidor, a área
// de transferência pode recusar a escrita (o clique já "esfriou"). Com o token na
// tela, sobra o caminho manual em vez de um erro sem saída.
async function copyIngestToken() {
  const btn = $('#btnCopyToken');
  btn.disabled = true;
  try {
    const token = await obterIngestToken();
    exibirIngestToken(token);
    await copyText(token, 'Token de ingestão copiado! Guarde em local seguro.');
  } catch (err) {
    toast('Não foi possível copiar o token: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function renderChecklist(p) {
  const checks = [
    { ok: true, label: 'Projeto criado', detail: `project_id: ${p.id}` },
    { ok: !!p.meta.pixelId, label: 'Pixel ID da Meta', detail: p.meta.pixelId || 'Não configurado — vá na aba Meta' },
    { ok: !!p.meta.hasAccessToken, label: 'Access Token da Meta', detail: p.meta.hasAccessToken ? 'Configurado (criptografado)' : 'Não configurado — vá na aba Meta' },
    { ok: true, skip: !p.meta.testEventCode, label: 'Test Event Code', detail: p.meta.testEventCode || 'Não configurado — sem ele o modo Teste do console fica indisponível' },
    { ok: !!p.google?.enabled, label: 'Google ativo', detail: p.google?.enabled ? 'Ativado' : 'Opcional — configure na aba Google' },
  ];

  const el = $('#setupChecklist');
  el.innerHTML = '<h4 style="margin:0 0 10px 0;color:var(--text)">Status da Configuração</h4>';

  // Três estados, não dois: item opcional que não foi preenchido não é sucesso (marca
  // verde ao lado de "não configurado" confunde) nem alerta. Cada um traz o próprio
  // ícone, então a lista continua legível para quem não separa verde de âmbar.
  const ESTADOS = {
    pulado:    { icone: 'minus',           cls: 'inst-chk-pulado' },
    ok:        { icone: 'circle-check-big', cls: 'inst-chk-ok' },
    pendente:  { icone: 'triangle-alert',   cls: 'inst-chk-pendente' },
  };

  for (const c of checks) {
    const est = ESTADOS[c.skip ? 'pulado' : c.ok ? 'ok' : 'pendente'];
    const row = document.createElement('div');
    row.className = 'inst-chk-row ' + est.cls;
    row.innerHTML = `<i data-lucide="${est.icone}" aria-hidden="true"></i><span><b></b> — <span class="inst-chk-detalhe"></span></span>`;
    row.querySelector('b').textContent = c.label;
    row.querySelector('.inst-chk-detalhe').textContent = c.detail;
    el.appendChild(row);
  }
  aplicarIcones(el);

  // Alerta se falta o essencial
  const metaReady = !!p.meta.pixelId && !!p.meta.hasAccessToken;
  if (!metaReady) {
    const warn = document.createElement('div');
    warn.className = 'callout amber inst-chk-alerta';
    // Ícone Lucide no lugar do emoji: emoji muda de desenho (e de cor) a cada sistema
    // operacional e traz para o painel uma cor que não é da paleta.
    warn.innerHTML = '<i data-lucide="triangle-alert" aria-hidden="true"></i><span><b>Configure o Pixel ID e o Access Token na aba Meta</b> antes de gerar o script e disparar conversões. Sem isso, os eventos são aceitos mas não enviados à Meta.</span>';
    el.appendChild(warn);
    aplicarIcones(warn);
  }
}

// --- GERAR SCRIPT GTM AUTOMATICAMENTE ---
function generateGTMScript() {
  const p = state.project;
  if (!p) return;

  const urls = projectUrls(p);

  // Uma tag só: /g/ empacota coletor + snippet + page_view num arquivo, na ordem certa
  // (o coletor grava os tk_* que o snippet lê; dois <script src> injetados pelo GTM não
  // têm ordem garantida).
  //
  // ERRATA (2026-08-26): a versão anterior deste comentário afirmava que o GTM recusa
  // "JavaScript cru colado" no campo HTML personalizado. Isso vale só para JS SEM o
  // embrulho <script>...</script> — com ele, o campo aceita normalmente, e é assim que
  // a maioria das tags customizadas é instalada. Ou seja: aquele argumento NÃO era razão
  // para preferir o <script src>. As razões reais são outras, e são estas:
  //   1. Atualização central — corrigimos a tag no servidor e todo cliente passa a
  //      receber a versão nova sem republicar container nenhum.
  //   2. O endpoint e o slug são embutidos pelo servidor, então não há como o operador
  //      colar a URL de outro projeto (erro silencioso e caro).
  //   3. O código não pode ser editado por engano dentro da tag.
  // O custo é uma viagem de rede antes da captura; ver docs/04 §2.2.
  const scriptContent = `<script src="${urls.scriptGtm}"><\/script>`;

  cbEscrever('#collectorBox', scriptContent);
  $('#gtmScriptArea').hidden = false;
  $('#gtmScriptArea').dataset.generated = 'true';

  toast('Script GTM gerado com sucesso! Copie e cole no GTM Web.', 'ok');
}

// Exemplo de chamada da Trilha B (Passo 3). O token não entra aqui: ele só existe na
// tela depois de o operador clicar em "Mostrar", e colar segredo em bloco copiável é
// a forma mais fácil de ele acabar num chat de suporte.
function exemploCurl(url) {
  const corpo = {
    event_name: 'purchase',
    event_id: 'pedido-9271',
    user_id: 'player-4821',
    user_data: { email: 'cliente@exemplo.com', phone: '5511999999999' },
    custom_data: { value: 199.9, currency: 'BRL', order_id: 'pedido-9271' },
  };
  return [
    `curl -X POST ${url} \\`,
    "  -H 'Content-Type: application/json' \\",
    "  -H 'Authorization: Bearer SEU_TOKEN' \\",
    `  -d '${JSON.stringify(corpo, null, 2).split('\n').join('\n     ')}'`,
  ].join('\n');
}

// Endpoint de eventos do projeto selecionado (rota nova por slug).
function eventoUrl() {
  return state.project ? projectUrls(state.project).evento : '/ingest/' + state.selectedId;
}

// ---------------- Bind (elementos estáticos do admin.html — ligado uma vez só) ----------------
// Estes elementos não são recriados a cada render (ao contrário da lista de domínios,
// por exemplo), então o bind roda uma única vez, aqui no topo do módulo — o script
// carrega depois de todo o HTML já estar no DOM (tag no fim do <body>).

for (const n of INST_PASSOS) {
  const head = $('#instStep' + n + 'Head');
  if (head) head.addEventListener('click', () => {
    _instPassoManual = true;
    instAbrirPasso(n);
    // O timer da confirmação segue a visibilidade do passo: abrir liga, sair desliga.
    if (n === 4 && state.project) { instAtualizarProgresso(state.project); }
    else { instPararAtualizacao(); }
  });
}

const _instRadioGtm = $('#instMetodoGtm');
const _instRadioPropria = $('#instMetodoProprio');
if (_instRadioGtm) _instRadioGtm.addEventListener('change', () => instEscolherMetodo('gtm'));
if (_instRadioPropria) _instRadioPropria.addEventListener('change', () => instEscolherMetodo('proprio'));

const _instBtnVerificarAgora = $('#instBtnVerificarAgora');
if (_instBtnVerificarAgora) {
  _instBtnVerificarAgora.addEventListener('click', () => { if (state.project) instAtualizarProgresso(state.project); });
}

// Trocar de aba ou de projeto encerra a atualização: o timer nunca sobrevive ao
// contexto que o justificava.
document.addEventListener('visibilitychange', () => { if (document.hidden) instPararAtualizacao(); });
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const tab = e.target.closest && e.target.closest('button.tab');
    if (tab && tab.dataset.tab !== 'setup') instPararAtualizacao();
  }, true);
}

const _instBtnCopyTagUnica = $('#btnCopyTagUnica');
if (_instBtnCopyTagUnica) {
  _instBtnCopyTagUnica.addEventListener('click', () => copyText($('#instTagUnicaBox').textContent, 'Código da tag única copiado. Cole no <head> do site.'));
}

const _instBtnCopyExemploPurchase = $('#btnCopyExemploPurchase');
if (_instBtnCopyExemploPurchase) {
  _instBtnCopyExemploPurchase.addEventListener('click', () => copyText($('#instExemploPurchase').textContent, 'Exemplo de purchase copiado.'));
}

const _instBtnCopyExemploLead = $('#btnCopyExemploLead');
if (_instBtnCopyExemploLead) {
  _instBtnCopyExemploLead.addEventListener('click', () => copyText($('#instExemploLead').textContent, 'Exemplo de lead copiado.'));
}

const _instBtnCopyExemploConfig = $('#btnCopyExemploConfig');
if (_instBtnCopyExemploConfig) {
  _instBtnCopyExemploConfig.addEventListener('click', () => copyText($('#instExemploConfig').textContent, 'Exemplo de configuração copiado.'));
}
