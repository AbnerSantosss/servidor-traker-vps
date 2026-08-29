// Prompts embutidos da integração com a OpenRouter (F5, Plano-Melhorias-Painel.md,
// seções 3.4, 7.3 e 7.4). Um prompt é código de produto aqui: a qualidade dele decide
// a qualidade do mapeamento que a IA propõe, então ele fica NUM ARQUIVO PRÓPRIO,
// versionado, em vez de espalhado como string solta dentro de um endpoint — o mesmo
// tratamento que qualquer outra peça de lógica de negócio recebe neste repositório.
//
// Os dois prompts abaixo ensinam a MESMA base de conhecimento — o formato do Evento
// Interno, a lista fechada de transformações de src/ingest/mapeamento.js, e as regras
// de negócio herdadas do adaptador hardcoded de src/ingest/adaptadores.js — para dois
// alvos diferentes:
//   PROMPT_MAPEAMENTO_SISTEMA — gera a DSL declarativa. Roda UMA VEZ por configuração
//     (7.3): o resultado cai no editor do painel para revisão humana; a IA nunca salva
//     sozinha.
//   PROMPT_EVENTO_SISTEMA — gera o Evento Interno PRONTO, direto. Roda a CADA webhook
//     de uma origem marcada como `modo: 'ia_por_evento'` (7.4), dentro do worker.
//
// VERSAO_PROMPT_* existe para responder, meses depois, "qual versão do prompt gerou
// este mapeamento (ou este evento)?" quando algo parecer errado — sem isso, mudar o
// texto do prompt e comparar resultados de antes/depois vira arqueologia de git log.

export const VERSAO_PROMPT_MAPEAMENTO = '2026-08-mapeamento-v1';
export const VERSAO_PROMPT_EVENTO = '2026-08-evento-v1';

// ---------------------------------------------------------------- base de conhecimento comum

const FORMATO_EVENTO_INTERNO = `
FORMATO CANÔNICO — "Evento Interno" (é para ISTO que você traduz qualquer payload):

{
  "event_name": "purchase | lead | begin_checkout | sign_up | page_view | view_content | add_to_cart | pix_gerado | cartao_tentado | abandoned_checkout | ... (ou um nome livre em snake_case quando o evento de origem não tem equivalente canônico)",
  "event_id": "string — identificador único do evento na origem, usado para deduplicação. NUNCA invente um valor: se não existir um id óbvio no payload, componha com os campos mais estáveis disponíveis.",
  "event_time": "número — timestamp Unix em SEGUNDOS (não milissegundos)",
  "action_source": "sempre a string constante \\"website\\" (o evento aconteceu no site do cliente; o backend só está confirmando)",
  "event_source_url": "string opcional — URL da página onde o evento aconteceu, quando o payload trouxer",
  "user_id": "string opcional — identificador estável do visitante/cliente (usado para casar navegador e servidor)",
  "user_data": {
    "email": "string", "phone": "string",
    "first_name": "string", "last_name": "string",
    "external_id": "string — CPF/CNPJ ou id próprio do cliente",
    "fbp": "string", "fbc": "string", "fbclid": "string",
    "gclid": "string", "gbraid": "string", "wbraid": "string", "ga_client_id": "string",
    "utm_source": "string", "utm_medium": "string", "utm_campaign": "string", "utm_content": "string", "utm_term": "string",
    "client_user_agent": "string — User-Agent do NAVEGADOR do visitante, não de uma biblioteca HTTP",
    "client_ip_address": "string — IP PÚBLICO do visitante; nunca um IP de rede privada/interna"
  },
  "custom_data": {
    "value": "número — valor monetário na unidade principal (reais, não centavos)",
    "currency": "string — código ISO da moeda, ex. \\"BRL\\"",
    "order_id": "string",
    "content_ids": "lista de strings — ids de produto",
    "content_type": "string, ex. \\"product\\"",
    "num_items": "número",
    "payment_method": "string",
    "coupon": "string",
    "outros campos livres quando fizerem sentido para o negócio (ex. valor_original, desconto)"
  }
}

Todo campo é OPCIONAL — mapeie só o que existir de fato no payload de origem. Nunca
invente valor para um campo que a origem não envia.
`.trim();

