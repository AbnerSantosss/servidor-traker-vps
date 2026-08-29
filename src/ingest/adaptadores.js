// Adaptadores de formato de entrada.
//
// Cada plataforma dispara o webhook no formato dela. Em vez de exigir que o site do
// cliente reescreva o payload (mexer no checkout de produção para acomodar o tracking
// é o tipo de coisa que ninguém faz), o servidor reconhece formatos conhecidos e traduz
// para o formato canônico antes da normalização.
//
// Para acrescentar um formato novo: escreva um adaptador com `detectar` e `adaptar`,
// e registre em ADAPTADORES. A ordem importa — o primeiro que detectar vence.
//
// Além dos hardcoded, `adaptarPayload` também considera os adaptadores DINÂMICOS do
// projeto (Webhook Studio, F4) — mapeamentos declarativos interpretados por
// src/ingest/mapeamento.js. Este arquivo importa de lá só o necessário para rodar esse
// segundo estágio; os primitivos abaixo (texto, vazio, ipPublico, separarNome,
// deMenorParaMaior, unixDeIso, clientIdDoGa) são exportados porque mapeamento.js os
// reaproveita — é a mesma regra de negócio, só muda quem a declara (código fixo aqui
// vs. JSON configurável lá). Import circular entre os dois módulos é seguro aqui: nada
// do que é importado é usado no nível superior do arquivo, só dentro de funções
// chamadas depois que os dois módulos já terminaram de carregar.
import { detectarComMapeamento, aplicarMapeamento } from './mapeamento.js';

// ---------------------------------------------------------------- utilidades

export const vazio = (v) => v === undefined || v === null || String(v).trim() === '';
export const texto = (v) => (vazio(v) ? undefined : String(v).trim());

/**
 * IP privado, de loopback ou link-local não serve como sinal de correspondência.
 * Um `10.244.16.187` é o IP do balanceador ou do pod interno de quem enviou, não o do
 * visitante. Mandar isso para a Meta é pior do que não mandar nada: é um identificador
 * errado, e todos os eventos daquele servidor compartilhariam o mesmo "visitante".
 */
export function ipPublico(valor) {
  if (vazio(valor)) return undefined;
  let ip = String(valor).trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4 mapeado em IPv6

  if (/^10\./.test(ip)) return undefined;
  if (/^127\./.test(ip)) return undefined;
  if (/^192\.168\./.test(ip)) return undefined;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return undefined;
  if (/^169\.254\./.test(ip)) return undefined;
  if (ip === '::1' || ip === '0.0.0.0') return undefined;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return undefined; // ULA IPv6
  if (/^fe80:/i.test(ip)) return undefined;             // link-local IPv6

  return ip;
}

// "Joao marcos rocha de araujo" -> { first_name: "Joao", last_name: "araujo" }
// A Meta usa fn/ln separados; mandar o nome inteiro num só campo não casa.
export function separarNome(nomeCompleto) {
  const partes = String(nomeCompleto || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return {};
  if (partes.length === 1) return { first_name: partes[0] };
  return { first_name: partes[0], last_name: partes.at(-1) };
}

// "GA1.1.121717542.1784724157" -> "121717542.1784724157"
// Exportada: é a mesma extração que a transformação `ga_client_id` da DSL usa
// (ver src/ingest/mapeamento.js) — reaproveitada, não duplicada.
export function clientIdDoGa(valorGa) {
  if (vazio(valorGa)) return undefined;
  const p = String(valorGa).split('.');
  return p.length >= 4 ? `${p[2]}.${p[3]}` : undefined;
}

// Valores monetários em unidade menor (centavos) -> unidade principal.
export function deMenorParaMaior(valorMenor) {
  const n = Number(valorMenor);
  return Number.isFinite(n) ? n / 100 : undefined;
}

const paraUnix = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
};
// Nome exportado que a transformação `unix_de_iso` da DSL chama (ver mapeamento.js).
export const unixDeIso = paraUnix;

// ---------------------------------------------------------------- Código Vencedor

