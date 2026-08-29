---
title: Referência da API HTTP do Servidor Traker
tags: [api, referencia, endpoints, ingestao, painel, curl, servidor-traker]
created: 2026-08-12
updated: 2026-08-25
---

# Referência da API HTTP do Servidor Traker

Referência literal de **todos** os endpoints, extraída do código
(`src/server.js`, `src/ingest/*.js`, `src/admin/*.js`). Os exemplos de corpo são os
formatos reais produzidos e aceitos pela implementação.

Nos exemplos, a base pública é `https://traker.codigovencedor.com`, o projeto é
`prj_a3f19c82b410` e o slug de ingestão é `k7m2vqbz`.

---

## 0. Convenções

### Formato de erro

Toda resposta de erro em JSON tem exatamente esta forma:

```json
{ "error": "mensagem em português" }
```

Duas exceções, que respondem **texto puro**: `GET /api/caddy/ask` (o consumidor é o Caddy) e
as rotas de script `GET /s/`, `GET /t/`, `GET /g/` e `GET /w/` (respondem
`/* projeto não encontrado */` com `Content-Type: application/javascript`).

O tratador de erro final de `server.js` responde `{ "error": "erro interno" }` e **nunca**
vaza stack trace. As rotas do painel usam o helper `wrap()`, que segue a mesma regra: erro
esperado (status `4xx`, lançado com `statusCode`) leva a mensagem em português ao operador;
erro interno (`5xx`) responde sempre `{ "error": "erro interno" }`, e o detalhe do driver do
banco e o stack ficam apenas no log.

### Autenticação

| Escopo | Mecanismo |
|---|---|
| Ingestão do navegador (`POST /e/`, `/c/`) | **Nenhuma.** Slug secreto + rate limit + projeto ativo |
| Webhook server-to-server (`POST /e/`) | `Authorization: Bearer <ingestToken do projeto>` |
| Painel (`/api/...`) | Cookie de sessão `traker_sess` (`HttpOnly`, `SameSite=Lax`, `Secure` em HTTPS) |
| `GET /api/caddy/ask` | **Nenhuma** — chamado pelo Caddy pela rede interna |
| `/health`, `/health/fila` | **Nenhuma** |

### Contrato de segredos (rotas `PUT /api/projects/:id/{meta,google,postback}`)

Vale para `accessToken`, `apiSecret`, `clientSecret`, `refreshToken`, `developerToken` e
`bearerToken`:

| No corpo da requisição | Efeito |
|---|---|
| **chave ausente** | mantém o valor cifrado atual (é assim que o painel salva sem retransmitir o segredo) |
| **chave presente com `""` ou `null`** | **apaga** a credencial |
| **chave presente com valor** | `trim` + recifra com AES-256-GCM |

Campos de `config` (não-secretos) são aplicados por **merge raso**: só o que vem no corpo é
alterado; o resto permanece. Segredos **nunca** voltam nas respostas — o painel recebe apenas
as flags `hasAccessToken`, `hasApiSecret`, `hasClientSecret`, `hasRefreshToken`,
`hasDeveloperToken`, `hasBearerToken`.

---

## 1. Ingestão de eventos

### `POST /e/:slug`

Recebe um evento. É o caminho quente do sistema. Responde `202` assim que o evento está
durável no banco — o envio aos destinos é assíncrono.

| | |
|---|---|
| **Autenticação** | Opcional. Sem `Authorization` ⇒ `source = "web"`. Com `Authorization: Bearer <ingestToken>` válido ⇒ `source = "webhook"` e `action_source = "system_generated"` |
| **Parâmetro de rota** | `slug` — `projects.slug` |
| **Content-Type** | `application/json` **ou** `text/plain` / `text/*` (o `sendBeacon` usa `text/plain` para evitar preflight CORS). Corpo em texto é parseado como JSON; se falhar vira `{}` |
| **Limite de corpo** | 256 kB |
| **Rate limit** | `RATE_LIMIT_PER_MINUTE` por projeto (padrão 6000/min) |
| **Alias legado** | `POST /ingest/:projectId` — idêntico, resolvendo por `projects.id` |
| **Rota por hostname** | `POST /` — resolve o projeto pelo `Host` da requisição (`project_domains`), para plataformas cujo campo de webhook só aceita um domínio, sem caminho. Só responde quando o hostname está cadastrado num projeto (seção 6); caso contrário cai no `404` genérico de rota não encontrada |
| **Preflight** | `OPTIONS /e/:slug` e `OPTIONS /ingest/:projectId` → `204` com os headers de CORS |

**Validação de borda (`validarPayload`).** O corpo é deliberadamente aberto, mas quatro
regras são aplicadas antes de qualquer processamento, e cada violação responde `400` com o
motivo:

| Regra | Mensagem |
|---|---|
| corpo precisa ser um objeto JSON (não array, não string solta) | `corpo deve ser um objeto JSON` |
| `event_name` (ou `event`) obrigatório e não-vazio | `event_name é obrigatório` |
| `event_name` precisa ser texto ou número | `event_name deve ser texto` |
| `event_name` até 100 caracteres | `event_name muito longo (máximo 100 caracteres)` |
| `event_id` até 200 caracteres | `event_id muito longo (máximo 200 caracteres)` |
| `user_data`, se presente, precisa ser objeto | `user_data deve ser um objeto` |
| `custom_data`, se presente, precisa ser objeto | `custom_data deve ser um objeto` |

`custom_data` continua sem schema: cada site manda os próprios campos.

**Corpo (fora as regras acima, todos os campos são opcionais):**

```json
{
  "event_name": "purchase",
  "event_id": "purchase-8812",
  "event_time": 1786000923,
  "page_location": "https://codigovencedor.com/obrigado",
  "page_path": "/obrigado",
  "page_title": "Pedido confirmado",
  "page_referrer": "https://codigovencedor.com/checkout",
  "user_id": "42",
  "user_data": {
    "email": "cliente@exemplo.com",
    "phone": "(11) 98888-7777",
    "first_name": "Maria",
    "last_name": "Silva",
    "city": "sao paulo",
    "state": "sp",
    "zip": "01310-100",
    "country": "br",
    "external_id": "42",
    "fbp": "fb.1.1785900000000.1029384756",
    "fbc": "fb.1.1785900000000.IwAR0abcdef",
    "fbclid": "IwAR0abcdef",
    "gclid": "Cj0KCQjw...",
    "ga_client_id": "1029384756.1785900000",
    "utm_source": "meta",
    "utm_medium": "cpc",
    "utm_campaign": "black-friday"
  },
  "custom_data": {
    "value": 199.9,
    "currency": "BRL",
    "order_id": 8812,
    "content_ids": ["curso-01"],
    "content_type": "product"
  },
  "consent_state": {
    "ad_storage": "granted",
    "analytics_storage": "granted",
    "ad_user_data": "granted",
    "ad_personalization": "granted"
  }
}
```

Aliases aceitos na entrada: `event` no lugar de `event_name`; `eventID`/`eventId` no lugar de
`event_id`; `em`/`ph`/`fn`/`ln`/`ct`/`st`/`zp` dentro de `user_data`; `event_source_url` ou
`url` no lugar de `page_location`; `consent` no lugar de `consent_state`; e `email`, `phone`,
`fbp`, `fbc`, `gclid`, `utm_*` diretamente na raiz do corpo. `consent_state` aceita
`true`/`false` além de `"granted"`/`"denied"`.

**Campos de `user_data` além do exemplo acima** (todos opcionais, repassados como
vieram — nunca hasheados, igual a `fbp`/`fbc`/`fbclid`/`gclid`):

| Campo | Origem/uso |
|---|---|
| `gbraid`, `wbraid` | cliques de campanhas app-to-app/rede de pesquisa do Google Ads |
| `ttclid`, `ttp` | TikTok Ads |
| `clickid`, `tblci` | Taboola |
| `msclkid` | Microsoft/Bing Ads |
| `twclid` | X (Twitter) Ads |
| `li_fat_id` | LinkedIn |
| `epik` | Pinterest |
| `sccid`, `_scid` | Snapchat (parâmetro de clique e cookie de pixel) |
| `rdt_cid` | Reddit |
| `irclickid` | Impact (afiliados) |
| `obclid` | Outbrain |
| `kwai_click_id` | Kwai |

Nenhum desses é mapeado para Meta ou Google (que só reconhecem os campos padrão deles);
quem os consome de fato é o destino postback, via `{{campo}}` na URL/headers (seção 5).

`user_data.click_ids` — camada **aberta** (ao contrário da lista fechada acima): um
objeto `{ chave: valor }` para identificadores de clique que o servidor ainda não conhece
nominalmente. Sanitizado por `sanitizeClickIds` (`src/db/repos/identities.js`) antes de
persistir: chave precisa bater `^[a-z0-9_]{1,40}$` (minúsculo), no máximo 20 chaves por
evento, cada valor truncado em 256 caracteres, e o objeto inteiro tem teto de 4096 bytes —
o que exceder qualquer um desses limites é **descartado em silêncio**, nunca rejeitado com
erro. A chave só aparece em `user_data` quando há pelo menos um identificador capturado
(objeto vazio não é incluído).

Se `event_id` não vier, é derivado de `custom_data.order_id`/`transaction_id`
(`purchase-8812`) ou, na falta dele, de um UUID aleatório.

Quando o corpo não traz `gclid` nem `ga_client_id`, o servidor os extrai dos cookies da
própria requisição — desembrulhando `_gcl_aw` (`GCL.<ts>.<gclid>`) e `_ga`
(`GA1.1.<client_id>`), nunca copiando o valor bruto.

**Resposta `202` — evento novo:**

```json
{
  "status": "accepted",
  "id": "8a4f1e2c-91b7-4d0a-b3e6-2f5c1d7a9e40",
  "event_id": "purchase-8812",
  "event_name": "purchase",
  "destinations": ["meta", "google"]
}
```

`id` é a PK em `events` (usada no requeue). `destinations` lista apenas os destinos
**habilitados** no momento — se nenhum estiver ligado, vem `[]` e o evento fica só no log.
Quando o corpo recebido não estava no formato canônico e foi traduzido por um adaptador
(o hardcoded `codigo-vencedor` ou um adaptador dinâmico do Webhook Studio, seção 8), a
resposta ganha também `"formato": "codigo-vencedor"` ou `"formato": "dinamico:<nome>"` —
ausente quando o corpo já veio canônico.

**Resposta `202` — duplicata (mesmo `project_id` + `event_id` + `event_name`):**

```json
{ "status": "duplicate", "id": "8a4f1e2c-91b7-4d0a-b3e6-2f5c1d7a9e40", "event_id": "purchase-8812" }
```

Nada é criado e nenhuma entrega é reenfileirada.

**Enriquecimento pela ponte de identidade.** Quando o corpo traz `user_id` e existe uma
identidade gravada para ele, os campos vazios de `user_data` são preenchidos com o que foi
capturado no navegador. **No modo webhook** (`Authorization: Bearer` válido), além disso,
`client_ip_address` e `client_user_agent` são **sobrescritos** pelos valores da ponte — os
da requisição seriam o IP do servidor do cliente e um User-Agent como `axios/1.7`.

**Consentimento.** `applyConsent` roda antes de persistir: com
`consent_state.ad_user_data = "denied"` (ou ausente, se `STRICT_CONSENT=true`), os campos de
PII são removidos e não chegam ao banco nem a nenhum destino. Com
`ad_storage` **e** `analytics_storage` ambos `"denied"`, o evento é gravado mas todas as
entregas ficam `skipped_consent`.

**Efeitos colaterais da resposta:** cabeçalhos `Set-Cookie` renovando `_fbp` e `_fbc` por 90
dias (`COOKIE_MAX_AGE_DAYS`), quando `SET_FIRST_PARTY_COOKIES=true` e houver valor a
regravar; e cabeçalhos de CORS quando a requisição trouxer `Origin`.

**Códigos de status**

| Código | Quando | Corpo |
|---|---|---|
| `202` | aceito ou duplicata | acima |
| `400` | payload reprovado por `validarPayload` | `{"error":"event_name é obrigatório"}` (ou a mensagem da regra violada) |
| `401` | `Authorization: Bearer` presente mas o token não bate com `ingestToken` | `{"error":"token de ingestão inválido"}` |
| `403` | o projeto tem `allowed_origins` preenchida e o header `Origin` da requisição não está nela | `{"error":"origem não autorizada para este projeto"}` |
| `404` | slug/id inexistente **ou** projeto com `status = "paused"` | `{"error":"projeto não encontrado ou inativo"}` |
| `429` | rate limit do projeto estourado | `{"error":"limite de requisições excedido"}` |
| `500` | falha ao gravar no banco | `{"error":"falha ao registrar evento"}` |

Ordem de avaliação: projeto → token → rate limit → `Origin` → validação do corpo. Requisição
sem header `Origin` (webhook, `curl`) nunca é barrada pela regra de origem.

---

### `POST /c/:slug` — coleta de identidade

Grava a associação `user_id → identificadores de marketing`. **Não envia conversão nenhuma.**

| | |
|---|---|
| **Autenticação** | Nenhuma |
| **Content-Type** | `application/json` ou `text/plain` / `text/*` |
| **Limite de corpo** | 64 kB |
| **Rate limit** | mesmo limite, chave `collect:<project_id>` |
| **Alias legado** | `POST /collect/:projectId` |
| **Preflight** | `OPTIONS /c/:slug`, `OPTIONS /collect/:projectId` → `204` |

**Corpo:**

```json
{
  "user_id": "42",
  "fbclid": "IwAR0abcdef",
  "fbp": "fb.1.1785900000000.1029384756",
  "fbc": "fb.1.1785900000000.IwAR0abcdef",
  "gclid": "Cj0KCQjw...",
  "ttclid": "",
  "utm_source": "meta",
  "utm_medium": "cpc",
  "utm_campaign": "black-friday",
  "landing_page": "https://codigovencedor.com/?fbclid=IwAR0abcdef"
}
```

