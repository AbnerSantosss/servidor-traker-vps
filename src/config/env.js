// Configuracao central via variaveis de ambiente.
// Regra de ouro do projeto: NADA de credencial de cliente aqui — o .env guarda apenas
// segredos de infraestrutura (conexao do banco e a master key que cifra as credenciais).
// Pixel ID, access token, measurement id etc. vivem no banco, cadastrados pelo painel.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Carrega .env sem dependencia externa (dotenv). Ignora linhas vazias e comentarios.
// Variaveis ja presentes no ambiente (Docker, systemd) tem precedencia sobre o arquivo.
function loadDotEnv() {
  const file = join(APP_ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const bool = (v, fallback = false) => (v === undefined ? fallback : ['1', 'true', 'sim', 'yes'].includes(String(v).toLowerCase()));

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 3000),

  // Banco
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://traker:traker@localhost:5432/traker',

  // Master key que cifra as credenciais em repouso (AES-256-GCM).
  // Perder esta chave = perder o acesso a todos os tokens salvos.
  APP_SECRET: process.env.APP_SECRET || '',

  // Chave anterior, usada só para DECIFRAR durante uma rotação de APP_SECRET.
  // Enquanto ela estiver definida, valores cifrados com a chave antiga continuam
  // legíveis; tudo que for gravado já sai com a chave nova. Ver docs/06 (rotação).
  APP_SECRET_PREVIOUS: process.env.APP_SECRET_PREVIOUS || '',

  // Dominio publico onde o servidor responde (usado para montar snippets e URLs no painel).
  PUBLIC_HOST: process.env.PUBLIC_HOST || `localhost:${process.env.PORT || 3000}`,
  PUBLIC_SCHEME: process.env.PUBLIC_SCHEME || (process.env.NODE_ENV === 'production' ? 'https' : 'http'),

  // Confiar no cabecalho X-Forwarded-For (obrigatorio quando ha proxy reverso na frente:
  // sem isso o client_ip_address vira o IP do proxy e o EMQ despenca).
  TRUST_PROXY: bool(process.env.TRUST_PROXY, true),

  // Consentimento ausente conta como negado? Ver src/ingest/consent.js.
  // false (padrão) = evento sem consent_state segue com PII.
  // true = postura conservadora, recomendada quando o site já tem CMP.
  STRICT_CONSENT: bool(process.env.STRICT_CONSENT, false),

  // DDI acrescentado a telefone nacional sem código de país, antes do hash.
  // Vazio desliga o comportamento (necessário para operação fora do Brasil).
  DEFAULT_COUNTRY_CODE: process.env.DEFAULT_COUNTRY_CODE ?? '55',

  META_API_VERSION: process.env.META_API_VERSION || 'v21.0',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // Worker
  WORKER_CONCURRENCY: Number(process.env.WORKER_CONCURRENCY || 5),
  WORKER_POLL_MS: Number(process.env.WORKER_POLL_MS || 1000),
  MAX_ATTEMPTS: Number(process.env.MAX_ATTEMPTS || 6),

  // Retencao do log de eventos (dias). Registros mais antigos sao expurgados pelo worker.
  RETENTION_DAYS: Number(process.env.RETENTION_DAYS || 90),

  // Sessao do painel
  SESSION_TTL_HOURS: Number(process.env.SESSION_TTL_HOURS || 12),

  // (LOGIN_RAPIDO foi removido em 2026-08-13 junto com a rota que entrava sem senha.
  //  Se a variavel aparecer em algum .env antigo, e simplesmente ignorada.)

  // Origens onde o PAINEL e servido, quando ele roda separado da API
  // (ex.: "https://painel.codigovencedor.com"). Vazio = painel servido pela propria
  // API, no mesmo host — o modo padrao. Ver docs/10-separacao-front-back.md.
  PANEL_ORIGINS: (process.env.PANEL_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean),

  // Validade dos links enviados por e-mail (horas).
  // Convite e longo porque a pessoa pode demorar a ver o e-mail; redefinicao de senha
  // e curta de proposito — quanto menor a janela, menor o estrago de um e-mail vazado.
  CONVITE_TTL_HORAS: Number(process.env.CONVITE_TTL_HORAS || 72),
  RESET_TTL_HORAS: Number(process.env.RESET_TTL_HORAS || 2),

  // SMTP. Hoje: Gmail com "senha de app" (exige verificacao em duas etapas na conta).
  SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
  SMTP_PORT: Number(process.env.SMTP_PORT || 465),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || '',

  // Cookies first-party renovados pelo servidor (mitigacao de ITP). 90 dias = validade do _fbp/_fbc da Meta.
  COOKIE_MAX_AGE_DAYS: Number(process.env.COOKIE_MAX_AGE_DAYS || 90),
  SET_FIRST_PARTY_COOKIES: bool(process.env.SET_FIRST_PARTY_COOKIES, true),
};

// APP_SECRET e obrigatorio fora de desenvolvimento: sem ele as credenciais ficariam
// cifradas com uma chave previsivel, o que e o mesmo que nao cifrar.
if (!env.APP_SECRET) {
  if (env.NODE_ENV === 'production') {
    console.error('[FATAL] APP_SECRET nao definido. Gere com: openssl rand -hex 32');
    process.exit(1);
  }
  env.APP_SECRET = 'dev-only-insecure-secret-nao-usar-em-producao';
}

export function publicBaseUrl() {
  return `${env.PUBLIC_SCHEME}://${env.PUBLIC_HOST}`;
}
