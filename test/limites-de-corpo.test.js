// Limites de tamanho de corpo por caminho.
//
// O defeito que este arquivo tranca: os routers de ingestão são montados na RAIZ
// (`app.use(ingestRouter)`), então um `router.use(json({limit}))` sem caminho
// rodava para toda requisição do processo. O limite da ingestão virava,
// silenciosamente, o limite do painel — e um corpo maior morria como 413
// genérico dentro do parser, antes de chegar à rota que saberia explicar o erro.
//
// Foi encontrado ao subir a logo de um projeto: 200 KB de imagem viram ~267 KB em
// base64 e batiam no teto de 256 KB da ingestão, devolvendo "erro interno" em vez
// da mensagem de validação. O sintoma apareceu longe da causa, que é o motivo de
// existir teste para isto.
import './setup-env.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { closePool } from '../src/db/pool.js';

let servidor;
let base;

before(async () => {
  await runMigrations();
  const app = createApp();
  await new Promise((resolve) => {
    servidor = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  await new Promise((resolve) => servidor.close(resolve));
  await closePool();
});

/** Corpo JSON com aproximadamente `kb` quilobytes. */
function corpoDe(kb) {
  return JSON.stringify({ recheio: 'x'.repeat(kb * 1024) });
}

describe('limites de corpo por caminho', () => {
  test('o painel aceita corpo maior que o teto da ingestão', async () => {
    // 400 KB passa do teto de 256 KB da ingestão e cabe no 1 MB do /api. O que
    // importa aqui NÃO é o status final (a rota vai recusar por falta de sessão),
    // e sim que a recusa venha da rota — e não um 413 do parser.
    const res = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Traker-Painel': '1' },
      body: corpoDe(400),
    });

    assert.notEqual(res.status, 413, 'o corpo do painel bateu no teto da ingestão');
    assert.ok(
      [400, 401, 403].includes(res.status),
      `esperava a rota decidir (400/401/403), veio ${res.status}`,
    );
  });

  test('a ingestão continua com o teto dela', async () => {
    // 300 KB passa dos 256 KB da ingestão: aqui o 413 é o comportamento certo.
    const res = await fetch(`${base}/e/projeto-que-nao-existe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: corpoDe(300),
    });

    assert.equal(res.status, 413, 'a ingestão deixou passar corpo acima do teto dela');
  });

  test('a rota de identidade continua com o teto dela', async () => {
    // O coletor aceita 64 KB — payload de identidade é pequeno por natureza, e um
    // teto baixo aqui é defesa, não economia.
    const res = await fetch(`${base}/c/projeto-que-nao-existe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: corpoDe(100),
    });

    assert.equal(res.status, 413, 'o coletor deixou passar corpo acima do teto dele');
  });

  // No repo de deploy da API não existe `public/`, então `/login` é 404 legítimo —
  // o painel é servido pelo repo do app. Mesmo padrão dos testes de página em
  // integracao.test.js.
  const SEM_PAINEL = !existsSync(new URL('../public/login.html', import.meta.url))
    && 'painel servido pelo repo do app';

  test('página estática não passa por parser de corpo nenhum', { skip: SEM_PAINEL }, async () => {
    // Um GET comum não deve ser afetado pelos parsers; se algum `use` solto
    // voltar, isto continua passando — mas o primeiro teste falha. São
    // complementares: este garante que a correção não quebrou o caminho normal.
    const res = await fetch(`${base}/login`);
    assert.equal(res.status, 200);
  });
});