/**
 * Formato do checkout do Código Vencedor.
 *
 * Reconhecido por três marcas juntas: `event`, `lead` e `attribution`. Exigir as três
 * evita casar por acidente com um payload genérico que só tenha `event`.
 */
const codigoVencedor = {
  nome: 'codigo-vencedor',

  // Nem todo evento do catálogo traz `lead` (ferramenta usada, e-book concluído) nem
  // `attribution` completo. O marcador confiável é `event` + `eventId` juntos, com pelo
  // menos um dos dois blocos — combinação que um payload canônico nunca teria.
  detectar: (b) =>
    b && typeof b === 'object' &&
    typeof b.event === 'string' &&
    typeof b.eventId === 'string' &&
    ((typeof b.lead === 'object' && b.lead !== null) ||
     (typeof b.attribution === 'object' && b.attribution !== null)),

  adaptar(b) {
    const lead = b.lead || {};
    const attr = b.attribution || {};
    const cookies = attr.cookies || {};
    const utm = attr.utm || {};

    return {
      event_name: nomeDoEvento(b),
      // O eventId do checkout já é único por evento — serve de chave de idempotência.
      event_id: texto(b.eventId) || texto(b.paymentId) || texto(b.sessionId),
      event_time: paraUnix(b.occurredAt),
      // A compra aconteceu no site; o backend só confirmou o pagamento. `website` dá
      // atribuição melhor que `system_generated`, que é para evento sem origem no site.
      action_source: 'website',
      event_source_url: texto(attr.eventSourceUrl),

      // Chave da ponte de identidade: é por ela que o servidor recupera o fbclid/gclid
      // que o navegador capturou e o backend não conhece. A ordem segue da chave mais
      // estável para a mais disponível — o `sessionId` existe já no início do checkout,
      // que costuma ser o primeiro momento em que o site sabe quem é o visitante.
      // O site precisa empurrar ESSE MESMO valor para o dataLayer, para o coletor
      // gravar a identidade sob a mesma chave.
      user_id: texto(b.customerReference) || texto(lead.taxId) || texto(b.sessionId),

      user_data: {
        email: texto(lead.email),
        phone: texto(lead.phone),
        ...separarNome(lead.name),
        // Identificador estável do cliente, para casar navegador e servidor.
        external_id: texto(b.customerReference) || texto(lead.taxId),

        fbp: texto(cookies.fbp),
        fbc: texto(cookies.fbc),
        fbclid: texto(cookies.fbclid),
        gclid: texto(cookies.gclid) || texto(cookies.gclAu),
        gbraid: texto(cookies.gbraid),
        wbraid: texto(cookies.wbraid),
        ga_client_id: clientIdDoGa(cookies.ga),

        utm_source: texto(utm.source),
        utm_medium: texto(utm.medium),
        utm_campaign: texto(utm.campaign),
        utm_content: texto(utm.content),
        utm_term: texto(utm.term),

        // O User-Agent aqui é o do NAVEGADOR do comprador, capturado no checkout —
        // muito melhor que o da biblioteca HTTP que fez o POST. O IP passa pelo filtro
        // de rede privada: se vier de dentro do cluster, é descartado e o servidor cai
        // para o que a ponte de identidade guardou.
        client_user_agent: texto(attr.userAgent),
        client_ip_address: ipPublico(attr.ipAddress),
      },

      custom_data: {
        // amountMinor é o valor EFETIVAMENTE COBRADO, em centavos. É ele que vira
        // receita — usar originalAmountMinor infla o ROAS com desconto que não entrou.
        value: deMenorParaMaior(b.amountMinor),
        currency: texto(b.currency) || 'BRL',
        order_id: texto(b.paymentId) || texto(b.sessionId),
        content_ids: Array.isArray(b.productIds) && b.productIds.length ? b.productIds : undefined,
        content_type: Array.isArray(b.productIds) && b.productIds.length ? 'product' : undefined,
        num_items: Array.isArray(b.productIds) && b.productIds.length ? b.productIds.length : undefined,
        // Contexto útil no relatório, sem valor de correspondência.
        payment_method: texto(b.method),
        coupon: texto(b.pricing?.couponCode),
        valor_original: deMenorParaMaior(b.pricing?.originalAmountMinor),
        desconto: deMenorParaMaior(b.pricing?.discountMinor),
      },
    };
  },
};

