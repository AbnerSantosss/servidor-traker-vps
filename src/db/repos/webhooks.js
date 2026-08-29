// Webhook Studio: captura de amostras de payloads não reconhecidos (Inbox de
// webhooks) e CRUD dos adaptadores dinâmicos por projeto.
// Ver Plano-Melhorias-Painel.md, seção 7, e docs/15-convencoes-do-painel.md.
import crypto from 'node:crypto';
import { query } from '../pool.js';
import { hashEmail, hashPhone, hashName, sha256Hex } from '../../config/crypto.js';

// ---------------------------------------------------------------- tetos de captura

// A amostra é CONFORTO DE OPERAÇÃO, não dado de negócio: sem teto, uma origem de alto
// volume que nenhum adaptador reconhece enche a tabela em horas. Três tetos
// complementares (ver comentário da migração 004_webhook_studio.sql):
export const MAX_AMOSTRAS_POR_DIA = 50;      // por projeto, por dia corrido
export const MAX_AMOSTRAS_POR_HASH = 5;      // por projeto, por hash_estrutura
export const MAX_AMOSTRAS_POR_PROJETO = 500; // retenção total — corta as mais antigas

// ---------------------------------------------------------------- máscara de PII

// Nomes de campo que, por si só, já denunciam o tipo de dado — mascarados mesmo que o
// VALOR não bata em nenhum regex (ex.: telefone gravado sem formatação nenhuma, nome
// de campo em outro idioma). "Erra para o lado de mascarar demais" (I-8).
const CHAVE_EMAIL_RE = /email|mail/;
const CHAVE_TELEFONE_RE = /telefone|phone|celular|whatsapp|^tel$|^ph$/;
const CHAVE_NOME_RE = /nome|name/;
const CHAVE_DOCUMENTO_RE = /cpf|cnpj|taxid|documento/;
// Não é PII no sentido do LGPD, mas é segredo — se um payload de terceiro trouxer um
// campo desses embutido (assinatura, api key), ele não pode sobreviver na amostra que
// o painel exibe. Redação simples (não hash): o operador só precisa saber que ali
// havia um segredo, não precisa do valor nem do hash dele.
const CHAVE_SEGREDO_RE = /senha|password|secret|token|authorization|apikey|api_key|cartao|card|cvv/;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CPF_RE = /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/;
const CNPJ_RE = /^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/;
// Telefone: aceito quando FORMATADO como telefone (tem separador comum) — dígito puro
// sem contexto de chave é tratado só quando a CHAVE já sugere telefone (acima), para
// não mascarar todo campo numérico de 10-13 dígitos (um order_id também tem esse
// tamanho) só porque "parece" um telefone.
const TELEFONE_FORMATADO_RE = /^\+?\d[\d\s().-]{7,18}\d$/;

function aplicarHash(fn, valor) {
  const h = fn(valor);
  return h || '[oculto]';
}

function mascararValor(valor, chaveNormalizada) {
  if (typeof valor !== 'string') return valor; // número/boolean/null não carregam PII de texto
  const v = valor.trim();
  if (!v) return valor;

  if (CHAVE_SEGREDO_RE.test(chaveNormalizada)) return '[oculto]';
  if (CHAVE_EMAIL_RE.test(chaveNormalizada) || EMAIL_RE.test(v)) return aplicarHash(hashEmail, v);
  if (CHAVE_DOCUMENTO_RE.test(chaveNormalizada) || CPF_RE.test(v) || CNPJ_RE.test(v)) {
    const digitos = v.replace(/\D/g, '') || v;
    return sha256Hex(digitos);
  }
  if (CHAVE_NOME_RE.test(chaveNormalizada)) return aplicarHash(hashName, v);
  if (CHAVE_TELEFONE_RE.test(chaveNormalizada) && v.replace(/\D/g, '').length >= 8) {
    return aplicarHash(hashPhone, v);
  }
  if (TELEFONE_FORMATADO_RE.test(v)) {
    const digitos = v.replace(/\D/g, '');
    if (digitos.length >= 10 && digitos.length <= 13) return aplicarHash(hashPhone, v);
  }
  return valor;
}

