---
title: Arquitetura do Servidor Traker
tags: [arquitetura, referencia, postgres, fila, multi-tenancy, seguranca, itp, dedup, servidor-traker]
created: 2026-08-12
updated: 2026-08-25
---

# Arquitetura do Servidor Traker

Referência do sistema **como construído**. Onde este documento e o
`Blueprint-Arquitetural.md` divergirem, vale o que está aqui — o código é a verdade. As
divergências conhecidas estão listadas na seção 10.

---

## 1. Topologia de processos

```
                              Internet (portas 80/443)
                                        │
                        ┌───────────────▼────────────────┐
                        │  caddy  (caddy:2-alpine)       │
                        │  · TLS automático              │
                        │  · TLS on-demand p/ domínio    │
                        │    de cliente, com gate `ask`  │
                        │  · header_up X-Real-IP         │
                        └───────────────┬────────────────┘
                                        │ reverse_proxy api:3000
                     rede interna do compose (bridge, sem portas no host)
                                        │
              ┌─────────────────────────┴─────────────────────────┐
              │                                                   │
    ┌─────────▼──────────┐                             ┌──────────▼─────────┐
    │  api               │                             │  worker            │
    │  npm start         │                             │  npm run worker    │
    │  src/server.js     │                             │  src/worker.js     │
    │                    │                             │                    │
    │  aceita → normaliza│                             │  claim → envia →   │
    │  → grava → 202     │                             │  marca resultado   │
    │  NUNCA fala com    │                             │  fala com Meta,    │
    │  Meta/Google       │                             │  Google, postback  │
    └─────────┬──────────┘                             └──────────┬─────────┘
              │                                                   │
              └───────────────────────┬───────────────────────────┘
                                      │
                          ┌───────────▼────────────┐
                          │  db  postgres:16-alpine│
                          │  · configuração        │
                          │  · identidades         │
                          │  · eventos             │
                          │  · A FILA (deliveries) │
                          └────────────────────────┘
```

**Ambos os processos rodam a mesma imagem** (`servidor-traker:latest`), mudando só o
comando. Ambos aplicam migrações no boot (`runMigrations()`), então tanto faz quem sobe
primeiro. Só o Caddy publica portas no host: `api`, `worker` e `db` existem apenas na rede
interna do compose, de modo que nem um Security List frouxo na OCI abre caminho direto para
o Postgres.

### Por que api e worker são processos separados

O requisito número um da ingestão é **latência baixa e previsível**: a requisição sai do
navegador do visitante enquanto ele navega, e um `sendBeacon` que demora pode ser cortado
pela troca de página. A Meta, em contrapartida, é uma API de terceiro que pode levar
segundos ou ficar indisponível.

Separando os dois, uma lentidão da Meta se manifesta como **fila crescendo**, não como
página lenta no site do cliente. A API responde `202 Accepted` assim que o evento está
durável no Postgres; o envio é problema do worker. Como consequência, `MAX_ATTEMPTS`, o
backoff e o timeout de 15s por destino podem ser generosos sem custo nenhum para o
visitante.

O isolamento também é de falha: `docker compose restart worker` durante um incidente de
entrega não derruba a ingestão, e nenhum evento se perde — ele já está no banco.

### Por que não há Redis

O blueprint previa Redis para fila, rate-limit e cache de resolução de tenant. A
implementação **não usa Redis**. A fila é a própria tabela `deliveries`, drenada com
`SELECT ... FOR UPDATE SKIP LOCKED` (seção 5). Motivos:

- **Durabilidade de graça.** O evento e as suas entregas nascem na **mesma transação**
  (`recordEvent`). Com Redis haveria duas escritas em sistemas diferentes e a janela
  clássica: "gravei o evento, morri antes de enfileirar".
- **Um componente a menos** para operar, monitorar, fazer backup e explicar no runbook. A
  única fonte de estado do sistema passa a ser o Postgres.
- **O volume comporta.** O custo é um `UPDATE ... RETURNING` a cada `WORKER_POLL_MS`
  (padrão 1s) sustentado por um índice parcial. Para a ordem de grandeza deste serviço
  (milhões de eventos/mês em uma instância pequena) isso é ruído.
- **`SKIP LOCKED` já resolve concorrência.** Vários workers em paralelo nunca pegam a mesma
  linha; a garantia é do banco, não do código.

O preço pago está registrado como dívida na seção 11: latência mínima de entrega ≈ 1 poll, e
rate limit em memória por processo (sem Redis não há contador compartilhado).

---

## 2. O Evento Interno canônico

`src/ingest/normalize.js` → `normalizeEvent(body, { clientIp, userAgent, source, cookies })`
produz o **único** formato do qual derivam todos os payloads de saída. Meta, GA4 e postback
leem deste objeto e de mais nada.

```js
{
  event_id,          // do cliente, ou derivado de order_id, ou UUID  (deriveEventId)
  event_name,        // NOME DO SITE, pré-mapeamento (ex.: "purchase")
  event_time,        // epoch em segundos, saneado (ver abaixo)
  source,            // "web" | "webhook"
  event_source_url,  // page_location | event_source_url | url        (string, '' se ausente)
  action_source,     // do payload, ou "website" (web) / "system_generated" (webhook)
  user_id,           // body.user_id | user_data.user_id | user_data.external_id

  user_data: {
    // --- PII CRUA nesta etapa. Normalizada e hasheada só na montagem de cada destino,
    //     porque cada plataforma tem regra própria.
    email, phone, first_name, last_name, city, state, zip, country,
    external_id,     // cai para user_id quando não informado

    // --- Identificadores de navegador: NUNCA hasheados, formato exato do cookie.
    //     Ordem de precedência: payload explícito > atalho no corpo > cookie da requisição.
    fbp,             // u.fbp | b.fbp | cookies._fbp
    fbc,             // u.fbc | b.fbc | cookies._fbc
    fbclid,
    gclid,           // u.gclid | b.gclid | gclidFromCookie(cookies._gcl_aw)
    ga_client_id,    // u.ga_client_id | b.ga_client_id | gaClientIdFromCookie(cookies._ga)
    gbraid, wbraid,
    ttclid, ttp,     // ttp cai para cookies._ttp
    clickid, tblci,

    utm_source, utm_medium, utm_campaign, utm_content, utm_term,

    // --- SEMPRE do servidor, jamais do que o cliente enviou.
    client_ip_address,
    client_user_agent
  },

  custom_data,       // repassado como veio (value, currency, order_id, content_ids, ...)
  consent_state: { ad_storage, analytics_storage, ad_user_data, ad_personalization },
                     // cada campo: "granted" | "denied" | undefined (true/false aceitos na entrada)
  page: { path, title, referrer }
}
```

Regras embutidas na normalização, todas com consequência prática:

- **`event_time` saneado.** Aceita o horário do cliente apenas dentro da janela
  `(agora − 7 dias, agora + 60s]`. Fora disso usa a hora do servidor. A Meta rejeita eventos
  com mais de 7 dias e não aceita futuro; relógio de cliente desregulado é comum.
- **IP e User-Agent nunca vêm do corpo.** `extractClientIp(req)` lê `X-Forwarded-For`
  (primeiro da cadeia) ou `X-Real-IP` **somente quando `TRUST_PROXY=true`**; caso contrário
  usa `req.socket.remoteAddress`. IPv4 mapeado em IPv6 (`::ffff:187.1.2.3`) é normalizado.
