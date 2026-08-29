# Catálogo de eventos do xWinner e o contrato com o n8n

Fonte: aba **Integrações → Webhooks** do backoffice (`admin.codigovencedor.com/backoffice/integracoes`),
seção *Catálogo de eventos (24)*, capturada em 16/08/2026.

Este documento responde três coisas: **quais eventos existem**, **em que formato eles
chegam** e **o que o n8n deve fazer** com eles.

---

## 1. O formato

O backoffice dispara um envelope próprio, em snake_case, com todo o conteúdo dentro de `data`:

```json
{
  "event": "purchase_approved",
  "event_id": "evt_...",
  "version": "1.0",
  "created_at": "2026-08-16T03:21:49+00:00",
  "data": { "…": "…" }
}
```

Não confundir com o formato da **Checkout Platform** (`eventId` camelCase, campos planos),
tratado pelo adaptador `codigo-vencedor`. São dois contratos diferentes e os dois convivem:
o backoffice reempacota os eventos da Checkout Platform e acrescenta os dele.

Quem traduz é `src/ingest/adaptadores.js` → adaptador **`xwinner`**. A detecção olha só o
envelope (`event` + `event_id` + `data` objeto) — de propósito: exigir `lead` ou
`attribution` deixaria de fora oito dos dezoito eventos que disparam.

### Regras que quebram silenciosamente se erradas

| Regra | Por quê |
|---|---|
| **`data.amount` é centavos** | `1990` = R$ 19,90. Sem dividir, a Meta recebe R$ 1.990,00 — erro de 100x. Confere com a aritmética do próprio catálogo: `original_amount` 2490 − `discount` 500 = `amount` 1990. |
| **`cookies.gcl_au` NÃO é gclid** | `_gcl_au` é o cookie de mensuração do Google (`1.1.<aleatório>.<timestamp>`). Quem carrega o clique é o `_gcl_aw`. Mandar `gcl_au` como gclid faz o Google aceitar a conversão e não casar com clique nenhum. |
| **Carimbo do fato, não do envelope** | Cada evento traz o seu (`approved_at`, `generated_at`, `opened_at`…). `created_at` é fallback — `subscription_cancelled` é o único evento sem carimbo próprio. |
| **`data.status` não vai para o `status` da Meta** | `status` é parâmetro padrão da Meta (usado em Lead). O status do pedido vai como `situacao`. |
| **IP de rede privada é descartado** | Um IP do cluster mandado para a Meta é pior que nenhum: todos os compradores viram o mesmo "visitante". |

### Ponte de identidade

`user_id` = `data.buyer.external_id` ou `data.user.external_id` (decisão do cliente).

É por essa chave que o servidor recupera o `fbclid`/`gclid` que o navegador capturou e o
backend não conhece. **O site precisa empurrar esse mesmo valor para o dataLayer**, para o
coletor `/c/<slug>` gravar a identidade sob a mesma chave. Sem isso, a ponte não fecha nos
oito eventos que não trazem `attribution`.

---

## 2. Os 24 eventos

18 disparam; 6 foram removidos (programa de afiliados/saques, ADR-R07).

| Evento | Canônico | Meta | GA4 |
|---|---|---|---|
| `user_registered` | `sign_up` | **CompleteRegistration** | sign_up |
| `onboarding_completed` | `onboarding_concluido` | — | — |
| `precheckout_opened` | `lead` | **Lead** | generate_lead |
| `precheckout_expired` | `precheckout_expirado` | — | — |
| `checkout_session_opened` | `begin_checkout` | **InitiateCheckout** | begin_checkout |
| `payment_generated` | `pix_gerado` | **AddPaymentInfo** | add_payment_info |
| `checkout_card_attempted` | `cartao_tentado` | **AddPaymentInfo** | add_payment_info |
| `checkout_abandoned` | `abandoned_checkout` | — ¹ | abandoned_checkout |
| `checkout_lead_abandoned` | `lead_abandonado` | — | — |
| `purchase_approved` | `purchase` | **Purchase** | purchase |
| `purchase_refunded` | `compra_estornada` | — | — |
| `chargeback_opened` | `chargeback` | — | — |
| `subscription_started` | `assinatura_iniciada` | **Subscribe** | purchase |
| `subscription_renewed` | `assinatura_renovada` | — ² | — |
| `subscription_cancelled` | `assinatura_cancelada` | — | — |
| `subscription_expired` | `assinatura_expirada` | — | — |
| `ebook_completed` | `ebook_concluido` | — | — |
| `tool_used` | `ferramenta_usada` | — | — |
| `affiliate_registered`, `affiliate_approved`, `commission_released`, `commission_reversed`, `withdrawal_requested`, `withdrawal_paid` | — | **Removidos** — não disparam | |

¹ "AbandonedCheckout" não existe entre os eventos padrão da Meta. Mapear criaria um evento
personalizado com cara de padrão, que não entra nas otimizações nem nos relatórios
agregados. Para usá-lo, criar uma Conversão Personalizada no Events Manager.

