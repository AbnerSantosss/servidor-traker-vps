// Interpretador da DSL declarativa do Webhook Studio.
//
// Por que uma DSL e não "cole um pouco de JavaScript": mapeamento vem do BANCO (o
// operador ou a IA da fase F5 salvam um JSON). Código vindo de dado é execução remota
// disfarçada — `eval`/`new Function` sobre uma coluna JSONB é, na prática, permitir que
// quem escreve naquela linha rode o que quiser dentro do processo da API. Por isso a
// lista de transformações é FECHADA (ver TRANSFORMACOES) e o acesso a campo é por um
// leitor de caminho PRÓPRIO — nunca `objeto[chave]` livre vindo de dado não confiável.
//
// Este módulo reproduz, de forma declarativa, tudo que o adaptador hardcoded
// `codigo-vencedor` (src/ingest/adaptadores.js) faz na unha — ver a prova de
// suficiência em test/webhook-studio.test.js. Por isso importa os mesmos primitivos de
// lá (texto, vazio, ipPublico, separarNome, deMenorParaMaior, unixDeIso, clientIdDoGa):
// a REGRA é a mesma, só muda quem a declara (código fixo vs. JSON configurável).
import { texto, vazio, ipPublico, separarNome, deMenorParaMaior, unixDeIso, clientIdDoGa } from './adaptadores.js';

// ---------------------------------------------------------------- acesso seguro a caminho

// Segmentos que NUNCA podem ser atravessados: são a superfície clássica de poluição de
// protótipo (`a.__proto__.b`, `a.constructor.prototype.x`). Como o caminho vem de uma
// coluna JSONB gravada pelo painel (ou, na F5, por uma IA), tratamos como dado hostil
// por padrão — não importa que hoje só admin escreva lá.
const SEGMENTOS_PROIBIDOS = new Set(['__proto__', 'constructor', 'prototype']);

function dividirCaminho(caminho) {
  return String(caminho ?? '').split('.').filter((s) => s !== '');
}

/**
 * Lê `a.b.0.c` de um objeto sem nunca atravessar __proto__/constructor/prototype e sem
 * lançar quando o caminho não existe (devolve undefined). Índice de array funciona
 * porque `objeto['0']` já resolve para `objeto[0]` em JS — não precisa de parsing extra.
 */
export function obterCaminho(objeto, caminho) {
  let atual = objeto;
  for (const seg of dividirCaminho(caminho)) {
    if (SEGMENTOS_PROIBIDOS.has(seg)) return undefined;
    if (atual === undefined || atual === null) return undefined;
    atual = atual[seg];
  }
  return atual;
}

/**
 * Escreve em `a.b.c`, criando os objetos intermediários que faltarem. `objeto` é
 * SEMPRE um literal criado por nós (o "Evento Interno" em construção), nunca o corpo
 * de entrada — então criar `atual[seg] = {}` é seguro mesmo com `seg` vindo de dado,
 * desde que barrado pela mesma lista proibida usada na leitura.
 * `valor === undefined` não escreve nada (é assim que o resto do repositório trata
 * campo ausente — "melhor faltar do que mandar chave vazia", ver adaptadores.js).
 */
export function definirCaminho(objeto, caminho, valor) {
  if (valor === undefined) return objeto;
  const segmentos = dividirCaminho(caminho);
  if (!segmentos.length) return objeto;

  let atual = objeto;
  for (let i = 0; i < segmentos.length - 1; i++) {
    const seg = segmentos[i];
    if (SEGMENTOS_PROIBIDOS.has(seg)) return objeto; // caminho malicioso: ignora em silêncio, não derruba o resto
    if (typeof atual[seg] !== 'object' || atual[seg] === null || Array.isArray(atual[seg])) {
      atual[seg] = {};
    }
    atual = atual[seg];
  }
  const ultimo = segmentos[segmentos.length - 1];
  if (!SEGMENTOS_PROIBIDOS.has(ultimo)) atual[ultimo] = valor;
  return objeto;
}

// ---------------------------------------------------------------- lista fechada de transformações

