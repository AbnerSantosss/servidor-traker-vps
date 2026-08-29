// A captura de amostras do Webhook Studio dentro da ingestão real.
//
// Este arquivo cobre a LIGAÇÃO entre a ingestão e o Webhook Studio — as peças (mascarar,
// hash de estrutura, tetos de captura) têm testes próprios em webhook-studio.test.js. O
// que se testa aqui é o comportamento observável no endpoint de verdade, porque é
// justamente onde uma captura mal condicionada faria estrago: enchendo a tabela com
// eventos normais, ou pior, derrubando a ingestão de uma conversão.
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/server.js';
import { runMigrations } from '../src/db/migrate.js';
import { query, closePool } from '../src/db/pool.js';
import { createProject, getProject } from '../src/db/repos/projects.js';
import { criarAdaptador } from '../src/db/repos/webhooks.js';

let servidor;
let base;
let projeto;
let tokenWebhook;

before(async () => {
  await runMigrations();
  await query('TRUNCATE events, deliveries, identities, destinations, project_domains, projects, webhook_amostras, adaptadores_projeto CASCADE');

  projeto = await createProject({ name: 'Amostras', domain: 'amostras.teste' });
  // O token de ingestão é o que distingue webhook (backend do cliente) de navegador.
  tokenWebhook = (await getProject(projeto.id)).ingestToken;

  servidor = createApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
  await new Promise((r) => servidor.close(r));
  await closePool();
});

const enviarWebhook = (corpo) =>
  fetch(`${base}/e/${projeto.slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenWebhook}` },
    body: JSON.stringify(corpo),
  });

const contarAmostras = async () => {
  const { rows } = await query('SELECT COUNT(*)::int AS total FROM webhook_amostras WHERE project_id = $1', [projeto.id]);
  return rows[0].total;
};

// A gravação da amostra é assíncrona e deliberadamente não é esperada pela resposta —
// o webhook não pode ficar mais lento por causa de um recurso do painel. Por isso o teste
// dá uma folga curta em vez de assumir que já aconteceu.
const esperarGravacao = () => new Promise((r) => setTimeout(r, 150));

