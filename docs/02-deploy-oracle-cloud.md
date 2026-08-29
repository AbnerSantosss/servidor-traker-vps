---
title: Deploy do Servidor Traker na Oracle Cloud (OCI)
tags: [infra, deploy, oracle-cloud, oci, docker, ubuntu, servidor-traker]
created: 2026-08-12
updated: 2026-08-12
---

# Deploy do Servidor Traker na Oracle Cloud (OCI)

Guia passo a passo para colocar o **Servidor Traker** no ar em uma instância da
**Oracle Cloud Infrastructure (OCI)**, que é onde ficam os serviços da Código Vencedor.

> **Por que OCI e não uma VPS externa ou Azure?**
> Decisão do responsável de infra (Rauny): *"o que for de serviço da empresa, o correto é
> ficar na infra. da empresa na Oracle"*. Então Hetzner, DigitalOcean, Azure e afins estão
> fora — não por serem ruins, mas porque o serviço é da empresa e precisa viver junto com o
> resto da infra dela (acesso, faturamento, backup e responsabilidade centralizados).

Este documento assume **zero conhecimento prévio de administração de servidor Linux**.
Onde tiver um bloco de comando, é para copiar e colar exatamente como está (trocando só o
que estiver `EM_MAIUSCULO_ASSIM`).

---

## 0. O que vamos montar

Uma única máquina virtual (VM) na Oracle rodando quatro containers Docker:

| Container | O que faz |
|---|---|
| `caddy` | Porta de entrada. Recebe todo o tráfego HTTPS, cuida do certificado SSL sozinho e repassa para a `api`. |
| `api` | A aplicação Node.js. Recebe os eventos do GTM, serve o painel admin e a landing. |
| `worker` | Processo separado que pega os eventos da fila e envia para a Meta CAPI / Google Ads. |
| `db` | PostgreSQL 16. Guarda tudo: projetos, credenciais, eventos, fila de entregas. |

**Não existe Redis neste projeto.** A fila de entregas é feita dentro do próprio Postgres,
usando `SELECT ... FOR UPDATE SKIP LOCKED`. Isso é uma decisão consciente: menos uma peça
para instalar, monitorar e quebrar.

Volumes Docker que guardam dado que **não pode ser perdido**:

- `pgdata` — o banco inteiro.
- `caddy_data` — os certificados SSL emitidos (se perder, o Caddy reemite; mas há limite de
  emissões por semana na Let's Encrypt, então evite).
- `caddy_config` — estado interno do Caddy.

---

## 1. Criar a instância de Compute na OCI

Na console da Oracle: **Menu ☰ → Compute → Instances → Create instance**.

### 1.1 Escolher a "shape" (o tamanho da máquina)

Aqui está a decisão mais importante do documento, e ela tem um trade-off real.

#### Opção A — Ampere A1 (ARM) — **recomendada**

- Shape: **`VM.Standard.A1.Flex`**
- Está no **Always Free** da Oracle: até **4 OCPU e 24 GB de RAM** sem custo, distribuídos
  entre quantas instâncias você quiser.
- **Recomendação de ponto de partida: 2 OCPU / 8 GB de RAM.** Sobra folga para o Postgres,
  os dois processos Node e o Caddy, e ainda deixa metade da cota livre para outra coisa.

**O porém honesto:** Ampere é arquitetura **ARM (aarch64)**, não x86. Isso significa que
toda imagem Docker usada precisa ter build para `arm64`. Na prática:

- `node:22-*`, `postgres:16`, `caddy:2` — todas são multi-arch oficiais e funcionam em ARM
  sem nenhum ajuste. Este projeto usa exatamente essas.
- O risco aparece se um dia alguém adicionar uma imagem de terceiro que só tenha build x86.
  Nesse caso o container simplesmente não sobe (`exec format error`).
- **Regra prática que resolve 95% do problema:** construa a imagem **na própria máquina
  ARM** (`docker compose build` rodando no servidor). Se compilar lá, roda lá.

Segundo porém: a capacidade de A1 na Oracle é disputada. É comum receber
`Out of host capacity` ao criar. Se acontecer, tente outra Availability Domain da mesma
região, ou tente de novo mais tarde — não é erro de configuração sua.

#### Opção B — x86 (`VM.Standard.E5.Flex`)

- Arquitetura x86_64, a mesma do seu notebook e da imensa maioria dos tutoriais da internet.
- **É paga** (não faz parte do Always Free em configuração útil — o único x86 gratuito é o
  `VM.Standard.E2.1.Micro`, com 1 GB de RAM, que **não** aguenta Postgres + Node + Caddy).
- Vantagem: compatibilidade total. Qualquer imagem Docker do mundo roda. Zero surpresa.

#### Como decidir

| Situação | Escolha |
|---|---|
| Caso normal deste projeto | **Ampere A1, 2 OCPU / 8 GB** |
| Se A1 der `Out of host capacity` repetidas vezes e houver urgência | E5.Flex 2 OCPU / 8 GB (custo com a empresa) |
| Se no futuro entrar uma dependência sem build arm64 | Migrar para E5.Flex |

### 1.2 Imagem do sistema operacional

**Canonical Ubuntu 22.04 LTS ou 24.04 LTS.** As duas servem; 24.04 tem suporte mais longo.

Evite "Oracle Linux" se você não tem familiaridade — a maior parte da documentação de Docker
na internet assume Debian/Ubuntu, e o firewall dele funciona diferente (`firewalld` em vez de
`iptables`), o que muda os comandos da seção 3.

### 1.3 Disco (boot volume)

O padrão de 50 GB é suficiente para começar. Se for guardar muito histórico de eventos,
**100 GB** é uma folga confortável (o Always Free dá até 200 GB de block storage no total).

Deixe **"Boot volume backup policy"** ligada se a console oferecer — é backup de disco a
nível de nuvem, complementar ao `pg_dump` da seção 8.

### 1.4 Chave SSH

Na criação, a Oracle pede uma chave pública SSH. É assim que você entra na máquina — não há
senha por padrão.

Se você ainda não tem uma, gere no seu computador (Windows, no PowerShell ou Git Bash):

```bash
ssh-keygen -t ed25519 -C "abner-servidor-traker"
```

Isso cria dois arquivos em `C:\Users\SEU_USUARIO\.ssh\`:

- `id_ed25519` — **chave privada. Nunca envie para ninguém, nunca coloque no git.**
- `id_ed25519.pub` — chave pública. É o conteúdo **deste** arquivo que você cola na Oracle.

Se quem criar a instância for o Rauny, mande para ele o conteúdo do `.pub`.

### 1.5 Rede

Deixe a instância em uma **subnet pública** com **"Assign a public IPv4 address" = Yes**.
Sem IP público, nada da internet chega nela. O IP que vem por padrão é *efêmero* — a próxima
seção resolve isso.

---

## 2. IP público reservado (não use o efêmero)

Toda instância nova ganha um **IP efêmero**: ele está amarrado ao ciclo de vida da instância.
Se a VM for parada e reiniciada em certos cenários, recriada, ou movida, **o IP muda**.

Isso é fatal para nós, porque:

- o registro DNS `traker.codigovencedor.com` vai apontar para esse IP;
- se o IP mudar, o domínio para de resolver, os eventos do GTM param de chegar e o
  certificado SSL não renova — e ninguém percebe até alguém reclamar de conversão faltando;
- e o DNS é controlado pelo Rauny, então cada mudança de IP vira um pedido para outra pessoa.

**Reserve o IP.** Na console:

1. **Networking → IP Management → Reserved public IPs → Reserve public IP address**
   (crie um, dê o nome `traker-prod-ip`).
2. Vá na instância → aba **Attached VNICs** → clique na VNIC primária → **IPv4 Addresses**.
3. No IP primário, **Edit** → em Public IP Type, escolha **Reserved public IP** → selecione
   o `traker-prod-ip` que você criou (ou "Reserve a new one" ali mesmo, que já faz tudo).

Anote esse IP. **É esse número que vai para o Rauny criar o DNS** (ver `03-dns-tls-subdominio.md`).

Um IP reservado sobrevive à destruição da instância — se um dia a VM for recriada, você
reanexa o mesmo IP e o DNS nem fica sabendo.

---

## 3. Abrir as portas 80 e 443 — **as duas camadas**

Esta é a parte que mais trava gente na OCI, e vale ler com atenção.

Existem **dois firewalls empilhados** entre a internet e a sua aplicação:

```
Internet
   │
   ├─► [ Camada 1 ] Security List / NSG da VCN  ← configurado na console web da Oracle
   │
   ├─► [ Camada 2 ] Firewall do sistema operacional (iptables)  ← configurado por SSH, dentro da VM
   │
   └─► Caddy (container) → api
```

**Abrir só a camada 1 não funciona.** E o sintoma é cruel: a console mostra a regra lá,
bonita, aberta — e o site continua não respondendo, sem nenhuma mensagem de erro útil. Você
fica horas achando que é o Docker, ou o DNS, ou o Caddy.

Motivo: as imagens Ubuntu distribuídas pela Oracle vêm com **regras iptables persistentes**
pré-instaladas que bloqueiam tudo que não seja SSH (porta 22). Elas são carregadas no boot
pelo `netfilter-persistent`. E — detalhe importante — **o `ufw` não mostra essas regras**.
Rodar `sudo ufw status` e ver "inactive" faz você concluir que não há firewall nenhum. Há.

### 3.1 Camada 1 — Security List / NSG na console da OCI

Na console: **Networking → Virtual Cloud Networks → sua VCN → Security Lists → Default
Security List** (ou o NSG associado à instância, se a empresa usar NSG — o Rauny sabe qual é
o padrão dela).

Adicione duas **Ingress Rules**:

| Stateless | Source Type | Source CIDR | IP Protocol | Destination Port Range | Descrição |
|---|---|---|---|---|---|
| No | CIDR | `0.0.0.0/0` | TCP | `80` | HTTP — validação do certificado Let's Encrypt e redirect para HTTPS |
| No | CIDR | `0.0.0.0/0` | TCP | `443` | HTTPS — tráfego real |

Se a empresa usa **Network Security Groups (NSG)** em vez de Security List, as mesmas duas
regras vão no NSG anexado à VNIC da instância. Vale confirmar com o Rauny qual dos dois é o
padrão da Código Vencedor — configurar no lugar errado é outro jeito de perder uma tarde.

Sim, `0.0.0.0/0` (o mundo inteiro) é o correto aqui: é um endpoint público que precisa
receber eventos de qualquer visitante de qualquer site cliente.

### 3.2 Camada 2 — firewall do sistema operacional

Conecte na máquina:

```bash
ssh ubuntu@SEU_IP_RESERVADO
```

(Se der "Permission denied", aponte a chave explicitamente:
`ssh -i ~/.ssh/id_ed25519 ubuntu@SEU_IP_RESERVADO`.)

**Primeiro, olhe o que já existe:**

```bash
sudo iptables -L INPUT -n --line-numbers
```

Você vai ver algo parecido com isto (o número das linhas varia):

```
Chain INPUT (policy ACCEPT)
num  target     prot opt source        destination
1    ACCEPT     all  --  0.0.0.0/0     0.0.0.0/0     state RELATED,ESTABLISHED
2    ACCEPT     icmp --  0.0.0.0/0     0.0.0.0/0
3    ACCEPT     all  --  0.0.0.0/0     0.0.0.0/0
4    ACCEPT     udp  --  0.0.0.0/0     0.0.0.0/0     udp spt:123
5    ACCEPT     tcp  --  0.0.0.0/0     0.0.0.0/0     state NEW tcp dpt:22
6    REJECT     all  --  0.0.0.0/0     0.0.0.0/0     reject-with icmp-host-prohibited
```

Repare na **linha 6**: `REJECT all`. É ela que derruba tudo. E repare na linha 5: só a 22
está liberada. É exatamente o cenário descrito acima.

**A ordem importa.** O iptables lê de cima para baixo e para na primeira regra que casa. Se
você adicionar as portas 80/443 *depois* do REJECT (com `-A`, que anexa no fim), elas nunca
serão alcançadas. Tem que **inserir antes** dele, com `-I` e o número da linha.

No exemplo acima, o REJECT está na linha 6, então inserimos nas posições 6 e 7:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 7 -m state --state NEW -p tcp --dport 443 -j ACCEPT
```

> Ajuste o `6` e o `7` para o número real do REJECT na **sua** saída. Se o REJECT estiver na
> linha 4, use `-I INPUT 4` e `-I INPUT 5`.

Confira que ficaram acima do REJECT:

```bash
sudo iptables -L INPUT -n --line-numbers
```

**Agora torne permanente** — sem isso, tudo volta ao estado anterior no próximo reboot:

```bash
sudo apt-get update
sudo apt-get install -y iptables-persistent netfilter-persistent
sudo netfilter-persistent save
```

(O `iptables-persistent` costuma já vir instalado nas imagens Oracle; se vier, ele vai
perguntar se quer salvar as regras atuais — responda **Yes** para IPv4.)

Verifique que o arquivo foi gravado:

```bash
sudo grep -E "dport (80|443)" /etc/iptables/rules.v4
```

Se aparecerem as duas linhas, está persistido.

### 3.3 Avisos sobre `ufw`

- **Não "resolva" isso ligando o `ufw`.** Em uma imagem Oracle com iptables pré-populado,
  `sudo ufw enable` pode reescrever a tabela e **derrubar a sua própria sessão SSH**,
  deixando você trancado para fora da máquina (a recuperação exige console serial da OCI).
- Se você *realmente* quiser usar `ufw` como ferramenta de gestão, faça isso com o
  **Cloud Shell / console serial da OCI aberto ao lado** como plano B, e libere a 22 *antes*:
  `sudo ufw allow 22/tcp` → `sudo ufw allow 80,443/tcp` → só então `sudo ufw enable`.
- Para o nosso caso, o caminho do 3.2 (iptables direto + persist) é mais seguro e suficiente.

### 3.4 E o Docker?

O Docker mexe na tabela `nat`/`FORWARD` por conta própria e, ao publicar portas
(`ports: "80:80"`), consegue furar parte do filtro. Isso às vezes faz o serviço responder
*mesmo sem* você ter liberado nada — e aí você acha que está tudo certo até um reboot mudar
a ordem das regras. **Faça o passo 3.2 de qualquer forma**, explicitamente. Estado
determinístico vale mais do que sorte.

---

## 4. Preparar o sistema e instalar o Docker

Ainda conectado por SSH:

```bash
# Atualizações do sistema
sudo apt-get update && sudo apt-get upgrade -y

# Fuso horário (deixa os logs legíveis)
sudo timedatectl set-timezone America/Sao_Paulo
```

Instale o Docker pelo script oficial (funciona igual em ARM e x86):

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
```

Permita usar o Docker sem `sudo`:

```bash
sudo usermod -aG docker ubuntu
```

**Saia e entre de novo no SSH** (`exit` e reconecte) para o grupo valer.

Confirme que tudo está no lugar:

```bash
docker --version
docker compose version   # note: "compose" sem hífen — é o plugin, não o docker-compose antigo
docker run --rm hello-world
uname -m                 # aarch64 = ARM/Ampere | x86_64 = Intel/AMD
```

Guarde o resultado do `uname -m`: é ele que diz em qual arquitetura você está.

### 4.1 Swap (opcional, mas recomendado)

Com 8 GB de RAM sobra memória, mas 2 GB de swap são um seguro barato contra um pico de
importação matar o Postgres com OOM:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

---

## 5. Clonar o repositório

O repositório do projeto é criado pelo Rauny (ver `08-mensagem-para-o-rauny.md`).

```bash
sudo mkdir -p /opt/servidor-traker
sudo chown ubuntu:ubuntu /opt/servidor-traker
git clone URL_DO_REPOSITORIO /opt/servidor-traker
cd /opt/servidor-traker
```

> **Sobre autenticação no git:** se o repositório for privado (e deve ser), o `git clone` vai
> pedir credencial. O caminho limpo é gerar uma **deploy key**: rode `ssh-keygen -t ed25519
> -f ~/.ssh/deploy_key -N ""` na VM, mande o conteúdo de `~/.ssh/deploy_key.pub` para o Rauny
> cadastrar como deploy key *read-only* do repositório, e clone pela URL SSH
> (`git@servidor:grupo/servidor-traker.git`). Assim o servidor lê o código sem carregar a
> senha de ninguém.

`/opt` é a convenção Linux para software de aplicação instalado manualmente. Usar a home do
usuário (`/home/ubuntu`) também funciona, mas `/opt` é mais claro para quem chegar depois.

---

## 6. Configurar o `.env`

O arquivo `.env` fica **na raiz do projeto**, ao lado do `docker-compose.yml`, e
**nunca** entra no git (confira que `.env` está no `.gitignore`).

### 6.1 Gerar o `APP_SECRET`

```bash
openssl rand -hex 32
```

Isso imprime 64 caracteres hexadecimais (= 32 bytes). Copie.

> ⚠️ **Leia isto antes de continuar.** O `APP_SECRET` é a chave que cifra, dentro do banco,
> todas as credenciais dos clientes: access tokens da Meta CAPI, tokens do Google Ads, api
> secrets. Os dados no banco são inúteis sem ela.
>
> **Se você perder o `APP_SECRET`, você perde todos os tokens de todos os projetos** — o
> banco continua lá, mas as credenciais viram bytes ilegíveis, e cada cliente terá que gerar
> e cadastrar token novo. Um backup do Postgres **não** salva você disso.
>
> Guarde uma cópia **fora do servidor**, no gerenciador de senhas da empresa, hoje, antes de
> seguir para o passo seguinte. Trocá-lo depois exige o procedimento de rotação descrito em
> `06-operacao-runbook.md`.

### 6.2 Escrever o arquivo

```bash
cd /opt/servidor-traker
nano .env
```

Cole o conteúdo abaixo, ajustando os valores marcados:

```bash
# ---- Aplicação ----
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# ---- Banco de dados ----
# A senha aqui precisa ser a MESMA de POSTGRES_PASSWORD lá embaixo.
# "db" é o nome do serviço no docker-compose — não troque por localhost.
DATABASE_URL=postgres://traker:SENHA_FORTE_DO_BANCO@db:5432/traker
POSTGRES_PASSWORD=SENHA_FORTE_DO_BANCO

# ---- Chave mestra de criptografia (openssl rand -hex 32) ----
# NÃO PERCA. NÃO COMMITE. Cópia no gerenciador de senhas da empresa.
APP_SECRET=COLE_AQUI_OS_64_CARACTERES_GERADOS

# ---- Identidade pública ----
PUBLIC_HOST=traker.codigovencedor.com
PUBLIC_SCHEME=https
TRUST_PROXY=1

# ---- Integrações ----
META_API_VERSION=v21.0

# ---- Worker / fila ----
WORKER_CONCURRENCY=4
WORKER_POLL_MS=1000
MAX_ATTEMPTS=8

# ---- Retenção e sessões ----
RETENTION_DAYS=90
SESSION_TTL_HOURS=12
COOKIE_MAX_AGE_DAYS=180
SET_FIRST_PARTY_COOKIES=true

# ---- Usuário inicial do painel ----
ADMIN_EMAIL=abner@codigovencedor.com
ADMIN_PASSWORD=SENHA_FORTE_DO_PAINEL
```

Salve no `nano` com **Ctrl+O**, **Enter**, depois **Ctrl+X**.

Proteja o arquivo (só o dono lê):

```bash
chmod 600 .env
```

### 6.3 O que cada variável faz

| Variável | Para que serve |
|---|---|
| `NODE_ENV` | `production` liga otimizações e desliga stack traces detalhados na resposta. |
| `PORT` | Porta interna da `api` (3000). Não é exposta na internet; só o Caddy fala com ela. |
| `DATABASE_URL` | String de conexão com o Postgres. O host é `db` (nome do serviço no compose). |
| `POSTGRES_PASSWORD` | Senha que o container do Postgres cria no primeiro boot. **Só é aplicada na criação do volume `pgdata`** — mudar depois não muda a senha do banco. |
| `APP_SECRET` | Chave AES que cifra as credenciais dos clientes no banco. Ver aviso em 6.1. |
| `PUBLIC_HOST` | Hostname público. Usado para montar as URLs do coletor entregues ao GTM e para o Caddy saber para qual domínio pedir certificado. |
| `PUBLIC_SCHEME` | `https` em produção. |
| `TRUST_PROXY` | `1` porque a app está atrás do Caddy — sem isso o IP do visitante chega como o IP do container, e o IP é um sinal de match importante para a Meta. |
| `META_API_VERSION` | Versão da Graph API usada nas chamadas de CAPI (`v21.0`). |
| `LOG_LEVEL` | `info` no dia a dia; `debug` só para investigar (gera muito volume). |
| `WORKER_CONCURRENCY` | Quantas entregas o worker processa em paralelo. |
| `WORKER_POLL_MS` | Intervalo entre consultas à fila quando ela está vazia. |
| `MAX_ATTEMPTS` | Tentativas antes de a entrega virar `dead` (dead-letter). |
| `RETENTION_DAYS` | Dias de retenção de eventos antes do expurgo (LGPD). |
| `SESSION_TTL_HOURS` | Duração da sessão de login no painel admin. |
| `COOKIE_MAX_AGE_DAYS` | Validade do cookie first-party do coletor. |
| `SET_FIRST_PARTY_COOKIES` | Se o servidor grava os cookies de identidade em nome do site. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Usuário inicial do painel (usado pelo `npm run seed`). |

---

## 7. Subir a aplicação

### 7.1 Build e start

```bash
cd /opt/servidor-traker
docker compose build          # construa NA máquina — resolve a arquitetura ARM automaticamente
docker compose up -d          # -d = detached (roda em segundo plano)
```

O primeiro `build` demora alguns minutos. Os seguintes usam cache e são rápidos.

Veja o que subiu:

```bash
docker compose ps
```

Você deve ver `caddy`, `api`, `worker` e `db` com status `Up` / `running`. Se algum estiver
em `Restarting`, pule para a seção 11.

### 7.2 Rodar as migrações do banco

O banco sobe vazio. As tabelas são criadas pelas migrações:

```bash
docker compose exec api npm run migrate
```

Saída esperada: uma lista de migrações aplicadas, sem erro no fim.

Se der `ECONNREFUSED` ou `database ... does not exist`, o Postgres provavelmente ainda estava
inicializando. Espere 15 segundos e rode de novo.

### 7.3 Dados iniciais (seed)

```bash
docker compose exec api npm run seed
```

Cria os registros base (mapeamentos padrão de eventos, e o usuário admin a partir de
`ADMIN_EMAIL` / `ADMIN_PASSWORD`).

---

## 8. Criar o usuário do painel

Se o `seed` já criou o admin com as variáveis do `.env`, você não precisa fazer mais nada —
é só logar em `https://traker.codigovencedor.com/login`.

Para criar usuários adicionais (ou se preferir não deixar a senha no `.env`):

```bash
docker compose exec api npm run criar-usuario
```

O comando pergunta e-mail e senha interativamente. Use uma senha longa e única, guardada no
gerenciador de senhas da empresa.

Depois de criar um usuário definitivo, **remova `ADMIN_PASSWORD` do `.env`** — não há motivo
para uma senha em texto puro ficar num arquivo do servidor mais tempo do que o necessário.

---

## 9. Verificação pós-deploy

Faça na ordem. Cada passo elimina uma camada de possível problema.

**1. A app responde localmente (dentro da máquina)?**

```bash
curl -i http://localhost:3000/health
```

Esperado: `HTTP/1.1 200 OK` e um JSON de status. Se falhar aqui, o problema é na `api` ou no
banco — nem chegou a ser rede.

**2. O Caddy está na frente e respondendo?**

```bash
curl -i http://localhost/health
```

**3. Chega de fora, pelo IP?**

Do seu computador (não da VM):

```bash
curl -i http://SEU_IP_RESERVADO/health
```

Se travar / der timeout aqui e o passo 1 funcionou, **o problema é firewall** — volte à
seção 3. É o caso mais comum de todos.

**4. Chega pelo domínio, com HTTPS?**

Só funciona depois de o DNS estar criado e propagado (ver `03-dns-tls-subdominio.md`):

```bash
curl -i https://traker.codigovencedor.com/health
```

**5. O painel abre?**

No navegador: `https://traker.codigovencedor.com/painel` → deve pedir login.

**6. Os endpoints públicos existem?**

```bash
# Deve responder 404/400 com JSON (slug inexistente), NÃO um erro de conexão
curl -i https://traker.codigovencedor.com/e/slug-de-teste

# O script coletor de um projeto real deve retornar 200 e JavaScript
curl -i https://traker.codigovencedor.com/s/SLUG_DO_PROJETO.js
```

**7. Os logs estão limpos?**

```bash
docker compose logs --tail=100 api
docker compose logs --tail=100 worker
docker compose logs --tail=50 caddy
```

**8. O certificado é válido?**

```bash
echo | openssl s_client -servername traker.codigovencedor.com \
  -connect traker.codigovencedor.com:443 2>/dev/null | openssl x509 -noout -issuer -dates
```

Deve mostrar `issuer=... Let's Encrypt ...` e uma data de expiração ~90 dias à frente.

---

## 10. Backup e restore do PostgreSQL

Sem backup, tudo acima é um castelo de areia. São dois níveis:

- **Backup de disco (boot volume backup policy da OCI)** — restaura a máquina inteira. Bom
  para desastre, ruim para "apaguei a tabela errada".
- **`pg_dump` lógico** — restaura o banco (ou uma tabela) em qualquer lugar. É o que segue.

### 10.1 Script de backup

```bash
sudo mkdir -p /opt/backups
sudo chown ubuntu:ubuntu /opt/backups
nano /opt/servidor-traker/backup.sh
```

Conteúdo:

```bash
#!/usr/bin/env bash
set -euo pipefail

PROJETO_DIR=/opt/servidor-traker
DESTINO=/opt/backups
DATA=$(date +%Y-%m-%d_%H%M)
ARQUIVO="$DESTINO/traker_$DATA.sql.gz"

cd "$PROJETO_DIR"

# Dump do banco inteiro, comprimido
docker compose exec -T db pg_dump -U traker -d traker --no-owner --clean --if-exists \
  | gzip > "$ARQUIVO"

# Falha ruidosamente se o arquivo saiu vazio/minúsculo (dump que deu errado)
if [ "$(stat -c%s "$ARQUIVO")" -lt 1024 ]; then
  echo "ERRO: backup $ARQUIVO parece vazio" >&2
  exit 1
fi

# Envia para o OCI Object Storage (ver 10.3)
if command -v oci >/dev/null 2>&1; then
  oci os object put \
    --bucket-name traker-backups \
    --file "$ARQUIVO" \
    --name "postgres/$(basename "$ARQUIVO")" \
    --force --auth instance_principal
fi

# Mantém 14 dias localmente
find "$DESTINO" -name 'traker_*.sql.gz' -mtime +14 -delete

echo "OK: $ARQUIVO"
```

```bash
chmod +x /opt/servidor-traker/backup.sh
/opt/servidor-traker/backup.sh     # teste agora, não espere o cron
ls -lh /opt/backups
```

### 10.2 Agendar no cron

```bash
crontab -e
```

Adicione (3h da manhã, todo dia):

```
0 3 * * * /opt/servidor-traker/backup.sh >> /var/log/traker-backup.log 2>&1
```

Confirme com `crontab -l`.

Duas semanas depois, **olhe o log e a lista de arquivos**. Backup que ninguém confere é
backup que não existe.

### 10.3 Cópia para o OCI Object Storage

Backup que mora no mesmo disco que o banco não protege contra perda da instância. Mande para
fora:

1. Na console: **Storage → Buckets → Create Bucket**, nome `traker-backups`, visibilidade
   **Private**.
2. Autorize a VM a escrever no bucket **sem guardar chave nenhuma no disco** — isso se chama
   *instance principal* e é o jeito certo na OCI. Peça ao Rauny (é ele quem tem permissão de
   IAM):
   - criar um **Dynamic Group** que inclua a instância, ex.:
     `ALL {instance.id = 'OCID_DA_INSTANCIA'}`
   - criar uma **Policy**:
     `Allow dynamic-group traker-servers to manage objects in compartment COMPARTIMENTO where target.bucket.name='traker-backups'`
3. Instale a CLI na VM:

```bash
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"
```

4. Teste:

```bash
oci os object list --bucket-name traker-backups --auth instance_principal
```

Se isso listar (mesmo vazio) sem erro de permissão, o `backup.sh` já vai subir sozinho.
Configure também uma **regra de ciclo de vida** no bucket para apagar objetos com mais de 90
dias, senão o custo de storage cresce para sempre.

### 10.4 Restore

**Restaurar apaga e recria o conteúdo do banco. Confirme que é o que você quer.**

```bash
cd /opt/servidor-traker

# 1. Pare quem escreve no banco (api e worker), mantendo o db de pé
docker compose stop api worker

# 2. Restaure
gunzip -c /opt/backups/traker_2026-08-12_0300.sql.gz \
  | docker compose exec -T db psql -U traker -d traker

# 3. Suba de volta
docker compose start api worker

# 4. Verifique
curl -i http://localhost:3000/health
```

Se o backup veio de outra máquina, **o `.env` restaurado precisa ter o mesmo `APP_SECRET`
de origem**, senão as credenciais cifradas dos clientes não abrem. Vale repetir: o segredo
não está no dump.

**Faça um teste de restore de verdade uma vez**, de preferência numa VM descartável, antes de
precisar dele às 2h da manhã.

---

## 11. Atualizar a aplicação

Deploy de versão nova:

```bash
cd /opt/servidor-traker

# 0. Backup antes de qualquer coisa (30 segundos que já salvaram muita gente)
./backup.sh

# 1. Trazer o código novo
git pull

# 2. Reconstruir e recriar só o que mudou
docker compose build
docker compose up -d

# 3. Aplicar migrações novas (se houver)
docker compose exec api npm run migrate

# 4. Conferir
docker compose ps
curl -i http://localhost:3000/health
docker compose logs --tail=50 api
```

Rodar os testes antes de subir, quando fizer sentido:

```bash
docker compose exec api npm test
```

**Voltar atrás (rollback):**

```bash
git log --oneline -5              # ache o commit anterior que funcionava
git checkout HASH_DO_COMMIT
docker compose build && docker compose up -d
```

Atenção: rollback de código **não** desfaz migração de banco. Se a versão nova rodou uma
migração destrutiva, o caminho de volta é o restore do 10.4.

**Limpeza periódica** (imagens antigas ocupam disco):

```bash
docker image prune -a -f
docker system df       # quanto o Docker está ocupando
```

---

## 12. Problemas comuns

### 12.1 "Abri a porta na console da Oracle e o site não responde"

**Sintoma:** `curl http://SEU_IP/health` do seu computador trava e dá timeout, mas
`curl http://localhost:3000/health` **dentro** da VM funciona perfeitamente.

**Causa:** o firewall do sistema operacional (camada 2). É o erro nº 1 em OCI.

**Diagnóstico:**

```bash
sudo iptables -L INPUT -n --line-numbers | grep -E "dpt:(80|443)|REJECT"
```

Se não aparecer regra `ACCEPT` para 80/443 **acima** da linha `REJECT`, é isso.

**Correção:** seção 3.2. E depois `sudo netfilter-persistent save`, senão volta no reboot.

**Teste extra, de fora da máquina:**

```bash
nc -vz SEU_IP 80
nc -vz SEU_IP 443
nc -vz SEU_IP 22    # se só esta responder, o diagnóstico está confirmado
```

### 12.2 Certificado não é emitido / navegador diz "não seguro"

Sintomas: `https://` não abre, ou o certificado aparece como interno do Caddy.

Checklist, nesta ordem:

1. **A porta 80 está aberta?** O desafio HTTP-01 da Let's Encrypt entra pela **80**, não pela
   443. Muita gente abre só a 443 e trava aqui.
2. **O DNS já resolve para o IP certo?**
   ```bash
   dig +short traker.codigovencedor.com
   ```
   Tem que devolver exatamente o IP reservado. Se devolver vazio ou outro IP, é DNS —
   ver `03-dns-tls-subdominio.md`.
3. **O que o Caddy está dizendo?**
   ```bash
   docker compose logs caddy | grep -iE "error|challenge|obtain|certificate"
   ```
4. **Rate limit da Let's Encrypt.** Se você ficou reiniciando o Caddy em loop tentando
   resolver, pode ter estourado o limite (5 falhas por conta/hostname por hora; 50 certificados
   por domínio por semana). A mensagem no log diz `too many failed authorizations` ou
   `rate limit`. Só resta esperar — e é por isso que o volume `caddy_data` não deve ser
   apagado à toa.
5. **Domínio de cliente não autorizado.** Se o domínio que falha é de cliente (TLS
   on-demand), o Caddy consulta `GET /api/caddy/ask?domain=` antes de emitir. Se esse
   endpoint não devolver 200 para o domínio, o Caddy recusa — corretamente. Teste:
   ```bash
   curl -i "http://localhost:3000/api/caddy/ask?domain=www.cliente.com.br"
   ```

### 12.3 Container reiniciando em loop

```bash
docker compose ps                      # quem está em "Restarting"
docker compose logs --tail=200 NOME    # api | worker | db | caddy
```

Causas por ordem de frequência:

| Log diz | Causa | Correção |
|---|---|---|
| `APP_SECRET` inválido / erro ao decifrar | segredo ausente, com aspas, ou não sendo 64 hex | conferir o `.env`, sem aspas em volta do valor |
| `ECONNREFUSED db:5432` | api subiu antes do banco | normal nos primeiros segundos; se persistir, ver 12.4 |
| `EADDRINUSE :3000` | algo já ocupa a porta | `sudo ss -tulpn \| grep 3000` |
| `exec format error` | **imagem x86 numa máquina ARM** | `docker compose build` na própria VM (seção 1.1) |
| `Cannot find module` | build desatualizado após mudança de dependência | `docker compose build --no-cache` |
| morre sem log, exit code 137 | OOM — ficou sem memória | ver `free -h`, adicionar swap (4.1) ou subir a shape |

### 12.4 O banco não conecta

```bash
docker compose logs db | tail -50
docker compose exec db pg_isready -U traker      # deve dizer "accepting connections"
docker compose exec db psql -U traker -d traker -c "\dt"   # lista as tabelas
```

- **`password authentication failed`** — este é traiçoeiro. O `POSTGRES_PASSWORD` só tem
  efeito **na primeira vez que o volume `pgdata` é criado**. Se você mudou a senha no `.env`
  depois, o banco continua com a antiga e nada bate. Ou você troca de volta a senha no
  `.env`, ou altera dentro do banco:
  ```bash
  docker compose exec db psql -U traker -d traker -c "ALTER USER traker WITH PASSWORD 'NOVA_SENHA';"
  ```
  (E aí sim atualize `.env` e `docker compose up -d`.)
- **`database "traker" does not exist`** — volume criado com outro nome de banco. Confira as
  variáveis do serviço `db` no `docker-compose.yml`.
- **Nunca** apague o volume `pgdata` para "resolver" — isso apaga o banco inteiro,
  incluindo eventos e credenciais.

### 12.5 O IP mudou

Sintoma: tudo parou de uma vez, DNS aponta para um IP que não responde mais.

```bash
curl -s ifconfig.me       # rodando NA VM: qual é o IP público real dela agora
dig +short traker.codigovencedor.com   # para onde o DNS está mandando
```

Se os dois números diferirem:

1. **A causa raiz é IP efêmero.** Vá na seção 2 e reserve o IP — de preferência reservando
   o que ela tem agora, para não precisar mexer no DNS.
2. Se não der para manter o IP atual, mande o novo para o Rauny atualizar o registro A
   (modelo de mensagem em `08-mensagem-para-o-rauny.md`) e espere a propagação (TTL).
3. Enquanto o DNS não propaga, o certificado não renova. Depois que resolver, force uma
   verificação: `docker compose restart caddy` e acompanhe `docker compose logs -f caddy`.

### 12.6 Disco cheio

```bash
df -h                    # visão geral
docker system df         # quanto é do Docker
du -sh /opt/backups      # backups acumulados
```

Ordem de limpeza, do mais seguro ao menos:

```bash
docker image prune -a -f                              # imagens antigas
docker builder prune -f                               # cache de build
sudo journalctl --vacuum-time=7d                      # logs do systemd
find /opt/backups -name 'traker_*.sql.gz' -mtime +14 -delete
```

Se o que cresceu foi o **banco**, o assunto é retenção — ver a seção de expurgo/LGPD no
`06-operacao-runbook.md`.

**Nunca** rode `docker system prune --volumes`: isso apaga volumes, e `pgdata` é um volume.

---

## 13. Resumo de comandos do dia a dia

```bash
cd /opt/servidor-traker

docker compose ps                    # o que está rodando
docker compose logs -f api           # acompanhar logs ao vivo (Ctrl+C para sair)
docker compose restart api           # reiniciar um serviço
docker compose down                  # parar tudo (dados nos volumes permanecem)
docker compose up -d                 # subir tudo
docker compose exec api npm run migrate
docker compose exec db psql -U traker -d traker    # abrir o banco (\q para sair)
./backup.sh                          # backup manual
```

---

## Ver também

- `03-dns-tls-subdominio.md` — o registro DNS e o certificado.
- `06-operacao-runbook.md` — operação diária, fila, incidentes.
- `08-mensagem-para-o-rauny.md` — o que pedir e como pedir.
