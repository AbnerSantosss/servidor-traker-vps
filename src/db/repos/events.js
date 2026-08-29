// Repositório de eventos e da fila de entregas.
// A fila vive no próprio Postgres (FOR UPDATE SKIP LOCKED) — sem Redis. Para o volume
// deste serviço isso é durável, transacional e elimina um componente de infraestrutura.
import { query, transaction } from '../pool.js';
import { env } from '../../config/env.js';
import { publicar, CANAL_EVENTOS } from '../notificacoes.js';

const RETRIABLE_STATUSES = ['pending', 'error'];

/**
 * Persiste o evento e cria as entregas pendentes na mesma transação.
 * Idempotente: se (project_id, event_id, event_name) já existe, não cria nada e
 * devolve { duplicate: true } — é a segunda camada de dedup (ver docs/01, seção 7).
 */
export async function recordEvent({ project, event, destinationTypes }) {
  const resultado = await transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO events
         (project_id, event_id, event_name, source, occurred_at, received_at,
          client_ip, utm_source, value, currency, payload, consent,
          utm_medium, utm_campaign, tem_fbc, tem_gclid)
       VALUES ($1,$2,$3,$4,$5,now(),$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15)
       ON CONFLICT (project_id, event_id, event_name) DO NOTHING
       RETURNING *`,
      [
        project.id,
        event.event_id,
        event.event_name,
        event.source || 'web',
        event.event_time ? new Date(event.event_time * 1000) : null,
        event.user_data?.client_ip_address || null,
        event.user_data?.utm_source || null,
        Number.isFinite(Number(event.custom_data?.value)) ? Number(event.custom_data.value) : null,
        event.custom_data?.currency || null,
        JSON.stringify(event),
        JSON.stringify(event.consent_state || {}),
        event.user_data?.utm_medium || null,
        event.user_data?.utm_campaign || null,
        // Sempre TRUE/FALSE, nunca NULL: no momento da ingestão sempre sabemos se o
        // identificador de clique veio ou não. NULL fica reservado para o evento
        // antigo que ainda não passou pelo backfill (ver 003_analytics.sql).
        Boolean(event.user_data?.fbc || event.user_data?.fbclid),
        Boolean(event.user_data?.gclid || event.user_data?.gbraid || event.user_data?.wbraid),
      ]
    );

    if (!rows.length) {
      const { rows: existing } = await client.query(
        'SELECT id FROM events WHERE project_id = $1 AND event_id = $2 AND event_name = $3',
        [project.id, event.event_id, event.event_name]
      );
      return { duplicate: true, id: existing[0]?.id || null };
    }

    const row = rows[0];
    for (const type of destinationTypes) {
      await client.query(
        `INSERT INTO deliveries (event_row_id, project_id, destination_type)
              VALUES ($1,$2,$3)
         ON CONFLICT (event_row_id, destination_type) DO NOTHING`,
        [row.id, project.id, type]
      );
    }
    return { duplicate: false, id: row.id, row };
  });

  // Publicado FORA da transação, DE PROPÓSITO: o evento já está commitado quando isto
  // roda, então uma falha de NOTIFY (rede, Postgres sob pressão) nunca pode desfazer nem
  // atrasar uma ingestão que já terminou. `publicar` é best-effort e nunca lança (ver
  // src/db/notificacoes.js) — mesmo assim o `if` abaixo evita notificar duplicata, que não
  // é um evento novo para ninguém.
  if (!resultado.duplicate) {
    await publicar(CANAL_EVENTOS, { project_id: project.id, tipo: 'evento', id: resultado.id });
  }

  return resultado;
}

/**
 * Reivindica lotes de entregas prontas para processar.
 * SKIP LOCKED permite rodar vários workers em paralelo sem que dois peguem a mesma linha.
 */
export async function claimDeliveries(limit = 5) {
  const { rows } = await query(
    `UPDATE deliveries
        SET status = 'processing', locked_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE id IN (
            SELECT id FROM deliveries
             WHERE status = ANY($2)
               AND next_attempt_at <= now()
             ORDER BY next_attempt_at
             LIMIT $1
             FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit, RETRIABLE_STATUSES]
  );
  if (!rows.length) return [];

  // Traz o evento junto (o worker precisa do payload para montar os destinos).
  const eventIds = [...new Set(rows.map((r) => r.event_row_id))];
  const { rows: events } = await query('SELECT * FROM events WHERE id = ANY($1)', [eventIds]);
  const byId = new Map(events.map((e) => [e.id, e]));
  return rows.map((d) => ({ delivery: d, event: byId.get(d.event_row_id) }));
}

export async function markDeliverySuccess(id, { httpStatus, response } = {}) {
  await query(
    `UPDATE deliveries
        SET status='success', http_status=$2, response=$3::jsonb, last_error=NULL,
            locked_at=NULL, updated_at=now()
      WHERE id=$1`,
    [id, httpStatus || null, JSON.stringify(response ?? null)]
  );
}

/**
 * Registra falha. Decide entre nova tentativa (backoff exponencial) e dead-letter.
 * Erro não-retriável (4xx de configuração, token inválido) vai direto para 'dead':
 * insistir num token errado só queima rate limit e polui o log.
 */
