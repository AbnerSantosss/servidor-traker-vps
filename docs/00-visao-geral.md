---
title: Visão geral do Servidor Traker
tags: [visao-geral, arquitetura, tracking, capi, meta, ga4, servidor-traker]
created: 2026-08-12
updated: 2026-08-25
---

# Visão geral do Servidor Traker

Documento de entrada do repositório. Se você acabou de chegar no projeto, leia daqui até o
fim antes de abrir qualquer arquivo em `src/`.

---

## 1. O que é isto

O **Servidor Traker** é um servidor de rastreamento *server-side* próprio. Ele fica entre o
site do cliente e as plataformas de anúncio: recebe os eventos que acontecem no navegador do
visitante (visualizou a página, virou lead, comprou), guarda esses eventos no banco e depois
os reenvia, pelo servidor, para a **Meta Conversions API** e para o **Google Analytics 4
(Measurement Protocol)**. É o mesmo papel que produtos como a [Stape](https://stape.io/pt)
cumprem — a diferença é que aqui a pipeline é nossa, sem intermediário e sem custo por
evento.

O problema que ele resolve tem duas metades. A primeira é **perda de dado**: bloqueadores de
anúncio, o ITP do Safari e o fim dos cookies de terceiros derrubam uma fatia grande dos
eventos que sairiam direto do navegador para o `facebook.com`. Quando o evento sai do nosso
servidor, ele não depende do navegador do visitante estar limpo — e o servidor ainda conhece
o IP e o User-Agent reais, que são campos de correspondência. A segunda metade é
**conversão que o navegador nunca vê**: pagamento aprovado horas depois, venda confirmada no
CRM, assinatura renovada. Essas conversões nascem no backend do cliente e, sem uma ponte,
chegariam à Meta sem nenhum identificador de clique — ou seja, sem atribuição. O Servidor
Traker guarda a associação `user_id → {fbc, fbp, gclid, utm_*}` capturada no navegador e a
usa para completar a conversão que vem do backend dias depois.

---

## 2. Os três fluxos de dados

### Visão consolidada

```
   NAVEGADOR DO VISITANTE                NOSSA INFRAESTRUTURA               PLATAFORMAS
 ┌───────────────────────────┐        ┌──────────────────────────┐       ┌──────────────┐
 │ site do cliente + GTM Web │        │  Caddy (TLS on-demand)   │       │  Meta CAPI   │
 │  └─ /g/<slug>.js  tag única │       │            │             │       │  GA4 MP      │
 │     coletor + window.trk   │        │            ▼             │       │  Google Ads  │
 └───────┬───────────┬───────┘        │   api (Express)          │       │  postback    │
         │ (A)       │ (B)            │    normaliza → enriquece │       └──────▲───────┘
         │ evento    │ identidade     │    → grava → enfileira   │              │
         └───────────┴──────────────► │            │             │              │
                                      │            ▼             │              │
 ┌───────────────────────────┐        │      PostgreSQL          │              │
 │ backend do cliente        │  (C)   │   events + deliveries    │              │
 │ POST autenticado (webhook)├──────► │            │             │              │
 └───────────────────────────┘        │            ▼             │              │
                                      │   worker (polling)  ─────┼──────────────┘
                                      └──────────────────────────┘
```

### Fluxo A — evento nascido no navegador

```
visitante clica "comprar"
        │
        ▼
 GTM Web dispara window.trk('purchase', { custom_data: { order_id: 8812, value: 199.9 } })
        │  gera event_id = "purchase-8812" e DEVOLVE esse id
        │  (o mesmo id vai para o Pixel do navegador em fbq(..., {eventID}))
        ▼
 POST https://traker.cliente.com/e/<slug>          [text/plain via sendBeacon]
        │
        ▼
 api:  validarPayload()    → 400 se o corpo for lixo (sem event_name, campos gigantes)
       extractClientIp()   → IP real (X-Forwarded-For do Caddy)
       normalizeEvent()    → Evento Interno canônico
       enrichFromIdentity()→ completa lacunas com o que a ponte já sabia
       refreshFirstPartyCookies() → Set-Cookie _fbp/_fbc (90 dias, anti-ITP)
       applyConsent()      → remove PII se ad_user_data = denied
       redactForStorage()  → PII vira SHA-256 antes de tocar o banco
       recordEvent()       → INSERT em events + 1 linha em deliveries por destino ativo
        │
        ▼  HTTP 202 em milissegundos (a página do cliente nunca espera a Meta)
       ...
 worker: claimDeliveries() → processDelivery() → sendToMeta / sendToGoogle / sendPostback
```

### Fluxo B — coleta de identidade (a ponte)

```
visitante chega por anúncio:  https://site.com/?fbclid=IwAR...&utm_source=meta
        │
        ▼
 /g/<slug>.js (tag única, roda em All Pages; a parte de coletor)
   ├─ lê fbclid/gclid/utm_* da URL, _fbp/_fbc/_ttp dos cookies
   ├─ se _fbc existe mas o fbclid sumiu da URL → extrai o fbclid de dentro do _fbc
   ├─ guarda TUDO em localStorage (sticky: sobrevive à navegação e ao corte do ITP)
   └─ só envia quando o dataLayer já expõe um user_id
        │
        ▼
 POST /c/<slug>  { user_id: "42", fbclid, fbp, fbc, gclid, utm_* }
        │
        ▼
 api: saveIdentity() → INSERT ... ON CONFLICT (project_id,user_key)
                       DO UPDATE SET params = params || novos
                       (merge no Postgres: valor bom NUNCA é sobrescrito por vazio)
```

Nada é enviado à Meta neste fluxo. Ele só popula a tabela `identities`, que é o ativo
consultado pelos outros dois fluxos.

### Fluxo C — conversão nascida no backend do cliente (webhook)

```
gateway aprova o pagamento (horas depois da visita)
        │
        ▼
 backend do cliente:
   POST https://traker.cliente.com/e/<slug>
   Authorization: Bearer <ingest_token do projeto>
   { "event_name":"purchase", "user_id":"42",
     "custom_data": { "order_id": 8812, "value": 199.9, "currency":"BRL" } }
        │
        ▼
 api: detectSource()      → Bearer válido ⇒ source = "webhook", action_source = system_generated
      deriveEventId()     → sem event_id explícito, deriva "purchase-8812"
                            (o MESMO id que o navegador geraria ⇒ a Meta deduplica)
      enrichFromIdentity()→ busca identities(project, user_id="42") e preenche
                            fbc, fbp, gclid, utm_* que o backend não conhece
                            E, só no webhook, SOBRESCREVE client_ip_address e
                            client_user_agent com os do navegador — senão iriam
                            o IP do datacenter do cliente e um UA "axios/1.7"
        │
        ▼
 mesma fila, mesmos workers do Fluxo A
```

É este fluxo que separa um EMQ medíocre de um EMQ alto em conversões de backend: a compra
sai com o identificador do clique no anúncio — e com o IP e o User-Agent reais do visitante
— capturados dias antes no navegador.

---

## 3. Mapa do repositório

```
servidor-traker/
├─ src/
│  ├─ server.js               processo da API (Express): ingestão, painel, saúde, estáticos
│  ├─ worker.js               processo worker: drena a fila e faz manutenção periódica
│  │
│  ├─ config/
│  │  ├─ env.js               lê .env sem dependência externa; exige APP_SECRET em produção
│  │  ├─ crypto.js            AES-256-GCM das credenciais, hash de PII (regras da Meta),
│  │  │                       scrypt de senha, randomSlug/randomToken, safeEqual
│  │  └─ log.js               log de uma linha (JSON em produção); maskPII()
│  │
│  ├─ db/
│  │  ├─ pool.js              pool do Postgres, transaction(), waitForDatabase()
│  │  ├─ migrate.js           migrador idempotente (schema_migrations)
│  │  ├─ migrations/001_init.sql   esquema completo (7 tabelas)
│  │  └─ repos/
│  │     ├─ projects.js       projetos + destinos + domínios; mapeamentos padrão;
│  │     │                    contrato de segredos; isDomainAuthorized() (gate do Caddy)
│  │     ├─ identities.js     ponte de identidade; MARKETING_KEYS; forgetUser() (LGPD)
│  │     ├─ events.js         gravação de evento + A FILA (claim/success/failure/requeue)
│  │     │                    + métricas do painel + expurgo por retenção
│  │     └─ users.js          usuários e sessões (token hasheado no banco)
│  │
│  ├─ ingest/
│  │  ├─ router.js            POST /e/:slug (+ alias /ingest/:projectId); validarPayload();
│  │  │                       CORS + bloqueio real por Origin; detectSource; ponte de identidade
│  │  ├─ collect.js           POST /c/:slug (+ alias /collect/:projectId)
│  │  ├─ scripts.js           GET /s/, /t/, /g/ (tag única do GTM) e /w/ (sem GTM) —
│  │  │                       gera os JS client-side; /g/ e /w/ concatenam /s/ + /t/
│  │  ├─ normalize.js         Evento Interno canônico; extractClientIp; deriveEventId;
│  │  │                       gclidFromCookie() e gaClientIdFromCookie()
│  │  ├─ consent.js           Consent Mode v2 aplicado no servidor (STRICT_CONSENT)
│  │  ├─ cookies.js           parse + Set-Cookie first-party de _fbp/_fbc; domínio registrável
│  │  └─ rate-limit.js        janela deslizante em memória, por processo
│  │
│  ├─ queue/dispatcher.js     pega uma entrega reivindicada e a executa no destino certo
│  │
│  ├─ destinations/
│  │  ├─ meta.js              Meta CAPI: buildUserData, deriveFbc, LDU
│  │  ├─ google.js            roteador do destino Google: GA4 MP (buildGa4Payload) ou,
│  │  │                       quando config.route = "google_ads", delega a google-ads.js
│  │  ├─ google-ads.js        Google Ads API: OAuth2 com cache de access token,
│  │  │                       UploadClickConversions, Enhanced Conversions, partialFailure
│  │  └─ postback.js          HTTP genérico com interpolação {{campo}}
│  │
│  ├─ admin/
│  │  ├─ router.js            API do painel + GET /api/caddy/ask (fora da autenticação)
│  │  └─ auth.js              login/logout/me/setup por cookie de sessão HttpOnly
│  │
│  ├─ tenancy/dns-check.js    resolveDns() e resolveOwnIps(): confere se o domínio do
│  │                          cliente aponta para cá e informa os nossos IPs ao painel
│  └─ scripts/
│     ├─ seed.js              cria um projeto de exemplo (destinos desligados)
│     └─ create-user.js       cria/redefine usuário do painel
│
├─ public/                    painel (admin.html + admin/*.js), login.html, landing, app.css
│     ├─ admin/               módulos do painel, um por tela (ver docs/15)
│     ├─ estilos/             folhas por assunto das telas maiores
│     └─ vendor/              ECharts e Lucide vendorizados (a CSP proíbe CDN)
├─ gtm/                       template do GTM (TrackServer.tpl) + notas de preview mode
├─ test/unit.test.js          testes unitários (node --test)
├─ infra/Caddyfile            proxy reverso, TLS on-demand com gate `ask`
├─ Dockerfile                 build multi-stage, roda como usuário `node`, healthcheck
├─ docker-compose.yml         caddy + api + worker + db (só o Caddy publica portas)
├─ .env.example               modelo comentado das variáveis (só segredo de infra)
└─ docs/                      esta documentação
```

Arquivos que valem uma leitura antes dos demais, nesta ordem:
`src/ingest/normalize.js` → `src/db/migrations/001_init.sql` → `src/db/repos/events.js` →
`src/destinations/meta.js`.

---

## 4. Glossário

| Termo | O que é |
|---|---|
| **CAPI** (Conversions API) | API server-to-server da Meta que recebe eventos de conversão direto do nosso servidor, em vez de do navegador. Endpoint: `graph.facebook.com/{versão}/{pixel_id}/events`. |
| **EMQ** (Event Match Quality) | Nota de 0 a 10 que a Meta dá à qualidade dos identificadores enviados em cada evento. Quanto mais campos de correspondência (e-mail, telefone, `fbc`, IP, User-Agent), maior o EMQ e melhor a atribuição. O número oficial vive no Events Manager; o painel mostra apenas a **cobertura de campos** como diagnóstico. |
| **dedup** (deduplicação) | Descarte, pela Meta, do segundo evento que chega com o mesmo par `event_id` + `event_name` no mesmo pixel dentro de ~48h. É o que permite mandar o mesmo evento pelo Pixel do navegador **e** pela CAPI sem contar duas vezes. |
| **`event_id`** | Identificador único do evento. Precisa ser **o mesmo** no Pixel do navegador (`eventID`) e no envio da CAPI. Quando existe um `order_id`/`transaction_id`, é derivado dele (`purchase-8812`), o que torna navegador e webhook naturalmente dedupáveis. |
| **`_fbp`** | Cookie first-party criado pelo Pixel da Meta que identifica o navegador. Formato `fb.1.<ts>.<random>`. **Nunca hashear.** |
| **`_fbc`** | Cookie first-party que amarra a visita ao clique no anúncio. Formato `fb.1.<timestamp_ms>.<fbclid>`. É o campo de maior ganho isolado de EMQ. **Nunca hashear.** |
| **`fbclid`** | Parâmetro que a Meta acrescenta à URL de destino do anúncio. Aparece **uma única vez**, na página de entrada — daí a captura sticky em localStorage. Dele se deriva o `_fbc`. |
| **`gclid`** | Equivalente do Google Ads (também `gbraid`/`wbraid` em campanhas de app/iOS). Cuidado: o cookie `_gcl_aw` **não** guarda o `gclid` puro — o formato é `GCL.<timestamp>.<gclid>`, e o servidor extrai a última parte (`gclidFromCookie`). |
| **ITP** (Intelligent Tracking Prevention) | Mecanismo do Safari que, entre outras coisas, limita a **7 dias** a validade de cookies gravados por JavaScript. Cookies gravados por `Set-Cookie` HTTP de um host first-party não sofrem esse corte — daí a camada de renovação por HTTP do servidor. |
| **Consent Mode v2** | Padrão do Google/Meta em que o site informa quatro sinais (`ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization`). Aqui a tag só **transporta** o estado; quem aplica a regra é o servidor (`src/ingest/consent.js`), uma única vez, **antes de gravar no banco**. `STRICT_CONSENT=true` faz consentimento ausente contar como negado. |
| **Ponte de identidade** | A tabela `identities`: associação `user_id do site → {fbc, fbp, fbclid, gclid, utm_*, IP, UA}` capturada no navegador. É a única camada de persistência imune a ITP, limpeza de cookies e modo anônimo. |
| **Slug de ingestão** | Caminho curto e aleatório por projeto (ex.: `/e/k7m2vqbz`), gerado com alfabeto sem vogais para não formar palavras. Serve para não dar às blocklists um padrão fixo para aprender. Rotacionável pelo painel. |
| **first-party** | Requisição feita para um host do **mesmo domínio registrável** do site do visitante (ex.: `traker.cliente.com` para o site `cliente.com`). É o que mantém os cookies vivos e o que mantém o endpoint fora das listas de bloqueio, que são majoritariamente listas de domínios de terceiros. |

---

## 5. Estado real de cada integração

| Destino | Arquivo | Estado | Observação |
|---|---|---|---|
| **Meta Conversions API** | `src/destinations/meta.js` | ✅ **Implementado** | `POST graph.facebook.com/{META_API_VERSION}/{pixelId}/events`. Hash de PII, `fbp`/`fbc`/IP/UA em texto plano, derivação de `_fbc` a partir do `fbclid`, `test_event_code`, sinalização de LDU. |
| **GA4 Measurement Protocol** | `src/destinations/google.js` (`route: "ga4_mp"`, padrão) | ✅ **Implementado** | `POST google-analytics.com/mp/collect`. Usa o `client_id` real extraído do cookie `_ga`; sem ele, deriva um pseudo-id estável a partir do `user_id`. Envia `sha256_email_address`/`sha256_phone_number`. **Atenção:** o MP responde `204` sem validar o payload — erro de schema passa silencioso. |
| **Google Ads API / Enhanced Conversions** | `src/destinations/google-ads.js` (`route: "google_ads"`) | ✅ **Implementado** | `POST googleads.googleapis.com/{GOOGLE_ADS_API_VERSION}/customers/{customerId}:uploadClickConversions`. OAuth2 real (`refresh_token` → `access_token`, com cache de ~1h), identificação do clique por `gclid` → `gbraid` → `wbraid`, Enhanced Conversions com `hashedEmail`/`hashedPhoneNumber`, e envio de `conversionValue`, `currencyCode` e `orderId`. Usa `partialFailure: true` e trata `partialFailureError` como falha mesmo com HTTP 200. **Pré-requisito externo:** um developer token aprovado pelo Google — sem ele a troca de token falha com erro explícito e visível no log do evento. |
| **Postback genérico** | `src/destinations/postback.js` | ✅ **Implementado** | GET ou POST para uma URL do cliente (CRM, n8n, plataforma de afiliados), com interpolação `{{campo}}` na URL e nos headers, filtro por nome de evento e `Bearer` opcional guardado cifrado. Aplica Consent Mode antes de enviar. |

---

## 6. Índice da documentação

| Documento | Para quê |
|---|---|
| `00-visao-geral.md` | **(este)** o que é o sistema, os três fluxos, mapa do repositório, glossário |
| `01-arquitetura.md` | referência de arquitetura: processos, Evento Interno, modelo de dados, fila, multi-tenancy, segurança, ITP, dedup, divergências e dívida técnica |
| `02-deploy-oracle-cloud.md` | subir a stack na Oracle Cloud (OCI), do zero, sem conhecimento prévio de Linux |
| `03-dns-tls-subdominio.md` | qual registro DNS criar, como o certificado é emitido sozinho, como conferir |
| `04-tagueamento-meta.md` | instalar as tags no GTM Web e validar a dedup e o EMQ no Events Manager |
| `05-tagueamento-google-ads.md` | configuração do lado Google: GA4 MP e a rota Google Ads API (OAuth2, developer token, conversion actions) |
| `06-operacao-runbook.md` | plantão: o que olhar todo dia, o que fazer quando quebra, rotação de chave, LGPD |
| `07-referencia-api.md` | referência literal de **todos** os endpoints HTTP, com exemplos e `curl` prontos |
| `08-mensagem-para-o-rauny.md` | textos prontos para os pedidos de infra (instância, DNS, repositório) |
