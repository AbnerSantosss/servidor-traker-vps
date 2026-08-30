// Painel servido de OUTRA origem que a API.
//
// Este arquivo cobre o arranjo de produção do Azure: o painel é um container nginx em
// app.zyraflow.site e a API é o Node em zyraflow.site. Origens diferentes para o
// navegador (logo, CORS), mesmo site para o cookie (logo, SameSite=Lax continua valendo).
//
// Por que um arquivo próprio: o modo depende de PANEL_ORIGINS, e o resto da suíte roda com
// ele VAZIO — de propósito, porque o modo padrão precisa continuar sendo o testado. Aqui a
// variável é ligada e desligada por bloco, o que exercita também a transição entre os dois
// modos (é ela que o rollback usa: esvaziar PANEL_ORIGINS devolve a API ao modo monolito).
//
// O que se pretende impedir é uma classe de defeito específica: o arranjo tem quatro peças
// em série (CSP do painel, URL da API no front, cookie, CORS) e mexer numa só não produz
// efeito visível nenhum. Sem cobertura, "não funciona" fica indistinguível de "funciona mas
// falta uma peça" — foi exatamente o que aconteceu em produção.
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { createUser } from '../src/db/repos/users.js';
import { createProject } from '../src/db/repos/projects.js';
import { env } from '../src/config/env.js';
import { painelEhSameSite } from '../src/admin/seguranca.js';

const PAINEL = 'https://app.traker.teste.local';   // subdomínio do PUBLIC_HOST da suíte
const ESTRANHA = 'https://mal.example';

let servidor;
let base;
let projeto;
let cookieSessao = '';

// env.PANEL_ORIGINS é lido a CADA requisição pelos middlewares (não capturado no boot),
// então dá para ligar e desligar o modo com o servidor no ar. Isso não é só conveniência
// de teste: é a propriedade que faz o rollback do plano funcionar sem rebuild de imagem.
const comPainelSeparado = (origens = [PAINEL]) => { env.PANEL_ORIGINS = origens; };
const semPainelSeparado = () => { env.PANEL_ORIGINS = []; };

const logar = async (origin = PAINEL) => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Traker-Painel': '1', Origin: origin },
    body: JSON.stringify({ email: 'separado@empresa.com', password: 'senha-de-teste-123' }),
  });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie().find((c) => c.startsWith('traker_sess='));
};

before(async () => {
  await runMigrations();
  await query('TRUNCATE events, deliveries, identities, destinations, project_domains, projects, sessions, user_tokens, users CASCADE');
  await createUser({ email: 'separado@empresa.com', password: 'senha-de-teste-123', name: 'Separado' });
  projeto = await createProject({ name: 'Origem Separada', domain: 'cliente-separado.local' });

  servidor = createApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  semPainelSeparado();
  await new Promise((r) => servidor.close(r));
  await closePool();
});

beforeEach(() => { semPainelSeparado(); });

