// Log estruturado em linha unica (JSON quando em producao, texto legivel em dev).
// Regra de privacidade: NUNCA logar PII em texto plano (email, telefone, nome).
// Use maskPII() para qualquer valor que possa conter dado pessoal.
import { env } from './env.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT = LEVELS[env.LOG_LEVEL] ?? LEVELS.info;

export function log(level, message, context) {
  if ((LEVELS[level] ?? 2) > CURRENT) return;
  const ts = new Date().toISOString();
  if (env.NODE_ENV === 'production') {
    process.stdout.write(JSON.stringify({ ts, level, message, ...(context || {}) }) + '\n');
  } else {
    const extra = context && Object.keys(context).length ? ' ' + JSON.stringify(context) : '';
    process.stdout.write(`${ts} [${level}] ${message}${extra}\n`);
  }
}

// Mascara um valor sensivel preservando so o suficiente para depuracao (ex.: "ab***@***.com" -> "ab***").
export function maskPII(value) {
  if (value == null || value === '') return undefined;
  const s = String(value);
  if (s.length <= 4) return '***';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}