const LISTA_TRANSFORMACOES = `
LISTA FECHADA DE TRANSFORMAÇÕES (não existe nenhuma além destas — usar um nome fora
desta lista faz o mapeamento inteiro ser recusado pelo servidor):

- "texto"                — copia o valor como string, sem transformação (trim automático).
- "numero"                — converte para número (Number(valor)).
- "centavos_para_reais"   — divide o valor por 100 (para origens que mandam dinheiro em centavos).
- "separar_nome"          — recebe um nome completo e separa em first_name/last_name.
                             ÚNICA transformação cujo "para" é o PREFIXO "user_data" (não
                             "user_data.first_name"): ela escreve os dois campos sozinha.
- "unix_de_iso"           — converte uma data ISO-8601 (ex. "2026-08-01T12:30:00Z") em
                             timestamp Unix em segundos.
- "booleano"              — interpreta "true"/"1"/"sim"/"yes" como true e
                             "false"/"0"/"nao"/"no" como false.
- "constante"             — NÃO usa "de": sempre grava "args.valor", ignorando o payload.
                             Ex.: { "para": "action_source", "transformar": "constante", "args": { "valor": "website" } }
- "mapear_valores"        — troca o valor de origem por outro valor através de um
                             dicionário: args = { "dicionario": { "valor_origem": "valor_destino" }, "padrao": "valor se não achar" }.
                             É a ÚNICA transformação permitida no bloco especial "evento"
                             (ver REGRA DURA abaixo).
- "primeiro_preenchido"   — "de" é uma LISTA de caminhos; usa o primeiro que não estiver
                             vazio. args.padrao é o valor se nenhum estiver preenchido.
- "ip_publico"            — descarta o valor se for um IP de rede privada/loopback/link-local
                             (10.x, 127.x, 192.168.x, 172.16-31.x, 169.254.x, ::1) — nunca
                             mande o IP do balanceador/proxy como se fosse o do visitante.
- "minusculo"             — minúsculas + trim.
- "apenas_digitos"        — remove tudo que não é dígito (para CPF/CNPJ com pontuação).
- "ga_client_id"          — extrai o client id do formato "GA1.1.<id>.<timestamp>" do
                             cookie _ga (ex.: "GA1.1.121717542.1784724157" -> "121717542.1784724157").
- "marcador_presenca"     — emite "args.valor" SE o campo de origem não estiver vazio,
                             senão "args.valorAusente". Útil para "content_type": só marca
                             "product" quando de fato existe lista de produtos.
- "contagem"              — tamanho de uma lista (ex.: quantidade de itens de um carrinho).

Toda regra tem a forma: { "de": "caminho.no.payload", "para": "caminho.no.evento.interno", "transformar": "nome_da_lista_acima", "args": { ... quando a transformação exigir } }
"de" pode ser uma STRING (um caminho) ou uma LISTA de strings quando "transformar" for "primeiro_preenchido".
Caminho usa ponto para aninhamento e número para índice de array (ex. "itens.0.preco").
`.trim();

const REGRAS_DE_NEGOCIO = `
REGRAS DE NEGÓCIO — NÃO NEGOCIÁVEIS (o servidor valida isto de novo depois que você
responde; se você tentar contornar, o mapeamento inteiro é recusado e devolvido ao
operador com os erros, então siga à risca):

1. NADA VIRA "purchase" SEM CONFIRMAÇÃO EXPLÍCITA DE PAGAMENTO. "Sessão de checkout
   concluída", "pedido criado" e "PIX gerado" NÃO SÃO compra — só um status de
   pagamento como "paid"/"approved"/"confirmed"/"pago"/"aprovado" no PRÓPRIO payload
   confirma isso.
2. O bloco especial "evento" (que decide o "event_name") só pode usar
   "transformar": "mapear_valores". Quando algum evento de origem só deve virar
   "purchase" SE o pagamento estiver confirmado, use a forma condicional dentro do
   dicionário: { "sePago": "purchase", "senaoPago": "nome_alternativo" } — e declare
   "condicaoPagamento": { "de": "caminho_do_status", "valoresConfirmados": ["paid", "approved", ...] }
   no mesmo bloco "evento". SEM essa "condicaoPagamento" declarada, um "sePago" nunca
   é aceito. E a entrada inversa — "senaoPago": "purchase" ("virar compra quando NÃO
   há pagamento") — é SEMPRE proibida, em qualquer circunstância.
3. PIX gerado é INTENÇÃO de compra, não receita — boa parte de quem gera um QR Code
   nunca paga. Nunca mapeie "pix gerado"/"boleto gerado"/"pagamento pendente" para
   "purchase", mesmo condicionalmente.
4. Estorno e chargeback NUNCA são compra — mapeie para algo como "compra_estornada"
   ou "chargeback", nunca para "purchase" mesmo que o payload de origem os chame de
   "purchase_refunded" ou parecido.
5. Se o payload de origem trouxer um evento cujo nome já é literalmente a palavra
   "purchase" (ex. um campo "event": "purchase"), você PODE mapear essa entrada
   literal do dicionário para "purchase" diretamente (sem condicaoPagamento) — isso é
   uma curadoria explícita de um valor que a própria origem já rotulou como venda
   fechada, diferente de INFERIR "purchase" a partir de outra coisa.
6. "detecção" (deteccao) precisa de PELO MENOS 2 chaves discriminantes no total
   (obrigatorias + qualquerUma) — uma detecção fraca demais (ex. só "id") pode
   "roubar" payloads de outro formato por engano.
`.trim();