const PROFUNDIDADE_MAXIMA_MASCARA = 8;

function mascararRecursivo(valor, chaveNormalizada, profundidade) {
  if (profundidade > PROFUNDIDADE_MAXIMA_MASCARA) return '[profundidade-excedida]';
  if (Array.isArray(valor)) return valor.map((v) => mascararRecursivo(v, chaveNormalizada, profundidade + 1));
  if (valor && typeof valor === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(valor)) {
      out[k] = mascararRecursivo(v, String(k).toLowerCase(), profundidade + 1);
    }
    return out;
  }
  if (typeof valor === 'string') return mascararValor(valor, chaveNormalizada);
  return valor;
}

/**
 * Mascara PII de um payload de formato ARBITRÁRIO (não o Evento Interno canônico —
 * por isso não dá para reaproveitar `redactForStorage` de normalize.js direto, que só
 * sabe mascarar os campos fixos de `user_data`). Reaproveita, sim, as MESMAS funções
 * de hash de src/config/crypto.js que `redactForStorage` usa (hashEmail/hashPhone/
 * hashName/sha256Hex) — o que muda aqui é só COMO elas são aplicadas: por
 * varredura recursiva de chave+valor em vez de por campo fixo.
 */
export function mascararAmostra(corpo) {
  if (!corpo || typeof corpo !== 'object') return {};
  return mascararRecursivo(corpo, '', 0);
}

// ---------------------------------------------------------------- hash de ESTRUTURA

const PROFUNDIDADE_MAXIMA_ESTRUTURA = 8;

function coletarCaminhos(valor, prefixo, profundidade, caminhos) {
  if (profundidade > PROFUNDIDADE_MAXIMA_ESTRUTURA) return;
  if (Array.isArray(valor)) {
    // O índice não entra no caminho: um array de 1 item e um de 30 têm a MESMA
    // estrutura — o que importa para o hash é a FORMA de um elemento, não a contagem.
    if (valor.length) coletarCaminhos(valor[0], `${prefixo}[]`, profundidade + 1, caminhos);
    else caminhos.push(`${prefixo}[]`);
    return;
  }
  if (valor && typeof valor === 'object') {
    for (const k of Object.keys(valor).sort()) {
      coletarCaminhos(valor[k], prefixo ? `${prefixo}.${k}` : k, profundidade + 1, caminhos);
    }
    return;
  }
  caminhos.push(prefixo || '(raiz)');
}

/**
 * Hash do FORMATO do payload — conjunto ORDENADO de caminhos de chave, sem valores.
 * Dois payloads com a mesma estrutura (mesmos campos, mesmo aninhamento) mas valores
 * diferentes produzem o MESMO hash — é o que permite ao painel agrupar "12 webhooks do
 * mesmo formato" em vez de mostrar 12 linhas idênticas.
 */
export function hashEstrutura(corpo) {
  const caminhos = [];
  coletarCaminhos(corpo && typeof corpo === 'object' ? corpo : {}, '', 0, caminhos);
  caminhos.sort();
  return crypto.createHash('sha256').update(caminhos.join('|')).digest('hex');
}

// ---------------------------------------------------------------- headers relevantes

// Allowlist estrita: nunca Authorization, nunca Cookie (segredo de sessão/webhook —
// I-7). `x-*` cobre cabeçalhos de assinatura de webhook (ex.: X-Hub-Signature,
// X-Webhook-Signature) sem precisar listar cada provedor.
const HEADERS_EXATOS = new Set(['content-type', 'user-agent']);

function headerRelevante(nome) {
  const n = String(nome).toLowerCase();
  if (n === 'cookie' || n === 'set-cookie' || n === 'authorization') return false;
  return HEADERS_EXATOS.has(n) || n.startsWith('x-');
}

