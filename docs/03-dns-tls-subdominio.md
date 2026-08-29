---
title: DNS, TLS e o subdomínio traker.codigovencedor.com
tags: [infra, dns, tls, certificado, caddy, first-party, itp, servidor-traker]
created: 2026-08-12
updated: 2026-08-12
---

# DNS, TLS e o subdomínio `traker.codigovencedor.com`

O Servidor Traker precisa de **um hostname próprio, com HTTPS válido**, para receber os
eventos do GTM Web. Este documento cobre: qual registro DNS criar, por que este e não outro,
como o certificado é emitido sozinho, e como conferir que tudo funcionou.

**Quem faz o quê:** o DNS do `codigovencedor.com` é controlado pelo **Rauny**. Ele já
confirmou: *"Sim, só me manda para onde essa entrada vai apontar"*. Ou seja — ele cria o
registro; nós só precisamos entregar o alvo certo. O texto pronto para mandar está em
`08-mensagem-para-o-rauny.md`.

---

## 1. O registro a criar

| Campo | Valor |
|---|---|
| **Nome / Host** | `traker` (ou `traker.codigovencedor.com`, dependendo de como o painel de DNS pede) |
| **Tipo** | **A** |
| **Valor / Aponta para** | o **IP público reservado** da instância OCI |
| **TTL** | `300` (5 min) no começo; subir para `3600` depois de estabilizar |
| **Proxy / nuvem laranja** | **desligado**, se o DNS estiver na Cloudflare (ver 1.3) |

E só. Um registro. Não precisa de MX, TXT, CNAME nem AAAA para funcionar.

> **O IP só existe depois de a instância ser criada e o IP reservado ser anexado.** Não dá
> para pedir o DNS antes disso. A ordem obrigatória é:
> **1)** criar a instância → **2)** reservar e anexar o IP → **3)** mandar o IP para o Rauny
> → **4)** ele cria o A record → **5)** o Caddy emite o certificado.

### 1.1 Por que **A** e não CNAME, neste caso

Um `A` aponta um nome diretamente para um **número de IP**. Um `CNAME` aponta um nome para
**outro nome**, que depois resolve para um IP.

Aqui o A é a escolha certa porque:

- **O serviço está na infra da própria empresa.** O `traker.codigovencedor.com` e a máquina
  que responde por ele pertencem à Código Vencedor. Não há intermediário — apontar para um
  nome no meio só acrescentaria um salto de resolução e mais uma coisa para quebrar.
- **O IP é reservado, portanto estável.** O único motivo forte para usar CNAME é quando o
  destino troca de IP sem avisar (load balancer gerenciado, PaaS, CDN). Não é o nosso caso:
  o IP reservado da OCI é fixo por definição (ver `02-deploy-oracle-cloud.md`, seção 2).
- **Menos indireção = menos latência de resolução e menos superfície de erro.** Uma consulta
  a menos em cada resolução fria.
- **É first-party de verdade**, o que importa muito para cookie e para Safari — seção 3.

**Quando o CNAME faria sentido:** se o Traker fosse uma plataforma multi-cliente hospedada,
e cada cliente apontasse um subdomínio *dele* para um hostname *nosso*. Aí sim o CNAME é o
mecanismo correto — e é exatamente o cenário da seção 2.

### 1.2 E o IPv6 (registro AAAA)?

Opcional e dispensável agora. A instância OCI pode ter IPv6, mas adicionar um `AAAA` sem
garantir que o Caddy também escuta e responde corretamente em IPv6 cria um caminho de falha
silencioso: navegadores com IPv6 tentam esse endereço **primeiro**. Só adicione depois de
testar de fato, e teste com `curl -6`.

### 1.3 Se o DNS estiver atrás da Cloudflare

Se o `codigovencedor.com` usa Cloudflare, o registro A tem um botão de "Proxy" (nuvem
laranja). **Deixe cinza (DNS only)**, pelo menos no início:

- Com o proxy **ligado**, quem termina o TLS é a Cloudflare, não o nosso Caddy. O desafio
  HTTP-01 da Let's Encrypt não chega até nós e a emissão do certificado falha.
