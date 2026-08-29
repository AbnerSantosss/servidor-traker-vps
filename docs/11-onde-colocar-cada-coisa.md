---
title: Onde colocar cada coisa — DNS, webhooks e tags
tags: [instalacao, dns, webhook, gtm, operacao]
created: 2026-08-13
updated: 2026-08-25
---

# Onde colocar cada coisa

Documento de resposta direta: **o que você precisa configurar, em qual sistema, e com qual valor.** Sem teoria.

---

## Visão de uma linha

No seu caso, **só o `page_view` vem do navegador. Todo o resto — compra, PIX gerado, lead — chega por webhook, do seu backend.**

```
NAVEGADOR (GTM)                      SEU BACKEND                      SERVIDOR TRAKER            META
     │                                    │                                 │                     │
     ├─ tag coletora ────────────────────────────────────────────────► POST /c/<slug>            │
     │  (guarda fbclid, fbp, gclid                                          │                     │
     │   amarrados à sessão)                                                │                     │
     │                                                                      │                     │
     ├─ tag page_view ───────────────────────────────────────────────► POST /e/<slug> ───────────►│  PageView
     │                                                                      │                     │
     │                    compra aprovada ──► POST /e/<slug> ──────────────►│                     │
     │                    (Bearer token)      + o servidor completa         │                     │
     │                                          fbclid/fbp/IP da coleta ───►│────────────────────►│  Purchase
```

Os dois lados usam o **mesmo endereço**. A diferença é que o webhook do backend leva um token de autenticação e o navegador não.

---

## 1. DNS — você precisa de um apontamento?

**Sim, exatamente um registro.** É o único apontamento de DNS do projeto inteiro.

| Onde | O quê |
|---|---|
| **Sistema** | Painel de DNS de `codigovencedor.com` (quem administra é o Rauny) |
| **Tipo** | `A` |
| **Nome** | `traker` |
| **Valor** | O IP público **reservado** da instância na Oracle Cloud |
| **TTL** | 300 (pode subir para 3600 depois de estabilizar) |

Resultado: `traker.codigovencedor.com` → IP da instância.

**Por que precisa disso, se as conversões vêm por webhook?** Por causa da tag do navegador. Um endereço que é subdomínio do próprio site não aparece em lista de bloqueio de ad-blocker, e o Safari não corta os cookies dele como corta os de terceiros. Se a tag apontasse para um domínio genérico, boa parte simplesmente não chegaria — e sem ela você perde o `fbclid`, que é o que amarra a venda ao anúncio.

O webhook do backend funcionaria em qualquer endereço, mas usa o mesmo por simplicidade.

Não é preciso CNAME, TXT, nem registro para `www`. Detalhes e o caso de domínio de cliente externo em [`03-dns-tls-subdominio.md`](03-dns-tls-subdominio.md).

---

## 2. O webhook que **recebe** os eventos (o nosso)

Este é o endereço que você cola **dentro da sua aplicação/checkout**, no lugar onde se configura "para onde enviar os webhooks".

**Onde achar o valor exato:** painel → selecione o projeto → aba **Instalação** → trilha *Backend*.

```
URL:     https://traker.codigovencedor.com/e/<slug-do-projeto>
Método:  POST
Header:  Content-Type: application/json
Header:  Authorization: Bearer <token-de-ingestao>
Corpo:   o payload que o seu checkout já dispara hoje, sem alteração
```

O `<slug-do-projeto>` é um código curto e aleatório gerado no cadastro (algo como `x7k2v9ab`). Ele é aleatório de propósito: um caminho previsível como `/webhook` ou `/track` entra em listas de bloqueio genéricas.

O `<token-de-ingestao>` aparece na aba Instalação clicando em **Mostrar** — ele não fica exposto na tela por padrão, e cada revelação é registrada em log.

**Você não precisa mudar o formato do payload.** O servidor reconhece o formato do seu checkout e traduz sozinho — `checkout.session.completed` com `paymentStatus: paid` vira Purchase, `checkout.pix.generated` vira AddPaymentInfo, valores em centavos são convertidos, nome é separado em nome/sobrenome, PII é hasheada.

Dois formatos são reconhecidos hoje: o da **Checkout Platform** (camelCase, campos planos) e o do **backoffice do xWinner** (`{event, event_id, data:{…}}`, snake_case, 24 eventos catalogados). Se o webhook passa por um n8n no caminho, ele deve repassar o corpo **intacto**, um evento por requisição — ver [`16-catalogo-xwinner-e-n8n.md`](16-catalogo-xwinner-e-n8n.md).

Teste rápido, direto do terminal:

```bash
curl -X POST https://traker.codigovencedor.com/e/SEU_SLUG \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SEU_TOKEN" \
  -d '{"event_name":"purchase","event_id":"teste-001","user_data":{"email":"teste@exemplo.com"},"custom_data":{"value":97,"currency":"BRL"}}'
```

Resposta esperada: `202` com `{"status":"accepted", ...}`. O evento aparece na aba **Logs** em segundos.

---

## 3. O webhook que **envia** os eventos (da sua aplicação)

Aqui há duas leituras possíveis, e vale separar porque são configurações em lugares diferentes:

