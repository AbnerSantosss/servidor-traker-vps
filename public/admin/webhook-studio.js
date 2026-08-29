// Aba Meta → sub-aba "Webhooks" (F4/F5): Webhook Studio.
// Inbox de amostras de payload não reconhecido, editor de mapeamento em 3 colunas
// (árvore clicável / regras + evento + detecção / prévia ao vivo) e o modo assistido
// por IA via OpenRouter. A tela é um EDITOR da DSL declarativa de
// src/ingest/mapeamento.js — leia esse arquivo antes de mexer aqui; cada conceito da
// UI (regra, transformação, bloco evento, detecção) tem um espelho exato lá.
// Parte do painel admin — carregado por admin.html na ordem definida lá.
'use strict';

// ════════════════════════════════════════════════════════════════════
// Constantes: espelham a lista FECHADA de transformações da DSL (mapeamento.js,
// TRANSFORMACOES) e um catálogo de sugestões de caminho canônico. O servidor
// continua sendo a autoridade — isto aqui é só rótulo de <select>/<datalist>.
// ════════════════════════════════════════════════════════════════════

const STUDIO_TRANSFORMACOES = [
  { valor: 'texto', rotulo: 'Texto (copia como veio)' },
  { valor: 'numero', rotulo: 'Número' },
  { valor: 'centavos_para_reais', rotulo: 'Centavos → reais' },
  { valor: 'separar_nome', rotulo: 'Nome completo → primeiro/sobrenome' },
  { valor: 'unix_de_iso', rotulo: 'Data ISO → timestamp Unix' },
  { valor: 'booleano', rotulo: 'Booleano (sim/não, true/false, 1/0)' },
  { valor: 'constante', rotulo: 'Valor fixo (constante)' },
  { valor: 'mapear_valores', rotulo: 'Dicionário de valores' },
  { valor: 'primeiro_preenchido', rotulo: 'Primeiro caminho preenchido' },
  { valor: 'ip_publico', rotulo: 'IP público (descarta IP privado)' },
  { valor: 'minusculo', rotulo: 'Minúsculo' },
  { valor: 'apenas_digitos', rotulo: 'Apenas dígitos' },
  { valor: 'ga_client_id', rotulo: 'Client ID do GA (extrai do cookie _ga)' },
  { valor: 'marcador_presenca', rotulo: 'Marcador de presença (valor fixo se não vazio)' },
  { valor: 'contagem', rotulo: 'Contagem de itens de uma lista' },
];
// "de" não é um caminho simples único nestas: 'constante' não lê nada da amostra,
// 'primeiro_preenchido' lê uma LISTA de caminhos (ver valorDaRegra em mapeamento.js).
const STUDIO_TRANSF_SEM_DE = new Set(['constante']);
const STUDIO_TRANSF_MULTI_DE = new Set(['primeiro_preenchido']);

// Caminhos canônicos mais comuns do Evento Interno (espelha adaptadores.js,
// checkoutAdapter.adaptar) — só preenche o <datalist> de "para"; qualquer caminho é
// aceito, quem valida de verdade é o servidor.
const STUDIO_CAMPOS_CANONICOS = [
  'user_data.email', 'user_data.phone', 'user_data.first_name', 'user_data.last_name',
  'user_data.external_id', 'user_data.fbp', 'user_data.fbc', 'user_data.fbclid',
  'user_data.gclid', 'user_data.gbraid', 'user_data.wbraid', 'user_data.ga_client_id',
  'user_data.utm_source', 'user_data.utm_medium', 'user_data.utm_campaign',
  'user_data.utm_content', 'user_data.utm_term',
  'user_data.client_ip_address', 'user_data.client_user_agent',
  'custom_data.value', 'custom_data.currency', 'custom_data.order_id',
  'custom_data.content_ids', 'custom_data.content_type', 'custom_data.num_items',
  'custom_data.payment_method',
  'event_id', 'event_time', 'event_source_url', 'user_id', 'action_source',
];

const STUDIO_MODO_LABEL = {
  nativo: 'normal', sombra: 'sombra (24h, observando)', ia_por_evento: 'IA por evento',
};

// ---------------- estado do módulo ----------------
// Ao contrário da tabela de mapeamento da Meta (meta.js), aqui o DOM das regras é a
// fonte da verdade (mesmo princípio de renderMapaMeta/lerMapaMeta) — reconstruir tudo
// a cada tecla derrubaria o foco do campo que a pessoa está editando. `studio` guarda
// só o que não vive no DOM: listas buscadas da API, qual amostra alimenta a árvore e
// a prévia, e o último resultado de validação (trava o botão Salvar).
let studio = {
  amostras: [],          // grupos de GET /webhooks/amostras
  adaptadores: [],        // GET /adaptadores
  edicao: null,           // { id, criadoVia } do adaptador em edição; null = editor fechado
  amostraAtual: null,     // { origem:'capturada'|'manual', amostraId, corpo, rotulo }
  metodo: 'nativo',       // método de RASCUNHO no editor: 'nativo' | 'ia' (não é o campo "modo" salvo)
  ultimoModoValido: 'nativo', // último valor aceito do <select> Modo, para reverter se o consentimento for recusado
  alvoInput: null,        // último <input>/<textarea> .studio-caminho focado — onde a árvore escreve
  previewTimer: null,
  ultimaPreview: null,    // último { validacao, deteccaoBateu, ... } de POST /adaptadores/preview
  iaModelos: [],          // cache local do último GET /ia/modelos (nome+id, para resolver o <input list>)
  iaUltimo: null,         // último resultado de POST /ia/mapear (para o selo "gerado por IA")
  iaConsentiuPorEvento: false, // aceite do modal do modo "IA por evento" — vale para a sessão da página
};

// Reage à troca de projeto mesmo com a sub-aba Webhooks fechada: um editor aberto com
// a amostra/adaptador do projeto ANTERIOR não pode sobreviver à troca — fecha e limpa
// os caches; a próxima abertura da aba (studioMontar, chamado por meta.js) busca tudo
// de novo para o projeto atual.
registrarAoTrocarProjeto(() => {
  studioFecharEditor();
  studio.amostras = [];
  studio.adaptadores = [];
  studio.iaModelos = [];
  studio.iaUltimo = null;
});

// ════════════════════════════════════════════════════════════════════
// MONTAGEM — chamada por meta.js quando a sub-aba "Webhooks" é aberta
// ════════════════════════════════════════════════════════════════════

function studioMontar() {
  const raiz = $('#metaWebhooks');
  if (!raiz) return;
  if (!raiz.dataset.studioMontado) {
    raiz.dataset.studioMontado = '1';
    raiz.innerHTML = studioEsqueletoHtml();
    aplicarIcones(raiz);
    $('#studioAtualizarInbox', raiz).addEventListener('click', studioCarregarInbox);
    $('#studioNovoAdaptador', raiz).addEventListener('click', () => studioAbrirEditor({}));
  }
  studioCarregarInbox();
  studioCarregarAdaptadores();
  studioAtualizarPapel();
}

function studioEsqueletoHtml() {
  return `
    <div class="studio-secao">
      <p class="studio-secao-d">
        Quando chega um webhook num formato que nenhum adaptador reconhece, ele fica registrado
        aqui como <b>amostra</b> — sem virar evento, sem ir para nenhum destino — até alguém
        estruturar esse formato. Depois de estruturado e salvo, o próximo webhook nesse formato
        já sai traduzido para o evento canônico, sem precisar de outra intervenção manual.
      </p>
    </div>

    <div class="studio-secao">
      <div class="studio-secao-h">
        <h4>Amostras não reconhecidas <button type="button" class="ajuda" data-ajuda="studio-amostra-webhook"></button></h4>
        <button type="button" class="btn btn-ghost" id="studioAtualizarInbox"><i data-lucide="refresh-cw" aria-hidden="true"></i> Atualizar</button>
      </div>
      <div id="studioInboxLista">${studioSkeletonTabela(3)}</div>
    </div>

    <div class="studio-secao">
      <div class="studio-secao-h">
        <h4>Adaptadores deste projeto</h4>
        <button type="button" class="btn btn-primary" id="studioNovoAdaptador"><i data-lucide="plus" aria-hidden="true"></i> Novo mapeamento manual</button>
      </div>
      <div id="studioAdaptadoresLista">${studioSkeletonTabela(2)}</div>
    </div>

    <div class="studio-secao" id="studioEditorWrap" hidden>
      <div id="studioEditor"></div>
    </div>`;
}

function studioAtualizarPapel() {
  const admin = isAdmin();

  // Rodapé do editor (nome/ativo/modo/salvar): operador pode digitar para explorar,
  // mas o servidor recusa a escrita mesmo assim (I-10) — desabilitar aqui só evita a
  // viagem em vão e deixa claro na tela, sem esconder o que já está preenchido.
  const footer = $('.studio-editor-footer');
  if (footer) {
    footer.classList.toggle('form-readonly', !admin);
    $$('input, select, button', footer).forEach((el) => { if (el.id !== 'studioCancelar') el.disabled = !admin; });
  }
  const nota = $('.js-studio-readonly-nota');
  if (nota) nota.hidden = admin;

  // IA é proibida por completo para operador: credencial paga de terceiro + resultado
  // que muda o significado do dado de conversão (I-10, I-7) — o botão nem aparece.
  const metodoIaBtn = $('#studioMetodoSwitch .modo[data-metodo="ia"]');
  if (metodoIaBtn) metodoIaBtn.hidden = !admin;
  if (!admin && studio.metodo === 'ia') studioEscolherMetodo('nativo');

  // Excluir adaptador é escrita — some da lista para quem não pode chamar o endpoint.
  $$('[data-studio-excluir]').forEach((b) => { b.hidden = !admin; });

  studioAtualizarBotaoSalvar();
}

// ════════════════════════════════════════════════════════════════════
// INBOX — amostras agrupadas por formato (GET /webhooks/amostras)
// ════════════════════════════════════════════════════════════════════

