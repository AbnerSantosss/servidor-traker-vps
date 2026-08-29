// Testes da FASE F8 (backend): perfil do usuário e notificações por e-mail.
//
// Segue o estilo de test/falhas.test.js: servidor real (createApp) contra o Postgres de
// teste, sessão por cookie, e chamada direta ao motor (src/notificacoes/motor.js) — o
// motor roda no worker, não na API, então não há endpoint HTTP que dispare um tick; o
// jeito certo de testá-lo é importar `tick()` e chamar como o worker chamaria.
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { createUser } from '../src/db/repos/users.js';
import { createProject } from '../src/db/repos/projects.js';
import { recordEvent } from '../src/db/repos/events.js';
import { tick, _internos } from '../src/notificacoes/motor.js';

// Uma imagem 1×1 PNG real (a menor possível) — suficiente para exercitar o caminho feliz
// da validação sem inventar bytes de imagem à mão.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

let servidor;
let base;
let cookieAdmin = '';
let adminId;

const api = (caminho, opcoes = {}) =>
  fetch(`${base}${caminho}`, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(cookieAdmin && { Cookie: cookieAdmin }), ...opcoes.headers },
  });

async function login(email, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('traker_sess=')).split(';')[0];
  return { cookie, user: (await res.json()).user };
}

// Mesmo formato de "Evento Interno" usado em test/falhas.test.js e test/metricas.test.js.
function evento({ eventId, eventName = 'purchase', valor = 10 }) {
  return {
    event_id: eventId,
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    source: 'web',
    event_source_url: '',
    action_source: 'website',
    user_data: {},
    custom_data: valor !== undefined ? { value: valor, currency: 'BRL' } : {},
    consent_state: {},
    page: {},
  };
}

/** Cria um evento + entrega e já marca a entrega como 'dead' — o gatilho de entrega_morta. */
async function criarEntregaMorta(projeto, { eventId, destino }) {
  const { id: eventRowId } = await recordEvent({
    project: projeto,
    event: evento({ eventId }),
    destinationTypes: [destino],
  });
  await query(
    `UPDATE deliveries SET status = 'dead', updated_at = now() WHERE event_row_id = $1 AND destination_type = $2`,
    [eventRowId, destino]
  );
  return eventRowId;
}

async function notificacoesDoTipo(tipo, destinatarioId) {
  const { rows } = await query(
    'SELECT * FROM notificacoes_enviadas WHERE tipo = $1 AND destinatario_id = $2 ORDER BY id',
    [tipo, destinatarioId]
  );
  return rows;
}

before(async () => {
  await runMigrations();
  await query(`TRUNCATE notificacoes_enviadas, assinaturas_notificacao, destinatarios_notificacao,
                        events, deliveries, identities, destinations, project_domains, projects,
                        sessions, user_tokens, users CASCADE`);

  const admin = await createUser({ email: 'admin@empresa.com', password: 'senha-de-teste-123', name: 'Admin Teste' });
  adminId = admin.id;
  await createUser({ email: 'operador@empresa.com', password: 'senha-de-teste-123', name: 'Operador Teste', role: 'operador' });

  servidor = createApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;

  ({ cookie: cookieAdmin } = await login('admin@empresa.com', 'senha-de-teste-123'));
});

after(async () => {
  servidor.close();
  await closePool();
});

// ================================================================== perfil (GET/PUT /me)

