// Cria um projeto de exemplo para validar a instalação ponta a ponta.
// Não configura credenciais reais: os destinos nascem desligados de propósito.
import { createProject, getProjectByDomain, addDomain } from '../db/repos/projects.js';
import { waitForDatabase, closePool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { publicBaseUrl } from '../config/env.js';

const DOMINIO = process.argv[2] || 'demo.local';

try {
  await waitForDatabase();
  await runMigrations();

  let project = await getProjectByDomain(DOMINIO);
  if (project) {
    console.log(`Projeto de exemplo já existia: ${project.id}`);
  } else {
    project = await createProject({ name: 'Projeto Demo', domain: DOMINIO });
    await addDomain(project.id, DOMINIO, { isPrimary: true }).catch(() => {});
    console.log(`Projeto criado: ${project.id}`);
  }

  const base = publicBaseUrl();
  console.log(`
  project_id ......... ${project.id}
  slug ............... ${project.slug}
  endpoint de evento . ${base}/e/${project.slug}
  endpoint de coleta . ${base}/c/${project.slug}
  script coletor ..... ${base}/s/${project.slug}.js
  token de webhook ... ${project.ingestToken}

  Teste rápido:
    curl -X POST ${base}/e/${project.slug} \\
      -H "Content-Type: application/json" \\
      -d '{"event_name":"purchase","event_id":"teste-001","custom_data":{"value":199.9,"currency":"BRL"}}'
`);
} catch (err) {
  console.error(`Falha no seed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