// Enquanto o dado não chega, a área já ocupa a altura que vai ocupar: sem isso a tela
// pisca do vazio para o cheio e tudo salta de lugar quando a resposta volta.
function studioSkeletonTabela(linhas = 3) {
  return `<div class="table-wrap">${
    Array.from({ length: linhas }, () => '<div class="skeleton skeleton-linha"></div>').join('')
  }</div>`;
}

// Realce de sintaxe para tema CLARO. O anterior era um tom só de dourado, pensado para
// fundo preto; em papel branco virava borrão. Aqui cada tipo tem a sua cor semântica —
// chave, texto, número, booleano, nulo — nas mesmas classes que o `.codebox` de app.css
// já usava. Escapa token a token (nunca a string inteira depois de montar o HTML).
function studioJsonHtml(valor) {
  let txt;
  try { txt = JSON.stringify(valor, null, 2); } catch { txt = String(valor); }
  if (txt === undefined) txt = 'undefined';

  let out = '';
  let i = 0;
  while (i < txt.length) {
    const c = txt[i];

    if (c === '"') {
      let j = i + 1;
      while (j < txt.length) {
        if (txt[j] === '\\') { j += 2; continue; }
        if (txt[j] === '"') break;
        j++;
      }
      const bruto = txt.slice(i, Math.min(j + 1, txt.length));
      // Chave x valor: só é chave se o próximo caractere não-branco for ":".
      let k = j + 1;
      while (k < txt.length && (txt[k] === ' ' || txt[k] === '\n')) k++;
      out += `<span class="${txt[k] === ':' ? 'c-key' : 'c-str'}">${escHtml(bruto)}</span>`;
      i = j + 1;
      continue;
    }

    if ((c === '-' || (c >= '0' && c <= '9')) && /[\s:[,]/.test(txt[i - 1] || ' ')) {
      let j = i + 1;
      while (j < txt.length && /[\d.eE+-]/.test(txt[j])) j++;
      out += `<span class="c-num">${escHtml(txt.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    const literal = ['true', 'false', 'null'].find((lit) => txt.startsWith(lit, i));
    if (literal) {
      out += `<span class="${literal === 'null' ? 'c-null' : 'c-bool'}">${literal}</span>`;
      i += literal.length;
      continue;
    }

    // Pontuação (chaves, colchetes, vírgulas, indentação) sai num bloco só: um <span>
    // por caractere multiplicaria por dez o tamanho do HTML de um payload grande.
    let j = i;
    while (j < txt.length && !'"-tfn'.includes(txt[j]) && !(txt[j] >= '0' && txt[j] <= '9')) j++;
    if (j === i) j = i + 1;
    out += `<span class="c-pon">${escHtml(txt.slice(i, j))}</span>`;
    i = j;
  }
  return out;
}

async function studioCarregarInbox() {
  const el = $('#studioInboxLista');
  const pid = state.selectedId;
  if (!el || !pid) return;
  el.innerHTML = studioSkeletonTabela(3);
  try {
    studio.amostras = await api(`/projects/${pid}/webhooks/amostras`);
  } catch (err) {
    el.innerHTML = `<div class="estado-vazio">
      <div class="estado-vazio-icone"><i data-lucide="circle-x" aria-hidden="true"></i></div>
      <h4>Não foi possível ler as amostras</h4>
      <p></p>
      <button type="button" class="btn" data-studio-retentar="inbox"><i data-lucide="refresh-cw" aria-hidden="true"></i> Tentar de novo</button>
    </div>`;
    el.querySelector('p').textContent = err.message;
    aplicarIcones(el);
    const retentar = el.querySelector('[data-studio-retentar]');
    if (retentar) retentar.addEventListener('click', studioCarregarInbox);
    return;
  }
  if (state.selectedId !== pid) return; // projeto trocou enquanto a busca corria
  studioRenderInbox(el);
}

function studioRenderInbox(el) {
  if (!studio.amostras.length) {
    const urlEvento = (state.project && state.project.urls && state.project.urls.evento) || '.../e/<slug>';
    // Estado vazio com uma saída, não um "nenhum dado" seco: aqui o vazio é normal
    // (nada quebrou), e o que o operador precisa é do comando que produz uma amostra.
    el.innerHTML = `
      <div class="estado-vazio">
        <div class="estado-vazio-icone"><i data-lucide="inbox" aria-hidden="true"></i></div>
        <h4>Nenhuma amostra por enquanto</h4>
        <p>
          Uma amostra aparece sozinha quando chega um webhook cujo formato nenhum adaptador
          reconhece — o corpo fica guardado, com dados pessoais mascarados, até alguém
          estruturar esse formato.
        </p>
        <button type="button" class="btn" data-studio-retentar="inbox"><i data-lucide="refresh-cw" aria-hidden="true"></i> Procurar de novo</button>
        <details style="margin-top:14px;max-width:74ch;width:100%">
          <summary style="cursor:pointer;font-size:.82rem">Como gerar uma amostra de teste</summary>
          <pre class="codebox" style="margin-top:8px;text-align:left"></pre>
        </details>
      </div>`;
    el.querySelector('.codebox').textContent =
      `curl -X POST ${urlEvento} \\\n  -H "Authorization: Bearer <token do projeto>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"qualquer":"coisa"}'`;
    aplicarIcones(el);
    const retentar = el.querySelector('[data-studio-retentar]');
    if (retentar) retentar.addEventListener('click', studioCarregarInbox);
    return;
  }

  // Tabela no padrão global do painel (cabeçalho em rótulo, zebra, contagem à direita
  // com `.num`): amostra de webhook é inventário, e inventário se compara linha a linha.
  // O payload continua a um clique, numa linha de detalhe logo abaixo da amostra.
  el.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Formato detectado</th>
            <th class="num">Webhooks</th>
            <th>Primeira</th>
            <th>Última</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${studio.amostras.map(studioGrupoHtml).join('')}</tbody>
      </table>
    </div>`;
  aplicarIcones(el);
  studio.amostras.forEach((g, i) => studioWireGrupo(el, g, i));
}

function studioGrupoHtml(g, idx) {
  const gid = `studioGrupo${idx}`;
  const rep = g.amostra_representativa || {};
  return `
    <tr id="${gid}">
      <td><span class="studio-inbox-formato">${escHtml(rep.formato_detectado || 'formato desconhecido')}</span></td>
      <td class="num">${fmtNumBR(g.quantidade)}</td>
      <td>${escHtml(fmtDate(g.primeira_em))}</td>
      <td>${escHtml(fmtDate(g.ultima_em))}</td>
      <td>
        <div class="studio-inbox-acoes-col">
          <button type="button" class="btn btn-ghost" data-studio-ver="${gid}" aria-expanded="false"><i data-lucide="eye" aria-hidden="true"></i> Payload</button>
          <button type="button" class="btn btn-primary" data-studio-estruturar="${gid}">Estruturar</button>
          <button type="button" class="btn btn-ghost" data-studio-descartar="${gid}">Descartar</button>
        </div>
      </td>
    </tr>
    <tr class="studio-inbox-detalhe" id="${gid}Detalhe" hidden>
      <td colspan="5">
        <div class="studio-inbox-detalhe-corpo">
          <pre class="json-view studio-json studio-inbox-amostra-json">${studioJsonHtml(rep.body_mascarado || {})}</pre>
          <div class="studio-inbox-acoes"></div>
        </div>
      </td>
    </tr>`;
}

function studioWireGrupo(container, g, idx) {
  const gid = `studioGrupo${idx}`;
  const btnV = container.querySelector(`[data-studio-ver="${gid}"]`);
  if (btnV) {
    btnV.addEventListener('click', () => {
      const detalhe = container.querySelector(`#${gid}Detalhe`);
      if (!detalhe) return;
      detalhe.hidden = !detalhe.hidden;
      btnV.setAttribute('aria-expanded', detalhe.hidden ? 'false' : 'true');
    });
  }
  const btnE = container.querySelector(`[data-studio-estruturar="${gid}"]`);
  if (btnE) btnE.addEventListener('click', () => studioAbrirEditor({ hash: g.hash_estrutura }));
  const btnD = container.querySelector(`[data-studio-descartar="${gid}"]`);
  if (btnD) btnD.addEventListener('click', () => studioDescartarAmostra(g, container, gid));
}

// Descarta só a amostra REPRESENTATIVA do grupo (a que a tela mostra) — não existe
// endpoint para apagar um grupo inteiro de uma vez, e fingir que apagou "todas" seria
// a mesma desonestidade que este projeto evita em outros lugares (ver falhasAbrirPayload).
// A confirmação abre na linha de detalhe: junto do payload que vai sumir, não solta no
// meio da tabela.
function studioDescartarAmostra(grupo, container, gid) {
  const rep = grupo.amostra_representativa || {};
  if (!rep.id) return;
  const detalhe = container.querySelector(`#${gid}Detalhe`);
  if (detalhe) {
    detalhe.hidden = false;
    const btnV = container.querySelector(`[data-studio-ver="${gid}"]`);
    if (btnV) btnV.setAttribute('aria-expanded', 'true');
  }
  const acoes = detalhe && detalhe.querySelector('.studio-inbox-acoes');
  if (!acoes || acoes.querySelector('.studio-confirm')) return;

  const box = document.createElement('div');
  box.className = 'studio-confirm';
  box.innerHTML = '<span></span>';
  box.querySelector('span').textContent =
    'Remove só a amostra mais recente deste formato (a que aparece aqui). Se chegarem mais webhooks assim, uma nova amostra ocupa o lugar dela.';
  const ok = document.createElement('button');
  ok.type = 'button'; ok.className = 'btn btn-primary'; ok.textContent = 'Remover';
  const cancelar = document.createElement('button');
  cancelar.type = 'button'; cancelar.className = 'btn btn-ghost'; cancelar.textContent = 'Cancelar';
  cancelar.addEventListener('click', () => box.remove());
  ok.addEventListener('click', async () => {
    ok.disabled = true; cancelar.disabled = true;
    try {
      await api(`/projects/${state.selectedId}/webhooks/amostras/${rep.id}`, { method: 'DELETE' });
      toast('Amostra removida.', 'ok');
      studioCarregarInbox();
    } catch (err) {
      toast('Erro ao remover amostra: ' + err.message, 'err');
      box.remove();
    }
  });
  box.append(ok, cancelar);
  acoes.appendChild(box);
}