- Com o proxy ligado, o IP do visitante chega no header `CF-Connecting-IP`, e a aplicação
  precisa saber ler isso — se não souber, todos os eventos vão para a Meta com o IP da
  Cloudflare, o que **degrada o Event Match Quality**.
- Se um dia houver motivo real para proxiar (bloqueio de bot, por exemplo), isso vira uma
  mudança planejada — não algo para descobrir no meio do deploy.

---

## 2. Domínio de cliente externo — aí sim, CNAME

Quando um cliente da Código Vencedor quiser servir o coletor no **domínio dele**
(`dados.clientex.com.br`, por exemplo) para máximo first-party, o registro muda de forma:

| Campo | Valor |
|---|---|
| **Nome** | `dados` (no DNS **do cliente**) |
| **Tipo** | **CNAME** |
| **Valor** | `traker.codigovencedor.com` |
| **TTL** | `300` |
| **Proxy** | desligado |

Aqui o CNAME é o certo porque quem controla o IP somos nós, e o cliente não pode ficar
dependente de um número que pode mudar do lado de cá. Ele aponta para um **nome** nosso e
pronto.

O que acontece do nosso lado quando esse CNAME é criado:

1. O domínio do cliente precisa estar **cadastrado e ativo no painel** antes — senão o
   servidor não sabe de quem é o tráfego.
2. Uma requisição chega com `Host: dados.clientex.com.br`.
3. O Caddy não tem certificado para esse hostname, então pergunta ao nosso próprio servidor
   se pode emitir: `GET /api/caddy/ask?domain=dados.clientex.com.br` (seção 5).
4. Resposta `200` → o Caddy pede o certificado à Let's Encrypt e passa a servir aquele
   domínio. Resposta diferente de `200` → recusa, e é assim que deve ser.

**Cuidado com CNAME na raiz.** `clientex.com.br` (sem subdomínio) não aceita CNAME pelo
padrão do DNS. Sempre peça um subdomínio.

---

## 3. Safari, ITP e por que isso influencia a escolha do registro

Essa parte é o motivo técnico de existir um subdomínio dedicado em vez de mandar tudo para
um domínio de terceiros.

**O problema:** o Safari (e navegadores baseados em WebKit) usa o **ITP — Intelligent
Tracking Prevention**. Ele classifica domínios e limita a vida de cookies conforme a origem:

- **Cookie de terceiro** (domínio diferente do site visitado): bloqueado. Fim.
- **Cookie gravado por JavaScript** (`document.cookie`), mesmo em first-party: limitado a
  **7 dias** — e a **24 horas** se o visitante chegou por um link com parâmetros de clique
  reconhecidos como rastreamento (`fbclid`, `gclid`). É exatamente o tráfego pago.
- **Cookie gravado pelo servidor** via header `Set-Cookie` HTTP, em um hostname que o ITP
  considera genuinamente first-party: **preserva a validade declarada**, podendo chegar a
  meses.

Daí a variável `SET_FIRST_PARTY_COOKIES=true` e o `COOKIE_MAX_AGE_DAYS=180`: o servidor grava
o cookie pelo header HTTP, não pelo JS, justamente para cair na terceira categoria.

**O "CNAME cloaking":** o truque de apontar um subdomínio seu, via CNAME, para a
infraestrutura de um provedor de tracking de terceiros — fazendo o cookie *parecer*
first-party. O Safari detecta isso: desde o ITP 2.3, quando o CNAME resolve para um domínio
**fora** do domínio visitado, os cookies daquela resposta são **capados em 7 dias**. Firefox
e uBlock Origin também têm mecanismos que anulam CNAME cloaking.

**Como isso se aplica a nós:**

| Cenário | O que o Safari vê | Resultado |
|---|---|---|
| Site `codigovencedor.com` + `traker.codigovencedor.com` via **A record** | Mesmo domínio registrável (eTLD+1). First-party real. | ✅ Melhor caso — sem CNAME, sem cloaking. Cookie de servidor com validade longa. |
| Site do cliente + `dados.clientex.com.br` via **CNAME** para nós | CNAME sai do domínio → cloaking detectável | ⚠️ Funciona, mas o cookie pode ser capado em 7 dias no Safari |
| GTM Web mandando direto para um domínio de terceiro | Terceiro puro | ❌ Bloqueado |

