// Repositório de destinatários e assinaturas de notificação por e-mail (épico E8).
//
// Este arquivo só administra CADASTRO (quem recebe o quê). Quem decide QUANDO enviar —
// avalia gatilhos, monta o e-mail, respeita idempotência — é src/notificacoes/motor.js,
// que roda no worker. A separação existe para que o roteador admin (CRUD) e o motor
// (envio) não precisem conhecer as regras um do outro.
import { query, transaction } from '../pool.js';
import { randomToken } from '../../config/crypto.js';

/**
 * Catálogo fechado de tipos de notificação (versão 1). Fica AQUI — e só aqui — porque é
 * consultado pelo roteador (GET /api/notificacoes/catalogo, que o front usa para montar
 * os checkboxes do modal) e pelo motor (que precisa saber quais tipos avaliar). Duas
 * cópias da mesma lista (uma no front, outra espalhada pelo back) é o tipo de coisa que
 * se desencontra na primeira mudança — por isso um dado só, importado dos dois lados.
 *
 * `porProjeto: false` marca os tipos que são de sistema, não de projeto (hoje só
 * `fila_acumulada` — a fila é uma só, compartilhada por todos os projetos): o front não
 * deve oferecer seletor de projeto para eles, e o motor sempre assina com project_id NULL.
 */
export const CATALOGO_NOTIFICACOES = [
  {
    tipo: 'entrega_morta',
    rotulo: 'Entregas mortas',
    descricao: 'Avisa quando conversões esgotam as tentativas e vão para a fila morta de um projeto. Chega agrupado — no máximo um e-mail por projeto a cada 30 minutos, listando tudo que morreu na janela.',
    porProjeto: true,
  },
  {
    tipo: 'falha_recorrente',
    rotulo: 'Falhas recorrentes',
    descricao: 'Avisa quando um destino (Meta, Google ou postback) acumula muitos erros seguidos em pouco tempo. Manda um segundo e-mail avisando quando o destino volta ao normal.',
    porProjeto: true,
  },
  {
    tipo: 'fila_acumulada',
    rotulo: 'Fila acumulada',
    descricao: 'Avisa quando a fila de entrega represa por mais de 15 minutos — sinal de que o worker parou ou um destino está fora do ar. É um alerta de sistema, não de um projeto específico.',
    porProjeto: false,
  },
  {
    tipo: 'dominio_problema',
    rotulo: 'Domínio com problema',
    descricao: 'Avisa quando um domínio ativo do painel para de resolver ou o certificado TLS falha ao emitir/renovar.',
    porProjeto: true,
  },
  {
    tipo: 'resumo_diario',
    rotulo: 'Resumo diário',
    descricao: 'Todo dia às 08h, um resumo com eventos, compras, receita e taxa de entrega do dia anterior.',
    porProjeto: true,
  },
  {
    tipo: 'resumo_semanal',
    rotulo: 'Resumo semanal',
    descricao: 'Toda segunda às 08h, o mesmo resumo da semana anterior, comparado com a semana retrasada.',
    porProjeto: true,
  },
];

export const TIPOS_VALIDOS = new Set(CATALOGO_NOTIFICACOES.map((t) => t.tipo));

const REGEX_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function normalizarEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function gerarTokenDescadastro() {
  return randomToken(24);
}

/**
 * Filtra e normaliza a lista de assinaturas vinda do painel. Tipo desconhecido é
 * descartado silenciosamente (em vez de erro 400): um checkbox de uma versão de front
 * mais nova/antiga que o back não pode travar o cadastro inteiro por causa de UM tipo
 * que o back ainda não conhece (ou já removeu do catálogo).
 */
function normalizarAssinaturas(lista) {
  if (!Array.isArray(lista)) return [];
  const vistas = new Set();
  const out = [];
  for (const item of lista) {
    if (!item || !TIPOS_VALIDOS.has(item.tipo)) continue;
    const projectId = item.projectId ?? item.project_id ?? null;
    const chave = `${item.tipo}::${projectId}`;
    if (vistas.has(chave)) continue; // o próprio front pode mandar duplicata sem querer
    vistas.add(chave);
    out.push({ tipo: item.tipo, projectId });
  }
  return out;
}

