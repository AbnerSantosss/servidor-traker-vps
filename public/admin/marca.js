// Marca da empresa: logo e cor de cada projeto, na barra lateral, no cabeçalho e no modal.
// Parte do painel admin — carregado por admin.html na ordem definida lá.
//
// Por que a marca existe: com vários clientes no mesmo painel, "de qual empresa é esta
// tela?" é a pergunta que o operador se faz o dia inteiro. Nome em texto responde depois
// da leitura; um logotipo responde antes dela. Por isso a marca é dado do projeto (uma
// coluna em `projects`, migração 009), não preferência de quem está logado.
'use strict';

// ════════════════════════════════════════════════════════════════════
// ESTADO PRÓPRIO — nunca em `state` (nucleo.js), pelo mesmo critério de
// configuracoes.js: é dado deste módulo, não do projeto selecionado.
// ════════════════════════════════════════════════════════════════════

let _marcas = new Map();      // projectId -> { id, name, logo, cor }
let _marcaCarregando = null;  // promessa em voo, para a lista não pedir duas vezes
let _marcaModalEl = null;
let _marcaProjetoEdicao = null;
let _marcaLogoPendente;       // undefined = sem mudança | null = remover | string = nova
let _marcaCorPendente;        // idem

const MARCA_LADO = 128;                  // o painel exibe em 24×24: 128 cobre telas 2×/3×
// O servidor recusa acima de 200 KB (src/db/repos/projects.js). O navegador mira mais
// baixo de propósito: o parser de corpo montado na raiz do app (ingest/router.js, 256 KB)
// corta qualquer JSON maior que isso ANTES da rota, e uma imagem de 200 KB vira ~267 KB
// em base64 — o operador receberia um 413 sem mensagem em vez do erro explicado. Com o
// alvo em 180 KB, o corpo cabe sempre. Na prática nem chega perto: 128×128 dá ~30 KB.
const MARCA_MAX_BYTES = 180 * 1024;

// Presets do seletor. São DADO (opções oferecidas ao operador), não estilo — por isso
// vivem aqui e não no CSS, onde a regra do projeto é "nenhuma cor fora dos tokens".
// A primeira é o índigo da paleta de ação; as demais cobrem as famílias usuais de marca.
const MARCA_PRESETS = [
  '#4F46E5', '#0EA5E9', '#14B8A6', '#15803D',
  '#F59E0B', '#DC2626', '#EC4899', '#8B5CF6',
  '#0F172A', '#64748B',
];

// ════════════════════════════════════════════════════════════════════
// LEITURA
// ════════════════════════════════════════════════════════════════════

function marcaDe(projectId) {
  return _marcas.get(String(projectId)) || {};
}

/**
 * Busca a marca de todos os projetos de uma vez. A barra lateral desenha N itens; sem
 * esta chamada única seriam N requisições só para montar um menu.
 */
async function marcaCarregar() {
  if (_marcaCarregando) return _marcaCarregando;
  _marcaCarregando = (async () => {
    try {
      const lista = await api('/marcas');
      _marcas = new Map((lista || []).map((m) => [String(m.id), m]));
    } catch {
      // Sessão ainda não pronta no boot, ou rede fora: a interface cai no fallback de
      // iniciais, que já é uma identidade válida. Nada aqui pode impedir o painel de abrir.
    } finally {
      _marcaCarregando = null;
    }
    return _marcas;
  })();
  return _marcaCarregando;
}