Ou seja: **o A record não é só uma preferência de arquitetura — ele é o que dá longevidade
ao cookie de identidade nos sites da própria Código Vencedor**, e a longevidade do cookie é o
que sustenta a ponte de identidade (`/c/:slug`) e, no fim, o Event Match Quality dos eventos
enviados à Meta.

Para domínios de cliente via CNAME, a mitigação é assumir que no Safari a janela é curta e
compensar com os outros sinais de match (e-mail e telefone hasheados, `external_id`), que não
dependem de cookie.

---

## 4. Como o Caddy emite o certificado sozinho

Você **não** vai gerar CSR, comprar certificado, nem rodar `certbot`. O Caddy faz tudo:

1. Ele lê o `PUBLIC_HOST` (= `traker.codigovencedor.com`) na configuração.
2. Na primeira requisição — ou já no start — ele fala com a Let's Encrypt e pede um
   certificado para esse nome.
3. A Let's Encrypt responde: *"prove que você controla esse domínio"* e manda um desafio
   **HTTP-01**: ela vai buscar uma URL específica em
   `http://traker.codigovencedor.com/.well-known/acme-challenge/<token>`, **na porta 80**.
4. O Caddy responde a essa URL automaticamente.
5. Validado, o certificado é emitido, guardado no volume `caddy_data` e o HTTPS passa a
   funcionar.
6. O Caddy **renova sozinho** com ~30 dias de antecedência (o certificado dura 90). Não há
   nada a agendar.

### 4.1 Pré-requisitos para isso dar certo

Se qualquer um destes faltar, a emissão falha:

- ✅ **Porta 80 aberta nas duas camadas** (Security List da OCI **e** iptables do Ubuntu —
  este é o ponto que mais falha; ver `02-deploy-oracle-cloud.md` §3). O desafio HTTP-01 entra
  pela **80**. Abrir só a 443 não resolve.
- ✅ **Porta 443 aberta**, para servir o tráfego depois.
- ✅ **DNS já propagado** apontando para o IP certo. Se a Let's Encrypt resolver o nome para
  outro IP (ou para nada), ela não encontra o desafio.
- ✅ **Container `caddy` no ar**, com os volumes `caddy_data` e `caddy_config` montados.
- ✅ Nada mais ocupando as portas 80/443 no host (`sudo ss -tulpn | grep -E ':(80|443)'`).

### 4.2 Ordem correta das operações

```
1. Instância criada + IP reservado anexado
2. Portas 80/443 abertas (console OCI + iptables)
3. Rauny cria o A record
4. DNS propaga  ← confira ANTES de seguir (seção 6)
5. docker compose up -d
6. Certificado emitido em segundos
```

Subir o Caddy **antes** do DNS resolver só gera tentativas falhas — e falha demais consome a
cota de rate limit da Let's Encrypt (5 falhas de validação por hostname por hora). Espere o
DNS.

### 4.3 Se precisar testar sem estourar a cota

Enquanto estiver depurando, aponte o Caddy para o ambiente de **staging** da Let's Encrypt
(certificado inválido no navegador, mas limites muito mais generosos), adicionando ao
Caddyfile:

```
{
  acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
}
```

**Lembre-se de remover essa linha** e rodar `docker compose restart caddy` antes de ir para
produção — senão o site fica com aviso de segurança para todo mundo.

---

## 5. O gate `GET /api/caddy/ask?domain=` (TLS on-demand)

Para o nosso domínio principal, o certificado é emitido direto porque nós sabemos o nome de
antemão. Para **domínios de clientes**, não sabemos: eles entram e saem pelo painel, sem
deploy. Aí entra o **On-Demand TLS** do Caddy — emitir certificado no momento em que o
primeiro request chega para um hostname novo.

Isso não pode ser aberto. Sem controle, qualquer um apontaria um CNAME para nós e nos faria
pedir certificados infinitos até a Let's Encrypt bloquear a nossa conta. Por isso o Caddy é
configurado para **perguntar antes**:

```
Request chega com Host: dados.clientex.com.br
        │
        ▼
Caddy: "tenho certificado para esse nome?"  ──sim──► serve normalmente
        │ não
        ▼
Caddy chama:  GET http://api:3000/api/caddy/ask?domain=dados.clientex.com.br
        │
        ├─ 200 OK      ──► pede o certificado à Let's Encrypt e serve
        └─ 4xx / 5xx   ──► recusa a conexão. Nenhum certificado é pedido.
```

