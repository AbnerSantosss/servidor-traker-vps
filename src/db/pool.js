// Pool de conexões PostgreSQL. Único ponto de acesso ao banco em toda a aplicação.
import pg from 'pg';
import { env } from '../config/env.js';
import { log } from '../config/log.js';

// NUMERIC volta como string por padrão no driver (para não perder precisão).
// Nos nossos usos (valor de conversão, contagens) o número é seguro em float64.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // BIGINT

// Quebra a DATABASE_URL em campos separados, em vez de entregar a string inteira ao
// driver.
//
// Existe por um defeito real e caro de diagnosticar: o parser de connection string do
// `pg` trata a URL como URL, e `#` inicia um fragmento. Uma senha gerada com `#` no meio
// (openssl rand -base64 gera `+`, `/` e `=`; geradores de cofre gerem `#` à vontade)
// chega TRUNCADA no ponto do `#`, e o resto da URL — banco, porta, parâmetros — vira
// fragmento e desaparece. O sintoma não fala de senha nenhuma: o Postgres recusa a
// autenticação, ou reclama de um banco que "não existe", com a URL parecendo certa no
// `.env` e no cofre. O mesmo vale para qualquer caractere com significado em URL que não
// tenha sido percent-encoded (`@`, `?`, `/` também derrubam, cada um do seu jeito).
//
// Encontrado em produção pelo time de infra (Rauny, 14/08/2026), com a senha vinda do
// Vault. Percent-encodar a senha no cofre resolveria o caso, mas depende de quem cadastra
// lembrar disso a cada rotação — e a falha volta calada. Parsear aqui resolve de uma vez,
// para qualquer senha.
//
// Exportada porque não é só o pool que conecta: o barramento de tempo real
// (src/db/notificacoes.js) mantém um cliente dedicado fora do pool para o LISTEN, e ele
// precisa exatamente do mesmo tratamento.
export function parsePgConnectionString(connectionString) {
  if (typeof connectionString !== 'string' || !connectionString.trim()) {
    throw new Error('DATABASE_URL inválida: vazia ou não é uma string.');
  }

  // Regex em vez do parser nativo de URL, justamente para NÃO dar significado especial a
  // `#`: a senha é tudo que vier entre `:` e o último `@` antes do host.
  const re = /^postgres(?:ql)?:\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:/?#]+)(?::(\d+))?(?:\/([^?#]*))?(?:\?(.*))?$/i;
  const m = connectionString.match(re);

  // A mensagem NÃO inclui a connection string: ela carrega a senha, e um erro de boot vai
  // para o log do container, que costuma ser agregado e ficar visível para muita gente.
  if (!m) throw new Error('DATABASE_URL em formato inválido (esperado postgres://usuario:senha@host:porta/banco).');

  const [, usuario, senha, host, porta, banco, queryString] = m;

  const config = {
    host,
    port: porta ? Number(porta) : 5432,
  };
  if (usuario) config.user = decodeURIComponent(usuario);
  if (senha) config.password = decodeURIComponent(senha);
  if (banco) config.database = decodeURIComponent(banco);

  // Parâmetros de query. O que importa aqui é `sslmode`, obrigatório em Postgres
  // gerenciado; os demais seguem adiante como estão, para não bloquear uma opção do
  // driver que este código não conhece.
  if (queryString) {
    for (const [chave, valor] of new URLSearchParams(queryString)) {
      if (chave === 'sslmode') {
        // Semântica do libpq, que é a que quem escreve a URL espera:
        //   disable                -> sem TLS
        //   require/prefer/allow   -> TLS sem validar a cadeia (o caso de banco gerenciado
        //                             com certificado próprio; `ssl: true` no pg validaria
        //                             e a conexão morreria com "self signed certificate")
        //   verify-ca/verify-full  -> TLS validando
        if (valor === 'disable') config.ssl = false;
        else if (valor === 'verify-ca' || valor === 'verify-full') config.ssl = { rejectUnauthorized: true };
        else config.ssl = { rejectUnauthorized: false };
      } else if (chave === 'ssl') {
        config.ssl = valor === 'true' || valor === '1' ? { rejectUnauthorized: false } : false;
      } else {
        config[chave] = valor;
      }
    }
  }

  return config;
}

export const pool = new pg.Pool({
  ...parsePgConnectionString(env.DATABASE_URL),
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  log('error', 'erro inesperado no pool do Postgres', { error: err.message });
});

export function query(text, params) {
  return pool.query(text, params);
}

// Executa um callback dentro de uma transação, com rollback automático em erro.
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Espera o banco aceitar conexões. Usado no boot: em docker compose o Postgres
// pode demorar alguns segundos a mais que o healthcheck para aceitar queries.
export async function waitForDatabase({ retries = 30, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch (err) {
      if (attempt === retries) throw err;
      log('warn', `banco indisponível, tentando de novo (${attempt}/${retries})`, { error: err.message });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

export async function closePool() {
  await pool.end().catch(() => {});
}
