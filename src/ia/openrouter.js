// Cliente server-side da OpenRouter (https://openrouter.ai) — F5 do plano de
// melhorias: a IA que estrutura payload de webhook, seja como assistente de
// mapeamento (roda uma vez por configuração, 7.3) ou evento a evento (7.4).
//
// Regra que não pode quebrar (I-7): o NAVEGADOR nunca fala com a OpenRouter — a CSP
// `connect-src 'self'` já barra isso, e este módulo é o ÚNICO ponto do backend que
// monta a chamada. BASE_URL é uma CONSTANTE fixa no código-fonte, nunca composta a
// partir de configuração (env, banco, corpo de requisição): nenhum dado vindo de fora
// consegue desviar esta chamada para outro host — mesmo que um dia alguém acrescente
// um campo "urlBase" em algum formulário por engano, ele não teria efeito nenhum aqui.
// Sem dependência npm nova: só o `fetch` global do Node 22.
import { publicBaseUrl } from '../config/env.js';

const HOST_PERMITIDO = 'openrouter.ai';
const BASE_URL = `https://${HOST_PERMITIDO}/api/v1`;

export const TIMEOUT_MODELOS_MS = 10_000;
export const TIMEOUT_MAPEAMENTO_MS = 30_000;
export const TIMEOUT_EVENTO_MS = 15_000;