// ════════════════════════════════════════════════════════════════════
// ADAPTADORES SALVOS — CRUD (GET/DELETE aqui; POST/PUT no editor)
// ════════════════════════════════════════════════════════════════════

async function studioCarregarAdaptadores() {
  const el = $('#studioAdaptadoresLista');
  const pid = state.selectedId;
  if (!el || !pid) return;
  el.innerHTML = studioSkeletonTabela(2);
  try {
    studio.adaptadores = await api(`/projects/${pid}/adaptadores`);
  } catch (err) {
    el.innerHTML = `<div class="estado-vazio">
      <div class="estado-vazio-icone"><i data-lucide="circle-x" aria-hidden="true"></i></div>
      <h4>Não foi possível ler os adaptadores</h4>
      <p></p>
      <button type="button" class="btn" data-studio-retentar="adapt"><i data-lucide="refresh-cw" aria-hidden="true"></i> Tentar de novo</button>
    </div>`;
    el.querySelector('p').textContent = err.message;
    aplicarIcones(el);
    const retentar = el.querySelector('[data-studio-retentar]');
    if (retentar) retentar.addEventListener('click', studioCarregarAdaptadores);
    return;
  }
  if (state.selectedId !== pid) return;
  studioRenderAdaptadores(el);
  studioAtualizarPapel();
}

function studioRenderAdaptadores(el) {
  if (!studio.adaptadores.length) {
    el.innerHTML = `
      <div class="estado-vazio">
        <div class="estado-vazio-icone"><i data-lucide="shuffle" aria-hidden="true"></i></div>
        <h4>Nenhum adaptador configurado</h4>
        <p>
          Um adaptador é a tradução de um formato de webhook para o evento canônico do
          servidor. Estruture uma amostra da tabela acima ou comece do zero.
        </p>
        <button type="button" class="btn btn-primary" data-studio-vazio-novo><i data-lucide="plus" aria-hidden="true"></i> Novo mapeamento manual</button>
      </div>`;
    aplicarIcones(el);
    const novo = el.querySelector('[data-studio-vazio-novo]');
    if (novo) novo.addEventListener('click', () => studioAbrirEditor({}));
    return;
  }
  el.innerHTML = `<div class="studio-adapt-lista">${studio.adaptadores.map(studioAdaptadorItemHtml).join('')}</div>`;
  aplicarIcones(el);
  studio.adaptadores.forEach((a) => studioWireAdaptadorItem(el, a));
}

function studioAdaptadorItemHtml(a) {
  // Ativo x inativo com ícone junto da cor: a lista é escaneada de relance, e um verde
  // e um cinza do mesmo tamanho não se distinguem para quem não separa as duas cores.
  return `
    <div class="studio-adapt-item" data-adaptador-id="${a.id}">
      <span class="pill ${a.ativo ? 'success' : 'off'}">
        <i data-lucide="${a.ativo ? 'circle-check-big' : 'circle-minus'}" aria-hidden="true"></i>${a.ativo ? 'ativo' : 'inativo'}
      </span>
      <span class="studio-adapt-nome">${escHtml(a.nome)}</span>
      <span class="studio-adapt-meta">${escHtml(STUDIO_MODO_LABEL[a.modo] || a.modo)}${a.criadoVia === 'ia' ? ' · gerado por IA' : ''}</span>
      <button type="button" class="btn btn-ghost" data-studio-editar="${a.id}"><i data-lucide="pencil" aria-hidden="true"></i> Editar</button>
      <button type="button" class="btn btn-ghost" data-studio-excluir="${a.id}"><i data-lucide="trash-2" aria-hidden="true"></i> Excluir</button>
    </div>`;
}

function studioWireAdaptadorItem(el, a) {
  const editar = el.querySelector(`[data-studio-editar="${a.id}"]`);
  if (editar) editar.addEventListener('click', () => studioAbrirEditor({ adaptador: a }));
  const excluir = el.querySelector(`[data-studio-excluir="${a.id}"]`);
  if (excluir) excluir.addEventListener('click', () => studioConfirmarExclusao(a, excluir));
}

function studioConfirmarExclusao(a, btn) {
  const item = btn.closest('.studio-adapt-item');
  if (!item || item.querySelector('.studio-confirm')) return;
  const box = document.createElement('div');
  box.className = 'studio-confirm';
  box.style.width = '100%';
  box.innerHTML = '<span></span>';
  box.querySelector('span').textContent = `Excluir o adaptador "${a.nome}"? Webhooks deste formato voltam a cair na inbox de amostras.`;
  const ok = document.createElement('button');
  ok.type = 'button'; ok.className = 'btn btn-primary'; ok.textContent = 'Excluir';
  const cancelar = document.createElement('button');
  cancelar.type = 'button'; cancelar.className = 'btn btn-ghost'; cancelar.textContent = 'Cancelar';
  cancelar.addEventListener('click', () => box.remove());
  ok.addEventListener('click', async () => {
    ok.disabled = true; cancelar.disabled = true;
    try {
      await api(`/projects/${state.selectedId}/adaptadores/${a.id}`, { method: 'DELETE' });
      toast('Adaptador excluído.', 'ok');
      studioCarregarAdaptadores();
    } catch (err) {
      toast('Erro ao excluir: ' + err.message, 'err');
      box.remove();
    }
  });
  box.append(ok, cancelar);
  item.appendChild(box);
}

// ════════════════════════════════════════════════════════════════════
// EDITOR — abertura/fechamento e montagem do HTML das 3 colunas
// ════════════════════════════════════════════════════════════════════

/** `{}` = novo adaptador em branco; `{hash}` = novo a partir de uma amostra da inbox;
 * `{adaptador}` = edição de um adaptador já salvo. */
