---
title: Tagueamento Meta — GTM Web, deduplicação Pixel × CAPI e EMQ
tags: [tagueamento, meta, capi, gtm, pixel, deduplicacao, emq, consent-mode, servidor-traker]
created: 2026-08-12
updated: 2026-08-25
---

# Tagueamento Meta — GTM Web, deduplicação Pixel × CAPI e EMQ

Guia prático para quem faz tráfego pago: como instalar o Servidor Traker no GTM Web, como
fazer o Pixel e a Conversions API conversarem sem contar a mesma conversão duas vezes, e
como espremer a qualidade de correspondência (EMQ) até o teto.

Não é necessário saber programar. Onde tiver bloco de código, é para copiar e colar,
trocando só o que estiver `EM_MAIUSCULO_ASSIM` ou o slug de exemplo.

**Pré-requisitos:** o servidor já no ar (`02-deploy-oracle-cloud.md`) com o subdomínio
`traker.codigovencedor.com` respondendo em HTTPS (`03-dns-tls-subdominio.md`), e um projeto
criado no painel admin.

---

## Antes de tudo: qual evento vem de onde

> **Na instalação do Código Vencedor, só o `page_view` sai do navegador.** Compra, PIX
> gerado e lead chegam pelo **webhook do backend**. Isso muda o que você precisa fazer:
>
> | | Vem do navegador (GTM) | Vem do backend (webhook) |
> |---|---|---|
> | Eventos | `page_view` | `purchase`, `pix_gerado`, `lead`, `abandoned_checkout` |
> | O que instalar | Uma tag só (`/g/…js`), que já traz captura e `page_view` | Só cadastrar a URL e o token na sua aplicação |
> | Deduplicação com o Pixel | Só importa se você mantiver o Pixel do navegador disparando os mesmos eventos | Não se aplica, a menos que o Pixel também dispare Purchase |
>
> **A consequência prática:** a seção 3 (deduplicação) só é obrigatória se o Pixel do
> navegador continuar disparando conversão. Se as conversões saem exclusivamente do
> backend, não há o que deduplicar — mas a **tag do navegador continua sendo obrigatória**,
> porque é ela que captura o `fbclid` para a conversão do backend poder usar. Sem ela, a
> compra chega sem nenhum vínculo com o clique no anúncio.
>
> O passo a passo de onde colar cada coisa está em
> [`11-onde-colocar-cada-coisa.md`](11-onde-colocar-cada-coisa.md).

---

## 0. Os quatro endereços do seu projeto

Ao criar um projeto no painel, ele recebe um **slug aleatório** de 8 caracteres — por
exemplo `x7k2v9ab`. Esse slug aparece pronto na aba **Instalação**. Ele é aleatório de
propósito: caminhos previsíveis (`/collect`, `/pixel`, `/track`) entram em blocklist de
adblocker; um caminho aleatório no domínio do próprio cliente não entra.

| O que é | URL | Para que serve |
|---|---|---|
| **Tag única do GTM** | `https://traker.codigovencedor.com/g/x7k2v9ab.js` | **É a que você instala.** Coletor + `window.trk()` + `page_view` num arquivo só. Uma tag de HTML personalizado, acionamento All Pages. |
| **Tag única sem GTM** | `https://traker.codigovencedor.com/w/x7k2v9ab.js` | Mesma coisa para quem não usa GTM: uma linha no `<head>` do site. |
| **Endpoint de eventos** | `https://traker.codigovencedor.com/e/x7k2v9ab` | Onde os eventos chegam. Também é a URL do webhook do backend. |
| **Endpoint de identidade** | `https://traker.codigovencedor.com/c/x7k2v9ab` | Só a tag usa. Você não chama isso à mão. |

> **As duas metades servidas separadas.** `/s/x7k2v9ab.js` (só o coletor) e
> `/t/x7k2v9ab.js` (só o `window.trk`) continuam existindo e são exatamente o conteúdo que
> a `/g/` empacota. Quem instalou em duas tags **não precisa mexer em nada** — continua
> funcionando. Em instalação nova, use a `/g/`: uma tag em vez de duas elimina a única
> fonte de erro que dependia de o operador acertar a prioridade de disparo.

> **Rotas antigas.** Se você instalou antes com `/ingest/prj_xxxx`, `/collect/prj_xxxx`,
> `/collector/prj_xxxx.js` ou `/snippet/prj_xxxx.js`, elas **continuam funcionando** — não
> quebra nada. Mas em instalação nova use sempre as curtas (`/e/`, `/c/`, `/g/`, `/w/`).

> **Troque o `x7k2v9ab` pelo slug do seu projeto** em todos os exemplos deste documento.
> Copie da aba Instalação; não invente nem reaproveite o de outro projeto.

---

## 1. Como o fluxo funciona, de ponta a ponta

Antes de mexer no GTM, vale entender o desenho. São dois caminhos que terminam no mesmo
lugar.

### Caminho A — evento que acontece no navegador

```
Visitante clica no anúncio
        │  (a URL chega com ?fbclid=IwAR...)
        ▼
[ site do cliente ]
   ├── Pixel da Meta (fbq)  ──────────────► Meta, pelo navegador
   │        grava _fbp e _fbc nos cookies
   │
   └── tag única /g/x7k2v9ab.js
            1) guarda fbclid, _fbp, _fbc, UTMs no localStorage
               e, quando o site sabe quem é o usuário, manda para /c/x7k2v9ab
            2) cria window.trk
            3) dispara o page_view  ─┐
                                     ├─ e suas outras tags: window.trk('purchase', {...})
                │                    │
                ▼◄───────────────────┘
   POST https://traker.codigovencedor.com/e/x7k2v9ab
                │
                ▼
        [ Servidor Traker ]
          • pega o IP real e o User-Agent da requisição
          • normaliza e hasheia e-mail/telefone em SHA-256
          • deriva o _fbc a partir do fbclid, se faltar
          • aplica Consent Mode v2
          • grava o evento e devolve 202 na hora
          • renova _fbp/_fbc por Set-Cookie (driblando o ITP do Safari)
                │
                ▼ (worker, em segundo plano)
        Meta Conversions API
```

O ponto que costuma surpreender: **a resposta ao navegador é imediata (`202`)**. O envio
para a Meta acontece depois, num processo separado. Se a API da Meta estiver lenta, a
página do cliente não trava. Em compensação, o evento não aparece no Events Manager no
mesmo segundo — dá alguns segundos de atraso normal.

### Caminho B — conversão que só o backend conhece

Compra aprovada por PIX 40 minutos depois, cadastro validado por um analista, upsell no
CRM. O navegador do visitante não está mais aberto. Aí:

```
[ backend do cliente ]
        │
        ▼
POST https://traker.codigovencedor.com/e/x7k2v9ab
Authorization: Bearer <ingest_token>
{ "event_name":"purchase", "user_id":"player-4821", "custom_data":{...} }
        │
        ▼
[ Servidor Traker ]
  • busca a identidade guardada para "player-4821"
  • completa sozinho fbc, fbp, gclid, IP e User-Agent capturados lá atrás no navegador
        │
        ▼
Meta Conversions API — com qualidade de match de evento web
```

É essa **ponte de identidade** que faz uma conversão de backend valer tanto quanto uma
conversão de navegador. Sem ela, o backend mandaria um evento sem `_fbc`, sem `_fbp` e com
o IP do servidor — praticamente inútil para atribuição. Detalhe da regra: **campos que já
vieram no evento nunca são sobrescritos**; a identidade só preenche buraco.

### O que o servidor faz sozinho (e você não precisa fazer no GTM)

Essa lista existe para você **não** perder tempo tentando fazer isso na mão:

- Extrai `client_ip_address` e `client_user_agent` reais da requisição.
- Normaliza e hasheia PII em SHA-256: e-mail com `trim` + minúsculas; telefone só dígitos,
  com o DDI `55` acrescentado quando o número vem com 10 ou 11 dígitos (o clássico
  `11987654321` do dataLayer). Se o valor já vier hasheado (64 caracteres hex), ele não
  hasheia de novo.
- **Nunca hasheia `_fbp` e `_fbc`.** Eles vão em texto puro, como a Meta exige.
- Deriva o `_fbc` a partir do `fbclid` no formato oficial `fb.1.<timestamp_ms>.<fbclid>`
  quando o cookie não existe.
- Usa o `user_id` como `external_id` (hasheado).
- Renova `_fbp`/`_fbc` via `Set-Cookie` HTTP first-party — mitigação do ITP do Safari, que
  corta em 7 dias qualquer cookie gravado por JavaScript.
- Aplica Consent Mode v2 (seção 7).
- Deduplica por `(projeto, event_id, event_name)` e nunca posta duas vezes no mesmo destino.
- Traduz o nome do evento do seu site para o nome da Meta, conforme o mapeamento do projeto.

---

## 2. Instalação no GTM Web, passo a passo

É **uma tag** no GTM. Ela já vem com o `page_view` dentro — não crie tag separada para ele,
e **nunca** crie tag de compra no GTM (conversão entra pelo webhook do backend, seção 4).

### 2.1 A tag (All Pages, o mais cedo possível)

**Tags → Nova → Configuração da tag → HTML personalizado**

```html
<script src="https://traker.codigovencedor.com/g/x7k2v9ab.js"></script>
```

- **Nome:** `TrackServer`
- **Acionamento:** `All Pages` (Todas as páginas)
- **Avançado → Prioridade de disparo da tag:** `100` (número alto = dispara antes)

> **Cole exatamente isso — a linha do `<script src>`, não o conteúdo do arquivo.** Copie da
> aba **Instalação** do painel, que já monta a linha com o slug certo.
>
> *Errata (2026-08-26):* a versão anterior deste aviso justificava a linha dizendo que o
> GTM recusa "JavaScript cru" no campo HTML personalizado. Isso vale só para JS **sem** o
> embrulho `<script>…</script>` — com ele o campo aceita normalmente. As razões reais de
> preferir o `<script src>` são outras: **atualização central** (corrigimos a tag no
> servidor e todo cliente recebe sem republicar contêiner), **endpoint e slug embutidos
> pelo servidor** (não há como colar a URL de outro projeto) e **o código não pode ser
> editado por engano dentro da tag**. O custo é uma viagem de rede antes da captura.

> **Por que o mais cedo possível?** A tag guarda o `fbclid` da URL de entrada. Se o
> visitante clicar num link interno antes de ela rodar, a URL muda, o `fbclid` some e
> aquela sessão perde a amarração com o clique no anúncio. Esse dado aparece **uma vez** e
> não volta.

O que ela guarda em `localStorage`, de forma *sticky* (sobrevive à navegação e ao
corte de cookies do Safari):

`fbclid`, `gclid`, `gbraid`, `wbraid`, `ttclid`, `clickid`, `tblci`, `_fbp`, `_fbc`,
`_ttp`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`.

Ela **não envia conversão**. Manda a identidade para o servidor quando encontra um
`user_id` no dataLayer, **uma vez por sessão por usuário** — ver seção 5 — e dispara o
`page_view`, o único evento que nasce no navegador.

### 2.2 Por que um arquivo só, e não dois `<script src>`

O arquivo `/g/` é a concatenação de `/s/` (coletor) + `/t/` (o `window.trk`) + a chamada do
`page_view`. A ordem entre essas partes não é preferência: **o coletor grava os `tk_*` que o
snippet lê ao montar o payload**, e o `page_view` só pode disparar depois de `window.trk`
existir.

Dois `<script src>` injetados pelo GTM não têm ordem de execução garantida — nem com
prioridade de disparo diferente, porque a prioridade ordena a *execução da tag*, não o
*download do script*. Um arquivo tem: é execução síncrona de cima para baixo. Por isso a
instalação em duas tags saía errada quando a rede colaborava contra, e é o motivo de a
`/g/` existir.

Repare que a tag **não** leva `async`. É de propósito: ela precisa terminar de carregar
antes de qualquer tag que chame `window.trk(...)`. Com `async`, um `purchase` que dispara
rápido demais encontraria `window.trk` ainda indefinido e o evento se perderia em silêncio.

### 2.3 Ordem final de disparo em uma página

```
1. TrackServer (/g/…js)   prioridade 100   — captura fbclid, cria window.trk, dispara page_view
2. Pixel base da Meta                      — cria fbq, grava _fbp/_fbc
3. Suas tags de evento (purchase, lead…)   — usam window.trk + fbq
```

O item 2 é tag da Meta, não nossa — você já a teria no contêiner de qualquer jeito. **De
nossa, é uma tag só**, o item 1.

> **O `TrackServer.tpl` da pasta `gtm/` não substitui esta tag.** Ele é um template de
> *envio de evento*, uma tag por conversão — outro assunto, e em conflito direto com a
> regra de não criar tag de compra no GTM. Para a instalação do Passo 2, use HTML
> personalizado com a linha `<script src>` que o painel gera.

> **Já instalou em duas tags, ou com o JavaScript colado inline?** Não precisa migrar:
> `/s/` e `/t/` continuam servidas. Se quiser consolidar, **apague as antigas na mesma
> publicação** em que a `/g/` entra: a antiga "Tag 2" tinha um `window.trk('page_view')`
> inline, que somado ao `page_view` da `/g/` viraria dois `page_view` por carregamento (a
> captura em duplicidade é inofensiva — grava o mesmo valor no mesmo lugar).
>
> **Atenção ao caso do coletor colado sozinho.** Uma instalação antiga em que a tag tem o
> JavaScript do `/s/` minificado e mais nada é pior do que parece: ela não tem `window.trk`
> nem `page_view`, então **nada** chega ao servidor — nem identidade (que depende do
> `user_id`), nem evento. E o GTM marca a tag como "Concluída", porque ela de fato rodou
> sem erro. Se a tag no contêiner é um bloco grande de JS em vez de uma linha, é este caso.

### 2.4 Quando o site não expõe o `user_id`

A tag procura o identificador em duas fontes, nesta ordem: o `dataLayer` e as variáveis
globais (`window`). Se ele não estiver em nenhuma das duas — SPA, login assíncrono, site
que só conhece o usuário no backend — **a ponte de identidade não é gravada**, e a compra
que chegar depois pelo webhook vai para a Meta sem o clique.

Repare no que continua funcionando mesmo assim: o `page_view` sai normalmente, levando
`fbclid`, `gclid`, `_fbp`, `_fbc` e as UTMs. O que se perde é só o vínculo com a conversão
do backend — que, justamente, é onde está o dinheiro.

Duas saídas, qualquer uma resolve:

```js
// (a) o site empurra para o dataLayer assim que souber quem é
window.dataLayer = window.dataLayer || [];
window.dataLayer.push({ user_id: 'jogador-4821' });