export async function markDeliveryFailure(id, { httpStatus, response, error, retriable, attempts } = {}) {
  const isDead = !retriable || attempts >= env.MAX_ATTEMPTS;
  // Entrega morta não tem próxima tentativa; manter o campo parado evita ler a tabela
  // e achar que ainda há algo agendado.
  const delaySeconds = isDead ? 0 : Math.min(2 ** Math.max(0, attempts - 1), 900); // 1s,2s,4s… teto de 15min
  await query(
    `UPDATE deliveries
        SET status = $2,
            http_status = $3,
            response = $4::jsonb,
            last_error = $5,
            next_attempt_at = now() + ($6 || ' seconds')::interval,
            locked_at = NULL,
            updated_at = now()
      WHERE id = $1`,
    [id, isDead ? 'dead' : 'error', httpStatus || null, JSON.stringify(response ?? null), String(error || '').slice(0, 2000), delaySeconds]
  );
  return { dead: isDead, retryInSeconds: delaySeconds };
}

export async function markDeliverySkipped(id, reason, detail) {
  await query(
    `UPDATE deliveries SET status=$2, last_error=$3, locked_at=NULL, updated_at=now() WHERE id=$1`,
    [id, reason, String(detail || '').slice(0, 500)]
  );
}

/**
 * Devolve à fila entregas presas em 'processing' (worker morreu no meio).
 * Sem isso, um kill -9 durante a entrega deixaria a linha travada para sempre.
 */
export async function recoverStuckDeliveries(olderThanMinutes = 10) {
  const { rowCount } = await query(
    `UPDATE deliveries
        SET status='error', locked_at=NULL, next_attempt_at=now(), updated_at=now()
      WHERE status='processing'
        AND locked_at < now() - ($1 || ' minutes')::interval`,
    [olderThanMinutes]
  );
  return rowCount;
}

// Reenvio manual pelo painel: recoloca na fila tudo que não teve sucesso.
export async function requeueEvent(eventRowId) {
  const { rowCount } = await query(
    `UPDATE deliveries
        SET status='pending', next_attempt_at=now(), attempts=0, last_error=NULL, updated_at=now()
      WHERE event_row_id = $1 AND status <> 'success'`,
    [eventRowId]
  );
  return rowCount;
}

// ---------------------------------------------------------------- leitura para o painel

/**
 * Log de eventos no formato consumido pelo painel:
 * destinations = { meta: { status, httpStatus, response }, ... }
 */
export async function listEvents(projectId, { limit = 200 } = {}) {
  // Teto rígido: sem ele, ?limit=999999 puxaria a tabela inteira para a memória.
  limit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const { rows } = await query(
    `SELECT e.id, e.event_id, e.event_name, e.received_at, e.source, e.value, e.currency, e.utm_source,
            e.payload->'custom_data'->>'payment_method' AS payment_method,
            e.payload->'custom_data'->>'coupon'         AS coupon,
            e.payload->'custom_data'->>'order_id'       AS order_id,
            COALESCE(
              jsonb_object_agg(
                d.destination_type,
                jsonb_build_object(
                  'status', d.status,
                  'httpStatus', d.http_status,
                  'attempts', d.attempts,
                  'response', COALESCE(d.response, to_jsonb(d.last_error))
                )
              ) FILTER (WHERE d.id IS NOT NULL),
              '{}'::jsonb
            ) AS destinations
       FROM events e
       LEFT JOIN deliveries d ON d.event_row_id = e.id
      WHERE e.project_id = $1
      GROUP BY e.id
      ORDER BY e.received_at DESC
      LIMIT $2`,
    [projectId, limit]
  );

  return rows.map((r) => ({
    id: r.id,
    event_id: r.event_id,
    event_name: r.event_name,
    receivedAt: r.received_at instanceof Date ? r.received_at.toISOString() : r.received_at,
    source: r.source,
    value: r.value,
    currency: r.currency,
    utm_source: r.utm_source,
    payment_method: r.payment_method,
    coupon: r.coupon,
    order_id: r.order_id,
    destinations: r.destinations || {},
  }));
}

export async function getEventRow(eventRowId) {
  const { rows } = await query('SELECT * FROM events WHERE id = $1', [eventRowId]);
  return rows[0] || null;
}

// Status que fazem sentido pedir na tela de "falhas explicadas". Fora desta lista o
// parâmetro é ignorado — evita que um valor digitado errado (ou um status que nem existe)
// silenciosamente devolva uma lista vazia sem o operador entender por quê.
const STATUS_FALHA_VALIDOS = new Set(['error', 'dead', 'skipped_consent', 'skipped_unmapped']);

/**
 * Entregas que precisam de atenção — a matéria-prima da tela de "falhas explicadas".
 * Junta `deliveries` com `events` porque o painel precisa mostrar o evento por trás da
 * entrega (nome, valor, UTM), não só o status cru da fila.
 *
 * `agrupar` é aceito na assinatura por pedido do plano de melhorias, mas não faz nada
 * AQUI: o agrupamento por causa depende do tradutor de erros
 * (src/destinations/erros-explicados.js), que é responsabilidade do router, não do
 * repositório. Este função só lê linhas; quem agrupa decide o quê fazer com elas.
 */