// ---------------------------------------------------------------- xWinner (backoffice)

/**
 * Momento do evento.
 *
 * O envelope do backoffice traz `created_at` (quando o webhook foi montado), mas cada
 * evento carrega dentro de `data` o carimbo do FATO — `approved_at` para a compra,
 * `generated_at` para o PIX, e assim por diante. É esse que vale: entre o fato e o
 * despacho pode haver retry, fila e reprocessamento, e a Meta atribui pela hora do
 * evento. `created_at` fica como último recurso, e `subscription_cancelled` é o caso
 * real que depende dele — é o único evento do catálogo sem carimbo próprio.
 *
 * `last_activity_at` (pré-checkout) NÃO entra: é a última interação do lead, não o
 * instante em que a sessão expirou.
 */
const CARIMBOS = [
  'approved_at', 'generated_at', 'attempted_at', 'opened_at', 'abandoned_at',
  'registered_at', 'completed_at', 'started_at', 'renewed_at', 'expired_at', 'occurred_at',
];

function momentoDoEvento(b) {
  const d = b.data || {};
  for (const campo of CARIMBOS) if (!vazio(d[campo])) return d[campo];
  return b.created_at;
}

/**
 * Formato do backoffice do xWinner (`admin.codigovencedor.com` → Integrações → Webhooks).
 *
 * Envelope `{ event, event_id, version, created_at, data: { … } }`, snake_case, com todo
 * o conteúdo dentro de `data`. É um contrato DIFERENTE do `codigo-vencedor` abaixo, que
 * nasceu dos payloads crus da Checkout Platform (camelCase, plano) — o backoffice
 * reempacota aqueles eventos e acrescenta os dele. Os dois convivem porque as duas
 * origens podem estar ligadas ao mesmo tempo.
 *
 * A detecção olha só o ENVELOPE, de propósito. Exigir `lead` ou `attribution` — como faz
 * o adaptador irmão — deixaria de fora oito dos dezoito eventos que disparam: as quatro
 * assinaturas, estorno, chargeback, e-book e ferramenta não trazem nenhum dos dois.
 */