A chave do usuário é `user_id`, `userId` **ou** `external_id`. Só as chaves de
`MARKETING_KEYS` são persistidas: `fbc`, `fbp`, `fbclid`, `gclid`, `gbraid`, `wbraid`,
`ttclid`, `ttp`, `clickid`, `tblci`, `utm_source`, `utm_medium`, `utm_campaign`,
`utm_content`, `utm_term`, `client_ip_address`, `client_user_agent`, `landing_page`,
`referrer`. Qualquer outro campo é ignorado.

O servidor sempre acrescenta `client_ip_address` e `client_user_agent` a partir da própria
requisição, e completa `fbp`/`fbc` com os cookies `_fbp`/`_fbc` do header `Cookie` quando o
corpo não os trouxer. O merge no banco **nunca sobrescreve um valor existente por vazio**.

**Respostas `202`:**

```json
{ "status": "stored" }
```

```json
{ "status": "ignored", "reason": "sem user_id" }
```

O segundo caso **não é erro**: o coletor roda em toda página, inclusive antes do login. Os
cookies first-party são renovados mesmo assim.

| Código | Quando | Corpo |
|---|---|---|
| `202` | gravado ou ignorado por falta de `user_id` | acima |
| `404` | slug inexistente ou projeto pausado | `{"error":"projeto não encontrado"}` |
| `429` | rate limit | `{"error":"limite de requisições excedido"}` |
| `500` | falha ao gravar | `{"error":"falha ao gravar identidade"}` |

---

## 2. Scripts client-side

Servidos pelo domínio first-party do próprio cliente, para não haver domínio de terceiro em
blocklist.

### `GET /s/:slug.js` — coletor de identidade

| | |
|---|---|
| **Autenticação** | Nenhuma |
| **Alias legado** | `GET /collector/:projectId.js` |
| **Content-Type** | `application/javascript; charset=utf-8` |
| **Cache** | `Cache-Control: public, max-age=300` |

Devolve um IIFE que: captura `fbclid`/`gclid`/`gbraid`/`wbraid`/`ttclid`/`clickid`/`tblci` da
query string e `_fbp`/`_fbc`/`_ttp` dos cookies; persiste tudo em `localStorage` nas chaves
`tk_*` (captura sticky); recupera o `fbclid` de dentro do `_fbc` quando ele sumiu da URL;
procura o `user_id` no `dataLayer` (chaves aceitas: `user_id`, `userId`, `user_id_cp`,
`player_id`, `playerId`, `jogador_codigo`, `jogador_id`, `codigo`, `customer_id`,
`cliente_id`); e faz `POST` para `/c/<slug>` via `sendBeacon`, com `fetch keepalive` de
fallback. Envia **uma vez por sessão por usuário** (guard `sessionStorage['tk_sent_'+uid]`) e
não envia nada se não houver `user_id` ou se nenhum identificador tiver sido capturado.

O endpoint embutido no script é montado a partir do **`Host` da requisição**
(`x-forwarded-proto` + `req.get('host')`), não do `PUBLIC_HOST` — ou seja, o script servido
pelo domínio do cliente aponta para o domínio do cliente.

Instalação: em instalação nova no GTM, use `/g/` (abaixo), que já embute este coletor. A
rota `/s/` continua servida sozinha para as instalações antigas em duas tags, e é o que
`/g/` concatena — não há segunda implementação.

### `GET /t/:slug.js` — tag de captura de eventos

| | |
|---|---|
| **Autenticação** | Nenhuma |
| **Alias legado** | `GET /snippet/:projectId.js` |
| **Content-Type** | `application/javascript; charset=utf-8` |
| **Cache** | `Cache-Control: public, max-age=300` |

Define `window.trk(nome, opts)`, que monta o payload e envia para `/e/<slug>`, devolvendo o
`event_id`. Lê `_fbp` e `_fbc` direto dos cookies, e **desembrulha** os cookies do Google —
`gclidDoCookie()` extrai o `gclid` de `_gcl_aw` (`GCL.<ts>.<gclid>`) e `gaClientId()` extrai
o `client_id` de `_ga` (`GA1.1.<cid>`, as duas últimas partes) —, caindo para as chaves
`tk_*` do localStorage quando o cookie não existe:

```js
var id = trk('purchase', {
  user_id: '42',
  user_data: { email: 'cliente@exemplo.com' },
  custom_data: { order_id: 8812, value: 199.9, currency: 'BRL' }
});
// repasse o MESMO id ao Pixel do navegador — é o que faz a Meta deduplicar:
fbq('track', 'Purchase', { value: 199.9, currency: 'BRL' }, { eventID: id });
```

O `event_id` é `opts.event_id`, ou `nome + '-' + (custom_data.order_id || transaction_id)`,
ou um UUID. `opts.consent_state` cai para `window.trkConsent` quando ausente.

### `GET /g/:slug.js` — tag única do GTM

| | |
|---|---|
| **Autenticação** | Nenhuma |
| **Content-Type** | `application/javascript; charset=utf-8` |
| **Cache** | `Cache-Control: public, max-age=300` |

Concatenação **literal** de `/s/` (coletor) + `/t/` (`window.trk`) + uma chamada de
`window.trk('page_view', {})`, nesta ordem. É a rota que a aba Instalação do painel oferece
na trilha GTM, como `<script src>` numa única tag de HTML personalizado com acionamento
All Pages.

Por que existe, em uma frase: **duas tags de HTML personalizado no GTM não têm ordem de
execução garantida** — o coletor grava as chaves `tk_*` que o snippet lê ao montar o payload,
e a prioridade de disparo do GTM ordena a execução da *tag*, não o download do *script*. Um
arquivo só é execução síncrona de cima para baixo, e resolve a ordem por construção.

Diferença de propósito em relação a `/w/`: aqui a descoberta do `user_id` é a varredura do
`window.dataLayer` feita pelo coletor, porque é assim que o GTM expõe variável. A `/w/` lê
`window[chave]`, que num site com GTM quase nunca existe. O `page_view` da `/g/` **não** tem
dedupe por URL nem interceptação de `history.pushState`: o gatilho All Pages já garante uma
execução por carregamento.

**Instalação:**

```html
<script src="https://traker.cliente.com/g/k7m2vqbz.js"></script>
```

Sem `async` — `window.trk` precisa existir antes de qualquer tag de conversão que o chame.

### `GET /w/:slug.js` — tag única (instalação sem GTM)

| | |
|---|---|
| **Autenticação** | Nenhuma |
| **Content-Type** | `application/javascript; charset=utf-8` |
| **Cache** | `Cache-Control: public, max-age=300` |

Empacota numa linha só o que `/s/` (coletor) e `/t/` (eventos) fazem separadamente, para
sites que não usam o GTM. As rotas antigas continuam existindo e inalteradas — esta é uma
opção de instalação a mais, não uma substituição. Para quem usa GTM, o equivalente é `/g/`.

**Instalação:**

```html
<script src="https://traker.cliente.com/w/k7m2vqbz.js" async
        data-auto-pageview="1"
        data-user-id-keys="user_id,customer_id"></script>
```

**Três diferenças de propósito em relação a `/s/` + `/t/`:**

1. **Descoberta de `user_id` sem `dataLayer`.** Sem GTM não há `window.dataLayer` para
   varrer. A tag primeiro tenta ler `window[chave]` diretamente (site que já expõe
   `window.user_id` num script inline do servidor) e, quando isso não existe (SPA, login
   assíncrono), o site precisa chamar `window.trkIdentify({...})` explicitamente.
2. **`page_view` automático, com dedupe por URL.** Sem container que decida quando
   disparar, a tag dispara `page_view` sozinha ao carregar e a cada navegação de SPA
   (intercepta `history.pushState`/`replaceState` e escuta `popstate`) — nunca duas vezes
   seguidas para a mesma URL.
3. **Fila de pré-carregamento (`window.trkQueue`).** A tag é `async`: o HTML pode chamar
   `trk(...)` antes do arquivo terminar de baixar. Em vez de publicar um stub próprio, quem
   instala acumula chamadas num array global que a tag drena ao iniciar:

```js
window.trkQueue = window.trkQueue || [];
window.trkQueue.push(['purchase', { custom_data: { value: 97 } }]);      // == trk('purchase', {...})
window.trkQueue.push(['__identify__', { user_id: 'jogador-123' }]);       // == trkIdentify({...})
```

**Configuração — três camadas, atributo do `<script>` sempre vence:**

1. `data-*` no próprio elemento `<script>` (lido via `document.currentScript`, síncrono).
2. `window.trkConfig = {...}`, definido **antes** da tag.
3. Padrão embutido no código.

| Chave (`data-*` em kebab-case) | Tipo | Padrão | Efeito |
|---|---|---|---|
| `autoPageview` / `data-auto-pageview` | boolean (`"0"` desliga) | ligado | dispara `page_view` sozinha |
| `debug` / `data-debug` | boolean (`"1"` liga) | desligado | `console.log`/`console.warn` de diagnóstico |
| `userIdKeys` / `data-user-id-keys` | lista (array ou `"a,b,c"`) | mesma lista padrão do coletor `/s/` | globals extras a checar para descobrir o `user_id` automaticamente |
| `paramsGlobais` / `data-params-globais` | objeto (ou JSON em string) | `{}` | mesclado no `custom_data` de **todo** evento (evento específico tem prioridade) |
| `clickIds` / `data-click-ids` | lista | `[]` | chaves extras a capturar da query string como `click_ids` (camada aberta) — vazio por padrão de propósito, para não virar coletor de PII acidental |

**API exposta:**

- `window.trk(nome, opts)` — idêntica à de `/t/`, mas o `user_data` já inclui a camada
  aberta de `click_ids` capturada por `clickIds`/`data-click-ids`.
- `window.trkIdentify({ user_id | userId | external_id })` — substitui o coletor `/s/`:
  envia a ponte de identidade (mesmo endpoint `/c/:slug`, mesmo guard de uma vez por
  sessão por usuário) quando o site souber quem é o visitante.
- `window.trkQueue` — array de pré-carregamento (ver acima).

**Identificadores capturados** (sticky em `localStorage`, mesma lista do coletor `/s/` mais
a camada aberta): `gclid`, `gbraid`, `wbraid`, `fbclid`, `ttclid`, `clickid`, `tblci`,
`msclkid`, `twclid`, `li_fat_id`, `epik`, `sccid`, `_scid`, `rdt_cid`, `irclickid`,
`obclid`, `kwai_click_id`, `fbp`, `fbc`, `ttp`, `utm_source`, `utm_medium`, `utm_campaign`,
`utm_content`, `utm_term`, `landing_page`, e `click_ids` (só as chaves configuradas em
`clickIds`/`data-click-ids`).

**Respostas dos cinco scripts** (`/s/`, `/t/`, `/w/` e os dois aliases legados)

| Código | Quando | Corpo |
|---|---|---|
| `200` | projeto ativo | o JavaScript |
| `404` | slug/id inexistente ou projeto pausado | `/* projeto não encontrado */` (ainda como `application/javascript`) |

---

## 3. Autenticação do painel

Base: `/api/auth`. Corpo em `application/json` (limite de 1 MB).

### `POST /api/auth/login`

Autenticação: nenhuma. Rate limit: **20 tentativas por minuto por IP**.

```json
{ "email": "admin@codigovencedor.com", "password": "senha-forte" }
```

**`200`:**

```json
{ "user": { "id": 1, "email": "admin@codigovencedor.com", "name": "Administrador", "role": "admin" } }
```

Acompanha `Set-Cookie: traker_sess=<token>; Path=/; HttpOnly; SameSite=Lax; Expires=...`
(mais `Secure` quando `PUBLIC_SCHEME=https`). Validade: `SESSION_TTL_HOURS` (padrão 12).

| Código | Quando | Corpo |
|---|---|---|
| `200` | credenciais corretas | acima |
| `401` | e-mail inexistente ou senha errada (mensagem idêntica nos dois casos) | `{"error":"e-mail ou senha inválidos"}` |
| `429` | mais de 20 tentativas/min do mesmo IP | `{"error":"muitas tentativas, tente novamente em um minuto"}` |
| `500` | falha interna | `{"error":"falha ao autenticar"}` |

### `POST /api/auth/logout`

Autenticação: nenhuma (usa o cookie, se houver). Sem corpo.

**`200`:** `{ "ok": true }` — sempre, mesmo sem sessão. A sessão é apagada do banco e o
cookie é expirado (`Max-Age=0`).

### `GET /api/auth/me`

Autenticação: cookie de sessão.

| Código | Corpo |
|---|---|
| `200` | `{"user":{"id":1,"email":"admin@codigovencedor.com","name":"Administrador","role":"admin"}}` |
| `401` | `{"error":"não autenticado"}` |

### `GET /api/auth/setup-necessario`

Autenticação: nenhuma. Usado pela tela de login para decidir entre "entrar" e "criar o
primeiro acesso".

**`200`:** `{ "setupNecessario": true }` — `true` apenas enquanto `users` estiver vazia.

### `POST /api/auth/setup`

Autenticação: nenhuma, **mas a janela fecha sozinha** assim que existir qualquer usuário.

```json
{ "email": "admin@codigovencedor.com", "password": "senha-com-8-ou-mais", "name": "Administrador" }
```

| Código | Quando | Corpo |
|---|---|---|
| `201` | primeiro usuário criado (já com sessão iniciada e cookie definido) | `{"user":{...}}` |
| `400` | e-mail vazio | `{"error":"e-mail obrigatório"}` |
| `400` | senha com menos de 8 caracteres | `{"error":"senha deve ter ao menos 8 caracteres"}` |
| `403` | já existe usuário | `{"error":"já existe usuário cadastrado; use o login"}` |
| `500` | falha interna | `{"error":"..."}` |