O endpoint é **interno** — é consultado pelo Caddy dentro da rede Docker (`api:3000`), não
pela internet. Ele responde `200` somente se o domínio estiver cadastrado e ativo em algum
projeto no painel.

**Testar o gate manualmente:**

```bash
cd /opt/servidor-traker

# Domínio cadastrado e ativo → espera-se 200
curl -i "http://localhost:3000/api/caddy/ask?domain=dados.clientex.com.br"

# Domínio inventado → espera-se 4xx (essa negativa é o comportamento correto)
curl -i "http://localhost:3000/api/caddy/ask?domain=dominio-que-nao-existe.com"
```

**Sintoma clássico:** cliente jura que criou o CNAME, mas o HTTPS não sobe. Em 9 de 10 casos
o domínio não foi cadastrado (ou não foi ativado) no painel, o `ask` devolve 4xx e o Caddy —
corretamente — recusa. Confirme pelo log:

```bash
docker compose logs caddy | grep -i "ask\|on-demand\|not allowed"
```

---

## 6. Verificar propagação de DNS

Depois que o Rauny criar o registro, confirme **antes** de subir o Caddy.

```bash
# O básico: para onde o nome resolve?
dig +short traker.codigovencedor.com

# Deve imprimir exatamente o IP reservado da instância. Nada mais.
```

```bash
# Consultando servidores públicos diferentes (pega cache regional)
dig +short traker.codigovencedor.com @8.8.8.8      # Google
dig +short traker.codigovencedor.com @1.1.1.1      # Cloudflare

# Ver a resposta completa, com TTL e tipo do registro
dig traker.codigovencedor.com A
```

No **Windows**, sem `dig`:

```powershell
nslookup traker.codigovencedor.com
nslookup traker.codigovencedor.com 8.8.8.8
Resolve-DnsName traker.codigovencedor.com -Type A
```

**Sites úteis** para ver a propagação no mundo todo: `dnschecker.org` ou `whatsmydns.net` —
cole o hostname, escolha tipo A, e veja o mapa. Verde em quase todo lugar = pode seguir.

**Quanto demora?** Registro novo (que nunca existiu) costuma propagar em minutos. O TTL
manda: com TTL 300, resolvers que já tinham consultado atualizam em até 5 minutos. Se o
registro foi *alterado* e o TTL antigo era 86400, pode levar até 24h para todo mundo ver —
mais um motivo para começar com TTL baixo.

**Se `dig` não devolve nada:**

1. O registro foi mesmo salvo? Peça um print ao Rauny.
2. Foi criado na zona certa (`codigovencedor.com` e não outra)?
3. Duplicidade de nome: alguns painéis aceitam `traker` e outros exigem
   `traker.codigovencedor.com` — se digitar o segundo num painel que já concatena o domínio,
   nasce `traker.codigovencedor.com.codigovencedor.com`. Vale checar.

---

## 7. Verificar o certificado

**Rápido, no navegador:** abra `https://traker.codigovencedor.com/health`. Cadeado fechado,
sem aviso = pronto. Clique no cadeado para ver emissor e validade.

**Pelo terminal:**

```bash
echo | openssl s_client -servername traker.codigovencedor.com \
  -connect traker.codigovencedor.com:443 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

Saída esperada:

```
subject=CN = traker.codigovencedor.com
issuer=C = US, O = Let's Encrypt, CN = ...
notBefore=Aug 12 ... 2026 GMT
notAfter=Nov 10 ... 2026 GMT      ← ~90 dias à frente
```

**Só a data de expiração:**

```bash
echo | openssl s_client -servername traker.codigovencedor.com \
  -connect traker.codigovencedor.com:443 2>/dev/null \
  | openssl x509 -noout -enddate