- **`first(...)`** ignora `undefined`, `null` e string vazia — string vazia nunca "ganha" de
  um valor bom por acidente.
- **Cookie como fallback.** Se o JavaScript não conseguiu ler `_fbp`/`_fbc` (ITP,
  bloqueador, contexto restrito), o valor ainda chega pelo header `Cookie` da própria
  requisição, porque o endpoint é first-party.
- **Cookies do Google são desembrulhados, não copiados.** `_gcl_aw` guarda
  `GCL.<timestamp>.<gclid>` e `_ga` guarda `GA1.1.<client_id>` — nenhum dos dois carrega o
  valor puro. `gclidFromCookie()` e `gaClientIdFromCookie()` extraem a parte útil. Mandar o
  cookie bruto adiante faz o Google **aceitar** a conversão e simplesmente não casá-la com
  clique nenhum, e faz o GA4 tratar cada evento como um usuário novo.

### Por que um formato único

Sem ele, cada destino leria o payload cru do cliente e cada um implementaria sua própria
tolerância a `em` vs. `email` vs. `user_data.email`. Com ele:

1. **A regra de correspondência é escrita uma vez.** Quem quiser adicionar TikTok Events API
   escreve só o tradutor de saída — nenhuma mudança em ingestão, banco ou fila.
2. **O que é persistido é o Evento Interno**, então reprocessar (`requeue`) monta o payload
   de novo a partir da mesma verdade, e não de um payload de destino já congelado.
3. **A dedup fica auditável.** `event_id` e `event_name` do site existem em um lugar só; a
   tradução para `Purchase` acontece na borda de saída, onde dá para conferir.

### `applyConsent` + `redactForStorage` — o que o banco realmente guarda

O evento passa por **duas** transformações antes do `INSERT`, nesta ordem.

Primeiro `applyConsent(event)`, uma única vez, na ingestão. Com `ad_user_data = "denied"`
(ou com o sinal ausente e `STRICT_CONSENT=true`), os nove campos de PII — `email`, `phone`,
`first_name`, `last_name`, `external_id`, `city`, `state`, `zip`, `country` — são
**removidos do objeto**, e o que for gravado não os terá. Com
`ad_personalization = "denied"`, o evento é mantido e recebe o flag `limitedDataUse`, que
vira `data_processing_options: ["LDU"]` no payload da Meta. O resultado fica em
`event._consentFlags` (`stripPII`, `limitedDataUse`, `consentMissing`).

Aplicar aqui, e não na montagem de cada destino, tem duas consequências desejadas: o log de
eventos nunca guarda PII de um titular que negou consentimento, e um destino novo não
precisa lembrar de repetir a regra. Os destinos ainda chamam `applyConsent` sobre o payload
lido do banco — é idempotente e serve de defesa em profundidade para eventos gravados antes
desta mudança.

Depois `redactForStorage(event, hashers)` substitui `email`, `phone`,
`first_name`, `last_name`, `city`, `state`, `zip` e `country` pelos respectivos hashes
SHA-256 (`hashPII`, `hashPhone`, `hashZip`, `hashCountry`). Os identificadores de navegador
continuam em claro — não são PII direta e são necessários para reprocessar.

Como todas as funções de hash detectam um valor que **já** é hex de 64 caracteres e o
devolvem intacto, o hash é idempotente: o destino pode chamar `hashPII` de novo sobre o
valor lido do banco sem produzir "hash de hash".

> **Atenção:** `external_id` **não** está no mapa de redação — ele é persistido em claro
> (normalmente é o `user_id` do site) e hasheado apenas na saída, já normalizado
> (`trim` + minúsculas), que é a forma que o Pixel do navegador também usa no Advanced
> Matching. Divergir na normalização entre os dois lados quebraria o match.

---

## 3. O caminho completo de um evento

```
 (1) POST /e/:slug                                    src/ingest/router.js  handleIngest
      │
      ├─ resolveProject(req) ──────────────────────── projects.js  getProjectBySlug / getProject
      │     404 se não existe ou status !== 'active'
      │
      ├─ applyCors(req, res, project) ─────────────── reflete Origin se allowedOrigins permitir
      │
      ├─ detectSource(req, project) ───────────────── Bearer? compara com safeEqual(ingestToken)
      │     sem Bearer  ⇒ { source:'web',     authenticated:true  }
      │     Bearer ok   ⇒ { source:'webhook', authenticated:true  }
      │     Bearer ruim ⇒ 401
      │
      ├─ rateLimit(`ingest:${project.id}`) ────────── rate-limit.js  → 429
      │
      ├─ Origin declarada e fora de project.allowedOrigins? ──────── 403
      │     (recusa no servidor; o cabeçalho CORS sozinho não impede nada)
      │
      ├─ parseBody(req) ───────────────────────────── aceita JSON e text/plain (sendBeacon)
 (2)  ├─ validarPayload(body) ─────────────────────── router.js → 400 com o motivo
      │     corpo não-objeto · event_name ausente/vazio/>100 chars · event_id >200 chars
      │     · user_data ou custom_data que não sejam objeto
      │
      ├─ extractClientIp(req) / headers['user-agent'] / parseCookies(headers.cookie)
      │
 (3)  ├─ normalizeEvent(...) ────────────────────────  normalize.js → Evento Interno
      │
 (4)  ├─ enrichFromIdentity(event, project.id) ─────── router.js + identities.js getIdentity
      │     preenche APENAS lacunas (undefined/null/'') a partir de identities.params
      │     EXCEÇÃO source === 'webhook': SOBRESCREVE client_ip_address e
      │     client_user_agent com os valores guardados pela ponte
      │     marca event._enrichedFromIdentity = true
      │
 (5)  ├─ refreshFirstPartyCookies(req, res, user_data) cookies.js → Set-Cookie _fbp/_fbc
      │     Max-Age=COOKIE_MAX_AGE_DAYS, Domain=.dominio-registravel, SameSite=Lax,
      │     Secure quando https, SEM HttpOnly (o Pixel precisa ler via JS)
      │
 (6)  ├─ destinationTypes = ['meta','google','postback'].filter(enabled)
      │
 (7)  ├─ applyConsent(event) ────────────────────────  consent.js
      │     ad_user_data denied (ou ausente com STRICT_CONSENT) ⇒ remove os 9 campos de PII
      │     ad_personalization denied ⇒ flag limitedDataUse (vira LDU no payload da Meta)
      │
      ├─ redactForStorage(permitido, {hashPII,hashPhone,hashZip,hashCountry})
      │
 (8)  ├─ recordEvent({ project, event: stored, destinationTypes })   events.js
      │     BEGIN
      │       INSERT INTO events ... ON CONFLICT (project_id,event_id,event_name) DO NOTHING
      │       se conflitou ⇒ SELECT id  →  { duplicate:true }   (não cria entregas)
      │       senão ⇒ para cada destino: INSERT INTO deliveries ... ON CONFLICT DO NOTHING
      │     COMMIT
      │
 (9)  └─ 202 { status:'accepted'|'duplicate', id, event_id, destinations }
────────────────────────────────────────────────────────────────────────────────────────
(10) worker.js  laço drenar()                          a cada WORKER_POLL_MS (1s)
      │
      ├─ claimDeliveries(WORKER_CONCURRENCY) ───────── events.js
      │     UPDATE deliveries SET status='processing', locked_at=now(), attempts=attempts+1
      │      WHERE id IN (SELECT id ... WHERE status IN ('pending','error')
      │                     AND next_attempt_at <= now()
      │                   ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      │     RETURNING *      → depois carrega os eventos correspondentes
      │
(11)  └─ processDelivery({delivery, event}) ─────────── queue/dispatcher.js
            ├─ evento sumiu?            → skipped_unmapped
            ├─ projeto removido?        → skipped_unmapped
            ├─ destino desligado agora? → skipped_unmapped   (pode ter mudado na fila)
            ├─ isBlockedByConsent()?    → skipped_consent
            │     (ad_storage='denied' E analytics_storage='denied')
            │
            ├─ SENDERS[type](payload, project)
            │     meta     → destinations/meta.js       buildMetaPayload
            │     google   → destinations/google.js     route 'ga4_mp' (buildGa4Payload)
            │                 └─ 'google_ads' → destinations/google-ads.js
            │                    OAuth2 + UploadClickConversions
            │     postback → destinations/postback.js   filtro de evento + interpolação
            │
            ├─ result.skipped ⇒ markDeliverySkipped(reason)
            ├─ result.ok      ⇒ markDeliverySuccess(httpStatus, response)
            └─ senão          ⇒ markDeliveryFailure({ retriable, attempts })
                                  → 'error' com backoff, ou 'dead'
```

