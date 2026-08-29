---
title: Deploy em dois repositórios (Azure DevOps) — como funciona e o que entregar ao Rauny
tags: [deploy, azure-devops, ci-cd, separacao, env, servidor-traker]
created: 2026-08-13
updated: 2026-08-13
---

# Dois repositórios no Azure DevOps — arquitetura, variáveis e handoff

Rauny criou os repositórios e vai montar as pipelines de CI/CD:

- `https://dev.azure.com/Officecom/OfficeCore/_git/codigovencedor-tracking-api`
- `https://dev.azure.com/Officecom/OfficeCore/_git/codigovencedor-tracking-app`

Os dois repositórios estão **montados, testados e commitados** em
`Servidor Proprio/repos/` — falta só o push (comandos na seção 4).

## 1. Como tudo funciona (o desenho)

```
                        internet (zyraflow.site — DNS já apontado)
                                        │
                              ┌─────────▼─────────┐
                              │  CADDY  (repo api) │  TLS automático, porta 80/443
                              │  roteia por caminho│
                              └────┬──────────┬────┘
      /api /e /c /s /t /health ... │          │  todo o resto (/painel, /login, /)
                              ┌────▼────┐ ┌───▼──────────┐
                              │ api:3000│ │ app:80 (nginx)│  ← repo app
                              │ worker  │ │ estáticos     │
                              │ db      │ │ zero segredo  │
                              └─────────┘ └───────────────┘
                               repo api      rede docker externa: tracking-net
```

- **Mesma origem para o navegador** (tudo em `https://zyraflow.site`): cookies e
  proteção CSRF continuam no modo simples e seguro. A separação é de repositório e
  de pipeline — não de domínio.
- **O container do painel não tem segredo nenhum**: é nginx + HTML/CSS/JS. Pode até
  vazar a imagem inteira que nada se perde.
- **Se o painel cair, a ingestão continua**: as rotas de evento não passam pelo app.
- Deploys independentes: pipeline do app publica painel sem tocar na API e vice-versa.

## 2. Variáveis de ambiente — a resposta curta: **segredo não vai em repositório**

O repo da API versiona **só o `.env.example`** (modelo comentado, sem valores). Os
valores reais vivem em `servidor-traker/.env.producao` na sua máquina (fora do git)
e precisam chegar ao servidor por um destes canais — decidir com o Rauny:

| Canal | Como | Quando usar |
|---|---|---|
| **A. Você mesmo, por SSH** (mais simples) | `scp .env.producao ubuntu@<IP>:~/tracking-api/.env` | você tem acesso SSH à VM; a pipeline só faz build+up e assume que o `.env` existe na máquina |
| **B. Variáveis secretas da pipeline** | Rauny cria um *Variable Group* (ou Azure Key Vault) com os valores marcados como secret; a pipeline gera o `.env` na VM no deploy | padrão corporativo, auditável; você entrega os valores UMA vez por canal seguro |

**Nunca**: mandar os valores por Discord/e-mail em texto puro, ou commitá-los.

### Matriz do que a API precisa (`.env` na VM)