export async function listFailedDeliveries(projectId, { status, destination, from, to, limit, agrupar } = {}) {
  void agrupar;

  let statusList = String(status || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => STATUS_FALHA_VALIDOS.has(s));
  if (!statusList.length) statusList = ['error', 'dead'];

  const lim = limitarNumero(limit, 100, 1, 500);

  const params = [projectId, statusList];
  let where = `WHERE d.project_id = $1 AND d.status = ANY($2)`;
  let i = 3;

  // Filtro por destino: parâmetro vinculado, nunca concatenado — vazamento de projeto ou
  // injeção de SQL por aqui seria o pior bug possível numa tela de diagnóstico.
  if (destination) {
    where += ` AND d.destination_type = $${i++}`;
    params.push(String(destination));
  }
  // Eixo do tempo é d.updated_at (quando a ÚLTIMA tentativa aconteceu), não
  // e.received_at nem d.created_at: uma entrega criada há dias mas que só falhou agora
  // (depois de várias tentativas) precisa aparecer como falha de agora, não do passado.
  if (from) {
    where += ` AND d.updated_at >= $${i++}`;
    params.push(new Date(`${from}T00:00:00Z`));
  }
  if (to) {
    where += ` AND d.updated_at < ($${i++}::date + interval '1 day')`;
    params.push(to);
  }

  params.push(lim);

  const { rows } = await query(
    `SELECT d.id AS delivery_id, d.event_row_id, e.event_id, e.event_name, e.received_at,
            d.destination_type, d.status, d.attempts, d.http_status, d.last_error,
            -- A coluna response traz o que o destino devolveu além da mensagem: no caso
            -- da Meta, o error_subcode é o que distingue "event_time fora da janela de 7
            -- dias" de "campo mal formatado", que compartilham o mesmo error code 100.
            -- Sem ela, o tradutor de erros só consegue dizer "erro 100" — que não diz a
            -- ninguém o que fazer. Ver src/destinations/erros-explicados.js.
            d.response,
            d.next_attempt_at, d.updated_at,
            e.value, e.currency, e.utm_source
       FROM deliveries d
       JOIN events e ON e.id = d.event_row_id
       ${where}
      ORDER BY d.updated_at DESC
      LIMIT $${i}`,
    params
  );

  return rows.map((r) => ({
    delivery_id: r.delivery_id,
    event_row_id: r.event_row_id,
    event_id: r.event_id,
    event_name: r.event_name,
    received_at: r.received_at instanceof Date ? r.received_at.toISOString() : r.received_at,
    destination_type: r.destination_type,
    status: r.status,
    attempts: r.attempts,
    http_status: r.http_status,
    last_error: r.last_error,
    // Fica disponível para o tradutor de erros, que é quem sabe ler cada destino. Quem
    // expõe isto na API precisa passar pelo mascarador antes: a resposta de erro de uma
    // plataforma pode ecoar trecho do que foi enviado, incluindo credencial.
    response: r.response || null,
    next_attempt_at: r.next_attempt_at instanceof Date ? r.next_attempt_at.toISOString() : r.next_attempt_at,
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    value: r.value,
    currency: r.currency,
    utm_source: r.utm_source,
  }));
}

/**
 * Contagem de falhas por destino nas últimas 24h e nos últimos 7 dias — usado pelo badge
 * do painel (ex. "Meta (3)"), que não pode pagar o custo de carregar a lista inteira de
 * falhas só para mostrar um número.
 */
export async function countFailuresByDestination(projectId) {
  const { rows } = await query(
    `SELECT d.destination_type AS destino,
            COUNT(*) FILTER (WHERE d.updated_at >= now() - interval '24 hours')::int AS ultimas_24h,
            COUNT(*) FILTER (WHERE d.updated_at >= now() - interval '7 days')::int   AS ultimos_7d
       FROM deliveries d
      WHERE d.project_id = $1
        AND d.status IN ('error', 'dead')
      GROUP BY 1`,
    [projectId]
  );

  const porDestino = {};
  for (const r of rows) {
    porDestino[r.destino] = { ultimas_24h: r.ultimas_24h, ultimos_7d: r.ultimos_7d };
  }
  return porDestino;
}

// ---------------------------------------------------------------- métricas do dashboard

// `coluna` é parametrizável porque nem toda métrica nova filtra por events.received_at:
// metrics/destinos, por exemplo, filtra deliveries por d.created_at (ver computeDestinos).
// O padrão 'e.received_at' preserva o comportamento de todo chamador existente.
function periodClause(from, to, startIndex, coluna = 'e.received_at') {
  const parts = [];
  const params = [];
  let i = startIndex;
  if (from) { parts.push(`AND ${coluna} >= $${i++}`); params.push(new Date(`${from}T00:00:00Z`)); }
  if (to)   { parts.push(`AND ${coluna} < ($${i++}::date + interval '1 day')`); params.push(to); }
  return { sql: parts.join(' '), params, nextIndex: i };
}

// Trava genérica para qualquer `limit`/quantidade vindo de query string: sem teto, um
// cliente pedindo ?limit=999999 forçaria a varrer/serializar a tabela inteira.
function limitarNumero(valor, padrao, minimo, maximo) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(Math.max(Math.trunc(n), minimo), maximo);
}

