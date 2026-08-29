---
title: Deploy no homelab com Portainer e Cloudflare Tunnel
tags: [infra, deploy, homelab, portainer, cloudflare, cloudflare-tunnel, docker, servidor-traker]
created: 2026-08-29
updated: 2026-08-29
---

> ## ⚠️ CORREÇÃO — leia antes de seguir este guia
>
> Este documento foi escrito assumindo um `cloudflared` **dentro da stack**, com um túnel
> novo e um `TUNNEL_TOKEN`. **Não é assim que o deploy foi feito.**
>
> Ao inspecionar a conta Cloudflare descobrimos que a máquina **já roda um túnel**
> (`servidor-abner`), servindo 24 aplicações — e todas as rotas dele apontam para
> `localhost:<porta>` ou `192.168.3.16:<porta>`. Ou seja, o `cloudflared` vive na **rede do
> host** e não resolve nomes de container. Subir um segundo `cloudflared` com o mesmo token
> criaria duas réplicas do mesmo túnel, e a Cloudflare sortearia entre elas — metade das
> requisições cairia na réplica que não enxerga esta stack.
>
> **O que vale hoje:**
>
> - **Não existe** serviço `cloudflared` nesta stack, e **não existe** a variável `TUNNEL_TOKEN`.
> - O Caddy publica `127.0.0.1:8099:80` no host (loopback apenas — nada exposto na LAN).
> - No túnel `servidor-abner` existente, adiciona-se uma *published application route*:
>   `<PUBLIC_HOST>` → `http://localhost:8099`.
> - `PUBLIC_HOST` é um subdomínio de `proxserverabner.site`. O `zyraflow.site` **não está**
>   nessa conta Cloudflare, então não serve para este deploy.
>
> Tudo o mais neste guia — variáveis, boot automático, limitação da aba Domínios, armadilhas
> de WAF, SSE e backup — continua válido. As seções 3.2 a 3.4 e a 6 sobre `cloudflared` estão
> desatualizadas e serão reescritas.



# Deploy no homelab com Portainer e Cloudflare Tunnel

Guia passo a passo para colocar o **Servidor Traker** no ar em uma máquina própria
(homelab), usando **Portainer** para gerenciar a stack e **Cloudflare Tunnel** para expor
o serviço na internet — **sem IP público, sem abrir porta nenhuma no roteador**.

Este é um caminho alternativo ao `02-deploy-oracle-cloud.md` (VM com IP público) e ao
`14-repos-azure.md` (pipeline do Azure DevOps na infra da empresa). Os três descrevem o
mesmo software; o que muda é onde ele mora e como o tráfego chega até ele.

Assim como os outros guias, este assume **zero conhecimento prévio de administração de
servidor**. Onde tiver um bloco de comando, é para copiar e colar trocando só o que
estiver `EM_MAIUSCULO_ASSIM`.

Arquivos que este documento pressupõe já existirem no repositório:

| Arquivo | Papel |
|---|---|
| `docker-compose.homelab.yml` | Stack específica deste cenário (raiz do projeto). **Não** é o `docker-compose.yml`, que continua sendo o do deploy com IP público. |
| `infra/Caddyfile.homelab` | Configuração do Caddy sem TLS e sem `on_demand_tls` — quem termina o HTTPS é a Cloudflare. Os comentários dele explicam cada decisão. |

---

## 1. O que muda em relação ao deploy com IP público

### 1.1 A topologia

```
   Visitante / GTM / webhook do backoffice
                    │  HTTPS (certificado da Cloudflare)
                    ▼
        ┌───────────────────────────┐
        │      CLOUDFLARE (borda)   │  ← termina o TLS, aplica WAF/Bot Fight,
        │   DNS + proxy + WAF       │    define CF-Connecting-IP
        └─────────────┬─────────────┘
                      │  conexão de SAÍDA, iniciada de dentro do homelab
                      │  (nenhuma porta aberta no roteador)
                      ▼
   ══════════════ HOMELAB (sua máquina, Docker/Portainer) ══════════════
        ┌───────────────────────────┐
        │  cloudflared              │  ← mantém o túnel; resolve `caddy`
        └─────────────┬─────────────┘    pelo nome da rede docker
                      │  http://caddy:80
                      ▼
        ┌───────────────────────────┐
        │  caddy  (:80, HTTP puro)  │  ← auto_https off; reescreve
        └─────────────┬─────────────┘    X-Forwarded-For a partir de
                      │  api:3000        CF-Connecting-IP
                      ▼
        ┌───────────────────────────┐      ┌──────────────┐
        │  api  (Express, :3000)    │◄────►│  worker      │
        └─────────────┬─────────────┘      └──────┬───────┘
                      │ db:5432                   │
                      ▼                           ▼
        ┌───────────────────────────────────────────────┐
        │  db (PostgreSQL 16) — volume pgdata           │
        └───────────────────────────────────────────────┘
              rede docker `interna` — nada publicado no host
   ═════════════════════════════════════════════════════════════════════
```

Cinco containers: `db`, `api`, `worker`, `caddy`, `cloudflared`. Uma rede, `interna`.
Três volumes: `pgdata`, `caddy_data`, `caddy_config`.

> **Por que o `cloudflared` roda dentro da mesma stack.** Ele precisa alcançar o Caddy pelo
> nome `caddy`, e nome de serviço só resolve dentro da rede do compose. Rodando o
> `cloudflared` fora (instalado no host, ou em outra stack), `http://caddy:80` não resolve
> e o túnel devolve erro 502 sem nenhuma pista no log do Node — porque a requisição nunca
> chegou ao Node.

