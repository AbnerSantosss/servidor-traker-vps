// Confirmação de instalação: os sinais que provam que o rastreamento está de pé.
//
// A DIFERENÇA ENTRE CONFIGURAR E INSTALAR
//
// A aba Instalação já mostrava um checklist, mas ele lia a CONFIGURAÇÃO do projeto:
// "Pixel ID preenchido ✓", "Access Token salvo ✓". Isso não diz nada sobre o site do
// cliente. Dá para ter os dois campos preenchidos, a tag nunca ter sido publicada no
// GTM, e o painel exibir dois vistos verdes — que é o pior resultado possível, porque
// o operador vai embora achando que terminou.
//
// Aqui cada sinal é uma EVIDÊNCIA: algo que só existe se aquele pedaço realmente rodou,
// com a hora em que aconteceu. "Ainda não chegou" é uma resposta honesta e útil;
// "configurado" não é resposta nenhuma.
//
// A EVIDÊNCIA MAIS INTERESSANTE É A DO PIXEL
//
// Não existe forma confiável de perguntar à Meta "o pixel está na página do cliente?".
// Mas o `_fbp` é um cookie que só o `fbq` cria. Se um `page_view` do navegador chegou
// com `user_data.fbp` preenchido, então o Pixel rodou naquela página — não há outro
// caminho para aquele valor existir. É uma prova indireta e forte, obtida sem sair de
// casa e sem chamar API de terceiro (I-7).
//
// CUSTO
//
// Uma consulta por sinal, todas com LIMIT 1 e todas apoiadas no índice
// `events_project_received_idx (project_id, received_at DESC)` ou
// `deliveries_project_status_idx (project_id, status)`. Nenhuma varre a tabela: num
// projeto com milhões de eventos, cada uma lê o topo do índice e para.
import { query } from '../pool.js';

/** Converte `row` em `{ ok, ...campos }`, ou o "ainda não" quando não veio linha. */
function sinal(row, montar) {
  if (!row) return { ok: false };
  return { ok: true, ...montar(row) };
}

/**
 * Todos os sinais de instalação de um projeto.
 *
 * Devolve sempre o objeto completo — um sinal que não pôde ser apurado vem
 * `{ ok: false }`, nunca ausente. É o que deixa o front renderizar a lista inteira sem
 * saber quais sinais existem, e o que faz "aguardando" ser um estado de primeira classe.
 */
export async function estadoInstalacao(projectId) {
  const [
    tagNavegador,
    pixelMeta,
    cliqueAnuncio,
    ponteIdentidade,
    webhookBackend,
    entregaMeta,
    entregaGoogle,
    dominio,
  ] = await Promise.all([
    sinalTagNavegador(projectId),
    sinalPixelMeta(projectId),
    sinalCliqueAnuncio(projectId),
    sinalPonteIdentidade(projectId),
    sinalWebhookBackend(projectId),
    sinalEntrega(projectId, 'meta'),
    sinalEntrega(projectId, 'google'),
    sinalDominio(projectId),
  ]);

  return {
    tag_navegador: tagNavegador,
    pixel_meta: pixelMeta,
    clique_anuncio: cliqueAnuncio,
    ponte_identidade: ponteIdentidade,
    webhook_backend: webhookBackend,
    entrega_meta: entregaMeta,
    entrega_google: entregaGoogle,
    dominio: dominio,
  };
}

// ---------------------------------------------------------------- navegador

/** A tag rodou no navegador: chegou evento de origem `web`. */
async function sinalTagNavegador(projectId) {
  const { rows } = await query(
    `SELECT received_at,
            payload->'page'->>'path' AS caminho,
            payload->>'event_source_url' AS url
       FROM events
      WHERE project_id = $1 AND source = 'web'
      ORDER BY received_at DESC
      LIMIT 1`,
    [projectId]
  );
  const base = sinal(rows[0], (r) => ({
    em: r.received_at,
    // O host é o que o operador reconhece ("é o meu site mesmo"); o caminho sozinho
    // ("/checkout") não distingue o site do cliente do ambiente de teste dele.
    onde: hostDe(r.url) || r.caminho || null,
  }));
  if (!base.ok) return base;

  const { rows: c } = await query(
    `SELECT count(*)::int AS n
       FROM events
      WHERE project_id = $1 AND source = 'web' AND received_at > now() - interval '24 hours'`,
    [projectId]
  );
  return { ...base, ultimas_24h: c[0]?.n ?? 0 };
}

/**
 * O Pixel da Meta rodou na página: chegou evento web com `_fbp`.
 *
 * `fbp` só nasce do `fbq`. Se ele veio, o Pixel executou — e isso importa porque sem
 * Pixel não há deduplicação navegador × servidor e a qualidade de correspondência cai,
 * mesmo com a CAPI funcionando perfeitamente.
 */