// (b) ou chama a tag diretamente — nenhum dataLayer envolvido
window.trkIdentify({ user_id: 'jogador-4821' });
```

Se o `trkIdentify` puder ser chamado antes de a tag terminar de carregar, use a fila:

```js
window.trkQueue = window.trkQueue || [];
window.trkQueue.push(['__identify__', { user_id: 'jogador-4821' }]);
```

**Para descobrir o nome certo da chave**, abra qualquer página com `?trk_debug=1` na URL e
olhe o Console: a tag lista o que procurou, o que encontrou no `dataLayer` e os
identificadores de marketing que já capturou.

### 2.5 Conferir que instalou

Abra o site, F12 → Console, e digite:

```js
typeof window.trk        // deve responder: "function"
localStorage.getItem('tk_fbclid')   // depois de entrar por um link com ?fbclid=...
```

Se `typeof window.trk` responder `"undefined"`, a tag não carregou: confira o slug na URL
e se a tag foi publicada (não só salva).

---

## 3. Deduplicação Pixel × CAPI — a parte mais importante deste documento

Você vai enviar a **mesma conversão duas vezes**: uma pelo navegador (Pixel) e uma pelo
servidor (CAPI). Isso é intencional e é o desenho correto — o navegador tem cookie e
contexto, o servidor tem confiabilidade e não é bloqueado. A Meta junta as duas e conta
**uma**, desde que você faça o combinado.

### 3.1 A regra da Meta, em três linhas

A Meta considera dois eventos como sendo o mesmo quando:

1. o **`event_id` é idêntico**, **e**
2. o **`event_name` é idêntico**, **e**
3. os dois chegam dentro de uma janela de **48 horas**.

O **primeiro que chega vence**; o segundo é descartado. Não importa se foi o do navegador
ou o do servidor. Falhou qualquer uma das três condições, a Meta trata como dois eventos
distintos e você **conta a conversão em dobro** — ROAS inflado, otimização envenenada.

### 3.2 Como pegar o `event_id` certo

`window.trk()` **retorna o `event_id`** que usou. É só guardar o retorno e repassar ao
Pixel:

```html
<script>
  // 1. Manda para o servidor. Guarda o event_id que ele usou.
  var eventId = window.trk('purchase', {
    user_id: {{DL - user_id}},
    user_data: {
      email: {{DL - email}},
      phone: {{DL - telefone}}
    },
    custom_data: {
      value:    {{DL - valor}},
      currency: 'BRL',
      order_id: {{DL - order_id}}
    }
  });

  // 2. Manda para o Pixel com o MESMO id.
  fbq('track', 'Purchase', {
    value:    {{DL - valor}},
    currency: 'BRL'
  }, { eventID: eventId });
</script>
```

Três detalhes que quebram tudo se você errar:

- É `eventID` — **`ID` maiúsculo**. `eventId` ou `event_id` no terceiro parâmetro do `fbq`
  são ignorados silenciosamente pela Meta.
- O `eventID` vai no **terceiro** argumento do `fbq('track', ...)`, num objeto separado. Se
  você jogar dentro do objeto de dados (segundo argumento), vira um parâmetro custom
  qualquer e a dedup não acontece.
- Chame `window.trk()` **antes** do `fbq`, para ter o id em mãos.

### 3.3 O erro que quebra a dedup em silêncio: o nome do evento

Este é o erro nº 1 e ele **não gera nenhum aviso** em lugar nenhum.

O Servidor Traker **traduz** o nome do evento do seu site para o nome da Meta, usando o
mapeamento configurado na aba **Meta** do painel. Já vem preenchido assim:

| Evento no seu site (`window.trk`) | Nome enviado à Meta |
|---|---|
| `page_view` | `PageView` |
| `view_content` | `ViewContent` |
| `sign_up` | `CompleteRegistration` |
| `lead` | `Lead` |
| `add_to_cart` | `AddToCart` |
| `begin_checkout` | `InitiateCheckout` |
| `abandoned_checkout` | `AbandonedCheckout` |
| `purchase` | `Purchase` |

Ou seja: você chama `window.trk('begin_checkout', ...)` e a Meta recebe `InitiateCheckout`.
Logo, no Pixel você **tem que** disparar `fbq('track', 'InitiateCheckout', ...)` — e não
`fbq('track','begin_checkout')`, nem `fbq('trackCustom','begin_checkout')`.

**Regra prática:** o nome no `fbq` é sempre o da **coluna da direita** da tabela acima.

O caso mais traiçoeiro é o `sign_up`: você chama `sign_up` na tag e a Meta recebe
`CompleteRegistration`. Quem dispara `fbq('track','Lead')` no cadastro está criando dois
eventos diferentes com o mesmo `event_id` — e a Meta **não** deduplica, porque a regra
exige nome igual.

> Se você editar o mapeamento na aba Meta do painel, **atualize o `fbq` junto**. São dois
> lugares e ninguém avisa quando desalinham.

### 3.4 O caso do `purchase` que chega pelos dois caminhos

Este é o cenário real que justifica todo o resto: a compra chega pelo **navegador** (página
de obrigado) e também pelo **webhook do backend** (confirmação de pagamento). Dois eventos
`Purchase`, gerados em momentos diferentes, por sistemas diferentes, que nem se conhecem.

A solução é o `event_id` **determinístico**. A tag de captura gera o `event_id` assim:

1. Se você passar `event_id` explicitamente, usa o seu.
2. Senão, se existir `custom_data.order_id` **ou** `custom_data.transaction_id`, gera
   `<nome_do_evento>-<order_id>` — ex.: `purchase-8812`.
3. Senão, gera um UUID aleatório.

O servidor aplica **exatamente a mesma regra** nos eventos que chegam por webhook. Então:

```html
<!-- Navegador, na página de obrigado -->
<script>
  var eventId = window.trk('purchase', {
    user_id: {{DL - user_id}},
    custom_data: { value: 199.90, currency: 'BRL', order_id: '8812' }
  });
  // eventId === "purchase-8812"
  fbq('track', 'Purchase', { value: 199.90, currency: 'BRL' }, { eventID: eventId });