async function requisitar(caminho, { chave, corpo, timeoutMs }) {
  const controlador = new AbortController();
  const timer = setTimeout(() => controlador.abort(), timeoutMs);
  try {
    return await fetch(`${BASE_URL}${caminho}`, {
      method: corpo ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${chave}`,
        'Content-Type': 'application/json',
        // Cabeçalhos que a OpenRouter recomenda para identificar o app chamador —
        // aparecem no ranking deles e ajudam o suporte a achar a conta; não é segredo.
        'HTTP-Referer': publicBaseUrl(),
        'X-Title': 'Servidor Traker',
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: controlador.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(
        new Error('a OpenRouter demorou demais para responder (timeout) — tente novamente em instantes'),
        { statusCode: 504 }
      );
    }
    throw Object.assign(new Error(`falha de rede ao falar com a OpenRouter: ${err.message}`), { statusCode: 502 });
  } finally {
    clearTimeout(timer);
  }
}

// Traduz o erro cru da OpenRouter numa mensagem que o operador entende e sabe o que
// fazer — nunca um stack trace nem o JSON cru de um terceiro (mesmo espírito de
// src/destinations/erros-explicados.js, só que os códigos aqui são os da OpenRouter,
// não os da Meta/Google).
async function erroHttp(resposta) {
  let corpo;
  try { corpo = await resposta.json(); } catch { corpo = null; }
  const mensagemCrua = corpo?.error?.message || corpo?.message || '';

  if (resposta.status === 401 || resposta.status === 403) {
    return Object.assign(
      new Error('a chave foi recusada pela OpenRouter — confira se ela foi copiada corretamente'),
      { statusCode: 401 }
    );
  }
  if (resposta.status === 402) {
    return Object.assign(
      new Error('a conta da OpenRouter está sem crédito suficiente para esta chamada'),
      { statusCode: 402 }
    );
  }
  if (resposta.status === 404) {
    return Object.assign(
      new Error(`modelo não encontrado na OpenRouter${mensagemCrua ? `: ${mensagemCrua}` : ''}`),
      { statusCode: 404 }
    );
  }
  if (resposta.status === 429) {
    return Object.assign(
      new Error('a OpenRouter limitou as requisições (rate limit) — aguarde um momento e tente de novo'),
      { statusCode: 429 }
    );
  }
  return Object.assign(
    new Error(mensagemCrua ? `a OpenRouter recusou a requisição: ${mensagemCrua}` : `a OpenRouter respondeu com erro (HTTP ${resposta.status})`),
    { statusCode: 502 }
  );
}

// Preço da OpenRouter vem em USD POR TOKEN (string tipo "0.0000002") — casas decimais
// demais para mostrar numa tela. Convertido para "por milhão de tokens", que é como
// praticamente toda documentação de LLM comunica preço hoje.
function precoPorMilhao(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? Number((n * 1_000_000).toFixed(4)) : null;
}

/**
 * Lista enxuta de modelos disponíveis para a chave informada.
 * Ordenada por nome: previsível para busca num <select>, sem depender de um critério
 * de "popularidade" que a própria OpenRouter não expõe de forma estável.
 */
export async function listarModelos(chave) {
  if (!chave) throw Object.assign(new Error('nenhuma chave da OpenRouter configurada'), { statusCode: 400 });

  const resposta = await requisitar('/models', { chave, timeoutMs: TIMEOUT_MODELOS_MS });
  if (!resposta.ok) throw await erroHttp(resposta);

  const dados = await resposta.json();
  const lista = Array.isArray(dados?.data) ? dados.data : [];

  return lista
    .map((m) => ({
      id: m.id,
      nome: m.name || m.id,
      contexto: m.context_length ?? m.top_provider?.context_length ?? null,
      preco_prompt: precoPorMilhao(m.pricing?.prompt),
      preco_resposta: precoPorMilhao(m.pricing?.completion),
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

// Extrai o primeiro `{...}` de um texto que pode vir cercado por ```json ... ``` ou
// por uma frase de abertura ("Aqui está o mapeamento:") mesmo com response_format
// pedido — nem todo modelo obedece à risca.
function tentarParsearJson(texto) {
  const limpo = String(texto || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(limpo);
  } catch {
    const inicio = limpo.indexOf('{');
    const fim = limpo.lastIndexOf('}');
    if (inicio === -1 || fim === -1 || fim <= inicio) return null;
    try { return JSON.parse(limpo.slice(inicio, fim + 1)); } catch { return null; }
  }
}

/**
 * Uma chamada de chat completion. `jsonEsperado` liga `response_format: json_object`
 * (quando o modelo suportar — a OpenRouter ignora o parâmetro em silêncio quando não
 * suporta, então NUNCA confiamos só nele: o texto devolvido é sempre validado) e arma
 * UMA retentativa se o texto não parsear como JSON — o pedido da F5 é "uma
 * retentativa em JSON inválido", não um loop; na segunda falha devolve o erro para
 * quem chamou decidir (o endpoint do painel repassa isso ao operador).
 */
export async function completar(chave, { modelo, system, user, jsonEsperado = false, timeoutMs = TIMEOUT_MAPEAMENTO_MS } = {}) {
  if (!chave) throw Object.assign(new Error('nenhuma chave da OpenRouter configurada'), { statusCode: 400 });
  if (!modelo) throw Object.assign(new Error('nenhum modelo informado'), { statusCode: 400 });

  const mensagensBase = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const tentativasMax = jsonEsperado ? 2 : 1;
  let textoCru = '';
  let usoFinal = { promptTokens: null, completionTokens: null, custoUsd: null };

  for (let tentativa = 1; tentativa <= tentativasMax; tentativa++) {
    const mensagens = tentativa === 1
      ? mensagensBase
      : [...mensagensBase, {
          role: 'user',
          content: 'A resposta anterior não era um JSON válido. Responda SOMENTE com o JSON pedido — sem texto antes ou depois, sem markdown, sem ```.',
        }];

    const resposta = await requisitar('/chat/completions', {
      chave,
      timeoutMs,
      corpo: {
        model: modelo,
        messages: mensagens,
        ...(jsonEsperado && { response_format: { type: 'json_object' } }),
        // Extensão da OpenRouter: pede que a resposta inclua o custo real da chamada
        // em `usage.cost` — sem isso teríamos que estimar a partir do preço por token
        // do modelo, impreciso (o roteamento pode trocar de provedor por trás).
        usage: { include: true },
      },
    });
    if (!resposta.ok) throw await erroHttp(resposta);

    const dados = await resposta.json();
    textoCru = dados?.choices?.[0]?.message?.content ?? '';
    usoFinal = {
      promptTokens: dados?.usage?.prompt_tokens ?? null,
      completionTokens: dados?.usage?.completion_tokens ?? null,
      custoUsd: dados?.usage?.cost ?? null,
    };

    if (!jsonEsperado) return { texto: textoCru, json: null, uso: usoFinal, modelo };

    const json = tentarParsearJson(textoCru);
    if (json !== null) return { texto: textoCru, json, uso: usoFinal, modelo };
  }

  throw Object.assign(
    new Error('a IA não devolveu um JSON válido, mesmo depois de uma nova tentativa — revise o resultado manualmente'),
    { statusCode: 502, textoCru, uso: usoFinal }
  );
}
