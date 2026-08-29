// Rate limit em memória, por processo. Camada de negócio (por projeto), complementar
// ao rate limit do proxy (por IP). Não pretende ser defesa contra DDoS — o objetivo é
// evitar que um loop de tag mal configurada no site do cliente inunde a fila.
//
// Janela deslizante simples por contadores de bucket. Estado em memória é aceitável:
// se o processo reinicia, o pior caso é uma janela de folga.

const buckets = new Map();
const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 6000);

export function rateLimit(key, limit = DEFAULT_LIMIT) {
  const now = Date.now();
  const windowStart = now - (now % WINDOW_MS);
  const entry = buckets.get(key);

  if (!entry || entry.windowStart !== windowStart) {
    buckets.set(key, { windowStart, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

// Limpeza periódica para o Map não crescer sem limite com projetos inativos.
const cleanup = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [key, entry] of buckets) {
    if (entry.windowStart < cutoff) buckets.delete(key);
  }
}, WINDOW_MS);
cleanup.unref();

export function resetRateLimit() {
  buckets.clear();
}