</script>
```

```bash
# Backend, quando o pagamento é confirmado — sem event_id explícito
curl -X POST https://traker.codigovencedor.com/e/x7k2v9ab \
  -H "Authorization: Bearer SEU_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event_name": "purchase",
    "user_id": "player-4821",
    "user_data": { "email": "cliente@exemplo.com", "phone": "11987654321" },
    "custom_data": { "value": 199.90, "currency": "BRL", "order_id": "8812" }
  }'
```

Os dois produzem `event_id = "purchase-8812"`. Resultado:

- O **servidor** já barra na entrada: a dedup interna é por `(projeto, event_id,
  event_name)` e o segundo POST volta com `{"status":"duplicate"}` sem gerar nova entrega.
- Mesmo que o servidor não pegasse, a **Meta** dedupliria: mesmo `event_id`, mesmo
  `Purchase`, dentro de 48h.

São duas redes de proteção. Você não precisa escolher qual caminho usar — pode usar os dois
e deixar o `order_id` resolver.

> **Requisito absoluto:** o `order_id` do navegador e o do backend têm que ser **a mesma
> string**. `8812` no navegador e `#8812` ou `8812.0` no backend geram
> `purchase-8812` vs `purchase-#8812` — dois eventos, conversão dobrada. Padronize no
> mesmo formato que o banco de dados guarda e trate como texto, nunca como número.

### 3.5 E o `PageView`?

O snippet base do Pixel dispara `fbq('track', 'PageView')` sozinho, **sem `eventID`**. Se
você também mandar `page_view` pelo servidor, a Meta vai contar dois PageViews por página.

Para PageView isso não corrompe otimização de campanha (não é evento de conversão), mas
polui relatório e infla o volume. Duas saídas:

- **Recomendada:** remova o `fbq('track','PageView')` do snippet base e dispare o PageView
  numa tag do GTM, com o `eventID` vindo do `window.trk('page_view')`, como na seção 6.1.
- **Alternativa:** deixe o `page_view` desmapeado no painel (remova a linha do JSON de
  mapeamento na aba Meta) e mande PageView só pelo navegador. Você perde a renovação de
  cookie via servidor nas páginas sem conversão — é uma perda real, mas pequena.

---

## 4. Como maximizar o EMQ

EMQ (*Event Match Quality*, "Qualidade da Correspondência de Eventos") é a nota de 0 a 10
que a Meta dá para cada evento no Events Manager. É a medida de quanto ela consegue
identificar a pessoa por trás do evento. EMQ baixo = atribuição pior = CPA aparente pior =
otimização pior. É o número que mais mexe no resultado sem mexer em criativo.

### 4.1 Tabela de prioridade dos campos

Nem todo campo pesa igual. Esta é a ordem de esforço/retorno, do que mais vale para o que
menos vale:

| Prioridade | Campo | Como chega ao servidor | Por que vale tanto |
|---|---|---|---|
| **1** | `email` | você passa em `user_data.email` | Identificador mais forte que existe. A Meta casa com a conta do usuário direto. |
| **2** | `phone` | você passa em `user_data.phone` | Quase tão forte quanto o e-mail no Brasil, onde muita conta é criada por telefone. |
| **3** | `fbc` | **automático** (cookie `_fbc` ou derivado do `fbclid`) | É o que amarra a conversão **ao clique naquele anúncio**. Sem ele, a Meta sabe quem comprou mas não sabe qual anúncio trouxe. |
| **4** | `external_id` | **automático** a partir do `user_id` | Permite a Meta ligar eventos do mesmo usuário ao longo do tempo, mesmo sem e-mail em todos eles. |
| **5** | `client_ip_address` + `client_user_agent` | **automático** (o servidor extrai da requisição) | Sozinhos são fracos; combinados com o resto, empurram a nota. Já vêm de graça. |
| **6** | `fbp` | **automático** (cookie `_fbp`) | Identifica o navegador. Vale, mas morre quando o usuário troca de dispositivo. |
| **7** | `first_name`, `last_name` | você passa | Incremento pequeno. Só ajuda quando e-mail e telefone faltam. |
| **8** | `city`, `state`, `zip`, `country` | você passa | O menor retorno de todos. Não vale reprojetar checkout por eles. |

Leitura prática: **as prioridades 3, 4, 5 e 6 já estão resolvidas** pelo servidor sem você
fazer nada. O seu trabalho de verdade é garantir **e-mail e telefone** nos eventos de
conversão. É aí que está o ganho.

### 4.2 O que precisa estar no dataLayer

Do lado do site (isso é conversa com quem desenvolve o site, não com o GTM):

```js
// Assim que o usuário está identificado — login, cadastro, checkout preenchido
window.dataLayer = window.dataLayer || [];
window.dataLayer.push({
  event: 'usuario_identificado',
  user_id: 'player-4821',            // a MESMA chave que o backend usa
  email:   'cliente@exemplo.com',
  telefone: '11987654321'
});
```

Depois, no GTM, você cria variáveis de camada de dados (`DL - user_id`, `DL - email`,
`DL - telefone`) e as usa nas chamadas do `window.trk`.

Três regras que valem ouro:

1. **Mande a PII crua.** Não hasheie no navegador. O servidor normaliza (trim, minúsculas,
   só dígitos, DDI 55) e hasheia com a regra certa. Hash feito no navegador quase sempre
   sai com normalização errada e vira um hash que não casa com nada. (Se por política de
   segurança você *tiver* que hashear antes, o servidor detecta valores já hasheados — 64
   caracteres hex — e não hasheia de novo; mas a normalização passa a ser sua
   responsabilidade.)
2. **Telefone pode ir como o usuário digitou.** `(11) 98765-4321`, `11987654321`,
   `+55 11 98765-4321` — o servidor limpa tudo e chega no mesmo hash. Números com 10 ou 11
   dígitos ganham o `55` automaticamente.