function studioAbrirEditor({ hash, adaptador } = {}) {
  const wrap = $('#studioEditorWrap');
  if (!wrap) return;
  wrap.hidden = false;
  studio.edicao = adaptador ? { id: adaptador.id, criadoVia: adaptador.criadoVia } : { id: null, criadoVia: 'manual' };
  studio.metodo = 'nativo';
  studio.iaUltimo = null;

  $('#studioEditor').innerHTML = studioEditorHtml();
  aplicarIcones($('#studioEditor'));
  studioWireEditor();
  studioPreencherAmostraSelect(hash);

  if (adaptador) {
    $('#studioNome').value = adaptador.nome || '';
    $('#studioAtivo').checked = !!adaptador.ativo;
    $('#studioModo').value = adaptador.modo || 'nativo';
    studio.ultimoModoValido = adaptador.modo || 'nativo';
    if (adaptador.modo === 'ia_por_evento') studio.iaConsentiuPorEvento = true; // já era o valor salvo — não pede reconsentimento só para visualizar
    studioCarregarEdicaoNoDom(adaptador.mapeamento || {}, adaptador.deteccao || {});
  } else {
    $('#studioNome').value = '';
    $('#studioAtivo').checked = false;
    $('#studioModo').value = 'nativo';
    studio.ultimoModoValido = 'nativo';
    studioCarregarEdicaoNoDom(
      { regras: [], evento: { de: '', transformar: 'mapear_valores', args: { dicionario: {} } } },
      { obrigatorias: [], qualquerUma: [] }
    );
  }

  studioAtualizarPapel();
  studioAgendarPreview();
  wrap.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function studioFecharEditor() {
  const wrap = $('#studioEditorWrap');
  if (wrap) wrap.hidden = true;
  const editor = $('#studioEditor');
  if (editor) editor.innerHTML = '';
  clearTimeout(studio.previewTimer);
  studio.edicao = null;
  studio.amostraAtual = null;
  studio.ultimaPreview = null;
  studio.alvoInput = null;
}

function studioEditorHtml() {
  const paraList = STUDIO_CAMPOS_CANONICOS.map((c) => `<option value="${escHtml(c)}"></option>`).join('');
  const eventosList = EVENTOS_CANONICOS.map((e) => `<option value="${escHtml(e.nome)}"></option>`).join('');
  return `
    <div class="studio-editor">
      <div class="studio-editor-topo">
        <div class="studio-editor-titulo">
          <span class="section-d" style="margin:0">${studio.edicao.id ? 'Editando adaptador salvo' : 'Novo adaptador'}</span>
        </div>
        <div class="studio-toggle-metodo modo-switch" id="studioMetodoSwitch" role="radiogroup" aria-label="Como montar este mapeamento">
          <button type="button" class="modo" data-metodo="nativo">
            <span class="modo-nome">Nativamente</span><span class="modo-sub">você monta as regras</span>
          </button>
          <button type="button" class="modo" data-metodo="ia">
            <span class="modo-nome">Com IA</span><span class="modo-sub">a OpenRouter propõe um rascunho</span>
          </button>
        </div>
      </div>

      <div class="studio-amostra-picker">
        <label for="studioAmostraSelect">Amostra de trabalho <button type="button" class="ajuda" data-ajuda="studio-amostra-webhook"></button></label>
        <select id="studioAmostraSelect"></select>
      </div>
      <div class="studio-amostra-manual" id="studioAmostraManualWrap" hidden>
        <textarea id="studioAmostraManualTexto" placeholder='Cole um JSON de exemplo, ex.: {"evento":"compra","valor":99.9}'></textarea>
        <div class="form-actions" style="margin-top:8px">
          <button type="button" class="btn btn-ghost" id="studioAmostraManualAplicar">Usar este payload</button>
        </div>
      </div>

      <div class="studio-ia-painel" id="studioIaPainel" hidden></div>

      <div class="studio-alvo-bar" id="studioAlvoBar">Clique num campo (ex.: "de" de uma regra) e depois num valor da árvore à esquerda para preenchê-lo.</div>

      <div class="studio-grid">
        <div class="studio-col">
          <p class="studio-col-h">Payload da amostra</p>
          <div class="studio-arvore" id="studioArvore"></div>
        </div>

        <div class="studio-col">
          <p class="studio-col-h">Regras</p>
          <div class="studio-regras" id="studioRegras"></div>
          <div class="studio-inbox-acoes">
            <button type="button" class="btn btn-ghost" id="studioAdicionarRegra"><i data-lucide="plus" aria-hidden="true"></i> Adicionar regra</button>
            <button type="button" class="btn btn-ghost" id="studioSugerir"><i data-lucide="wand-2" aria-hidden="true"></i> Sugerir mapeamento</button>
          </div>

          <div class="studio-evento-bloco">
            <h5>Nome do evento <button type="button" class="ajuda" data-ajuda="studio-evento-bloco"></button></h5>
            <div class="field">
              <label for="studioEventoDe">Campo bruto com o nome/tipo do evento</label>
              <input type="text" class="studio-caminho" id="studioEventoDe" data-studio-rotulo="o campo bruto do nome do evento" placeholder="ex.: event" />
            </div>
            <div class="studio-dicionario" id="studioEventoDicionario"></div>
            <button type="button" class="btn btn-ghost" id="studioEventoDicAdd">+ adicionar entrada no dicionário</button>

            <label class="field switch" style="margin-top:12px">
              <input type="checkbox" id="studioCondPagAtiva" />
              <span>Depende de confirmação de pagamento</span>
            </label>
            <div id="studioCondPagCampos" hidden style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
              <input type="text" class="studio-caminho" id="studioCondPagDe" data-studio-rotulo="o campo de status do pagamento" placeholder="campo de status do pagamento" style="min-width:180px" />
              <input type="text" id="studioCondPagValores" placeholder="valores confirmados, separados por vírgula (ex.: paid, approved)" style="min-width:220px;flex:1" />
            </div>

            <div class="callout amber" style="margin-top:12px">
              <b>Regra dura:</b> nenhum mapeamento vira <code>purchase</code> sem uma dessas duas coisas — uma entrada do
              dicionário mapeando literalmente para <code>purchase</code>, ou a condição de pagamento acima batendo.
              O servidor recusa salvar qualquer mapeamento que tente burlar isso.
              <button type="button" class="ajuda" data-ajuda="studio-regra-dura-purchase"></button>
            </div>
          </div>

          <div class="studio-deteccao">
            <h5>Detecção <button type="button" class="ajuda" data-ajuda="studio-deteccao"></button></h5>
            <p class="section-d" style="margin:0 0 10px">Como o servidor reconhece sozinho que um webhook futuro é deste formato.</p>
            <div class="studio-chips-grupo">
              <label>Obrigatórias — precisam estar TODAS presentes</label>
              <div class="studio-chips" id="studioDetObrig"></div>
              <div class="studio-chip-add">
                <input type="text" class="studio-caminho" id="studioDetObrigNovo" data-studio-rotulo="uma nova chave obrigatória de detecção" placeholder="ex.: event" />
                <button type="button" class="btn btn-ghost" id="studioDetObrigBtn">Adicionar</button>
              </div>
            </div>
            <div class="studio-chips-grupo">
              <label>Qualquer uma — basta UMA presente</label>
              <div class="studio-chips" id="studioDetQualquer"></div>
              <div class="studio-chip-add">
                <input type="text" class="studio-caminho" id="studioDetQualquerNovo" data-studio-rotulo="uma nova chave de detecção (qualquer uma)" placeholder="ex.: attribution" />
                <button type="button" class="btn btn-ghost" id="studioDetQualquerBtn">Adicionar</button>
              </div>
            </div>
            <p class="studio-deteccao-contagem" id="studioDetContagem"></p>
          </div>
        </div>

        <div class="studio-col">
          <div class="studio-preview-h">
            <p class="studio-col-h" style="margin:0">Prévia ao vivo</p>
            <span class="pill" id="studioPreviewStatus">—</span>
          </div>
          <div id="studioPreviewCorpo"><p class="dash-empty">Escolha uma amostra de trabalho para começar.</p></div>
        </div>
      </div>

      <div class="studio-editor-footer">
        <div class="field">
          <label for="studioNome">Nome do adaptador</label>
          <input type="text" id="studioNome" placeholder="ex.: Checkout Loja X" />
        </div>
        <label class="field switch">
          <input type="checkbox" id="studioAtivo" />
          <span>Ativo — passa a traduzir webhooks reais assim que salvo</span>
        </label>
        <div class="field">
          <label for="studioModo">Modo <button type="button" class="ajuda" data-ajuda="studio-modo-sombra"></button></label>
          <select id="studioModo">
            <option value="nativo">Normal — roda de verdade quando "Ativo" estiver marcado</option>
            <option value="sombra">Sombra — só observa por 24h, não altera nada</option>
            <option value="ia_por_evento">IA por evento (avançado) — cada webhook passa pela IA</option>
          </select>
        </div>
        <p class="callout ro-note js-studio-readonly-nota" hidden>
          Você está como operador — pode revisar e testar o mapeamento, mas só um administrador pode salvar.
        </p>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" id="studioCancelar">Cancelar</button>
          <button type="button" class="btn btn-primary" id="studioSalvar" disabled>Salvar adaptador</button>
        </div>
      </div>
    </div>
    <datalist id="studioParaList">${paraList}</datalist>
    <datalist id="studioEventosCanonicosList">${eventosList}</datalist>`;
}

function studioWireEditor() {
  $$('#studioMetodoSwitch .modo').forEach((btn) => btn.addEventListener('click', () => studioEscolherMetodo(btn.dataset.metodo)));
  studioEscolherMetodo('nativo');

  $('#studioAmostraManualAplicar').addEventListener('click', studioAmostraManualAplicar);
  $('#studioAdicionarRegra').addEventListener('click', () => studioAdicionarRegra({ transformar: 'texto' }));
  $('#studioSugerir').addEventListener('click', studioSugerirMapeamento);

  $('#studioEventoDicAdd').addEventListener('click', () => {
    $('#studioEventoDicionario').appendChild(studioEventoDicLinha('', ''));
    studioAgendarPreview();
  });
  $('#studioCondPagAtiva').addEventListener('change', () => {
    $('#studioCondPagCampos').hidden = !$('#studioCondPagAtiva').checked;
    studioAgendarPreview();
  });

  $('#studioDetObrigBtn').addEventListener('click', () => studioAdicionarChip('studioDetObrig', 'studioDetObrigNovo'));
  $('#studioDetQualquerBtn').addEventListener('click', () => studioAdicionarChip('studioDetQualquer', 'studioDetQualquerNovo'));

  $('#studioModo').addEventListener('change', studioAoMudarModoSalvar);
  $('#studioCancelar').addEventListener('click', studioFecharEditor);
  $('#studioSalvar').addEventListener('click', studioSalvar);
}

// ---------------- amostra de trabalho ----------------

function studioPreencherAmostraSelect(hashPreferido) {
  const sel = $('#studioAmostraSelect');
  sel.innerHTML = '';
  for (const g of studio.amostras) {
    const rep = g.amostra_representativa || {};
    const rotulo = `${rep.formato_detectado || 'formato sem nome'} · ${fmtNumBR(g.quantidade)} webhook(s) · desde ${fmtDate(g.primeira_em)}`;
    sel.appendChild(opcao(g.hash_estrutura, rotulo));
  }
  sel.appendChild(opcao('__manual__', 'colar um payload manualmente…'));
  if (hashPreferido && studio.amostras.some((g) => g.hash_estrutura === hashPreferido)) sel.value = hashPreferido;
  else if (studio.amostras.length) sel.value = studio.amostras[0].hash_estrutura;
  else sel.value = '__manual__';

  sel.addEventListener('change', studioSelecionarAmostra);
  studioSelecionarAmostra();
}

function studioSelecionarAmostra() {
  const sel = $('#studioAmostraSelect');
  const manualWrap = $('#studioAmostraManualWrap');
  if (sel.value === '__manual__') {
    manualWrap.hidden = false;
    if (!studio.amostraAtual || studio.amostraAtual.origem !== 'manual') {
      studio.amostraAtual = null;
      studioRenderArvore();
    }
    studioAgendarPreview();
    return;
  }
  manualWrap.hidden = true;
  const grupo = studio.amostras.find((g) => g.hash_estrutura === sel.value);
  const rep = (grupo && grupo.amostra_representativa) || null;
  studio.amostraAtual = rep
    ? { origem: 'capturada', amostraId: rep.id, corpo: rep.body_mascarado || {}, rotulo: rep.formato_detectado || 'formato sem nome' }
    : null;
  studioRenderArvore();
  studioAgendarPreview();
}

function studioAmostraManualAplicar() {
  const bruto = $('#studioAmostraManualTexto').value.trim();
  if (!bruto) { toast('Cole um JSON antes de aplicar.', 'warn'); return; }
  let obj;
  try { obj = JSON.parse(bruto); } catch (err) { toast('JSON inválido: ' + err.message, 'err'); return; }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) { toast('O payload precisa ser um objeto JSON.', 'err'); return; }
  studio.amostraAtual = { origem: 'manual', amostraId: null, corpo: obj, rotulo: 'payload colado manualmente' };
  studioRenderArvore();
  studioAgendarPreview();
  toast('Payload aplicado à árvore e à prévia.', 'ok');
}

// ---------------- árvore clicável (coluna esquerda) ----------------

function studioRenderArvore() {
  const el = $('#studioArvore');
  if (!el) return;
  const corpo = studio.amostraAtual && studio.amostraAtual.corpo;
  el.innerHTML = (corpo && typeof corpo === 'object')
    ? studioArvoreNo(corpo, '')
    : '<p class="studio-arvore-vazio">Escolha (ou cole) uma amostra de trabalho acima.</p>';
}

