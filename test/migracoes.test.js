// Migrações no boot.
//
// O que este arquivo protege: em produção a API e o worker sobem em paralelo (mesmo
// compose, mesma imagem) e AMBOS chamam runMigrations(). Antes do advisory lock, os
// dois aplicavam a mesma migração no mesmo instante — um vencia, o outro estourava
// com chave duplicada, saía com código 1 e o container entrava em loop de reinício.
// O sintoma que chegava ao operador era "as migrations não estão sendo executadas no
// startup da api", que aponta para o lugar errado: elas eram executadas, só que duas
// vezes ao mesmo tempo.
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');

describe('migrações no boot', () => {
  after(async () => {
    await closePool();
  });

  test('todas as migrações do disco estão versionadas e visíveis', () => {
    // Guarda contra o defeito que já ocorreu neste projeto: um `.gitignore` com "*.sql"
    // removia src/db/migrations/ inteiro do repositório. O clone subia sem uma tabela
    // sequer, e a falha só aparecia no ambiente novo — longe da causa.
    assert.ok(existsSync(MIGRATIONS_DIR), 'diretório de migrações não existe');
    const arquivos = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    assert.ok(arquivos.length > 0, 'nenhuma migração .sql encontrada');
    assert.ok(
      arquivos.includes('001_init.sql'),
      'a migração inicial sumiu — provável .gitignore engolindo *.sql',
    );
  });

  test('rodar duas vezes em sequência é idempotente', async () => {
    await runMigrations();
    const segunda = await runMigrations();
    assert.equal(segunda, 0, 'a segunda execução não deveria aplicar nada');
  });

  test('duas migrações simultâneas não se atropelam', async () => {
    // Simula o boot real: dois processos migrando ao mesmo tempo. Com o advisory lock,
    // uma espera a outra; sem ele, isto falha com 23505 (chave duplicada em
    // schema_migrations) ou com "relation already exists".
    const resultados = await Promise.allSettled([
      runMigrations(),
      runMigrations(),
      runMigrations(),
    ]);

    const falhas = resultados.filter((r) => r.status === 'rejected');
    assert.equal(
      falhas.length,
      0,
      `migrações concorrentes falharam: ${falhas.map((f) => f.reason?.message).join(' | ')}`,
    );
  });

  test('o registro de migrações aplicadas cobre todos os arquivos do disco', async () => {
    await runMigrations();
    const { rows } = await query('SELECT name FROM schema_migrations');
    const aplicadas = new Set(rows.map((r) => r.name));
    const noDisco = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    for (const arquivo of noDisco) {
      assert.ok(aplicadas.has(arquivo), `migração ${arquivo} não foi registrada como aplicada`);
    }
  });
});
