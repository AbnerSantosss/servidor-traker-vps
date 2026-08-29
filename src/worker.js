// Processo worker: drena a fila de entregas e faz a manutenção periódica.
// Roda separado da API para que uma lentidão da Meta jamais afete o tempo de resposta
// da ingestão. Vários workers podem rodar em paralelo — FOR UPDATE SKIP LOCKED garante
// que dois nunca peguem a mesma entrega.
import { env } from './config/env.js';
import { log } from './config/log.js';
import { waitForDatabase, closePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { claimDeliveries, recoverStuckDeliveries, purgeOldEvents, queueHealth } from './db/repos/events.js';
import { purgeExpiredSessions, purgeExpiredTokens } from './db/repos/users.js';
import { processDelivery } from './queue/dispatcher.js';
import { tick as tickNotificacoes } from './notificacoes/motor.js';

let parando = false;

async function drenar() {
  let processadas = 0;
  // Enquanto houver trabalho, continua sem esperar o próximo poll.
  for (;;) {
    if (parando) break;
    const lote = await claimDeliveries(env.WORKER_CONCURRENCY);
    if (!lote.length) break;
    await Promise.all(lote.map((item) => processDelivery(item).catch((err) => {
      log('error', 'erro não tratado no despacho', { error: err.message });
    })));
    processadas += lote.length;
    if (lote.length < env.WORKER_CONCURRENCY) break;
  }
  return processadas;
}

// Manutenção: roda a cada 5 minutos, fora do caminho quente.
async function manutencao() {
  try {
    const presas = await recoverStuckDeliveries(10);
    if (presas) log('warn', `${presas} entrega(s) presas devolvidas à fila`);

    const sessoes = await purgeExpiredSessions();
    if (sessoes) log('debug', `${sessoes} sessão(ões) expirada(s) removida(s)`);

    const tokens = await purgeExpiredTokens();
    if (tokens) log('debug', `${tokens} token(s) de convite/redefinição expirado(s) removido(s)`);

    if (env.RETENTION_DAYS > 0) {
      const eventos = await purgeOldEvents(env.RETENTION_DAYS);
      if (eventos) log('info', `expurgo de retenção: ${eventos} evento(s) com mais de ${env.RETENTION_DAYS} dias`);
    }
  } catch (err) {
    log('error', 'falha na manutenção periódica', { error: err.message });
  }
}

/**
 * Um tick do motor de notificações (épico E8). Roda a cada minuto, separado da
 * manutenção de 5 em 5 — os gatilhos de alerta (fila acumulada, entrega morta) perdem o
 * sentido se só forem avaliados a cada 5 minutos. `tick()` já protege cada tipo de
 * notificação individualmente (ver src/notificacoes/motor.js); este try/catch é a
 * segunda camada, para o caso raríssimo de algo escapar por cima disso — notificação
 * nunca pode ser motivo de o worker parar de processar a fila de entrega.
 */
async function notificacoes() {
  try {
    await tickNotificacoes();
  } catch (err) {
    log('error', 'falha no tick do motor de notificações', { error: err.message });
  }
}

async function main() {
  await waitForDatabase();
  // O worker também aplica migrações: em deploy novo, tanto faz quem sobe primeiro.
  await runMigrations();

  log('info', 'worker iniciado', {
    concorrencia: env.WORKER_CONCURRENCY,
    poll_ms: env.WORKER_POLL_MS,
    max_tentativas: env.MAX_ATTEMPTS,
    retencao_dias: env.RETENTION_DAYS,
  });

  await manutencao();
  const timerManutencao = setInterval(manutencao, 5 * 60_000);

  await notificacoes();
  const timerNotificacoes = setInterval(notificacoes, 60_000);

  while (!parando) {
    try {
      const n = await drenar();
      if (n) log('debug', `${n} entrega(s) processada(s)`);
    } catch (err) {
      log('error', 'erro no laço do worker', { error: err.message });
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!parando) await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS));
  }

  clearInterval(timerManutencao);
  clearInterval(timerNotificacoes);
  const saude = await queueHealth().catch(() => null);
  log('info', 'worker encerrado', saude || {});
  await closePool();
}

// Encerramento gracioso: termina o lote em andamento antes de sair, para não deixar
// entregas travadas em 'processing'.
for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    if (parando) process.exit(0);
    log('info', `${sinal} recebido, encerrando após o lote atual`);
    parando = true;
  });
}

main().catch(async (err) => {
  log('error', 'falha fatal no worker', { error: err.message, stack: err.stack });
  await closePool();
  process.exit(1);
});