// Iniciais para quem não tem logo — duas letras, como no avatar do usuário
// (cfgIniciais em configuracoes.js). Um quadrado vazio não identifica nada.
function marcaIniciais(nome) {
  const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

/**
 * Cor estável para projeto que ainda não escolheu a sua: derivada do nome, sempre a
 * mesma para o mesmo nome. Sorteio aleatório seria pior que cinza — a cor mudaria a cada
 * recarga e deixaria de servir para reconhecer o projeto de relance.
 */
function marcaCorDerivada(nome) {
  let h = 0;
  const texto = String(nome || '');
  for (let i = 0; i < texto.length; i++) h = (h * 31 + texto.charCodeAt(i)) >>> 0;
  return MARCA_PRESETS[h % MARCA_PRESETS.length];
}

// Luminância relativa (WCAG) para decidir se o texto das iniciais vai claro ou escuro.
// Sem isso, iniciais brancas sobre o âmbar do preset ficariam ilegíveis.
function marcaFundoEhClaro(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
  if (!m) return false;
  const canal = (v) => {
    const c = parseInt(v, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * canal(m[1]) + 0.7152 * canal(m[2]) + 0.0722 * canal(m[3]) > 0.45;
}

/**
 * Cria o elemento visual da marca de um projeto: <img class="projeto-logo"> quando há
 * logo, <span class="projeto-iniciais"> caso contrário. Os dois nomes de classe são os
 * definidos no app.css (F-V2) — este módulo só decide QUAL dos dois usar e com que dado.
 */
function marcaCriarChip(projeto) {
  const m = marcaDe(projeto.id);
  if (m.logo) {
    const img = document.createElement('img');
    img.className = 'projeto-logo';
    img.src = m.logo;      // data-URI: `img-src 'self' data:` já permite (seguranca.js)
    img.alt = '';          // decorativo: o nome do projeto está ao lado, em texto
    return img;
  }
  const span = document.createElement('span');
  span.className = 'projeto-iniciais';
  span.textContent = marcaIniciais(projeto.name || m.name);
  const cor = m.cor || marcaCorDerivada(projeto.name || m.name || projeto.id);
  span.style.backgroundColor = cor;
  span.classList.toggle('is-fundo-claro', marcaFundoEhClaro(cor));
  return span;
}

/**
 * Põe (ou atualiza) o chip dentro de um contêiner.
 *
 * Procura primeiro um chip que já exista — a casca da barra lateral pode já desenhar o
 * slot da marca por conta própria, e nesse caso este módulo só troca o conteúdo em vez
 * de acrescentar um segundo. Só quando não há slot algum é que criamos um, e aí o
 * contêiner ganha a classe `marca-hospeda`, que é o único gancho de layout de
 * marca.css: assim a folha nova nunca disputa layout com o app.css.
 */
function marcaAplicarChip(container, projeto) {
  if (!container || !projeto) return;
  const novo = marcaCriarChip(projeto);
  const atual = container.querySelector(':scope > .projeto-logo, :scope > .projeto-iniciais');
  if (atual) {
    novo.dataset.marcaChip = atual.dataset.marcaChip || '';
    atual.replaceWith(novo);
    return;
  }
  novo.dataset.marcaChip = '1';
  container.classList.add('marca-hospeda');
  container.insertBefore(novo, container.firstChild);
}

// ════════════════════════════════════════════════════════════════════
// BARRA LATERAL
// ════════════════════════════════════════════════════════════════════

/**
 * Decora os itens da lista de projetos. O casamento item↔projeto é por posição porque
 * `renderProjectList` (nucleo.js) itera `state.projects` na ordem — e nucleo.js é de
 * outro módulo, então este arquivo lê o DOM em vez de pedir uma mudança lá.
 */
function marcaDecorarLista() {
  const ul = document.getElementById('projectList');
  if (!ul) return;
  const itens = ul.querySelectorAll('li.project-item');
  itens.forEach((li, i) => {
    const p = (state.projects || [])[i];
    if (!p) return;
    li.dataset.marcaProjeto = p.id;
    marcaAplicarChip(li, p);
  });
}

/**
 * A lista é redesenhada por nucleo.js (a cada carga e a cada seleção). Em vez de exigir
 * uma chamada dentro daquela função — arquivo compartilhado, ponto de conflito perpétuo —
 * observamos o próprio <ul>.
 *
 * `subtree: false` é essencial: o chip é inserido DENTRO de um <li>, o que não é uma
 * mutação dos filhos diretos do <ul>. Com subtree o observador se reentraria em laço.
 */
function marcaObservarLista() {
  const ul = document.getElementById('projectList');
  if (!ul || ul.dataset.marcaObservado) return;
  ul.dataset.marcaObservado = '1';
  new MutationObserver(async () => {
    if (!_marcas.size) await marcaCarregar();
    marcaDecorarLista();
    // `state.projects` só existe depois desta renderização — é aqui que a seção de
    // Configurações deixa de dizer "nenhum projeto ainda".
    marcaRenderizarSecaoConfig();
  }).observe(ul, { childList: true });
}

// ════════════════════════════════════════════════════════════════════
// CABEÇALHO DO PROJETO — chip grande + atalho para o modal
// ════════════════════════════════════════════════════════════════════

function marcaAtualizarCabecalho(projeto) {
  const titulo = document.getElementById('pvTitle');
  if (!titulo || !projeto) return;

  let barra = document.getElementById('marcaCabecalho');
  if (!barra) {
    barra = document.createElement('div');
    barra.id = 'marcaCabecalho';
    barra.className = 'marca-cabecalho marca-hospeda';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost marca-cabecalho-btn';
    btn.id = 'marcaCabecalhoBtn';
    btn.textContent = 'Marca da empresa';
    btn.addEventListener('click', () => marcaAbrirModal(state.selectedId));
    barra.appendChild(btn);
    titulo.parentElement.insertBefore(barra, titulo);
  }
  marcaAplicarChip(barra, projeto);

  // Operador acompanha, não redefine a identidade do cliente (a API responde 403 de
  // qualquer forma — isto só evita oferecer um botão que não funcionaria).
  const btn = document.getElementById('marcaCabecalhoBtn');
  if (btn) btn.hidden = !isAdmin();
}

// ════════════════════════════════════════════════════════════════════
// SEÇÃO EM CONFIGURAÇÕES — a lista de projetos com a marca de cada um
// ════════════════════════════════════════════════════════════════════

/**
 * A view de Configurações é montada por configuracoes.js no DOMContentLoaded. Se ela
 * ainda não existir quando este módulo iniciar (ordem de scripts diferente, carga
 * adiada), esperamos o `#cfgPerfil` aparecer em vez de desistir em silêncio.
 */
function marcaObservarConfiguracoes() {
  const view = document.getElementById('viewConfiguracoes');
  if (!view || view.dataset.marcaObservado) return;
  view.dataset.marcaObservado = '1';
  const obs = new MutationObserver(() => {
    marcaMontarSecaoConfig();
    if (document.getElementById('marcaSecao')) obs.disconnect();
  });
  obs.observe(view, { childList: true });
}

function marcaMontarSecaoConfig() {
  const destino = document.getElementById('cfgPerfil') || document.getElementById('viewConfiguracoes');
  if (!destino || document.getElementById('marcaSecao')) return;

  const secao = document.createElement('section');
  secao.className = 'bloco marca-secao';
  secao.id = 'marcaSecao';
  secao.innerHTML = `
    <div class="bloco-h">
      <span class="bloco-k">Marca da empresa</span>
      <h3>Logo e cor de cada projeto</h3>
      <p>A logo aparece ao lado do nome do projeto na barra lateral e no cabeçalho. Sem logo, o painel desenha as iniciais sobre a cor escolhida — todo projeto tem identidade visual, mesmo sem imagem.</p>
    </div>
    <ul class="marca-lista" id="marcaLista"></ul>`;
  destino.appendChild(secao);
  marcaRenderizarSecaoConfig();
}

function marcaRenderizarSecaoConfig() {
  const ul = document.getElementById('marcaLista');
  if (!ul) return;
  ul.innerHTML = '';

  const projetos = state.projects || [];
  if (!projetos.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nenhum projeto ainda.';
    ul.appendChild(li);
    return;
  }

  for (const p of projetos) {
    const li = document.createElement('li');
    li.className = 'marca-lista-item marca-hospeda';

    const texto = document.createElement('span');
    texto.className = 'marca-lista-nome';
    texto.textContent = p.name;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost';
    btn.textContent = marcaDe(p.id).logo ? 'Trocar marca' : 'Definir marca';
    btn.disabled = !isAdmin();
    btn.addEventListener('click', () => marcaAbrirModal(p.id));

    li.append(texto, btn);
    marcaAplicarChip(li, p);
    ul.appendChild(li);
  }
}

// ════════════════════════════════════════════════════════════════════
// MODAL "MARCA DA EMPRESA"
// ════════════════════════════════════════════════════════════════════

function _marcaGarantirModal() {
  if (_marcaModalEl) return _marcaModalEl;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'marcaModalBackdrop';
  backdrop.innerHTML = `
    <div class="modal modal--marca" role="dialog" aria-modal="true" aria-labelledby="marcaModalTitulo">
      <h3 id="marcaModalTitulo">Marca da empresa</h3>
      <p class="desc" id="marcaModalProjeto"></p>

      <div class="marca-modal-topo">
        <div class="marca-preview marca-hospeda" id="marcaPreview"></div>
        <div class="marca-modal-acoes">
          <div class="marca-modal-botoes">
            <label class="btn btn-ghost" for="marcaArquivo">Escolher logo</label>
            <input type="file" id="marcaArquivo" accept="image/png,image/jpeg,image/webp" hidden />
            <button class="btn btn-ghost" type="button" id="marcaRemover" hidden>Remover logo</button>
          </div>
          <p class="desc" id="marcaInfo"></p>
        </div>
      </div>

      <div class="field">
        <label>Cor da empresa</label>
        <div class="marca-cores" id="marcaCores" role="group" aria-label="Cores sugeridas"></div>
        <div class="marca-cor-livre">
          <input type="color" id="marcaCorSeletor" aria-label="Escolher cor livre" />
          <input type="text" id="marcaCorHex" spellcheck="false" maxlength="7" aria-label="Cor em hexadecimal" placeholder="#4F46E5" />
          <button class="btn btn-ghost" type="button" id="marcaCorLimpar">Sem cor definida</button>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" type="button" id="marcaSalvar">Salvar marca</button>
        <button class="btn btn-ghost" type="button" id="marcaCancelar">Cancelar</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  // Presets: a cor de cada botão é dado do JS (MARCA_PRESETS), aplicada por style —
  // é o que mantém marca.css sem uma única cor fora dos tokens.
  const cores = backdrop.querySelector('#marcaCores');
  for (const cor of MARCA_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'marca-cor-preset';
    b.dataset.marcaCor = cor;
    b.style.backgroundColor = cor;
    b.title = cor;
    b.setAttribute('aria-label', `Usar a cor ${cor}`);
    b.addEventListener('click', () => marcaDefinirCor(cor));
    cores.appendChild(b);
  }

  backdrop.querySelector('#marcaArquivo').addEventListener('change', marcaAoEscolherArquivo);
  backdrop.querySelector('#marcaRemover').addEventListener('click', marcaRemoverLogo);
  backdrop.querySelector('#marcaSalvar').addEventListener('click', marcaSalvar);
  backdrop.querySelector('#marcaCancelar').addEventListener('click', marcaFecharModal);
  backdrop.querySelector('#marcaCorSeletor').addEventListener('input', (e) => marcaDefinirCor(e.target.value));
  backdrop.querySelector('#marcaCorHex').addEventListener('change', (e) => marcaDefinirCor(e.target.value));
  backdrop.querySelector('#marcaCorLimpar').addEventListener('click', () => marcaDefinirCor(''));
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) marcaFecharModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _marcaModalEl && _marcaModalEl.classList.contains('open')) marcaFecharModal();
  });

  _marcaModalEl = backdrop;
  return backdrop;
}

function marcaProjetoPorId(id) {
  return (state.projects || []).find((p) => String(p.id) === String(id))
    || { id, name: marcaDe(id).name || '' };
}

async function marcaAbrirModal(projectId) {
  if (!projectId) { toast('Selecione um projeto primeiro.', 'warn'); return; }
  const backdrop = _marcaGarantirModal();
  _marcaProjetoEdicao = String(projectId);
  _marcaLogoPendente = undefined;
  _marcaCorPendente = undefined;

  if (!_marcas.size) await marcaCarregar();
  const projeto = marcaProjetoPorId(projectId);
  const m = marcaDe(projectId);

  document.getElementById('marcaModalProjeto').textContent = projeto.name || projectId;
  document.getElementById('marcaRemover').hidden = !m.logo;
  document.getElementById('marcaInfo').textContent =
    'PNG, JPEG ou WEBP. A imagem é reduzida para 128×128 no seu navegador antes de subir (o servidor recusa acima de 200 KB). SVG não é aceito: pode carregar script embutido.';
  marcaAtualizarPreview();
  marcaRefletirCor(m.cor || '');
  backdrop.classList.add('open');
  document.getElementById('marcaSalvar').focus();
}

function marcaFecharModal() {
  if (_marcaModalEl) _marcaModalEl.classList.remove('open');
  _marcaProjetoEdicao = null;
  _marcaLogoPendente = undefined;
  _marcaCorPendente = undefined;
}

/** Desenha o preview com o estado PENDENTE por cima do salvo, sem tocar no `_marcas`. */
function marcaAtualizarPreview() {
  const caixa = document.getElementById('marcaPreview');
  if (!caixa || !_marcaProjetoEdicao) return;
  const projeto = marcaProjetoPorId(_marcaProjetoEdicao);
  const salvo = marcaDe(_marcaProjetoEdicao);
  const logo = _marcaLogoPendente !== undefined ? _marcaLogoPendente : salvo.logo;
  const cor = (_marcaCorPendente !== undefined ? _marcaCorPendente : salvo.cor) || marcaCorDerivada(projeto.name);

  caixa.innerHTML = '';
  if (logo) {
    const img = document.createElement('img');
    img.className = 'projeto-logo';
    img.src = logo;
    img.alt = '';
    caixa.appendChild(img);
  } else {
    const span = document.createElement('span');
    span.className = 'projeto-iniciais';
    span.textContent = marcaIniciais(projeto.name);
    span.style.backgroundColor = cor;
    span.classList.toggle('is-fundo-claro', marcaFundoEhClaro(cor));
    caixa.appendChild(span);
  }
}

function marcaDefinirCor(valor) {
  const limpo = String(valor || '').trim();
  if (limpo && !/^#[0-9a-fA-F]{6}$/.test(limpo)) {
    toast('A cor precisa estar no formato #RRGGBB.', 'warn');
    return;
  }
  _marcaCorPendente = limpo ? limpo.toUpperCase() : null;
  marcaRefletirCor(_marcaCorPendente || '');
  marcaAtualizarPreview();
}

function marcaRefletirCor(cor) {
  const hex = document.getElementById('marcaCorHex');
  const seletor = document.getElementById('marcaCorSeletor');
  if (hex) hex.value = cor || '';
  if (seletor && cor) seletor.value = cor.toLowerCase();
  document.querySelectorAll('.marca-cor-preset').forEach((b) => {
    b.classList.toggle('is-ativa', b.dataset.marcaCor.toUpperCase() === String(cor).toUpperCase());
    b.setAttribute('aria-pressed', b.classList.contains('is-ativa') ? 'true' : 'false');
  });
}

// ---------------- upload: leitura, redimensionamento e compressão no navegador ----------------

// FileReader.readAsDataURL, NUNCA URL.createObjectURL: a CSP do painel é
// `img-src 'self' data:` (src/admin/seguranca.js), sem `blob:` na lista. Uma <img>
// apontando para blob: é bloqueada em silêncio — só dispara onerror, sem mensagem no
// console que aponte a causa. A lição já custou uma depuração longa no fluxo do avatar.
function marcaLerImagem(file) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('não foi possível ler a imagem escolhida'));
      img.src = leitor.result;
    };
    leitor.onerror = () => reject(new Error('não foi possível ler o arquivo escolhido'));
    leitor.readAsDataURL(file);
  });
}

function marcaTelaParaBlob(tela, tipo, qualidade) {
  return new Promise((resolve) => tela.toBlob(resolve, tipo, qualidade));
}

function marcaBlobParaDataUri(blob) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.onerror = () => reject(new Error('falha ao converter a imagem processada'));
    leitor.readAsDataURL(blob);
  });
}

/**
 * Encaixa a imagem inteira numa tela de 128×128 preservando a proporção (e centralizando
 * o que sobra). Logotipo é quase sempre horizontal: um recorte quadrado central — que é
 * o certo para foto de rosto, e é o que o avatar faz — cortaria justamente as pontas do
 * logotipo. O quadrado transparente ao redor é o preço de manter a marca inteira.
 *
 * PNG primeiro, porque preserva transparência; WEBP com qualidade decrescente só se o
 * PNG estourar o teto do servidor (raro em 128×128, mas o cliente não pode contar com isso).
 */
async function marcaProcessarImagem(file) {
  const img = await marcaLerImagem(file);
  const tela = document.createElement('canvas');
  tela.width = MARCA_LADO;
  tela.height = MARCA_LADO;
  const ctx = tela.getContext('2d');
  const escala = Math.min(MARCA_LADO / img.naturalWidth, MARCA_LADO / img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * escala));
  const h = Math.max(1, Math.round(img.naturalHeight * escala));
  ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight,
    Math.floor((MARCA_LADO - w) / 2), Math.floor((MARCA_LADO - h) / 2), w, h);

  let blob = await marcaTelaParaBlob(tela, 'image/png');
  let qualidade = 0.92;
  while (blob && blob.size > MARCA_MAX_BYTES && qualidade > 0.35) {
    blob = await marcaTelaParaBlob(tela, 'image/webp', qualidade);
    qualidade -= 0.15;
  }
  if (!blob || blob.size > MARCA_MAX_BYTES) {
    throw new Error(`não foi possível comprimir a logo abaixo de ${MARCA_MAX_BYTES / 1024} KB — tente uma imagem mais simples`);
  }
  return { dataUri: await marcaBlobParaDataUri(blob), tamanho: blob.size };
}

async function marcaAoEscolherArquivo(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const info = document.getElementById('marcaInfo');
  const original = info.textContent;
  info.textContent = 'Processando imagem…';
  try {
    const { dataUri, tamanho } = await marcaProcessarImagem(file);
    _marcaLogoPendente = dataUri;
    document.getElementById('marcaRemover').hidden = false;
    marcaAtualizarPreview();
    info.textContent = `Pronta para salvar — ${Math.ceil(tamanho / 1024)} KB depois de reduzida para ${MARCA_LADO}×${MARCA_LADO}.`;
  } catch (err) {
    toast('Erro ao processar a logo: ' + err.message, 'err');
    info.textContent = original;
  } finally {
    e.target.value = ''; // permite reescolher o mesmo arquivo depois de um erro
  }
}

function marcaRemoverLogo() {
  _marcaLogoPendente = null;
  document.getElementById('marcaRemover').hidden = true;
  document.getElementById('marcaInfo').textContent = 'A logo será removida ao salvar — o projeto volta a mostrar as iniciais sobre a cor.';
  marcaAtualizarPreview();
}

async function marcaSalvar() {
  if (!_marcaProjetoEdicao) return;
  const btn = document.getElementById('marcaSalvar');
  btn.disabled = true;

  // Só o que mudou viaja: campo ausente significa "mantenha o atual" no servidor
  // (mesmo contrato do perfil), então enviar tudo sempre seria reescrever à toa.
  const body = {};
  if (_marcaLogoPendente !== undefined) body.logo = _marcaLogoPendente;
  if (_marcaCorPendente !== undefined) body.cor = _marcaCorPendente;
  if (!Object.keys(body).length) { marcaFecharModal(); return; }

  try {
    const salva = await api('/projects/' + _marcaProjetoEdicao + '/marca', { method: 'PUT', body });
    _marcas.set(String(salva.id), salva);
    marcaFecharModal();
    marcaDecorarLista();
    marcaRenderizarSecaoConfig();
    if (state.project) marcaAtualizarCabecalho(state.project);
    toast('Marca atualizada.', 'ok');
  } catch (err) {
    toast('Erro ao salvar a marca: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ════════════════════════════════════════════════════════════════════
// BOOT — só pelos pontos de extensão de navegacao.js e por observação do DOM.
// Nenhum outro módulo precisa saber que este existe.
// ════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  // O gancho vem de navegacao.js. A checagem não é paranoia decorativa: uma exceção
  // aqui, no corpo do arquivo, abortaria o resto do boot deste módulo e a marca sumiria
  // do painel inteiro por causa de um nome trocado em outro arquivo.
  if (typeof registrarAoTrocarProjeto === 'function') registrarAoTrocarProjeto(marcaAtualizarCabecalho);
  else console.error('[painel] marca: registrarAoTrocarProjeto indisponível — o cabeçalho não vai atualizar');

  marcaObservarLista();
  marcaMontarSecaoConfig();
  marcaObservarConfiguracoes();
  await marcaCarregar();
  marcaDecorarLista();
  marcaRenderizarSecaoConfig();
});
