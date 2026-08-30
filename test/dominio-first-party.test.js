// Endereço first-party na tag (defeito documentado em wiki/arquitetura/Endereço First-Party na Tag.md).
//
// O que estes testes fixam: o endereço que o servidor escreve na tag e nos campos de
// copiar-e-colar do painel é o DOMÍNIO VERIFICADO DO PROJETO — não o host de quem pediu
// o script. O bug antigo não dava erro (o CORS passa, a ingestão responde 202); o que
// quebrava era o cookie `_fbp`/`_fbc` nascer no domínio do serviço, ilegível para o Pixel
// que roda na página do cliente. Só teste pega uma regressão silenciosa dessas.
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { createUser } from '../src/db/repos/users.js';
import { addDomain, setDomainStatus } from '../src/db/repos/projects.js';
import { escolherHostFirstParty, normalizarHost } from '../src/tenancy/first-party.js';

const dom = (hostname, verification_status, is_primary = false) => ({ hostname, verification_status, is_primary });

describe('escolherHostFirstParty (unitário, sem banco)', () => {
  test('projeto sem domínio nenhum devolve null — quem chama cai no comportamento antigo', () => {
    assert.equal(escolherHostFirstParty([]), null);
    assert.equal(escolherHostFirstParty(null), null);
    assert.equal(escolherHostFirstParty(undefined), null);
  });

  test('domínio pending ou failed nunca é escolhido', () => {
    assert.equal(escolherHostFirstParty([dom('cliente.com', 'pending', true)]), null);
    assert.equal(escolherHostFirstParty([dom('cliente.com', 'failed', true)]), null);
  });

  test('o domínio raiz pending do onboarding não sequestra o subdomínio verificado', () => {
    // Caso real: no cadastro do projeto informa-se o site (cliente.com), que fica
    // eternamente `pending` porque ninguém aponta o site inteiro para cá; o subdomínio
    // t.cliente.com é o que de fato foi verificado.
    const escolhido = escolherHostFirstParty([
      dom('cliente.com', 'pending', true),
      dom('t.cliente.com', 'active'),
    ]);
    assert.equal(escolhido, 't.cliente.com');
  });

  test('active (certificado emitido) ganha de verified', () => {
    assert.equal(
      escolherHostFirstParty([dom('a.cliente.com', 'verified', true), dom('b.cliente.com', 'active')]),
      'b.cliente.com'
    );
  });

  test('entre status iguais o primário ganha (ordem que listDomains entrega)', () => {
    assert.equal(
      escolherHostFirstParty([dom('primario.cliente.com', 'active', true), dom('outro.cliente.com', 'active')]),
      'primario.cliente.com'
    );
  });

  test('se o script foi pedido por um domínio do próprio projeto, é esse que vale', () => {
    // Projeto com dois sites: cada página tem de falar com o SEU subdomínio, senão o
    // cookie volta a nascer cruzado — exatamente o que se quer evitar.
    const domains = [dom('a.cliente.com', 'active', true), dom('b.cliente.com', 'active')];
    assert.equal(escolherHostFirstParty(domains, { preferido: 'b.cliente.com' }), 'b.cliente.com');
    assert.equal(escolherHostFirstParty(domains, { preferido: 'b.cliente.com:443' }), 'b.cliente.com');
    assert.equal(escolherHostFirstParty(domains, { preferido: 'B.Cliente.COM' }), 'b.cliente.com');
  });

  test('host da requisição que não é domínio elegível do projeto é ignorado', () => {
    // É o caso do painel: ele busca o script no host do serviço, e era daí que vinha o bug.
    const domains = [dom('t.cliente.com', 'active')];
    assert.equal(escolherHostFirstParty(domains, { preferido: 'zyraflow.site' }), 't.cliente.com');
    assert.equal(
      escolherHostFirstParty([dom('t.cliente.com', 'active'), dom('novo.cliente.com', 'pending')], {
        preferido: 'novo.cliente.com',
      }),
      't.cliente.com'
    );
  });

  test('normalizarHost tira porta, espaço e caixa', () => {
    assert.equal(normalizarHost(' T.Cliente.COM:8443 '), 't.cliente.com');
    assert.equal(normalizarHost(''), null);
    assert.equal(normalizarHost(undefined), null);
  });
});

// ------------------------------------------------------- integração (Postgres real)

let servidor;
let base;
let hostRequisicao;
let cookie = '';
let projeto;

// Extrai o endereço que a tag realmente vai chamar, em vez de procurar substring solta:
// `t.cliente.com` contém `cliente.com`, e um assert por substring passaria com o
// endereço errado.
const endpointsDoScript = (js) =>
  [...js.matchAll(/var ENDPOINT(?:_EVENTO|_COLETA)? = "([^"]+)";/g)].map((m) => m[1]);