/**
 * Série diária para o gráfico principal do dashboard: contagem por tipo de evento e
 * receita, dia a dia.
 *
 * Existe para tirar esse cálculo do navegador. A primeira versão da faixa montava a série
 * no cliente lendo a lista de eventos com teto de 1.000 linhas — correto no volume atual,
 * mas com dois defeitos: o gráfico passa a mentir por omissão assim que o projeto cresce,
 * e trafega o payload inteiro de cada evento só para contar quantos foram. Agregação é
 * trabalho de banco.
 *
 * `topN` limita quantos tipos de evento viram série própria; o resto é somado em `outros`.
 * Sem isso, um projeto com 40 nomes de evento geraria 40 séries empilhadas — um gráfico
 * que ninguém consegue ler.
 */
export async function computeSerieDiaria(projectId, { from, to, utm_source, event_name, topN = 8 } = {}) {
  const base = periodClause(from, to, 2);
  let filterSql = base.sql;
  const params = [projectId, ...base.params];
  let i = base.nextIndex;

  if (utm_source) { filterSql += ` AND e.utm_source = $${i++}`; params.push(utm_source); }
  // Aceita o mesmo recorte por tipo de evento que o dashboard já oferece nos demais
  // gráficos. Com o filtro ligado a série vira uma faixa só — o que é o esperado: quem
  // pediu "só purchase" não quer ver as outras empilhadas junto.
  if (event_name) { filterSql += ` AND e.event_name = $${i++}`; params.push(event_name); }

  const where = `WHERE e.project_id = $1 ${filterSql}`;
  const limite = limitarNumero(topN, 8, 1, 20);

  const [porDiaTipo, receitaPorDia, tiposMaiores, primeiro] = await Promise.all([
    query(
      `SELECT to_char(date_trunc('day', e.received_at), 'YYYY-MM-DD') AS dia,
              e.event_name AS tipo,
              COUNT(*)::int AS eventos
         FROM events e ${where}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      params
    ),
    query(
      `SELECT to_char(date_trunc('day', e.received_at), 'YYYY-MM-DD') AS dia,
              COALESCE(SUM(e.value) FILTER (WHERE e.event_name = 'purchase'), 0) AS receita,
              COUNT(*) FILTER (WHERE e.event_name = 'purchase')::int AS compras
         FROM events e ${where}
        GROUP BY 1 ORDER BY 1`,
      params
    ),
    query(
      `SELECT e.event_name AS tipo, COUNT(*)::int AS eventos
         FROM events e ${where}
        GROUP BY 1 ORDER BY 2 DESC LIMIT ${limite}`,
      params
    ),
    // Data do primeiro evento do projeto — INDEPENDENTE do período filtrado, porque a
    // pergunta que ela responde é "desde quando este projeto coleta?". Com três ou
    // quatro pontos na série, o gráfico precisa dizer que é jovem em vez de desenhar
    // um bloco gigante de cor única e parecer um dado consolidado.
    query('SELECT MIN(e.received_at) AS desde FROM events e WHERE e.project_id = $1', [projectId]),
  ]);

  const principais = new Set(tiposMaiores.rows.map((r) => r.tipo));
  const dias = new Map();
  const garantirDia = (dia) => {
    if (!dias.has(dia)) dias.set(dia, { dia, tipos: {}, outros: 0, receita: 0, compras: 0 });
    return dias.get(dia);
  };

  for (const r of porDiaTipo.rows) {
    const d = garantirDia(r.dia);
    if (principais.has(r.tipo)) d.tipos[r.tipo] = (d.tipos[r.tipo] || 0) + r.eventos;
    else d.outros += r.eventos;
  }
  for (const r of receitaPorDia.rows) {
    const d = garantirDia(r.dia);
    d.receita = Number(r.receita) || 0;
    d.compras = r.compras;
  }

  const desde = primeiro.rows[0]?.desde || null;

  return {
    tipos: [...principais],
    // `temOutros` diz à tela se vale desenhar a faixa "outros" — sem ele, o gráfico
    // ganharia uma série sempre zerada em todo projeto com poucos tipos de evento.
    temOutros: [...dias.values()].some((d) => d.outros > 0),
    coletandoDesde: desde instanceof Date ? desde.toISOString() : desde,
    serie: [...dias.values()].sort((a, b) => a.dia.localeCompare(b.dia)),
  };
}

/**
 * Funil de dinheiro — os seis indicadores principais do dashboard, todos calculados
 * NO BANCO numa varredura só (mais duas leituras derivadas do mesmo CTE).
 *
 * Dois deles não existem como evento: são derivados, e a forma como cada um é derivado
 * muda o número na tela — por isso a função devolve também COMO calculou
 * (`pix_metodo`, `pix_com_chave`), e o painel escreve isso no balão de ajuda. Uma
 * métrica derivada sem o método declarado é um número que ninguém consegue auditar.
 *
 * - **Checkouts abandonados** = begin_checkout − purchase no MESMO período do filtro,
 *   com piso 0. O piso não é cosmético: quem começou o checkout ontem e comprou hoje
 *   entra só com a compra na janela de hoje, e sem o piso o card mostraria um negativo.
 *   Não há janela por sessão nesta versão (decisão registrada no plano visual, §6).
 * - **Pix abandonado (valor)** = soma do valor dos pix_gerado que não têm compra
 *   correspondente. A correspondência é por `order_id`/`transaction_id` quando TODO
 *   pix do período traz a chave; se algum vier sem, o par a par mentiria (um pix sem
 *   chave nunca casaria e viraria "abandonado" por falta de dado, não por falta de
 *   pagamento), então cai no agregado Σ pix − Σ compras, com piso 0.
 */
function montarFunilDinheiro(linha) {
  const f = linha || {};
  const vendas = f.vendas || 0;
  const vendasValor = Number(f.vendas_valor || 0);
  const checkoutsIniciados = f.checkouts_iniciados || 0;
  const checkoutsAbandonados = Math.max(0, checkoutsIniciados - vendas);
  const pixGerados = f.pix_gerados || 0;
  const pixValor = Number(f.pix_valor || 0);
  const pixComChave = f.pix_com_chave || 0;

  const porChave = pixGerados > 0 && pixComChave === pixGerados;

  return {
    vendas,
    vendas_valor: vendasValor,
    page_views: f.page_views || 0,
    checkouts_iniciados: checkoutsIniciados,
    checkouts_abandonados: checkoutsAbandonados,
    taxa_abandono_checkout: checkoutsIniciados ? checkoutsAbandonados / checkoutsIniciados : 0,
    pix_gerados: pixGerados,
    pix_valor: pixValor,
    pix_abandonado_valor: porChave
      ? Number(f.pix_abandonado_valor_chave || 0)
      : Math.max(0, pixValor - vendasValor),
    // No modo agregado não existe "quantos pix": a conta é uma subtração de somas, não
    // um casamento linha a linha. `null` diz isso ao painel; 0 mentiria dizendo que
    // nenhum pix ficou para trás.
    pix_abandonado_qtd: porChave ? (f.pix_abandonado_qtd_chave || 0) : null,
    pix_metodo: porChave ? 'order_id' : 'agregado',
    pix_com_chave: pixComChave,
  };
}

export async function computeMetrics(projectId, { from, to, utm_source, event_name } = {}) {
  const base = periodClause(from, to, 2);
  let filterSql = base.sql;
  const params = [projectId, ...base.params];
  let i = base.nextIndex;

  if (utm_source) { filterSql += ` AND e.utm_source = $${i++}`; params.push(utm_source); }

  // Fotografado ANTES do filtro por tipo de evento, de propósito: o funil de dinheiro
  // compara seis eventos DIFERENTES entre si, então herdar um recorte "só purchase"
  // zeraria cinco dos seis cards e o operador leria zero onde existe dado. O filtro de
  // evento continua valendo para todo o resto da resposta, como sempre valeu.
  const whereFunil = `WHERE e.project_id = $1 ${filterSql}`;
  const paramsFunil = [...params];

  if (event_name) { filterSql += ` AND e.event_name = $${i++}`; params.push(event_name); }

  const where = `WHERE e.project_id = $1 ${filterSql}`;

  const [totals, byDay, byUtm, byEvent, byDest, funil] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS events,
              COUNT(*) FILTER (WHERE e.event_name = 'purchase')::int AS purchases,
              COALESCE(SUM(e.value) FILTER (WHERE e.event_name = 'purchase'), 0) AS revenue,
              COUNT(*) FILTER (WHERE e.event_name IN ('sign_up','lead'))::int AS sign_ups
         FROM events e ${where}`,
      params
    ),
    query(
      `SELECT to_char(date_trunc('day', e.received_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS events
         FROM events e ${where}
        GROUP BY 1 ORDER BY 1`,
      params
    ),
    query(
      `SELECT COALESCE(e.utm_source, '') AS source, COUNT(*)::int AS count
         FROM events e ${where}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
      params
    ),
    query(
      `SELECT e.event_name AS name, COUNT(*)::int AS count
         FROM events e ${where}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
      params
    ),
    query(
      `SELECT d.destination_type AS dest,
              COUNT(*) FILTER (WHERE d.status = 'success')::int AS success,
              COUNT(*) FILTER (WHERE d.status IN ('error','dead'))::int AS error,
              COUNT(*) FILTER (WHERE d.status NOT IN ('success','error','dead'))::int AS off
         FROM deliveries d JOIN events e ON e.id = d.event_row_id ${where}
        GROUP BY 1`,
      params
    ),
    // Os seis indicadores do funil de dinheiro. `periodo` materializa uma vez os
    // eventos da janela já com a chave de correlação resolvida; `compras` e `pix` só
    // reaproveitam esse recorte — assim a correlação do pix custa uma varredura, não
    // uma por linha.
    query(
      `WITH periodo AS (
         SELECT e.event_name,
                e.value,
                NULLIF(COALESCE(e.payload->'custom_data'->>'order_id',
                                e.payload->'custom_data'->>'transaction_id'), '') AS chave
           FROM events e ${whereFunil}
       ),
       compras AS (
         SELECT DISTINCT chave FROM periodo WHERE event_name = 'purchase' AND chave IS NOT NULL
       ),
       pix AS (
         SELECT p.value, p.chave, (c.chave IS NOT NULL) AS casou
           FROM periodo p
           LEFT JOIN compras c ON c.chave = p.chave
          WHERE p.event_name = 'pix_gerado'
       )
       SELECT
         (SELECT COUNT(*) FROM periodo WHERE event_name = 'purchase')::int              AS vendas,
         (SELECT COALESCE(SUM(value), 0) FROM periodo WHERE event_name = 'purchase')    AS vendas_valor,
         (SELECT COUNT(*) FROM periodo WHERE event_name = 'page_view')::int             AS page_views,
         (SELECT COUNT(*) FROM periodo WHERE event_name = 'begin_checkout')::int        AS checkouts_iniciados,
         (SELECT COUNT(*) FROM pix)::int                                                AS pix_gerados,
         (SELECT COALESCE(SUM(value), 0) FROM pix)                                      AS pix_valor,
         (SELECT COUNT(*) FROM pix WHERE chave IS NOT NULL)::int                        AS pix_com_chave,
         (SELECT COALESCE(SUM(value), 0) FROM pix WHERE chave IS NOT NULL AND NOT casou) AS pix_abandonado_valor_chave,
         (SELECT COUNT(*) FROM pix WHERE chave IS NOT NULL AND NOT casou)::int          AS pix_abandonado_qtd_chave`,
      paramsFunil
    ),
  ]);

  const t = totals.rows[0] || {};
  const purchases = t.purchases || 0;
  const revenue = Number(t.revenue || 0);

  const byDestination = {};
  for (const r of byDest.rows) {
    byDestination[r.dest] = { success: r.success || 0, error: r.error || 0, off: r.off || 0 };
  }
  const totalDeliveries = Object.values(byDestination).reduce((acc, d) => acc + d.success + d.error, 0);
  const totalSuccess = Object.values(byDestination).reduce((acc, d) => acc + d.success, 0);

  return {
    totals: {
      events: t.events || 0,
      purchases,
      revenue,
      signUps: t.sign_ups || 0,
      avgTicket: purchases ? revenue / purchases : 0,
      // fração 0..1 — o painel multiplica por 100
      successRate: totalDeliveries ? totalSuccess / totalDeliveries : 0,
    },
    // Bloco NOVO (F-V3). Vive fora de `totals` por dois motivos: não herda o filtro por
    // tipo de evento que `totals` herda, e traz o método de cálculo junto do número.
    // Nada em `totals` mudou de nome nem de significado — o dashboard antigo e os testes
    // que dependem daqueles campos continuam válidos.
    funilDinheiro: montarFunilDinheiro(funil.rows[0]),
    byDay: byDay.rows,
    byUtmSource: byUtm.rows,
    byEventName: byEvent.rows,
    byDestination,
  };
}

