// Processo da API: landing, painel, API administrativa, ingestão e scripts client-side.
// Não envia nada para Meta/Google — isso é do worker. A API só aceita, normaliza,
// persiste e responde, para que o site do cliente nunca espere por API de terceiro.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { env } from './config/env.js';
import { log } from './config/log.js';
import { waitForDatabase, closePool, query } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { ingestRouter } from './ingest/router.js';
import { collectRouter } from './ingest/collect.js';
import { scriptsRouter } from './ingest/scripts.js';
import { adminRouter } from './admin/router.js';
import { authRouter } from './admin/auth.js';
import { usuariosRouter } from './admin/usuarios.js';
import { marcaRouter } from './admin/projetos-marca.js';
import { notificacoesRouter, descadastroRouter } from './admin/notificacoes.js';
import { testarRouter } from './admin/testar.js';
import { streamRouter } from './admin/stream.js';
import { corsDoPainel, semCache, exigirOrigemDoPainel, cabecalhosDePagina } from './admin/seguranca.js';
import { queueHealth } from './db/repos/events.js';
import { createUser, countUsers } from './db/repos/users.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

export function createApp() {
  const app = express();

  // Atrás do Caddy: faz o Express derivar protocolo e IP dos cabeçalhos do proxy.
  if (env.TRUST_PROXY) app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use((req, _res, next) => {
    log('debug', `${req.method} ${req.url}`);
    next();
  });

  // --- Rotas de ingestão. Vêm primeiro: são o caminho quente e não devem passar por
  // nenhum middleware de painel. Cada router traz seu próprio parser de corpo, porque
  // aceitam text/plain (sendBeacon) além de JSON.
  app.use(ingestRouter);
  app.use(collectRouter);
  app.use(scriptsRouter);

  // Descadastro de notificação (LGPD): link de e-mail, um clique, sem login. Fica FORA
  // de /api de propósito — não pode passar por corsDoPainel/exigirOrigemDoPainel (que
  // exigem cabeçalho que só o painel manda) nem depender de cookie de sessão.
  app.use(descadastroRouter);

  // --- Painel e API
  //
  // Separação front/back: daqui para baixo a API não devolve NADA renderizado — só JSON,
  // sempre sem cache, e com CORS fechado numa lista de origens quando o painel roda em
  // outro host. O painel é um cliente estático que consome esses mesmos endpoints.
  app.use('/api', corsDoPainel, semCache, exigirOrigemDoPainel);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/usuarios', usuariosRouter);
  app.use('/api/notificacoes', notificacoesRouter);
  app.use('/api/projects', testarRouter);
  // Mesmo prefixo de testarRouter (rotas relativas, ex.: GET /:id/stream) — é o mesmo
  // recurso-base (/api/projects/:id/*), só que para tempo real em vez de teste de envio.
  app.use('/api/projects', streamRouter);
  app.use('/api', marcaRouter);
  app.use('/api', adminRouter);

  // --- Saúde
  app.get('/health', async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ ok: true, uptime: Math.round(process.uptime()), db: true });
    } catch (err) {
      res.status(503).json({ ok: false, db: false, error: err.message });
    }
  });

  app.get('/health/fila', async (_req, res) => {
    try {
      res.json(await queueHealth());
    } catch (err) {
      res.status(503).json({ error: err.message });
    }
  });

  // --- Estáticos e páginas
  //
  // O painel é servido daqui por conveniência de operação (um deploy só), mas continua
  // sendo um cliente independente: nenhum dado é injetado no HTML, tudo vem da API.
  // Para hospedá-lo em outro lugar, basta publicar a pasta public/ e apontar
  // PANEL_ORIGINS para a origem dele — nada no código muda.
  app.use(cabecalhosDePagina);

  // `no-cache` NÃO significa "não guarde": significa "guarde, mas revalide antes de
  // usar". Com o ETag, a revalidação custa um 304 vazio.
  //
  // Por que não cachear de verdade: os arquivos do painel não têm hash no nome
  // (app.css é sempre app.css). Com max-age longo, um deploy deixaria o navegador
  // rodando o JS antigo por até uma hora — e JS antigo conversando com a API nova
  // quebra em silêncio: o botão simplesmente não faz nada, sem erro na tela. Para um
  // painel interno, o custo de uma revalidação por arquivo é irrelevante perto disso.
  // O painel pode ser servido por este mesmo processo (deploy monolito, o padrão em
  // desenvolvimento) OU por um container próprio atrás do proxy (deploy em dois
  // repositórios: codigovencedor-tracking-api + codigovencedor-tracking-app).
  // A detecção é pela presença dos arquivos: no repositório da API não existe
  // `public/admin.html`, então as rotas de página respondem 404 e quem serve o
  // painel é o nginx do outro container — o Caddy decide para onde cada caminho vai.
  const TEM_PAINEL = existsSync(join(PUBLIC_DIR, 'admin.html'));
  if (TEM_PAINEL) {
    app.use(express.static(PUBLIC_DIR, {
      etag: true,
      lastModified: true,
      setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
    }));
    app.get('/painel', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'admin.html')));
    app.get('/login', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'login.html')));
    // Aceite de convite e redefinição de senha (o token vai na query string).
    app.get('/definir-senha', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'definir-senha.html')));
  }

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'rota não encontrada' });
    if (TEM_PAINEL) return res.status(404).sendFile(join(PUBLIC_DIR, 'index.html'));
    res.status(404).type('text/plain').send('não encontrado');
  });

  // Tratador de erro final: nunca vaza stack trace para o cliente.
  app.use((err, _req, res, _next) => {
    log('error', 'erro não tratado', { error: err.message, stack: err.stack });
    res.status(err.statusCode || 500).json({ error: 'erro interno' });
  });

  return app;
}

/**
 * Cria o usuário inicial a partir de ADMIN_EMAIL/ADMIN_PASSWORD, se o banco estiver
 * vazio. Torna o primeiro deploy autossuficiente, sem passo manual esquecível.
 */
async function bootstrapAdmin() {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;
  if ((await countUsers()) > 0) return;
  try {
    const user = await createUser({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
      name: 'Administrador',
    });
    log('info', 'usuário administrador inicial criado', { email: user.email });
  } catch (err) {
    log('error', 'falha ao criar usuário inicial', { error: err.message });
  }
}

async function main() {
  await waitForDatabase();
  await runMigrations();
  await bootstrapAdmin();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    log('info', 'API do Servidor Traker no ar', {
      porta: env.PORT,
      publico: `${env.PUBLIC_SCHEME}://${env.PUBLIC_HOST}`,
      ambiente: env.NODE_ENV,
    });
  });

  // Encerramento gracioso: para de aceitar conexões novas, termina as em andamento.
  for (const sinal of ['SIGTERM', 'SIGINT']) {
    process.on(sinal, () => {
      log('info', `${sinal} recebido, encerrando a API`);
      server.close(async () => {
        await closePool();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  }
}

// Só sobe o servidor quando executado diretamente (os testes importam createApp).
if (process.argv[1]?.endsWith('server.js')) {
  main().catch(async (err) => {
    log('error', 'falha fatal ao iniciar a API', { error: err.message, stack: err.stack });
    await closePool();
    process.exit(1);
  });
}