// Recursivo: cada folha (valor que não é objeto/lista) vira um botão clicável com o
// caminho completo em data-caminho, na MESMA notação "a.b.0.c" que obterCaminho
// (mapeamento.js) entende — índice de array não precisa de colchete, só do número.
function studioArvoreNo(valor, caminho) {
  if (Array.isArray(valor)) {
    if (!valor.length) return '<span class="studio-arvore-vazio">[ ] vazio</span>';
    return `<ul>${valor.map((v, i) => {
      const filho = caminho ? `${caminho}.${i}` : String(i);
      return `<li><span class="studio-arvore-chave">[${i}]</span> ${studioArvoreNo(v, filho)}</li>`;
    }).join('')}</ul>`;
  }
  if (valor && typeof valor === 'object') {
    const chaves = Object.keys(valor);
    if (!chaves.length) return '<span class="studio-arvore-vazio">{ } vazio</span>';
    return `<ul>${chaves.map((k) => {
      const filho = caminho ? `${caminho}.${k}` : k;
      return `<li><span class="studio-arvore-chave">${escHtml(k)}:</span> ${studioArvoreNo(valor[k], filho)}</li>`;
    }).join('')}</ul>`;
  }
  // O valor herda a mesma paleta de tipos do JSON realçado (.studio-json): texto em
  // verde, número em índigo, booleano em violeta, nulo em cinza. Antes tudo saía num
  // dourado só — que em tema claro deixava de distinguir qualquer coisa.
  const rotuloValor = valor === null ? 'null' : String(valor);
  const tipo = valor === null ? 'c-null'
    : typeof valor === 'number' ? 'c-num'
      : typeof valor === 'boolean' ? 'c-bool' : 'c-str';
  return `<button type="button" class="studio-arvore-leaf studio-json" data-caminho="${escHtml(caminho)}" title="${escHtml(caminho)}">
    <span class="studio-arvore-valor ${tipo}">${escHtml(studioAbreviar(rotuloValor, 42))}</span>
  </button>`;
}