### 3a. Sua aplicação disparando para nós

É o mesmo endereço da seção 2. Na sua aplicação, procure a configuração de webhooks/notificações e cadastre a URL acima. Se o seu checkout permitir escolher **quais** eventos disparar, marque todos os que existirem — o servidor decide o que fazer com cada um e o que não interessa fica só registrado no log, sem ir para a Meta.

Se o seu sistema exigir uma URL por evento, use **a mesma URL para todos**: o tipo do evento vai dentro do corpo (`"event": "..."`), não no caminho.

### 3b. Nosso servidor disparando para você (postback)

Caminho inverso: o Servidor Traker pode repassar cada evento processado para um endpoint **seu** (CRM, n8n, planilha, plataforma de afiliados).

**Onde configurar:** painel → projeto → aba **Postback**.

```
URL:      https://seu-sistema.com/recebe-conversao   (você fornece)
Método:   GET ou POST
Eventos:  quais tipos repassar
Headers:  opcionais
Token:    Bearer opcional, guardado criptografado
```

A URL aceita interpolação: `https://parceiro.com/conv?click_id={{clickid}}&valor={{value}}` — os campos do evento entram no lugar das chaves.

Isso é **opcional**. Se você não usa nenhum sistema externo, deixe desligado.

---

## 4. A tag no GTM (navegador)

Só isso vai para o GTM. As conversões **não** passam por aqui.

**Onde configurar:** GTM Web do site → Tags → Nova → HTML personalizado. As URLs exatas estão no painel, aba Instalação, trilha *Navegador*.

| Tag | Acionador | Para quê |
|---|---|---|
| `<script src="https://traker.codigovencedor.com/g/<slug>.js"></script>` | All Pages, prioridade alta | Captura `fbclid`, `gclid`, `_fbp`, `_fbc` e UTMs amarrados à sessão do visitante, cria `window.trk(...)` e dispara o `page_view` |

Uma tag, não três. As três coisas moram no mesmo arquivo porque a ordem entre elas importa e o GTM não garante ordem entre dois `<script src>` — detalhe em [`04-tagueamento-meta.md`](04-tagueamento-meta.md), seção 2.2. Instalações antigas em duas tags (`/s/` + `/t/`) continuam válidas.

### O passo que faz a diferença no seu caso

A tag precisa saber **sob qual chave** guardar a identidade, e essa chave tem que ser a mesma que o webhook envia depois. Sem isso, a compra chega sem `fbclid` e a Meta não consegue ligá-la ao anúncio.

No checkout, empurre o identificador da sessão para o dataLayer **antes** da tag rodar:

```html
<script>
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ sessionId: 'MESMO_VALOR_QUE_VAI_NO_WEBHOOK' });
</script>
```

A tag procura, nesta ordem: `user_id`, `userId`, `customerReference`, `sessionId`, `session_id`, `taxId`, `cpf`, entre outras. O adaptador do webhook usa `customerReference` → `taxId` → `sessionId`. Basta que um desses coincida nos dois lados.

---

## 5. Checklist de ativação

- [ ] Registro A de `traker.codigovencedor.com` criado e apontando para o IP reservado
- [ ] Certificado emitido (o painel mostra o domínio como `ativo`)
- [ ] Projeto criado no painel, com Pixel ID e Access Token da Meta salvos
- [ ] Test Event Code preenchido (para testar sem sujar os dados)
- [ ] URL do webhook + token cadastrados na sua aplicação
- [ ] Tag `/g/<slug>.js` instalada e **publicada** (não só salva) no GTM
- [ ] `sessionId` (ou equivalente) sendo empurrado para o dataLayer no checkout
- [ ] Aba **Testar** do painel: evento simulado com pontuação de correspondência aceitável
- [ ] Um evento de teste aparecendo no *Testar eventos* do Events Manager
- [ ] Test Event Code removido e primeira conversão real conferida na aba Logs
- [x] ~~`LOGIN_RAPIDO=false` no `.env`~~ — **não é mais necessário conferir**: o atalho de entrar sem senha foi removido do código em 2026-08-13, e dois testes de integração impedem que ele volte. Não há flag a esquecer ligada.

---

## Perguntas frequentes

**Preciso de um subdomínio para cada evento?** Não. Um endereço só, para tudo.

**O webhook precisa de subdomínio?** Não. Só as tags do navegador dependem disso. Como usam o mesmo endereço, o subdomínio acaba servindo os dois.

**Posso testar antes de apontar o DNS?** Sim, pela aba **Testar** do painel, em modo *Simular* — mostra o payload exato que iria para a Meta sem enviar nada.

**Se eu mudar o slug, quebra?** Sim: a URL do webhook muda junto. O slug só deve ser rotacionado se você suspeitar de bloqueio, e a URL nova precisa ser atualizada na sua aplicação.

**Preciso mudar o payload do meu checkout?** Não. O servidor entende o formato atual.

---

Ver também: [`04-tagueamento-meta.md`](04-tagueamento-meta.md) (tagueamento completo) · [`07-referencia-api.md`](07-referencia-api.md) (todos os endpoints) · [`02-deploy-oracle-cloud.md`](02-deploy-oracle-cloud.md) (subir na Oracle).
