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
apontar o Public Hostname do túnel para `http://caddy:80`.

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
| Portas | 80 e 443 publicadas | nenhuma porta publicada |
| Entrada | conexão de fora para dentro | `cloudflared`, de dentro para fora |
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

Levantadas na auditoria de 2026-08-29 e **ainda não aplicadas**:

1. `src/tenancy/dns-check.js` — a verificação de DNS compara os IPs do domínio do
   cliente com os de `PUBLIC_HOST`. Como `PUBLIC_HOST` está atrás do anycast da
   Cloudflare, um domínio de cliente também na Cloudflare pode **casar por engano**
   e o painel anunciar "aponta para este servidor" para um domínio que nunca
   chegará aqui.
2. `public/admin.html` e `public/admin/ajudas.js` — os textos da aba Domínios
   afirmam que o certificado é emitido automaticamente e mandam deixar o proxy da
   Cloudflare como "DNS only". Neste deploy é o contrário: sem proxy não há caminho
   até o túnel.
3. `src/admin/auth.js` — lê `x-forwarded-for` direto em três lugares, sem respeitar
   `TRUST_PROXY` (`normalize.js` respeita). Preexistente, não é regressão daqui.

## Documentação

Toda a pasta `docs/` veio junto por ser a base de conhecimento do projeto, mas nem
tudo se aplica a este deploy. Ver [`docs/README.md`](docs/README.md) para o índice
do que vale e do que é histórico.
