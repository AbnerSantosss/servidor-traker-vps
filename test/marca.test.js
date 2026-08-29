// Marca da empresa por projeto (F-V5): validação pura + endpoint real contra Postgres.
//
// O que este arquivo protege, em uma frase: a logo entra no banco como data-URI, e um
// campo assim é uma porta aberta se ninguém guardar o tamanho, o formato e o papel de
// quem escreve. Os três testes que mais importam aqui são os de recusa — imagem grande
// demais, MIME que não é imagem (SVG à frente) e escrita sem sessão.
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { createUser } from '../src/db/repos/users.js';
import { createProject, validarLogoMarca, validarCorMarca, getBrand } from '../src/db/repos/projects.js';
import { logoDataUri } from '../src/scripts/seed-marca.js';

// ============================================================== parte pura

describe('validação da marca', () => {
  const pngMinimo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

  test('aceita PNG, JPEG e WEBP em data-URI', () => {
    assert.equal(validarLogoMarca(pngMinimo), pngMinimo);
    assert.ok(validarLogoMarca('data:image/jpeg;base64,/9j/4AAQ'));
    assert.ok(validarLogoMarca('data:image/webp;base64,UklGRg=='));
  });

  test('vazio e null são valores válidos — é como o painel remove a logo', () => {
    assert.equal(validarLogoMarca(null), null);
    assert.equal(validarLogoMarca(''), null);
    assert.equal(validarLogoMarca(undefined), null);
  });

  test('recusa SVG mesmo em data-URI bem formada', () => {
    // SVG carrega <script>. A logo hoje só é renderizada em <img src="data:...">, onde o
    // navegador não executa esse script — mas a garantia depende de todo consumidor
    // futuro continuar usando <img>. A recusa na entrada não depende de ninguém lembrar.
    assert.throws(
      () => validarLogoMarca('data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4='),
      /PNG, JPEG ou WEBP/,
    );
  });

  test('recusa o que não é data-URI de imagem', () => {
    assert.throws(() => validarLogoMarca('https://exemplo.com/logo.png'), /data-URI/);
    assert.throws(() => validarLogoMarca('data:text/html;base64,PGgxPm9pPC9oMT4='), /data-URI/);
  });

  test('recusa imagem acima de 200 KB (medindo o binário, não o texto base64)', () => {
    const grande = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((201 * 1024 * 4) / 3));
    assert.throws(() => validarLogoMarca(grande), /200 KB/);
  });

  test('aceita exatamente no limite de 200 KB', () => {
    // 200 KB de binário = 273.067 caracteres base64 (4 por 3 bytes). Testar a borda é o
    // que garante que o limite é "≤ 200 KB" e não "< 200 KB por acidente de arredondamento".
    const noLimite = 'data:image/png;base64,' + 'A'.repeat((200 * 1024 * 4) / 3);
    assert.ok(validarLogoMarca(noLimite));
  });

  test('cor precisa ser hex #RRGGBB e volta normalizada em maiúsculas', () => {
    assert.equal(validarCorMarca('#4f46e5'), '#4F46E5');
    assert.equal(validarCorMarca(''), null);
    assert.equal(validarCorMarca(null), null);
    assert.throws(() => validarCorMarca('#FFF'), /#RRGGBB/);
    assert.throws(() => validarCorMarca('indigo'), /#RRGGBB/);
    assert.throws(() => validarCorMarca('#4F46E5; background:url(x)'), /#RRGGBB/);
  });
});

// ============================================================== seed da logo

describe('redimensionamento da logo no seed', () => {
  test('reduz um PNG grande a 128×128 dentro do limite da API', () => {
    // Gera um PNG de teste com o próprio codificador? Não: o valor deste teste é rodar o
    // caminho completo (inflar, desfiltrar, reamostrar, recodificar) sobre um arquivo de
    // verdade — e o arquivo de verdade deste projeto é o logotipo do painel.
    const arquivo = fileURLToPath(new URL('../public/assets/logo-full.png', import.meta.url));
    if (!existsSync(arquivo)) return; // asset da marca ainda não versionado neste ambiente
    const resultado = logoDataUri(arquivo);
    assert.match(resultado.dataUri, /^data:image\/png;base64,/);
    assert.ok(resultado.bytes < 200 * 1024, `logo reduzida deveria caber no limite (${resultado.bytes} bytes)`);
    assert.equal(validarLogoMarca(resultado.dataUri), resultado.dataUri);
  });
});

// ============================================================== endpoint

let servidor;
let base;
let cookieAdmin = '';
let cookieOperador = '';
let projeto;

const req = (caminho, { cookie, ...opcoes } = {}) =>
  fetch(`${base}${caminho}`, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...opcoes.headers },
  });