### `POST /api/auth/esqueci-senha`

Público, sem sessão. Corpo: `{ "email": "pessoa@empresa.com" }`.

**Responde sempre `200 {"ok":true}`**, exista o e-mail ou não — e essa uniformidade é
deliberada: responder diferente para e-mail inexistente transformaria o endpoint num
verificador de quem tem conta no sistema. Quando o e-mail existe, um token de propósito
`redefinicao` é criado e o link chega por e-mail; quando não existe, nada acontece além de
uma linha de log em nível `debug`.

Limite de 10 requisições por minuto por IP; acima disso, `429 {"error":"muitas tentativas,
tente novamente em um minuto"}`.

### `GET /api/auth/token/:token`

Público. Valida o token antes de a página pedir a senha — sem isso, a pessoa digitaria uma
senha nova para só então descobrir que o link expirou.

```json
{ "valido": true, "tipo": "convite", "email": "pessoa@empresa.com", "nome": "Fulana" }
```

`tipo` é o propósito do token (`convite` ou `redefinicao`). Token inválido, expirado ou já
usado devolve `200 {"valido": false}` — sem detalhar qual dos três casos é.

### `POST /api/auth/definir-senha`

Público. Corpo: `{ "token": "...", "password": "senha-com-8-ou-mais" }`. Serve tanto para o
aceite de convite quanto para a redefinição.

Em caso de sucesso, define a senha, **consome o token** (uso único), abre a sessão e já
devolve o cookie — a pessoa entra direto, sem passar pelo login. Um e-mail de confirmação é
disparado para o titular: é assim que alguém descobre uma troca de senha que não fez.

| Código | Quando | Corpo |
|---|---|---|
| `200` | senha definida (já autenticado) | `{"user":{...}}` |
| `400` | token inválido, expirado ou já utilizado | `{"error":"link inválido, expirado ou já utilizado"}` |
| `400` | senha curta demais | `{"error":"senha deve ter ao menos 8 caracteres"}` |

---

## 4. Painel — projetos

Todas as rotas abaixo exigem cookie de sessão válido; sem ele, `401
{"error":"não autenticado"}`. Todas devolvem, nas escritas, o **projeto completo** no formato
`publicProject`.

### Formato `publicProject`

```json
{
  "id": "prj_a3f19c82b410",
  "name": "Código Vencedor",
  "domain": "codigovencedor.com",
  "slug": "k7m2vqbz",
  "status": "active",
  "createdAt": "2026-08-12T13:02:41.882Z",
  "temIngestToken": true,
  "urls": {
    "base": "https://traker.codigovencedor.com",
    "evento": "https://traker.codigovencedor.com/e/k7m2vqbz",
    "coleta": "https://traker.codigovencedor.com/c/k7m2vqbz",
    "scriptColetor": "https://traker.codigovencedor.com/s/k7m2vqbz.js",
    "scriptTag": "https://traker.codigovencedor.com/t/k7m2vqbz.js"
  },
  "meta": {
    "enabled": true,
    "pixelId": "1234567890123456",
    "testEventCode": "",
    "eventMap": {
      "page_view": "PageView", "view_content": "ViewContent",
      "sign_up": "CompleteRegistration", "lead": "Lead",
      "add_to_cart": "AddToCart", "begin_checkout": "InitiateCheckout",
      "abandoned_checkout": "AbandonedCheckout", "purchase": "Purchase"
    },
    "hasAccessToken": true
  },
  "google": {
    "enabled": true,
    "route": "ga4_mp",
    "measurementId": "G-ABC123XYZ",
    "ga4ClientId": "",
    "clientId": "",
    "customerId": "",
    "loginCustomerId": "",
    "conversionActions": {},
    "eventMap": {
      "page_view": "page_view", "view_content": "view_item",
      "sign_up": "sign_up", "lead": "generate_lead",
      "add_to_cart": "add_to_cart", "begin_checkout": "begin_checkout",
      "abandoned_checkout": "abandoned_checkout", "purchase": "purchase"
    },
    "hasApiSecret": true,
    "hasClientSecret": false,
    "hasRefreshToken": false,
    "hasDeveloperToken": false
  },
  "postback": {
    "enabled": false,
    "url": "",
    "method": "GET",
    "headers": {},
    "events": ["purchase", "sign_up", "begin_checkout", "abandoned_checkout", "page_view"],
    "hasBearerToken": false
  },
  "ia": {
    "enabled": false,
    "modelo": "",
    "hasIaKey": false
  }
}
```

`urls` é montado a partir de `PUBLIC_HOST`/`PUBLIC_SCHEME`, não do `Host` da requisição.

`ingestToken` (o segredo do webhook server-to-server) **nunca viaja neste objeto** — nem na
listagem, nem na resposta de um projeto específico, nem depois de uma escrita. `publicProject`
só devolve a flag `temIngestToken`, exatamente como as flags `has*` dos outros segredos. Quem
precisa do valor em claro busca sob demanda em `GET /api/projects/:id/ingest-token` (abaixo),
um endpoint próprio, restrito a administradores e **auditado** — cada revelação gera uma
linha de log com quem pediu. `ia` reflete a configuração de IA/OpenRouter (seção 9): a chave
cifrada nunca sai daqui, só a flag `hasIaKey`.

### `GET /api/projects/:id/ingest-token`

Revela o token de ingestão em claro. Endpoint separado de propósito — ver o comentário
acima sobre por que `ingestToken` não acompanha mais `publicProject`.

| | |
|---|---|
| **Autenticação** | `requireAdmin` (não basta sessão comum) |

**`200`:** `{ "ingestToken": "6b1f9a0c4d7e2381ab55c9f0e4d13a72c8b6e5f419d0a7c3" }`
**`404`:** `{"error":"projeto não encontrado"}`

Toda chamada bem-sucedida gera `log('warn', 'token de ingestão revelado', { project, por: <e-mail de quem pediu> })`.

### `GET /api/projects`

Lista todos os projetos, mais recentes primeiro. **`200`:** array de `publicProject`
(`[]` se não houver nenhum).

### `GET /api/servidor`

Identidade pública do servidor — é o dado que o painel usa para dizer ao operador, com o
número na mão, qual registro `A` criar no DNS do cliente.

**`200`:**

```json
{
  "publicHost": "traker.codigovencedor.com",
  "scheme": "https",
  "baseUrl": "https://traker.codigovencedor.com",
  "ips": ["150.230.10.20", "2603:c020:8007:xxxx::1"]
}
```

`ips` são os endereços para os quais o `PUBLIC_HOST` resolve (A + AAAA). Vem `[]` quando
`PUBLIC_HOST` é `localhost` ou não resolve.

### `POST /api/projects`

```json
{ "name": "Código Vencedor", "domain": "codigovencedor.com" }
```

O domínio é sanitizado (remove `https://`, remove path, minúsculas). `name` vazio cai para o
domínio. Junto com o projeto são criados: o slug aleatório, o `ingestToken`, os três destinos
desligados com o mapeamento padrão, e o domínio informado é cadastrado em `project_domains`
como primário e `pending` (falha nesse cadastro é ignorada silenciosamente).

| Código | Quando | Corpo |
|---|---|---|
| `201` | criado | `publicProject` |
| `400` | domínio ausente/vazio | `{"error":"domínio obrigatório"}` |
| `409` | domínio já cadastrado | `{"error":"domínio já cadastrado"}` |

### `GET /api/projects/:id`

| Código | Corpo |
|---|---|
| `200` | `publicProject` |
| `404` | `{"error":"projeto não encontrado"}` |

### `DELETE /api/projects/:id`

Remove o projeto e, por `ON DELETE CASCADE`, seus domínios, destinos, identidades, eventos e
entregas. **Irreversível.**

| Código | Corpo |
|---|---|
| `200` | `{"ok":true}` |
| `404` | `{"error":"projeto não encontrado"}` |

### `PUT /api/projects/:id/status`

```json
{ "status": "paused" }
```

Qualquer valor diferente de `"paused"` é interpretado como `"active"`. Um projeto pausado faz
`/e/`, `/c/` e os scripts responderem `404`, e derruba a autorização de emissão de TLS dos
seus domínios.

| Código | Corpo |
|---|---|
| `200` | `publicProject` |
| `404` | `{"error":"projeto não encontrado"}` |

### `POST /api/projects/:id/rotate-slug`

Gera um slug novo de 8 caracteres. Sem corpo. **Quebra imediatamente** os snippets já
instalados no GTM do cliente — depois de rotacionar é obrigatório republicar as tags com as
novas URLs (que voltam em `urls` na resposta).

| Código | Corpo |
|---|---|
| `200` | `publicProject` (já com o slug e as URLs novas) |
| `404` | `{"error":"projeto não encontrado"}` |

---

## 5. Painel — destinos

Todos os campos do corpo são opcionais; só o que vier é alterado. Ver o **contrato de
segredos** na seção 0.

### `PUT /api/projects/:id/meta`

```json
{
  "enabled": true,
  "pixelId": "1234567890123456",
  "testEventCode": "TEST12345",
  "accessToken": "EAAB...",
  "eventMap": { "purchase": "Purchase", "lead": "Lead" }
}
```

- `pixelId` e `testEventCode` sofrem `trim`.
- `accessToken` ausente ⇒ mantém; `""` ⇒ apaga; valor ⇒ recifra.
- `eventMap` **substitui** o mapa inteiro (não é merge por chave).
- `enabled` ausente ⇒ mantém o valor atual.

**`200`:** `publicProject`. **`404`:** projeto inexistente.

### `PUT /api/projects/:id/google`

```json
{
  "enabled": true,
  "route": "ga4_mp",
  "measurementId": "G-ABC123XYZ",
  "apiSecret": "Xy9...",
  "ga4ClientId": "",
  "clientId": "",
  "customerId": "",
  "loginCustomerId": "",
  "conversionActions": {},
  "clientSecret": "",
  "refreshToken": "",
  "developerToken": "",
  "eventMap": { "purchase": "purchase" }
}
```

`route` escolhe entre as duas integrações Google, **ambas implementadas**. O valor **não é
validado**: qualquer string diferente de `"google_ads"` cai no GA4 MP.

| `route` | Destino | Campos exigidos |
|---|---|---|
| `"ga4_mp"` (padrão) | GA4 Measurement Protocol | `measurementId` + `apiSecret` |
| `"google_ads"` | Google Ads API `UploadClickConversions` | `clientId`, `customerId`, `conversionActions` + `clientSecret`, `refreshToken`, `developerToken` |

Segredos aceitos: `apiSecret` → `api_secret`, `clientSecret` → `client_secret`,
`refreshToken` → `refresh_token`, `developerToken` → `developer_token`.

**Campos específicos da rota `google_ads`:**

- `customerId` e `loginCustomerId` são limpos para só dígitos no envio (pode gravar com
  hífen). `loginCustomerId` é opcional — use quando a conta é acessada via MCC.
- `conversionActions` mapeia **nome de evento do site → resource name da conversion action**,
  com uma chave `default` de fallback:

```json
{
  "route": "google_ads",
  "clientId": "1234-abc.apps.googleusercontent.com",
  "customerId": "123-456-7890",
  "loginCustomerId": "098-765-4321",
  "conversionActions": {
    "purchase": "customers/1234567890/conversionActions/987654321",
    "lead": "customers/1234567890/conversionActions/987654322",
    "default": "customers/1234567890/conversionActions/987654321"
  },
  "clientSecret": "GOCSPX-...",
  "refreshToken": "1//0g...",
  "developerToken": "abcDEF..."
}
```

Faltando qualquer um de `client_id`, `client_secret`, `refresh_token`, `developer_token`,
`customer_id` ou `conversion_action`, a entrega falha imediatamente com `retriable:false` e a
mensagem `"Google Ads não configurado: faltam <lista>"` — visível no log de eventos.

A versão da Ads API vem de `GOOGLE_ADS_API_VERSION` (padrão `v17`), variável de ambiente
global, não por projeto.

> **Pré-requisito externo:** o `developerToken` precisa estar **aprovado pelo Google**. Sem
> aprovação, a chamada falha com erro tratado — nunca com sucesso silencioso.

**`200`:** `publicProject`. **`404`:** projeto inexistente.

### `PUT /api/projects/:id/postback`

```json
{
  "enabled": true,
  "url": "https://crm.cliente.com/conv?click_id={{clickid}}&valor={{value}}",
  "method": "POST",
  "headers": { "X-Origem": "traker", "X-Pedido": "{{order_id}}" },
  "events": ["purchase", "lead"],
  "bearerToken": "segredo-do-crm"
}
```

- `method`: qualquer valor diferente de `"POST"` (case-insensitive) vira `"GET"`.
- `events`: lista de nomes de evento **do site** (pré-mapeamento). Lista vazia = todos. Um
  evento fora da lista é marcado como `skipped_unmapped`, não como erro.
- `{{campo}}` na URL e nos headers é interpolado a partir de `event`, `event.user_data` e
  `event.custom_data` (nessa ordem de precedência), com `encodeURIComponent`. Caminhos com
  ponto funcionam: `{{custom_data.order_id}}`.
- `bearerToken` é guardado cifrado e enviado como `Authorization: Bearer ...`.
- Em `POST`, o corpo enviado ao cliente é
  `{ event_name, event_id, event_time, user_id, user_data, custom_data }`.

**`200`:** `publicProject`. **`404`:** projeto inexistente.

---

## 6. Painel — domínios first-party

### `GET /api/projects/:id/domains`

**`200`:** array de linhas cruas de `project_domains`, ordenadas por `is_primary DESC,
created_at ASC`:

```json
[
  {
    "id": 7,
    "project_id": "prj_a3f19c82b410",
    "hostname": "traker.codigovencedor.com",
    "pointing_method": "a_record",
    "verification_status": "active",
    "is_primary": true,
    "last_checked_at": "2026-08-12T13:20:11.402Z",
    "last_error": null,
    "ssl_issued_at": "2026-08-12T13:21:59.118Z",
    "created_at": "2026-08-12T13:02:41.882Z"
  }
]
```

**`404`:** `{"error":"projeto não encontrado"}`.

### `POST /api/projects/:id/domains`

```json
{ "hostname": "ct.clientex.com.br", "pointingMethod": "cname" }
```

`hostname` é sanitizado e validado contra `/^[a-z0-9.-]+\.[a-z]{2,}$/`. `pointingMethod`
aceita `"cname"`; qualquer outro valor vira `"a_record"`. O domínio nasce `pending` e
`is_primary = false`.

| Código | Quando | Corpo |
|---|---|---|
| `201` | criado | a linha de `project_domains` |
| `400` | hostname inválido | `{"error":"hostname inválido"}` |
| `404` | projeto inexistente | `{"error":"projeto não encontrado"}` |
| `409` | hostname já cadastrado (a unicidade é **global**) | `{"error":"hostname já cadastrado"}` |

### `DELETE /api/projects/:id/domains/:domainId`

`domainId` é o `id` numérico da linha. A exclusão é escopada por `project_id`.

| Código | Corpo |
|---|---|
| `200` | `{"ok":true}` |
| `404` | `{"error":"domínio não encontrado"}` |

### `POST /api/projects/:id/domains/:domainId/verify`

Roda `resolveDns(hostname)`: compara o CNAME com o `PUBLIC_HOST` e procura IPs em comum entre
o hostname do cliente e o host público do serviço. Grava
`verification_status = "verified"` em caso de sucesso e `"pending"` em caso de falha (**esta
rota nunca marca `"failed"`**), junto com `last_checked_at` e `last_error`. Sem corpo.

**`200` — sucesso:**

```json
{
  "hostname": "ct.clientex.com.br",
  "ok": true,
  "metodo": "cname",
  "ips": ["150.230.10.20"],
  "cnames": ["traker.codigovencedor.com"],
  "esperado": { "host": "traker.codigovencedor.com", "ips": ["150.230.10.20"] }
}
```

**`200` — ainda não propagou:**

```json
{
  "hostname": "ct.clientex.com.br",
  "ok": false,
  "error": "domínio ainda não resolve (DNS não propagado ou registro inexistente)",
  "ips": [],
  "cnames": []
}
```

**`200` — aponta para o lugar errado:**

```json
{
  "hostname": "ct.clientex.com.br",
  "ok": false,
  "metodo": null,
  "ips": ["203.0.113.9"],
  "cnames": [],
  "esperado": { "host": "traker.codigovencedor.com", "ips": ["150.230.10.20"] },
  "error": "aponta para 203.0.113.9, esperado 150.230.10.20"
}
```

Em ambiente local (`PUBLIC_HOST` igual a `localhost` ou vazio), devolve
`{"ok":false,"error":"PUBLIC_HOST não configurado — não é possível verificar em ambiente local"}`.

| Código | Corpo |
|---|---|
| `200` | acima (inclusive quando `ok: false` — a verificação rodou) |
| `404` | `{"error":"domínio não encontrado"}` |

---

## 7. Painel — eventos, métricas e diagnóstico

### `GET /api/projects/:id/events`

Log de eventos, mais recentes primeiro.

| Parâmetro de query | Padrão | Efeito |
|---|---|---|
| `limit` | `200` | número de eventos. Valor não-numérico cai para 200; o valor efetivo é limitado a **[1, 1000]** — `?limit=999999` devolve 1000, não a tabela inteira |

**`200`:**

```json
[
  {
    "id": "8a4f1e2c-91b7-4d0a-b3e6-2f5c1d7a9e40",
    "event_id": "purchase-8812",
    "event_name": "purchase",
    "receivedAt": "2026-08-12T14:22:03.114Z",
    "source": "web",
    "value": 199.9,
    "currency": "BRL",
    "utm_source": "meta",
    "payment_method": "pix",
    "coupon": null,
    "order_id": "8812",
    "destinations": {
      "meta":   { "status": "success", "httpStatus": 200, "attempts": 1,
                  "response": { "events_received": 1, "fbtrace_id": "A1bC2dEf3Gh" } },
      "google": { "status": "success", "httpStatus": 204, "attempts": 1,
                  "response": { "accepted": true, "event": "purchase" } }
    }
  },
  {
    "id": "1c9d7b60-3ea2-4f18-9c05-77b1e4a2d331",
    "event_id": "lead-7731",
    "event_name": "lead",
    "receivedAt": "2026-08-12T14:19:47.002Z",
    "source": "webhook",
    "value": null,
    "currency": null,
    "utm_source": "google",
    "payment_method": null,
    "coupon": null,
    "order_id": null,
    "destinations": {
      "meta": { "status": "dead", "httpStatus": 400, "attempts": 1,
                "response": { "error": "Invalid OAuth access token", "code": 190,
                              "fbtrace_id": "Zz9Yy8Xx7" } }
    }
  }
]
```

`destinations` é `{}` quando o evento não gerou nenhuma entrega (nenhum destino habilitado no
momento da ingestão). Quando a entrega não tem `response` gravado, o campo traz o
`last_error` como string.

`payment_method`, `coupon` e `order_id` são lidos direto de `payload->'custom_data'` (via
`->>`) e vêm `null` quando o evento não trouxe o campo correspondente.

Valores possíveis de `status`: `pending`, `processing`, `success`, `error`, `dead`,
`skipped_consent`, `skipped_unmapped`.

**`404`:** `{"error":"projeto não encontrado"}`.

### `POST /api/events/:eventDbId/requeue`

`eventDbId` é o **UUID** de `events.id` (o campo `id` da rota acima, não o `event_id`), e é
validado contra o formato antes de chegar ao banco. Recoloca na fila todas as entregas
daquele evento que não estejam em `success`, zerando `attempts` e `last_error`. Não é
escopado por projeto. Sem corpo.

| Código | Quando | Corpo |
|---|---|---|
| `200` | ao menos uma entrega reenfileirada | `{"ok":true,"requeued":2}` |
| `400` | `eventDbId` não tem formato de UUID | `{"error":"identificador de evento inválido"}` |
| `404` | evento inexistente ou todas as entregas já em `success` | `{"error":"evento não encontrado ou já entregue"}` |

### `GET /api/projects/:id/metrics`

| Parâmetro de query | Formato | Efeito |
|---|---|---|
| `from` | `YYYY-MM-DD` | `received_at >= <from>T00:00:00Z` |
| `to` | `YYYY-MM-DD` | `received_at < <to> + 1 dia` (o dia final é **incluído**) |
| `utm_source` | string | filtra pela coluna desnormalizada `events.utm_source` |
| `event_name` | string | filtra pelo nome do evento **do site** |

**`200`:**

```json
{
  "totals": {
    "events": 12840,
    "purchases": 372,
    "revenue": 74395.3,
    "signUps": 1129,
    "avgTicket": 199.98,
    "successRate": 0.9831
  },
  "byDay": [
    { "date": "2026-08-10", "events": 4102 },
    { "date": "2026-08-11", "events": 4611 },
    { "date": "2026-08-12", "events": 4127 }
  ],
  "byUtmSource": [
    { "source": "meta", "count": 8420 },
    { "source": "google", "count": 3110 },
    { "source": "", "count": 1310 }
  ],
  "byEventName": [
    { "name": "page_view", "count": 9012 },
    { "name": "purchase", "count": 372 }
  ],
  "byDestination": {
    "meta":   { "success": 12401, "error": 213, "off": 3 },
    "google": { "success": 12388, "error": 9,   "off": 220 }
  }
}
```

Notas de leitura: `purchases`, `revenue` e `avgTicket` consideram apenas
`event_name = 'purchase'`; `signUps` soma `sign_up` **e** `lead`; `successRate` é uma
**fração de 0 a 1** (o painel multiplica por 100) e ignora entregas pendentes e puladas;
`off` em `byDestination` agrupa tudo que não é `success`/`error`/`dead` — ou seja `pending`,
`processing`, `skipped_consent` e `skipped_unmapped`.

**`404`:** `{"error":"projeto não encontrado"}`.

### `GET /api/projects/:id/metrics/utm`

Receita e cobertura de atribuição por combinação `utm_source × utm_medium × utm_campaign`.

| Parâmetro de query | Padrão | Efeito |
|---|---|---|
| `from`, `to` | — | mesmo recorte de período de `GET /metrics` |
| `limit` | `50` | linhas devolvidas; teto rígido em **200** |

**`200`:**

```json
{
  "linhas": [
    {
      "utm_source": "facebook",
      "utm_medium": "cpc",
      "utm_campaign": "promo",
      "eventos": 2,
      "compras": 1,
      "receita": 100,
      "ticket_medio": 100,
      "pct_com_atribuicao": 0.5
    },
    {
      "utm_source": "(direto)",
      "utm_medium": "(direto)",
      "utm_campaign": "(direto)",
      "eventos": 1,
      "compras": 1,
      "receita": 50,
      "ticket_medio": 50,
      "pct_com_atribuicao": 0
    }
  ],
  "total": { "eventos": 3, "compras": 2, "receita": 150 }
}
```

UTM ausente vira a chave `"(direto)"` já na consulta — nunca `null` cru. `receita` e
`ticket_medio` consideram só `event_name = 'purchase'`. `pct_com_atribuicao` é a fração
(0 a 1) dos eventos daquela linha que tinham `fbc`/`fbclid` ou `gclid`/`gbraid`/`wbraid`
(colunas `tem_fbc`/`tem_gclid`). `total` é o agregado do período inteiro, não a soma das
linhas visíveis (que podem estar cortadas pelo `limit`). **`404`:** projeto inexistente.

### `GET /api/projects/:id/metrics/atribuicao`

Cobertura de identificador de clique por dia e a "receita invisível" — compras fechadas
sem `fbc`/`fbclid` nem `gclid`/`gbraid`/`wbraid`, portanto sem chance de casar com uma
campanha específica do lado da plataforma de anúncio.

| Parâmetro de query | Padrão | Efeito |
|---|---|---|
| `from`, `to` | — | recorte de período |
| `event_name` | — | filtra a **série** e o **resumo** por tipo de evento do site |
| `limit` | `20` | linhas da lista `sem_atribuicao`; teto rígido em **100** |

**`200`:**

```json
{
  "serie": [
    { "data": "2026-08-13", "com_fbc": 1, "sem_fbc": 1, "com_gclid": 0, "sem_gclid": 2 }
  ],
  "sem_atribuicao": [
    {
      "id": "c2e1...uuid",
      "event_id": "atr-compra-sem-click",
      "received_at": "2026-08-13T10:00:00.000Z",
      "value": 30,
      "currency": "BRL",
      "utm_source": "(direto)",
      "utm_campaign": "(direto)"
    }
  ],
  "resumo": { "total_eventos": 2, "sem_atribuicao": 1, "receita_sem_atribuicao": 30 }
}
```

A lista `sem_atribuicao` é **sempre sobre `purchase`**, independente do `event_name`
pedido — é justamente a lista que sustenta o alerta de receita sem rastro; o filtro
`event_name` só recorta a `serie` e o `resumo`. **`404`:** projeto inexistente.

### `GET /api/projects/:id/metrics/funil`

Funil configurável, calculado numa única varredura (cada etapa é um `COUNT(*) FILTER`
na mesma query, não uma query por etapa).

| Parâmetro de query | Padrão | Efeito |
|---|---|---|
| `from`, `to` | — | recorte de período |
| `etapas` | `page_view,lead,begin_checkout,pix_gerado,purchase` | lista de nomes de evento separada por vírgula, na ordem desejada; teto de **12** etapas |

**`200`:**

```json
{
  "etapas": [
    { "nome": "page_view", "eventos": 2, "taxa_da_etapa_anterior": null, "taxa_do_topo": 1 },
    { "nome": "lead", "eventos": 1, "taxa_da_etapa_anterior": 0.5, "taxa_do_topo": 0.5 },
    { "nome": "begin_checkout", "eventos": 0, "taxa_da_etapa_anterior": 0, "taxa_do_topo": 0 },
    { "nome": "pix_gerado", "eventos": 0, "taxa_da_etapa_anterior": 0, "taxa_do_topo": 0 },
    { "nome": "purchase", "eventos": 1, "taxa_da_etapa_anterior": 0, "taxa_do_topo": 0.5 }
  ]
}
```

`taxa_da_etapa_anterior` da primeira etapa é sempre `null` (não existe "anterior"). Uma
etapa cuja anterior teve 0 eventos devolve `0`, nunca `NaN`/`Infinity` (guarda contra
divisão por zero). **`404`:** projeto inexistente.

### `GET /api/projects/:id/metrics/destinos`

Saúde de entrega por destino: status por dia, latência média e os erros mais frequentes.
Usa `deliveries.created_at` como eixo do tempo (não `events.received_at`) — um reenvio
manual de um evento antigo aparece no dia do reenvio, não no dia do evento original.

| Parâmetro de query | Efeito |
|---|---|
| `from`, `to` | recorte de período sobre `created_at` da entrega |

**`200`:**

```json
{
  "serie": [
    {
      "data": "2026-08-13",
      "destino": "meta",
      "status": { "success": 1, "processing": 0, "error": 0, "dead": 1, "pending": 0, "skipped_consent": 0, "skipped_unmapped": 0 }
    }
  ],
  "latencia_media_segundos": { "meta": 3.1, "google": 1.0 },
  "top_erros": {
    "meta": [{ "erro": "Invalid access token", "quantidade": 1 }],
    "google": []
  }
}
```