export function headersRelevantes(headers) {
  const out = {};
  for (const [nome, valor] of Object.entries(headers || {})) {
    if (valor === undefined || valor === null) continue;
    if (!headerRelevante(nome)) continue;
    out[String(nome).toLowerCase()] = String(valor).slice(0, 500);
  }
  return out;
}

// ---------------------------------------------------------------- captura

/**
 * Captura uma amostra de um payload que nenhum adaptador reconheceu (ou que só um
 * adaptador em modo SOMBRA reconheceria — ver `sombra` em adaptarPayload).
 *
 * SIDE-EFFECT ISOLADO por design: quem chama (a ingestão, quando existir o ponto de
 * integração — ver relato de wiring pendente) precisa envolver em try/catch e nunca
 * deixar uma falha aqui atrasar ou derrubar a resposta do webhook. A amostra é
 * conforto de operação; o evento é a função crítica do sistema (docs/15).
 *
 * Aplica os tetos de captura ANTES de gravar (nunca depois) — um projeto com uma única
 * origem de alto volume não pode encher a tabela em poucas horas.
 */
export async function capturarAmostra({ projectId, corpo, formatoDetectado = null, headers = {} }) {
  if (!projectId) return null;

  const bodyMascarado = mascararAmostra(corpo);
  const hash = hashEstrutura(corpo);
  const headersRel = headersRelevantes(headers);

  const { rows: diaRows } = await query(
    `SELECT COUNT(*)::int AS total FROM webhook_amostras
      WHERE project_id = $1 AND received_at >= now() - interval '1 day'`,
    [projectId]
  );
  if ((diaRows[0]?.total || 0) >= MAX_AMOSTRAS_POR_DIA) return null;

  const { rows: hashRows } = await query(
    `SELECT COUNT(*)::int AS total FROM webhook_amostras WHERE project_id = $1 AND hash_estrutura = $2`,
    [projectId, hash]
  );
  if ((hashRows[0]?.total || 0) >= MAX_AMOSTRAS_POR_HASH) return null;

  const { rows } = await query(
    `INSERT INTO webhook_amostras (project_id, body_mascarado, formato_detectado, headers_relevantes, hash_estrutura)
          VALUES ($1, $2::jsonb, $3, $4::jsonb, $5)
       RETURNING *`,
    [projectId, JSON.stringify(bodyMascarado), formatoDetectado, JSON.stringify(headersRel), hash]
  );

  // Retenção: corta o excedente além do teto total, sempre as mais antigas primeiro.
  // Roda a cada inserção em vez de um cron à parte — mais uma peça de infra evitada.
  await query(
    `DELETE FROM webhook_amostras
      WHERE project_id = $1
        AND id NOT IN (
          SELECT id FROM webhook_amostras WHERE project_id = $1 ORDER BY received_at DESC LIMIT $2
        )`,
    [projectId, MAX_AMOSTRAS_POR_PROJETO]
  );

  return rows[0];
}

export async function obterAmostraPorId(projectId, id) {
  if (!Number.isInteger(id)) return null;
  const { rows } = await query('SELECT * FROM webhook_amostras WHERE project_id = $1 AND id = $2', [projectId, id]);
  return rows[0] || null;
}

export async function excluirAmostra(projectId, id) {
  if (!Number.isInteger(id)) return false;
  const { rowCount } = await query('DELETE FROM webhook_amostras WHERE project_id = $1 AND id = $2', [projectId, id]);
  return rowCount > 0;
}

/**
 * Amostras agrupadas por `hash_estrutura` — uma linha por FORMATO distinto, não uma
 * por webhook recebido (ver comentário de hashEstrutura). `amostra_representativa` é a
 * mais recente de cada grupo; é o corpo mascarado que a UI de mapeamento usa como
 * ponto de partida.
 */