async function logar(email, senha) {
  const res = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: senha }) });
  assert.equal(res.status, 200, `login de ${email} deveria funcionar`);
  return res.headers.getSetCookie().find((c) => c.startsWith('traker_sess=')).split(';')[0];
}

// PNG 1×1 transparente de verdade — pequeno, válido e reconhecível na asserção.
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('endpoint da marca', () => {
  before(async () => {
    await runMigrations();
    await query('TRUNCATE events, deliveries, identities, destinations, project_domains, projects, sessions, user_tokens, users CASCADE');
    await createUser({ email: 'admin@marca.teste', password: 'senha-de-teste-123', name: 'Admin', role: 'admin' });
    await createUser({ email: 'op@marca.teste', password: 'senha-de-teste-123', name: 'Operador', role: 'operador' });
    projeto = await createProject({ name: 'Codigo Vencedor', domain: 'marca.teste' });

    servidor = createApp().listen(0);
    await new Promise((r) => servidor.once('listening', r));
    base = `http://127.0.0.1:${servidor.address().port}`;

    cookieAdmin = await logar('admin@marca.teste', 'senha-de-teste-123');
    cookieOperador = await logar('op@marca.teste', 'senha-de-teste-123');
  });

  after(async () => {
    await new Promise((r) => servidor.close(r));
    await closePool();
  });

  test('sem sessão não lê nem escreve marca', async () => {
    assert.equal((await req('/api/marcas')).status, 401);
    assert.equal((await req(`/api/projects/${projeto.id}/marca`)).status, 401);
    const res = await req(`/api/projects/${projeto.id}/marca`, { method: 'PUT', body: JSON.stringify({ cor: '#4F46E5' }) });
    assert.equal(res.status, 401);
  });

  test('operador lê a marca mas não a altera', async () => {
    assert.equal((await req('/api/marcas', { cookie: cookieOperador })).status, 200);
    const res = await req(`/api/projects/${projeto.id}/marca`, {
      method: 'PUT', cookie: cookieOperador, body: JSON.stringify({ cor: '#4F46E5' }),
    });
    assert.equal(res.status, 403);
  });

  test('admin grava logo e cor, e a leitura devolve as duas', async () => {
    const res = await req(`/api/projects/${projeto.id}/marca`, {
      method: 'PUT', cookie: cookieAdmin, body: JSON.stringify({ logo: PNG_1X1, cor: '#4f46e5' }),
    });
    assert.equal(res.status, 200);
    const corpo = await res.json();
    assert.equal(corpo.logo, PNG_1X1);
    assert.equal(corpo.cor, '#4F46E5', 'a cor volta normalizada em maiúsculas');

    const lida = await (await req(`/api/projects/${projeto.id}/marca`, { cookie: cookieAdmin })).json();
    assert.equal(lida.logo, PNG_1X1);
    assert.equal(lida.cor, '#4F46E5');
  });

  test('campo ausente mantém o valor atual', async () => {
    const res = await req(`/api/projects/${projeto.id}/marca`, {
      method: 'PUT', cookie: cookieAdmin, body: JSON.stringify({ cor: '#15803D' }),
    });
    assert.equal(res.status, 200);
    const corpo = await res.json();
    assert.equal(corpo.cor, '#15803D');
    assert.equal(corpo.logo, PNG_1X1, 'salvar só a cor não podia apagar a logo');
  });

  test('logo nula remove a imagem e o projeto volta ao fallback de iniciais', async () => {
    const res = await req(`/api/projects/${projeto.id}/marca`, {
      method: 'PUT', cookie: cookieAdmin, body: JSON.stringify({ logo: null }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).logo, null);
    assert.equal((await getBrand(projeto.id)).logo, null);
  });

  test('imagem grande demais é recusada e nada é gravado', async () => {
    const grande = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((260 * 1024 * 4) / 3));
    const res = await req(`/api/projects/${projeto.id}/marca`, {
      method: 'PUT', cookie: cookieAdmin, body: JSON.stringify({ logo: grande }),
    });
    // 413, e não o 400 da validação da rota: `ingestRouter` é montado na RAIZ do app
    // (app.use(ingestRouter), sem caminho) e o `json({ limit: '256kb' })` dele vale para
    // toda requisição do processo — inclusive /api. Uma imagem de 200 KB vira ~267 KB em
    // base64, então o corpo morre no parser antes de chegar aqui. O teto de 200 KB da
    // rota continua sendo o contrato (ver a suíte de validação acima, que o exercita
    // direto); na prática o corte efetivo é ~192 KB de binário. Nada disso muda o que
    // importa neste teste: imagem grande não entra.
    assert.ok([400, 413].includes(res.status), `esperava recusa, veio ${res.status}`);
    assert.equal((await getBrand(projeto.id)).logo, null, 'nada podia ter sido gravado');
  });

  test('imagem dentro do limite, porém pesada, é aceita', async () => {
    // 150 KB de binário: acima de qualquer logo real de 128×128 e abaixo do teto — o
    // caminho feliz do arquivo grande, que é o que separa "limite" de "obstáculo".
    const pesada = 'data:image/png;base64,' + 'A'.repeat((150 * 1024 * 4) / 3);
    const res = await req(`/api/projects/${projeto.id}/marca`, {
      method: 'PUT', cookie: cookieAdmin, body: JSON.stringify({ logo: pesada }),
    });
    assert.equal(res.status, 200);
    await req(`/api/projects/${projeto.id}/marca`, {
      method: 'PUT', cookie: cookieAdmin, body: JSON.stringify({ logo: null }),
    });
  });

  test('MIME inválido é recusado com 400 (SVG inclusive)', async () => {
    for (const logo of [
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'data:text/html;base64,PGgxPm9pPC9oMT4=',
      'javascript:alert(1)',
    ]) {
      const res = await req(`/api/projects/${projeto.id}/marca`, {
        method: 'PUT', cookie: cookieAdmin, body: JSON.stringify({ logo }),
      });
      assert.equal(res.status, 400, `${logo.slice(0, 24)}… deveria ser recusado`);
    }
  });

  test('cor fora do formato #RRGGBB é recusada com 400', async () => {
    const res = await req(`/api/projects/${projeto.id}/marca`, {
      method: 'PUT', cookie: cookieAdmin, body: JSON.stringify({ cor: 'rgb(1,2,3)' }),
    });
    assert.equal(res.status, 400);
  });

  test('projeto inexistente responde 404', async () => {
    const res = await req('/api/projects/prj_naoexiste/marca', {
      method: 'PUT', cookie: cookieAdmin, body: JSON.stringify({ cor: '#4F46E5' }),
    });
    assert.equal(res.status, 404);
  });

  test('a listagem traz a marca de todos os projetos numa chamada só', async () => {
    const lista = await (await req('/api/marcas', { cookie: cookieAdmin })).json();
    assert.ok(Array.isArray(lista));
    const alvo = lista.find((m) => m.id === projeto.id);
    assert.ok(alvo, 'o projeto criado deveria aparecer na listagem');
    assert.equal(alvo.cor, '#15803D');
    assert.equal(alvo.name, 'Codigo Vencedor');
  });

  test('a rota nova não engoliu as rotas de projeto que já existiam', async () => {
    // /api/marcas e /api/projects/:id/marca são montados ANTES do adminRouter. Um path
    // mal escolhido aqui (ex.: /projects/marcas) faria /projects/:id casar primeiro e
    // devolver 404 para um projeto existente. Este teste é o alarme desse acidente.
    const res = await req(`/api/projects/${projeto.id}`, { cookie: cookieAdmin });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, projeto.id);
  });
});
