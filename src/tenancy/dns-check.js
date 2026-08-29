// Verificação de DNS no onboarding de um domínio first-party.
//
// O cliente cria o registro no DNS dele; nós conferimos se já aponta para cá antes de
// liberar a emissão do certificado. Sem esta checagem, o Caddy tentaria emitir para um
// domínio que ainda não resolve e queimaria tentativa junto à Let's Encrypt.
import dns from 'node:dns/promises';
import { env } from '../config/env.js';
import { log } from '../config/log.js';

const hostOf = (value) => String(value || '').split(':')[0].trim().toLowerCase();

async function resolveIps(hostname) {
  const [v4, v6] = await Promise.all([
    dns.resolve4(hostname).catch(() => []),
    dns.resolve6(hostname).catch(() => []),
  ]);
  return [...v4, ...v6];
}

/**
 * IPs para os quais o host público do serviço resolve.
 * É o número que o painel mostra ao operador na instrução de registro A — sem isso
 * a instrução vira "aponte para o IP do servidor" sem dizer qual.
 */
export async function resolveOwnIps() {
  const alvo = hostOf(env.PUBLIC_HOST);
  if (!alvo || alvo === 'localhost') return [];
  return resolveIps(alvo).catch(() => []);
}

/**
 * Confere se `hostname` aponta para o mesmo destino que o host público do serviço.
 * Aceita as duas formas válidas:
 *   - CNAME apontando para o nosso host público
 *   - registro A/AAAA com o mesmo IP do nosso host público
 */
export async function resolveDns(hostname) {
  const alvo = hostOf(env.PUBLIC_HOST);
  const host = hostOf(hostname);

  if (!host) return { ok: false, error: 'hostname vazio' };
  if (!alvo || alvo === 'localhost') {
    return { ok: false, error: 'PUBLIC_HOST não configurado — não é possível verificar em ambiente local' };
  }

  try {
    const cnames = await dns.resolveCname(host).catch(() => []);
    const apontaPorCname = cnames.some((c) => hostOf(c) === alvo);

    const [ipsDoCliente, ipsDoServico] = await Promise.all([resolveIps(host), resolveIps(alvo)]);
    const ipsEmComum = ipsDoCliente.filter((ip) => ipsDoServico.includes(ip));

    const ok = apontaPorCname || ipsEmComum.length > 0;

    if (!ok && !ipsDoCliente.length) {
      return { ok: false, error: 'domínio ainda não resolve (DNS não propagado ou registro inexistente)', ips: [], cnames };
    }

    return {
      ok,
      metodo: apontaPorCname ? 'cname' : ipsEmComum.length ? 'a_record' : null,
      ips: ipsDoCliente,
      cnames,
      esperado: { host: alvo, ips: ipsDoServico },
      error: ok ? undefined : `aponta para ${ipsDoCliente.join(', ') || 'destino desconhecido'}, esperado ${ipsDoServico.join(', ') || alvo}`,
    };
  } catch (err) {
    log('warn', 'falha ao verificar DNS', { hostname: host, error: err.message });
    return { ok: false, error: err.message };
  }
}
