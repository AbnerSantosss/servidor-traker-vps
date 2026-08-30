// Redes de proxy/CDN compartilhado — onde "mesmo IP" NÃO significa "mesmo servidor".
//
// Por que este arquivo existe: a verificação de DNS do onboarding comparava os IPs do
// domínio do cliente com os do PUBLIC_HOST e, batendo, dizia "aponta para este servidor".
// Atrás de um proxy anycast (Cloudflare e afins) esse raciocínio é inválido: MILHÕES de
// domínios sem nenhuma relação entre si resolvem para o MESMO punhado de IPs. Dois
// domínios ambos na Cloudflare casam por engano, e o painel anuncia "já aponta para cá"
// para um domínio cujo tráfego nunca chegará aqui.
//
// A saída não é adivinhar melhor: é reconhecer que a pergunta "os IPs são iguais?" não
// tem resposta útil nesse cenário e devolver um estado honesto (ver dns-check.js).
//
// Faixas retiradas das listas públicas dos provedores. Ficam embutidas de propósito —
// buscar a lista pela rede a cada verificação transformaria o onboarding num refém da
// disponibilidade de terceiro, e a consequência de uma faixa desatualizada aqui é
// benigna: cai no caminho antigo (comparação por IP), nunca num falso "aponta para cá"
// a mais do que já existia.

/** Faixas por provedor. Fonte: https://www.cloudflare.com/ips/ */
export const REDES_COMPARTILHADAS = [
  {
    nome: 'Cloudflare',
    // O tráfego só chega ao nosso servidor se a zona estiver configurada na conta
    // Cloudflare do cliente apontando para cá — coisa que nenhuma consulta de DNS revela.
    cidrs: [
      '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
      '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
      '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
      '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
      '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
      '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
    ],
  },
];

// ------------------------------------------------------------------ parsing de IP

/** IPv4 pontuado -> BigInt de 32 bits. `null` se não for IPv4 válido. */
function ipv4ParaBigInt(ip) {
  const partes = ip.split('.');
  if (partes.length !== 4) return null;
  let n = 0n;
  for (const parte of partes) {
    if (!/^\d{1,3}$/.test(parte)) return null;
    const octeto = Number(parte);
    if (octeto > 255) return null;
    n = (n << 8n) | BigInt(octeto);
  }
  return n;
}

/** IPv6 (inclusive `::` comprimido e `::ffff:1.2.3.4`) -> BigInt de 128 bits. */
function ipv6ParaBigInt(ip) {
  if (!ip.includes(':')) return null;

  let resto = ip;
  let sufixoV4 = null;
  // Forma mista `::ffff:187.1.2.3`: o final é IPv4 e vale por 32 bits.
  const ultimoBloco = resto.slice(resto.lastIndexOf(':') + 1);
  if (ultimoBloco.includes('.')) {
    sufixoV4 = ipv4ParaBigInt(ultimoBloco);
    if (sufixoV4 === null) return null;
    resto = resto.slice(0, resto.lastIndexOf(':') + 1) + '0:0';
  }

  const lados = resto.split('::');
  if (lados.length > 2) return null;

  const grupo = (s) => (s ? s.split(':').filter((g) => g !== '') : []);
  const esquerda = grupo(lados[0]);
  const direita = lados.length === 2 ? grupo(lados[1]) : [];
  const total = esquerda.length + direita.length;
  if (total > 8 || (lados.length === 1 && total !== 8)) return null;

  const grupos = [...esquerda, ...Array(8 - total).fill('0'), ...direita];
  let n = 0n;
  for (const g of grupos) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }

  // Com sufixo IPv4, os dois últimos grupos foram zerados acima; agora entram de verdade.
  if (sufixoV4 !== null) n |= sufixoV4;
  return n;
}

/** `{ n, bits }` do IP, ou `null` se não der para interpretar. */
function parseIp(valor) {
  const ip = String(valor || '').trim().toLowerCase();
  if (!ip) return null;
  // ::ffff:187.1.2.3 é o mesmo host que 187.1.2.3 — comparar como IPv4 evita ter que
  // repetir cada faixa v4 na forma mapeada.
  if (ip.startsWith('::ffff:') && ip.slice(7).includes('.')) {
    const n = ipv4ParaBigInt(ip.slice(7));
    return n === null ? null : { n, bits: 32 };
  }
  if (ip.includes(':')) {
    const n = ipv6ParaBigInt(ip);
    return n === null ? null : { n, bits: 128 };
  }
  const n = ipv4ParaBigInt(ip);
  return n === null ? null : { n, bits: 32 };
}

function parseCidr(cidr) {
  const [rede, prefixo] = String(cidr).split('/');
  const base = parseIp(rede);
  if (!base) return null;
  const prefix = Number(prefixo);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > base.bits) return null;
  return { ...base, prefix };
}

/** O IP está dentro do CIDR? */
export function ipEmCidr(ip, cidr) {
  const alvo = parseIp(ip);
  const rede = parseCidr(cidr);
  if (!alvo || !rede || alvo.bits !== rede.bits) return false;
  if (rede.prefix === 0) return true;
  const mascara = ((1n << BigInt(rede.prefix)) - 1n) << BigInt(rede.bits - rede.prefix);
  return (alvo.n & mascara) === (rede.n & mascara);
}

/**
 * Nome do provedor de proxy compartilhado a que o IP pertence, ou `null`.
 * @param {string} ip
 * @returns {string|null}
 */
export function proxyDoIp(ip) {
  for (const rede of REDES_COMPARTILHADAS) {
    if (rede.cidrs.some((cidr) => ipEmCidr(ip, cidr))) return rede.nome;
  }
  return null;
}

/**
 * Provedor de proxy compartilhado quando a lista de IPs cai TODA nele.
 *
 * Exige "todos" e não "algum" de propósito: um domínio com um IP na Cloudflare e outro
 * num servidor próprio ainda é comparável pelo IP próprio, e nesse caso a checagem
 * clássica continua valendo. Só quando não sobra nenhum IP fora do proxy é que a
 * comparação perde o sentido por completo.
 *
 * @param {string[]} ips
 * @returns {string|null}
 */
export function proxyDeIps(ips) {
  const lista = (ips || []).filter(Boolean);
  if (!lista.length) return null;
  const nomes = lista.map((ip) => proxyDoIp(ip));
  if (nomes.some((n) => n === null)) return null;
  // Lista inteira atrás de proxy: devolve o primeiro nome (na prática é sempre o mesmo).
  return nomes[0];
}
