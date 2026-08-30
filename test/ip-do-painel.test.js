// O IP que o painel registra em auditoria e usa para limitar força bruta.
//
// As rotas de autenticação liam `x-forwarded-for` CRU, sem passar por TRUST_PROXY (que
// src/ingest/normalize.js sempre respeitou). Duas consequências, ambas cobertas aqui:
//
//   1. Auditoria envenenada — a coluna `sessions.ip` e o e-mail "sua senha mudou"
//      guardavam o IP que o próprio cliente escolheu escrever no cabeçalho. Quem
//      invadisse uma conta escreveria o IP que quisesse no registro da invasão.
//   2. Rate limit inútil — a chave do limite era esse mesmo IP forjável, então bastava
//      trocar o cabeçalho a cada tentativa para ganhar 20 tentativas novas por vez, e o
//      limite de força bruta virava enfeite.
//
// Os testes rodam nos DOIS estados de TRUST_PROXY porque a correção não é "ignorar o
// cabeçalho": atrás do Caddy o cabeçalho é a única fonte do IP real, e ignorá-lo
// jogaria todo mundo no mesmo balde. O certo é obedecer à configuração — e é isso que
// se verifica: desligado, o cabeçalho não vale nada; ligado, ele vale.
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { createUser } from '../src/db/repos/users.js';
import { resetRateLimit } from '../src/ingest/rate-limit.js';
import { env } from '../src/config/env.js';

const EMAIL = 'auditoria@empresa.com';
const SENHA = 'senha-de-teste-123';

// IP que só existe no cabeçalho: nenhuma conexão do teste vem de lá.
const IP_FORJADO = '203.0.113.66';

let servidor;
let base;
let trustProxyOriginal;

const login = (headers = {}, corpo = {}) =>
  fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ email: EMAIL, password: SENHA, ...corpo }),
  });

/** IP gravado na sessão mais recente — é o registro de auditoria do login. */
async function ipDaUltimaSessao() {
  const { rows } = await query('SELECT ip FROM sessions ORDER BY created_at DESC LIMIT 1');
  return rows[0] ? String(rows[0].ip) : null;
}

before(async () => {
  await runMigrations();
  await query(
    'TRUNCATE events, deliveries, identities, destinations, project_domains, projects, sessions, user_tokens, users CASCADE'
  );
  await createUser({ email: EMAIL, password: SENHA, name: 'Auditoria' });

  trustProxyOriginal = env.TRUST_PROXY;
  servidor = createApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  env.TRUST_PROXY = trustProxyOriginal;
  await new Promise((r) => servidor.close(r));
  await closePool();
});

beforeEach(async () => {
  resetRateLimit();
  await query('TRUNCATE sessions');
});

describe('TRUST_PROXY desligado: o X-Forwarded-For do cliente não vale nada', () => {
  before(() => { env.TRUST_PROXY = false; });

  test('login: o IP forjado no cabeçalho NÃO entra no registro de auditoria', async () => {
    const res = await login({ 'X-Forwarded-For': IP_FORJADO });
    assert.equal(res.status, 200);

    const ip = await ipDaUltimaSessao();
    assert.notEqual(ip, IP_FORJADO, 'o cabeçalho forjado virou o IP da auditoria — é o bug');
    assert.match(ip, /^(127\.0\.0\.1|::1)$/, `deveria registrar o IP da conexão, veio "${ip}"`);
  });

  test('login: uma cadeia inteira forjada também é descartada', async () => {
    // Cadeia longa é a tentativa clássica de esconder o IP real no meio da lista.
    await login({ 'X-Forwarded-For': `${IP_FORJADO}, 198.51.100.1, 192.0.2.1` });
    assert.notEqual(await ipDaUltimaSessao(), IP_FORJADO);
  });

  test('login: X-Real-IP forjado também é descartado', async () => {
    await login({ 'X-Real-IP': IP_FORJADO });
    assert.notEqual(await ipDaUltimaSessao(), IP_FORJADO);
  });

  test('rate limit: trocar de X-Forwarded-For a cada tentativa não zera o contador', async () => {
    // O limite de /login é 20 por minuto. Com o cabeçalho cru, cada IP inventado abria
    // um balde novo e o atacante nunca via 429 — é o furo que este teste tranca.
    let ultimaResposta;
    for (let i = 0; i < 22; i++) {
      ultimaResposta = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${i}` },
        body: JSON.stringify({ email: EMAIL, password: 'senha-errada' }),
      });
    }
    assert.equal(ultimaResposta.status, 429, 'todas as tentativas vêm da mesma conexão: deveria travar');
  });

  test('rate limit de /esqueci-senha usa o mesmo IP de conexão', async () => {
    // Limite de 10 por minuto na mesma rota.
    let ultimaResposta;
    for (let i = 0; i < 12; i++) {
      ultimaResposta = await fetch(`${base}/api/auth/esqueci-senha`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${i}` },
        body: JSON.stringify({ email: 'ninguem@empresa.com' }),
      });
    }
    assert.equal(ultimaResposta.status, 429);
  });
});

describe('TRUST_PROXY ligado: o cabeçalho do proxy é a fonte do IP real', () => {
  before(() => { env.TRUST_PROXY = true; });

  test('login: o primeiro IP da cadeia é o que vai para a auditoria', async () => {
    // Atrás do Caddy, ignorar o cabeçalho registraria o IP do container em todo login.
    await login({ 'X-Forwarded-For': `${IP_FORJADO}, 10.0.0.1, 172.17.0.1` });
    assert.equal(await ipDaUltimaSessao(), IP_FORJADO);
  });

  test('rate limit: IPs distintos declarados pelo proxy contam separado', async () => {
    for (let i = 0; i < 22; i++) {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${i}` },
        body: JSON.stringify({ email: EMAIL, password: 'senha-errada' }),
      });
      assert.notEqual(res.status, 429, `visitante ${i} é outro IP, não deveria herdar o limite alheio`);
    }
  });
});