Repare no que **desapareceu** em relação ao `docker-compose.yml` de produção: o serviço
`caddy` não publica mais `80:80` nem `443:443`. Nenhum container publica porta no host. O
único caminho de entrada é o túnel, que é uma conexão iniciada **de dentro para fora**.

### 1.2 O que se ganha e o que se perde

| | Deploy com IP público (docs/02, docs/12) | Homelab + Cloudflare Tunnel (este documento) |
|---|---|---|
| **Custo mensal** | Always Free da Oracle hoje; conta da empresa se cair para x86 | Energia + link que você já paga |
| **Dependência de terceiros** | Instância provisionada pelo Rauny; cada mudança de rede é um pedido | Você mesmo, na sua máquina |
| **Portas no roteador** | 80 e 443 abertas, nas duas camadas de firewall | **Nenhuma.** Não há porta de entrada para varrer |
| **IP público** | Precisa ser reservado; se mudar, quebra tudo | Irrelevante — pode ser dinâmico, pode ser CGNAT |
| **Certificado TLS** | Let's Encrypt, emitido pelo Caddy, renovação automática | Cloudflare, na borda. Nada a renovar do seu lado |
| **Superfície exposta** | O serviço inteiro, direto na internet | Só o que a Cloudflare deixa passar; a origem é invisível |
| **DDoS / bot** | Só o que o Caddy e a aplicação fizerem | WAF e mitigação da Cloudflare de graça — que é bênção e maldição, ver §6 |
| **Latência** | Um salto: visitante → Caddy | Dois saltos: visitante → borda Cloudflare → túnel → Caddy |
| **Domínio de cliente (modelo Stape)** | Funciona: cliente aponta CNAME, Caddy emite certificado sob demanda | **Não funciona.** Ver §5 — é a perda mais séria |
| **Disponibilidade** | SLA de datacenter, energia e link redundantes | Sua energia e seu link. Queda = ingestão parada (§6d) |
| **Backup** | Snapshot de boot volume + `pg_dump` para o Object Storage | Só o que você montar. Não há snapshot de provedor (§6c) |
| **Quem consegue mexer** | Precisa de SSH e de saber Linux | UI do Portainer no navegador; deploy é um botão |

Resumo honesto: você troca **dependência organizacional e custo** por **responsabilidade
operacional e um teto arquitetural** (o §5).

---

## 2. Pré-requisitos no homelab

| Item | Detalhe |
|---|---|
| **Máquina ligada 24/7** | Qualquer coisa com 4 GB de RAM já roda a stack; 8 GB dá folga para o Postgres crescer. Se ela desliga à noite, leia o §6d antes de decidir. |
| **Docker + Docker Compose v2** | O Portainer usa o Docker do host. `docker compose version` (sem hífen) precisa responder. |
| **Portainer CE ou BE** | Versão recente o bastante para ter *Stacks → Repository* (deploy a partir de git). Praticamente qualquer instalação atual tem. |
| **Disco** | 40 GB é o mínimo confortável. O que cresce é o `pgdata` (eventos) e as imagens Docker. |
| **Conta na Cloudflare com o domínio ativo** | O domínio precisa estar com os *nameservers* da Cloudflare, não só cadastrado. Sem isso não há como criar hostname público no túnel. |
| **Conta no GitHub** | Para o repositório privado que o Portainer vai puxar. |
| **Saída HTTPS liberada** | O `cloudflared` abre conexão de saída para a borda da Cloudflare. Se a rede tiver firewall de saída restritivo, libere-o. Não é necessário liberar nada de entrada. |
| **Fuso horário do host** | `America/Sao_Paulo`, para os logs baterem com o que você vê no painel. |

Não é pré-requisito: IP fixo, DDNS, encaminhamento de porta, DMZ, certificado. Nada disso
é usado neste desenho.

---

## 3. Passo a passo

### 3.1 Criar o repositório privado no GitHub e dar push

O Portainer vai buscar o código no git. Logo, o código precisa estar em um repositório —
e ele tem que ser **privado**, porque o repositório carrega o `docker-compose.homelab.yml`,
o `Caddyfile.homelab` e o código da aplicação inteira.

> **Segredo nenhum vai no repositório.** O `.gitignore` do projeto já bloqueia `.env`,
> `.env.*` (exceto `.env.example`), `caddy_data/` e `caddy_config/`. Confirme antes do
> primeiro push:
>
> ```bash
> git status --porcelain --ignored | grep -E '\.env$|caddy_data|caddy_config'
> ```
>
> As linhas devem começar com `!!` (ignorado). Se alguma aparecer como `A ` (adicionada),
> **pare** e conserte antes de commitar.

Na sua máquina, dentro da pasta do projeto:

```bash
cd "servidor-traker"

git init                       # se ainda não for um repositório
git add -A
git commit -m "stack de homelab: compose, Caddyfile e docs"

# crie o repositório PRIVADO no github.com/new (ou pelo gh CLI abaixo)
gh repo create SEU_USUARIO/servidor-traker --private --source=. --remote=origin

git push -u origin main
```

Se preferir criar pela web, o `git remote add origin ...` é o caminho manual:

```bash
git remote add origin https://github.com/SEU_USUARIO/servidor-traker.git
git branch -M main
git push -u origin main
```