`status` sempre traz as sete chaves (zeradas quando não houve entrega naquele dia/destino).
`latencia_media_segundos` só considera entregas com `status = 'success'`. `top_erros` lista,
por destino, até **5** mensagens (`last_error` truncado em 200 caracteres) ordenadas por
quantidade — nunca o texto integral nem o corpo da resposta do destino. **`404`:** projeto
inexistente.

### `GET /api/projects/:id/metrics/serie`

Série diária do gráfico principal do dashboard: contagem por tipo de evento e receita,
dia a dia — calculada no banco para o gráfico não mentir por omissão em projetos grandes
nem baixar o payload inteiro de cada evento só para contar.

| Parâmetro de query | Padrão | Efeito |
|---|---|---|
| `from`, `to` | — | recorte de período |
| `utm_source` | — | filtra pela coluna desnormalizada |
| `event_name` | — | recorta a série para um único tipo de evento |
| `top_n` | `8` | quantos tipos de evento viram série própria; teto rígido em **20**, mínimo 1. O resto é somado em `outros` |

**`200`:**

```json
{
  "tipos": ["page_view", "lead", "purchase"],
  "temOutros": false,
  "serie": [
    { "dia": "2026-08-13", "tipos": { "page_view": 2, "lead": 1, "purchase": 2 }, "outros": 0, "receita": 200, "compras": 2 }
  ]
}
```

`temOutros` só vira `true` quando algum dia teve eventos fora do `top_n` mais frequentes —
evita o gráfico ganhar uma faixa "outros" sempre zerada em projeto com poucos tipos de
evento. Projeto sem eventos no período devolve `{ "tipos": [], "temOutros": false, "serie": [] }`,
nunca erro. **`404`:** projeto inexistente.

### `GET /api/projects/:id/deliveries` — falhas de entrega explicadas

Entregas que precisam de atenção, já **agrupadas por causa** (não pelo texto cru do erro).
O agrupamento acontece **no servidor** (`agruparFalhasPorCausa`, em `src/admin/router.js`),
usando o tradutor de `src/destinations/erros-explicados.js` — o repositório só devolve
linhas cruas de `deliveries`.

| Parâmetro de query | Padrão | Efeito |
|---|---|---|
| `status` | `error,dead` | lista separada por vírgula. Só `error`, `dead`, `skipped_consent`, `skipped_unmapped` são aceitos — qualquer outro valor na lista é silenciosamente ignorado |
| `destination` | — | `meta`, `google` ou `postback` |
| `from`, `to` | — | recorte sobre `deliveries.updated_at` (quando a **última tentativa** aconteceu, não quando o evento chegou) |
| `limit` | `100` | linhas cruas lidas do banco **antes** de agrupar; teto rígido em **500** |

**`200`:**

```json
{
  "grupos": [
    {
      "chave": "meta.token_invalido",
      "resumo": "Token de acesso da Meta inválido ou expirado",
      "detalhe": "A Meta recusou o token usado para autenticar as chamadas — comum quando o token foi gerado como token de usuário (que expira) em vez de um token de sistema de longa duração, ou quando alguém o revogou no Gerenciador de Negócios.",
      "acao": "Gere um novo token de acesso (token de usuário do sistema, de longa duração) e salve em Configurações > Meta.",
      "gravidade": "critica",
      "catalogado": true,
      "destino": "meta",
      "quantidade": 3,
      "primeira_em": "2026-08-13T10:00:00.000Z",
      "ultima_em": "2026-08-13T10:05:00.000Z",
      "event_row_ids": ["uuid-1", "uuid-2", "uuid-3"],
      "truncado": false,
      "amostras": [
        { "delivery_id": 41, "event_row_id": "uuid-1", "event_id": "f-token-1", "event_name": "purchase",
          "received_at": "...", "destination_type": "meta", "status": "dead", "attempts": 5,
          "http_status": 401, "last_error": "(#190) Error validating access token: expired.",
          "next_attempt_at": null, "updated_at": "...", "value": 10, "currency": "BRL", "utm_source": null }
      ]
    }
  ],
  "total": 5,
  "por_destino": { "meta": 4, "google": 0, "postback": 1 }
}
```

Campo a campo:

- **`chave`** — identificador estável da causa (ex.: `meta.token_invalido`,
  `rede.timeout`, `desconhecido`), usado para o agrupamento e para o link do botão
  "reenviar todos" agir só sobre aquele grupo.
- **`gravidade`** — `critica` (bloqueia entrega, exige ação), `atencao` (degrada, pode se
  resolver sozinho) ou `informativa` (comportamento esperado, ex. consentimento negado).
  Os grupos vêm ordenados por gravidade (`critica` antes de `atencao` antes de
  `informativa`) e, dentro da mesma gravidade, por `quantidade` decrescente.
- **`catalogado`** — `true` quando o erro bateu numa regra conhecida do dicionário;
  `false` quando nada casou (chave `desconhecido`) — o módulo **nunca inventa** uma causa
  para um erro que não reconhece.
- **`event_row_ids`** — até **200** ids de `events.id` do grupo, para o "reenviar todos"
  (via `POST /api/events/:eventDbId/requeue`, um por um). **`truncado: true`** quando
  `quantidade` for maior que 200 — o painel precisa avisar que só uma parte foi
  reenfileirada, nunca fingir que reenviou tudo.