3. **Use o mesmo `user_id` em todo lugar.** Navegador, backend e webhook. O servidor
   normaliza o `external_id` sozinho antes de hashear — aplica `trim` e minúsculas,
   exatamente o que o `fbq` faz no Advanced Matching — então `Player-4821` e `player-4821`
   chegam ao mesmo hash e casam. Ainda assim, padronize um formato e mantenha por
   consistência: normalização igual dos dois lados é garantia de match, mas um `user_id`
   que muda de forma entre sistemas continua sendo fonte de confusão em relatório e
   depuração.

### 4.3 Advanced Matching do Pixel tem que espelhar os mesmos dados

Erro comum: caprichar no `user_data` do servidor e deixar o Pixel do navegador magro. A
Meta calcula a qualidade do **evento deduplicado**, então o par tem que estar alinhado.

No snippet base do Pixel, passe os mesmos dados no `fbq('init', ...)`:

```html
<script>
  fbq('init', 'SEU_PIXEL_ID', {
    em: {{DL - email}},        // crus mesmo; a biblioteca do Pixel hasheia sozinha
    ph: {{DL - telefone}},
    external_id: {{DL - user_id}}
  });
</script>
```

O Advanced Matching do navegador hasheia por conta própria — nesse lado, sim, você manda
cru e a biblioteca resolve. E use **o mesmo `external_id`** dos dois lados: é ele que
costura o histórico do usuário.

### 4.4 Diagnóstico de EMQ no próprio painel

A aba **Dashboard** do painel mostra, para os eventos recentes, a **% que carrega cada
campo de match**: `email`, `phone`, `fbc`, `fbp`, `external_id`, `client_ip_address`,
`client_user_agent` — mais quantas identidades a ponte já guardou.

> **Isso é diagnóstico interno, não é o EMQ oficial.** O número oficial vive no Events
> Manager da Meta e é calculado com a fórmula deles, que ninguém de fora conhece. O bloco
> do painel serve para outra coisa, mais útil no dia a dia: **descobrir onde está o furo**.
> Se ele mostra "`purchase` com e-mail em 58% dos casos", o problema é o dataLayer da
> página de obrigado, não a configuração da CAPI. Ele responde "o quê", o Events Manager
> responde "quanto".

Metas razoáveis para eventos de conversão (`purchase`, `lead`, `sign_up`):

- `client_ip_address` e `client_user_agent`: ~100% (se não estiver, veja a seção 9.6)
- `fbp`: 85%+
- `external_id`: 90%+ (depende de o `user_id` estar no dataLayer)
- `email`: 90%+
- `fbc`: 40–70% — é normal ser mais baixo; nem todo mundo veio de anúncio

---

## 5. A ponte de identidade — salvando a conversão de backend

### 5.1 O problema

Compra por PIX confirmada 40 minutos depois. Cadastro aprovado no dia seguinte. Renovação
de assinatura. Nesses casos o navegador do visitante não existe mais, e um evento enviado
pelo backend sairia sem `_fbc`, sem `_fbp` e com o IP do datacenter. A Meta recebe, aceita,
e não consegue atribuir a ninguém.

### 5.2 A solução

A tag (`/g/x7k2v9ab.js`) guarda os identificadores no navegador **e**, quando descobre
quem é o usuário, manda tudo para o servidor amarrado ao `user_id`. Depois, quando o
webhook chega com aquele `user_id`, o servidor completa o evento com o que foi capturado lá
atrás.

### 5.3 O que o site precisa fazer

**Uma coisa só: colocar o `user_id` no dataLayer.** O coletor procura sozinho nestas
chaves, inclusive dentro de um objeto `custom_parameters`:

```
user_id, userId, user_id_cp, player_id, playerId,
jogador_codigo, jogador_id, codigo, customer_id, cliente_id
```

Ou seja: se o site já empurra `player_id` ou `codigo` para o dataLayer por outro motivo,
**a ponte já funciona sem alterar nada**. Vale conferir antes de pedir desenvolvimento.

```js
// Qualquer um destes formatos funciona:
dataLayer.push({ event: 'login', user_id: 'player-4821' });
dataLayer.push({ event: 'login', custom_parameters: { player_id: 'player-4821' } });
```

Comportamento do coletor, para você não estranhar no Network:

- Ele varre o dataLayer **do fim para o começo**, pegando o valor mais recente.
- Se não achar `user_id`, ele **não envia nada** e não dá erro. É o esperado antes do login.
- Se achar `user_id` mas nenhum identificador de marketing (nem `fbclid`, nem `_fbp`, nem
  `gclid`…), também não envia — não haveria o que guardar.
- Envia **uma vez por sessão por usuário**. Se você recarregar a página e não vir uma
  segunda chamada a `/c/...`, está certo. Para forçar um novo envio ao testar, abra uma
  aba anônima ou limpe o `sessionStorage`.
- Ele **nunca envia conversão**. Só identidade. `/c/` não gera evento na Meta.

### 5.4 O webhook do backend

```bash
POST https://traker.codigovencedor.com/e/x7k2v9ab
Authorization: Bearer <ingest_token>     # copie da aba Instalação
Content-Type: application/json

{
  "event_name": "purchase",
  "user_id": "player-4821",
  "user_data": { "email": "cliente@exemplo.com", "phone": "11987654321" },
  "custom_data": { "value": 199.90, "currency": "BRL", "order_id": "8812" }
}
```

O que o servidor completa sozinho pela identidade: `fbc`, `fbp`, `fbclid`, `gclid`,
`gbraid`, `wbraid`, `client_ip_address`, `client_user_agent`, UTMs. **Campos que você
mandou nunca são sobrescritos** — se você mandar um `email`, é o seu que vai.

Eventos de webhook saem com `action_source: "system_generated"` em vez de `"website"`.
Isso é correto e a Meta espera essa distinção; não é erro.

> O `ingest_token` é uma senha. Ele fica no backend, em variável de ambiente. **Nunca** no
> GTM, no HTML da página ou num repositório público — com ele qualquer pessoa injeta
> conversões falsas no seu pixel.

---

## 6. Exemplos de disparo, evento por evento

Todos os exemplos assumem que a tag de captura já carregou e que `{{DL - ...}}` são
variáveis de camada de dados do GTM. Ajuste os nomes das variáveis ao seu container.

### 6.1 `page_view`

```html
<script>
  var id = window.trk('page_view', {
    user_id: {{DL - user_id}}
  });
  fbq('track', 'PageView', {}, { eventID: id });
</script>
```

Gatilho: `All Pages`. Não precisa de `custom_data`. Lembre da seção 3.5 sobre o PageView
automático do snippet base.

### 6.2 `view_content` → `ViewContent`

```html
<script>
  var id = window.trk('view_content', {
    user_id: {{DL - user_id}},
    custom_data: {
      content_name:  {{DL - nome_produto}},
      content_ids:   [{{DL - id_produto}}],
      content_type:  'product',
      content_category: {{DL - categoria}},
      value:    {{DL - preco}},
      currency: 'BRL'
    }
  });
  fbq('track', 'ViewContent', {
    content_name: {{DL - nome_produto}},
    content_ids:  [{{DL - id_produto}}],
    content_type: 'product',
    value:    {{DL - preco}},
    currency: 'BRL'
  }, { eventID: id });
</script>
```