describe('perfil do usuário', () => {
  test('salva nome/sobrenome e deriva `name` — código antigo que lê `name` continua funcionando', async () => {
    const res = await api('/api/usuarios/me', {
      method: 'PUT',
      body: JSON.stringify({ firstName: 'Ana', lastName: 'Beatriz' }),
    });
    assert.equal(res.status, 200);
    const { user } = await res.json();
    assert.equal(user.firstName, 'Ana');
    assert.equal(user.lastName, 'Beatriz');
    assert.equal(user.name, 'Ana Beatriz');

    // A listagem de usuários (rota antiga, usada pelo admin) lê a coluna `name` — precisa
    // continuar mostrando o nome completo mesmo sem saber que first_name/last_name existem.
    const lista = await (await api('/api/usuarios')).json();
    const eu = lista.find((u) => u.id === adminId);
    assert.equal(eu.name, 'Ana Beatriz');
  });

  test('avatar válido (PNG pequeno) é salvo e devolvido', async () => {
    const res = await api('/api/usuarios/me', {
      method: 'PUT',
      body: JSON.stringify({ avatar: `data:image/png;base64,${PNG_1X1}` }),
    });
    assert.equal(res.status, 200);
    const { user } = await res.json();
    assert.equal(user.avatar, `data:image/png;base64,${PNG_1X1}`);
  });

  test('avatar acima de 128 KB é rejeitado', async () => {
    // ~150 KB decodificados — acima do teto de 128 KB.
    const enorme = `data:image/png;base64,${'A'.repeat(200_000)}`;
    const res = await api('/api/usuarios/me', { method: 'PUT', body: JSON.stringify({ avatar: enorme }) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /128/);
  });

  test('avatar com MIME inválido é rejeitado', async () => {
    const res = await api('/api/usuarios/me', {
      method: 'PUT',
      body: JSON.stringify({ avatar: `data:image/gif;base64,${PNG_1X1}` }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /PNG|JPEG|WEBP/);
  });

  test('trocar senha dispara o fluxo de redefinição existente (sem SMTP, devolve o link)', async () => {
    const res = await api('/api/usuarios/me/trocar-senha', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enviado, false); // SMTP desligado no ambiente de teste
    assert.match(body.urlRedefinicao, /\/definir-senha\?token=/);

    const { rows } = await query(
      `SELECT purpose FROM user_tokens WHERE user_id = $1 AND purpose = 'redefinicao'`,
      [adminId]
    );
    assert.equal(rows.length, 1);
  });
});

// ================================================================== catálogo e CRUD

describe('catálogo e destinatários', () => {
  test('catálogo de notificações é exposto e fechado (6 tipos)', async () => {
    const res = await api('/api/notificacoes/catalogo');
    assert.equal(res.status, 200);
    const catalogo = await res.json();
    const tipos = catalogo.map((t) => t.tipo).sort();
    assert.deepEqual(tipos, [
      'dominio_problema', 'entrega_morta', 'falha_recorrente',
      'fila_acumulada', 'resumo_diario', 'resumo_semanal',
    ].sort());
  });

  test('destinatário externo (sem user_id) — cria, lista, edita e remove ponta a ponta', async () => {
    const criar = await api('/api/notificacoes/destinatarios', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Dono do Negócio',
        email: 'dono@fora-do-painel.com',
        assinaturas: [{ tipo: 'resumo_diario', projectId: null }],
      }),
    });
    assert.equal(criar.status, 201);
    const { destinatario } = await criar.json();
    assert.equal(destinatario.interno, false);
    assert.equal(destinatario.userId, null);
    assert.ok(
      !('token_descadastro' in destinatario) && !('tokenDescadastro' in destinatario),
      'o token de descadastro nunca pode sair na resposta do painel'
    );
    assert.equal(destinatario.assinaturas.length, 1);

    const lista = await (await api('/api/notificacoes/destinatarios')).json();
    assert.ok(lista.some((d) => d.email === 'dono@fora-do-painel.com'));

    const editar = await api(`/api/notificacoes/destinatarios/${destinatario.id}`, {
      method: 'PUT',
      body: JSON.stringify({ nome: 'Dono Renomeado', assinaturas: [] }),
    });
    assert.equal(editar.status, 200);
    assert.equal((await editar.json()).destinatario.nome, 'Dono Renomeado');

    const remover = await api(`/api/notificacoes/destinatarios/${destinatario.id}`, { method: 'DELETE' });
    assert.equal(remover.status, 200);
    assert.equal((await (await api('/api/notificacoes/destinatarios')).json()).some((d) => d.id === destinatario.id), false);
  });

  test('requireAdmin barra o operador em todos os endpoints de escrita', async () => {
    const { cookie: cookieOperador } = await login('operador@empresa.com', 'senha-de-teste-123');
    const chamar = (caminho, opcoes = {}) =>
      fetch(`${base}${caminho}`, { ...opcoes, headers: { 'Content-Type': 'application/json', Cookie: cookieOperador, ...opcoes.headers } });

    const criado = await api('/api/notificacoes/destinatarios', {
      method: 'POST',
      body: JSON.stringify({ nome: 'Alvo', email: 'alvo-requireadmin@fora.com', assinaturas: [] }),
    });
    const { destinatario } = await criado.json();

    const tentativas = [
      chamar('/api/notificacoes/destinatarios', { method: 'GET' }),
      chamar('/api/notificacoes/destinatarios', { method: 'POST', body: JSON.stringify({ nome: 'X', email: 'x@x.com' }) }),
      chamar(`/api/notificacoes/destinatarios/${destinatario.id}`, { method: 'PUT', body: JSON.stringify({ nome: 'Y' }) }),
      chamar(`/api/notificacoes/destinatarios/${destinatario.id}/teste`, { method: 'POST' }),
      chamar(`/api/notificacoes/destinatarios/${destinatario.id}`, { method: 'DELETE' }),
    ];
    for (const resposta of await Promise.all(tentativas)) {
      assert.equal((await resposta).status, 403);
    }

    // Catálogo, por outro lado, é leitura liberada para qualquer papel autenticado.
    assert.equal((await chamar('/api/notificacoes/catalogo')).status, 200);
  });
});

// ================================================================== motor: gatilhos