O que está gravado em `events.payload` já é o evento **pós-consentimento** e com PII
hasheada: se o titular negou `ad_user_data`, não há PII nenhuma no banco para nenhum destino
ler. Os três destinos ainda chamam `applyConsent` sobre esse payload — a operação é
idempotente e cobre eventos gravados antes desta regra existir.

---

## 4. Modelo de dados

Sete tabelas, todas criadas por `src/db/migrations/001_init.sql`. Multi-tenant por linha:
toda tabela de dado carrega `project_id`.

### `users` — operadores do painel

| Coluna | Tipo | Papel |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `email` | TEXT UNIQUE | normalizado para minúsculas em `createUser` |
| `password_hash` | TEXT | formato `scrypt:<salt b64>:<derivado b64>` (sem dependência nativa) |
| `name`, `role` | TEXT | `role` default `'admin'` — **não é verificado em lugar nenhum hoje** |
| `created_at`, `last_login_at` | TIMESTAMPTZ | |

### `sessions` — sessão do painel

| Coluna | Tipo | Papel |
|---|---|---|
| `token_hash` | TEXT **PK** | SHA-256 do token opaco. O token em si só existe no cookie do navegador — um dump do banco não permite sequestrar sessão ativa. |
| `user_id` | BIGINT FK → `users` ON DELETE CASCADE | |
| `expires_at` | TIMESTAMPTZ | `now() + SESSION_TTL_HOURS`; indexado (`sessions_expires_idx`) para o expurgo do worker |
| `user_agent`, `ip` | TEXT | auditoria; UA truncado em 300 chars |

### `projects` — um site rastreado

| Coluna | Tipo | Papel |
|---|---|---|
| `id` | TEXT **PK** | `prj_` + 6 bytes hex (`prj_a3f19c82b410`) |
| `name` | TEXT | cai para o domínio quando vazio |
| `domain` | TEXT UNIQUE | site principal, sanitizado (sem esquema, sem path, minúsculas) |
| `slug` | TEXT UNIQUE | caminho de ingestão anti-adblock, 8 chars do alfabeto `23456789bcdfghjkmnpqrstvwxyz` |
| `status` | TEXT | `active` \| `paused`. `paused` faz `/e/`, `/c/` e os scripts responderem 404 e derruba a autorização de TLS. |
| `ingest_token` | TEXT | Bearer do webhook S2S. **Guardado em claro** (ver seção 11). |
| `allowed_origins` | TEXT[] | usado apenas por `applyCors`; lista vazia = reflete qualquer Origin |

### `project_domains` — domínios first-party

| Coluna | Tipo | Papel |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `project_id` | TEXT FK → `projects` CASCADE | |
| `hostname` | TEXT **UNIQUE global** | um hostname pertence a um projeto só, em todo o sistema |
| `pointing_method` | TEXT | `a_record` \| `cname` — informativo, guia a instrução exibida no painel |
| `verification_status` | TEXT | `pending` \| `verified` \| `active` \| `failed` |
| `is_primary` | BOOLEAN | o domínio criado junto com o projeto nasce `true` |
| `last_checked_at`, `last_error` | | resultado da última verificação de DNS |
| `ssl_issued_at` | TIMESTAMPTZ | carimbado quando o Caddy pede e recebe autorização em `/api/caddy/ask` |

### `destinations` — configuração por destino

| Coluna | Tipo | Papel |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `project_id` | TEXT FK CASCADE | |
| `type` | TEXT | `meta` \| `google` \| `postback` |
| `enabled` | BOOLEAN | nasce `false`; consultado **duas vezes** (na ingestão, para criar a entrega; e no worker, porque pode ter sido desligado no meio) |
| `config` | JSONB | **o que é público**: `pixelId`, `testEventCode`, `measurementId`, `route`, `customerId`, `eventMap`, `url`/`method`/`headers`/`events` do postback |
| `credentials_enc` | JSONB | **o que é segredo**, cifrado individualmente: `{"access_token":"v1:<iv>:<tag>:<ciphertext>"}`. O banco nunca vê o valor em claro. |
| — | UNIQUE `(project_id, type)` | um destino de cada tipo por projeto; é a chave do `ON CONFLICT` do `updateDestination` |

Três linhas são criadas junto com o projeto, desligadas, já com `eventMap` padrão
(`DEFAULT_META_MAP`, `DEFAULT_GA4_MAP`) e a lista padrão de eventos do postback — o sistema
funciona "de fábrica" assim que o operador preenche o pixel e o token.

### `identities` — a ponte de identidade

| Coluna | Tipo | Papel |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `project_id` | TEXT FK CASCADE | |
| `user_key` | TEXT | o `user_id` do site do cliente |
| `params` | JSONB | só chaves de `MARKETING_KEYS` (lista fechada — o coletor não vira canal de gravação arbitrária) |
| `first_seen_at`, `last_seen_at` | TIMESTAMPTZ | `last_seen_at` indexado |
| — | UNIQUE `(project_id, user_key)` | chave do merge atômico |

O merge é feito **no banco**, não no Node:

```sql
INSERT INTO identities (project_id, user_key, params) VALUES ($1,$2,$3::jsonb)
ON CONFLICT (project_id, user_key) DO UPDATE
   SET params = identities.params || EXCLUDED.params, last_seen_at = now()
```

`saveIdentity` remove antes qualquer chave vazia do lado novo, de modo que `||` **nunca
sobrescreve um valor bom com vazio**. Isso importa porque o visitante volta por tráfego
direto na segunda visita: sem essa regra, a segunda visita apagaria o `fbclid` da primeira e
destruiria a atribuição.

### `events` — log de eventos recebidos