/**
 * Agregado por UTM (source × medium × campaign) para a tela de origem de tráfego.
 * UTM ausente vira a chave '(direto)' já na consulta — nunca devolvemos null cru numa
 * tabela do painel, senão o operador lê "null" como se fosse o nome de uma campanha.
 */
export async function computeUtmMetrics(projectId, { from, to, limit } = {}) {
  const lim = limitarNumero(limit, 50, 1, 200);
  const base = periodClause(from, to, 2);
  const where = `WHERE e.project_id = $1 ${base.sql}`;
  const params = [projectId, ...base.params];

  const [linhas, totalGeral] = await Promise.all([
    query(
      `SELECT COALESCE(e.utm_source, '(direto)')   AS utm_source,
              COALESCE(e.utm_medium, '(direto)')   AS utm_medium,
              COALESCE(e.utm_campaign, '(direto)') AS utm_campaign,
              COUNT(*)::int AS eventos,
              COUNT(*) FILTER (WHERE e.event_name = 'purchase')::int AS compras,
              COALESCE(SUM(e.value) FILTER (WHERE e.event_name = 'purchase'), 0) AS receita,
              COUNT(*) FILTER (WHERE e.tem_fbc IS TRUE OR e.tem_gclid IS TRUE)::int AS com_atribuicao
         FROM events e ${where}
        GROUP BY 1, 2, 3
        ORDER BY receita DESC
        LIMIT $${params.length + 1}`,
      [...params, lim]
    ),
    query(
      `SELECT COUNT(*)::int AS eventos,
              COUNT(*) FILTER (WHERE e.event_name = 'purchase')::int AS compras,
              COALESCE(SUM(e.value) FILTER (WHERE e.event_name = 'purchase'), 0) AS receita
         FROM events e ${where}`,
      params
    ),
  ]);

  const t = totalGeral.rows[0] || {};
  return {
    linhas: linhas.rows.map((r) => ({
      utm_source: r.utm_source,
      utm_medium: r.utm_medium,
      utm_campaign: r.utm_campaign,
      eventos: r.eventos,
      compras: r.compras,
      receita: Number(r.receita),
      ticket_medio: r.compras ? Number(r.receita) / r.compras : 0,
      pct_com_atribuicao: r.eventos ? r.com_atribuicao / r.eventos : 0,
    })),
    total: {
      eventos: t.eventos || 0,
      compras: t.compras || 0,
      receita: Number(t.receita || 0),
    },
  };
}