async function inserirAssinaturas(client, destinatarioId, lista) {
  for (const a of lista) {
    await client.query(
      `INSERT INTO assinaturas_notificacao (destinatario_id, tipo, project_id)
            VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [destinatarioId, a.tipo, a.projectId]
    );
  }
}

// ---------------------------------------------------------------- CRUD de destinatário

export async function getDestinatario(id) {
  const { rows } = await query('SELECT * FROM destinatarios_notificacao WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function getDestinatarioPorEmail(email) {
  const { rows } = await query('SELECT * FROM destinatarios_notificacao WHERE email = $1', [normalizarEmail(email)]);
  return rows[0] || null;
}

export async function getDestinatarioPorToken(token) {
  if (!token) return null;
  const { rows } = await query('SELECT * FROM destinatarios_notificacao WHERE token_descadastro = $1', [token]);
  return rows[0] || null;
}

async function assinaturasDe(id) {
  const { rows } = await query(
    'SELECT tipo, project_id FROM assinaturas_notificacao WHERE destinatario_id = $1 ORDER BY tipo, project_id',
    [id]
  );
  return rows.map((r) => ({ tipo: r.tipo, projectId: r.project_id }));
}

/**
 * Destinatário + suas assinaturas + o papel do usuário vinculado (quando interno) — a
 * forma que a resposta de POST/PUT devolve ao painel, no mesmo formato de listDestinatarios.
 */
export async function getDestinatarioComAssinaturas(id) {
  const { rows } = await query(
    `SELECT d.*, u.role AS usuario_role
       FROM destinatarios_notificacao d
       LEFT JOIN users u ON u.id = d.user_id
      WHERE d.id = $1`,
    [id]
  );
  if (!rows.length) return null;
  return { ...rows[0], assinaturas: await assinaturasDe(id) };
}

/**
 * Lista para a tela de administração: todos os destinatários, cada um já com suas
 * assinaturas e, quando é um usuário do painel, o papel dele (para o badge "interno" vs
 * "externo" pedido no modal). Duas queries no total, não uma por destinatário — a lista
 * de assinaturas some com o volume se cada linha disparasse a própria consulta.
 */
export async function listDestinatarios() {
  const { rows } = await query(
    `SELECT d.*, u.role AS usuario_role
       FROM destinatarios_notificacao d
       LEFT JOIN users u ON u.id = d.user_id
      ORDER BY d.created_at ASC`
  );
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const { rows: assinaturas } = await query(
    'SELECT destinatario_id, tipo, project_id FROM assinaturas_notificacao WHERE destinatario_id = ANY($1)',
    [ids]
  );
  const porDestinatario = new Map();
  for (const a of assinaturas) {
    const lista = porDestinatario.get(a.destinatario_id) || [];
    lista.push({ tipo: a.tipo, projectId: a.project_id });
    porDestinatario.set(a.destinatario_id, lista);
  }

  return rows.map((d) => ({ ...d, assinaturas: porDestinatario.get(d.id) || [] }));
}

/**
 * Cria um destinatário (interno, com `userId`, ou externo, sem) já com as assinaturas
 * escolhidas no modal. Externo = pessoa sem acesso ao painel, cadastrada só por nome e
 * e-mail — requisito explícito do pedido original.
 */
export async function criarDestinatario({ nome, email, userId = null, criadoPor, assinaturas }) {
  const cleanEmail = normalizarEmail(email);
  if (!cleanEmail || !REGEX_EMAIL.test(cleanEmail)) {
    throw Object.assign(new Error('e-mail inválido'), { statusCode: 400 });
  }
  const cleanNome = String(nome || '').trim();
  if (!cleanNome) throw Object.assign(new Error('nome obrigatório'), { statusCode: 400 });

  if (await getDestinatarioPorEmail(cleanEmail)) {
    throw Object.assign(new Error('já existe um destinatário com esse e-mail'), { statusCode: 409 });
  }

  const lista = normalizarAssinaturas(assinaturas);
  const token = gerarTokenDescadastro();

  const destinatario = await transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO destinatarios_notificacao (nome, email, user_id, criado_por, token_descadastro)
            VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
      [cleanNome, cleanEmail, userId, criadoPor, token]
    );
    await inserirAssinaturas(client, rows[0].id, lista);
    return rows[0];
  });

  return { ...destinatario, assinaturas: lista };
}

/**
 * Atualiza nome/e-mail e, se `assinaturas` vier no corpo, SUBSTITUI a lista inteira
 * (delete + insert) — é o comportamento que o modal espera: reabrir, mexer nos
 * checkboxes e salvar de novo manda o conjunto completo, não um diff.
 */
export async function atualizarDestinatario(id, { nome, email, assinaturas } = {}) {
  const atual = await getDestinatario(id);
  if (!atual) throw Object.assign(new Error('destinatário não encontrado'), { statusCode: 404 });

  let cleanEmail = atual.email;
  if (email !== undefined) {
    cleanEmail = normalizarEmail(email);
    if (!cleanEmail || !REGEX_EMAIL.test(cleanEmail)) {
      throw Object.assign(new Error('e-mail inválido'), { statusCode: 400 });
    }
    if (cleanEmail !== atual.email) {
      const conflito = await getDestinatarioPorEmail(cleanEmail);
      if (conflito) throw Object.assign(new Error('já existe um destinatário com esse e-mail'), { statusCode: 409 });
    }
  }
  const cleanNome = nome === undefined ? atual.nome : (String(nome || '').trim() || atual.nome);
  const substituirAssinaturas = assinaturas !== undefined;
  const listaNova = substituirAssinaturas ? normalizarAssinaturas(assinaturas) : null;

  const destinatario = await transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE destinatarios_notificacao SET nome = $2, email = $3 WHERE id = $1 RETURNING *`,
      [id, cleanNome, cleanEmail]
    );
    if (substituirAssinaturas) {
      await client.query('DELETE FROM assinaturas_notificacao WHERE destinatario_id = $1', [id]);
      await inserirAssinaturas(client, id, listaNova);
    }
    return rows[0];
  });

  return { ...destinatario, assinaturas: substituirAssinaturas ? listaNova : await assinaturasDe(id) };
}