/**
 * Lista fechada. Transformação fora daqui é RECUSADA na validação (nunca ignorada em
 * silêncio — um mapeamento com transformação desconhecida não é salvo).
 *
 * `ga_client_id`, `marcador_presenca` e `contagem` NÃO estavam no enunciado original —
 * foram acrescentadas durante a prova de suficiência porque sem elas o adaptador
 * `codigo-vencedor` não é 100% reproduzível pela DSL (ver relato no final do trabalho):
 *   - `ga_client_id`: extrai o client_id do cookie `_ga` (formato `GA1.1.<id>.<ts>`) —
 *     mesma lógica de `clientIdDoGa` em adaptadores.js.
 *   - `marcador_presenca`: emite uma constante SE E SOMENTE SE o campo de origem não
 *     está vazio (ex.: `content_type: 'product'` só quando há `productIds`).
 *   - `contagem`: tamanho de uma lista (ex.: `num_items` a partir de `productIds`).
 */
export const TRANSFORMACOES = [
  'texto', 'numero', 'centavos_para_reais', 'separar_nome', 'unix_de_iso', 'booleano',
  'constante', 'mapear_valores', 'primeiro_preenchido', 'ip_publico', 'minusculo',
  'apenas_digitos', 'ga_client_id', 'marcador_presenca', 'contagem',
];

// Transformações que NÃO seguem o padrão "lê um caminho, devolve um valor": mudam a
// forma da regra (múltiplos `de`, nenhum `de`, ou saída em mais de um campo). Tratadas
// à parte em aplicarMapeamento/valorDaRegra.
const TRANSFORMACOES_ESPECIAIS = new Set(['constante', 'primeiro_preenchido', 'separar_nome']);