**Autenticação:** o GitHub não aceita mais senha de conta no `git push`. Use um
**Personal Access Token** (fine-grained, com permissão *Contents: read and write* apenas
neste repositório) ou uma chave SSH. Guarde o token no gerenciador de senhas — o Portainer
vai pedir um também, no passo 3.3, e o dele pode ser **somente leitura**.

### 3.2 Criar o túnel na Cloudflare e pegar o token

No painel da Cloudflare, crie um **tunnel** (fica na área de Zero Trust, em *Networks →
Tunnels*, mas a Cloudflare reorganiza esse menu com alguma frequência — procure por
"Tunnels"). Dê um nome que você reconheça daqui a seis meses, ex.: `homelab-traker`.

Ao criar, escolha o modo **conector gerenciado por token** (a Cloudflare oferece
instaladores para Windows/Debian/Docker; o que você quer é o **token**, não o instalador).
A tela mostra um comando parecido com:

```
docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJhIjoi...
```

**O que interessa é só a string depois de `--token`.** Copie-a: é o valor da variável
`TUNNEL_TOKEN` do passo 3.4.

> ⚠️ **O `TUNNEL_TOKEN` é um segredo de verdade.** Quem tiver esse token consegue subir um
> conector daquele túnel em outra máquina. Trate-o como senha: gerenciador de senhas, nunca
> em repositório, nunca em print, nunca em mensagem de Discord.

**Ainda não configure o hostname público** — isso é o passo 3.7, depois que a stack estiver
de pé. Configurar antes só faz a Cloudflare devolver erro 502 para quem acessar, e você
perde tempo achando que é problema de configuração.

### 3.3 Criar a stack no Portainer pela opção **Repository**

No Portainer: **Stacks → Add stack**. Dê o nome `servidor-traker`.

Aparecem várias opções de origem (Web editor, Upload, Repository, Custom template).
**Escolha `Repository`.**

> ### Por que o *Web editor* NÃO serve aqui
>
> É a tentação óbvia — colar o YAML numa caixa de texto e clicar em deploy. Não funciona
> neste projeto, e o motivo é concreto:
>
> Os serviços `api` e `worker` **não usam imagem pronta**: eles têm `build:` com
> `context: .` e `dockerfile: Dockerfile`. O Docker precisa de um *contexto de build* —
> uma pasta com o `Dockerfile`, o `package.json`, `src/`, `public/` e `gtm/`.
>
> O Web editor entrega ao Docker **um arquivo YAML solto e nada mais**. Não há pasta, não
> há `Dockerfile`, não há `src/`. O deploy falha com algo do tipo
> `unable to prepare context: path "." not found` ou `failed to read dockerfile`.
>
> O mesmo vale para o `caddy`, que faz `- ./infra/Caddyfile.homelab:/etc/caddy/Caddyfile:ro`:
> sem a pasta do projeto no disco, esse *bind mount* não acha o arquivo. Dependendo da
> versão do Docker, ele **cria um diretório vazio** com esse nome em vez de falhar — e aí o
> Caddy sobe com a configuração padrão dele, responde a página "Congratulations!" no lugar
> da aplicação, e você fica sem entender por quê.
>
> A opção **Repository** resolve as duas coisas de uma vez: o Portainer clona o repositório
> inteiro numa pasta do host e roda o compose de dentro dela. `build: context: .` acha o
> `Dockerfile`, e `./infra/Caddyfile.homelab` acha o Caddyfile.

Preencha:

| Campo | Valor |
|---|---|
| Repository URL | `https://github.com/SEU_USUARIO/servidor-traker` |
| Repository reference | `refs/heads/main` |
| Compose path | `docker-compose.homelab.yml` ← **não** `docker-compose.yml` |
| Autenticação | Ligada. Usuário = seu login do GitHub; senha = **Personal Access Token** (basta *Contents: read*). |

O campo do caminho do compose é o erro mais fácil de cometer: deixar o valor padrão
`docker-compose.yml` sobe a stack **errada** — a de IP público, que tenta publicar 80/443
no host e emitir certificado Let's Encrypt que nunca vai sair.

**Sobre o *auto update* / *GitOps updates*:** se o Portainer oferecer polling automático do
repositório, ligar é conveniente (`git push` vira deploy). Mas entenda o que isso
significa: qualquer commit na `main` vai para produção sozinho, sem ninguém olhar. Para
começar, deixe desligado e faça o redeploy pelo botão — quando a rotina estiver madura,
reavalie.

### 3.4 Preencher as variáveis de ambiente

Ainda na tela da stack, na seção de **Environment variables**, adicione cada par
nome/valor. É aqui que os segredos vivem: eles ficam guardados no Portainer, **não** no
repositório e **não** num `.env` no disco.

**Gere os valores aleatórios antes**, em qualquer terminal:

```bash
openssl rand -hex 32      # → APP_SECRET (64 caracteres hexadecimais)
openssl rand -base64 24   # → POSTGRES_PASSWORD
```

#### Obrigatórias