function studioAbreviar(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

// ---------------- regras (coluna central) ----------------

function studioAdicionarRegra(inicial) {
  const cont = $('#studioRegras');
  if (!cont) return null;
  const row = studioNovaRegraEl(inicial || {});
  cont.appendChild(row);
  studioAgendarPreview();
  return row;
}

function studioNovaRegraEl(regraInicial) {
  const row = document.createElement('div');
  row.className = 'studio-regra';
  row.innerHTML = `
    <div class="studio-regra-de">
      <label>de</label>
      <input type="text" class="studio-caminho" data-role="de" placeholder="ex.: cliente.email" />
      <textarea class="studio-caminho" data-role="de-multi" hidden placeholder="um caminho por linha"></textarea>
    </div>
    <span class="studio-regra-seta">→</span>
    <div class="studio-regra-para">
      <label>para</label>
      <input type="text" class="studio-para" list="studioParaList" placeholder="ex.: user_data.email" />
    </div>
    <div class="studio-regra-transf">
      <label>transformar <button type="button" class="ajuda" data-ajuda="studio-transf-texto"></button></label>
      <select class="studio-transformar">${STUDIO_TRANSFORMACOES.map((t) => `<option value="${t.valor}">${escHtml(t.rotulo)}</option>`).join('')}</select>
    </div>
    <div class="studio-regra-args"></div>
    <button type="button" class="btn btn-ghost studio-regra-remover">remover</button>`;

  const de = regraInicial.de;
  row.querySelector('.studio-transformar').value = regraInicial.transformar || 'texto';
  if (Array.isArray(de)) row.querySelector('textarea[data-role="de-multi"]').value = de.join('\n');
  else row.querySelector('input[data-role="de"]').value = de || '';
  row.querySelector('.studio-para').value = regraInicial.para || '';

  studioAtualizarArgsDaRegra(row, regraInicial.args);
  row.querySelector('.studio-regra-remover').addEventListener('click', () => { row.remove(); studioAgendarPreview(); });
  row.querySelector('.studio-para').addEventListener('input', () => studioAtualizarRotuloDe(row));
  studioAtualizarRotuloDe(row);
  return row;
}

// Mostra/esconde "de" (input simples vs. lista em textarea vs. nenhum), troca a chave
// de ajuda contextual para a transformação escolhida e desenha os campos de `args`
// específicos dela. Chamada tanto na criação da linha quanto no listener delegado de
// `change` do <select> (ver studioWireDelegados, no fim do arquivo).
function studioAtualizarArgsDaRegra(row, argsIniciais) {
  const transformar = row.querySelector('.studio-transformar').value;
  const inputDe = row.querySelector('input[data-role="de"]');
  const textDe = row.querySelector('textarea[data-role="de-multi"]');
  const multi = STUDIO_TRANSF_MULTI_DE.has(transformar);
  const semDe = STUDIO_TRANSF_SEM_DE.has(transformar);
  inputDe.hidden = multi || semDe;
  inputDe.disabled = multi || semDe;
  textDe.hidden = !multi;
  textDe.disabled = !multi;

  const ajudaBtn = row.querySelector('.studio-regra-transf .ajuda');
  if (ajudaBtn) ajudaBtn.dataset.ajuda = 'studio-transf-' + transformar.replace(/_/g, '-');

  const argsEl = row.querySelector('.studio-regra-args');
  argsEl.innerHTML = '';
  const args = argsIniciais || {};

  if (transformar === 'constante') {
    argsEl.appendChild(studioArgInput('valor', 'valor fixo', args.valor));
  } else if (transformar === 'marcador_presenca') {
    argsEl.appendChild(studioArgInput('valor', 'valor quando presente', args.valor));
    argsEl.appendChild(studioArgInput('valorAusente', 'valor quando ausente (opcional)', args.valorAusente));
  } else if (transformar === 'primeiro_preenchido') {
    argsEl.appendChild(studioArgInput('padrao', 'valor padrão se nada preenchido (opcional)', args.padrao));
  } else if (transformar === 'mapear_valores') {
    const dic = document.createElement('div');
    dic.className = 'studio-dicionario studio-dicionario-simples';
    studioMontarDicionarioSimples(dic, args.dicionario || {});
    argsEl.appendChild(dic);
    const addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'btn btn-ghost'; addBtn.textContent = '+ valor';
    addBtn.addEventListener('click', () => { dic.appendChild(studioDicSimplesLinha('', '')); studioAgendarPreview(); });
    argsEl.appendChild(addBtn);
    argsEl.appendChild(studioArgInput('padrao', 'valor padrão (opcional)', args.padrao));
  }
}

function studioArgInput(nomeArg, placeholder, valorInicial) {
  const input = document.createElement('input');
  input.type = 'text';
  input.dataset.arg = nomeArg;
  input.placeholder = placeholder;
  if (valorInicial !== undefined) input.value = valorInicial;
  return input;
}

function studioMontarDicionarioSimples(container, dicionario) {
  container.innerHTML = '';
  const entradas = Object.entries(dicionario || {});
  if (!entradas.length) entradas.push(['', '']);
  for (const [k, v] of entradas) container.appendChild(studioDicSimplesLinha(k, v));
}
function studioDicSimplesLinha(chave, valor) {
  const row = document.createElement('div');
  row.className = 'studio-dic-row';
  row.innerHTML = `
    <input type="text" class="studio-dic-chave" placeholder="valor de origem" />
    <span aria-hidden="true">→</span>
    <input type="text" class="studio-dic-valor" placeholder="valor de destino" />
    <button type="button" class="btn btn-ghost studio-dic-remover" aria-label="remover">×</button>`;
  row.querySelector('.studio-dic-chave').value = chave;
  row.querySelector('.studio-dic-valor').value = valor;
  row.querySelector('.studio-dic-remover').addEventListener('click', () => { row.remove(); studioAgendarPreview(); });
  return row;
}
function studioLerDicionarioSimples(container) {
  const dic = {};
  if (!container) return dic;
  container.querySelectorAll('.studio-dic-row').forEach((row) => {
    const k = row.querySelector('.studio-dic-chave').value.trim();
    const v = row.querySelector('.studio-dic-valor').value.trim();
    if (k) dic[k] = v;
  });
  return dic;
}

// "para" muda o rótulo do alvo de clique da árvore ("a origem que vira X") — só texto
// de orientação, não afeta o que é salvo.
function studioAtualizarRotuloDe(row) {
  const para = row.querySelector('.studio-para').value.trim();
  const rotulo = para ? `a origem que vira "${para}"` : 'a origem desta regra';
  row.querySelectorAll('.studio-caminho').forEach((el) => { el.dataset.studioRotulo = rotulo; });
}

function studioLerRegra(row) {
  const transformar = row.querySelector('.studio-transformar').value;
  const para = row.querySelector('.studio-para').value.trim();
  const regra = { para, transformar };

  if (STUDIO_TRANSF_MULTI_DE.has(transformar)) {
    regra.de = row.querySelector('textarea[data-role="de-multi"]').value.split('\n').map((s) => s.trim()).filter(Boolean);
  } else if (!STUDIO_TRANSF_SEM_DE.has(transformar)) {
    regra.de = row.querySelector('input[data-role="de"]').value.trim();
  }

  const args = {};
  row.querySelectorAll('.studio-regra-args [data-arg]').forEach((input) => {
    const v = input.value.trim();
    if (v) args[input.dataset.arg] = v;
  });
  if (transformar === 'mapear_valores') {
    args.dicionario = studioLerDicionarioSimples(row.querySelector('.studio-dicionario-simples'));
  }
  if (Object.keys(args).length) regra.args = args;
  return regra;
}

function studioLerRegras() { return $$('#studioRegras .studio-regra').map(studioLerRegra); }

// ---------------- bloco "evento" (nome do evento canônico) ----------------

function studioEventoDicLinha(chave, valor) {
  const row = document.createElement('div');
  row.className = 'studio-dic-row';
  const condicional = valor !== null && typeof valor === 'object' && !Array.isArray(valor);
  row.innerHTML = `
    <input type="text" class="studio-dic-chave" placeholder="valor bruto do evento (ex.: payment.approved)" />
    <select class="studio-dic-modo">
      <option value="sempre">sempre vira</option>
      <option value="condicional">depende do pagamento (acima)</option>
    </select>
    <input type="text" class="studio-dic-destino" list="studioEventosCanonicosList" placeholder="ex.: purchase" />
    <div class="studio-dic-condicional" hidden>
      <input type="text" class="studio-dic-sepago" list="studioEventosCanonicosList" placeholder="se pago: ex.: purchase" />
      <input type="text" class="studio-dic-senaopago" placeholder='se NÃO pago (nunca "purchase")' />
    </div>
    <span class="studio-dic-aviso" hidden><i data-lucide="triangle-alert" aria-hidden="true"></i>"se não pago" não pode ser "purchase" — o servidor recusa salvar.</span>
    <button type="button" class="btn btn-ghost studio-dic-remover" aria-label="remover">×</button>`;

  row.querySelector('.studio-dic-chave').value = chave;
  const modoSel = row.querySelector('.studio-dic-modo');
  const destinoInput = row.querySelector('.studio-dic-destino');
  const condDiv = row.querySelector('.studio-dic-condicional');
  const senaoPago = row.querySelector('.studio-dic-senaopago');
  const aviso = row.querySelector('.studio-dic-aviso');

  modoSel.value = condicional ? 'condicional' : 'sempre';
  destinoInput.hidden = condicional;
  condDiv.hidden = !condicional;
  if (condicional) {
    row.querySelector('.studio-dic-sepago').value = valor.sePago || '';
    senaoPago.value = valor.senaoPago || '';
  } else {
    destinoInput.value = valor || '';
  }

  modoSel.addEventListener('change', () => {
    const cond = modoSel.value === 'condicional';
    destinoInput.hidden = cond;
    condDiv.hidden = !cond;
    studioAgendarPreview();
  });
  // Aviso ao vivo — a regra dura já aparece na interface antes de o operador tentar
  // salvar e esbarrar no erro do servidor (pedido explícito do agente responsável).
  senaoPago.addEventListener('input', () => {
    const barrado = senaoPago.value.trim().toLowerCase() === 'purchase';
    aviso.hidden = !barrado;
    // A borda vermelha entra junto do texto: o aviso solto embaixo não diz QUAL campo
    // recusa o valor quando a linha tem quatro entradas lado a lado.
    if (barrado) senaoPago.setAttribute('aria-invalid', 'true');
    else senaoPago.removeAttribute('aria-invalid');
  });
  row.querySelector('.studio-dic-remover').addEventListener('click', () => { row.remove(); studioAgendarPreview(); });
  aplicarIcones(row);
  return row;
}

function studioLerEventoDicionario() {
  const dic = {};
  const cont = $('#studioEventoDicionario');
  if (!cont) return dic;
  cont.querySelectorAll('.studio-dic-row').forEach((row) => {
    const chave = row.querySelector('.studio-dic-chave').value.trim();
    if (!chave) return;
    if (row.querySelector('.studio-dic-modo').value === 'condicional') {
      const sePago = row.querySelector('.studio-dic-sepago').value.trim();
      const senaoPago = row.querySelector('.studio-dic-senaopago').value.trim();
      const entrada = {};
      if (sePago) entrada.sePago = sePago;
      if (senaoPago) entrada.senaoPago = senaoPago;
      dic[chave] = entrada;
    } else {
      const destino = row.querySelector('.studio-dic-destino').value.trim();
      if (destino) dic[chave] = destino;
    }
  });
  return dic;
}

function studioLerEvento() {
  const evento = { de: $('#studioEventoDe').value.trim(), transformar: 'mapear_valores', args: { dicionario: studioLerEventoDicionario() } };
  if ($('#studioCondPagAtiva').checked) {
    const de = $('#studioCondPagDe').value.trim();
    const valores = $('#studioCondPagValores').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (de && valores.length) evento.condicaoPagamento = { de, valoresConfirmados: valores };
  }
  return evento;
}

// ---------------- bloco "detecção" ----------------

function studioChip(caminho) {
  const chip = document.createElement('span');
  chip.className = 'studio-chip';
  chip.dataset.caminho = caminho;
  chip.innerHTML = '<span></span><button type="button" aria-label="remover">×</button>';
  chip.querySelector('span').textContent = caminho;
  chip.querySelector('button').addEventListener('click', () => { chip.remove(); studioAtualizarContagemDeteccao(); studioAgendarPreview(); });
  return chip;
}
function studioRenderChips(containerId, itens) {
  const el = $('#' + containerId);
  if (!el) return;
  el.innerHTML = '';
  for (const caminho of itens) el.appendChild(studioChip(caminho));
}
function studioLerChips(containerId) {
  const el = $('#' + containerId);
  return el ? $$('.studio-chip', el).map((c) => c.dataset.caminho) : [];
}
function studioAdicionarChip(containerId, inputId) {
  const input = $('#' + inputId);
  const caminho = input.value.trim();
  if (!caminho) return;
  if (studioLerChips(containerId).includes(caminho)) { toast('Esta chave já está na lista.', 'warn'); return; }
  $('#' + containerId).appendChild(studioChip(caminho));
  input.value = '';
  studioAtualizarContagemDeteccao();
  studioAgendarPreview();
}
function studioAtualizarContagemDeteccao() {
  const total = studioLerChips('studioDetObrig').length + studioLerChips('studioDetQualquer').length;
  const el = $('#studioDetContagem');
  if (!el) return;
  const fraca = total < 2;
  el.classList.toggle('is-fraca', fraca);
  el.innerHTML = `<i data-lucide="${fraca ? 'triangle-alert' : 'circle-check-big'}" aria-hidden="true"></i><span></span>`;
  el.querySelector('span').textContent = fraca
    ? `${total} chave(s) discriminante(s) — são necessárias pelo menos 2 no total (obrigatórias + qualquer uma), senão este adaptador pode "roubar" webhooks de outro formato.`
    : `${total} chave(s) discriminante(s) — suficiente para uma detecção segura.`;
  aplicarIcones(el);
}
function studioLerDeteccao() { return { obrigatorias: studioLerChips('studioDetObrig'), qualquerUma: studioLerChips('studioDetQualquer') }; }

// ---------------- carregar um mapeamento/detecção inteiro no DOM ----------------
// Usado para: abrir o editor em branco, editar um adaptador salvo, aplicar a sugestão
// heurística e aplicar o rascunho da IA — as quatro origens produzem a MESMA forma
// { regras, evento } / { obrigatorias, qualquerUma }, então uma função só resolve as
// quatro (mesma ideia de sugerirMapeamento em mapeamento.js: "o editor não precisa
// saber qual dos caminhos gerou o rascunho").

function studioCarregarEdicaoNoDom(mapeamento, deteccao) {
  const m = mapeamento || {};
  const d = deteccao || {};

  const cont = $('#studioRegras');
  cont.innerHTML = '';
  const regras = Array.isArray(m.regras) ? m.regras : [];
  if (!regras.length) studioAdicionarRegra({ transformar: 'texto' });
  else regras.forEach((r) => studioAdicionarRegra(r));

  const evento = m.evento || {};
  $('#studioEventoDe').value = evento.de || '';
  const dicEl = $('#studioEventoDicionario');
  dicEl.innerHTML = '';
  Object.entries((evento.args && evento.args.dicionario) || {}).forEach(([k, v]) => dicEl.appendChild(studioEventoDicLinha(k, v)));

  const cond = evento.condicaoPagamento;
  $('#studioCondPagAtiva').checked = !!cond;
  $('#studioCondPagCampos').hidden = !cond;
  $('#studioCondPagDe').value = (cond && cond.de) || '';
  $('#studioCondPagValores').value = (cond && Array.isArray(cond.valoresConfirmados)) ? cond.valoresConfirmados.join(', ') : '';

  studioRenderChips('studioDetObrig', Array.isArray(d.obrigatorias) ? d.obrigatorias : []);
  studioRenderChips('studioDetQualquer', Array.isArray(d.qualquerUma) ? d.qualquerUma : []);
  studioAtualizarContagemDeteccao();
}

function studioLerMapeamentoCompleto() { return { regras: studioLerRegras(), evento: studioLerEvento() }; }

// ---------------- sugestão heurística (sem IA — disponível para operador também) ----------------

async function studioSugerirMapeamento() {
  if (!studio.amostraAtual) { toast('Escolha uma amostra de trabalho primeiro.', 'warn'); return; }
  const body = studio.amostraAtual.origem === 'capturada' && studio.amostraAtual.amostraId != null
    ? { amostraId: studio.amostraAtual.amostraId }
    : { amostra: studio.amostraAtual.corpo };
  try {
    const r = await api(`/projects/${state.selectedId}/adaptadores/sugerir`, { method: 'POST', body });
    studioCarregarEdicaoNoDom(r.mapeamento, r.deteccao);
    studio.iaUltimo = null;
    const d = r.diagnostico || {};
    const n = (d.camposReconhecidos || []).length;
    toast(`Sugestão aplicada: ${n} campo(s) reconhecido(s) automaticamente. Revise antes de salvar.`, 'ok', 5000);
    studioAgendarPreview();
  } catch (err) {
    toast('Erro ao sugerir mapeamento: ' + err.message, 'err');
  }
}

// ════════════════════════════════════════════════════════════════════
// PRÉVIA AO VIVO (coluna direita) — POST /adaptadores/preview, com debounce
// ════════════════════════════════════════════════════════════════════

function studioAgendarPreview() {
  clearTimeout(studio.previewTimer);
  studioAtualizarContagemDeteccao();
  studio.previewTimer = setTimeout(studioAtualizarPreview, 450);
}

async function studioAtualizarPreview() {
  const corpoEl = $('#studioPreviewCorpo');
  const statusEl = $('#studioPreviewStatus');
  if (!corpoEl || !statusEl) return;

  if (!studio.amostraAtual) {
    corpoEl.innerHTML = '<p class="dash-empty">Escolha uma amostra de trabalho para começar.</p>';
    statusEl.textContent = '—';
    statusEl.className = 'pill';
    studio.ultimaPreview = null;
    studioAtualizarBotaoSalvar();
    return;
  }

  statusEl.textContent = 'calculando…';
  statusEl.className = 'pill';
  let r;
  try {
    r = await api(`/projects/${state.selectedId}/adaptadores/preview`, {
      method: 'POST',
      body: { mapeamento: studioLerMapeamentoCompleto(), amostra: studio.amostraAtual.corpo, deteccao: studioLerDeteccao() },
    });
  } catch (err) {
    corpoEl.innerHTML = `<div class="studio-preview-erro"><i data-lucide="circle-alert" aria-hidden="true"></i><span></span></div>`;
    corpoEl.querySelector('span').textContent = 'Erro ao calcular a prévia: ' + err.message;
    aplicarIcones(corpoEl);
    statusEl.textContent = 'erro';
    statusEl.className = 'pill error';
    studio.ultimaPreview = null;
    studioAtualizarBotaoSalvar();
    return;
  }

  studio.ultimaPreview = r;
  studioRenderPreview(corpoEl, statusEl, r);
  studioAtualizarBotaoSalvar();
}

function studioRenderPreview(corpoEl, statusEl, r) {
  const valido = !!(r.validacao && r.validacao.valido);
  statusEl.className = 'pill ' + (valido ? 'success' : 'error');
  statusEl.innerHTML = `<i data-lucide="${valido ? 'circle-check-big' : 'circle-x'}" aria-hidden="true"></i><span></span>`;
  statusEl.querySelector('span').textContent = valido ? 'mapeamento válido' : 'inválido';

  const erro = (texto) => `<div class="studio-preview-erro"><i data-lucide="circle-alert" aria-hidden="true"></i><span>${escHtml(texto)}</span></div>`;

  const blocos = [];
  if (!valido) {
    blocos.push(`<div class="studio-preview-erros">${r.validacao.erros.map(erro).join('')}</div>`);
  }
  if (r.erroExecucao) {
    blocos.push(erro('Erro ao executar o mapeamento contra esta amostra: ' + r.erroExecucao));
  }
  if (typeof r.deteccaoBateu === 'boolean') {
    // "A detecção reconheceria esta amostra" é boa notícia e ganha a caixa verde: antes
    // o caso bom saía como parágrafo mudo e só o ruim tinha forma própria.
    blocos.push(r.deteccaoBateu
      ? '<p class="studio-preview-ok"><i data-lucide="circle-check-big" aria-hidden="true"></i><span>Esta detecção reconheceria esta amostra.</span></p>'
      : erro('Esta detecção NÃO reconheceria esta amostra — confira as chaves obrigatórias/qualquer uma.'));
  }
  if (r.evento) {
    const ev = r.evento;
    const diag = r.diagnostico || { camposPreenchidos: [], camposVazios: [] };
    const chips = (lista) => lista.length ? `<span class="kv-chips">${lista.map((c) => `<span>${escHtml(c)}</span>`).join('')}</span>` : '<span class="res-vazio">nenhum</span>';
    blocos.push(`
      <div class="kv"><span class="kv-k">event_name</span><span class="kv-v">${escHtml(ev.event_name || '—')}</span></div>
      <p class="section-d" style="margin:10px 0 4px">Campos preenchidos (${diag.camposPreenchidos.length})</p>
      ${chips(diag.camposPreenchidos)}
      <p class="section-d" style="margin:10px 0 4px">Campos vazios (${diag.camposVazios.length})</p>
      ${chips(diag.camposVazios)}
      <pre class="json-view studio-json studio-preview-json">${studioJsonHtml(ev)}</pre>`);
  }
  corpoEl.innerHTML = blocos.join('') || '<p class="dash-empty">Sem prévia ainda.</p>';
  aplicarIcones(corpoEl);
  aplicarIcones(statusEl);
}

function studioAtualizarBotaoSalvar() {
  const btn = $('#studioSalvar');
  if (!btn) return;
  const totalDeteccao = studioLerChips('studioDetObrig').length + studioLerChips('studioDetQualquer').length;
  const mapeamentoValido = !!(studio.ultimaPreview && studio.ultimaPreview.validacao && studio.ultimaPreview.validacao.valido);
  btn.disabled = !isAdmin() || !mapeamentoValido || totalDeteccao < 2 || !studio.amostraAtual;
}

// ════════════════════════════════════════════════════════════════════
// SALVAR — POST/PUT /adaptadores (admin)
// ════════════════════════════════════════════════════════════════════

async function studioSalvar() {
  if (!isAdmin()) { toast('Apenas administradores podem salvar adaptadores.', 'err'); return; }
  const nome = $('#studioNome').value.trim();
  if (!nome) { toast('Dê um nome ao adaptador.', 'warn'); $('#studioNome').focus(); return; }

  const body = {
    nome,
    ativo: $('#studioAtivo').checked,
    modo: $('#studioModo').value,
    mapeamento: studioLerMapeamentoCompleto(),
    deteccao: studioLerDeteccao(),
    criadoVia: studio.iaUltimo ? 'ia' : 'manual',
  };

  const btn = $('#studioSalvar');
  btn.disabled = true;
  try {
    if (studio.edicao && studio.edicao.id) {
      await api(`/projects/${state.selectedId}/adaptadores/${studio.edicao.id}`, { method: 'PUT', body });
      toast('Adaptador atualizado.', 'ok');
    } else {
      await api(`/projects/${state.selectedId}/adaptadores`, { method: 'POST', body });
      toast('Adaptador criado. Se estiver "Ativo", os próximos webhooks deste formato já saem traduzidos.', 'ok');
    }
    studioFecharEditor();
    studioCarregarInbox();
    studioCarregarAdaptadores();
  } catch (err) {
    // Rede de segurança: se o servidor recusar por um motivo que a prévia não pegou
    // (ex.: detecção fraca só validada no save), anexa os erros já conhecidos da
    // última prévia — "adaptador inválido" sozinho não ajuda ninguém a corrigir.
    const detalhes = (studio.ultimaPreview && studio.ultimaPreview.validacao && !studio.ultimaPreview.validacao.valido)
      ? ' — ' + studio.ultimaPreview.validacao.erros.join('; ')
      : '';
    toast('Erro ao salvar adaptador: ' + err.message + detalhes, 'err', 6500);
    btn.disabled = false;
  }
}

function studioAoMudarModoSalvar() {
  const sel = $('#studioModo');
  if (sel.value === 'ia_por_evento' && !studio.iaConsentiuPorEvento) {
    sel.value = studio.ultimoModoValido;
    studioAbrirConsentimentoIaPorEvento();
    return;
  }
  studio.ultimoModoValido = sel.value;
}

// ---------------- modal de consentimento: modo "IA por evento" ----------------

let _studioModalConsentimento = null;

function _studioGarantirModalConsentimento() {
  if (_studioModalConsentimento) return _studioModalConsentimento;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.id = 'studioConsentimentoBackdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h3>Modo "IA por evento" — avançado <button type="button" class="ajuda" data-ajuda="studio-modo-ia-por-evento"></button></h3>
      <p class="section-d" style="margin-top:0">Isto é diferente de usar a IA só para RASCUNHAR o mapeamento. Neste modo, TODO webhook real passa pela IA. Antes de habilitar:</p>
      <ul class="studio-consentimento-lista">
        <li><b>Custo por evento.</b> Cada webhook que chegar neste formato gera uma chamada paga à OpenRouter — recorrente, não um custo único de configuração.</li>
        <li><b>Latência adicional.</b> O evento espera a resposta da IA antes de seguir para os destinos — mais lento que um mapeamento salvo e fixo.</li>
        <li><b>Os dados vão a um terceiro.</b> O corpo do webhook, com PII já hasheada antes do envio, sai deste servidor rumo à OpenRouter.</li>
        <li><b>O resultado não é determinístico.</b> A mesma entrada pode produzir mapeamentos ligeiramente diferentes entre chamadas — não é uma regra fixa como o modo normal.</li>
      </ul>
      <div class="form-actions">
        <button type="button" class="btn btn-primary" id="studioConsentimentoAceitar">Aceitar e habilitar</button>
        <button type="button" class="btn btn-ghost" id="studioConsentimentoCancelar">Cancelar</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  aplicarIcones(backdrop);
  backdrop.querySelector('#studioConsentimentoCancelar').addEventListener('click', () => backdrop.classList.remove('open'));
  backdrop.querySelector('#studioConsentimentoAceitar').addEventListener('click', () => {
    studio.iaConsentiuPorEvento = true;
    studio.ultimoModoValido = 'ia_por_evento';
    const sel = $('#studioModo');
    if (sel) sel.value = 'ia_por_evento';
    backdrop.classList.remove('open');
  });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.classList.remove('open'); });
  _studioModalConsentimento = backdrop;
  return backdrop;
}

