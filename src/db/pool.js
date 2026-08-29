// Pool de conexões PostgreSQL. Único ponto de acesso ao banco em toda a aplicação.
import pg from 'pg';
import { env } from '../config/env.js';
import { log } from '../config/log.js';

// NUMERIC volta como string por padrão no driver (para não perder precisão).
// Nos nossos usos (valor de conversão, contagens) o número é seguro em float64.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // BIGINT

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  log('error', 'erro inesperado no pool do Postgres', { error: err.message });
});

export function query(text, params) {
  return pool.query(text, params);
}

// Executa um callback dentro de uma transação, com rollback automático em erro.
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Espera o banco aceitar conexões. Usado no boot: em docker compose o Postgres
// pode demorar alguns segundos a mais que o healthcheck para aceitar queries.
export async function waitForDatabase({ retries = 30, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch (err) {
      if (attempt === retries) throw err;
      log('warn', `banco indisponível, tentando de novo (${attempt}/${retries})`, { error: err.message });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

export async function closePool() {
  await pool.end().catch(() => {});
}