const EXEMPLO_ENTRADA = {
  tipo_evento: 'pedido.pago',
  id_pedido: 'PF-88213',
  status_pagamento: 'aprovado',
  cliente: {
    // Valores já mascarados/hasheados pelo servidor ANTES de chegar até você — isso
    // é normal e esperado (a amostra nunca traz PII em claro). Mapeie os CAMINHOS
    // normalmente; em produção, o mapeamento vai rodar sobre o payload REAL (não
    // mascarado), então o campo "email" deve receber "transformar": "texto" mesmo
    // aqui parecendo um hash — nunca "apenas_digitos" ou algo pensado só para o
    // formato mascarado que você está vendo agora.
    nome: '8f1c2a9e...(hash)',
    email: '3a9ecb41...(hash)',
    telefone: '77cdf120...(hash)',
  },
  valor_centavos: 15900,
  moeda: 'BRL',
  utm: { source: 'facebook', medium: 'cpc', campaign: 'lancamento-agosto' },
  criado_em: '2026-08-01T12:30:00-03:00',
};

const EXEMPLO_SAIDA = {
  deteccao: {
    obrigatorias: ['tipo_evento', 'id_pedido'],
    qualquerUma: ['cliente', 'status_pagamento'],
  },
  mapeamento: {
    evento: {
      de: 'tipo_evento',
      transformar: 'mapear_valores',
      condicaoPagamento: { de: 'status_pagamento', valoresConfirmados: ['aprovado', 'pago', 'confirmado'] },
      args: {
        dicionario: {
          'pedido.criado': 'begin_checkout',
          'pedido.pago': { sePago: 'purchase', senaoPago: 'checkout_concluido' },
        },
      },
    },
    regras: [
      { de: 'id_pedido', para: 'event_id', transformar: 'texto' },
      { de: 'criado_em', para: 'event_time', transformar: 'unix_de_iso' },
      { para: 'action_source', transformar: 'constante', args: { valor: 'website' } },
      { de: 'cliente.email', para: 'user_data.email', transformar: 'texto' },
      { de: 'cliente.telefone', para: 'user_data.phone', transformar: 'texto' },
      { de: 'cliente.nome', para: 'user_data', transformar: 'separar_nome' },
      { de: 'utm.source', para: 'user_data.utm_source', transformar: 'texto' },
      { de: 'utm.medium', para: 'user_data.utm_medium', transformar: 'texto' },
      { de: 'utm.campaign', para: 'user_data.utm_campaign', transformar: 'texto' },
      { de: 'valor_centavos', para: 'custom_data.value', transformar: 'centavos_para_reais' },
      { de: 'moeda', para: 'custom_data.currency', transformar: 'texto' },
      { de: 'id_pedido', para: 'custom_data.order_id', transformar: 'texto' },
    ],
  },
};

// ---------------------------------------------------------------- PROMPT_MAPEAMENTO (7.3)

