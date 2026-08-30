// Verificação de DNS do onboarding — o falso positivo do anycast.
//
// O defeito que estes testes trancam: com o PUBLIC_HOST atrás da Cloudflare, a checagem
// comparava os IPs resolvidos e, batendo, dizia "aponta para este servidor". Só que
// dois domínios SEM NENHUMA RELAÇÃO, ambos com proxy da Cloudflare, resolvem para o
// mesmo pool anycast. O painel anunciava DNS pronto para um domínio cujo tráfego nunca
// chegaria aqui — e o usuário ia esperar por um certificado que não vinha.
//
// A regra correta não é "adivinhar melhor": é reconhecer quando a pergunta "os IPs são
// iguais?" não tem resposta útil, e dizer isso (`status: 'inconclusivo'`) em vez de
// mentir para os dois lados. Por isso a maioria dos casos abaixo checa o `status`, e não
// só o booleano — é o `ok: true` indevido que o bug produzia.
import './setup-env.js'; // precisa vir primeiro — define o ambiente antes de config/env.js ser lido

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classificarDns } from '../src/tenancy/dns-check.js';
import { ipEmCidr, proxyDoIp, proxyDeIps } from '../src/tenancy/redes-proxy.js';

const ALVO = 'traker.codigovencedor.com';

// Dois IPs anycast REAIS da Cloudflare (faixas 104.16.0.0/13 e 172.64.0.0/13): é o
// cenário do bug — o cliente e o serviço caem no mesmo pool sem terem relação alguma.
const CF_A = '104.21.35.7';
const CF_B = '172.67.140.9';
const CF_V6 = '2606:4700:3033::6815:2307';

// IP de servidor dedicado (Oracle Cloud): aqui o IP identifica UMA máquina.
const PROPRIO = '150.230.10.20';
const OUTRO = '203.0.113.9';

describe('faixas de proxy compartilhado', () => {
  test('reconhece IPv4 dentro das faixas da Cloudflare', () => {
    assert.equal(proxyDoIp(CF_A), 'Cloudflare');
    assert.equal(proxyDoIp(CF_B), 'Cloudflare');
    assert.equal(proxyDoIp('162.159.0.1'), 'Cloudflare');   // 162.158.0.0/15
    assert.equal(proxyDoIp('131.0.72.1'), 'Cloudflare');    // 131.0.72.0/22
  });

  test('reconhece IPv6 dentro das faixas da Cloudflare', () => {
    assert.equal(proxyDoIp(CF_V6), 'Cloudflare');
    assert.equal(proxyDoIp('2400:cb00::1'), 'Cloudflare');
  });

  test('IP de servidor dedicado não é confundido com proxy', () => {
    assert.equal(proxyDoIp(PROPRIO), null);
    assert.equal(proxyDoIp(OUTRO), null);
    assert.equal(proxyDoIp('8.8.8.8'), null);
    assert.equal(proxyDoIp('2001:4860:4860::8888'), null);
  });

  test('vizinho de faixa fica de fora — o limite do CIDR é respeitado', () => {
    // 104.16.0.0/13 cobre 104.16.* a 104.23.*; 104.24.0.0/14 cobre até 104.27.*.
    assert.equal(proxyDoIp('104.15.255.255'), null);
    assert.equal(proxyDoIp('104.28.0.1'), null);
    // 131.0.72.0/22 termina em 131.0.75.255.
    assert.equal(proxyDoIp('131.0.76.1'), null);
  });

  test('ipEmCidr compara pelo prefixo, não pelo texto', () => {
    assert.equal(ipEmCidr('10.0.0.5', '10.0.0.0/8'), true);
    assert.equal(ipEmCidr('11.0.0.5', '10.0.0.0/8'), false);
    assert.equal(ipEmCidr('192.168.1.1', '192.168.1.0/24'), true);
    assert.equal(ipEmCidr('192.168.2.1', '192.168.1.0/24'), false);
    // Famílias diferentes nunca casam.
    assert.equal(ipEmCidr('2606:4700::1', '104.16.0.0/13'), false);
    assert.equal(ipEmCidr('104.16.0.1', '2606:4700::/32'), false);
    // Lixo não derruba nem casa por acidente.
    assert.equal(ipEmCidr('não-é-ip', '104.16.0.0/13'), false);
    assert.equal(ipEmCidr('', '104.16.0.0/13'), false);
  });

  test('a lista só conta como "atrás de proxy" quando NENHUM IP está fora dele', () => {
    assert.equal(proxyDeIps([CF_A, CF_B]), 'Cloudflare');
    // Um IP próprio no meio devolve a comparação clássica ao jogo.
    assert.equal(proxyDeIps([CF_A, PROPRIO]), null);
    assert.equal(proxyDeIps([]), null);
  });
});

