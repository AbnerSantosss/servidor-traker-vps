// Cria (ou redefine a senha de) um usuário do painel.
//   npm run criar-usuario -- email@empresa.com "senha-forte" "Nome"
// Sem argumentos, usa ADMIN_EMAIL / ADMIN_PASSWORD do ambiente.
import { createUser } from '../db/repos/users.js';
import { waitForDatabase, closePool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { log } from '../config/log.js';

const [, , emailArg, senhaArg, nomeArg] = process.argv;
const email = emailArg || process.env.ADMIN_EMAIL;
const senha = senhaArg || process.env.ADMIN_PASSWORD;

if (!email || !senha) {
  console.error('Uso: npm run criar-usuario -- <email> <senha> [nome]');
  console.error('     (ou defina ADMIN_EMAIL e ADMIN_PASSWORD no .env)');
  process.exit(1);
}

try {
  await waitForDatabase();
  await runMigrations();
  const user = await createUser({ email, password: senha, name: nomeArg });
  log('info', 'usuário pronto para uso', { email: user.email, id: user.id });
  console.log(`\nUsuário ${user.email} criado/atualizado. Acesse /login para entrar.\n`);
} catch (err) {
  console.error(`Falha: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