| Variável | O que é |
|---|---|
| `POSTGRES_PASSWORD` | Senha do usuário `traker` do Postgres. **Só tem efeito na primeira criação do volume `pgdata`** — mudar depois não muda a senha do banco (ver §7 do `02-deploy-oracle-cloud.md`). |
| `APP_SECRET` | Chave AES-256-GCM que cifra as credenciais dos clientes no banco. 64 caracteres hex. |
| `PUBLIC_HOST` | O hostname público, ex.: `traker.seudominio.com`. É o mesmo que você vai configurar no túnel no passo 3.7. Sem `https://` e sem barra. |
| `ADMIN_EMAIL` | E-mail do primeiro usuário do painel. |
| `ADMIN_PASSWORD` | Senha desse usuário. Longa e única. Troque pelo painel após o primeiro login. |
| `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Envio de convite e reset de senha (ver `09-usuarios-e-email.md`). |
| `TUNNEL_TOKEN` | O token do passo 3.2. |

> ⚠️ **Sobre o `APP_SECRET`, e vale reler mesmo se você já leu no docs/02.** Ele cifra, no
> banco, todos os access tokens de Meta CAPI, tokens de Google Ads e api secrets dos
> clientes. **Perder o `APP_SECRET` = perder todas as credenciais de todos os projetos**,
> mesmo com backup do banco intacto — o segredo não está no dump.
>
> No homelab isso é *mais* arriscado que na nuvem, não menos: aqui o valor vive só na base
> do Portainer, num disco na sua casa. Copie-o **hoje** para um gerenciador de senhas fora
> da máquina, antes de clicar em deploy.

#### Opcionais (têm default no compose — só preencha para mudar o padrão)

| Variável | Para que serve |
|---|---|
| `PUBLIC_SCHEME` | `https` — usado para montar as URLs que o painel mostra. |
| `META_API_VERSION` | Versão da Graph API nas chamadas de CAPI. |
| `LOG_LEVEL` | `info` no dia a dia; `debug` só para investigar. |
| `WORKER_CONCURRENCY` | Entregas processadas em paralelo pelo worker. |
| `WORKER_POLL_MS` | Intervalo de consulta à fila quando ela está vazia. |
| `MAX_ATTEMPTS` | Tentativas antes de a entrega virar `dead`. |
| `RETENTION_DAYS` | Dias de retenção de eventos antes do expurgo (LGPD). |
| `SESSION_TTL_HOURS` | Duração da sessão de login no painel. |
| `COOKIE_MAX_AGE_DAYS` | Validade do cookie first-party do coletor. |
| `SET_FIRST_PARTY_COOKIES` | Se o servidor grava cookies de identidade em nome do site. |
| `SMTP_HOST` / `SMTP_PORT` | Servidor de e-mail (default serve para Gmail). |
| `CONVITE_TTL_HORAS` / `RESET_TTL_HORAS` | Validade dos links de convite e de reset de senha. |

#### Duas variáveis que você **não** deve criar

- **`DATABASE_URL` não existe nesta stack.** No `docker-compose.homelab.yml` ela é montada
  a partir de `POSTGRES_PASSWORD`, dentro do compose. Criá-la à mão na UI do Portainer
  reintroduz exatamente o bug que a derivação elimina: dois lugares com a mesma senha, um
  deles desatualizado, e o sintoma é `password authentication failed` num container que
  ontem funcionava. Se você veio do `.env.example` (que tem `DATABASE_URL`), essa é a
  diferença a memorizar.
- **`CADDY_SITE` também não.** O `Caddyfile.homelab` escuta em `:80` sem nome de host de
  propósito — quem decide qual hostname é válido é o Public Hostname do túnel.

### 3.5 Deploy

Clique em **Deploy the stack**.

O primeiro deploy demora: o Portainer clona o repositório e o Docker **constrói a imagem**
(`npm ci` das dependências, dois estágios). Alguns minutos é normal. Os seguintes usam
cache e são rápidos.

Quando terminar, a lista de containers da stack deve mostrar cinco entradas em `running`:
`db`, `api`, `worker`, `caddy`, `cloudflared`.

Sinais de saúde, na ordem em que aparecem:

- **`db`** vira `healthy` depois de ~30 s (o healthcheck é `pg_isready`).
- **`api`** só começa depois disso (`depends_on: condition: service_healthy`). No log dela
  você deve ver as migrações rodando e, no fim, `API do Servidor Traker no ar`.
- **`cloudflared`** loga `Registered tunnel connection` (normalmente quatro conexões, para
  datacenters diferentes). Se ele logar erro de autenticação, o `TUNNEL_TOKEN` foi colado
  com espaço, quebra de linha ou aspas em volta.

### 3.6 Verificar de dentro, antes de mexer na Cloudflare

Faça isto **antes** de configurar o hostname público. Se falhar aqui, o problema é da
stack e não tem nada a ver com a Cloudflare — e diagnosticar as duas coisas ao mesmo tempo
é o jeito mais rápido de perder uma tarde.

No host do homelab (ou pelo console de container do Portainer):

```bash
# A api responde e enxerga o banco?
docker exec -it servidor-traker-api-1 \
  node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log)"

# O Caddy está na frente e repassando?
docker exec -it servidor-traker-cloudflared-1 \
  sh -c 'wget -qO- http://caddy:80/health'
```

(Os nomes de container seguem o padrão `<stack>-<serviço>-<n>`; confirme na lista do
Portainer.) Se a segunda chamada não responder, o problema é rede docker ou o bind mount do
Caddyfile — não é o túnel.

### 3.7 Configurar o Public Hostname do túnel

Volte ao túnel criado no passo 3.2 e **crie um Public Hostname** com:

- **Hostname**: o mesmo valor que você pôs em `PUBLIC_HOST`, ex.: `traker.seudominio.com`
  (subdomínio + domínio da sua conta Cloudflare).
- **Serviço / origem**: `HTTP` apontando para **`caddy:80`** — ou seja, a URL de origem é
  `http://caddy:80`.