| Variável | Segredo? | Valor / origem |
|---|---|---|
| `POSTGRES_PASSWORD` | 🔒 sim | já gerada (está no `.env.producao`) |
| `DATABASE_URL` | 🔒 sim | idem (contém a senha acima) |
| `APP_SECRET` | 🔒 **crítico** | cifra as credenciais de anúncio; já gerada. Perder = perder as credenciais salvas |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 🔒 sim | admin master; já definidos |
| `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | 🔒 sim | Gmail `notificacoes010@gmail.com` + senha de app; trocar de provedor = trocar só estas variáveis |
| `PUBLIC_HOST` | não | `zyraflow.site` |
| `PUBLIC_SCHEME` | não | `https` |
| `NODE_ENV`, `PORT`, `TRUST_PROXY`, `META_API_VERSION`, `LOG_LEVEL`, `WORKER_*`, `RETENTION_DAYS`, `SESSION_TTL_HOURS`, `COOKIE_MAX_AGE_DAYS`, `SET_FIRST_PARTY_COOKIES`, `CONVITE_TTL_HORAS`, `RESET_TTL_HORAS` | não | como no `.env.producao` |
| `CADDY_SITE` | não | Deixar em branco serve um domínio só, seguindo o `PUBLIC_HOST`. Para servir o painel também em subdomínio próprio, **liste os dois separados por vírgula** — ver abaixo |

### Painel em subdomínio próprio (`app.zyraflow.site`)

Se o painel precisa de hostname próprio, **não** o publique como um site separado. Basta
listar os dois no `CADDY_SITE`:

```
CADDY_SITE=zyraflow.site, app.zyraflow.site
```

O Caddy passa a servir os **dois** hostnames com o mesmo roteamento por caminho e emite
certificado para ambos. Verificado com `caddy adapt`:

```
hosts : zyraflow.site, app.zyraflow.site
certs : app.zyraflow.site, zyraflow.site
```

**Por que não um site separado para o painel.** O front chama a API por caminho relativo
(`fetch('/api' + path)`, em `public/admin/nucleo.js`) e o nginx do repo do painel devolve
**404 de propósito** para `/api/*` — é um canário de roteamento errado. Um site que aponte
só para o nginx faria a tela carregar e **todas** as chamadas falharem com 404.

Listando no `CADDY_SITE`, cada hostname continua sendo *mesma origem* para o navegador:
o painel em `app.zyraflow.site` chama `app.zyraflow.site/api/...`, o Caddy roteia para o
Node, e não há cross-origin. Nada de CORS, nada de mexer na CSP, nada de mexer no código.

**Pré-requisitos:** registro DNS de `app.zyraflow.site` apontando para o mesmo IP (o
certificado é pedido na primeira subida — sem DNS, o desafio ACME falha).

**Uma consequência a saber:** o cookie de sessão é por hostname. Quem loga em
`app.zyraflow.site` não está logado em `zyraflow.site`, e vice-versa. Não é defeito, mas
convém escolher um dos dois como endereço oficial do painel para não confundir a equipe.

### E o repo do painel?

**Zero variáveis.** O app é estático puro — não existe `.env` nele. É por isso que a
pipeline dele é trivial: build da imagem nginx e `docker compose up`.

> As credenciais de Meta/Google **não** são variáveis de ambiente: entram pelo
> painel depois do deploy e ficam cifradas (AES-256-GCM com o `APP_SECRET`) no banco.

## 3. O que cada pipeline faz (para o Rauny montar)

Pré-requisito único na VM (uma vez): `docker network create tracking-net`

**Pipeline `codigovencedor-tracking-api`** (a cada push na `main`):

```bash
npm ci
npm run test:unit                        # rápido, sem banco (CI)
# deploy na VM (ssh):
docker compose up -d --build
docker compose run --rm api npm run migrate
curl -fsS https://zyraflow.site/health   # gate: {"ok":true,"db":true}
```

**Pipeline `codigovencedor-tracking-app`**:

```bash
npm test                                 # 13 asserções estáticas, sem banco/Docker
# deploy na VM (ssh):
docker compose up -d --build
curl -fsS -o /dev/null https://zyraflow.site/login   # gate
```

Ordem do primeiro deploy: rede → api (sobe Caddy) → app. Depois disso a ordem não
importa mais.

## 4. Push (você roda; precisa do seu login no Azure)

```bash
cd "Servidor Proprio/repos/codigovencedor-tracking-api"
git remote add origin https://dev.azure.com/Officecom/OfficeCore/_git/codigovencedor-tracking-api
git push -u origin main

cd ../codigovencedor-tracking-app
git remote add origin https://dev.azure.com/Officecom/OfficeCore/_git/codigovencedor-tracking-app
git push -u origin main
```

(Se pedir senha: use um Personal Access Token do Azure DevOps, não a senha da conta.)

## 5. Mensagem pronta para o Rauny

> Rauny, códigos no ar nos dois repos. Resumo pro CI/CD:
>
> **Pré-requisito na VM (uma vez):** `docker network create tracking-net`
>
> **tracking-api** — Node 22. CI: `npm ci && npm run test:unit`. Deploy:
> `docker compose up -d --build && docker compose run --rm api npm run migrate`.
> Gate: `curl -fsS https://zyraflow.site/health`. Precisa de um `.env` na pasta do
> compose (te passo os valores por canal seguro — me diz se prefere colocar direto
> na VM ou como variáveis secretas da pipeline / Key Vault; NENHUM segredo está no
> repo, só o `.env.example`).
>
> **tracking-app** — estático (nginx), sem env nenhum. CI: `npm test` (só Node,
> sem banco). Deploy: `docker compose up -d --build`. Gate:
> `curl -fsS https://zyraflow.site/login`.
>
> Ordem só no primeiro deploy: rede → api → app. O Caddy do repo da api é quem
> escuta 80/443 e roteia para o app pela `tracking-net`; portas 80 e 443 precisam
> estar liberadas nas duas camadas (Security List + iptables). O DNS do
> zyraflow.site você já apontou — o certificado sai sozinho no primeiro boot. Valeu!

## 6. O monorepo continua sendo a fonte

`servidor-traker/` segue como ambiente de desenvolvimento (um compose só, Express
servindo o painel). A divisão é reproduzível: `bash deploy/montar-repos.sh` remonta
as duas pastas de `repos/` a partir do monorepo — commit e push a partir delas.