Gatilho: visualização de página de produto/oferta. `content_ids` é **array**, mesmo com um
item só — mandar string quebra a associação com o catálogo.

### 6.3 `lead` → `Lead`

```html
<script>
  var id = window.trk('lead', {
    user_id: {{DL - user_id}},
    user_data: {
      email:      {{DL - email}},
      phone:      {{DL - telefone}},
      first_name: {{DL - primeiro_nome}}
    },
    custom_data: {
      content_name: 'Formulário Landing Black',
      value:    50,
      currency: 'BRL'
    }
  });
  fbq('track', 'Lead', { content_name: 'Formulário Landing Black' }, { eventID: id });
</script>
```

Gatilho: envio do formulário (evento do dataLayer, não "clique no botão" — botão clicado
não é lead gerado).

O `value` no lead é opcional, mas se você tem noção de quanto vale um lead, mandar ajuda a
Meta a otimizar por valor. Use um número que faça sentido (ticket médio × taxa de
conversão), não um chute.

### 6.4 `sign_up` → `CompleteRegistration`

```html
<script>
  var id = window.trk('sign_up', {
    user_id: {{DL - user_id}},
    user_data: {
      email: {{DL - email}},
      phone: {{DL - telefone}}
    },
    custom_data: {
      content_name: 'Cadastro',
      status: 'completed',
      value: 0,
      currency: 'BRL'
    }
  });
  // ATENÇÃO: o nome na Meta é CompleteRegistration, não "sign_up" nem "Lead".
  fbq('track', 'CompleteRegistration', { status: 'completed' }, { eventID: id });
</script>
```

### 6.5 `add_to_cart` → `AddToCart`

```html
<script>
  var id = window.trk('add_to_cart', {
    user_id: {{DL - user_id}},
    custom_data: {
      content_ids:  [{{DL - id_produto}}],
      content_type: 'product',
      contents: [{ id: {{DL - id_produto}}, quantity: 1 }],
      value:    {{DL - preco}},
      currency: 'BRL'
    }
  });
  fbq('track', 'AddToCart', {
    content_ids: [{{DL - id_produto}}],
    content_type: 'product',
    value: {{DL - preco}},
    currency: 'BRL'
  }, { eventID: id });
</script>
```

### 6.6 `begin_checkout` → `InitiateCheckout`

```html
<script>
  var id = window.trk('begin_checkout', {
    user_id: {{DL - user_id}},
    user_data: {
      email: {{DL - email}},
      phone: {{DL - telefone}}
    },
    custom_data: {
      value:     {{DL - valor_carrinho}},
      currency:  'BRL',
      num_items: {{DL - qtd_itens}},
      content_ids: {{DL - ids_produtos}},
      content_type: 'product'
    }
  });
  fbq('track', 'InitiateCheckout', {
    value: {{DL - valor_carrinho}},
    currency: 'BRL',
    num_items: {{DL - qtd_itens}}
  }, { eventID: id });
</script>
```

Este é o momento em que o e-mail costuma aparecer pela primeira vez — capture aqui, não só
no `purchase`.

### 6.7 `purchase` → `Purchase`

```html
<script>
  var id = window.trk('purchase', {
    user_id: {{DL - user_id}},
    user_data: {
      email:      {{DL - email}},
      phone:      {{DL - telefone}},
      first_name: {{DL - primeiro_nome}},
      last_name:  {{DL - sobrenome}}
    },
    custom_data: {
      value:    {{DL - valor_total}},
      currency: 'BRL',
      order_id: {{DL - order_id}},        // ← gera event_id "purchase-8812"
      content_ids:  {{DL - ids_produtos}},
      content_type: 'product',
      contents:     {{DL - contents}},
      num_items:    {{DL - qtd_itens}}
    }
  });
  fbq('track', 'Purchase', {
    value: {{DL - valor_total}},
    currency: 'BRL',
    content_ids: {{DL - ids_produtos}},
    content_type: 'product'
  }, { eventID: id });
</script>
```

**Nunca omita o `order_id`.** É ele que transforma o `event_id` em determinístico e casa a
compra do navegador com a do webhook (seção 3.4).

### 6.8 `abandoned_checkout` → `AbandonedCheckout`

Este **não** se dispara no navegador — por definição, o visitante foi embora. Quem dispara
é o backend, depois do tempo limite que você definir (30 min, 1h, o que fizer sentido):

```bash
POST https://traker.codigovencedor.com/e/x7k2v9ab
Authorization: Bearer <ingest_token>
{
  "event_name": "abandoned_checkout",
  "user_id": "player-4821",
  "user_data": { "email": "cliente@exemplo.com" },
  "custom_data": { "value": 199.90, "currency": "BRL", "order_id": "8812-abandonado" }
}
```

> `AbandonedCheckout` **não é um evento padrão da Meta**. Ela aceita e registra como evento
> personalizado — serve muito bem para montar público de remarketing, mas **não use como
> evento de otimização de campanha**: eventos personalizados têm menos sinal e a entrega
> costuma piorar. Otimize por `Purchase` ou `InitiateCheckout`.

### 6.9 Referência rápida do `custom_data`

| Campo | Tipo | Onde usar |
|---|---|---|
| `value` | número | Todos os eventos com valor monetário |
| `currency` | texto (`'BRL'`) | Obrigatório sempre que houver `value` |
| `order_id` | texto | `purchase` — **sempre** |
| `content_ids` | array | `view_content`, `add_to_cart`, `begin_checkout`, `purchase` |
| `content_type` | `'product'` | Junto com `content_ids` |
| `contents` | array de `{id, quantity}` | Quando quiser detalhar itens |
| `content_name` | texto | Nome legível da oferta/produto |
| `content_category` | texto | Categoria |
| `num_items` | número | Quantidade total de itens |
| `search_string` | texto | Evento de busca |
| `status` | texto | `sign_up` |
| `predicted_ltv` | número | Valor previsto do cliente |

Campos fora dessa lista o servidor ignora ao montar o payload da Meta — ela só aceita esses.
Isso é proteção: campo desconhecido faria a Meta rejeitar o evento inteiro.

---

## 7. Consent Mode v2

O Servidor Traker aplica o consentimento **no servidor**. A tag do navegador só transporta o
estado; quem decide o que sai do payload é o servidor. A vantagem é ter uma regra única e
auditável, em vez de lógica espalhada por tags do GTM.

### 7.1 Como mandar o estado

Duas formas. A global é a mais prática:

```html
<!-- Numa tag que dispare DEPOIS do seu banner de cookies -->
<script>
  window.trkConsent = {
    ad_storage:         'granted',
    analytics_storage:  'granted',
    ad_user_data:       'granted',
    ad_personalization: 'granted'
  };
</script>
```

Toda chamada a `window.trk()` sem `consent_state` explícito herda esse objeto. Ou, por
evento:

```js
window.trk('purchase', {
  custom_data: { /* ... */ },
  consent_state: { ad_user_data: 'granted', ad_personalization: 'denied' }
});
```

Aceita `'granted'`/`'denied'`, e também `true`/`false` (convertidos automaticamente).

### 7.2 O que o servidor faz com cada combinação

| `ad_user_data` | `ad_personalization` | O que acontece |
|---|---|---|
| `granted` | `granted` | Evento completo. PII hasheada vai normalmente. |
| `granted` | `denied` | Evento completo **+** `data_processing_options: ["LDU"]` (Limited Data Use). A Meta recebe e conta, mas não usa para personalizar anúncio. |
| `denied` | `granted` | **PII removida**: `email`, `phone`, `first_name`, `last_name`, `external_id`, `city`, `state`, `zip`, `country`. O evento continua indo, com `fbp`/`fbc`/IP/UA. EMQ despenca, mas a conversão é contada. |
| `denied` | `denied` | PII removida **e** LDU. O mínimo. |
| ausente | ausente | Depende de `STRICT_CONSENT` — ver abaixo. |

### 7.3 Consentimento ausente e a variável `STRICT_CONSENT`

Quando o evento chega **sem** `consent_state` (ou sem o campo `ad_user_data` dentro dele),
o servidor decide pela variável de ambiente `STRICT_CONSENT`:

| `STRICT_CONSENT` | Comportamento com consentimento ausente |
|---|---|
| `false` — **padrão** | O evento segue **completo, com PII**. A ausência é tratada como "o site ainda não manda esse sinal", não como negação. |
| `true` | A ausência é tratada como **negação**: a PII é removida, igual a `ad_user_data: 'denied'`. |

O padrão é `false` de propósito: a maioria dos sites ainda não envia `consent_state`, e
cortar a PII em silêncio inutilizaria o tracking sem ninguém perceber — você veria EMQ no
chão sem nenhuma pista do motivo. De qualquer forma o servidor registra a ocorrência com o
flag `consentMissing` no log do evento, então a escolha fica auditável.

> **Como decidir.** Se o site **já tem um CMP/banner de consentimento configurado**, ligue
> `STRICT_CONSENT=true`: nesse cenário, evento sem sinal é bug de implementação, e o
> comportamento conservador é o mais defensável sob LGPD/GDPR. Se o site **ainda não tem**
> banner, deixe em `false` — mas trate isso como pendência, não como configuração final.
>
> Em qualquer um dos dois casos, a boa prática não muda: **mande o estado explicitamente em
> toda chamada** (seção 7.1) e não dependa do default. A variável se configura no arquivo
> de ambiente do servidor — ver `06-operacao-runbook.md`, que também cobre retenção e
> expurgo de dados.

### 7.4 `ad_storage` e `analytics_storage`

Quando **os dois** estão `denied`, destinos de postback interno são bloqueados. Meta e
Google continuam recebendo, com as regras das tabelas acima.

---

## 8. Checklist de validação antes de ligar em produção

Faça na ordem. Cada passo depende do anterior.

### 8.1 A tag carregou

- [ ] Console do navegador: `typeof window.trk` responde `"function"`.
- [ ] Aba Network do DevTools: aparece `s/x7k2v9ab.js` e `t/x7k2v9ab.js` com status `200`.
- [ ] Nenhum erro vermelho de CORS no console.

### 8.2 O evento chega ao servidor

- [ ] Dispare um evento no site. Na aba Network, o `POST` para `/e/x7k2v9ab` responde `202`.
- [ ] Painel → aba **Logs**: o evento aparece com `event_name` e `event_id` corretos.
- [ ] O status por destino mostra `success` para a Meta (pode levar alguns segundos — o
      worker processa em segundo plano).

### 8.3 Test Events do Events Manager

- [ ] Events Manager → seu Pixel → **Testar eventos**. Copie o código (`TESTxxxxx`).
- [ ] Cole no painel, aba **Meta**, campo **Test Event Code**. Salve.
- [ ] Dispare o evento no site.
- [ ] Na tela de Test Events devem aparecer **duas linhas** do mesmo evento: uma
      `Navegador` e uma `Servidor`.
- [ ] A Meta deve marcar explicitamente como **"Desduplicado"** / *Deduplicated*. Se ela
      mostrar dois eventos separados sem essa marca, **volte para a seção 3** — algo está
      desalinhado.
- [ ] Clique no evento do servidor e confira os parâmetros recebidos.
- [ ] **Remova o Test Event Code do painel antes de ir para produção.** Se ficar, os eventos
      continuam indo para a fila de teste e **não contam** nas campanhas. Este é um dos
      erros mais caros da lista.

### 8.4 Confirmar que `fbp`/`fbc` não estão hasheados

No detalhe do evento no Test Events, os campos devem estar assim:

```
✅ CORRETO
fbp: fb.1.1699999999999.1234567890
fbc: fb.1.1699999999999.IwAR2xK9...

❌ ERRADO (alguém hasheou)
fbp: 8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4
fbc: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

O servidor **nunca** hasheia esses dois campos. Se aparecerem como hash de 64 caracteres, o
valor chegou já hasheado — alguém está hasheando antes de mandar, provavelmente numa tag do
GTM. Remova esse hash. A Meta não avisa e o match simplesmente não acontece.

Aproveite e confira o oposto: `em` e `ph` **devem** estar hasheados (64 caracteres hex). Se
aparecer e-mail legível, algo muito errado está acontecendo — abra um chamado.

### 8.5 EMQ e cobertura

- [ ] Painel → **Dashboard** → bloco de cobertura de campos de match. Compare com as metas
      da seção 4.4.
- [ ] Events Manager → Pixel → coluna **Qualidade da correspondência de eventos**. Espere
      24–48h de volume real antes de tirar conclusão; com poucos eventos o número oscila
      muito.

### 8.6 Ponte de identidade

- [ ] Entre no site por uma URL com `?fbclid=teste123`.
- [ ] Faça login (ou o que quer que coloque o `user_id` no dataLayer).
- [ ] Network: aparece um `POST` para `/c/x7k2v9ab` com status `202` e corpo
      `{"status":"stored"}`.
- [ ] Dispare o webhook de teste no painel (aba Instalação → "Disparar Webhook de Teste")
      com o mesmo `user_id`.
- [ ] Nos Logs, o evento do webhook deve sair **com `fbc` preenchido**, mesmo você não tendo
      mandado `fbc` nenhum. Se saiu, a ponte funciona.

### 8.7 Consent

- [ ] Recuse os cookies no banner e dispare um evento.
- [ ] Nos Logs, o evento deve estar **sem** `email`/`phone` e, se `ad_personalization` for
      `denied`, **com** `data_processing_options: ["LDU"]`.

---

## 9. Erros comuns e como diagnosticar

### 9.1 Conversão contando em dobro no Gerenciador de Anúncios

**Sintomas:** ROAS bom demais, número de compras ~2× o do sistema de vendas.

**Diagnóstico, em ordem:**

1. Events Manager → Test Events. Os dois eventos aparecem marcados como "Desduplicado"?
   Se não:
2. Compare os **nomes**. `fbq('track','ALGO')` tem que ser exatamente o valor da coluna
   direita da tabela da seção 3.3. O erro clássico: site manda `sign_up`, servidor traduz
   para `CompleteRegistration`, e o pixel dispara `Lead`.
3. Compare os `event_id`. No console: `var id = window.trk('purchase', {...}); console.log(id)`.
   Confira que é esse mesmo valor que vai no `eventID` do `fbq`.
4. Confirme que é `eventID` (I-D maiúsculos) e que está no **terceiro** argumento do `fbq`.
5. Se a duplicação é navegador × webhook: confira que o `order_id` é a **mesma string** dos
   dois lados (seção 3.4).

### 9.2 `window.trk is not a function`

A tag de captura não carregou, ou carregou depois do evento.

- Confira o slug na URL do script (copie de novo da aba Instalação).
- Abra `https://traker.codigovencedor.com/g/x7k2v9ab.js` direto no navegador. Se vier
  `/* projeto não encontrado */`, o slug está errado ou o projeto está inativo.
- Confira a prioridade da tag (seção 2.3) e que ela **não** tem `async`.
- Se o evento dispara muito cedo (antes do `DOMContentLoaded`), mude o gatilho da tag de
  captura para uma prioridade ainda maior, ou proteja a chamada:
  `if (window.trk) { var id = window.trk(...); }`.

### 9.3 EMQ baixo (abaixo de 6)

Vá ao Dashboard do painel e veja **qual campo** está faltando:

| Sintoma na cobertura | Causa provável | Correção |
|---|---|---|
| `email` baixo | O dataLayer não tem e-mail na hora do evento | Peça ao dev para incluir; capture já no `begin_checkout` |
| `fbc` baixo em campanha de Meta | Coletor disparando tarde demais | Prioridade `100` e `All Pages`; ver 2.1 |
| `external_id` baixo | Falta `user_id` no dataLayer | Ver seção 5.3 — talvez já exista com outro nome |
| `client_ip_address` vazio | `TRUST_PROXY` desligado ou proxy mal configurado | Ver `06-operacao-runbook.md` |
| Tudo alto, EMQ ainda baixo | Advanced Matching do Pixel vazio | Ver seção 4.3 |

### 9.4 Eventos somem: nada chega no Events Manager

1. O **Test Event Code** ficou preenchido no painel? Eventos com test code **não contam** —
   é a causa mais comum e a mais frustrante. Limpe o campo.
2. Painel → Logs. O evento aparece? Se **não**, o problema é entre o navegador e o servidor
   (rede/CORS/slug). Se **sim**, com erro no destino, leia a mensagem: token expirado, pixel
   ID errado, permissão faltando.
3. Access Token da CAPI expirado ou gerado com o usuário errado. Gere um novo em Events
   Manager → Configurações → Conversions API e cole na aba Meta.
4. Fila travada: `06-operacao-runbook.md`, seção da fila de entregas.

### 9.5 `fbp`/`fbc` hasheados no payload

Alguém está hasheando antes de mandar. Procure em: tags customizadas do GTM, alguma
"otimização de privacidade" adicionada por outro fornecedor, ou código do próprio site.
O servidor **nunca** faz isso. Ver 8.4.

### 9.6 `client_ip_address` chegando como IP interno (`172.x`, `10.x`, `127.0.0.1`)

O servidor está atrás de proxy e não confia no `X-Forwarded-For`. Isso é uma configuração de
infraestrutura, não de tagueamento: ver `03-dns-tls-subdominio.md` (Caddy) e
`06-operacao-runbook.md` (variável `TRUST_PROXY`). Enquanto não corrigir, você perde um
campo de match em 100% dos eventos.

### 9.7 A ponte de identidade não guarda nada

- O `POST` para `/c/x7k2v9ab` acontece? Se não aparece na aba Network, o coletor não achou
  `user_id` no dataLayer. Rode no console: `dataLayer.filter(function(e){ return e.user_id || e.player_id || e.codigo; })`.
- Aparece, mas com `{"status":"ignored","reason":"sem user_id"}`? O `user_id` está numa
  chave fora da lista da seção 5.3.
- Aconteceu uma vez e não acontece mais? **É o comportamento correto** — uma gravação por
  sessão por usuário. Teste em aba anônima.

### 9.8 Evento com horário errado / rejeitado por antiguidade

A Meta rejeita eventos com mais de 7 dias. O servidor protege: `event_time` fora da janela
(ou no futuro) é substituído pela hora do servidor. Se o seu backend reprocessa conversões
antigas em lote, saiba que elas vão chegar com a data de hoje — a conversão conta, mas a
atribuição no relatório fica no dia errado.

### 9.9 Adblocker bloqueando

O caminho aleatório (`/e/x7k2v9ab`) já resolve a maior parte, e o script é servido pelo
domínio do próprio cliente. Se mesmo assim uma blocklist aprender o caminho, o painel
permite **regenerar o slug** do projeto — as URLs mudam e você reinstala a tag com o
slug novo. Ver `06-operacao-runbook.md`.

---

## 10. Resumo de uma página

1. Uma tag no GTM: `/g/…js` como `<script src>` em HTML personalizado, All Pages,
   prioridade 100. Ela já traz coletor, `window.trk` e o `page_view`.
2. Toda conversão: `var id = window.trk('nome_do_evento', {...})` e depois
   `fbq('track', 'NomeDaMeta', {...}, { eventID: id })`.
3. O nome no `fbq` é o **traduzido** (`purchase` → `Purchase`, `sign_up` →
   `CompleteRegistration`, `begin_checkout` → `InitiateCheckout`).
4. `purchase` sempre com `order_id` — é o que casa navegador e webhook.
5. E-mail e telefone crus no `user_data`; o servidor normaliza e hasheia.
6. `user_id` no dataLayer liga a ponte de identidade e salva a conversão de backend.
7. Teste com Test Events, confirme o selo "Desduplicado", **e apague o test code depois**.

Para a parte de Google Ads, siga em `05-tagueamento-google-ads.md`. Para operação do dia a
dia, `06-operacao-runbook.md`.