export async function listarAmostrasAgrupadas(projectId, { limit = 50 } = {}) {
  const { rows: agregados } = await query(
    `SELECT hash_estrutura, COUNT(*)::int AS quantidade,
            MIN(received_at) AS primeira_em, MAX(received_at) AS ultima_em
       FROM webhook_amostras
      WHERE project_id = $1
      GROUP BY hash_estrutura`,
    [projectId]
  );
  if (!agregados.length) return [];

  const { rows: representantes } = await query(
    `SELECT DISTINCT ON (hash_estrutura) *
       FROM webhook_amostras
      WHERE project_id = $1
      ORDER BY hash_estrutura, received_at DESC`,
    [projectId]
  );
  const porHash = Object.fromEntries(representantes.map((r) => [r.hash_estrutura, r]));

  return agregados
    .map((a) => {
      const rep = porHash[a.hash_estrutura];
      return {
        hash_estrutura: a.hash_estrutura,
        quantidade: a.quantidade,
        primeira_em: a.primeira_em,
        ultima_em: a.ultima_em,
        amostra_representativa: rep && {
          id: rep.id,
          received_at: rep.received_at,
          formato_detectado: rep.formato_detectado,
          body_mascarado: rep.body_mascarado,
          headers_relevantes: rep.headers_relevantes,
          processada: rep.processada,
        },
      };
    })
    .sort((a, b) => new Date(b.ultima_em) - new Date(a.ultima_em))
    .slice(0, limit);
}

// ---------------------------------------------------------------- cache de adaptadores ativos

// Consultar o banco a cada webhook é inaceitável no caminho quente da ingestão — daí o
// cache em memória. `api` e `worker` são processos separados que não compartilham
// memória (I-11), mas quem CHAMA adaptarPayload é sempre a ingestão, que roda só no
// processo `api` — o mesmo processo que atende as escritas do CRUD abaixo. Por isso a
// invalidação explícita em cada escrita (invalidarCacheAdaptadores) já garante
// consistência imediata; o TTL é só uma rede de segurança para o caso de a escrita ter
// vindo de outra fonte (ex.: script rodando fora do processo da API).
const CACHE_TTL_MS = 30_000;
const cacheAdaptadores = new Map(); // projectId -> { data, expiraEm }

export function invalidarCacheAdaptadores(projectId) {
  cacheAdaptadores.delete(projectId);
}

/**
 * Adaptadores dinâmicos "em jogo" para um projeto: os ATIVOS (rodam de verdade) e os
 * em modo SOMBRA (só observam). Os desligados (`ativo=false` e `modo='nativo'`) não
 * precisam nem chegar à ingestão. Ordem: `id` crescente — ordem de criação, estável
 * (ver o comentário de precedência em adaptarPayload).
 */
export async function carregarAdaptadoresAtivos(projectId) {
  const agora = Date.now();
  const entrada = cacheAdaptadores.get(projectId);
  if (entrada && entrada.expiraEm > agora) return entrada.data;

  const { rows } = await query(
    `SELECT id, nome, deteccao, mapeamento, ativo, modo
       FROM adaptadores_projeto
      WHERE project_id = $1 AND (ativo = true OR modo = 'sombra')
      ORDER BY id ASC`,
    [projectId]
  );
  cacheAdaptadores.set(projectId, { data: rows, expiraEm: agora + CACHE_TTL_MS });
  return rows;
}

// ---------------------------------------------------------------- CRUD de adaptadores

/**
 * Modos válidos de um adaptador do projeto. A lista precisa bater com o CHECK da coluna
 * (`004_webhook_studio.sql`, alargado por `008_ia.sql`).
 *
 * Recusa o desconhecido em vez de cair para 'nativo'. A primeira versão coagia
 * silenciosamente qualquer valor fora da lista, e o efeito era o pior possível: pedir
 * `ia_por_evento` gravava `nativo`, a tela mostrava o modo salvo e nada acontecia — um
 * recurso inteiro desligado sem nenhuma mensagem de erro. Coerção silenciosa em campo que
 * decide comportamento é bug esperando data para aparecer.
 */