² Decisão do cliente: renovação de assinatura **não** vai para a Meta.

`page_view` e `view_content` não estão aqui — vêm do navegador, pela tag, não do backoffice.

### Pré-checkout e checkout são etapas diferentes

Decisão do cliente, e ela tem consequência no código: `precheckout_expired` e
`checkout_lead_abandoned` **não** colapsam no mesmo nome canônico. Os dois descrevem
abandono, mas em momentos distintos do funil, e a idempotência por `event_id` não os
uniria — seriam dois eventos contados como um.

---

## 3. O contrato com o n8n

### Por que o n8n não monta o payload da Meta

Foi pedido que o n8n montasse o payload final. **Não deve** — três motivos concretos:

1. **O n8n não tem a ponte de identidade.** Oito dos dezoito eventos não trazem
   `attribution`: as quatro assinaturas, estorno, chargeback, e-book e ferramenta. Para
   esses, o `fbc`/`gclid` só existe na tabela `identities`, que o coletor gravou no
   navegador. Payload montado fora do servidor sai sem click ID nesses casos.
2. **A dedup com o Pixel depende do servidor.** A Meta só funde o evento do navegador com
   o do servidor se o `event_id` for idêntico. Duas fontes de verdade para essa chave é
   como se perde a deduplicação sem nenhum erro aparecer.
3. **A decisão da F5 já valeu para isso.** IA gera o mapeamento, não processa cada evento:
   determinismo, custo, latência e LGPD. Um LLM no caminho quente de uma conversão é risco
   de latência e de indisponibilidade — e pode inventar um `purchase`.

### O que o n8n deve enviar

```
POST https://<host>/e/<slug>
Content-Type: application/json
Authorization: Bearer <token-de-ingestao>
```

Corpo: **o envelope, sem traduzir**.

```json
{
  "event": "purchase_approved",
  "event_id": "<id estável da origem>",
  "version": "1.0",
  "created_at": "<ISO 8601>",
  "data": { "…": "o que a origem tiver, preservando lead e attribution" }
}
```

Regras:

- **Um evento por POST.** Lote quebra a idempotência por `event_id`.
- **`event_id` estável, vindo da origem.** É a chave de deduplicação: retry do n8n ou do
  backoffice não pode gerar evento novo.
- **Preservar `lead`, `attribution`, `buyer`/`user` como objetos**, com os nomes originais.
  O adaptador lê `attribution.user_agent`, `attribution.ip`, `attribution.cookies.*`.
- **Não converter valores.** `amount` continua em centavos; a divisão é do servidor.
- **Evento fora do catálogo:** escolher um nome em snake_case e pôr o resto em `data`. O
  servidor transforma nome desconhecido em canônico legível (`promo.spin.completed` →
  `promo_spin_completed`), grava e mostra no painel. Nada é descartado em silêncio.

### Eventos fora do catálogo: onde mapear

No **Webhook Studio** do painel (aba Meta → Webhooks), não no n8n. Ele recebe a amostra do
payload desconhecido, a IA propõe o mapeamento declarativo, o operador aprova — e a partir
daí o runtime é código, não modelo. Mesmo poder, num lugar versionado e testável.

---

## 4. Endpoints configurados hoje no backoffice

Estado em 16/08/2026, lido do próprio backoffice:

| Endpoint | Eventos | Entregas |
|---|---|---|
| `n8n.proxserverabner.site/webhook/codigo-vencedor` | 16 | 1.070 |
| `eventoscodigovencedor.proxserverabner.site/api/webhook/auto-ha50mq` | 16 | 858 |
| `b24-xenall.bitrix24.com.br/rest/43/…/crm.lead.add.json` | 2 | 117 |
| `tkr.codigovencedor.com/cvd?event=purchase` | 1 | 35 |
| `tkr.codigovencedor.com/cvd?event=begin_checkout` | 1 | 19 |
| `tkr.codigovencedor.com/cvd?event=pre_checkout_opened` | 1 | 13 |
| `n8n.proxserverabner.site/webhook/ffe7e75a-48c6-4ca8-9183-558cad96551b` | 1 (compra aprovada) | 14 |
| `b24-xenall.bitrix24.com.br/rest/55/…/crm.lead.add.json` | 1 | 12 |
| `tkr.codigovencedor.com/cvd?event=checkout_abandoned` | 1 | 4 |
| `tkr.codigovencedor.com/cvd?event=checkout.pix.generated` | 1 | 4 |
| `tkr.codigovencedor.com/cvd?event=pre_checkout_abandoned` | 1 | 0 |

Dois pontos que saltam disso:

- **`tkr.codigovencedor.com` é a Stape**, não este servidor (ver `wiki/log.md`, 13/08 —
  ela segue intocada para permitir comparação em paralelo). **Nenhum endpoint aponta para o
  Servidor Traker hoje.**
- **`precheckout_opened` não está assinado no endpoint do n8n.** Ele só vai para a Stape.
  Como é o evento que vira `Lead` na Meta, precisa ser marcado no endpoint do n8n para
  chegar até aqui.