// ════════════════════════════════════════════════════════════════════════════════
// Mesmo site × outra origem
// ════════════════════════════════════════════════════════════════════════════════
describe('painelEhSameSite — decide o SameSite do cookie', () => {
  // PUBLIC_HOST da suíte é traker.teste.local (setup-env.js).
  const casos = [
    { origens: [],                                  esperado: true,  porque: 'sem painel separado a pergunta não se aplica' },
    { origens: ['https://app.traker.teste.local'],  esperado: true,  porque: 'subdomínio do host da API' },
    { origens: ['https://traker.teste.local'],      esperado: true,  porque: 'o próprio host, em outro esquema ou porta' },
    { origens: ['https://a.b.traker.teste.local'],  esperado: true,  porque: 'subdomínio em mais de um nível' },
    { origens: ['https://mal.example'],             esperado: false, porque: 'outro domínio' },
    { origens: ['https://outro-teste.local'],       esperado: false, porque: 'sufixo parecido, domínio diferente' },
    { origens: ['https://faketraker.teste.local'],  esperado: false, porque: 'casaria num endsWith escrito sem o ponto' },
    { origens: ['https://app.traker.teste.local', 'https://mal.example'], esperado: false, porque: 'uma cross-site basta para reprovar' },
    { origens: ['nao-e-url'],                       esperado: false, porque: 'origem malformada não pode virar Lax' },
  ];

  for (const { origens, esperado, porque } of casos) {
    test(`${JSON.stringify(origens)} → ${esperado} (${porque})`, () => {
      env.PANEL_ORIGINS = origens;
      assert.equal(painelEhSameSite(), esperado);
    });
  }

  // Este é o caso que uma comparação "dois últimos labels" erraria: em .com.br os dois
  // últimos labels são o próprio sufixo público, e dois clientes diferentes pareceriam o
  // mesmo site — um Lax indevido, ou seja uma brecha de CSRF.
  test('não confunde domínios distintos sob o mesmo sufixo composto', () => {
    const original = env.PUBLIC_HOST;
    try {
      env.PUBLIC_HOST = 'empresa-a.com.br';
      env.PANEL_ORIGINS = ['https://painel.empresa-b.com.br'];
      assert.equal(painelEhSameSite(), false);
    } finally {
      env.PUBLIC_HOST = original;
    }
  });

  test('porta no PUBLIC_HOST não atrapalha a comparação', () => {
    const original = env.PUBLIC_HOST;
    try {
      env.PUBLIC_HOST = 'traker.teste.local:3000';
      env.PANEL_ORIGINS = ['https://app.traker.teste.local'];
      assert.equal(painelEhSameSite(), true);
    } finally {
      env.PUBLIC_HOST = original;
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Cookie de sessão
// ════════════════════════════════════════════════════════════════════════════════
describe('cookie de sessão no modo separado', () => {
  test('painel em subdomínio mantém SameSite=Lax', async () => {
    comPainelSeparado();
    const cookie = await logar();
    assert.match(cookie, /SameSite=Lax/);
    assert.ok(!cookie.includes('SameSite=None'), 'same-site não precisa abrir mão do Lax');
  });

  test('painel em outro domínio cai para SameSite=None; Secure', async () => {
    // Sem Secure o navegador DESCARTA um cookie SameSite=None em silêncio — e o sintoma
    // seria "o login responde 200 e a próxima chamada dá 401", sem erro em lugar nenhum.
    comPainelSeparado([ESTRANHA]);
    const cookie = await logar(ESTRANHA);
    assert.match(cookie, /SameSite=None/);
    assert.match(cookie, /Secure/);
  });

  test('logout limpa o cookie com os MESMOS atributos com que ele foi criado', async () => {
    // Um Set-Cookie de remoção com atributos diferentes é descartado pelo navegador em
    // contexto cross-site: a sessão continuaria valendo no lado do usuário depois do
    // logout, sem nenhum sinal na tela.
    comPainelSeparado([ESTRANHA]);
    const cookie = await logar(ESTRANHA);
    const res = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { 'X-Traker-Painel': '1', Origin: ESTRANHA, Cookie: cookie.split(';')[0] },
    });
    assert.equal(res.status, 200);

    const limpeza = res.headers.getSetCookie().find((c) => c.startsWith('traker_sess='));
    assert.ok(limpeza, 'logout deveria mandar Set-Cookie de remoção');
    for (const atributo of ['SameSite=None', 'Secure', 'HttpOnly', 'Path=/']) {
      assert.ok(limpeza.includes(atributo), `a limpeza precisa repetir ${atributo}`);
    }
  });

  test('modo padrão (mesma origem) segue Lax, sem Secure em http', async () => {
    semPainelSeparado();
    const cookie = await logar();
    assert.match(cookie, /SameSite=Lax/);
    assert.ok(!cookie.includes('Secure'), 'em http local, Secure impediria o cookie de valer');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// CORS do painel
// ════════════════════════════════════════════════════════════════════════════════
describe('CORS do painel', () => {
  test('preflight de origem autorizada devolve 204 com credenciais liberadas', async () => {
    comPainelSeparado();
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: PAINEL,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, x-traker-painel',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), PAINEL);
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    // Sem o cabeçalho do painel na lista, o preflight reprova e a escrita nunca sai.
    assert.match(res.headers.get('access-control-allow-headers'), /x-traker-painel/i);
    // Vary: Origin é obrigatório — sem ele um cache intermediário pode servir a resposta
    // de uma origem para outra.
    assert.match(res.headers.get('vary') || '', /Origin/);
  });

  test('origem estranha não recebe cabeçalho de CORS nenhum', async () => {
    comPainelSeparado();
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: ESTRANHA, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  });

  test('no modo padrão a API não emite CORS (nem para a origem que seria a do painel)', async () => {
    semPainelSeparado();
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: PAINEL, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// CSRF: o cabeçalho do painel
// ════════════════════════════════════════════════════════════════════════════════
describe('proteção de escrita no modo separado', () => {
  before(async () => {
    comPainelSeparado();
    cookieSessao = (await logar()).split(';')[0];
  });

  const escrever = (headers, sufixo) => fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieSessao, ...headers },
    body: JSON.stringify({ name: 'Teste CSRF', domain: `csrf-${sufixo}.local` }),
  });

  test('escrita sem X-Traker-Painel é recusada com 403', async () => {
    comPainelSeparado();
    const res = await escrever({ Origin: PAINEL }, 'sem-cabecalho');
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'requisição sem identificação do painel');
  });

  test('escrita de origem não autorizada é recusada com 403', async () => {
    comPainelSeparado();
    const res = await escrever({ Origin: ESTRANHA, 'X-Traker-Painel': '1' }, 'origem-ma');
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'origem não autorizada');
  });

  test('escrita do painel autorizado passa', async () => {
    comPainelSeparado();
    const res = await escrever({ Origin: PAINEL, 'X-Traker-Painel': '1' }, 'ok');
    assert.equal(res.status, 201);
  });

  test('leitura não exige o cabeçalho (GET nunca é alvo de CSRF por formulário)', async () => {
    comPainelSeparado();
    const res = await fetch(`${base}/api/projects`, { headers: { Cookie: cookieSessao, Origin: PAINEL } });
    assert.equal(res.status, 200);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Rotas públicas que o painel consome
// ════════════════════════════════════════════════════════════════════════════════
describe('rotas públicas alcançáveis pelo painel em outra origem', () => {
  test('script do coletor é buscável por fetch de qualquer origem', async () => {
    // A aba Instalação busca este arquivo para mostrar o código na tela. Sem
    // Access-Control-Allow-Origin o fetch falha e a tela cai no texto de fallback —
    // degradação silenciosa, que passaria por "funcionando".
    comPainelSeparado();
    const res = await fetch(`${base}/s/${projeto.slug}.js`, { headers: { Origin: PAINEL } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    // Curinga e credenciais são incompatíveis por especificação; a rota não usa cookie.
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  });

  test('ingestão aceita a origem do painel mesmo com allowedOrigins restrito', async () => {
    // O console de testes envia evento por esta rota. Restringir allowedOrigins ao
    // domínio do cliente é a configuração RECOMENDADA — e era justamente ela que
    // desligava o console quando o painel passou a ter host próprio.
    comPainelSeparado();
    await query('UPDATE projects SET allowed_origins = $1 WHERE id = $2', [['https://cliente-separado.local'], projeto.id]);
    try {
      const res = await fetch(`${base}/e/${projeto.slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: PAINEL },
        body: JSON.stringify({ event_name: 'page_view', event_id: `sep-${Date.now()}` }),
      });
      assert.equal(res.headers.get('access-control-allow-origin'), PAINEL);
      assert.equal(res.status, 202);
    } finally {
      await query('UPDATE projects SET allowed_origins = $1 WHERE id = $2', [[], projeto.id]);
    }
  });

  test('origem estranha continua barrada na ingestão restrita', async () => {
    comPainelSeparado();
    await query('UPDATE projects SET allowed_origins = $1 WHERE id = $2', [['https://cliente-separado.local'], projeto.id]);
    try {
      const res = await fetch(`${base}/e/${projeto.slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ESTRANHA },
        body: JSON.stringify({ event_name: 'page_view', event_id: `sep-mal-${Date.now()}` }),
      });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    } finally {
      await query('UPDATE projects SET allowed_origins = $1 WHERE id = $2', [[], projeto.id]);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// CSP das páginas servidas pela própria API
// ════════════════════════════════════════════════════════════════════════════════
describe('CSP com painel em outra origem', () => {
  test('connect-src passa a incluir a origem do painel', async () => {
    // Vale para o caso de a API continuar servindo as páginas (modo monolito com painel
    // adicional em outro host). O nginx do repo do painel tem a diretiva espelhada, e é o
    // estatico.test.mjs de lá que trava a correspondência com o config.js.
    comPainelSeparado();
    const res = await fetch(`${base}/login`);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'a página de login deveria ter CSP');
    assert.ok(
      /connect-src [^;]*/.exec(csp)[0].includes(PAINEL),
      `connect-src deveria incluir ${PAINEL}; veio: ${/connect-src [^;]*/.exec(csp)[0]}`,
    );
    assert.match(csp, /script-src 'self'/);
    assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"));
  });
});
