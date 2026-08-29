---
title: Plano de deploy — zyraflow.site (arquitetura webhook-first)
tags: [deploy, dns, zyraflow, oracle-cloud, webhook, servidor-traker]
created: 2026-08-13
updated: 2026-08-13
---

# Plano de deploy — `zyraflow.site`

Este documento substitui, para o deploy real, as partes de `docs/02`/`docs/03`/`docs/08`
que assumiam `traker.codigovencedor.com`. A decisão mudou em 2026-08-13:

- **O site do cliente (`codigovencedor.com`) não é tocado.** Sem tag nova no GTM, sem
  subdomínio nele, sem DNS nele.
- **A aplicação vive em domínio próprio**: `zyraflow.site` (comprado para isso, raiz do
  domínio, registro **A**).
- **Arquitetura webhook-first**: as conversões chegam pelo webhook do backoffice, que já
  envia `attribution.cookies` (fbp/fbc/fbclid/gclid) capturados no checkout. A camada de
  navegador (tags first-party no site) fica como evolução futura — o sistema já suporta,
  é só cadastrar um subdomínio do cliente na aba Domínios quando quiserem.
- **Atribuição**: a Meta não vê o domínio de quem envia. A campanha é atribuída pelo
  `fbc`/`fbclid` dentro do evento, e o Events Manager exibe o domínio do
  `event_source_url` — que continua sendo `https://codigovencedor.com/`.

## Divisão de responsabilidades

| Coisa | Quem faz | Onde |
|---|---|---|
| Instância OCI + IP reservado + portas | Rauny | Console da Oracle |
| Registro A `zyraflow.site` → IP | **Abner** | Painel do registrador onde comprou o zyraflow.site |
| Deploy (compose, migrate, usuário) | Abner | SSH na instância |
| Webhook + `X-Forwarded-For` | Dev do backoffice | Aplicação do checkout |

## 1. Mensagem para o Rauny (copiar e colar)

> Rauny, beleza? Sobre o servidor de tracking — como você definiu que serviço da empresa
> fica na Oracle, montei o pedido nesse formato. São 3 coisas (o DNS dessa vez é comigo,
> o domínio é meu):
>
> **1) Instância de Compute na OCI**
> - Shape: **VM.Standard.A1.Flex (Ampere/ARM)** — está no Always Free
> - **2 OCPU / 8 GB de RAM**
> - Imagem: **Ubuntu 22.04 ou 24.04 LTS**
> - Boot volume: **100 GB**
> - Subnet pública, com IP público
>
> Se a A1 der "out of host capacity" e não rolar insistir, pode ir de
> **VM.Standard.E5.Flex (x86) 2 OCPU / 8 GB** — nesse caso é paga, me avisa antes.
>
> **2) IP público RESERVADO (não efêmero)**
> O DNS vai apontar direto pro IP. Se for efêmero e mudar, o domínio quebra, os eventos
> param e o certificado para de renovar.
>
> **3) Portas 80 e 443 liberadas — nas duas camadas**
> - Na **Security List / NSG da VCN**: ingress TCP 80 e 443, source `0.0.0.0/0`
> - No **firewall do Ubuntu**: as imagens da Oracle vêm com iptables liberando só a 22.
>   Se preferir, eu faço essa parte por SSH — só me passar o acesso.
>
> (A 80 é obrigatória — é por ela que o Let's Encrypt valida o domínio pro certificado.)
>
> **O que eu preciso de volta:** o IP reservado e acesso SSH (te mando minha chave
> pública). O DNS eu mesmo crio, no meu domínio. Valeu!

## 2. DNS — no painel do registrador do zyraflow.site

Uma linha, criada por você (não pelo Rauny):

| Campo | Valor |
|---|---|
| Tipo | **A** |
| Nome / Host | `@` (raiz) |
| Valor | IP público reservado da instância |
| TTL | 300 no começo; 3600 depois de estabilizar |
| Proxy/CDN do registrador | desligado |

Conferir propagação antes de subir o Caddy: `nslookup zyraflow.site` deve devolver
exatamente o IP reservado.

## 3. Deploy na instância

```bash
# na sua máquina: copiar projeto e env
scp -r servidor-traker ubuntu@<IP>:~/
scp servidor-traker/.env.producao ubuntu@<IP>:~/servidor-traker/.env

# na instância (com DNS JÁ propagado):
cd ~/servidor-traker
docker compose up -d --build
docker compose run --rm api npm run migrate
docker compose ps          # 4 containers healthy
curl -s https://zyraflow.site/health   # {"ok":true,...}
```

O usuário admin (`ADMIN_EMAIL`/`ADMIN_PASSWORD` do env) é criado no primeiro boot.
**Troque a senha pelo painel após o primeiro login.**

## 4. Projeto no painel

`https://zyraflow.site/painel` → Novo projeto:

- **Nome**: Codigo Vencedor · **Domínio**: `codigovencedor.com` ← define o
  `event_source_url` que a Meta exibe
- Aba **Meta**: Pixel ID `1624114999139319` + Access Token + Test Event Code
- Aba **Instalação**: copiar o **slug** (será novo, o banco é outro) e o **ingest token**

## 5. Backoffice (dev do checkout)

- Webhook: `POST https://zyraflow.site/e/<slug-novo>` com
  `Authorization: Bearer <ingest_token>` — token em variável de ambiente, nunca em
  front/GTM/repositório.
- **Corrigir o IP**: hoje o payload manda `10.244.16.187` (rede interna do cluster) e o
  servidor descarta. Ler `X-Forwarded-For` e mandar o IP público do comprador em
  `attribution.ipAddress`. É o maior ganho de correspondência pendente.

## 6. Validação (ordem)

1. Aba **Testar** → modo **Teste** → modelo "Compra aprovada" → Events Manager →
   *Testar eventos* mostra o evento como **Servidor**.
2. Conferir no detalhe: `em`/`ph` hasheados (64 hex), `fbp`/`fbc` legíveis (`fb.1.…`).
3. Compra real de teste pelo checkout → aba **Logs** → status `success`.
4. **Remover o Test Event Code** — com ele preenchido os eventos não contam nas campanhas.
5. Nada a conferir sobre acesso sem senha: o atalho `LOGIN_RAPIDO` foi **removido do
   código** em 2026-08-13 (ver `docs/13`). A única porta de entrada é e-mail + senha.

## Segurança já garantida pela base (não refazer)

Painel é cliente estático (CSP `script-src 'self'`, sem inline, sem terceiro), token de
webhook só por endpoint admin auditado, credenciais AES-256-GCM, PII hasheada em repouso,
só o Caddy publica portas (db/api/worker em rede interna). Coberto por asserções na suíte
de testes — detalhes em `docs/10-separacao-front-back.md`.