| Coluna | Tipo | Papel |
|---|---|---|
| `id` | UUID PK `gen_random_uuid()` | chave usada por `deliveries` e pelo requeue do painel |
| `project_id` | TEXT FK CASCADE | |
| `event_id` | TEXT | o id de dedup (do cliente, derivado ou UUID) |
| `event_name` | TEXT | nome do **site**, pré-mapeamento |
| `source` | TEXT | `web` \| `webhook` |
| `occurred_at` | TIMESTAMPTZ | `event_time` do cliente convertido |
| `received_at` | TIMESTAMPTZ | `now()` no INSERT; base de todas as métricas e do expurgo |
| `client_ip` | TEXT | IP do visitante (desnormalizado de `payload.user_data`) |
| `utm_source`, `value`, `currency` | | desnormalizados **só** para o dashboard não varrer JSONB em toda consulta. `value` é `NUMERIC(14,2)`. |
| `payload` | JSONB | **o Evento Interno pós-consentimento**, com PII hasheada por `redactForStorage`. Titular que negou `ad_user_data` não deixa PII aqui |
| `consent` | JSONB | cópia do `consent_state` |
| — | UNIQUE `(project_id, event_id, event_name)` | **idempotência de ingestão** |

Índices: `(project_id, received_at DESC)` para a tela de logs e as métricas; `(received_at)`
para o expurgo por retenção.

### `deliveries` — a fila, a auditoria e a tela de logs, na mesma tabela

| Coluna | Tipo | Papel |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `event_row_id` | UUID FK → `events(id)` CASCADE | expurgo de evento leva as entregas junto |
| `project_id` | TEXT FK CASCADE | |
| `destination_type` | TEXT | `meta` \| `google` \| `postback` |
| `status` | TEXT | `pending` \| `processing` \| `success` \| `error` \| `dead` \| `skipped_consent` \| `skipped_unmapped` |
| `attempts` | INT | incrementado **no claim**, não na falha |
| `next_attempt_at` | TIMESTAMPTZ | default `now()`; empurrado pelo backoff |
| `locked_at` | TIMESTAMPTZ | carimbado no claim, limpo em qualquer desfecho; base da recuperação de entregas presas |
| `http_status`, `response`, `last_error` | | resultado, mostrado no painel |
| — | UNIQUE `(event_row_id, destination_type)` | **idempotência de entrega** |

Índices: `deliveries_queue_idx ON (next_attempt_at) WHERE status IN ('pending','error')` —
índice **parcial**, que é o que faz o polling do worker custar quase nada mesmo com milhões
de linhas já entregues; mais `(event_row_id)` e `(project_id, status)`.

### O papel das duas constraints de unicidade

Idempotência aqui é **garantia do banco**, não disciplina de código. Duas linhas de DDL
substituem toda uma classe de bug de concorrência:

**`events(project_id, event_id, event_name)`** — nenhum caminho de entrada consegue criar o
mesmo evento duas vezes. Cobre, sem código extra: retry do `sendBeacon` quando a página
fecha, double-fire de tag mal configurada no GTM, o cliente reenviando o webhook porque o
timeout dele estourou, e o navegador **e** o backend mandando o mesmo `purchase` (que
derivam o mesmo `event_id` a partir do `order_id`). O `ON CONFLICT DO NOTHING` faz a segunda
tentativa não criar evento **nem entregas**, e a resposta é `202 { status: "duplicate" }` —
idempotente do ponto de vista de quem chamou.

**`deliveries(event_row_id, destination_type)`** — um evento nunca gera duas entregas para o
mesmo destino, mesmo que `recordEvent` seja chamado em corrida ou que a lista de destinos
mude. A garantia relevante: **o requeue do painel reutiliza a linha existente** (`UPDATE
... SET status='pending'`), não cria outra. Não existe caminho em que dois workers postem o
mesmo evento no mesmo pixel — e, se existisse, a dedup da Meta pelo `event_id` seguraria.
Defesa em profundidade.

---

## 5. Como a fila funciona

### Reivindicação: `claimDeliveries(limit)`

```sql
UPDATE deliveries
   SET status = 'processing', locked_at = now(), attempts = attempts + 1, updated_at = now()
 WHERE id IN (
       SELECT id FROM deliveries
        WHERE status = ANY(ARRAY['pending','error'])
          AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
 )
RETURNING *
```

`FOR UPDATE` bloqueia as linhas selecionadas; **`SKIP LOCKED` faz um segundo worker pular as
que já estão bloqueadas em vez de esperar por elas**. É isso — e só isso — que permite rodar
N workers em paralelo sem coordenação externa, sem Redis e sem risco de dois processos
pegarem a mesma entrega. Sem `SKIP LOCKED`, o segundo worker ficaria serializado atrás do
primeiro; com ele, cada um leva um lote distinto.

O `ORDER BY next_attempt_at` dá prioridade natural a quem espera há mais tempo. `attempts` é
incrementado **no claim**, de propósito: se o processo morrer no meio do envio, a tentativa
já foi contabilizada e não se cria um laço infinito de "tentar sem nunca contar".

Depois do claim, os eventos correspondentes são carregados em uma segunda query
(`WHERE id = ANY($1)`) e devolvidos como `{ delivery, event }`.

O laço em `worker.js` (`drenar()`) continua reivindicando **sem esperar o poll** enquanto o
lote vier cheio, e só volta a dormir `WORKER_POLL_MS` quando o lote vem incompleto ou vazio.
Um pico é drenado na velocidade do banco, não na do relógio.

### Backoff exponencial com teto

Em `markDeliveryFailure`:

```js
const isDead       = !retriable || attempts >= env.MAX_ATTEMPTS;   // MAX_ATTEMPTS = 6
const delaySeconds = isDead ? 0 : Math.min(2 ** Math.max(0, attempts - 1), 900); // teto 15 min
```

Como `attempts` já foi incrementado no claim, a progressão real é:

| Tentativa | `attempts` | Próxima em |
|---|---|---|
| 1ª falha | 1 | 1s |
| 2ª | 2 | 2s |
| 3ª | 3 | 4s |
| 4ª | 4 | 8s |
| 5ª | 5 | 16s |
| 6ª | 6 | → **dead** |

O teto de 900s existe para o caso de `MAX_ATTEMPTS` ser elevado na configuração: a espera
nunca passa de 15 minutos, então uma indisponibilidade longa da Meta é retomada rápido
quando ela volta, em vez de ficar dormindo horas.

### O que vira `dead`

`status = 'dead'` quando **`retriable === false`** ou quando `attempts >= MAX_ATTEMPTS`.
Nada mais reivindica a linha (o claim só olha `pending` e `error`), então ela some da fila e
fica visível no painel para reenvio manual — o `dead-letter` do sistema. Ao marcar `dead`, o
`next_attempt_at` fica parado (`delaySeconds = 0`), para quem lê a tabela não achar que ainda
há algo agendado.

`requeueEvent(eventRowId)` (rota `POST /api/events/:id/requeue`) devolve à fila **todas** as
entregas daquele evento que não estejam em `success`, zerando `attempts` e `last_error`.

### Recuperação de entregas presas

Se o worker morrer entre o claim e a marcação do resultado, a linha fica em `processing`
para sempre: o claim não a enxerga e nada a libera. `recoverStuckDeliveries(10)`, chamado
pela manutenção a cada 5 minutos, resolve:

```sql
UPDATE deliveries SET status='error', locked_at=NULL, next_attempt_at=now()
 WHERE status='processing' AND locked_at < now() - interval '10 minutes'
```