describe('captura de amostras na ingestão', () => {
  test('webhook em formato desconhecido vira amostra', async () => {
    const res = await enviarWebhook({ id_pedido: 'X-1', comprador: { mail: 'a@b.com' }, total_centavos: 9990 });
    // Sem event_name, o payload é recusado — e é exatamente por isso que ele precisa
    // aparecer no painel: alguém está mandando algo que o servidor não entende.
    assert.equal(res.status, 400);

    await esperarGravacao();
    assert.equal(await contarAmostras(), 1);

    const { rows } = await query('SELECT * FROM webhook_amostras WHERE project_id = $1', [projeto.id]);
    assert.ok(rows[0].hash_estrutura, 'amostra precisa ter hash de estrutura para agrupar iguais');
    assert.ok(rows[0].body_mascarado, 'corpo precisa ser persistido mascarado');
  });

  test('e-mail dentro do payload desconhecido não fica em claro na amostra', async () => {
    const { rows } = await query('SELECT body_mascarado FROM webhook_amostras WHERE project_id = $1', [projeto.id]);
    assert.ok(!JSON.stringify(rows[0].body_mascarado).includes('a@b.com'), 'PII não pode ser persistida em claro (LGPD)');
  });

  test('webhook já canônico NÃO vira amostra', async () => {
    const antes = await contarAmostras();
    const res = await enviarWebhook({ event_name: 'lead', event_id: 'lead-1', user_data: { email: 'c@d.com' } });
    assert.equal(res.status, 202);

    await esperarGravacao();
    // `adaptarPayload` devolve formato null tanto para "não reconhecido" quanto para
    // "já é canônico". Sem essa distinção, todo webhook bem configurado viraria ruído.
    assert.equal(await contarAmostras(), antes);
  });

  test('evento do navegador NÃO vira amostra', async () => {
    const antes = await contarAmostras();
    const res = await fetch(`${base}/e/${projeto.slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // sem token = navegador
      body: JSON.stringify({ event_name: 'page_view', event_id: 'pv-1' }),
    });
    assert.equal(res.status, 202);

    await esperarGravacao();
    assert.equal(await contarAmostras(), antes, 'evento de navegador vem da nossa própria tag, no formato canônico');
  });

  test('payload de formato reconhecido pelos adaptadores em código NÃO vira amostra', async () => {
    const antes = await contarAmostras();
    const res = await enviarWebhook({
      event: 'purchase_approved',
      eventId: 'cv-9001',
      paymentStatus: 'paid',
      amountMinor: 19990,
      currency: 'BRL',
      lead: { email: 'comprador@exemplo.com', name: 'Fulano de Tal' },
      attribution: { cookies: { fbp: 'fb.1.1.1' }, utm: { source: 'facebook' } },
    });
    assert.equal(res.status, 202);

    await esperarGravacao();
    assert.equal(await contarAmostras(), antes, 'formato traduzido por adaptador não tem o que mapear');
  });

  test('adaptador em modo IA grava evento neutro com o corpo bruto e PII hasheada', async () => {
    await criarAdaptador(projeto.id, {
      nome: 'plataforma-exotica',
      deteccao: { obrigatorias: ['pedido_ref', 'cliente'] },
      // O mapeamento não é usado neste modo (quem estrutura é o worker), mas a coluna
      // exige um valor válido.
      mapeamento: { evento: { de: 'tipo', transformar: 'mapear_valores', args: { dicionario: { novo: 'lead' } } }, regras: [] },
      ativo: true,
      modo: 'ia_por_evento',
    });

    const res = await enviarWebhook({ pedido_ref: 'PED-77', cliente: { email: 'quem@exemplo.com' }, tipo: 'novo' });
    assert.equal(res.status, 202);

    const { rows } = await query(
      `SELECT event_name, payload FROM events WHERE project_id = $1 ORDER BY received_at DESC LIMIT 1`,
      [projeto.id]
    );
    // Até um modelo rodar, ninguém confirmou pagamento nenhum — um registro otimista já
    // contaminaria o relatório de receita mesmo que a IA depois discordasse.
    assert.equal(rows[0].event_name, 'aguardando_estruturacao_ia');
    assert.equal(rows[0].payload.ia_por_evento, true);
    assert.equal(rows[0].payload.ia_adaptador, 'plataforma-exotica');
    assert.equal(rows[0].payload.ia_bruto.pedido_ref, 'PED-77', 'o corpo bruto precisa sobreviver para o worker estruturar');

    const bruto = JSON.stringify(rows[0].payload.ia_bruto);
    assert.ok(!bruto.includes('quem@exemplo.com'), 'e-mail não pode ficar em claro no banco nem por pouco tempo');
    assert.match(rows[0].payload.ia_bruto.cliente.email, /^[a-f0-9]{64}$/, 'o hash precisa sobreviver — a Meta casa hash com hash');
  });

  test('ingestão continua respondendo mesmo se a captura falhar', async () => {
    // Deixa a tabela de amostras inacessível para o resto desta transação de teste: se a
    // ingestão dependesse dela, o webhook falharia. A promessa aqui é dura — a entrega de
    // conversão nunca pode ser derrubada por um recurso de conveniência do painel.
    await query('ALTER TABLE webhook_amostras RENAME TO webhook_amostras_escondida');
    try {
      const res = await enviarWebhook({ event_name: 'purchase', event_id: 'compra-resiliente', custom_data: { value: 10 } });
      assert.equal(res.status, 202, 'o webhook precisa ser aceito mesmo com a captura quebrada');

      const desconhecido = await enviarWebhook({ formato: 'estranho', qualquer: 1 });
      assert.equal(desconhecido.status, 400, 'a validação normal segue valendo');
    } finally {
      await query('ALTER TABLE webhook_amostras_escondida RENAME TO webhook_amostras');
    }
  });
});
