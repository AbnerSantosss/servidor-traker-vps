// Preenche utm_medium/utm_campaign/tem_fbc/tem_gclid dos eventos gravados ANTES da
// migração 003_analytics — ela só cria as colunas (ver comentário lá) porque um UPDATE em
// massa dentro da transação da migração travaria o deploy numa tabela de produção grande.
//
// Idempotente e retomável: cada lote só pega linhas ainda não processadas (as 4 colunas
// novas com valor NULL ao mesmo tempo) e o UPDATE sempre grava tem_fbc/tem_gclid como
// TRUE ou FALSE — nunca NULL de novo. É essa garantia que faz a condição "ainda não
// processado" parar de bater na linha depois do primeiro UPDATE, mesmo quando o evento
// realmente não tinha UTM nenhum (utm_medium/utm_campaign continuam NULL, mas
// tem_fbc/tem_gclid não). Sem ela, a mesma linha voltaria a cada lote para sempre.
import { query, waitForDatabase, closePool } from '../db/pool.js';

const TAMANHO_LOTE_PADRAO = 5000;

/**
 * Processa um único lote. Devolve quantas linhas foram atualizadas — 0 significa que
 * não há mais nada pendente (condição de parada do loop em `rodarBackfill`).
 */
export async function processarLote(tamanhoLote = TAMANHO_LOTE_PADRAO) {
  const { rows } = await query(
    `UPDATE events e
        SET utm_medium   = sub.utm_medium,
            utm_campaign = sub.utm_campaign,
            tem_fbc      = sub.tem_fbc,
            tem_gclid    = sub.tem_gclid
       FROM (
         SELECT id,
                NULLIF(payload->'user_data'->>'utm_medium', '')   AS utm_medium,
                NULLIF(payload->'user_data'->>'utm_campaign', '') AS utm_campaign,
                (
                  COALESCE(payload->'user_data'->>'fbc', '') <> ''
                  OR COALESCE(payload->'user_data'->>'fbclid', '') <> ''
                ) AS tem_fbc,
                (
                  COALESCE(payload->'user_data'->>'gclid', '') <> ''
                  OR COALESCE(payload->'user_data'->>'gbraid', '') <> ''
                  OR COALESCE(payload->'user_data'->>'wbraid', '') <> ''
                ) AS tem_gclid
           FROM events
          WHERE utm_medium IS NULL AND utm_campaign IS NULL
            AND tem_fbc IS NULL AND tem_gclid IS NULL
          LIMIT $1
       ) sub
      WHERE e.id = sub.id
      RETURNING e.id`,
    [tamanhoLote]
  );
  return rows.length;
}

/**
 * Roda em lotes até esgotar as linhas pendentes, imprimindo progresso. Seguro de
 * interromper (Ctrl+C) e retomar depois: o próximo lote continua de onde parou, porque
 * a seleção é sempre "o que ainda está NULL", nunca um cursor de posição.
 */
export async function rodarBackfill({ tamanhoLote = TAMANHO_LOTE_PADRAO } = {}) {
  let total = 0;
  let processadosNoLote;
  do {
    processadosNoLote = await processarLote(tamanhoLote);
    total += processadosNoLote;
    if (processadosNoLote > 0) {
      console.log(`backfill-analytics: ${total} eventos atualizados até agora`);
    }
  } while (processadosNoLote === tamanhoLote); // lote cheio = provavelmente ainda há mais

  console.log(`backfill-analytics: concluído, ${total} eventos atualizados no total`);
  return total;
}

// Execução direta (`npm run backfill:analytics`) — mesmo padrão de src/db/migrate.js.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('backfill-analytics.js')) {
  try {
    await waitForDatabase();
    await rodarBackfill();
  } catch (err) {
    console.error(`falha no backfill: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