Dez minutos é folga confortável sobre o timeout de 15s por destino — nenhuma entrega
legítima fica tanto tempo em voo, então não há risco de reprocessar algo que ainda está
rodando. A tentativa já foi contada no claim, então a entrega recuperada não ganha vidas
extras.

Ao lado disso, a mesma rotina de manutenção roda `purgeExpiredSessions()` e
`purgeOldEvents(RETENTION_DAYS)` — o expurgo de eventos leva as `deliveries` junto por
`ON DELETE CASCADE`.

### Por que 4xx de configuração não é retentado

Cada destino devolve `retriable` explicitamente. A regra, idêntica nos três
(`meta.js`, `google.js`, `postback.js`):

```js
retriable: res.status >= 500 || res.status === 429
```

E, antes de qualquer requisição, a falta de configuração é declarada **não-retriável**:

```js
if (!pixelId || !token)
  return { ok:false, retriable:false, response:{ error:'Meta não configurado (...)' } };
```

Raciocínio: `500` e `429` descrevem um estado **temporário** do outro lado — vale insistir.
Um `400` com "Invalid OAuth access token" descreve um estado **nosso**, que não muda
sozinho. Insistir seis vezes com backoff apenas (a) queima cota de rate limit da API, (b)
enche o log de ruído idêntico e (c) atrasa o diagnóstico, porque a entrega demora minutos
para chegar ao estado final que o operador precisa ver. Marcando `dead` na primeira
tentativa, o erro aparece no painel imediatamente, com a mensagem exata da Meta — que é a
informação útil.

Exceção: **timeout e falha de rede são sempre retriáveis** (`catch` → `retriable: true`),
porque não houve resposta e portanto não há como saber se o problema é nosso.

Dois casos particulares do Google Ads merecem nota:

- **Falha de OAuth.** `getAccessToken` marca `retriable` apenas para `5xx` do endpoint de
  token. Um `invalid_grant` (refresh token revogado) é problema de configuração e vai direto
  para `dead`, com a mensagem `OAuth falhou: <detalhe>` visível no painel.
- **`partialFailure: true`.** A Ads API responde `HTTP 200` mesmo quando a conversão foi
  recusada — o erro real vem em `partialFailureError`. `uploadClickConversion` trata a
  presença desse campo como falha (`ok = res.ok && !partialErr`). Confiar no `200` aqui
  produziria exatamente o sucesso silencioso e falso que o resto do sistema evita.

---

## 6. Multi-tenancy

Um único banco, um único par de processos, N projetos. O isolamento é por linha
(`project_id` em toda tabela de dado), e a resolução do tenant acontece na borda.

### Resolução por slug (caminho principal)

```
POST /e/k7m2vqbz  →  resolveProject(req)  →  getProjectBySlug('k7m2vqbz')
                                             SELECT * FROM projects WHERE slug = $1
```

O slug é único globalmente, gerado com `randomSlug(8)`. Como ele **é** a chave de resolução,
a URL de ingestão de cada cliente é distinta e imprevisível — o que serve ao mesmo tempo à
tenancy e à mitigação de blocklist. As rotas legadas `/ingest/:projectId` e
`/collect/:projectId` resolvem por `getProject(id)` e continuam funcionando para integrações
já instaladas no GTM.

### Resolução por Host header

`getProjectByHostname(host)` faz o `JOIN` com `project_domains`:

```sql
SELECT p.* FROM projects p
  JOIN project_domains d ON d.project_id = p.id
 WHERE d.hostname = $1 LIMIT 1
```

O host é sempre normalizado (`split(':')[0]`, `trim`, minúsculas). **Esta função existe e
está testada, mas o caminho de ingestão hoje não a usa** — a resolução em produção é por
slug. Quem consome `project_domains` é o gate de TLS (abaixo) e o painel.

### `project_domains` e o gate `/api/caddy/ask`

O Caddy está configurado com TLS on-demand:

```
{
  on_demand_tls {
    ask http://api:3000/api/caddy/ask
  }
}

:443 {
  tls { on_demand }
  ...
}
```

O bloco coringa `:443` atende **qualquer** hostname que chegue e não case com o site
principal. Sem um gate, isso seria um vetor aberto: qualquer pessoa que apontasse um domínio
qualquer para o nosso IP faria o Caddy pedir um certificado em nosso nome, queimando o rate
limit da Let's Encrypt (e virando DoS, já que cada handshake com SNI novo dispara uma
emissão). Desde o Caddy 2.10 as opções `interval`/`burst` foram removidas — **o `ask` é a
única barreira**.

`GET /api/caddy/ask?domain=<host>` é a única rota de `/api` **fora** da autenticação
(registrada antes de `adminRouter.use(requireAuth)`), porque quem chama é o proxy. Ela nega
por padrão, e **estar cadastrado no painel não basta**:

1. `domain` ausente → `400 domínio ausente`.
2. `domain` igual ao `PUBLIC_HOST` (sem porta) → `200 ok` (o host do próprio serviço sempre
   pode).
3. `isDomainAuthorized(domain)` devolve `false` (hostname não cadastrado, `failed`, ou
   projeto não-`active`) → `403 domínio não autorizado`.
4. Devolve `'pending'` → **verificação de DNS ao vivo** (`resolveDns`). Se o domínio ainda
   não resolve para cá → `403 DNS não aponta para este servidor`. Se resolve, é promovido a
   `verified` na hora e o fluxo segue.
5. Devolve `'verified'` ou `'active'` (ou acabou de ser promovido) → `200 ok`, e o domínio é
   carimbado com `verification_status='active'` e `ssl_issued_at`.

`isDomainAuthorized` deixou de ser um booleano: devolve o `verification_status` da linha
(ou `false`), justamente para o gate poder distinguir o caso 4 do caso 5.

A verificação ao vivo do estado `pending` resolve um impasse real de onboarding: sem ela o
operador teria que clicar em "Verificar DNS" no painel **antes** de o certificado poder ser
emitido, mesmo com o DNS já propagado.

Consequência operacional: **se a API cair, o Caddy para de emitir certificados novos**. É o
modo de falha seguro (nada é emitido indevidamente), mas trava a ativação de clientes novos
até a API voltar. Certificados já emitidos continuam servindo normalmente.

O onboarding do domínio é: cadastrar (`pending`) → `POST .../verify` roda `resolveDns()` e
marca `verified` se o CNAME aponta para o `PUBLIC_HOST` ou se há IP em comum → primeira
requisição HTTPS dispara o `ask` e marca `active`.

---

## 7. Segurança

### Cifragem das credenciais (AES-256-GCM) e rotação

Regra de ouro do projeto: **nenhuma credencial de cliente no `.env`**. Pixel ID, access
token, API secret e refresh token vivem em `destinations.credentials_enc`, cifrados em nível
de aplicação — o banco nunca vê o valor em claro, e um dump do Postgres sem a `APP_SECRET` é
inútil.

Formato de cada valor: `v1:<iv b64>:<authTag b64>:<ciphertext b64>`. A chave é
`sha256(APP_SECRET)`, IV de 12 bytes aleatório por cifragem (duas cifragens do mesmo valor
produzem saídas diferentes).