/**
 * Cobertura de atribuição por clique (fbc/fbclid para Meta, gclid/gbraid/wbraid para
 * Google) e a "receita invisível": compras que fecharam sem nenhum identificador de
 * clique, portanto sem chance de casar com uma campanha específica do lado da plataforma.
 */
export async function computeAtribuicao(projectId, { from, to, event_name, limit } = {}) {
  const lim = limitarNumero(limit, 20, 1, 100);
  const base = periodClause(from, to, 2);
  let filterSql = base.sql;
  const params = [projectId, ...base.params];
  let i = base.nextIndex;
  if (event_name) { filterSql += ` AND e.event_name = $${i++}`; params.push(event_name); }
  const where = `WHERE e.project_id = $1 ${filterSql}`;

  const [serie, resumo, semAtribuicao] = await Promise.all([
    query(
      `SELECT to_char(date_trunc('day', e.received_at), 'YYYY-MM-DD') AS data,
              COUNT(*) FILTER (WHERE e.tem_fbc IS TRUE)::int     AS com_fbc,
              COUNT(*) FILTER (WHERE e.tem_fbc IS NOT TRUE)::int AS sem_fbc,
              COUNT(*) FILTER (WHERE e.tem_gclid IS TRUE)::int     AS com_gclid,
              COUNT(*) FILTER (WHERE e.tem_gclid IS NOT TRUE)::int AS sem_gclid
         FROM events e ${where}
        GROUP BY 1 ORDER BY 1`,
      params
    ),
    query(
      `SELECT COUNT(*)::int AS total_eventos,
              COUNT(*) FILTER (WHERE e.tem_fbc IS NOT TRUE AND e.tem_gclid IS NOT TRUE)::int AS sem_atribuicao,
              COALESCE(SUM(e.value) FILTER (
                WHERE e.event_name = 'purchase' AND e.tem_fbc IS NOT TRUE AND e.tem_gclid IS NOT TRUE
              ), 0) AS receita_sem_atribuicao
         FROM events e ${where}`,
      params
    ),
    // Independente do filtro event_name: a lista de "compra cega" é sempre sobre
    // purchase — é justamente o caso que justifica o alerta de receita sem rastro.
    query(
      `SELECT e.id, e.event_id, e.received_at, e.value, e.currency, e.utm_source, e.utm_campaign
         FROM events e
        WHERE e.project_id = $1 ${base.sql}
          AND e.event_name = 'purchase'
          AND e.tem_fbc IS NOT TRUE AND e.tem_gclid IS NOT TRUE
        ORDER BY e.received_at DESC
        LIMIT $${base.params.length + 2}`,
      [projectId, ...base.params, lim]
    ),
  ]);

  const r = resumo.rows[0] || {};
  return {
    serie: serie.rows,
    sem_atribuicao: semAtribuicao.rows.map((row) => ({
      id: row.id,
      event_id: row.event_id,
      received_at: row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at,
      value: row.value,
      currency: row.currency,
      utm_source: row.utm_source || '(direto)',
      utm_campaign: row.utm_campaign || '(direto)',
    })),
    resumo: {
      total_eventos: r.total_eventos || 0,
      sem_atribuicao: r.sem_atribuicao || 0,
      receita_sem_atribuicao: Number(r.receita_sem_atribuicao || 0),
    },
  };
}