describe('motor de notificações — gatilho entrega_morta', () => {
  test('assinatura com project_id NULL recebe um alerta por PROJETO afetado (não um só global)', async () => {
    const p1 = await createProject({ name: 'Projeto Um', domain: 'projeto-um.exemplo.com' });
    const p2 = await createProject({ name: 'Projeto Dois', domain: 'projeto-dois.exemplo.com' });

    const { destinatario } = await (await api('/api/notificacoes/destinatarios', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Assina Tudo', email: 'assina-tudo@fora.com',
        assinaturas: [{ tipo: 'entrega_morta', projectId: null }],
      }),
    })).json();

    await criarEntregaMorta(p1, { eventId: 'evt-p1', destino: 'meta' });
    await criarEntregaMorta(p2, { eventId: 'evt-p2', destino: 'meta' });

    await tick();

    const enviadas = await notificacoesDoTipo('entrega_morta', destinatario.id);
    assert.equal(enviadas.length, 2, 'um registro por projeto afetado, não um só combinando os dois');
    const chaves = enviadas.map((e) => e.chave_incidente);
    assert.ok(chaves.some((c) => c.startsWith(`${p1.id}:`)));
    assert.ok(chaves.some((c) => c.startsWith(`${p2.id}:`)));
  });

  test('digest respeita a janela de 30 min: agrega múltiplos destinos e não redispara ao repetir o tick (idempotência)', async () => {
    const projeto = await createProject({ name: 'Projeto Digest', domain: 'projeto-digest.exemplo.com' });
    const { destinatario } = await (await api('/api/notificacoes/destinatarios', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Recebe Digest', email: 'digest@fora.com',
        assinaturas: [{ tipo: 'entrega_morta', projectId: projeto.id }],
      }),
    })).json();

    // Dois destinos diferentes morrendo no MESMO projeto, na mesma janela de 30 min.
    await criarEntregaMorta(projeto, { eventId: 'evt-meta', destino: 'meta' });
    await criarEntregaMorta(projeto, { eventId: 'evt-google', destino: 'google' });

    await tick(); // primeira passada: deveria mandar UM digest com os dois destinos
    await tick(); // segunda passada, mesmo incidente/janela: não pode redisparar

    const enviadas = await notificacoesDoTipo('entrega_morta', destinatario.id);
    assert.equal(enviadas.length, 1, 'no máximo um e-mail por projeto a cada 30 min, mesmo com dois destinos e dois ticks');
  });
});

describe('motor de notificações — descadastro e resiliência', () => {
  test('descadastro por token desativa o destinatário e o motor deixa de enviar para ele', async () => {
    const projeto = await createProject({ name: 'Projeto Descadastro', domain: 'projeto-descadastro.exemplo.com' });
    const { destinatario } = await (await api('/api/notificacoes/destinatarios', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Vai Sair', email: 'vai-sair@fora.com',
        assinaturas: [{ tipo: 'entrega_morta', projectId: projeto.id }],
      }),
    })).json();

    const { rows } = await query('SELECT token_descadastro FROM destinatarios_notificacao WHERE id = $1', [destinatario.id]);
    const token = rows[0].token_descadastro;

    const paginaInvalida = await fetch(`${base}/descadastro?token=token-que-nao-existe`);
    assert.equal(paginaInvalida.status, 400);

    const pagina = await fetch(`${base}/descadastro?token=${token}`);
    assert.equal(pagina.status, 200);
    assert.match(await pagina.text(), /canceladas/i);

    const { rows: depois } = await query('SELECT ativo FROM destinatarios_notificacao WHERE id = $1', [destinatario.id]);
    assert.equal(depois[0].ativo, false);

    // Novo incidente, depois do descadastro: o motor não pode mais notificar este destinatário.
    await criarEntregaMorta(projeto, { eventId: 'evt-pos-descadastro', destino: 'postback' });
    await tick();

    assert.equal((await notificacoesDoTipo('entrega_morta', destinatario.id)).length, 0);
  });

  test('falha inesperada no envio não derruba o motor nem impede o restante do tick', async () => {
    const projeto = await createProject({ name: 'Projeto Resiliência', domain: 'projeto-resiliencia.exemplo.com' });
    const { destinatario } = await (await api('/api/notificacoes/destinatarios', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Sofre a Falha', email: 'falha@fora.com',
        assinaturas: [{ tipo: 'entrega_morta', projectId: projeto.id }],
      }),
    })).json();
    await criarEntregaMorta(projeto, { eventId: 'evt-falha-mailer', destino: 'meta' });

    const emailConfiguradoOriginal = _internos.emailConfigurado;
    const enviarEmailOriginal = _internos.enviarEmail;
    _internos.emailConfigurado = () => true;
    _internos.enviarEmail = async () => { throw new Error('SMTP explodiu'); };

    try {
      await assert.doesNotReject(tick(), 'uma falha de envio não pode propagar e derrubar o worker');
      // Como o envio lançou ANTES de registrar, o incidente continua em aberto — nada
      // foi marcado como enviado (não há falso positivo de idempotência).
      assert.equal((await notificacoesDoTipo('entrega_morta', destinatario.id)).length, 0);
    } finally {
      _internos.emailConfigurado = emailConfiguradoOriginal;
      _internos.enviarEmail = enviarEmailOriginal;
    }

    // Com o mailer normal de volta (SMTP desligado no teste = "não envia e loga"), o
    // mesmo incidente, ainda aberto, é processado normalmente no próximo tick.
    await tick();
    assert.equal((await notificacoesDoTipo('entrega_morta', destinatario.id)).length, 1);
  });
});
