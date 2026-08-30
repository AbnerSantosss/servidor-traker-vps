// Verificação de DNS no onboarding de um domínio first-party.
//
// O cliente cria o registro no DNS dele; nós conferimos se já aponta para cá antes de
// liberar a emissão do certificado. Sem esta checagem, o Caddy tentaria emitir para um
// domínio que ainda não resolve e queimaria tentativa junto à Let's Encrypt.
//
// O que a checagem PODE e o que NÃO PODE provar:
//
//   CNAME para o nosso PUBLIC_HOST  -> prova positiva. O nome do destino é nosso e de
//                                      mais ninguém.
//   A/AAAA com IP igual ao nosso    -> prova só quando o IP identifica UM servidor.
//                                      Atrás de um proxy anycast (Cloudflare), o mesmo
//                                      punhado de IPs serve milhões de domínios sem
//                                      relação entre si: IP igual não prova nada.
//
// Este segundo caso era o bug: com o PUBLIC_HOST atrás da Cloudflare, qualquer domínio
// de cliente também na Cloudflare casava por IP e o painel anunciava "aponta para este
// servidor" para um domínio cujo tráfego nunca chegaria aqui. Hoje esse cenário devolve
// `status: 'inconclusivo'` — nunca um `ok: true` falso.
import dns from 'node:dns/promises';
import { env } from '../config/env.js';
import { log } from '../config/log.js';
import { proxyDeIps, proxyDoIp } from './redes-proxy.js';

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
 * Identidade de rede do próprio serviço, para o painel saber QUAL instrução dar.
 *
 * Se o nosso host está atrás de um proxy compartilhado, mandar o cliente criar um
 * registro A com o IP anycast é conselho ruim: o pacote chega ao proxy, que não tem a
 * zona do cliente e devolve erro. A instrução que funciona é sempre o CNAME.
 *
 * @returns {Promise<{host: string, ips: string[], proxy: string|null, metodoRecomendado: 'cname'|'a_record'}>}
 */
export async function identidadeDoServidor() {
  const host = hostOf(env.PUBLIC_HOST);
  const ips = await resolveOwnIps();
  const proxy = proxyDeIps(ips);
  return {
    host,
    ips,
    proxy,
    metodoRecomendado: proxy ? 'cname' : 'a_record',
  };
}

/**
 * A DECISÃO, separada da consulta.
 *
 * Fica em função pura de propósito: é aqui que mora a regra que estava errada, e assim
 * ela é testável exaustivamente (todo par cliente/serviço, com e sem proxy) sem depender
 * de resolvedor de DNS nem de rede. `resolveDns` só junta as consultas e delega.
 *
 * `status` é o campo que vale — `ok` é só o atalho booleano para "provado":
 *
 *   'aponta'        prova positiva (CNAME para o nosso host, ou IP próprio em comum).
 *                   `ok: true`.
 *   'inconclusivo'  o domínio resolve para um proxy compartilhado (Cloudflare & cia),
 *                   onde IP igual não prova nem desmente nada. `ok: false`, e a
 *                   mensagem diz ao usuário qual é a verificação que de fato vale.
 *   'nao_resolve'   nenhum registro respondeu ainda (DNS não propagado ou inexistente).
 *   'nao_aponta'    resolve, mas para outro lugar.
 *
 * @param {{alvo: string, cnames?: string[], ipsDoCliente?: string[], ipsDoServico?: string[]}} entrada
 */
export function classificarDns({ alvo, cnames = [], ipsDoCliente = [], ipsDoServico = [] }) {
  const apontaPorCname = cnames.some((c) => hostOf(c) === alvo);
  const proxyDoCliente = proxyDeIps(ipsDoCliente);
  const proxyDoServico = proxyDeIps(ipsDoServico);
  const ipsEmComum = ipsDoCliente.filter((ip) => ipsDoServico.includes(ip));

  const esperado = {
    host: alvo,
    ips: ipsDoServico,
    proxy: proxyDoServico,
    // Atrás de proxy, o registro A com o IP anycast NÃO entrega o tráfego aqui.
    metodoRecomendado: proxyDoServico ? 'cname' : 'a_record',
  };
  const base = { ips: ipsDoCliente, cnames, proxy: proxyDoCliente, esperado };

  // 1) Prova positiva, e a única que sobrevive a qualquer proxy no caminho: o CNAME
  //    nomeia o nosso host, e esse nome não é de mais ninguém.
  if (apontaPorCname) {
    return { ok: true, status: 'aponta', metodo: 'cname', ...base };
  }

  // 2) Nada responde ainda.
  if (!ipsDoCliente.length) {
    return {
      ok: false,
      status: 'nao_resolve',
      metodo: null,
      ...base,
      error: 'domínio ainda não resolve (DNS não propagado ou registro inexistente)',
    };
  }

  // 3) IP em comum que identifica UM servidor (fora de qualquer faixa de proxy
  //    compartilhado): aí sim a igualdade de IP é prova.
  const comunsProprios = ipsEmComum.filter((ip) => !proxyDoIp(ip));
  if (comunsProprios.length) {
    return { ok: true, status: 'aponta', metodo: 'a_record', ...base };
  }

  // 4) Domínio atrás de proxy compartilhado (ou casando só por IP anycast): a
  //    comparação por IP não decide nada, nem a favor nem contra. Dizer "aponta"
  //    aqui era a mentira que o painel contava; dizer "não aponta" seria a oposta.
  const proxyRelevante = proxyDoCliente || (ipsEmComum.length ? proxyDoIp(ipsEmComum[0]) : null);
  if (proxyRelevante) {
    return {
      ok: false,
      status: 'inconclusivo',
      metodo: null,
      ...base,
      error: `verificação inconclusiva: o domínio resolve para IPs da ${proxyRelevante}, compartilhados por milhões de sites — IP igual ao nosso não prova que o tráfego chega aqui. A prova que vale é um CNAME para ${alvo} com o proxy (nuvem laranja) DESLIGADO nesse registro; enquanto ele estiver ligado, nenhuma consulta de DNS consegue confirmar o apontamento.`,
    };
  }

  return {
    ok: false,
    status: 'nao_aponta',
    metodo: null,
    ...base,
    error: `aponta para ${ipsDoCliente.join(', ')}, esperado ${ipsDoServico.join(', ') || alvo}`,
  };
}

/**
 * Confere se `hostname` aponta para o mesmo destino que o host público do serviço.
 * Faz as consultas e entrega a `classificarDns` — ver lá a tabela de `status`.
 *
 * @returns {Promise<{ok: boolean, status: string, metodo: string|null, ips?: string[],
 *   cnames?: string[], proxy?: string|null, esperado?: object, error?: string}>}
 */
export async function resolveDns(hostname) {
  const alvo = hostOf(env.PUBLIC_HOST);
  const host = hostOf(hostname);

  if (!host) return { ok: false, status: 'erro', metodo: null, error: 'hostname vazio' };
  if (!alvo || alvo === 'localhost') {
    return {
      ok: false,
      status: 'erro',
      metodo: null,
      error: 'PUBLIC_HOST não configurado — não é possível verificar em ambiente local',
    };
  }

  try {
    const [cnames, ipsDoCliente, ipsDoServico] = await Promise.all([
      dns.resolveCname(host).catch(() => []),
      resolveIps(host),
      resolveIps(alvo),
    ]);
    return classificarDns({ alvo, cnames, ipsDoCliente, ipsDoServico });
  } catch (err) {
    log('warn', 'falha ao verificar DNS', { hostname: host, error: err.message });
    return { ok: false, status: 'erro', metodo: null, error: err.message };
  }
}