function studioAbrirConsentimentoIaPorEvento() { _studioGarantirModalConsentimento().classList.add('open'); }

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _studioModalConsentimento && _studioModalConsentimento.classList.contains('open')) {
    _studioModalConsentimento.classList.remove('open');
  }
});

// ════════════════════════════════════════════════════════════════════
// MÉTODO "COM IA" — painel de chave/modelo/custo e o botão "Estruturar com IA"
// ════════════════════════════════════════════════════════════════════

function studioEscolherMetodo(metodo) {
  studio.metodo = metodo;
  $$('#studioMetodoSwitch .modo').forEach((btn) => btn.classList.toggle('is-on', btn.dataset.metodo === metodo));
  const painel = $('#studioIaPainel');
  if (!painel) return;
  if (metodo === 'ia') {
    painel.hidden = false;
    if (!painel.dataset.montado) { painel.dataset.montado = '1'; studioMontarPainelIa(painel); }
    studioAtualizarPainelIa();
  } else {
    painel.hidden = true;
  }
}

function studioMontarPainelIa(painel) {
  painel.innerHTML = `
    <p class="section-d" style="margin-top:0">
      A amostra de trabalho (já mascarada) é enviada à OpenRouter para propor um rascunho de
      mapeamento. O navegador nunca fala direto com a OpenRouter — a chamada é sempre feita
      pelo servidor, e o rascunho volta para você revisar antes de qualquer coisa ser salva.
    </p>
    <div class="field">
      <label for="studioIaApiKey">Chave da API da OpenRouter <button type="button" class="ajuda" data-ajuda="studio-chave-openrouter"></button></label>
      <input type="password" id="studioIaApiKey" autocomplete="off" placeholder="sk-or-..." />
      <p class="desc" id="studioIaChaveNota"></p>
    </div>
    <div class="field">
      <label for="studioIaModelo">Modelo</label>
      <div class="studio-ia-modelo-row">
        <input type="text" id="studioIaModelo" list="studioModelosDatalist" placeholder="ex.: DeepSeek v4 Flash" />
        <datalist id="studioModelosDatalist"></datalist>
        <button type="button" class="btn btn-ghost" id="studioIaCarregarModelos">Carregar modelos</button>
      </div>
      <p class="desc" id="studioIaModelosNota"></p>
    </div>
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" id="studioIaSalvarConfig">Salvar chave/modelo</button>
    </div>
    <p class="studio-ia-uso" id="studioIaUso">Custo acumulado do mês: carregando…</p>
    <div class="form-actions">
      <button type="button" class="btn btn-primary" id="studioIaEstruturar">Estruturar com IA</button>
      <button type="button" class="ajuda" data-ajuda="studio-custo-ia"></button>
    </div>
    <div class="studio-ia-selo" id="studioIaSelo" hidden></div>`;
  aplicarIcones(painel);

  if (studio.iaModelos.length) {
    painel.querySelector('#studioModelosDatalist').innerHTML = studio.iaModelos.map((m) => `<option value="${escHtml(m.nome)}"></option>`).join('');
  }

  $('#studioIaApiKey', painel).addEventListener('input', studioAtualizarBotaoEstruturarIa);
  $('#studioIaModelo', painel).addEventListener('input', studioAtualizarBotaoEstruturarIa);
  $('#studioIaCarregarModelos', painel).addEventListener('click', studioCarregarModelosIa);
  $('#studioIaSalvarConfig', painel).addEventListener('click', studioSalvarConfigIa);
  $('#studioIaEstruturar', painel).addEventListener('click', studioEstruturarComIa);
}