- **`amostras`** — até **5** entregas de exemplo do grupo, no formato cru de
  `listFailedDeliveries`, **exceto** que `last_error` sai sempre truncado (~500 caracteres)
  e **mascarado** (`truncarEMascarar`: qualquer trecho parecido com
  `access_token=`/`refresh_token=`/`client_secret=`/`api_secret=`/`developer_token=`/
  `bearer_token=` ou `Bearer <token>` vira `***`) — o texto de erro vem de um terceiro e
  já aconteceu de vazar fragmento de credencial numa mensagem de erro. O campo `response`
  (o corpo cru que o destino devolveu — pode ecoar trecho do que foi enviado, incluindo
  credencial) é **descartado antes de sair da API**; ele só existe para o tradutor de
  erros ler internamente (ex.: o `error_subcode` da Meta que distingue "fora da janela de
  7 dias" de "campo mal formatado", ambos com o mesmo `code: 100`).

**`404`:** `{"error":"projeto não encontrado"}`.

### `GET /api/projects/:id/deliveries/resumo`

Badge do painel (ex. "Meta (3)") sem carregar a lista inteira de falhas.

**`200`:**

```json
{
  "destinos": {
    "meta": { "ultimas_24h": 1, "ultimos_7d": 2 },
    "google": { "ultimas_24h": 0, "ultimos_7d": 0 },
    "postback": { "ultimas_24h": 0, "ultimos_7d": 0 }
  },
  "total_24h": 1,
  "total_7d": 2
}
```

Conta só `status IN ('error', 'dead')`, agrupado por `deliveries.updated_at`. As três
chaves de `destinos` vêm sempre, mesmo com zero falhas. **`404`:** projeto inexistente.

### `GET /api/projects/:id/emq`

Cobertura dos campos de correspondência nos eventos recentes. **Não é o EMQ oficial da Meta**
(esse vive no Events Manager) — serve para achar **onde** está a perda de match.

| Parâmetro de query | Padrão | Efeito |
|---|---|---|
| `days` | `7` | janela de `received_at >= now() - <days> days` |

**`200`:**

```json
{
  "total": 12840,
  "days": 7,
  "coverage": [
    { "field": "email",             "count": 4102,  "pct": 0.3194 },
    { "field": "phone",             "count": 3880,  "pct": 0.3021 },
    { "field": "fbc",               "count": 9017,  "pct": 0.7022 },
    { "field": "fbp",               "count": 11902, "pct": 0.9269 },
    { "field": "external_id",       "count": 5300,  "pct": 0.4127 },
    { "field": "client_ip_address", "count": 12840, "pct": 1 },
    { "field": "client_user_agent", "count": 12840, "pct": 1 }
  ],
  "identidades": 2681
}
```

`identidades` é a contagem de linhas em `identities` para o projeto. `pct` é fração de 0 a 1.

**`404`:** `{"error":"projeto não encontrado"}`.

### `DELETE /api/projects/:id/identities/:userKey` — expurgo por titular (LGPD)

Remove a identidade daquele `user_id` **e** todos os eventos cujo `payload->>'user_id'` seja
igual a ele (as entregas caem por cascade). Irreversível.

| Código | Corpo | Observação |
|---|---|---|
| `200` | `{"ok":true}` | havia identidade e ela foi removida |
| `200` | `{"ok":false}` | não havia identidade — **os eventos são apagados de qualquer forma** |

Não valida se o projeto existe: com um `id` inexistente responde `{"ok":false}`.

### `GET /api/fila`

Profundidade da fila **de toda a instância** (sem recorte por projeto).

**`200`:**

```json
{
  "pending": 3,
  "processing": 1,
  "success": 24880,
  "error": 2,
  "dead": 11,
  "skipped_consent": 47,
  "skipped_unmapped": 5
}
```

As **sete** chaves vêm sempre, zeradas quando não há linhas naquele status — o consumidor
pode ler qualquer uma sem checar existência.

### Console de testes

Duas rotas sob `/api/projects/:id`, montadas por `src/admin/testar.js`. Servem à aba
"Testar" do painel: montar um evento, ver o JSON exato que sairia e, se o operador
autorizar, mandá-lo de verdade.

#### `GET /api/projects/:id/testar/modelos`

`{ "modelos": [...] }` — payloads de exemplo já preenchidos com os dados do projeto, para o
operador não precisar escrever JSON à mão. `404` se o projeto não existe.

#### `POST /api/projects/:id/testar`

```json
{ "modo": "simular", "destino": "meta", "payload": { "event_name": "purchase", "...": "..." } }
```

`modo` e `destino` são validados contra listas fechadas e caem no padrão (`simular`,
`meta`) quando vêm com valor desconhecido — nunca produzem erro por digitação.

| `modo` | O que acontece |
|---|---|
| `simular` | **Nada sai daqui.** Monta o payload, mostra a URL de destino e o JSON exato, e para. |
| `teste` | Envia de verdade, mas marcado como teste na plataforma (na Meta, com o `test_event_code` do projeto). |
| `real` | Envia como um evento de produção. |

**`200`** devolve seis blocos — os três primeiros dizem *como o evento foi interpretado* e
os três últimos, *o que aconteceu com ele*:

```json
{
  "modo": "simular",
  "destino": "meta",
  "formatoDetectado": "codigo-vencedor",
  "eventoInterno": { "event_name": "...", "event_id": "...", "event_time": 0,
                     "action_source": "website", "user_data": {}, "custom_data": {} },
  "urlDestino": "https://graph.facebook.com/v21.0/<pixel_id>/events",
  "payloadEnviado": { "...": "..." },
  "enviado": false,
  "resposta": null,
  "diagnostico": { "alertas": ["..."], "bloqueios": ["..."], "campos": [] }
}
```

O `diagnostico` é o que dá valor à tela: lista o que falta para a correspondência, o que
seria enviado com ressalva, e o que **impediria** o envio. Payload que não é objeto devolve
`400`; projeto inexistente, `404`.

---

## 8. Painel — Webhook Studio

Todas as rotas abaixo exigem cookie de sessão válido (`requireAuth`). Escrita que muda o
**significado dos dados de conversão** (criar/editar/excluir adaptador) exige
`requireAdmin` — mexer no mapeamento não é ação de operador.

### `GET /api/projects/:id/webhooks/amostras` — inbox de webhooks não reconhecidos

Amostras de payloads que chegaram por webhook (`POST /e/:slug` com `Authorization: Bearer`)
e que **nenhum adaptador reconheceu** — nem os hardcoded do código, nem os dinâmicos do
projeto — capturadas automaticamente pela ingestão. A captura é *side-effect* isolado: uma
falha ao gravar a amostra nunca atrasa nem derruba a resposta do webhook.

| Parâmetro de query | Padrão | Efeito |
|---|---|---|
| `limit` | `50` | quantos **grupos** de formato devolver |

**`200`:** array agrupado por **formato** (por `hash_estrutura` — o conjunto ordenado de
caminhos de chave do payload, sem valores; dois payloads com a mesma estrutura e valores
diferentes caem no mesmo grupo):

```json
[
  {
    "hash_estrutura": "a1b2c3...",
    "quantidade": 2,
    "primeira_em": "2026-08-13T10:00:00.000Z",
    "ultima_em": "2026-08-13T10:05:00.000Z",
    "amostra_representativa": {
      "id": 41,
      "received_at": "2026-08-13T10:05:00.000Z",
      "formato_detectado": null,
      "body_mascarado": { "x": 9, "y": 9 },
      "headers_relevantes": { "content-type": "application/json", "x-webhook-signature": "abc" },
      "processada": false
    }
  }
]
```

`amostra_representativa` é a mais recente do grupo. `body_mascarado` já vem com PII
mascarada — e-mail/telefone/nome viram hash SHA-256 (mesmas funções de
`redactForStorage`), CPF/CNPJ vira hash dos dígitos, e qualquer campo cuja **chave**
sugira segredo (`senha`, `token`, `secret`, `authorization`, `apikey`, `cartao`, `cvv`...)
vira a string `"[oculto]"` em vez de hash — "erra para o lado de mascarar demais".
`headers_relevantes` nunca inclui `Authorization` nem `Cookie`; só `content-type`,
`user-agent` e qualquer header `x-*` (assinatura de webhook). Tetos de captura, aplicados
antes de gravar: **50** amostras novas por projeto por dia, **5** por formato
(`hash_estrutura`) idêntico, **500** no total por projeto (as mais antigas são descartadas
ao estourar). **`404`:** projeto inexistente.

### `DELETE /api/projects/:id/webhooks/amostras/:amostraId`

Descarte manual — operação de limpeza, coberta por `requireAuth` (não exige admin).
`amostraId` precisa ser numérico.

| Código | Corpo |
|---|---|
| `200` | `{"ok":true}` |
| `400` | `{"error":"id de amostra inválido"}` — `amostraId` não numérico |
| `404` | `{"error":"amostra não encontrada"}` — inexistente, ou de outro projeto |

### A DSL de mapeamento (`mapeamento` e `deteccao`)

Formato aceito pelo CRUD de adaptadores e pelos endpoints de preview/sugestão/IA. É uma
lista **fechada** de transformações interpretadas por `src/ingest/mapeamento.js` — nunca
`eval`/código: mapeamento vem do banco (operador ou IA), e código vindo de dado seria
execução remota disfarçada.

**`deteccao`** decide se um adaptador reconhece um payload:

```json
{ "obrigatorias": ["tipo_evento", "id_pedido"], "qualquerUma": ["cliente", "status_pagamento"] }
```

Todas as `obrigatorias` precisam estar presentes (AND); se `qualquerUma` não for vazia,
pelo menos uma precisa estar presente (OR). `validarDeteccao` exige **ao menos 2 chaves
discriminantes no total** (`obrigatorias.length + qualquerUma.length >= 2`) — detecção
fraca demais (ex.: só `"id"`) poderia "roubar" payloads de outro formato.

**`mapeamento`** tem dois blocos: `evento` (deriva `event_name`) e `regras` (o resto do
Evento Interno):

```json
{
  "evento": {
    "de": "tipo_evento",
    "transformar": "mapear_valores",
    "condicaoPagamento": { "de": "status_pagamento", "valoresConfirmados": ["aprovado", "pago"] },
    "args": { "dicionario": {
      "pedido.criado": "begin_checkout",
      "pedido.pago": { "sePago": "purchase", "senaoPago": "checkout_concluido" }
    } }
  },
  "regras": [
    { "de": "id_pedido", "para": "event_id", "transformar": "texto" },
    { "de": "valor_centavos", "para": "custom_data.value", "transformar": "centavos_para_reais" },
    { "de": ["email_a", "email_b"], "para": "user_data.email", "transformar": "primeiro_preenchido", "args": { "padrao": "" } }
  ]
}
```

Cada regra: `{ "de": "caminho.no.payload", "para": "caminho.no.evento.interno", "transformar": "nome_da_lista_abaixo", "args": {...} }`.
`de` pode ser uma lista de caminhos quando `transformar` é `primeiro_preenchido`. Caminho
usa ponto para aninhamento e número para índice de array (`itens.0.preco`); segmentos
`__proto__`/`constructor`/`prototype` nunca são atravessados, na leitura nem na escrita
(defesa contra poluição de protótipo, já que o caminho vem de uma coluna JSONB gravável
pelo painel ou por uma IA).

**Lista fechada de transformações** (`transformar` fora desta lista faz o mapeamento
inteiro ser **recusado** na validação — nunca ignorado em silêncio):

| Transformação | O que faz |
|---|---|
| `texto` | copia como string, com `trim` |
| `numero` | `Number(valor)`; inválido vira campo ausente |
| `centavos_para_reais` | divide por 100 |
| `separar_nome` | recebe nome completo, separa em `first_name`/`last_name`. **Única** cujo `para` é o prefixo `user_data` (não `user_data.first_name`) — ela escreve os dois campos sozinha |
| `unix_de_iso` | data ISO-8601 → timestamp Unix em segundos |
| `booleano` | `"true"/"1"/"sim"/"yes"` → `true`; `"false"/"0"/"nao"/"no"` → `false` |
| `constante` | não usa `de`; sempre grava `args.valor` |
| `mapear_valores` | dicionário `{ "valor_origem": "valor_destino" }` com `args.padrao` de fallback. **Única transformação permitida no bloco `evento`** |
| `primeiro_preenchido` | `de` é uma lista de caminhos; usa o primeiro não vazio, senão `args.padrao` |
| `ip_publico` | descarta o valor se for IP de rede privada/loopback/link-local (`10.x`, `127.x`, `192.168.x`, `172.16-31.x`, `169.254.x`, `::1`) |
| `minusculo` | minúsculas + trim |
| `apenas_digitos` | remove tudo que não é dígito (CPF/CNPJ com pontuação) |
| `ga_client_id` | extrai o client id do cookie `_ga` (`GA1.1.<id>.<ts>` → `<id>.<ts>`) |
| `marcador_presenca` | emite `args.valor` se o campo de origem não estiver vazio, senão `args.valorAusente` |
| `contagem` | tamanho de uma lista |

**Regra dura — nada vira `"purchase"` sem confirmação explícita de pagamento**, validada
em `validarMapeamento` (recusa salvar) e reforçada de novo em tempo de execução:

- O bloco `evento` só pode usar `"transformar": "mapear_valores"` — qualquer outra
  transformação passaria o valor cru adiante sem checagem, e se um dia o valor cru for
  literalmente `"purchase"`, viraria compra sem confirmação nenhuma.
- Dentro do dicionário do bloco `evento`, uma entrada pode ser uma string simples ou um
  objeto condicional `{ "sePago": "...", "senaoPago": "..." }`, resolvido por
  `condicaoPagamento`. `"senaoPago": "purchase"` é **sempre proibido** (compra sem
  pagamento é o inverso da regra). `"sePago": "purchase"` só é aceito quando o mapeamento
  declara `condicaoPagamento` (`{ "de": "...", "valoresConfirmados": [...] }`).
- Uma entrada **literal** do dicionário mapeando direto para `"purchase"` (sem
  `sePago`/`senaoPago`) é **permitida** — é curadoria explícita de um valor que a própria
  origem já rotula como venda fechada (ex.: `"event": "purchase"` no payload).
- Sem `condicaoPagamento` declarada, nenhum evento fora do dicionário vira `purchase` em
  tempo de execução — cai num nome derivado (slug) do valor bruto.

Violação de qualquer uma dessas regras faz `POST/PUT /adaptadores` responder `400` com
`{"error":"adaptador inválido","detalhes":["..."]}`, um item por erro encontrado.

### `GET /api/projects/:id/adaptadores`

Lista os adaptadores dinâmicos do projeto (mais recente primeiro).

**`200`:** array de:

```json
{
  "id": 7,
  "nome": "plataforma-y",
  "deteccao": { "obrigatorias": ["tipo", "cliente"], "qualquerUma": [] },
  "mapeamento": { "evento": { "...": "..." }, "regras": [] },
  "ativo": false,
  "modo": "nativo",
  "criadoVia": "manual",
  "createdBy": 1,
  "createdAt": "2026-08-13T10:00:00.000Z",
  "updatedAt": "2026-08-13T10:00:00.000Z"
}
```

Nada aqui é segredo (mapeamento/detecção são configuração), então o registro inteiro é
devolvido — sem flags `has*`.

### `POST /api/projects/:id/adaptadores`

**Autenticação:** `requireAdmin`.

```json
{ "nome": "plataforma-y", "deteccao": {...}, "mapeamento": {...}, "ativo": false, "modo": "nativo" }
```

`nome` obrigatório; `mapeamento`/`deteccao` validados (ver DSL acima). `modo` aceita
`"nativo"` | `"sombra"` | `"ia_por_evento"` — qualquer outro valor devolve `400
{"error":"modo inválido: \"X\" (use nativo, sombra, ia_por_evento)"}`. Em modo `sombra`,
o adaptador **nunca altera** o evento processado — só fica registrado se teria batido
(diagnóstico para validar uma detecção nova sem risco). `criadoVia` é `"manual"` (padrão)
ou `"ia"` (quando o rascunho veio de `POST /ia/mapear`, seção 9).

| Código | Quando | Corpo |
|---|---|---|
| `201` | criado | o adaptador (formato acima) |
| `400` | `nome` ausente, `mapeamento`/`deteccao` inválidos, ou `modo` fora da lista | `{"error":"...", "detalhes"?: [...]}` |
| `403` | sessão sem papel admin | `{"error":"ação restrita a administradores"}` |
| `404` | projeto inexistente | `{"error":"projeto não encontrado"}` |
| `409` | já existe adaptador com esse nome no projeto | `{"error":"já existe um adaptador com esse nome neste projeto"}` |

### `PUT /api/projects/:id/adaptadores/:adaptadorId`

**Autenticação:** `requireAdmin`. Corpo: patch parcial de `nome`/`deteccao`/`mapeamento`/
`ativo`/`modo` — só o que vier é validado e alterado. `adaptadorId` precisa ser numérico
(`400` senão). `200` com o adaptador atualizado; `404` se não existir.

### `DELETE /api/projects/:id/adaptadores/:adaptadorId`

**Autenticação:** `requireAdmin`. `200 {"ok":true}` / `400` id não numérico / `404` não
encontrado.

### `POST /api/projects/:id/adaptadores/preview`

Mostra o Evento Interno resultante de um mapeamento contra uma amostra, **sem salvar
nada** — o coração da UI de mapeamento: o operador vê o resultado antes de aceitar.

```json
{ "mapeamento": {...}, "amostra": {...}, "deteccao": {...} }
```

`deteccao` é opcional — só para informar se a amostra teria sido reconhecida por essa
detecção (diagnóstico extra).

**`200`:**

```json
{
  "evento": { "event_name": "purchase", "event_id": "...", "user_data": {...}, "custom_data": {...} },
  "diagnostico": { "camposPreenchidos": ["event_id", "custom_data.value"], "camposVazios": ["user_data.phone"] },
  "validacao": { "valido": true, "erros": [] },
  "erroExecucao": null,
  "deteccaoBateu": true
}
```

Se `mapeamento` for inválido, `evento` vem `null` e `validacao.valido` é `false` — nunca
`500`. **`404`:** projeto inexistente.

### `POST /api/projects/:id/adaptadores/sugerir`

Mapeamento inicial **heurístico** (casamento por nome de campo — `email`, `telefone`,
`orderId`, `gclid`, ... contra uma tabela de padrões), **sem IA**. Devolve exatamente a
mesma **forma** de resposta que `POST /ia/mapear` (seção 9) — o editor do painel não
precisa saber qual dos dois caminhos gerou o rascunho. Nunca produz um `evento` capaz de
gerar `purchase` sozinho: o dicionário nasce vazio e sem `condicaoPagamento`.

```json
{ "amostraId": 41 }
```

ou `{ "amostra": { ... } }` (objeto direto, ex. colado manualmente pelo operador).

**`200`:**

```json
{
  "deteccao": { "obrigatorias": ["tipo_evento", "id_pedido"], "qualquerUma": ["cliente"] },
  "mapeamento": { "evento": { "de": "tipo_evento", "transformar": "mapear_valores", "args": { "dicionario": {} } }, "regras": [{ "de": "cliente.email", "para": "user_data.email", "transformar": "texto" }] },
  "diagnostico": {
    "camposReconhecidos": ["cliente.email"],
    "camposNaoReconhecidos": ["tipo_evento", "id_pedido"],
    "sugestaoCampoEvento": "tipo_evento",
    "sugestaoCampoStatus": null
  }
}
```

| Código | Quando | Corpo |
|---|---|---|
| `400` | nem `amostra` nem `amostraId` válido informado | `{"error":"informe \"amostra\" (objeto) ou \"amostraId\" de uma amostra existente"}` |
| `404` | `amostraId` não encontrado no projeto | `{"error":"amostra não encontrada"}` |

---

## 9. Painel — IA / OpenRouter

Toda esta seção é `requireAdmin`: a chave da OpenRouter é uma credencial de terceiro
(cobrada por chamada) e o resultado da IA muda o significado do dado de conversão — nada
disso é ação de operador. **O navegador nunca fala com a OpenRouter** — a CSP do painel
barra isso (`connect-src 'self'`), e `src/ia/openrouter.js` é o único ponto do backend que
monta a chamada, sempre para o host fixo `openrouter.ai` (nunca composto a partir de
configuração vinda de fora).

### `PUT /api/projects/:id/ia`

```json
{ "apiKey": "sk-or-v1-...", "modelo": "deepseek/deepseek-v4-flash", "habilitada": true }
```

- `apiKey` **ausente ou em branco (`""`)** mantém a chave atual — **diferente** do
  contrato de segredos da seção 0 (onde `""` apaga): aqui não existe um jeito de "desligar
  só a chave" pelo formulário, porque perder a chave por engano derrubaria a estruturação
  por IA em silêncio. Para desligar a IA, use `habilitada: false` (não mexe na chave).
- `modelo`/`habilitada` ausentes mantêm o valor atual.
- A chave nunca volta em nenhuma resposta — só a flag `hasIaKey`.

**`200`:** `publicProject` (o bloco `ia` reflete o novo estado). Salvar invalida o cache de
modelos deste projeto (a lista de `GET /ia/modelos` de uma chave anterior não pode
continuar sendo servida). **`404`:** projeto inexistente.

### `GET /api/projects/:id/ia/modelos`

Proxy server-side da lista de modelos da OpenRouter, para o `<select>` do painel.

**`200` (com chave configurada):**

```json
{
  "modelos": [
    { "id": "deepseek/deepseek-v4-flash", "nome": "DeepSeek v4 Flash", "contexto": 128000, "preco_prompt": 0.2, "preco_resposta": 0.6 }
  ],
  "cache": false
}
```

Ordenada por nome (`pt-BR`). `preco_prompt`/`preco_resposta` já convertidos para **USD por
milhão de tokens** (a OpenRouter devolve por token). Resposta cacheada em memória por
projeto por **5 minutos** (`cache: true` nas chamadas dentro da janela — não bate na
OpenRouter de novo).

| Código | Quando | Corpo |
|---|---|---|
| `400` | nenhuma chave configurada para o projeto | `{"error":"nenhuma chave da OpenRouter configurada para este projeto — salve uma chave antes de carregar os modelos"}` (nunca chega a chamar a OpenRouter) |
| `401` | a OpenRouter recusou a chave | `{"error":"a chave foi recusada pela OpenRouter — confira se ela foi copiada corretamente"}` |
| `402` | conta OpenRouter sem crédito | `{"error":"a conta da OpenRouter está sem crédito suficiente para esta chamada"}` |
| `429` | rate limit da OpenRouter | `{"error":"a OpenRouter limitou as requisições (rate limit) — aguarde um momento e tente de novo"}` |
| `502`/`504` | falha de rede/timeout (10s) | mensagem explicando |

### `POST /api/projects/:id/ia/mapear`

Estrutura uma amostra em mapeamento **via IA**. **Nunca salva nada** — devolve o rascunho
para o mesmo editor do modo nativo revisar; salvar de verdade continua sendo
`POST /projects/:id/adaptadores` (seção 8). A validação que roda ao salvar (`validarMapeamento`/
`validarDeteccao`, com a regra dura contra `purchase`) roda **também aqui**, sobre o que a
IA devolveu.

```json
{ "amostraId": 41 }
```

ou `{ "amostra": {...} }`.

**`200` — mapeamento válido:**

```json
{
  "mapeamento": { "evento": {...}, "regras": [{ "de": "cliente.email", "para": "user_data.email", "transformar": "texto" }] },
  "deteccao": { "obrigatorias": ["tipo", "id"], "qualquerUma": [] },
  "preview": { "event_name": "purchase", "user_data": { "email": "a@b.com" } },
  "validacao": { "valido": true, "erros": [] },
  "modelo": "deepseek/deepseek-v4-flash",
  "custo": { "promptTokens": 100, "completionTokens": 50, "custoUsd": 0.0005 },
  "promptVersao": "2026-08-mapeamento-v1"
}
```

**`200` — mapeamento inválido** (ex.: a IA propôs `purchase` sem condição de pagamento):
o rascunho **ainda é devolvido** (o operador precisa vê-lo para corrigir à mão), mas
`validacao.valido` vem `false` com a lista de erros — **não é um erro HTTP**, e nada é
persistido em nenhum dos dois casos.

`custo` é registrado em `ia_uso_mensal` sempre que a OpenRouter informou um valor,
**mesmo quando a validação reprova** o resultado — a chamada foi cobrada de qualquer jeito.
Se a IA não devolver JSON válido, o cliente tenta **uma retentativa** (pedindo
explicitamente só JSON); se a segunda também falhar, `502` com mensagem citando "JSON".

| Código | Quando | Corpo |
|---|---|---|
| `400` | sem chave configurada, sem modelo selecionado, ou `amostraId`/`amostra` ausentes/inválidos | `{"error":"..."}` |
| `404` | `amostraId` não encontrado | `{"error":"amostra não encontrada"}` |
| `401`/`402`/`429`/`502`/`504` | erro da OpenRouter (mesmo catálogo de `GET /ia/modelos`) | `{"error":"..."}` |

### `GET /api/projects/:id/ia/uso`

Custo estimado acumulado no **mês corrente**.

**`200`:** `{ "anoMes": "2026-08", "custoUsd": 0.0005, "chamadas": 1 }`. Granularidade
mensal; `custoUsd`/`chamadas` zerados quando não há uso no mês. **`404`:** projeto
inexistente.

---

## 10. Painel — tempo real

### `GET /api/projects/:id/stream` — Server-Sent Events

Alimentado por `LISTEN`/`NOTIFY` do Postgres — uma única assinatura por processo da API,
compartilhada por todos os clientes conectados (nunca uma conexão de banco por aba de
painel aberta). SSE, não WebSocket: HTTP puro, e o navegador (`EventSource`) já sabe
reconectar sozinho com backoff.

| | |
|---|---|
| **Autenticação** | `requireAuth` |
| **Cabeçalhos da resposta** | `Content-Type: text/event-stream`; `Cache-Control: no-cache, no-transform`; `Connection: keep-alive`; `X-Accel-Buffering: no` (evita que um proxy no caminho — Caddy, nginx — bufferize a resposta em rajadas) |
| **Heartbeat** | comentário SSE `: ping` a cada **25s** (`_config.heartbeatMs`), só para manter a conexão viva contra timeout de proxy ocioso — não é um evento, o navegador o ignora |
| **Limite de conexões** | **20 simultâneas**, somadas em toda a instância (não por projeto) |

Sem `id:` nos eventos, de propósito: implementar retomada de verdade por `Last-Event-ID`
exigiria guardar um backlog de eventos perdidos durante a desconexão — o módulo não faz
isso, e prometer uma retomada que não existe seria pior do que não prometer nada.

**Dois tipos de evento**, cada um com `event: <tipo>` seguido de `data: <json>`:

`evento_novo` — despachado quando um evento novo é gravado no projeto. `data` é o
registro completo de `events` (mesmo mascaramento de PII já aplicado na gravação —
`redactForStorage` roda antes de persistir, não aqui), com `received_at`/`occurred_at`
serializados em ISO:

```
event: evento_novo
data: {"id":"8a4f1e2c-...","project_id":"prj_a3f19c82b410","event_id":"purchase-8812","event_name":"purchase","source":"web","received_at":"2026-08-13T10:00:00.000Z", ...}

```

`entrega_atualizada` — despachado a cada mudança de status de uma entrega. `data` é o
registro completo de `deliveries`, com `last_error` truncado/mascarado (mesma função
`truncarEMascarar` da seção 8) — mas `response` (o corpo cru do destino) **sai como está**,
sem mascaramento, igual ao que `GET /projects/:id/events` já expõe hoje (não é uma
regressão desta rota, é o comportamento pré-existente reaproveitado):

```
event: entrega_atualizada
data: {"id":41,"event_row_id":"8a4f1e2c-...","destination_type":"meta","status":"success","http_status":200, ...}

```

| Código | Quando | Corpo |
|---|---|---|
| `200` | conexão aberta (fica aberta; a resposta nunca "termina") | stream SSE |
| `401` | sem cookie de sessão | `{"error":"não autenticado"}` |
| `404` | projeto inexistente | `{"error":"projeto não encontrado"}` |
| `503` | as 20 conexões simultâneas já estão em uso | `{"error":"limite de conexões de tempo real atingido — feche alguma aba do painel e tente de novo"}` |

Uma falha ao publicar a notificação (rede, Postgres sob pressão) nunca afeta a ingestão:
`publicar()` é *best-effort* e não lança — o evento já está gravado quando a tentativa de
notificação acontece.

---

## 11. Painel — perfil e usuários

### `GET /api/usuarios/me`

**Autenticação:** `requireAuth`. **`200`:**

```json
{
  "user": {
    "id": 1, "email": "admin@codigovencedor.com", "name": "Ana Beatriz",
    "firstName": "Ana", "lastName": "Beatriz", "avatar": null,
    "role": "admin", "createdAt": "2026-08-12T13:00:00.000Z", "lastLoginAt": "2026-08-13T09:00:00.000Z"
  }
}
```

### `PUT /api/usuarios/me`

```json
{ "firstName": "Ana", "lastName": "Beatriz", "avatar": "data:image/png;base64,..." }
```

Cada campo é tri-estado: **ausente** mantém o valor atual; **string vazia** limpa o campo
(`""` em `avatar` remove a foto); **valor** grava. `name` (a coluna que o resto do código
antigo lê — convite, e-mails, listagem de usuários) é **derivado** automaticamente como
`firstName + ' ' + lastName`.

**Regras do avatar:** precisa ser uma data-URI `data:image/(png|jpeg|webp);base64,...` —
qualquer outro tipo (inclusive SVG, que poderia carregar `<script>`) é rejeitado com `400`.
Teto de **128 KB** medido nos **bytes decodificados** do binário (não no tamanho da string
base64, que é ~33% maior). O redimensionamento para 256×256 acontece no navegador (canvas);
o servidor não confia nisso e valida os limites de novo.

**`200`:** `{ "user": {...} }` (mesmo formato de `GET /me`).

| Código | Quando | Corpo |
|---|---|---|
| `400` | avatar com MIME fora de PNG/JPEG/WEBP | `{"error":"avatar precisa ser uma imagem PNG, JPEG ou WEBP em data-URI (data:image/...;base64,...)"}` |
| `400` | avatar acima de 128 KB | `{"error":"avatar não pode passar de 128 KB (recebido <N> KB)"}` |

### `POST /api/usuarios/me/trocar-senha`

**Autenticação:** `requireAuth`. Sem corpo. **Não é um fluxo de autenticação novo** — só
dispara o e-mail de redefinição de senha (o mesmo fluxo de "esqueci minha senha", propósito
`redefinicao`) para o próprio e-mail do usuário logado. A definição da senha nova continua
em `POST /api/auth/definir-senha`.

**`200`** — quando o SMTP está configurado e o envio funciona: `{ "enviado": true }`.
Quando o SMTP **não está configurado**, o e-mail não sai mas a rota devolve o link mesmo
assim, para o admin repassar manualmente: `{ "enviado": false, "motivo": "SMTP não configurado", "urlRedefinicao": "https://.../definir-senha?token=..." }`.
Quando o SMTP está configurado mas o envio falha: `{ "enviado": false, "motivo": "<erro do driver de e-mail>" }`
— sem `urlRedefinicao` neste caso.

### Administração de usuários — `requireAdmin`

Diferente das rotas `/me` acima, tudo abaixo exige papel **admin**. A forma pública de um
usuário nestas rotas é enxuta de propósito (não traz foto nem sobrenome — só o que a
listagem de time precisa):

```json
{ "id": 3, "email": "operador@empresa.com", "name": "Fulana", "role": "operador",
  "status": "convite_pendente", "created_at": "...", "last_login_at": null }
```

`status` é derivado: `ativo` quando já existe senha definida, `convite_pendente` enquanto
não existe.

| Rota | O que faz |
|---|---|
| `GET /api/usuarios` | Lista todos os usuários. |
| `POST /api/usuarios` | Convida alguém. Corpo: `{ email, name, role }` (`role` padrão `operador`). Devolve `201 { user, conviteEnviado, urlConvite?, motivo? }` — o `urlConvite` só aparece quando o e-mail não pôde ser enviado, para o admin repassar o link à mão. Os demais admins são notificados por e-mail: controle de acesso é assunto de todos eles, não só de quem clicou. |
| `PUT /api/usuarios/:id` | Altera `name` e/ou `role`. Papel fora de `admin`/`operador` devolve `400`. |
| `DELETE /api/usuarios/:id` | Remove. Recusa com `400` remover a própria conta e recusa remover o **último admin** — um sistema sem administrador não teria como voltar a ter um. |
| `POST /api/usuarios/:id/reenviar-convite` | Reenvia o convite. `404` se o usuário não existe; `400` se ele já definiu a senha (o caminho certo aí é "esqueci minha senha"). Devolve `{ ok: true, enviado, urlConvite? }`. |

---

## 12. Painel — notificações

Base: `/api/notificacoes`. Toda a seção exige `requireAuth`; o catálogo é leitura liberada
para qualquer papel, o resto exige `requireAdmin`.

### `GET /api/notificacoes/catalogo`

Catálogo **fechado** de tipos de notificação — a mesma lista usada pelo motor de envio
(`src/notificacoes/motor.js`, que roda no worker) e pelo modal de assinatura do painel.

**`200`:** array de 6 entradas:

```json
[
  { "tipo": "entrega_morta", "rotulo": "Entregas mortas", "descricao": "...", "porProjeto": true },
  { "tipo": "falha_recorrente", "rotulo": "Falhas recorrentes", "descricao": "...", "porProjeto": true },
  { "tipo": "fila_acumulada", "rotulo": "Fila acumulada", "descricao": "...", "porProjeto": false },
  { "tipo": "dominio_problema", "rotulo": "Domínio com problema", "descricao": "...", "porProjeto": true },
  { "tipo": "resumo_diario", "rotulo": "Resumo diário", "descricao": "...", "porProjeto": true },
  { "tipo": "resumo_semanal", "rotulo": "Resumo semanal", "descricao": "...", "porProjeto": true }
]
```

`porProjeto: false` marca os tipos de sistema (hoje só `fila_acumulada`, porque a fila é
uma só, compartilhada por todos os projetos) — o painel não deve oferecer seletor de
projeto para eles.

### `GET /api/notificacoes/destinatarios`

**Autenticação:** `requireAdmin`. **`200`:** array de:

```json
{
  "id": 5, "nome": "Dono do Negócio", "email": "dono@fora-do-painel.com",
  "userId": null, "interno": false, "papel": null, "ativo": true,
  "createdAt": "2026-08-13T10:00:00.000Z",
  "assinaturas": [{ "tipo": "resumo_diario", "projectId": null }]
}
```

`interno: true` quando o destinatário está vinculado a um usuário do painel (`userId`
presente) — nesse caso `papel` traz o `role` daquele usuário. `token_descadastro`
**nunca** sai daqui: expô-lo na listagem admin daria a qualquer sessão com acesso de
leitura o poder de desinscrever qualquer destinatário.

### `POST /api/notificacoes/destinatarios`

```json
{ "nome": "Dono do Negócio", "email": "dono@fora-do-painel.com", "assinaturas": [{ "tipo": "resumo_diario", "projectId": null }] }
```

Destinatário **externo** (sem `userId`) — pessoa sem acesso ao painel, cadastrada só por
nome e e-mail. Com `userId` informado, o destinatário nasce **interno**: `nome`/`email`
vêm do usuário vinculado quando não informados no corpo, para os dois cadastros não
divergirem por um typo no modal. `assinaturas[].projectId = null` assina "todos os
projetos" (para os tipos com `porProjeto: true`).

| Código | Quando | Corpo |
|---|---|---|
| `201` | criado | `{ "destinatario": {...} }` |
| `400` | e-mail inválido, nome vazio, ou `userId` de usuário inexistente | `{"error":"..."}` |
| `409` | já existe destinatário com esse e-mail | `{"error":"já existe um destinatário com esse e-mail"}` |

### `PUT /api/notificacoes/destinatarios/:id`

```json
{ "nome": "Dono Renomeado", "assinaturas": [{ "tipo": "resumo_diario", "projectId": null }] }
```

`nome`/`email` ausentes mantêm o valor atual. Quando `assinaturas` vem no corpo, a lista
inteira é **substituída** (delete + insert) — não é um diff; reabrir o modal e salvar de
novo manda o conjunto completo. **`200`:** `{ "destinatario": {...} }`.

### `DELETE /api/notificacoes/destinatarios/:id`

`200 {"ok":true}` / `404 {"error":"destinatário não encontrado"}`.

### `POST /api/notificacoes/destinatarios/:id/teste`

Dispara um e-mail de teste para o destinatário, pelo mesmo motor que envia notificações
de verdade. **`200`:** `{ "enviado": true }`, ou `{ "enviado": false, "motivo": "SMTP não configurado" }` /
`{ "enviado": false, "motivo": "<erro do driver de e-mail>" }`. **`404`:** destinatário
inexistente.

### `GET /descadastro?token=...` — descadastro (rota pública, fora de `/api`)

Link de e-mail, um clique, **sem login**. Montada em `server.js` **fora** de `/api` de
propósito: não pode depender de CORS do painel nem de cookie de sessão — LGPD exige que
sair da lista de e-mails não dependa de fazer login.

| | |
|---|---|
| **Autenticação** | Nenhuma |
| **Content-Type da resposta** | `text/html; charset=utf-8` (página HTML minimalista, não JSON) |

Desativa o destinatário (`ativo = false`) — não apaga o cadastro, preservando o histórico
de envios e permitindo reativação manual pelo admin se a pessoa pedir para voltar.

| Código | Quando |
|---|---|
| `200` | token válido — página "Notificações canceladas" |
| `400` | token inválido, expirado ou já usado — página "Link inválido" |

---

## 13. Gate de TLS on-demand

### `GET /api/caddy/ask`

Consultado pelo Caddy antes de emitir um certificado, pela rede interna do compose
(`ask http://api:3000/api/caddy/ask`). É a **única** rota de `/api` fora da autenticação, e
responde **texto puro**, não JSON.

| Parâmetro de query | Obrigatório | Descrição |
|---|---|---|
| `domain` | sim | hostname do SNI. Normalizado (`trim` + minúsculas) |

Estar cadastrado no painel **não basta**: o gate exige que o hostname esteja `verified` ou
`active`. Um hostname ainda `pending` recebe uma **verificação de DNS ao vivo** e só é
promovido a `verified` (e autorizado) se já resolver para este servidor — o que evita o
impasse de precisar clicar em "Verificar DNS" no painel antes de o certificado poder sair.

| Código | Corpo | Quando |
|---|---|---|
| `200` | `ok` | `domain` igual ao `PUBLIC_HOST` (sem porta); **ou** hostname `verified`/`active` de projeto `active`; **ou** hostname `pending` cujo DNS já aponta para cá (promovido a `verified` na hora). Nos casos de hostname, o domínio é marcado `active` e recebe `ssl_issued_at` |
| `400` | `domínio ausente` | `domain` vazio ou não informado |
| `403` | `domínio não autorizado` | hostname não cadastrado, com `verification_status = 'failed'`, ou de projeto não-`active`. Gera `log('warn', 'emissão de certificado negada: domínio não cadastrado')` |
| `403` | `DNS não aponta para este servidor` | hostname `pending` cuja verificação ao vivo falhou. Gera `log('warn', 'emissão de certificado negada: DNS ainda não aponta para cá')` |

> Se esta rota ficar indisponível, o Caddy **para de emitir certificados novos**.
> Certificados já emitidos continuam servindo.

---

## 14. Saúde

### `GET /health`

Autenticação: nenhuma. É o alvo do `HEALTHCHECK` do Dockerfile.

| Código | Corpo |
|---|---|
| `200` | `{"ok":true,"uptime":3612,"db":true}` — `uptime` em segundos, arredondado |
| `503` | `{"ok":false,"db":false,"error":"connection terminated unexpectedly"}` |

### `GET /health/fila`

Autenticação: nenhuma. Mesmo corpo de `GET /api/fila`, sem exigir sessão — é o endpoint usado
pelo monitoramento externo.

| Código | Corpo |
|---|---|
| `200` | as mesmas sete chaves de `GET /api/fila` |
| `503` | `{"error":"<mensagem do banco>"}` |

---

## 15. Páginas e estáticos

| Rota | Resposta |
|---|---|
| `GET /painel` | `public/admin.html` |
| `GET /login` | `public/login.html` |
| `GET /definir-senha` | `public/definir-senha.html` — aceite de convite e redefinição de senha; o token vai na query string (`?token=...`), lido pelo front, que consulta `GET /api/auth/token/:token` e envia `POST /api/auth/definir-senha` |
| `GET /*` (arquivo existente em `public/`) | o arquivo (`Cache-Control: 1h` em produção) |
| `GET /api/*` não reconhecido | `404 {"error":"rota não encontrada"}` |
| qualquer outra rota | `404` com `public/index.html` (a landing) |

---

## 16. Exemplos `curl`

### Enviar um evento do navegador (sem autenticação)

```bash
curl -i -X POST https://traker.codigovencedor.com/e/k7m2vqbz \
  -H "Content-Type: application/json" \
  -d '{
    "event_name": "purchase",
    "event_id": "purchase-8812",
    "page_location": "https://codigovencedor.com/obrigado",
    "user_id": "42",
    "user_data": {
      "email": "cliente@exemplo.com",
      "phone": "11988887777",
      "fbp": "fb.1.1785900000000.1029384756",
      "fbc": "fb.1.1785900000000.IwAR0abcdef"
    },
    "custom_data": { "value": 199.9, "currency": "BRL", "order_id": 8812 },
    "consent_state": {
      "ad_storage": "granted", "analytics_storage": "granted",
      "ad_user_data": "granted", "ad_personalization": "granted"
    }
  }'
```

Resposta esperada: `202` com `{"status":"accepted","id":"<uuid>","event_id":"purchase-8812","event_name":"purchase","destinations":["meta","google"]}`.
Repetir o mesmo comando devolve `{"status":"duplicate",...}` — é a prova de que a
idempotência de ingestão funciona.

### Simular o `sendBeacon` (payload como `text/plain`, sem preflight)

```bash
curl -i -X POST https://traker.codigovencedor.com/e/k7m2vqbz \
  -H "Content-Type: text/plain" \
  -H "Origin: https://codigovencedor.com" \
  --data-raw '{"event_name":"page_view","page_location":"https://codigovencedor.com/"}'
```

### Enviar uma conversão por webhook autenticado (Fluxo C)

```bash
INGEST_TOKEN="6b1f9a0c4d7e2381ab55c9f0e4d13a72c8b6e5f419d0a7c3"

curl -i -X POST https://traker.codigovencedor.com/e/k7m2vqbz \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -d '{
    "event_name": "purchase",
    "user_id": "42",
    "user_data": { "email": "cliente@exemplo.com" },
    "custom_data": { "order_id": 8812, "value": 199.9, "currency": "BRL" }
  }'
```

Sem `event_id`, o servidor deriva `purchase-8812` a partir do `order_id` — o **mesmo** id que
o navegador geraria, então a Meta deduplica. `fbc`, `fbp`, `gclid` e os `utm_*` que o backend
não conhece são completados pela ponte de identidade a partir do `user_id` — e, por ser
webhook, `client_ip_address` e `client_user_agent` são **substituídos** pelos do navegador,
em vez de ficarem com o IP do servidor que fez este `curl`.

Token errado devolve `401 {"error":"token de ingestão inválido"}`.

Conferindo o efeito da ponte (o evento gravado deve ter o IP do visitante, não o do chamador):

```bash
curl -s -b cookies.txt "$BASE/api/projects/prj_a3f19c82b410/emq?days=7" \
  | jq '.coverage[] | select(.field=="client_ip_address" or .field=="fbc")'
```

### Coletar identidade (Fluxo B)

```bash
curl -i -X POST https://traker.codigovencedor.com/c/k7m2vqbz \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "42",
    "fbclid": "IwAR0abcdef",
    "fbp": "fb.1.1785900000000.1029384756",
    "gclid": "Cj0KCQjw",
    "utm_source": "meta",
    "utm_campaign": "black-friday",
    "landing_page": "https://codigovencedor.com/?fbclid=IwAR0abcdef"
  }'
```

Resposta esperada: `202 {"status":"stored"}`. Sem `user_id`, responde
`202 {"status":"ignored","reason":"sem user_id"}` — e isso não é erro.

### Login e consulta de logs (fluxo completo do painel)

```bash
BASE="https://traker.codigovencedor.com"

# 1. Login — guarda o cookie de sessão em cookies.txt
curl -s -c cookies.txt -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@codigovencedor.com","password":"senha-forte"}'

# 2. Confirma a sessão
curl -s -b cookies.txt "$BASE/api/auth/me"

# 3. Lista os projetos
curl -s -b cookies.txt "$BASE/api/projects"

# 4. Últimos 50 eventos do projeto, com o status por destino
curl -s -b cookies.txt "$BASE/api/projects/prj_a3f19c82b410/events?limit=50"

# 5. Métricas do período
curl -s -b cookies.txt \
  "$BASE/api/projects/prj_a3f19c82b410/metrics?from=2026-08-01&to=2026-08-12"

# 6. Diagnóstico de cobertura de campos (EMQ) dos últimos 14 dias
curl -s -b cookies.txt "$BASE/api/projects/prj_a3f19c82b410/emq?days=14"

# 7. Reenviar um evento que morreu (id = events.id, o UUID)
curl -s -b cookies.txt -X POST \
  "$BASE/api/events/8a4f1e2c-91b7-4d0a-b3e6-2f5c1d7a9e40/requeue"

# 8. Sair
curl -s -b cookies.txt -X POST "$BASE/api/auth/logout"
```

Filtrando só o que interessa no log de eventos, com `jq`:

```bash
curl -s -b cookies.txt "$BASE/api/projects/prj_a3f19c82b410/events?limit=200" \
  | jq '.[] | select(.destinations.meta.status == "dead")
        | { event_id, event_name, erro: .destinations.meta.response.error }'
```

### Configurar o destino Meta (o token só é transmitido uma vez)

```bash
# Primeira gravação: manda o access token
curl -s -b cookies.txt -X PUT "$BASE/api/projects/prj_a3f19c82b410/meta" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"pixelId":"1234567890123456","accessToken":"EAAB..."}'

# Alterações seguintes: OMITE accessToken — o valor cifrado é mantido
curl -s -b cookies.txt -X PUT "$BASE/api/projects/prj_a3f19c82b410/meta" \
  -H "Content-Type: application/json" \
  -d '{"testEventCode":"TEST12345"}'

# Apagar a credencial: string vazia
curl -s -b cookies.txt -X PUT "$BASE/api/projects/prj_a3f19c82b410/meta" \
  -H "Content-Type: application/json" \
  -d '{"accessToken":""}'
```

### Configurar o destino Google na rota Google Ads API

```bash
curl -s -b cookies.txt -X PUT "$BASE/api/projects/prj_a3f19c82b410/google" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "route": "google_ads",
    "clientId": "1234-abc.apps.googleusercontent.com",
    "clientSecret": "GOCSPX-...",
    "refreshToken": "1//0g...",
    "developerToken": "abcDEF...",
    "customerId": "123-456-7890",
    "conversionActions": {
      "purchase": "customers/1234567890/conversionActions/987654321",
      "default":  "customers/1234567890/conversionActions/987654321"
    }
  }'
```

Depois de disparar um evento de teste, o resultado do upload aparece no log de eventos:

```bash
curl -s -b cookies.txt "$BASE/api/projects/prj_a3f19c82b410/events?limit=20" \
  | jq '.[] | { event_id, google: .destinations.google }'
```

Falha de configuração aparece como `"status":"dead"` com
`"error":"Google Ads não configurado: faltam ..."`; developer token não aprovado aparece
como `"error":"OAuth falhou: ..."`.

### Onboarding de um domínio de cliente

```bash
# Descobre o alvo a informar ao cliente (host e IPs deste servidor)
curl -s -b cookies.txt "$BASE/api/servidor"

# Cadastra o subdomínio first-party do cliente
curl -s -b cookies.txt -X POST "$BASE/api/projects/prj_a3f19c82b410/domains" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"ct.clientex.com.br","pointingMethod":"cname"}'

# Verifica se o DNS já aponta para cá (id da linha devolvida acima)
curl -s -b cookies.txt -X POST \
  "$BASE/api/projects/prj_a3f19c82b410/domains/8/verify"

# Simula o que o Caddy pergunta antes de emitir o certificado
# 200 = autorizado; 403 "domínio não autorizado" = não cadastrado/failed/projeto inativo;
# 403 "DNS não aponta para este servidor" = cadastrado, mas o DNS ainda não resolve para cá
curl -s -w '\n%{http_code}\n' "$BASE/api/caddy/ask?domain=ct.clientex.com.br"
```

### Monitoramento (sem sessão)

```bash
curl -s https://traker.codigovencedor.com/health
curl -s https://traker.codigovencedor.com/health/fila
```