```

**Ver a cadeia completa e a versão de TLS:**

```bash
curl -vI https://traker.codigovencedor.com/health 2>&1 | grep -E "SSL|subject|issuer|TLS"
```

**Confirmar que HTTP redireciona para HTTPS** (o Caddy faz isso por padrão):

```bash
curl -I http://traker.codigovencedor.com/health
# Esperado: 308 Permanent Redirect → Location: https://...
```

**Monitoramento contínuo:** vale cadastrar o hostname em um serviço gratuito de alerta de
expiração de certificado. É improvável que o Caddy falhe na renovação, mas se falhar
(porta 80 fechada por uma mudança de regra, por exemplo), você tem ~30 dias de aviso em vez
de descobrir pelo cliente.

---

## 8. Sobre o nome do subdomínio: uma ressalva registrada

Uma parte do valor de servir tracking em first-party é **não ser reconhecido como tracking**
por bloqueadores. Extensões como uBlock Origin, AdGuard, Brave Shields e os DNS filtrantes
(Pi-hole, NextDNS) mantêm listas com padrões de nome, e algumas dessas listas casam
subdomínios por palavra-chave, não só por domínio conhecido.

Palavras que aparecem com frequência nesses padrões:

`track`, `tracker`, `tracking`, `pixel`, `analytics`, `stats`, `metrics`, `tag`, `tags`,
`collect`, `telemetry`, `beacon`, `adserver`, `ads`

A recomendação de manual seria um nome **neutro e plausível como funcionalidade do site**:
`api`, `dados`, `s`, `conecta`, `hub`, `link`, `sinal`, `evt`, `go`.

**Situação atual:** `traker` **já foi escolhido** e vai ser usado. É aceitável, e a decisão
está tomada — não é motivo para refazer nada. Mas fica registrado, para não ser "descoberto"
depois como se fosse novidade:

- `traker` é uma grafia alternativa de "tracker" e **pode** casar com regras de blocklist
  baseadas em substring, dependendo de quão agressiva seja a lista. Blocklists sérias
  costumam trabalhar com domínios conhecidos, não com heurística de nome — então o risco é
  baixo, mas não é zero.
- **O impacto prático é limitado ao nosso próprio domínio.** Os endpoints que mais importam
  para volume de eventos são os que rodam nos sites dos clientes, com **CNAME em domínio
  deles** e slug aleatório na URL (`/e/:slug`, `/s/:slug.js`). Esses não carregam a palavra
  "traker" em lugar nenhum — o design de slug aleatório já resolve o principal vetor de
  bloqueio, independentemente do nome do nosso host.
- **Se um dia medirmos perda de eventos atribuível a bloqueio de nome**, a saída é barata:
  criar um segundo A record com nome neutro apontando para o mesmo IP, adicionar ao
  `PUBLIC_HOST`/lista de domínios e migrar gradualmente. Os dois nomes podem conviver.

**Regra para daqui em diante:** ao cadastrar domínio de cliente, oriente a escolher nome
neutro (`dados.cliente.com.br`, `api.cliente.com.br`, `s.cliente.com.br`) — nunca
`track.cliente.com.br` ou `pixel.cliente.com.br`. É onde a escolha do nome realmente pesa.

---

## 9. Checklist de conclusão

- [ ] Instância OCI criada e no ar
- [ ] IP público **reservado** anexado à VNIC (não efêmero)
- [ ] Portas 80 e 443 abertas na **Security List/NSG** da OCI
- [ ] Portas 80 e 443 abertas no **iptables do Ubuntu** e salvas com `netfilter-persistent`
- [ ] IP enviado ao Rauny
- [ ] Registro **A** `traker.codigovencedor.com` criado
- [ ] `dig +short traker.codigovencedor.com` devolve o IP correto
- [ ] Containers no ar (`docker compose ps`)
- [ ] `https://traker.codigovencedor.com/health` responde 200 com cadeado válido
- [ ] `http://` redireciona para `https://` (308)
- [ ] Emissor do certificado é a Let's Encrypt, validade ~90 dias
- [ ] Painel abre em `https://traker.codigovencedor.com/painel`
- [ ] `GET /api/caddy/ask?domain=` testado para um domínio válido e um inválido

---

## Ver também

- `02-deploy-oracle-cloud.md` — instância, IP reservado, firewall.
- `06-operacao-runbook.md` — o que fazer quando o certificado ou o DNS falharem depois.
- `08-mensagem-para-o-rauny.md` — texto pronto para pedir o registro DNS.