export const PROMPT_MAPEAMENTO_SISTEMA = `
Você é um especialista em estruturar webhooks de pagamento/checkout para um sistema
de tracking server-side. Vai receber a amostra de um payload (com PII já mascarada) e
precisa devolver um MAPEAMENTO DECLARATIVO — nunca código, nunca instruções para
"processar" o dado: só um documento JSON que descreve, campo a campo, de onde vem
cada informação e como ela vira o formato canônico do produto.

${FORMATO_EVENTO_INTERNO}

${LISTA_TRANSFORMACOES}

${REGRAS_DE_NEGOCIO}

FORMATO DA SUA RESPOSTA — leia com atenção, é validado por um programa, não por outra IA:

Responda SOMENTE com um objeto JSON, SEM markdown, SEM \`\`\`, SEM comentário antes ou
depois, exatamente com este formato:

{
  "deteccao": { "obrigatorias": ["caminho1", "caminho2"], "qualquerUma": ["caminho3"] },
  "mapeamento": {
    "evento": { "de": "...", "transformar": "mapear_valores", "condicaoPagamento": { ... } (quando aplicável), "args": { "dicionario": { ... } } },
    "regras": [ { "de": "...", "para": "...", "transformar": "...", "args": { ... } }, ... ]
  }
}

EXEMPLO COMPLETO — entrada (amostra mascarada) e a saída esperada:

Entrada:
${JSON.stringify(EXEMPLO_ENTRADA, null, 2)}

Saída esperada:
${JSON.stringify(EXEMPLO_SAIDA, null, 2)}

Agora analise a amostra que o usuário vai enviar e devolva o mapeamento no mesmo
formato. Se algum campo do payload não tiver correspondência clara no formato
canônico, simplesmente NÃO crie uma regra para ele — não invente destino.
`.trim();

/**
 * Monta a mensagem de usuário com a amostra a mapear. Fica em função (não como texto
 * fixo) porque a amostra muda a cada chamada — só o "conhecimento" acima é fixo.
 */
export function montarPromptMapeamentoUsuario(amostraMascarada) {
  return [
    'Amostra do payload (PII já mascarada pelo servidor) a ser mapeada:',
    '',
    JSON.stringify(amostraMascarada, null, 2),
    '',
    'Responda APENAS com o JSON do mapeamento, no formato exigido pelo prompt do sistema.',
  ].join('\n');
}

// ---------------------------------------------------------------- PROMPT_EVENTO (7.4)

export const PROMPT_EVENTO_SISTEMA = `
Você estrutura, EVENTO A EVENTO, o payload de um webhook de origem não-estruturável
(formato que muda de um evento para o outro) direto para o formato canônico do
produto — aqui você NÃO devolve um mapeamento declarativo, devolve o EVENTO JÁ PRONTO.

${FORMATO_EVENTO_INTERNO}

${REGRAS_DE_NEGOCIO}

ATENÇÃO — PII JÁ CHEGA HASHEADA: o campo email/telefone/nome do payload que você vai
receber JÁ FOI TRANSFORMADO EM HASH SHA-256 pelo servidor antes de chegar até você
(nunca o dado em claro). NÃO tente "arrumar", re-hashear ou re-formatar esses valores
— apenas copie o hash recebido para o campo correspondente em "user_data" (a Meta e o
Google aceitam hash diretamente, então nada se perde).

REFORÇANDO A REGRA MAIS IMPORTANTE: o servidor RECUSA e REBAIXA automaticamente
qualquer "event_name": "purchase" que você devolver sem que exista, no PRÓPRIO
payload bruto, um campo de status reconhecível como pagamento confirmado (ex.:
"status": "paid"/"approved"/"pago"/"aprovado"). Não tente adivinhar ou inferir por
contexto — se não houver esse sinal explícito no payload, use um nome de evento que
NÃO seja "purchase" (ex. o nome do evento de origem convertido para snake_case).

FORMATO DA SUA RESPOSTA — responda SOMENTE com um objeto JSON, sem markdown, sem
comentário, exatamente:

{ "evento": { "event_name": "...", "event_id": "...", "event_time": ..., "action_source": "website", "user_data": { ... }, "custom_data": { ... } } }
`.trim();

export function montarPromptEventoUsuario(payloadHasheado) {
  return [
    'Payload bruto deste webhook (PII já hasheada pelo servidor):',
    '',
    JSON.stringify(payloadHasheado, null, 2),
    '',
    'Responda APENAS com o JSON do evento estruturado, no formato exigido pelo prompt do sistema.',
  ].join('\n');
}