`caddy` aqui é o nome do serviço no compose, resolvido pelo DNS interno da rede `interna`.
É por isso que o `cloudflared` precisa estar na mesma stack.

**`http://` e não `https://` é proposital.** O `Caddyfile.homelab` tem `auto_https off` e
escuta HTTP puro; o TLS acaba na borda da Cloudflare. Apontar o túnel para `https://caddy:443`
falha — não há nada escutando na 443 dentro da stack.

Ao salvar, a Cloudflare cria sozinha o registro DNS (um `CNAME` para o túnel, com proxy
ligado). Você **não** precisa criar registro A nem apontar IP nenhum — e nem poderia, já
que não há IP.

### 3.8 Verificação final

Da sua máquina, fora da rede do homelab (dados móveis do celular servem, e são um teste
melhor):

```bash
curl -s https://SEU_DOMINIO/health
```

Esperado, exatamente:

```json
{"ok":true,"db":true}
```

(O JSON real também traz `uptime` — o que importa é `ok` e `db` em `true`. É esse endpoint
que o `src/server.js:71-78` serve: ele roda um `SELECT 1` de verdade contra o Postgres, por
isso `db:true` prova a cadeia inteira, não só que o Node está vivo.)

Se vier `{"ok":false,"db":false,...}`, a api está no ar mas não fala com o banco — olhe o
log do `db`. Se vier uma página de erro da Cloudflare, o problema está entre a borda e o
Caddy; erros 1033 e 502 nessa etapa quase sempre são hostname público apontando para o
lugar errado ou `cloudflared` fora da stack.

Depois disso:

```bash
# painel abre e pede login
curl -s -o /dev/null -w '%{http_code}\n' https://SEU_DOMINIO/login

# endpoint de ingestão existe (404/400 com JSON é o esperado para slug inexistente,
# NÃO um erro de conexão)
curl -i https://SEU_DOMINIO/e/slug-de-teste
```

No navegador: `https://SEU_DOMINIO/painel` deve pedir login e aceitar o
`ADMIN_EMAIL`/`ADMIN_PASSWORD` que você cadastrou.

---

## 4. Migração e admin inicial são automáticos — não há passo manual

Este é o ponto em que este guia **diverge do `02-deploy-oracle-cloud.md`**. Aquele
documento manda rodar `npm run migrate` e `npm run seed` à mão depois do `up -d`. Aqui, não
existe onde rodar isso confortavelmente (não há SSH na pasta do projeto, e abrir console de
container no Portainer para todo deploy é frágil).

**Não precisa.** O boot da aplicação já faz as três coisas, em ordem, antes de abrir a
porta HTTP — `src/server.js:157-160`:

```js
async function main() {
  await waitForDatabase();
  await runMigrations();
  await bootstrapAdmin();
```

O que cada uma faz:

| Chamada | Efeito | Onde está |
|---|---|---|
| `waitForDatabase()` | Espera o Postgres aceitar conexão. Torna irrelevante a corrida de quem sobe primeiro. | `src/db/pool.js`, importado em `src/server.js:10` |
| `runMigrations()` | Aplica as migrações pendentes de `src/db/migrations/`. Em banco novo, cria o schema inteiro; em banco existente, só o que faltar. | `src/db/migrate.js`, importado em `src/server.js:11` |
| `bootstrapAdmin()` | Cria o usuário inicial a partir de `ADMIN_EMAIL`/`ADMIN_PASSWORD`. | `src/server.js:142-156` |

O `bootstrapAdmin()` é conservador de propósito (`src/server.js:143-144`):

```js
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;
if ((await countUsers()) > 0) return;
```

Ou seja: **ele só age se o banco não tiver nenhum usuário**. Não sobrescreve senha, não
recria usuário apagado, não faz nada em deploy subsequente. Se você trocar a senha pelo
painel e depois redeployar, a senha do painel continua sendo a nova — a variável do
Portainer vira letra morta. (E isso é bom: remova `ADMIN_PASSWORD` das variáveis depois do
primeiro login, pelo mesmo motivo que o docs/02 manda tirar do `.env`.)

Consequências práticas para a operação no Portainer:

- **Deploy de versão nova = clicar em *Pull and redeploy*.** A api sobe, migra e continua.
  Nenhum comando manual.
- **Se uma migração falhar, a api não sobe** — `main()` rejeita e o `catch` de
  `src/server.js:186-190` encerra o processo com `falha fatal ao iniciar a API`. O container
  entra em restart loop. Isso é o comportamento correto (melhor não subir do que subir com
  schema errado), mas significa que **restart loop da `api` logo após um deploy é quase
  sempre migração, não configuração**. Leia o log antes de mexer em variável.
- **Nunca "resolva" isso apagando o volume `pgdata`.** Isso apaga o banco inteiro.

---

## 5. ⚠️ O que NÃO funciona neste deploy: domínio de cliente com certificado sob demanda

Esta é a limitação séria do desenho, e ela é **estrutural** — não há configuração que a
contorne.

### 5.1 O que deixa de funcionar

O modelo Stape, que o projeto suporta no deploy com IP público, funciona assim: o cliente
cria um `CNAME`/registro apontando `sgtm.dominiodocliente.com.br` para o **nosso servidor**;
na primeira visita, o Caddy recebe o handshake TLS com aquele SNI, consulta
`GET /api/caddy/ask?domain=...` (`src/admin/router.js:149`) para saber se o domínio está
autorizado, e **emite o certificado na hora**. É isso que dá ao cliente um coletor
*first-party* de verdade, no domínio dele — o que sobrevive melhor a bloqueador de anúncio
e a restrições de cookie de terceiro.