const xwinner = {
  nome: 'xwinner',

  detectar: (b) =>
    b && typeof b === 'object' &&
    typeof b.event === 'string' &&
    typeof b.event_id === 'string' &&
    typeof b.data === 'object' && b.data !== null && !Array.isArray(b.data),

  adaptar(b) {
    const d = b.data || {};
    const lead = d.lead || {};
    const buyer = d.buyer || {};
    // Eventos de assinatura e de engajamento identificam a pessoa por `user`, não por
    // `buyer` — não há comprador quando não há compra.
    const usuario = d.user || {};
    const attr = d.attribution || {};
    const cookies = attr.cookies || {};
    const utm = attr.utm || {};
    const produto = d.product || {};

    // Identificador estável da pessoa, e chave da ponte de identidade: é por ele que o
    // servidor recupera o fbclid/gclid que o navegador capturou e o backend não conhece.
    // O site precisa empurrar ESTE MESMO valor para o dataLayer.
    const externalId = texto(buyer.external_id) || texto(usuario.external_id);

    // Identificador de negócio, da chave mais específica para a mais genérica.
    const idNegocio =
      texto(d.order_id) || texto(d.purchase_id) || texto(d.session_token) ||
      texto(d.precheckout_id) || texto(d.subscription_id);

    const ids = Array.isArray(d.product_ids) && d.product_ids.length
      ? d.product_ids.map(String)
      : (texto(produto.id) ? [texto(produto.id)] : undefined);

    return {
      event_name: nomeDoEvento(b),
      // O `event_id` do envelope é único por evento na origem — serve de chave de
      // idempotência e sobrevive a retry do n8n ou do próprio backoffice.
      event_id: texto(b.event_id),
      event_time: paraUnix(momentoDoEvento(b)),
      action_source: 'website',
      // `page_origin` só existe no abandono e é a página real do checkout; fora dele, a
      // landing é a melhor aproximação que o payload oferece.
      event_source_url: texto(d.page_origin) || texto(attr.landing_page),
      referrer: texto(attr.referrer),

      user_id: externalId || idNegocio,

      user_data: {
        email: texto(lead.email) || texto(buyer.email) || texto(usuario.email),
        phone: texto(lead.phone) || texto(buyer.phone) || texto(usuario.phone),
        ...separarNome(lead.name || buyer.name || usuario.name),
        // A Meta aceita data de nascimento hasheada (`db`) como campo de correspondência.
        // O catálogo entrega isso de graça em todo evento com `lead`.
        birth_date: texto(lead.birth_date) || texto(d.birth_date),
        external_id: externalId,

        fbp: texto(cookies.fbp),
        fbc: texto(cookies.fbc),
        fbclid: texto(cookies.fbclid),
        // `gcl_au` NÃO entra aqui. Apesar do nome parecido, `_gcl_au` é o cookie
        // first-party de mensuração do Google (`1.1.<aleatório>.<timestamp>`) e não
        // contém gclid nenhum — quem carrega o clique é o `_gcl_aw`. Mandá-lo como
        // gclid faz o Google aceitar a conversão e não casar com clique algum, que é
        // a falha mais cara possível: silenciosa.
        gclid: texto(cookies.gclid),
        gbraid: texto(cookies.gbraid),
        wbraid: texto(cookies.wbraid),
        ga_client_id: clientIdDoGa(cookies.ga),

        utm_source: texto(utm.source),
        utm_medium: texto(utm.medium),
        utm_campaign: texto(utm.campaign),
        utm_content: texto(utm.content),
        utm_term: texto(utm.term),

        // IP e User-Agent do NAVEGADOR do comprador, capturados no checkout — melhores
        // que os da requisição, que seriam do n8n ou do servidor do cliente. O IP passa
        // pelo filtro de faixa privada.
        client_user_agent: texto(attr.user_agent),
        client_ip_address: ipPublico(attr.ip),
      },

      custom_data: {
        // `amount` é o valor EFETIVAMENTE COBRADO, em centavos (confirmado com o
        // cliente): `original_amount` 2490 − `discount` 500 = `amount` 1990 = R$ 19,90.
        // Sem a divisão, a Meta receberia R$ 1.990,00 — erro de 100x.
        value: deMenorParaMaior(d.amount),
        currency: texto(d.currency) || 'BRL',
        order_id: idNegocio,
        content_ids: ids,
        content_type: ids ? 'product' : undefined,
        content_name: texto(produto.name),
        num_items: ids ? ids.length : undefined,

        // Contexto para conversão personalizada e para o postback. Sem valor de
        // correspondência, mas é o que permite segmentar "só quem pagou por PIX" ou
        // "só quem usou cupom" no Gerenciador de Eventos.
        payment_method: texto(d.payment_method),
        coupon: texto(d.coupon_code),
        valor_original: deMenorParaMaior(d.original_amount),
        desconto: deMenorParaMaior(d.discount),
        // `status` é campo padrão da Meta (usado em Lead) — reaproveitá-lo para o
        // status do pedido mandaria "refunded"/"active" para um campo que significa
        // outra coisa. Vai com nome próprio.
        situacao: texto(d.status),
        etapa: texto(d.stage),
        expirado_por: texto(d.expired_by),
        plano_id: texto(d.plan?.id),
        assinatura_id: texto(d.subscription_id),
        pacote_creditos: d.credit_pack?.credits,
        ferramenta: texto(d.tool),
        capitulos_concluidos: d.chapters_completed,
      },
    };
  },
};