export async function removerDestinatario(id) {
  const { rowCount } = await query('DELETE FROM destinatarios_notificacao WHERE id = $1', [id]);
  return rowCount > 0;
}

/**
 * Descadastro de um clique (LGPD): desativa o destinatário pelo token do link, sem
 * exigir login — é a rota pública GET /descadastro. Desativar (não apagar) preserva o
 * histórico em `notificacoes_enviadas` e permite reativação manual pelo admin se a
 * pessoa pedir para voltar a receber depois.
 */
export async function desativarPorToken(token) {
  if (!token) return null;
  const { rows } = await query(
    `UPDATE destinatarios_notificacao SET ativo = false WHERE token_descadastro = $1 RETURNING *`,
    [token]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------- leitura para o motor

/**
 * Assinantes ativos de um tipo, para um projeto. Inclui quem assinou aquele projeto
 * ESPECIFICAMENTE e quem assinou "todos os projetos" (project_id NULL) — é assim que um
 * alerta por incidente (entrega morta, falha recorrente, domínio) deve se comportar:
 * "todos" quer dizer "me avise de qualquer projeto", um alerta por projeto afetado.
 */
export async function assinantesDoTipo(tipo, projectId = null) {
  const { rows } = await query(
    `SELECT DISTINCT d.*
       FROM destinatarios_notificacao d
       JOIN assinaturas_notificacao a ON a.destinatario_id = d.id
      WHERE d.ativo = true
        AND a.tipo = $1
        AND (a.project_id IS NULL OR a.project_id = $2)`,
    [tipo, projectId]
  );
  return rows;
}

/**
 * Assinantes EXATOS de um tipo+projeto (sem incluir quem assinou "todos"). Usado só
 * pelos resumos agregados (diário/semanal): ali "todos os projetos" já vira UM e-mail
 * combinado à parte — incluir esse mesmo destinatário de novo em cada projeto individual
 * duplicaria a mensagem com um número diferente em cada uma.
 */
export async function assinantesExatoDoTipo(tipo, projectId) {
  const { rows } = await query(
    `SELECT d.*
       FROM destinatarios_notificacao d
       JOIN assinaturas_notificacao a ON a.destinatario_id = d.id
      WHERE d.ativo = true AND a.tipo = $1 AND a.project_id = $2`,
    [tipo, projectId]
  );
  return rows;
}

/** Sai-cedo barato para os agendados: existe ALGUÉM assinando este tipo? */
export async function existeAssinanteDoTipo(tipo) {
  const { rows } = await query(
    `SELECT EXISTS (
       SELECT 1 FROM assinaturas_notificacao a
       JOIN destinatarios_notificacao d ON d.id = a.destinatario_id
      WHERE a.tipo = $1 AND d.ativo = true
     ) AS existe`,
    [tipo]
  );
  return rows[0]?.existe || false;
}

// ---------------------------------------------------------------- idempotência

export async function jaNotificado(tipo, chaveIncidente, destinatarioId) {
  const { rows } = await query(
    `SELECT 1 FROM notificacoes_enviadas WHERE tipo = $1 AND chave_incidente = $2 AND destinatario_id = $3`,
    [tipo, chaveIncidente, destinatarioId]
  );
  return rows.length > 0;
}

export async function registrarEnvio(tipo, chaveIncidente, destinatarioId) {
  const { rowCount } = await query(
    `INSERT INTO notificacoes_enviadas (tipo, chave_incidente, destinatario_id)
          VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`,
    [tipo, chaveIncidente, destinatarioId]
  );
  return rowCount > 0;
}

/** Zero envios anteriores = este é o primeiro contato com o destinatário. */
export async function contarEnviosAnteriores(destinatarioId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS total FROM notificacoes_enviadas WHERE destinatario_id = $1',
    [destinatarioId]
  );
  return rows[0]?.total || 0;
}

/**
 * Chaves de incidente que já receberam o alerta de ABERTURA (`tipoAberto`) mas ainda não
 * o de RESOLUÇÃO (`tipoResolvido`) — usado só por falha_recorrente para saber quando
 * mandar o "voltou ao normal". Limitado a `desde` para não varrer o histórico inteiro a
 * cada tick.
 */
export async function chavesAbertasSemResolucao(tipoAberto, tipoResolvido, desde) {
  const { rows } = await query(
    `SELECT DISTINCT a.chave_incidente
       FROM notificacoes_enviadas a
      WHERE a.tipo = $1 AND a.enviada_em >= $3
        AND NOT EXISTS (
          SELECT 1 FROM notificacoes_enviadas r
           WHERE r.tipo = $2 AND r.chave_incidente = a.chave_incidente
        )`,
    [tipoAberto, tipoResolvido, desde]
  );
  return rows.map((r) => r.chave_incidente);
}