**Atrás do Cloudflare Tunnel, isso não acontece.** Dois motivos independentes, cada um
suficiente sozinho:

1. **Não existe IP para o cliente apontar.** O DNS do cliente precisa de um destino. Com
   túnel, não há endereço público — o roteamento é feito por hostname *dentro da conta
   Cloudflare*, e o cliente não tem como criar um `CNAME` para um túnel de outra conta.
2. **A Cloudflare só emite certificado para hostname que esteja na conta dela.** Ela
   termina o TLS na borda; para apresentar um certificado de `dominiodocliente.com.br`,
   esse domínio precisaria ser uma zona da sua conta — o que exigiria que o cliente
   entregasse os nameservers dele para você.

Servir domínio de terceiro atrás da Cloudflare tem um caminho oficial: **Cloudflare for
SaaS (Custom Hostnames)**, que emite e renova certificado para domínios dos seus clientes
apontando para a sua infraestrutura. É um **produto pago à parte**, com cobrança por
hostname personalizado ativo.

> **Confira o preço na página oficial da Cloudflare antes de considerar isso no orçamento.**
> Este documento deliberadamente não registra valor: o modelo de cobrança de Cloudflare for
> SaaS mudou mais de uma vez, e um número desatualizado aqui seria pior do que nenhum.

Consequência concreta no produto: **a aba "Domínios" do painel não tem efeito neste
deploy.** Você pode cadastrar um domínio lá, o registro entra no banco, o endpoint
`/api/caddy/ask` continua existindo e respondendo — mas ninguém o chama, porque não há
Caddy emitindo certificado. O `Caddyfile.homelab` remove o `on_demand_tls` e o bloco
coringa `:443` justamente por isso: manter aquela configuração seria uma armadilha, um
mecanismo que parece armado e nunca dispara.

### 5.2 Por que isso hoje não bloqueia nada

A arquitetura escolhida em `12-deploy-zyraflow.md` é **webhook-first**: as conversões chegam
por `POST` do backoffice para `/e/<slug>` com `Authorization: Bearer <ingest_token>`, já
trazendo `attribution.cookies` (`fbp`/`fbc`/`fbclid`/`gclid`) capturados no checkout. Esse
caminho é **servidor para servidor** e não depende de domínio nenhum do cliente — o `POST`
sai do backoffice direto para `https://SEU_DOMINIO/e/<slug>`.

A atribuição também não sofre: a Meta não olha o domínio de quem envia. A campanha é
atribuída pelo `fbc`/`fbclid` dentro do evento, e o Events Manager exibe o domínio do
`event_source_url`, que continua sendo o do site do cliente.

Ou seja: **hoje, com o modelo webhook-first, o homelab entrega 100% do que precisa
entregar.**

### 5.3 Mas é um teto, e vale saber disso agora

O que fica fora de alcance enquanto o deploy for atrás de túnel:

- Vender/entregar coletor first-party no domínio do cliente (o argumento comercial central
  do modelo Stape).
- Camada de navegador com tags first-party no site do cliente, que o `docs/12` cita como
  "evolução futura, o sistema já suporta".
- Qualquer cliente que exija que o endpoint de coleta esteja no domínio *dele* por política
  de consentimento ou de CSP.

Se algum desses virar requisito, as saídas são três, nesta ordem de custo: (a) contratar
Cloudflare for SaaS; (b) mover a produção de volta para uma máquina com IP público
(`02-deploy-oracle-cloud.md` volta a valer inteiro); (c) manter um deploy híbrido — homelab
para o que é webhook, IP público para os clientes com domínio próprio. **Decida isso antes
de prometer o recurso a um cliente**, não depois.

---

## 6. Armadilhas operacionais

Cada uma destas já custou tempo a alguém. O que torna essas quatro perigosas é que **três
delas falham em silêncio** — nada aparece no log do Node.

### 6a. WAF / Bot Fight Mode bloqueando os POST de ingestão

**Sintoma observável:** o evento simplesmente **some**. O GTM (ou o backoffice) dispara, o
navegador mostra a requisição saindo, e **não há linha nenhuma no log da `api`** — nem
sucesso, nem erro, nem 400. O painel não registra o evento. Do lado do cliente, a resposta
pode ser um HTML de desafio da Cloudflare (JS challenge) ou um 403 — em vez do JSON que a
aplicação devolveria.

**Por que acontece:** os endpoints de ingestão têm exatamente o perfil que um WAF classifica
como bot: `POST` de alto volume, sem sessão, de milhares de IPs diferentes, com corpo JSON,
muitas vezes sem `Referer` e disparados por script. Se o *Bot Fight Mode* (ou uma regra de
Managed Ruleset) estiver ligado, ele intercepta **na borda** — a requisição nunca entra no
túnel, nunca chega ao Caddy, nunca chega ao Node. É por isso que o log fica limpo: do ponto
de vista do servidor, o evento nunca existiu.

**As rotas afetadas** (todas as de ingestão, confirmadas no código):

| Rota | Método | Onde |
|---|---|---|
| `/e/:slug` | POST (+ OPTIONS) | `src/ingest/router.js:314-315` |
| `/c/:slug` | POST (+ OPTIONS) | `src/ingest/collect.js:91-92` |
| `/s/:slug.js` | GET | `src/ingest/scripts.js:603` |
| `/t/:slug.js` | GET | `src/ingest/scripts.js:604` |