before(async () => {
  await runMigrations();
  await query(
    'TRUNCATE events, deliveries, identities, destinations, project_domains, projects, sessions, user_tokens, users CASCADE'
  );
  await createUser({ email: 'firstparty@empresa.com', password: 'senha-de-teste-123', name: 'Teste First Party' });

  servidor = createApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  hostRequisicao = `127.0.0.1:${servidor.address().port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'firstparty@empresa.com', password: 'senha-de-teste-123' }),
  });
  cookie = login.headers.getSetCookie().find((c) => c.startsWith('traker_sess=')).split(';')[0];

  const res = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'Loja First Party', domain: 'lojafp.example' }),
  });
  projeto = await res.json();
});

after(async () => {
  await new Promise((r) => servidor.close(r));
  await closePool();
});

describe('projeto sem domínio verificado — comportamento antigo, sem regressão', () => {
  test('a tag sai com o host da requisição enquanto o domínio do cadastro está pending', async () => {
    const js = await (await fetch(`${base}/t/${projeto.slug}.js`)).text();
    assert.deepEqual(endpointsDoScript(js), [`http://${hostRequisicao}/e/${projeto.slug}`]);
  });

  test('as URLs do painel saem no host do serviço (PUBLIC_HOST)', async () => {
    const p = await (await fetch(`${base}/api/projects/${projeto.id}`, { headers: { Cookie: cookie } })).json();
    assert.equal(p.urls.base, 'http://traker.teste.local');
    assert.equal(p.urls.scriptTag, `http://traker.teste.local/t/${projeto.slug}.js`);
  });
});

describe('projeto com domínio verificado — a tag nasce no domínio do cliente', () => {
  before(async () => {
    await addDomain(projeto.id, 't.lojafp.example');
    await setDomainStatus('t.lojafp.example', 'verified');
  });

  test('/t/:slug.js (GTM) aponta para o subdomínio verificado, não para o host do serviço', async () => {
    const js = await (await fetch(`${base}/t/${projeto.slug}.js`)).text();
    assert.deepEqual(endpointsDoScript(js), [`http://t.lojafp.example/e/${projeto.slug}`]);
  });

  test('/s/:slug.js (coletor) também', async () => {
    const js = await (await fetch(`${base}/s/${projeto.slug}.js`)).text();
    assert.deepEqual(endpointsDoScript(js), [`http://t.lojafp.example/c/${projeto.slug}`]);
  });

  test('/w/:slug.js (tag única, sem GTM) também, nos dois endpoints', async () => {
    const js = await (await fetch(`${base}/w/${projeto.slug}.js`)).text();
    assert.deepEqual(endpointsDoScript(js), [
      `http://t.lojafp.example/e/${projeto.slug}`,
      `http://t.lojafp.example/c/${projeto.slug}`,
    ]);
  });

  test('as URLs de copiar-e-colar do painel acompanham — painel e tag não podem divergir', async () => {
    const p = await (await fetch(`${base}/api/projects/${projeto.id}`, { headers: { Cookie: cookie } })).json();
    assert.equal(p.urls.base, 'http://t.lojafp.example');
    assert.equal(p.urls.evento, `http://t.lojafp.example/e/${projeto.slug}`);
    assert.equal(p.urls.coleta, `http://t.lojafp.example/c/${projeto.slug}`);
    assert.equal(p.urls.scriptColetor, `http://t.lojafp.example/s/${projeto.slug}.js`);
    assert.equal(p.urls.scriptTag, `http://t.lojafp.example/t/${projeto.slug}.js`);
    // A tag única é a que o painel deduzia sozinho, e por isso saía no host do serviço
    // mesmo depois do resto corrigido. Agora vem do servidor como as outras.
    assert.equal(p.urls.scriptUnica, `http://t.lojafp.example/w/${projeto.slug}.js`);
  });

  test('a listagem do painel (barra lateral) também traz o domínio do cliente', async () => {
    const lista = await (await fetch(`${base}/api/projects`, { headers: { Cookie: cookie } })).json();
    const p = lista.find((x) => x.id === projeto.id);
    assert.equal(p.urls.base, 'http://t.lojafp.example');
  });

  test('domínio failed volta a valer o comportamento antigo (tag não aponta para domínio quebrado)', async () => {
    await setDomainStatus('t.lojafp.example', 'failed');
    const js = await (await fetch(`${base}/t/${projeto.slug}.js`)).text();
    assert.deepEqual(endpointsDoScript(js), [`http://${hostRequisicao}/e/${projeto.slug}`]);
    await setDomainStatus('t.lojafp.example', 'verified');
  });
});