describe('classificação do DNS de um domínio de cliente', () => {
  test('CNAME para o nosso host é prova positiva, mesmo com tudo atrás da Cloudflare', () => {
    // É a prova que o anycast não corrompe: o nome do destino é nosso e de mais ninguém.
    const r = classificarDns({
      alvo: ALVO,
      cnames: [ALVO],
      ipsDoCliente: [CF_A],
      ipsDoServico: [CF_B],
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'aponta');
    assert.equal(r.metodo, 'cname');
  });

  test('CNAME é comparado sem depender de caixa nem de espaços em volta', () => {
    const r = classificarDns({ alvo: ALVO, cnames: [`  ${ALVO.toUpperCase()}  `], ipsDoCliente: [OUTRO] });
    assert.equal(r.ok, true);
    assert.equal(r.metodo, 'cname');
  });

  test('registro A com o IP do nosso servidor dedicado é prova positiva', () => {
    const r = classificarDns({ alvo: ALVO, ipsDoCliente: [PROPRIO], ipsDoServico: [PROPRIO] });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'aponta');
    assert.equal(r.metodo, 'a_record');
  });

  // ---- o bug ----

  test('REGRESSÃO: IP anycast igual NÃO vira "aponta para este servidor"', () => {
    // Cliente e serviço na Cloudflare, mesmo IP: era exatamente aqui que o painel mentia.
    const r = classificarDns({ alvo: ALVO, ipsDoCliente: [CF_A], ipsDoServico: [CF_A] });
    assert.equal(r.ok, false, 'IP anycast em comum não pode contar como prova');
    assert.equal(r.status, 'inconclusivo');
    assert.equal(r.metodo, null, 'não existe método comprovado neste caso');
  });

  test('inconclusivo explica o porquê e aponta a verificação que vale', () => {
    const r = classificarDns({ alvo: ALVO, ipsDoCliente: [CF_A], ipsDoServico: [CF_A] });
    assert.match(r.error, /inconclusiva/);
    assert.match(r.error, /Cloudflare/);
    assert.ok(r.error.includes(ALVO), 'a mensagem precisa dizer para onde apontar o CNAME');
    assert.match(r.error, /CNAME/);
    assert.equal(r.proxy, 'Cloudflare');
  });

  test('inconclusivo também quando os IPs anycast são diferentes', () => {
    // Não dá para dizer "não aponta": com o proxy no meio, o cliente pode estar
    // perfeitamente configurado e ainda assim resolver para outro IP do mesmo pool.
    const r = classificarDns({ alvo: ALVO, ipsDoCliente: [CF_A], ipsDoServico: [CF_B] });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'inconclusivo');
  });

  test('inconclusivo em IPv6 anycast também', () => {
    const r = classificarDns({ alvo: ALVO, ipsDoCliente: [CF_V6], ipsDoServico: [CF_V6] });
    assert.equal(r.status, 'inconclusivo');
  });

  test('A record apontado direto para um IP anycast não passa por prova', () => {
    // Cliente fora da Cloudflare que copiou nosso IP anycast num registro A: o pacote
    // chega ao proxy, que não tem a zona dele. Confirmar seria prometer o que não vai
    // acontecer — e o serviço aqui nem está atrás de proxy, só o IP copiado é que está.
    const r = classificarDns({ alvo: ALVO, ipsDoCliente: [CF_A, PROPRIO], ipsDoServico: [CF_A] });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'inconclusivo');
  });

  // ---- casos que continuam como antes ----

  test('domínio que ainda não resolve continua "nao_resolve"', () => {
    const r = classificarDns({ alvo: ALVO, ipsDoCliente: [], ipsDoServico: [PROPRIO] });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'nao_resolve');
    assert.match(r.error, /não resolve/);
  });

  test('domínio apontado para outro lugar continua "nao_aponta", com os dois lados na mensagem', () => {
    const r = classificarDns({ alvo: ALVO, ipsDoCliente: [OUTRO], ipsDoServico: [PROPRIO] });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'nao_aponta');
    assert.equal(r.error, `aponta para ${OUTRO}, esperado ${PROPRIO}`);
  });
});

describe('instrução de DNS que o painel deve dar', () => {
  test('serviço atrás de proxy: o método recomendado é CNAME, não registro A', () => {
    // O IP que resolvemos é anycast — mandar criar um registro A com ele é conselho ruim.
    const r = classificarDns({ alvo: ALVO, ipsDoCliente: [OUTRO], ipsDoServico: [CF_A] });
    assert.equal(r.esperado.proxy, 'Cloudflare');
    assert.equal(r.esperado.metodoRecomendado, 'cname');
  });

  test('serviço em IP dedicado: registro A continua sendo instrução válida', () => {
    const r = classificarDns({ alvo: ALVO, ipsDoCliente: [OUTRO], ipsDoServico: [PROPRIO] });
    assert.equal(r.esperado.proxy, null);
    assert.equal(r.esperado.metodoRecomendado, 'a_record');
  });
});