**Solução:** crie na Cloudflare uma regra de **bypass / skip** para esses caminhos. O
objetivo é: para requisições cujo path comece com `/e/`, `/c/`, `/s/` ou `/t/`, **pular**
as proteções de bot e o WAF gerenciado. Na linguagem de expressão da Cloudflare, o
predicado é algo como:

```
starts_with(http.request.uri.path, "/e/") or
starts_with(http.request.uri.path, "/c/") or
starts_with(http.request.uri.path, "/s/") or
starts_with(http.request.uri.path, "/t/")
```

Deixe **o painel (`/painel`, `/login`, `/api/`) fora do bypass** — ali a proteção da
Cloudflare é bem-vinda, é superfície administrativa.

**Como confirmar que era isso:** a Cloudflare mantém um log de eventos de segurança
(*Security Events*). Filtre pelo hostname e pelo path `/e/` e veja se há entradas com ação
`block`/`challenge`. Se houver, era isso. E vale checar esse log **antes** de sair mexendo
na aplicação: o instinto natural é procurar bug no Node, e o Node não tem culpa nenhuma.

> **Aviso de rate limiting, pelo mesmo motivo:** se você configurar regras de rate limit na
> Cloudflare, lembre que um pico de tráfego legítimo do cliente (lançamento, campanha) se
> parece muito com abuso. Rate limit disparado tem o mesmo sintoma: evento sumindo sem erro.

### 6b. SSE do painel atravessando a Cloudflare

O painel tem tempo real via **Server-Sent Events**: `GET /api/projects/:id/stream`
(`src/admin/stream.js:117`, montado em `/api/projects` por `src/server.js:66`). É uma
resposta HTTP que fica **aberta indefinidamente**, escrevendo eventos conforme eles chegam
via `LISTEN/NOTIFY` do Postgres.

**O que observar:** os eventos aparecerem no painel **em rajadas** — nada por 10, 20, 30
segundos e então três ou quatro de uma vez — em vez de um a um, na hora. Isso é buffering
em algum ponto do caminho. Um segundo sintoma é a aba do painel **reconectando
periodicamente** (o `EventSource` do navegador reconecta sozinho, então não há erro visível
— mas cada reconexão reabre a consulta e pisca a lista).

**O que já está feito do nosso lado** (não refaça, e não desfaça):

- A aplicação envia `Cache-Control: no-cache, no-transform` e `X-Accel-Buffering: no`
  (`src/admin/stream.js:135-142`) — os dois headers padrão para pedir a proxies que não
  bufferizem.
- Há um **heartbeat de 25 segundos** escrevendo um comentário SSE (`: ping`) na conexão
  ociosa (`src/admin/stream.js:150-152`, intervalo em `src/admin/stream.js:26`). É ele que
  impede que um timeout de conexão ociosa derrube o stream — e 25 s é folgado o bastante
  para a maioria dos timeouts de proxy.
- O `Caddyfile.homelab` usa `flush_interval -1` no `reverse_proxy`, que desliga o buffer do
  Caddy.

**Se mesmo assim as rajadas aparecerem**, o buffering está na borda da Cloudflare, e o
diagnóstico é de eliminação: reproduza o mesmo `GET /api/projects/:id/stream` **de dentro
da rede docker** (contra `http://caddy:80`) e compare. Se lá o fluxo é contínuo e pela
internet é em rajadas, é a Cloudflare. Os caminhos, do mais simples ao menos: desligar
compressão/otimizações da Cloudflare para esse path via regra de configuração; ou aceitar a
latência, já que o SSE aqui é conveniência de painel, não caminho crítico de conversão.

**O que isso não afeta:** a ingestão. Nenhum evento se perde por causa de SSE — o stream é
só a visualização ao vivo. Se ele degradar, o painel continua correto ao recarregar a
página.

### 6c. Backup: aqui não existe rede de segurança do provedor

Na Oracle há *boot volume backup policy* — um snapshot de disco automático que salva a
máquina inteira. **No homelab não há nada disso.** Se o SSD morrer, acabou.

E o que está em jogo é maior do que "os eventos":

O volume **`pgdata` contém o banco inteiro** — projetos, eventos, fila de entregas, e as
**credenciais dos clientes cifradas** (access token da Meta CAPI, tokens do Google Ads, api
secrets). Perder o `pgdata` significa cada cliente precisar recadastrar credencial. E
lembre da assimetria: o backup do banco **não** contém o `APP_SECRET` — os dois precisam
sobreviver, guardados em lugares diferentes, para a restauração funcionar.

**`pg_dump` agendado, para fora da máquina, é obrigatório.** Não opcional, não "quando
sobrar tempo".

Comando do dump (o `-T` desabilita a alocação de TTY, necessário quando roda em cron):

```bash
docker exec -t servidor-traker-db-1 \
  pg_dump -U traker -d traker --no-owner --clean --if-exists \
  | gzip > "/caminho/backups/traker_$(date +%Y-%m-%d_%H%M).sql.gz"
```

Script completo, com a verificação que importa (`falhar ruidosamente` quando o dump sai
vazio) e a cópia para fora da máquina:

```bash
#!/usr/bin/env bash
set -euo pipefail

CONTAINER_DB=servidor-traker-db-1
DESTINO=/caminho/backups
ARQUIVO="$DESTINO/traker_$(date +%Y-%m-%d_%H%M).sql.gz"

mkdir -p "$DESTINO"

docker exec -t "$CONTAINER_DB" \
  pg_dump -U traker -d traker --no-owner --clean --if-exists \
  | gzip > "$ARQUIVO"

# Um dump que falhou no meio produz um .gz minúsculo e um exit code que o pipe
# esconde. Sem esta checagem, você acumula 90 arquivos inúteis e só descobre no
# dia em que precisar de um.
if [ "$(stat -c%s "$ARQUIVO")" -lt 1024 ]; then
  echo "ERRO: backup $ARQUIVO parece vazio" >&2
  exit 1
fi

# FORA DA MÁQUINA. Escolha um destino e descomente:
#   rclone copy "$ARQUIVO" remoto:traker-backups/     # nuvem (rclone configurado)
#   rsync -a "$ARQUIVO" usuario@OUTRA_MAQUINA:/backups/traker/
#   scp "$ARQUIVO" usuario@NAS:/volume1/backups/traker/

find "$DESTINO" -name 'traker_*.sql.gz' -mtime +14 -delete
echo "OK: $ARQUIVO"
```

```bash
chmod +x /caminho/backup-traker.sh
/caminho/backup-traker.sh          # teste AGORA, não espere o cron
crontab -e
```

```
0 3 * * * /caminho/backup-traker.sh >> /var/log/traker-backup.log 2>&1
```

Três regras que não são burocracia:

1. **"Fora da máquina" quer dizer fora da máquina.** Backup no mesmo SSD do `pgdata` não
   protege contra a única falha que realmente acontece no homelab: o disco.
2. **Guarde o `APP_SECRET` em um gerenciador de senhas**, separado dos dumps. Backup do
   banco sem a chave é um arquivo de bytes ilegíveis.
3. **Faça um teste de restore de verdade, uma vez.** Suba um Postgres descartável, restaure
   um dump nele, confira que as tabelas estão lá. Backup que nunca foi restaurado é uma
   hipótese, não um backup.

### 6d. Disponibilidade: queda de luz ou de link é conversão perdida

**O sintoma é a ausência de sintoma.** Nada quebra visivelmente: o site do cliente continua
no ar, o checkout continua funcionando, ninguém reclama. Só que os eventos daquele período
não existem em lugar nenhum — não estão numa fila esperando, não estão num log. Você
descobre depois, comparando o número de vendas do backoffice com o número de conversões no
Events Manager.

Na nuvem isso é problema do datacenter (energia redundante, link redundante, SLA). No
homelab é problema seu: falta de luz, queda da operadora, reinício do roteador, alguém
desligando a máquina errada.

**O que atenua, em ordem de eficácia:**

1. **Retentativa no webhook do backoffice.** É a única mitigação que realmente fecha o
   buraco. Se o `POST` para `/e/<slug>` falhar (timeout, 5xx, conexão recusada), o
   backoffice precisa **enfileirar e tentar de novo** com backoff — em minutos, não em
   segundos. Com isso, uma queda de 40 minutos vira 40 minutos de atraso, não de perda.
   **Isto é uma conversa com o dev do checkout**, do mesmo tipo da correção do
   `X-Forwarded-For` listada em `12-deploy-zyraflow.md`. Confirme se existe antes de tratar
   o homelab como produção.
2. **Nobreak (UPS) na máquina e no roteador/ONU.** Adianta pouco colocar nobreak só no
   servidor: se a ONU cai, o túnel cai igual. Cobre a queda curta, que é a maioria.
3. **`restart: unless-stopped`** em todos os serviços (já está no compose) — resolve o
   reinício da máquina, não a queda do link.
4. **Monitoramento externo do `/health`.** Qualquer serviço de uptime batendo em
   `https://SEU_DOMINIO/health` a cada minuto e alertando no celular. É barato e converte
   "descobri semana que vem" em "descobri em dois minutos".

Um ponto a favor do desenho: eventos que **chegam** não se perdem por queda do worker. A
fila vive no Postgres (`SELECT ... FOR UPDATE SKIP LOCKED`), então se o `worker` cair e o
`db` continuar de pé, as entregas ficam esperando e são processadas quando ele voltar. O
buraco é só o que **não chega**.

---

## 7. Nota sobre onde a produção deve morar

O `02-deploy-oracle-cloud.md` registra a decisão do responsável de infra (Rauny): *"o que
for de serviço da empresa, o correto é ficar na infra. da empresa na Oracle"*.

Esse documento descreve um caminho técnico válido e completo, mas mover **produção** de um
serviço da empresa para o homelab é, antes de tudo, uma conversa com ele — não um
impedimento técnico. O homelab é imediatamente útil como ambiente de homologação, teste de
integração e laboratório de configuração da Cloudflare, sem que essa decisão precise ser
tomada.

---

## Ver também

- `02-deploy-oracle-cloud.md` — o deploy equivalente com IP público, firewall e Let's Encrypt.
- `03-dns-tls-subdominio.md` — DNS e certificado no modelo com IP público.
- `06-operacao-runbook.md` — operação diária, fila, incidentes, rotação do `APP_SECRET`.
- `12-deploy-zyraflow.md` — a decisão de domínio próprio e a arquitetura webhook-first.
- `14-repos-azure.md` — o modelo de deploy por pipeline no Azure DevOps.
- `infra/Caddyfile.homelab` — os comentários do arquivo explicam cada diferença em relação
  ao `infra/Caddyfile` padrão.
