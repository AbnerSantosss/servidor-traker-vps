// Migrador simples: aplica em ordem os .sql de migrations/ que ainda não rodaram.
// Cada migração é aplicada dentro de uma transação e registrada em schema_migrations,
// então rodar `npm run migrate` várias vezes é seguro (idempotente).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, transaction, waitForDatabase, closePool } from './pool.js';
import { log } from '../config/log.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// Identificador do advisory lock. É um número arbitrário mas FIXO: o que importa é
// que todos os processos desta aplicação usem o mesmo, porque é a chave que os
// serializa entre si.
const LOCK_ID = 4_073_120_001;

function listarMigracoes() {
  // Diretório ausente é o sintoma clássico de migração não versionada (um `.gitignore`
  // com `*.sql` engole a pasta inteira). Sem este aviso, o processo subiria "com
  // sucesso" contra um banco sem tabela nenhuma e a falha só apareceria na primeira
  // query — longe daqui, difícil de associar à causa.
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(
      `diretório de migrações não encontrado: ${MIGRATIONS_DIR}. ` +
      'Se isto é um deploy, confira se src/db/migrations/*.sql está versionado ' +
      '(um .gitignore com "*.sql" remove as migrações do repositório).'
    );
  }
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    throw new Error(
      `nenhuma migração encontrada em ${MIGRATIONS_DIR}. ` +
      'Confira se os arquivos .sql chegaram à imagem/repositório de deploy.'
    );
  }
  return files;
}

export async function runMigrations() {
  await waitForDatabase();

  const files = listarMigracoes();

  // API e worker sobem em paralelo no compose e ambos migram no boot. Sem trava, os
  // dois aplicam a mesma migração ao mesmo tempo: um vence e o outro estoura
  // ("relation already exists" ou deadlock), sai com código 1 e o container entra em
  // loop de reinício — exatamente o sintoma de "as migrations não rodam no startup".
  //
  // O advisory lock é do Postgres, não da tabela: quem chega primeiro migra, quem
  // chega depois espera aqui e segue com o banco já atualizado. Precisa de uma conexão
  // dedicada (o lock é da sessão, e o pool poderia devolver outra conexão no unlock).
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await transaction(async (tx) => {
        await tx.query(sql);
        await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
      log('info', `migração aplicada: ${file}`);
      count++;
    }

    if (count === 0) log('info', 'banco já está atualizado, nenhuma migração pendente');
    return count;
  } finally {
    // Libera antes de devolver a conexão ao pool. Se o processo morrer aqui, o
    // Postgres solta o lock sozinho ao encerrar a sessão — não fica preso.
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

// Execução direta (`npm run migrate`)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.js')) {
  runMigrations()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      log('error', 'falha ao migrar', { error: err.message });
      await closePool();
      process.exit(1);
    });
}