const ETAPAS_PADRAO_FUNIL = ['page_view', 'lead', 'begin_checkout', 'pix_gerado', 'purchase'];
// Teto arbitrário generoso: um funil com mais etapas que isso já é ilegível no painel,
// então o limite aqui é sobretudo para impedir uma query com centenas de FILTER.
const MAX_ETAPAS_FUNIL = 12;

/**
 * Funil configurável, calculado numa varredura só: cada etapa vira um
 * `COUNT(*) FILTER (WHERE event_name = ...)` na MESMA query, em vez de uma query por
 * etapa. Assim o custo não cresce linear com o número de etapas customizadas.
 */
export async function computeFunil(projectId, { from, to, etapas } = {}) {
  let nomes = ETAPAS_PADRAO_FUNIL;
  if (etapas) {
    const custom = String(etapas).split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_ETAPAS_FUNIL);
    if (custom.length) nomes = custom;
  }

  const base = periodClause(from, to, 2);
  const params = [projectId, ...base.params];
  let i = base.nextIndex;
  const filtros = nomes.map((nome, idx) => {
    params.push(nome);
    return `COUNT(*) FILTER (WHERE e.event_name = $${i++})::int AS c${idx}`;
  });

  const { rows } = await query(
    `SELECT ${filtros.join(',\n            ')}
       FROM events e
      WHERE e.project_id = $1 ${base.sql}`,
    params
  );

  const contagens = nomes.map((_, idx) => rows[0]?.[`c${idx}`] || 0);
  const topo = contagens[0] || 0;

  return {
    etapas: nomes.map((nome, idx) => {
      const atual = contagens[idx];
      const anterior = idx > 0 ? contagens[idx - 1] : null;
      return {
        nome,
        eventos: atual,
        // Primeira etapa não tem "anterior" — null, não 1 nem 0: não existe taxa aqui.
        taxa_da_etapa_anterior: idx === 0 ? null : (anterior ? atual / anterior : 0),
        taxa_do_topo: topo ? atual / topo : 0,
      };
    }),
  };
}

