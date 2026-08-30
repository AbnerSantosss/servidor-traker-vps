// Escolha do domínio first-party que entra nos endereços gerados pelo servidor.
//
// É a razão de existir do produto. Uma tag apontada para o host do serviço funciona —
// responde 202, os eventos chegam, nenhum erro aparece — mas `ingest/cookies.js` grava
// `_fbp`/`_fbc` no domínio de QUEM RECEBEU a chamada. Recebendo em zyraflow.site, o
// cookie nasce com `Domain=zyraflow.site` e o Pixel, rodando numa página do cliente,
// não consegue lê-lo. A camada 1 da mitigação de ITP morre em silêncio.
//
// Por isso o endereço vem daqui — do domínio verificado do projeto — e não do host da
// requisição, que é o host de quem PEDIU o script (o painel, quase sempre).
import { listDomains } from '../db/repos/projects.js';
import { env, publicBaseUrl } from '../config/env.js';
import { log } from '../config/log.js';

// Ordem de preferência entre os status de `project_domains`.
// `active`   = certificado já emitido (passou pelo gate de TLS on-demand do Caddy).
// `verified` = DNS confere, certificado ainda não emitido — o Caddy emite no primeiro acesso.
//
// `pending` e `failed` ficam FORA de propósito: apontar a tag para um domínio que ainda
// não resolve derruba a coleta inteira do cliente, e perder a coleta é pior que perder o
// first-party. É também o que impede o domínio raiz cadastrado no onboarding (que fica
// eternamente `pending`, porque ninguém aponta o site inteiro para cá) de sequestrar o
// endereço do subdomínio que de fato foi verificado.
const PESO_STATUS = { active: 0, verified: 1 };

export function normalizarHost(valor) {
  return String(valor || '').split(':')[0].trim().toLowerCase() || null;
}

/**
 * Escolhe o hostname first-party a usar, ou null quando o projeto não tem nenhum
 * domínio utilizável. Função pura — recebe as linhas de `project_domains`.
 *
 * `preferido` é o host da requisição: se o script foi pedido por um domínio DO PRÓPRIO
 * projeto, é esse que vale. Num projeto com vários sites, cada página precisa falar com
 * o SEU subdomínio — senão o cookie volta a nascer cruzado, que é justo o que este
 * módulo existe para evitar.
 */
export function escolherHostFirstParty(domains, { preferido } = {}) {
  const elegiveis = (domains || []).filter((d) => Object.hasOwn(PESO_STATUS, d?.verification_status));
  if (!elegiveis.length) return null;

  const alvo = normalizarHost(preferido);
  if (alvo && elegiveis.some((d) => d.hostname === alvo)) return alvo;

  // `listDomains` já entrega ordenado por is_primary DESC, created_at ASC. A ordenação
  // do JS é estável, então entre status iguais o domínio primário continua ganhando.
  const ordenados = [...elegiveis].sort(
    (a, b) => PESO_STATUS[a.verification_status] - PESO_STATUS[b.verification_status]
  );
  return ordenados[0].hostname;
}

/**
 * Base URL first-party do projeto (`https://t.cliente.com`), com queda para `fallback`
 * quando o projeto ainda não tem domínio verificado — projeto novo continua funcionando
 * exatamente como antes, sem regressão.
 */
export async function baseFirstParty(projectId, { preferido, fallback } = {}) {
  const padrao = fallback || publicBaseUrl();
  if (!projectId) return padrao;
  try {
    const host = escolherHostFirstParty(await listDomains(projectId), { preferido });
    return host ? `${env.PUBLIC_SCHEME}://${host}` : padrao;
  } catch (err) {
    // Falha de banco ao montar um endereço não pode derrubar a entrega do script nem a
    // tela do painel: cai no comportamento antigo e registra.
    log('warn', 'falha ao resolver domínio first-party', { project: projectId, error: err.message });
    return padrao;
  }
}