function aplicarTransformacaoSimples(nome, valor, args = {}) {
  switch (nome) {
    case 'texto':
      return texto(valor);
    case 'numero': {
      const n = Number(valor);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'centavos_para_reais':
      return deMenorParaMaior(valor);
    case 'unix_de_iso':
      return unixDeIso(valor);
    case 'booleano': {
      if (typeof valor === 'boolean') return valor;
      if (vazio(valor)) return undefined;
      const v = String(valor).trim().toLowerCase();
      if (['true', '1', 'sim', 's', 'yes', 'y'].includes(v)) return true;
      if (['false', '0', 'nao', 'não', 'n', 'no'].includes(v)) return false;
      return undefined;
    }
    case 'mapear_valores': {
      // Uso GERAL (fora do bloco `evento`, que tem sua própria semântica mais estrita
      // — ver derivarNomeEvento): dicionário simples chave->valor, com fallback opcional.
      if (vazio(valor)) return args.padrao;
      const dicionario = args.dicionario || {};
      const achado = dicionario[String(valor)] ?? dicionario[String(valor).toLowerCase()];
      return achado !== undefined ? achado : args.padrao;
    }
    case 'ip_publico':
      return ipPublico(valor);
    case 'minusculo':
      return vazio(valor) ? undefined : String(valor).trim().toLowerCase();
    case 'apenas_digitos': {
      if (vazio(valor)) return undefined;
      const d = String(valor).replace(/\D+/g, '');
      return d || undefined;
    }
    case 'ga_client_id':
      return clientIdDoGa(valor);
    case 'marcador_presenca':
      return vazio(valor) ? args.valorAusente : args.valor;
    case 'contagem':
      return Array.isArray(valor) && valor.length ? valor.length : undefined;
    default:
      // Não deveria acontecer em produção (validarMapeamento barra isso antes de
      // salvar) — mas se um mapeamento antigo/corrompido chegar aqui, falha alto e
      // claro em vez de produzir um evento com campo faltando em silêncio.
      throw new Error(`transformação desconhecida: "${nome}"`);
  }
}

function valorDaRegra(corpo, regra) {
  const { de, transformar, args = {} } = regra;
  if (transformar === 'constante') return args.valor;
  if (transformar === 'primeiro_preenchido') {
    const caminhos = Array.isArray(de) ? de : [de];
    for (const caminho of caminhos) {
      const v = obterCaminho(corpo, caminho);
      if (!vazio(v)) return typeof v === 'string' ? v.trim() : v;
    }
    return args.padrao; // nenhum caminho preenchido: cai no fallback (ex.: currency -> 'BRL')
  }
  const bruto = obterCaminho(corpo, de);
  if (transformar === 'separar_nome') return separarNome(bruto);
  return aplicarTransformacaoSimples(transformar, bruto, args);
}

// ---------------------------------------------------------------- bloco `evento`

// Marcador usado dentro do dicionário do bloco `evento` para dizer "este nome de
// origem só vira uma coisa OU outra dependendo de pagamento confirmado" — é a forma
// declarativa do `pago ? 'purchase' : 'checkout_concluido'` que existe hoje em
// nomeDoEvento (adaptadores.js) para `checkout.session.completed`. Continua sendo só
// DADO (duas strings dentro de um objeto), nunca código.
function ehCondicional(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

function condicaoPagamentoAtendida(corpo, condicao) {
  if (!condicao?.de || !Array.isArray(condicao.valoresConfirmados)) return false;
  const statusBruto = String(obterCaminho(corpo, condicao.de) ?? '').toLowerCase();
  return condicao.valoresConfirmados.map((v) => String(v).toLowerCase()).includes(statusBruto);
}

function slugificarEvento(bruto) {
  return String(bruto || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Deriva `event_name`. Espelha nomeDoEvento (adaptadores.js) termo a termo:
 *   1. procura o valor CRU no dicionário (case-insensitive);
 *   2. entrada condicional `{ sePago, senaoPago }` resolve pela condicaoPagamento;
 *   3. nada na tabela: pagamento confirmado promove a `purchase`; senão vira um nome
 *      legível (slug) — nunca some em silêncio.
 *
 * A REGRA DURA mora aqui e em validarMapeamento: o único jeito de este código devolver
 * `'purchase'` é (a) uma entrada literal do dicionário valendo exatamente `'purchase'`
 * — curada por quem configurou o adaptador, sabendo o que a origem envia — ou (b) uma
 * `condicaoPagamento` batendo (branch `sePago`, ou o fallback do passo 3). Sem
 * `condicaoPagamento` declarada, o passo 3 NUNCA promove a `purchase` (condicaoPagamentoAtendida
 * devolve false sem uma condição válida) — ou seja, sem confirmação de pagamento no
 * mapeamento, `purchase` só sai por entrada explícita do dicionário.
 */
export function derivarNomeEvento(corpo, blocoEvento) {
  const bloco = blocoEvento || {};
  const bruto = texto(obterCaminho(corpo, bloco.de)) || '';
  const chave = bruto.toLowerCase();

  const dicionario = bloco.args?.dicionario || {};
  const dicionarioMin = {};
  for (const [k, v] of Object.entries(dicionario)) dicionarioMin[String(k).toLowerCase()] = v;

  const pago = bloco.condicaoPagamento ? condicaoPagamentoAtendida(corpo, bloco.condicaoPagamento) : false;

  let nome = dicionarioMin[chave];
  if (ehCondicional(nome)) nome = pago ? nome.sePago : nome.senaoPago;

  if (nome === undefined) nome = pago ? 'purchase' : slugificarEvento(bruto);

  return nome || 'custom_event';
}

// ---------------------------------------------------------------- detecção

/**
 * `deteccao = { obrigatorias: [...], qualquerUma: [...] }` — todas as `obrigatorias`
 * precisam estar presentes (AND) e, se `qualquerUma` não for vazia, PELO MENOS UMA
 * delas precisa estar presente (OR). Reproduz a forma do `detectar` do
 * `codigo-vencedor`: `event` + `eventId` obrigatórios, e pelo menos um de `lead`/
 * `attribution`.
 */
export function detectarComMapeamento(corpo, deteccao) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return false;
  const obrig = Array.isArray(deteccao?.obrigatorias) ? deteccao.obrigatorias : [];
  const qualquer = Array.isArray(deteccao?.qualquerUma) ? deteccao.qualquerUma : [];

  for (const caminho of obrig) {
    if (obterCaminho(corpo, caminho) === undefined) return false;
  }
  if (qualquer.length) {
    const algumaPresente = qualquer.some((caminho) => {
      const v = obterCaminho(corpo, caminho);
      return v !== undefined && v !== null;
    });
    if (!algumaPresente) return false;
  }
  return obrig.length + qualquer.length > 0; // deteccao vazia nunca "reconhece" nada
}

// ---------------------------------------------------------------- aplicação do mapeamento

/**
 * Executa `mapeamento = { regras: [...], evento: {...} }` contra um payload e devolve
 * `{ evento, diagnostico }`. `evento` é o "Evento Interno" pronto para seguir o mesmo
 * caminho de um adaptador hardcoded (ver adaptarPayload). `diagnostico` lista quais
 * campos de correspondência foram preenchidos e quais ficaram vazios — é o que a UI de
 * mapeamento (preview) mostra ao operador antes de ele aceitar.
 */
export function aplicarMapeamento(corpo, mapeamento) {
  const b = corpo && typeof corpo === 'object' ? corpo : {};
  const m = mapeamento || {};

  const evento = {
    event_name: derivarNomeEvento(b, m.evento),
    event_id: undefined,
    event_time: undefined,
    action_source: 'website',
    event_source_url: undefined,
    user_id: undefined,
    user_data: {},
    custom_data: {},
  };

  const diagnostico = { camposPreenchidos: [], camposVazios: [] };

  for (const regra of Array.isArray(m.regras) ? m.regras : []) {
    if (!regra || !regra.para) continue;

    if (regra.transformar === 'separar_nome') {
      const bruto = obterCaminho(b, regra.de);
      const partes = separarNome(bruto);
      let algo = false;
      if (partes.first_name !== undefined) { definirCaminho(evento, `${regra.para}.first_name`, partes.first_name); algo = true; }
      if (partes.last_name !== undefined) { definirCaminho(evento, `${regra.para}.last_name`, partes.last_name); algo = true; }
      (algo ? diagnostico.camposPreenchidos : diagnostico.camposVazios).push(regra.para);
      continue;
    }

    const valor = valorDaRegra(b, regra);
    if (valor === undefined) {
      diagnostico.camposVazios.push(regra.para);
      continue;
    }
    definirCaminho(evento, regra.para, valor);
    diagnostico.camposPreenchidos.push(regra.para);
  }

  return { evento, diagnostico };
}

// ---------------------------------------------------------------- validação do mapeamento

/**
 * Recusa salvar um mapeamento inválido — em especial a REGRA DURA (ver
 * derivarNomeEvento): o bloco `evento` só pode existir com `transformar: 'mapear_valores'`
 * (nenhuma outra transformação chega perto de `event_name` — um `texto`/`primeiro_preenchido`
 * passaria o valor cru adiante sem checagem nenhuma, e se um dia esse valor cru for
 * literalmente "purchase", viraria compra sem qualquer confirmação de pagamento).
 * Dentro do dicionário: entradas condicionais `{ senaoPago: 'purchase' }` são sempre
 * proibidas (isso seria "purchase quando NÃO há pagamento confirmado" — o oposto da
 * regra), e `{ sePago: 'purchase' }` exige uma `condicaoPagamento` declarada.
 */
export function validarMapeamento(mapeamento) {
  const erros = [];
  const m = mapeamento && typeof mapeamento === 'object' ? mapeamento : {};

  const regras = Array.isArray(m.regras) ? m.regras : [];
  regras.forEach((regra, i) => {
    if (!regra || typeof regra !== 'object') { erros.push(`regra ${i}: deve ser um objeto`); return; }
    const rotulo = regra.para ? `"${regra.para}"` : `#${i}`;
    if (!regra.para) erros.push(`regra ${rotulo}: campo "para" é obrigatório`);
    if (!TRANSFORMACOES.includes(regra.transformar)) {
      erros.push(`regra ${rotulo}: transformação desconhecida "${regra.transformar}" — lista fechada: ${TRANSFORMACOES.join(', ')}`);
    } else if (!TRANSFORMACOES_ESPECIAIS.has(regra.transformar) && !regra.de) {
      erros.push(`regra ${rotulo}: campo "de" é obrigatório para a transformação "${regra.transformar}"`);
    } else if (regra.transformar === 'primeiro_preenchido' && !regra.de) {
      erros.push(`regra ${rotulo}: "primeiro_preenchido" precisa de "de" com uma lista de caminhos`);
    } else if (regra.transformar === 'separar_nome' && !regra.de) {
      erros.push(`regra ${rotulo}: "separar_nome" precisa de "de"`);
    }
  });

  const evento = m.evento || {};
  if (!evento || typeof evento !== 'object' || !evento.de) {
    erros.push('bloco "evento": campo "de" é obrigatório (caminho do nome bruto do evento)');
  }
  if (evento.transformar !== 'mapear_valores') {
    erros.push(
      `bloco "evento": transformação "${evento.transformar}" não é permitida — só "mapear_valores" pode derivar ` +
      'o nome do evento (regra dura contra "purchase" acidental; ver adaptadores.js: nomeDoEvento)'
    );
  } else {
    const dicionario = evento.args?.dicionario || {};
    if (typeof dicionario !== 'object' || Array.isArray(dicionario)) {
      erros.push('bloco "evento": args.dicionario deve ser um objeto {evento_de_origem: nome_canonico}');
    } else {
      for (const [chaveDic, valorDic] of Object.entries(dicionario)) {
        if (ehCondicional(valorDic)) {
          if (valorDic.senaoPago === 'purchase') {
            erros.push(`bloco "evento": entrada "${chaveDic}" mapeia para "purchase" mesmo SEM pagamento confirmado — proibido`);
          }
          if (valorDic.sePago === 'purchase' && !evento.condicaoPagamento) {
            erros.push(`bloco "evento": entrada "${chaveDic}" depende de pagamento confirmado, mas "condicaoPagamento" não foi declarada`);
          }
        }
      }
    }
  }
  if (evento.condicaoPagamento) {
    const cond = evento.condicaoPagamento;
    if (!cond.de || !Array.isArray(cond.valoresConfirmados) || !cond.valoresConfirmados.length) {
      erros.push('bloco "evento": condicaoPagamento precisa de "de" e uma lista não vazia de "valoresConfirmados"');
    }
  }

  return { valido: erros.length === 0, erros };
}

/**
 * `deteccao = { obrigatorias, qualquerUma }` — validada à parte de `mapeamento` porque
 * mora em coluna própria (`adaptadores_projeto.deteccao`). Exige pelo menos 2 chaves
 * discriminantes: é a mitigação (Plano-Melhorias-Painel.md, seção 13) contra um
 * adaptador dinâmico com detecção fraca demais "roubando" payloads de outro formato.
 */
export function validarDeteccao(deteccao) {
  const erros = [];
  const d = deteccao && typeof deteccao === 'object' ? deteccao : {};
  const obrig = Array.isArray(d.obrigatorias) ? d.obrigatorias : [];
  const qualquer = Array.isArray(d.qualquerUma) ? d.qualquerUma : [];
  if (obrig.length + qualquer.length < 2) {
    erros.push('detecção fraca: são necessárias ao menos 2 chaves discriminantes no total (obrigatorias + qualquerUma)');
  }
  return { valido: erros.length === 0, erros };
}

// ---------------------------------------------------------------- sugestão heurística (sem IA)

// Casamento por nome de campo (normalizado: minúsculo, sem separador) -> regra sugerida.
// A F5 troca isso por uma chamada à IA, mas devolve exatamente esta mesma FORMA de
// resposta (ver sugerirMapeamento) — o editor do painel não precisa saber qual dos
// dois produziu o rascunho.
const HEURISTICAS_CAMPO = [
  { padrao: /^(email|e-?mail|customeremail|useremail)$/, para: 'user_data.email', transformar: 'texto' },
  { padrao: /^(phone|telefone|celular|whatsapp|tel|customerphone)$/, para: 'user_data.phone', transformar: 'texto' },
  { padrao: /^(cpf|taxid|documento|cnpj)$/, para: 'user_data.external_id', transformar: 'apenas_digitos' },
  { padrao: /^(orderid|pedido|pedidoid|transactionid|paymentid|purchaseid)$/, para: 'custom_data.order_id', transformar: 'texto' },
  { padrao: /^(value|amount|total|valor|preco|price|totalvalue)$/, para: 'custom_data.value', transformar: 'numero' },
  { padrao: /^(currency|moeda)$/, para: 'custom_data.currency', transformar: 'texto' },
  { padrao: /^gclid$/, para: 'user_data.gclid', transformar: 'texto' },
  { padrao: /^fbclid$/, para: 'user_data.fbclid', transformar: 'texto' },
  { padrao: /^fbp$/, para: 'user_data.fbp', transformar: 'texto' },
  { padrao: /^fbc$/, para: 'user_data.fbc', transformar: 'texto' },
  { padrao: /^utmsource$/, para: 'user_data.utm_source', transformar: 'texto' },
  { padrao: /^utmmedium$/, para: 'user_data.utm_medium', transformar: 'texto' },
  { padrao: /^utmcampaign$/, para: 'user_data.utm_campaign', transformar: 'texto' },
  { padrao: /^(ip|ipaddress|clientip)$/, para: 'user_data.client_ip_address', transformar: 'ip_publico' },
  { padrao: /^(useragent|clientuseragent)$/, para: 'user_data.client_user_agent', transformar: 'texto' },
];

const CAMPO_NOME_RE = /^(nome|name|fullname|customername|clientname)$/;
const CAMPO_EVENTO_RE = /^(event|evento|eventname|type|tipo)$/;
const CAMPO_STATUS_RE = /^(status|situacao|paymentstatus|statuspagamento|paymentstate)$/;

function normalizarChave(k) {
  return String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Percorre o objeto (profundidade limitada) coletando { caminho, chaveNormalizada }
// de cada folha — é sobre essa lista que a heurística casa os nomes de campo.
function coletarFolhas(valor, prefixo, profundidade, saida) {
  if (profundidade > 5 || saida.length > 200) return;
  if (Array.isArray(valor)) {
    if (valor.length) coletarFolhas(valor[0], prefixo, profundidade + 1, saida);
    return;
  }
  if (valor && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) {
      const caminho = prefixo ? `${prefixo}.${k}` : k;
      coletarFolhas(v, caminho, profundidade + 1, saida);
    }
    return;
  }
  const partes = prefixo.split('.');
  saida.push({ caminho: prefixo, chaveNormalizada: normalizarChave(partes[partes.length - 1]) });
}

/**
 * Mapeamento inicial HEURÍSTICO (sem IA — casamento de nome de campo por
 * similaridade). Nunca produz um `evento` capaz de gerar `purchase` sozinho: o
 * dicionário nasce vazio e sem `condicaoPagamento` — só um humano (ou a IA da F5, que
 * também não salva sozinha) decide isso na revisão. `sugestaoCampoEvento`/
 * `sugestaoCampoStatus` são só DICAS informativas para a UI destacar campos prováveis,
 * nunca entram no mapeamento executável.
 */
export function sugerirMapeamento(corpoAmostra) {
  const folhas = [];
  coletarFolhas(corpoAmostra || {}, '', 0, folhas);

  const regras = [];
  const camposReconhecidos = [];
  const camposNaoReconhecidos = [];
  const usados = new Set(); // não sugere duas regras para o mesmo campo "para"
  let campoNomeCompleto = null;
  let campoEvento = null;
  let campoStatus = null;

  for (const { caminho, chaveNormalizada } of folhas) {
    const heuristica = HEURISTICAS_CAMPO.find((h) => h.padrao.test(chaveNormalizada));
    if (heuristica && !usados.has(heuristica.para)) {
      regras.push({ de: caminho, para: heuristica.para, transformar: heuristica.transformar });
      usados.add(heuristica.para);
      camposReconhecidos.push(caminho);
      continue;
    }
    if (!campoNomeCompleto && CAMPO_NOME_RE.test(chaveNormalizada)) {
      regras.push({ de: caminho, para: 'user_data', transformar: 'separar_nome' });
      campoNomeCompleto = caminho;
      camposReconhecidos.push(caminho);
      continue;
    }
    if (!campoEvento && CAMPO_EVENTO_RE.test(chaveNormalizada)) { campoEvento = caminho; }
    if (!campoStatus && CAMPO_STATUS_RE.test(chaveNormalizada)) { campoStatus = caminho; }
    camposNaoReconhecidos.push(caminho);
  }

  // Chaves discriminantes: as folhas de nível 1 (topo do payload), preferindo as mais
  // específicas (nome mais longo tende a ser menos genérico que "id"/"tipo").
  const topo = [...new Set(folhas.map((f) => f.caminho.split('.')[0]))].sort((a, b) => b.length - a.length);
  const deteccao = { obrigatorias: topo.slice(0, 2), qualquerUma: topo.slice(2, 3) };

  const mapeamento = {
    regras,
    evento: {
      de: campoEvento || 'event',
      transformar: 'mapear_valores',
      args: { dicionario: {} },
    },
  };

  return {
    deteccao,
    mapeamento,
    diagnostico: {
      camposReconhecidos,
      camposNaoReconhecidos,
      sugestaoCampoEvento: campoEvento,
      sugestaoCampoStatus: campoStatus,
    },
  };
}