O prefixo `v1` marca o **formato** do valor cifrado, **não** qual chave o cifrou — ele não
muda em uma rotação, e não deve ser lido como "versão da chave". A **rotação** usa
`APP_SECRET_PREVIOUS`: `decrypt` tenta a chave atual primeiro e, se a autenticação GCM não
fechar — sinal inequívoco de chave errada, não de corrupção —, tenta a anterior. Tudo que for
regravado já sai com a chave nova. Roteiro sem downtime:
`APP_SECRET_PREVIOUS = chave antiga` + `APP_SECRET = chave nova` → reiniciar → resalvar os
destinos pelo painel → remover `APP_SECRET_PREVIOUS`.

Fora de `development`, a ausência de `APP_SECRET` é **fatal** (`process.exit(1)`): cifrar com
uma chave previsível é o mesmo que não cifrar.

O painel nunca recebe um segredo de volta. `publicProject()` expõe apenas flags
(`hasAccessToken`, `hasApiSecret`, `hasClientSecret`, `hasRefreshToken`,
`hasDeveloperToken`, `hasBearerToken`). O `ingestToken` é a exceção deliberada — o operador
precisa copiá-lo para o backend do cliente —, mas ele acompanha apenas a resposta de **um**
projeto (`publicProject(p)`); a listagem `GET /api/projects` o omite
(`publicProject(p, { comToken: false })`), para o segredo de todos os projetos não trafegar a
cada recarga da barra lateral.

### Hash de PII antes de persistir

`redactForStorage` hasheia e-mail, telefone, nome, sobrenome, cidade, estado, CEP e país
**antes** do `INSERT`. O banco nunca guarda e-mail em claro (LGPD), e como o hash é
idempotente, o destino consegue montar o payload correto a partir do valor armazenado.

As regras de normalização são as da Meta e valem repetir porque errá-las quebra o match **sem
gerar nenhum aviso**: normalizar (`trim` + minúsculas) **antes** de hashear — inclusive o
`external_id`; telefone só dígitos, sem zeros à esquerda, com DDI; e **`fbp`, `fbc`, IP e
User-Agent vão em texto plano** — hashear esses quatro é o erro clássico que zera o match
silenciosamente.

O DDI acrescentado a números nacionais de 10–11 dígitos é configurável em
`DEFAULT_COUNTRY_CODE` (padrão `55`); definir a variável como vazia desliga o comportamento,
o que é necessário para operação fora do Brasil.

Regra de log complementar: `LOG_LEVEL=debug` registra payloads; `maskPII()` existe para
qualquer valor sensível que precise aparecer em log.

### Sessão com token hasheado

Autenticação do painel: e-mail + senha (`scrypt`, comparação com `timingSafeEqual`) → token
opaco de 32 bytes em cookie `traker_sess`, com `HttpOnly`, `SameSite=Lax`, `Expires` e
`Secure` quando `PUBLIC_SCHEME=https`. O banco guarda **apenas o SHA-256** do token
(`sessions.token_hash` é a PK) — vazamento do banco não permite sequestrar sessão ativa.

`authenticate()` executa a verificação de senha mesmo quando o e-mail não existe, para não
vazar por timing quais e-mails estão cadastrados.

`POST /api/auth/setup` cria o primeiro usuário sem autenticação, mas a janela **fecha sozinha
assim que existe um usuário** (`countUsers() > 0` → `403`). Não é um backdoor permanente.

### Rate limit

`src/ingest/rate-limit.js` — janela deslizante por buckets de 60s, **em memória, por
processo**. É camada de negócio, não defesa contra DDoS (essa é do proxy). Objetivo real:
impedir que um laço de tag mal configurada no site de um cliente inunde a fila.

| Chave | Limite | Onde |
|---|---|---|
| `ingest:<project_id>` | `RATE_LIMIT_PER_MINUTE` (padrão 6000/min) | `POST /e/:slug` |
| `collect:<project_id>` | idem | `POST /c/:slug` |
| `login:<ip>` | 20/min | `POST /api/auth/login` |

### Origem e validação na borda da ingestão

Duas barreiras foram acrescentadas ao caminho quente, ambas **antes** de qualquer escrita:

- **`allowed_origins` recusa de verdade.** Se o projeto tem uma lista preenchida e a
  requisição declara uma `Origin` fora dela, a resposta é `403` e o evento nem é normalizado.
  Refletir apenas o cabeçalho CORS não protegia nada: CORS instrui o navegador a esconder a
  *resposta*, mas a requisição já foi processada — e um `POST text/plain` sequer dispara
  preflight. Lista vazia continua significando "qualquer origem", porque a tag pode estar em
  subdomínios variados.
- **`validarPayload(body)`** rejeita com `400` o que produziria lixo silencioso no banco:
  corpo que não é objeto JSON, `event_name` ausente/vazio/acima de 100 caracteres,
  `event_id` acima de 200 caracteres, e `user_data`/`custom_data` que não sejam objetos. Não
  é schema completo de propósito — `custom_data` é deliberadamente aberto, porque cada site
  manda os próprios campos.

### Nunca confiar em IP/User-Agent vindos do cliente

`client_ip_address` e `client_user_agent` são **sempre** derivados da requisição
(`extractClientIp(req)` e `req.headers['user-agent']`) e sobrescrevem qualquer valor que o
payload tenha mandado. Dois motivos:

1. **Segurança.** IP é campo de correspondência da Meta. Aceitar o IP do corpo permitiria a
   qualquer um forjar a origem de um evento.
2. **Correção.** `X-Forwarded-For` só é lido quando `TRUST_PROXY=true`, e apenas o **primeiro
   IP da cadeia** (o cliente original). Sem proxy, o header é ignorado.

**A exceção do webhook.** No Fluxo C quem faz a requisição é o servidor do cliente, então
"os dados de quem chamou" são o IP do datacenter dele e um User-Agent como `axios/1.7` —
dois campos de match apontando para a máquina errada, o que é pior do que não mandar nada.
Por isso `enrichFromIdentity`, e **somente quando `event.source === 'webhook'`**, sobrescreve
`client_ip_address` e `client_user_agent` com o que a ponte de identidade guardou do
navegador. A regra continua sendo "nunca confiar no cliente": a fonte do valor é o nosso
banco, não o corpo da requisição. No Fluxo A nada muda — os dados da requisição já são os do
visitante. Há dois testes de integração cobrindo esse comportamento.

O espelho disso está no `Caddyfile`: `X-Forwarded-For` **não** é declarado no `reverse_proxy`
de propósito — o Caddy já o envia e **apenda** o IP à cadeia existente; escrever
`header_up X-Forwarded-For {remote_host}` **sobrescreveria** a cadeia. `X-Real-IP`, que não é
padrão do Caddy, vai explícito. Se `TRUST_PROXY` ficar `false` atrás do proxy, todos os
eventos passam a carregar o IP do container do Caddy e o EMQ despenca **sem nenhum erro
visível** — é a falha mais traiçoeira da arquitetura.

---

## 8. Mitigação de ITP e AdBlocker

Nenhuma camada sozinha basta. As cinco implementadas, com o limite honesto de cada uma:

**1. Cookie first-party gravado por `Set-Cookie` HTTP** — `refreshFirstPartyCookies()` reemite
`_fbp` e `_fbc` a cada `POST /e/` e `POST /c/`, com `Max-Age = COOKIE_MAX_AGE_DAYS × 86400`
(90 dias), `Domain=.dominio-registravel`, `SameSite=Lax`, `Secure` quando HTTPS e
**deliberadamente sem `HttpOnly`** — o Pixel da Meta precisa ler esses cookies via
JavaScript. O ITP corta em 7 dias os cookies gravados por JS, mas não os gravados por
resposta HTTP de host first-party.
*Limite:* o ITP tem heurística contra "CNAME cloaking" — se o subdomínio resolve por CNAME
para um host de terceiro, o Safari pode aplicar o corte de 7 dias assim mesmo. O `A record`
é a opção de hardening. E o servidor **nunca inventa** um `_fbp`: só regrava o que já
existe, porque fabricar um identificador que o Pixel não conhece degradaria o match em vez
de melhorá-lo.

**2. localStorage sticky no coletor** — a parte de coletor da tag (`/s/`, e portanto também
`/g/` e `/w/`, que a embutem) guarda `fbclid`, `gclid`, `gbraid`,
`wbraid`, `ttclid`, `clickid`, `tblci`, `_fbp`, `_fbc`, `_ttp`, os `utm_*` e a landing page
em chaves `tk_*`, e a cada página lê o valor novo **ou** recupera o antigo (`sticky()`). Os
click IDs aparecem uma única vez, na URL de entrada; sem isso, morrem na primeira navegação.
*Limite:* localStorage é por origem e por navegador — some com "limpar dados", não atravessa
dispositivos e não existe em navegação anônima após fechar a aba. No Safari, dados de script
de sites sem interação também são apagados após 7 dias.

**3. Identidade server-side** — a tabela `identities`. É a **única camada imune** a ITP,
limpeza de cookie, modo anônimo e troca de dispositivo, porque o dado está no nosso banco.
*Limite:* depende de o visitante se identificar. Sem `user_id` no dataLayer, o coletor
simplesmente não envia nada (`if(!uid) return`). E o guard `sessionStorage['tk_sent_'+uid]`
grava uma vez por sessão por usuário — identificadores que aparecerem depois dessa primeira
gravação só entram na sessão seguinte.

**4. Derivação de `_fbc`** — em `meta.js`, `deriveFbc()` reconstrói
`fb.1.<timestamp_ms>.<fbclid>` quando o cookie sumiu mas o `fbclid` existe (URL, localStorage
ou identidade). O caminho inverso também está implementado, no coletor: `fbclidFromFbc()`
extrai o `fbclid` de dentro do `_fbc` (`p.slice(3).join('.')`). É o maior ganho isolado de
EMQ, porque `fbc` é o campo que amarra a conversão ao clique.
*Limite:* o timestamp reconstruído é o do evento, não o do clique real. A Meta aceita, mas o
`_fbc` original é sempre preferível.

**5. Slug aleatório + script servido first-party** — o caminho é `/e/k7m2vqbz`, não
`/collect` ou `/track`; o alfabeto do slug não tem vogais, para não formar palavra; o payload
vai como `text/plain` via `sendBeacon` (que também evita preflight CORS); e o JS da tag sai
do **domínio do cliente** (`/g/<slug>.js` no GTM, `/w/<slug>.js` sem GTM, ou as metades
`/s/` e `/t/` nas instalações antigas), não de um CDN de terceiro. As
blocklists são majoritariamente listas de domínios de terceiros e de paths conhecidos —
nenhum dos dois se aplica aqui. O slug é rotacionável por
`POST /api/projects/:id/rotate-slug` quando um padrão for aprendido.
*Limite:* bloqueadores por heurística de conteúdo (uBlock com scriptlets agressivos) ainda
podem pegar padrões no comportamento do script. A rotação mantém o alvo móvel, mas exige
republicar o snippet no GTM do cliente.

---

## 9. Deduplicação

### As três camadas

**Camada 1 — Meta, 48h, por `event_id` + `event_name`.** O Pixel do navegador dispara com
`eventID = X`; nosso servidor envia a CAPI com `event_id = X`. Se o par bate, a Meta descarta
o segundo. **`event_name` também precisa bater exatamente**, e é aqui que a dedup quebra na
prática: o nome que sai daqui é `config.eventMap[event_name] || event_name`, então se o
`eventMap` do painel traduz `purchase → Purchase` mas o Pixel do navegador dispara
`Comprar`, a Meta vê dois eventos diferentes e conta duas conversões — **sem nenhum aviso**.

**Camada 2 — unicidade na ingestão.** `UNIQUE (project_id, event_id, event_name)` em
`events`. Retry de beacon, double-fire de tag e reenvio de webhook não criam evento novo nem
entregas; a resposta é `202 { status:"duplicate" }`.

**Camada 3 — unicidade na entrega.** `UNIQUE (event_row_id, destination_type)` em
`deliveries`. Um evento nunca gera duas entregas para o mesmo destino, e o requeue reutiliza
a linha em vez de criar outra.

As camadas 2 e 3 protegem o **nosso** lado (não gastar quota, não poluir o log, não postar
duas vezes); a camada 1 protege a **contagem de conversões** da Meta. Mesmo que 2 e 3
falhassem por uma corrida extrema, 1 seguraria — defesa em profundidade.

### A regra do `event_id` determinístico

`deriveEventId(body, eventName)` em `normalize.js`:

```js
1. body.event_id | body.eventID | body.eventId   →  usa como veio
2. custom_data.order_id | custom_data.transaction_id | body.order_id | body.transaction_id
                                                 →  `${event_name}-${businessId}`
3. nenhum dos dois                               →  crypto.randomUUID()
```

A mesma derivação está **duplicada no snippet do navegador** (`renderSnippet` em
`scripts.js`), e é obrigatório que continue idêntica: é o que faz o `purchase` do navegador e
o `purchase` do webhook do backend produzirem `purchase-8812` **independentemente**, sem
combinarem nada, e a Meta deduplicar.

Regra de ouro: **quando o evento pode chegar por dois caminhos, o `event_id` precisa ser
derivável do mesmo identificador de negócio nos dois.** `purchase` é o caso típico. Eventos
que só existem em um caminho (`page_view`, `view_content`) usam UUID à vontade.

O snippet **devolve o `event_id`** de `window.trk(...)` justamente para você repassá-lo ao
Pixel:

```js
var id = trk('purchase', { custom_data: { order_id: 8812, value: 199.9, currency: 'BRL' } });
fbq('track', 'Purchase', { value: 199.9, currency: 'BRL' }, { eventID: id });
```

---

## 10. Divergências em relação ao Blueprint

