// Ambiente de teste.
//
// Precisa ser um módulo separado, importado ANTES dos demais: em ESM os `import` são
// içados e executados antes de qualquer instrução do corpo do arquivo, então definir
// process.env no topo do próprio teste seria tarde demais — config/env.js já teria lido.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.APP_SECRET = 'segredo-de-teste-com-32-bytes-ok';
process.env.PUBLIC_HOST = 'traker.teste.local';
process.env.PUBLIC_SCHEME = 'http';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://traker:traker@localhost:55432/traker_test';

// SMTP explicitamente vazio: sem isto, o .env local seria carregado por config/env.js e
// a suíte passaria a enviar e-mail de verdade pelo Gmail a cada execução — lento, sujeito
// a rate limit e capaz de disparar mensagem para endereço de teste inexistente.
// String vazia (e não delete) porque o carregador do .env só preenche o que está undefined.
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
process.env.SMTP_FROM = '';

// Nunca criar o admin de produção a partir do .env durante os testes.
process.env.ADMIN_EMAIL = '';
process.env.ADMIN_PASSWORD = '';

// O atalho de login sem senha fica DESLIGADO na suíte: os testes precisam garantir
// justamente que o padrão seguro é o padrão. Se o .env local o liga para
// desenvolvimento, isso não pode vazar para dentro do teste.

export const TEST_DB = process.env.DATABASE_URL;