function studioAtualizarPainelIa() {
  const ia = (state.project && state.project.ia) || {};
  // Mesma pílula de segredo das abas de credenciais: o painel só recebe a flag
  // `hasIaKey`, e a regra "em branco = mantém o atual" precisa estar escrita na tela.
  dicaSegredo('#studioIaChaveNota', ia.hasIaKey, SEGREDO_MANTEM,
    'Nenhuma chave salva ainda. Sem uma chave válida, "Carregar modelos" e "Estruturar com IA" não funcionam.');
  const campoModelo = $('#studioIaModelo');
  if (campoModelo && !campoModelo.value) campoModelo.value = ia.modelo || '';
  studioCarregarUsoIa();
  studioAtualizarBotaoEstruturarIa();
}

async function studioCarregarUsoIa() {
  const el = $('#studioIaUso');
  if (!el) return;
  if (!isAdmin()) { el.textContent = ''; return; }
  try {
    const uso = await api(`/projects/${state.selectedId}/ia/uso`);
    el.innerHTML = `Custo acumulado em ${escHtml(uso.anoMes)}: <b>US$ ${uso.custoUsd.toFixed(4)}</b> em ${fmtNumBR(uso.chamadas)} chamada(s) este mês.`;
  } catch {
    el.textContent = 'Não foi possível carregar o custo acumulado do mês.';
  }
}

async function studioCarregarModelosIa() {
  const btn = $('#studioIaCarregarModelos');
  const nota = $('#studioIaModelosNota');
  const rotulo = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Carregando…';
  try {
    const r = await api(`/projects/${state.selectedId}/ia/modelos`);
    studio.iaModelos = r.modelos || [];
    const dl = $('#studioModelosDatalist');
    if (dl) dl.innerHTML = studio.iaModelos.map((m) => `<option value="${escHtml(m.nome)}"></option>`).join('');
    nota.textContent = `${studio.iaModelos.length} modelo(s) carregado(s)${r.cache ? ' (em cache)' : ''}. Digite para buscar e escolha um no campo acima.`;
    toast('Modelos carregados.', 'ok');
  } catch (err) {
    nota.textContent = '';
    toast('Não foi possível carregar os modelos: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = rotulo;
    studioAtualizarBotaoEstruturarIa();
  }
}

async function studioSalvarConfigIa() {
  if (!isAdmin()) return;
  const apiKey = $('#studioIaApiKey').value.trim();
  const modeloDigitado = $('#studioIaModelo').value.trim();
  // O campo mostra o NOME do modelo (mais legível); resolve para o ID que a OpenRouter
  // espera quando o nome bate com algo já carregado — senão manda o texto como veio
  // (cobre o caso de colar um id direto, ex.: "deepseek/deepseek-chat-v4-flash").
  const achado = studio.iaModelos.find((m) => m.nome === modeloDigitado || m.id === modeloDigitado);
  const modelo = achado ? achado.id : modeloDigitado;

  const body = { habilitada: true };
  if (apiKey) body.apiKey = apiKey;
  if (modelo) body.modelo = modelo;
  try {
    state.project = await api(`/projects/${state.selectedId}/ia`, { method: 'PUT', body });
    $('#studioIaApiKey').value = '';
    toast('Configuração de IA salva.', 'ok');
    studioAtualizarPainelIa();
  } catch (err) {
    toast('Erro ao salvar a configuração de IA: ' + err.message, 'err');
  }
}

function studioAtualizarBotaoEstruturarIa() {
  const btn = $('#studioIaEstruturar');
  if (!btn) return;
  const ia = (state.project && state.project.ia) || {};
  const modeloOk = $('#studioIaModelo') && $('#studioIaModelo').value.trim();
  btn.disabled = !(isAdmin() && ia.hasIaKey && modeloOk && studio.amostraAtual);
}

async function studioEstruturarComIa() {
  if (!isAdmin()) return;
  if (!studio.amostraAtual) { toast('Escolha uma amostra de trabalho primeiro.', 'warn'); return; }

  const btn = $('#studioIaEstruturar');
  const rotulo = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Estruturando…';

  const body = (studio.amostraAtual.origem === 'capturada' && studio.amostraAtual.amostraId != null)
    ? { amostraId: studio.amostraAtual.amostraId }
    : { amostra: studio.amostraAtual.corpo };

  try {
    const r = await api(`/projects/${state.selectedId}/ia/mapear`, { method: 'POST', body });
    // Cai no MESMO editor da revisão humana, inválido ou não — perder o rascunho por
    // causa de um erro de validação seria o pior resultado possível aqui.
    studioCarregarEdicaoNoDom(r.mapeamento, r.deteccao);
    studio.iaUltimo = r;

    const selo = $('#studioIaSelo');
    selo.hidden = false;
    const custo = r.custo && r.custo.custoUsd != null ? `US$ ${Number(r.custo.custoUsd).toFixed(4)}` : 'custo não informado pela OpenRouter';
    selo.innerHTML = `<span class="badge-dev">gerado por IA — revise antes de salvar</span><span>modelo ${escHtml(r.modelo || '—')} · ${escHtml(custo)}</span>`;

    toast(
      r.validacao.valido
        ? 'Rascunho da IA carregado no editor. Revise antes de salvar.'
        : 'A IA devolveu um rascunho com problemas — os erros aparecem na prévia à direita. Corrija à mão antes de salvar.',
      r.validacao.valido ? 'ok' : 'warn',
      6000
    );
    studioAgendarPreview();
    studioCarregarUsoIa();
  } catch (err) {
    toast('Falha ao estruturar com IA: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = rotulo;
    studioAtualizarBotaoEstruturarIa();
  }
}

// ════════════════════════════════════════════════════════════════════
// Delegação global: "clicar num campo da árvore insere no campo selecionado" e
// "qualquer edição no editor reagenda a prévia" — registrados uma vez no document
// (mesmo padrão de tooltip.js/falhas.js), porque o editor inteiro é reconstruído a
// cada abertura e um listener por elemento se perderia a cada re-render.
// ════════════════════════════════════════════════════════════════════

document.addEventListener('focusin', (e) => {
  const alvo = e.target.closest && e.target.closest('.studio-caminho');
  if (!alvo) return;
  studio.alvoInput = alvo;
  const bar = document.getElementById('studioAlvoBar');
  if (bar) bar.innerHTML = 'Clique num valor da árvore à esquerda para preencher: <b>' + escHtml(alvo.dataset.studioRotulo || alvo.placeholder || 'este campo') + '</b>';
});

document.addEventListener('click', (e) => {
  const leaf = e.target.closest && e.target.closest('.studio-arvore-leaf');
  if (!leaf) return;
  const alvo = studio.alvoInput;
  if (!alvo || !document.body.contains(alvo)) {
    toast('Clique antes num campo do editor (ex.: "de" de uma regra) para escolher onde este caminho entra.', 'warn');
    return;
  }
  const caminho = leaf.dataset.caminho;
  if (alvo.tagName === 'TEXTAREA') alvo.value = alvo.value.trim() ? alvo.value.replace(/\n+$/, '') + '\n' + caminho : caminho;
  else alvo.value = caminho;
  alvo.dispatchEvent(new Event('input', { bubbles: true }));
  alvo.focus();
});

document.addEventListener('input', (e) => {
  if (!e.target.closest || !e.target.closest('#studioEditor')) return;
  if (e.target.classList.contains('studio-transformar')) return; // tratado no 'change' abaixo
  studioAgendarPreview();
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.closest || !el.closest('#studioEditor')) return;
  if (el.classList.contains('studio-transformar')) studioAtualizarArgsDaRegra(el.closest('.studio-regra'));
  studioAgendarPreview();
});
