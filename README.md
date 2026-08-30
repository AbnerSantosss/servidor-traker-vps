# servidor-traker — deploy no homelab (VPS própria)

Servidor próprio de tracking server-side: recebe eventos first-party do GTM Web e
do webhook do backoffice, e reenvia via Conversions API para Meta, Google Ads e
postbacks. Este repositório é **exclusivamente o alvo de deploy do homelab**,
atrás de Cloudflare Tunnel, publicado pelo Portainer.

## Como subir

Guia completo: [`docs/17-deploy-homelab-cloudflare.md`](docs/17-deploy-homelab-cloudflare.md).

Resumo: Portainer → Stacks → Add stack → **Repository** (não o editor web, que não
tem contexto de arquivos para o `build:`) → `docker-compose.yml` → cadastrar as
variáveis (modelo em [`portainer.env.example`](portainer.env.example)) → Deploy →
adicionar no túnel `servidor-abner` uma rota `<PUBLIC_HOST>` -> `http://localhost:8099`.

Não existe passo manual de migração nem de criação de usuário: `src/server.js`
chama `waitForDatabase()`, `runMigrations()` e `bootstrapAdmin()` no boot.

## De onde este código veio — leia antes de mexer

Esta pasta foi copiada em **2026-08-29** do monorepo de desenvolvimento em
`Projetos/7 - Servidor Proprio/servidor-traker` (HEAD `ed6aab1`, de 26/08).

**Existe uma segunda linha de desenvolvimento divergente.** O repositório privado
`AbnerSantosss/servidor-traker` no GitHub foi criado em 18/08 a partir de outra
cópia e recebeu commits em 20/08 que **não estão aqui**:

| Só lá (GitHub) | Só aqui (esta cópia) |
|---|---|
| `src/tenancy/first-party.js` | `src/db/repos/instalacao.js` |
| `public/config.js`, `public/gtm-template.js` | `test/instalacao.test.js` |
| 3 arquivos de teste | os arquivos de deploy do homelab |

Além disso, ~40 arquivos em comum divergem por dentro — os maiores são
`src/ingest/scripts.js`, `public/admin.html`, `src/admin/router.js` e
`src/db/pool.js`. A reconciliação das duas linhas **ainda não foi feita**.

## Diferenças em relação ao deploy com IP público

| | IP público (Oracle/VPS com porta aberta) | Aqui (homelab + túnel) |
|---|---|---|
| TLS | Caddy emite via Let's Encrypt | Cloudflare termina na borda |
| Portas | 80 e 443 publicadas | só `127.0.0.1:8099` (loopback, fora da LAN) |
| Entrada | conexão de fora para dentro | túnel `servidor-abner` do host → `127.0.0.1:8099` |
| Domínios de cliente | TLS sob demanda funciona | **não funciona** — ver abaixo |

## O que NÃO funciona neste deploy

A **aba "Domínios"** do painel (o modelo Stape: cliente aponta `tkr.dominiodele.com`
para cá e o certificado sai sozinho) **não opera atrás do túnel**. Não há IP para o
cliente apontar, e a Cloudflare só emite certificado para hostname da própria conta;
domínio de terceiro exigiria Cloudflare for SaaS (Custom Hostnames), produto pago à
parte — confira o preço atual antes de contar com ele.

Consequência visível: a tela deixa cadastrar o domínio e ele fica **travado em 2 de 4
estágios para sempre**, porque a única linha do código que grava o estado `active` é
a do handler `/api/caddy/ask`, que ninguém chama aqui.

Isso hoje não bloqueia a operação, porque a arquitetura escolhida é webhook-first
(ver `docs/12-deploy-zyraflow.md`). As rotas com slug (`/e/:slug`, `/c/:slug`)
continuam intactas.

## Pendências conhecidas

As três levantadas na auditoria de 2026-08-29 foram **aplicadas em 2026-08-30**
(commit `bdadec5`), junto com a reconciliação com o código de produção:

1. ~~`src/tenancy/dns-check.js` — falso positivo do anycast da Cloudflare.~~
   **Resolvido.** A decisão saiu para uma função pura `classificarDns()` e o retorno
   ganhou o campo `status` (`aponta` | `inconclusivo` | `nao_resolve` | `nao_aponta` |
   `erro`). O CNAME para o nosso host passa a ser checado primeiro, por ser prova
   sobre nome e imune a proxy; igualdade de IP só vale **fora** das faixas de CDN
   compartilhado (novo `src/tenancy/redes-proxy.js`). O gate de `/api/caddy/ask`
   segue negando o que não for `ok: true` — aceitar `inconclusivo` foi tentado e
   revertido, porque qualquer um abre um handshake TLS com o SNI que quiser, e isso
   viraria emissão especulativa contra a cota da Let's Encrypt.
2. ~~Textos da aba Domínios prometendo certificado automático e mandando usar
   "DNS only".~~ **Resolvido.** Callout persistente no topo da aba, orientação do
   proxy invertida para a correta, blocos de benefício no condicional e o tutorial
   recolhido. Nova chave de ajuda `dominio-indisponivel`.
3. ~~`src/admin/auth.js` lendo `x-forwarded-for` sem respeitar `TRUST_PROXY`.~~
   **Resolvido.** Os três pontos passaram a usar o `extractClientIp` que
   `src/ingest/normalize.js` já exportava — sem duplicar a lógica.

### Ainda em aberto

4. **O domínio first-party do cliente não é servível por este deploy.** O projeto em
   produção usa `t.codigovencedor.com` (a tag publicada no GTM aponta para
   `https://t.codigovencedor.com/g/bj3j9gc2.js`), e `src/tenancy/first-party.js` faz
   o endereço da tag sair do domínio verificado do projeto justamente para que os
   cookies `_fbp`/`_fbc` nasçam no domínio do cliente. Atrás do túnel não há como
   servir esse hostname, a menos que `codigovencedor.com` esteja na **mesma conta
   Cloudflare** do túnel — aí basta uma rota de hostname público. Confirmar isso
   **antes** de qualquer virada: sem ele, a tag instalada para de responder.
5. **A Cloudflare sobrescreve o cache do script.** O código manda
   `Cache-Control: public, max-age=300`, mas a resposta no ar volta com
   `max-age=14400` e `cf-cache-status: REVALIDATED`. Uma tag corrigida leva até
   4 horas para chegar aos navegadores se o cache não for purgado no deploy.

## Documentação

Toda a pasta `docs/` veio junto por ser a base de conhecimento do projeto, mas nem
tudo se aplica a este deploy. Ver [`docs/README.md`](docs/README.md) para o índice
do que vale e do que é histórico.