/**
 * Tradução dos eventos do checkout para os nomes canônicos do produto.
 *
 * Regra dura: **nada vira `purchase` sem confirmação explícita de pagamento.**
 * Nem "sessão de checkout concluída" nem "PIX gerado" são receita — no PIX, gerar o
 * QR Code é intenção, e boa parte nunca é paga. Contar isso como compra inflaria o
 * ROAS e, pior, ensinaria o algoritmo da Meta a buscar quem gera PIX e não paga.
 *
 * Eventos que não estão na tabela viram um nome canônico legível (pontos viram
 * underscore) e aparecem no painel para o operador mapear. Nada é descartado em
 * silêncio — evento desconhecido fica visível, não sumido.
 */
export function nomeDoEvento(b) {
  const evento = String(b.event || '').toLowerCase();

  // Só é compra quando o pagamento está declarado como concluído.
  const statusPago = ['paid', 'approved', 'confirmed', 'succeeded', 'completed'];
  const pago = statusPago.includes(String(b.paymentStatus || '').toLowerCase());

  const mapa = {
    // ---- Catálogo do backoffice do Código Vencedor (nomes técnicos oficiais) ----
    // Aquisição
    user_registered: 'sign_up',
    onboarding_completed: 'onboarding_concluido',
    // Conversão
    precheckout_opened: 'lead',              // lead deixou contato no pré-checkout
    // Pré-checkout e checkout são etapas DIFERENTES do funil (decisão do cliente), e os
    // dois abandonos também: `precheckout_expired` é a sessão de pré-checkout que
    // expirou, `checkout_lead_abandoned` é o lead que largou antes de a sessão existir.
    // Colapsar os dois no mesmo nome canônico contaria um abandono duas vezes no funil,
    // e a idempotência por `event_id` não pegaria — são eventos distintos na origem.
    precheckout_expired: 'precheckout_expirado',
    checkout_session_opened: 'begin_checkout',
    payment_generated: 'pix_gerado',         // PIX gerado: intenção, ainda sem dinheiro
    checkout_card_attempted: 'cartao_tentado',
    checkout_abandoned: 'abandoned_checkout',
    checkout_lead_abandoned: 'lead_abandonado',
    purchase_approved: 'purchase',           // ESTE é o pagamento confirmado
    purchase_refunded: 'compra_estornada',
    chargeback_opened: 'chargeback',
    // Assinatura
    subscription_started: 'assinatura_iniciada',
    subscription_renewed: 'assinatura_renovada',
    subscription_cancelled: 'assinatura_cancelada',
    subscription_expired: 'assinatura_expirada',
    // Engajamento
    ebook_completed: 'ebook_concluido',
    tool_used: 'ferramenta_usada',

    // ---- Nomes da Checkout Platform (repassados com notação de ponto) ----
    'checkout.pix.generated': 'pix_gerado',
    'checkout.session.created': 'begin_checkout',
    'checkout.session.opened': 'begin_checkout',
    'checkout.session.expired': 'abandoned_checkout',
    'checkout.lead.abandoned': 'lead_abandonado',
    'pre.checkout.session.opened': 'lead',
    'pre.checkout.session.expired': 'precheckout_expirado',
    // Sessão de checkout finalizada NÃO é sinônimo de pagamento aprovado; só vira
    // compra se o próprio payload afirmar que foi pago.
    'checkout.session.completed': pago ? 'purchase' : 'checkout_concluido',
    'payment.approved': 'purchase',
    'payment.confirmed': 'purchase',
    'payment.paid': 'purchase',
    'checkout.payment.approved': 'purchase',
    'order.paid': 'purchase',
    'lead.created': 'lead',
    'subscription.created': 'assinatura_iniciada',
  };

  if (mapa[evento]) return mapa[evento];

  // Evento fora da tabela: se o payload declara pagamento concluído, é compra.
  if (pago) return 'purchase';

  return evento.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'custom_event';
}

// ---------------------------------------------------------------- registro

// Ordem: `xwinner` primeiro por ser o formato que está em produção hoje (é o que o
// backoffice dispara). Os dois não podem colidir de qualquer forma — um exige
// `event_id` + `data`, o outro exige `eventId` camelCase —, mas o mais provável
// primeiro poupa uma detecção por evento.
const ADAPTADORES = [xwinner, codigoVencedor];