const TOP_ERROS_POR_DESTINO = 5;

// Todo status possível de `deliveries` (ver 001_init.sql) começa zerado — o painel
// sempre recebe a mesma forma, tenha ou não entrega naquele dia/destino.
function statusZerados() {
  return { success: 0, processing: 0, error: 0, dead: 0, pending: 0, skipped_consent: 0, skipped_unmapped: 0 };
}

/**
 * Saúde de entrega por destino — de onde a fila está travando e com que erro.
 * Usa d.created_at como eixo do tempo, não events.received_at: o que importa aqui é
 * quando a TENTATIVA de entrega aconteceu (um reenvio manual de evento antigo deve
 * aparecer no dia do reenvio, não no dia em que o evento original chegou).
 */
export async function computeDestinos(projectId, { from, to } = {}) {
  const base = periodClause(from, to, 2, 'd.created_at');
  const where = `WHERE d.project_id = $1 ${base.sql}`;
  const params = [projectId, ...base.params];

  const [porDia, latencia, erros] = await Promise.all([
    query(
      `SELECT to_char(date_trunc('day', d.created_at), 'YYYY-MM-DD') AS data,
              d.destination_type AS destino,
              d.status AS status,
              COUNT(*)::int AS quantidade
         FROM deliveries d ${where}
        GROUP BY 1, 2, 3
        ORDER BY 1, 2`,
      params
    ),
    query(
      `SELECT d.destination_type AS destino,
              AVG(EXTRACT(EPOCH FROM (d.updated_at - d.created_at)))::float AS latencia
         FROM deliveries d ${where}
          AND d.status = 'success'
        GROUP BY 1`,
      params
    ),
    query(
      `WITH agrupado AS (
         SELECT d.destination_type AS destino,
                LEFT(COALESCE(d.last_error, ''), 200) AS erro,
                COUNT(*)::int AS quantidade
           FROM deliveries d ${where}
            AND d.status IN ('error', 'dead')
            AND COALESCE(d.last_error, '') <> ''
          GROUP BY 1, 2
       )
       SELECT destino, erro, quantidade
         FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY destino ORDER BY quantidade DESC) AS rn
             FROM agrupado
         ) ranqueado
        WHERE rn <= ${TOP_ERROS_POR_DESTINO}
        ORDER BY destino, quantidade DESC`,
      params
    ),
  ]);

  const serieMap = new Map();
  for (const r of porDia.rows) {
    const chave = `${r.data}|${r.destino}`;
    if (!serieMap.has(chave)) serieMap.set(chave, { data: r.data, destino: r.destino, status: statusZerados() });
    serieMap.get(chave).status[r.status] = r.quantidade;
  }

  const latenciaMedia = {};
  for (const r of latencia.rows) latenciaMedia[r.destino] = r.latencia ? Number(r.latencia) : 0;

  const topErros = {};
  for (const r of erros.rows) {
    (topErros[r.destino] ||= []).push({ erro: r.erro, quantidade: r.quantidade });
  }

  return {
    serie: [...serieMap.values()],
    latencia_media_segundos: latenciaMedia,
    top_erros: topErros,
  };
}

/**
 * Cobertura de campos de user_data nos eventos recentes — diagnóstico de EMQ.
 * Não é o número oficial da Meta (esse vive no Events Manager), mas mostra ONDE
 * está a perda de match: "purchase sem e-mail em 40% dos casos" aponta o dataLayer.
 */
export async function computeMatchCoverage(projectId, { days = 7 } = {}) {
  const fields = ['email', 'phone', 'fbc', 'fbp', 'external_id', 'client_ip_address', 'client_user_agent'];
  const selects = fields
    .map((f) => `COUNT(*) FILTER (WHERE COALESCE(e.payload->'user_data'->>'${f}', '') <> '')::int AS "${f}"`)
    .join(',\n            ');

  const { rows } = await query(
    `SELECT COUNT(*)::int AS total,
            ${selects}
       FROM events e
      WHERE e.project_id = $1
        AND e.received_at >= now() - ($2 || ' days')::interval`,
    [projectId, days]
  );

  const r = rows[0] || { total: 0 };
  const total = r.total || 0;
  return {
    total,
    days,
    coverage: fields.map((f) => ({
      field: f,
      count: r[f] || 0,
      pct: total ? (r[f] || 0) / total : 0,
    })),
  };
}

// Saúde da fila — usado pelo /health e pelo runbook.
export async function queueHealth() {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS count FROM deliveries GROUP BY status`
  );
  const out = {
    pending: 0, processing: 0, success: 0, error: 0, dead: 0,
    skipped_consent: 0, skipped_unmapped: 0,
  };
  for (const r of rows) out[r.status] = r.count;
  return out;
}

// Expurgo por retenção (LGPD + controle de volume). deliveries cai por CASCADE.
export async function purgeOldEvents(days = env.RETENTION_DAYS) {
  const { rowCount } = await query(
    `DELETE FROM events WHERE received_at < now() - ($1 || ' days')::interval`,
    [days]
  );
  return rowCount;
}