| # | Blueprint previa | Implementação real | Por quê / consequência |
|---|---|---|---|
| 1 | **Redis** para fila, rate-limit e cache de tenant | **Sem Redis.** Fila na tabela `deliveries` com `FOR UPDATE SKIP LOCKED`; rate-limit em memória; sem cache de tenant | Durabilidade transacional junto com o evento, um componente a menos. Custo: rate limit não é compartilhado entre processos e há 1 query de resolução de projeto por requisição de ingestão |
| 2 | Tabelas `tenants` e `api_keys` | **Não existem.** Não há camada de conta comercial; o token do webhook é a coluna `projects.ingest_token` | Simplificação de MVP. Um token por projeto, sem rotação nem revogação parcial |
| 3 | Tabela `event_mappings` (linha por tradução) | **Não existe.** O mapeamento vive em `destinations.config.eventMap` (JSONB) | Menos joins; a contrapartida é que não há `param_map` nem flag `enabled` por mapeamento |
| 4 | `deliveries UNIQUE (event_id, destination_id)` | `deliveries UNIQUE (event_row_id, destination_type)` | Não existe `destination_id` no caminho quente: o destino é resolvido por **tipo** dentro do agregado do projeto |
| 5 | `events` **particionada por mês** | Tabela única, sem particionamento | Expurgo é `DELETE ... WHERE received_at < ...`. Ver dívida técnica |
| 6 | Segredos cifrados em coluna **BYTEA** com `key_version` na linha | JSONB com o prefixo `v1:` **dentro de cada valor**, que marca o formato e não a chave; rotação por tentativa na tag GCM com `APP_SECRET_PREVIOUS` | Alcança o mesmo objetivo (rotação sem downtime) sem carregar um registro de versão de chave |
| 7 | `evento sem mapeamento → skipped` | Sem mapeamento, **passa com o nome original** (`eventMap[nome] \|\| nome`) | Mais permissivo. Evento novo no site chega à Meta com o nome do site em vez de ser descartado silenciosamente |
| 8 | Resolução de tenant por **Host header** (`project_domains`), com o `public_id` da URL conferido contra o projeto resolvido | Resolução por **slug** na URL. `getProjectByHostname` existe e está testada, mas **não é usada** no caminho de ingestão | Um cliente que apontasse o próprio domínio e usasse o slug de outro projeto seria atendido como o outro projeto. Na prática o slug é secreto e aleatório, mas a conferência cruzada prevista no blueprint não existe |
| 9 | Validação de `Origin`/`Referer` contra `allowed_origins` na ingestão do navegador | Implementado: `Origin` declarada e fora da lista recebe `403` antes de qualquer processamento. **Continua sem tela no painel** para preencher a coluna | O mecanismo existe e funciona; a lista só pode ser populada direto no banco |
| 10 | Framework NestJS ou Express modular, com **validação de schema na borda** | Express 4 modular, com `validarPayload()` próprio em vez de biblioteca de schema | Cobre o que produziria lixo no banco (corpo não-objeto, `event_name` ausente, campos gigantes) sem fechar `custom_data`, que é aberto por design |
| 11 | Deploy em VPS (Hetzner/DO/Vultr) | **Oracle Cloud (OCI)**, por decisão de infra da empresa | Ver `docs/02-deploy-oracle-cloud.md` |
| 12 | Dependências: framework + Redis + validador | **Duas dependências de produção**: `express` e `pg`. `.env` lido sem `dotenv`, senha com `scrypt` nativo em vez de `bcrypt`, validação de borda escrita à mão | Superfície de supply-chain mínima; build sem toolchain nativo, roda igual em x86_64 e ARM64 |
| 13 | Google Ads API como evolução pós-MVP | **Implementada** em `google-ads.js`, junto com o GA4 MP | O blueprint a listava na seção 12 (evoluções mapeadas); saiu na frente do previsto |

---

## 11. Limitações conhecidas e dívida técnica

**Integrações**

1. **Google Ads depende de um developer token aprovado pelo Google.** O cliente está
   completo, mas o upload só funciona com uma conta cujo acesso à API tenha sido liberado —
   é um prazo externo, não um item de código. Sem ele, a troca de token falha com erro
   tratado e visível no log do evento.
2. **`GOOGLE_ADS_API_VERSION` (padrão `v17`) é global**, não por projeto. A Google
   descontinua versões periodicamente; a atualização é uma variável de ambiente e um
   restart, mas atinge todos os clientes de uma vez.
3. **O cache de access token do Google Ads é por processo**, chaveado pelo `refresh_token`.
   Com api e worker rodando, cada um mantém o seu. `clearTokenCache()` existe, mas **não é
   chamado** quando as credenciais mudam no painel — trocar o refresh token pode deixar o
   worker usando o access token antigo por até ~1h.
4. **GA4 MP não valida payload.** O Measurement Protocol responde `204` para praticamente
   qualquer coisa; erro de schema passa como sucesso no nosso log. Só o endpoint
   `/debug/mp/collect` valida de verdade, e ele **não** está integrado.
5. **`ga_client_id` não é persistido na ponte de identidade.** Ele existe no Evento Interno
   e é lido do cookie `_ga`, mas não está em `MARKETING_KEYS` — então uma conversão de
   webhook não recupera o `client_id` real do GA4 e cai na derivação a partir do `user_id`.

**Fila e banco**

6. **Fila em Postgres, não Redis** (divergência 1). Latência mínima de entrega ≈ 1 ×
   `WORKER_POLL_MS`. Reduzir o poll aumenta a carga no banco linearmente.
7. **Sem particionamento de `events`.** O expurgo é um `DELETE` de massa que gera bloat e
   depende de autovacuum; um `DROP PARTITION` seria instantâneo. Com retenção de 90 dias e
   volume alto, é o primeiro gargalo a aparecer.
8. **`queueHealth()` é global**, sem recorte por projeto — útil para saúde da instância,
   inútil para diagnosticar um cliente específico.

**Escala e disponibilidade**

9. **Instância única, sem HA.** Um `docker compose` em uma VM. Recuperação = nova VM +
   restore do dump + DNS. A API é stateless, então escalar horizontalmente é viável (o
   `SKIP LOCKED` já suporta N workers), mas nada disso está montado.
10. **Rate limit em memória, por processo.** Com duas réplicas da API, o limite efetivo
    dobra. Some no restart (pior caso: uma janela de folga).
11. **Se a API cair, o Caddy para de emitir certificados novos** (o `ask` não responde).
    Falha segura, mas trava a ativação de clientes. Agora o gate também depende de uma
    resolução de DNS para domínios `pending`, o que acrescenta latência a esse caminho.
12. **Uma consulta a `projects` (e outra a `destinations`) por requisição de ingestão.** Sem
    cache. É o custo esperado por não ter Redis; vira gargalo antes do resto.

**Segurança e privacidade**

13. **`projects.ingest_token` guardado e exibido em claro.** O blueprint pedia `key_hash`;
    a decisão de produto foi manter o valor recuperável, porque o operador precisa copiá-lo
    para o backend do cliente e um token que só aparece uma vez vira chamado de suporte.
    Consequência aceita: com acesso de leitura ao banco dá para forjar webhooks — risco
    menor que o dos access tokens, que estão cifrados.
14. **`events.client_ip` guarda o IP em claro** e sem hash, sujeito à retenção de 90 dias.
15. **`users.role` não é verificado em lugar nenhum.** Todo usuário autenticado tem acesso
    total ao painel, inclusive a projetos de outros clientes.
16. **`POST /api/events/:id/requeue` não é escopado por projeto** — qualquer sessão válida
    reenfileira qualquer evento.
17. **Sem CSRF token no painel.** O cookie é `SameSite=Lax`, o que cobre o caso comum, mas
    não há defesa explícita.
18. **`allowed_origins` não tem tela no painel.** O bloqueio por `Origin` funciona, mas a
    lista só pode ser preenchida direto no banco — na prática, o recurso fica desligado.
19. **`STRICT_CONSENT` é global**, não por projeto. Clientes com CMP maduro e clientes sem
    consent nenhum compartilham a mesma postura.