/**
 * Aplica o primeiro adaptador que reconhecer o payload.
 *
 * Devolve `{ corpo, formato, sombra }`:
 *   - `formato` é null quando NADA reconheceu o payload (nem hardcoded, nem dinâmico
 *     ativo) — é o sinal para a ingestão capturar uma amostra (Webhook Studio, F4);
 *   - `sombra` é o NOME do adaptador dinâmico em modo 'sombra' que bateria, quando
 *     nenhum adaptador de verdade (hardcoded ou dinâmico ativo) reconheceu o payload.
 *     Nunca altera `corpo`/`formato` — só sinaliza "isto teria sido reconhecido" para
 *     quem grava a amostra anotar (ver docs/15 e Plano-Melhorias-Painel.md, seção 7.1).
 *
 * `adaptadoresDoProjeto` é OPCIONAL: quando omitido, o comportamento é IDÊNTICO ao de
 * antes desta função ganhar o segundo parâmetro (I-4) — só os hardcoded rodam. Quem
 * chama passa a lista já carregada (com cache) por
 * `carregarAdaptadoresAtivos` (src/db/repos/webhooks.js); esta função nunca consulta o
 * banco sozinha, para não acoplar o módulo de adaptação a I/O.
 *
 * Ordem — e por que hardcoded sempre vence: um adaptador dinâmico é configurado pelo
 * painel (ou sugerido por IA na F5) com uma detecção que pode, por engano, ser ampla
 * demais. Se ele pudesse "vencer" um formato hardcoded já testado (como
 * `codigo-vencedor`), um mapeamento mal calibrado silenciosamente desviaria payloads
 * que já funcionavam. Por isso: 1) hardcoded, na ordem de ADAPTADORES; 2) dinâmicos do
 * projeto, na ordem estável devolvida por `carregarAdaptadoresAtivos` (por `id`
 * crescente — ordem de criação); primeiro que detectar vence em cada estágio.
 */
export function adaptarPayload(corpo, { adaptadoresDoProjeto } = {}) {
  for (const adaptador of ADAPTADORES) {
    if (adaptador.detectar(corpo)) {
      return { corpo: adaptador.adaptar(corpo), formato: adaptador.nome, sombra: null };
    }
  }

  let sombra = null;
  for (const dinamico of adaptadoresDoProjeto || []) {
    let bate = false;
    try {
      bate = detectarComMapeamento(corpo, dinamico.deteccao);
    } catch {
      bate = false; // detecção malformada nunca derruba o webhook — só não reconhece
    }
    if (!bate) continue;

    const emSombra = dinamico.modo === 'sombra';

    // Modo "IA por evento": aqui NÃO se traduz nada. A estruturação acontece no worker,
    // depois que o webhook já respondeu — chamar um modelo de terceiro dentro da ingestão
    // colocaria a latência (e a indisponibilidade) de uma API externa no caminho de uma
    // conversão. O que sai daqui é só a marca de que este payload precisa desse
    // tratamento; quem grava o evento monta o registro neutro. Ver o contrato no topo de
    // src/queue/dispatcher.js.
    if (dinamico.ativo && dinamico.modo === 'ia_por_evento') {
      return { corpo, formato: null, sombra: null, iaPorEvento: dinamico.nome };
    }

    if (dinamico.ativo && !emSombra) {
      try {
        const { evento } = aplicarMapeamento(corpo, dinamico.mapeamento);
        return { corpo: evento, formato: `dinamico:${dinamico.nome}`, sombra: null };
      } catch {
        continue; // mapeamento quebrado: tenta o próximo dinâmico em vez de derrubar o webhook
      }
    }

    // Sombra (ou dinâmico ainda desligado): não altera nada, só marca a primeira
    // detecção para o registro da amostra.
    if (emSombra && !sombra) sombra = dinamico.nome;
  }

  return { corpo, formato: null, sombra };
}

export const formatosSuportados = ADAPTADORES.map((a) => a.nome);