async function sinalPixelMeta(projectId) {
  const { rows } = await query(
    `SELECT received_at
       FROM events
      WHERE project_id = $1
        AND source = 'web'
        AND coalesce(payload->'user_data'->>'fbp', '') <> ''
      ORDER BY received_at DESC
      LIMIT 1`,
    [projectId]
  );
  return sinal(rows[0], (r) => ({ em: r.received_at }));
}

/** O clique do anúncio foi capturado: `fbc` (Meta) ou `gclid` (Google). */
async function sinalCliqueAnuncio(projectId) {
  const { rows } = await query(
    `SELECT received_at, tem_fbc, tem_gclid
       FROM events
      WHERE project_id = $1 AND (tem_fbc OR tem_gclid)
      ORDER BY received_at DESC
      LIMIT 1`,
    [projectId]
  );
  return sinal(rows[0], (r) => ({
    em: r.received_at,
    meta: !!r.tem_fbc,
    google: !!r.tem_gclid,
  }));
}

/** A ponte de identidade está guardando quem é o visitante. */
async function sinalPonteIdentidade(projectId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n, max(last_seen_at) AS ultima
       FROM identities
      WHERE project_id = $1`,
    [projectId]
  );
  const r = rows[0];
  if (!r || !r.n) return { ok: false };
  return { ok: true, em: r.ultima, pessoas: r.n };
}

/** O backend do cliente está mandando conversão: chegou evento de origem `webhook`. */
async function sinalWebhookBackend(projectId) {
  const { rows } = await query(
    `SELECT received_at, event_name
       FROM events
      WHERE project_id = $1 AND source = 'webhook'
      ORDER BY received_at DESC
      LIMIT 1`,
    [projectId]
  );
  return sinal(rows[0], (r) => ({ em: r.received_at, evento: r.event_name }));
}

/**
 * O destino confirmou o recebimento.
 *
 * Guarda o que a plataforma devolveu, não a nossa opinião: `events_received` e
 * `fbtrace_id` no caso da Meta são o número e o identificador que o suporte dela pede
 * quando alguém abre chamado. Sem eles, "entregue" é palavra nossa.
 */
async function sinalEntrega(projectId, destino) {
  const { rows } = await query(
    `SELECT d.updated_at, d.response
       FROM deliveries d
      WHERE d.project_id = $1 AND d.destination_type = $2 AND d.status = 'success'
      ORDER BY d.updated_at DESC
      LIMIT 1`,
    [projectId, destino]
  );
  return sinal(rows[0], (r) => ({
    em: r.updated_at,
    eventos_recebidos: r.response?.events_received ?? null,
    fbtrace_id: r.response?.fbtrace_id ?? null,
  }));
}

// NÃO existe sinal de "deduplicação navegador × servidor", e a ausência é deliberada.
//
// A tentativa óbvia é procurar o mesmo `(event_id, event_name)` chegando pelas duas
// origens. Ela não funciona: `recordEvent` deduplica exatamente por esse par NA
// INGESTÃO (src/db/repos/events.js), então o segundo envio é recusado como duplicata e
// nunca vira linha. A consulta compila, roda, e devolve vazio para sempre — um sinal
// que só sabe dizer "ainda não" é pior que sinal nenhum, porque parece uma pendência.
//
// E a dedup que de fato importa — Pixel do navegador × CAPI do servidor — acontece
// DENTRO da Meta, entre um envio que passa por aqui e outro que nunca passa. Não há
// evidência dela deste lado. Inventar uma seria o falso verde que este arquivo existe
// para evitar. O que o painel pode fazer sobre dedup é ENSINAR (passe o `event_id` que
// `trk()` devolve como `eventID` no `fbq`), e isso é texto da aba, não sinal.

/** O domínio first-party do projeto está com certificado. */
async function sinalDominio(projectId) {
  const { rows } = await query(
    `SELECT hostname, verification_status, ssl_issued_at
       FROM project_domains
      WHERE project_id = $1
      ORDER BY is_primary DESC, (verification_status = 'active') DESC, id
      LIMIT 1`,
    [projectId]
  );
  const r = rows[0];
  if (!r) return { ok: false };
  return {
    ok: r.verification_status === 'active',
    em: r.ssl_issued_at,
    hostname: r.hostname,
    situacao: r.verification_status,
  };
}

// ---------------------------------------------------------------- auxiliares

/** Host de uma URL, ou null. Nunca lança: URL malformada vinda do navegador é comum. */
function hostDe(url) {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}