const MODOS_VALIDOS = ['nativo', 'sombra', 'ia_por_evento'];

function validarModo(modo) {
  const m = String(modo || 'nativo');
  if (!MODOS_VALIDOS.includes(m)) {
    throw Object.assign(
      new Error(`modo inválido: "${m}" (use ${MODOS_VALIDOS.join(', ')})`),
      { statusCode: 400 }
    );
  }
  return m;
}

export async function listarAdaptadores(projectId) {
  const { rows } = await query('SELECT * FROM adaptadores_projeto WHERE project_id = $1 ORDER BY created_at DESC', [projectId]);
  return rows;
}

export async function obterAdaptador(projectId, id) {
  if (!Number.isInteger(id)) return null;
  const { rows } = await query('SELECT * FROM adaptadores_projeto WHERE project_id = $1 AND id = $2', [projectId, id]);
  return rows[0] || null;
}

function erroNomeDuplicado(err) {
  if (err.code === '23505') return Object.assign(new Error('já existe um adaptador com esse nome neste projeto'), { statusCode: 409 });
  return err;
}

export async function criarAdaptador(projectId, { nome, deteccao, mapeamento, ativo = false, modo = 'nativo', criadoVia = 'manual', createdBy = null }) {
  const nomeLimpo = String(nome || '').trim();
  if (!nomeLimpo) throw Object.assign(new Error('nome é obrigatório'), { statusCode: 400 });
  const modoValidado = validarModo(modo);

  try {
    const { rows } = await query(
      `INSERT INTO adaptadores_projeto (project_id, nome, deteccao, mapeamento, ativo, modo, criado_via, created_by)
            VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8)
         RETURNING *`,
      [
        projectId, nomeLimpo,
        JSON.stringify(deteccao || {}), JSON.stringify(mapeamento || {}),
        Boolean(ativo), modoValidado,
        criadoVia === 'ia' ? 'ia' : 'manual', createdBy,
      ]
    );
    invalidarCacheAdaptadores(projectId);
    return rows[0];
  } catch (err) {
    throw erroNomeDuplicado(err);
  }
}

export async function atualizarAdaptador(projectId, id, patch = {}) {
  const atual = await obterAdaptador(projectId, id);
  if (!atual) return null;

  const nome = patch.nome !== undefined ? String(patch.nome).trim() : atual.nome;
  const deteccao = patch.deteccao !== undefined ? patch.deteccao : atual.deteccao;
  const mapeamento = patch.mapeamento !== undefined ? patch.mapeamento : atual.mapeamento;
  const ativo = patch.ativo !== undefined ? Boolean(patch.ativo) : atual.ativo;
  const modo = patch.modo !== undefined ? validarModo(patch.modo) : atual.modo;

  try {
    const { rows } = await query(
      `UPDATE adaptadores_projeto
          SET nome = $3, deteccao = $4::jsonb, mapeamento = $5::jsonb, ativo = $6, modo = $7, updated_at = now()
        WHERE project_id = $1 AND id = $2
      RETURNING *`,
      [projectId, id, nome, JSON.stringify(deteccao || {}), JSON.stringify(mapeamento || {}), ativo, modo]
    );
    invalidarCacheAdaptadores(projectId);
    return rows[0] || null;
  } catch (err) {
    throw erroNomeDuplicado(err);
  }
}

export async function excluirAdaptador(projectId, id) {
  if (!Number.isInteger(id)) return false;
  const { rowCount } = await query('DELETE FROM adaptadores_projeto WHERE project_id = $1 AND id = $2', [projectId, id]);
  if (rowCount) invalidarCacheAdaptadores(projectId);
  return rowCount > 0;
}
