---
title: Tagueamento Google Ads — GA4 Measurement Protocol e Google Ads API
tags: [tagueamento, google-ads, ga4, measurement-protocol, gclid, enhanced-conversions, oauth, servidor-traker]
created: 2026-08-12
updated: 2026-08-12
---

# Tagueamento Google Ads — GA4 Measurement Protocol e Google Ads API

Como fazer as conversões do Servidor Traker chegarem ao Google Ads. Este documento é o par
do `04-tagueamento-meta.md` e assume que você já leu aquele — a instalação das tags no GTM
Web (coletor + tag de captura) é **exatamente a mesma**, não se faz nada a mais no GTM para
o Google.

**O que muda:** o destino, a forma como a conversão vira conversão no Ads, o prazo, e a
escolha entre duas rotas que existem de verdade e servem a cenários diferentes.

---

## 1. As duas rotas — qual escolher

Na aba **Google** do painel existe um seletor de **Rota**. As duas opções estão
implementadas e funcionam; elas se diferenciam por **esforço de habilitação** e por **o que
conseguem carregar**.

### `ga4_mp` — GA4 Measurement Protocol

O servidor envia o evento para o **GA4** pelo Measurement Protocol. O evento vira conversão
no Google Ads pela **importação de conversões do GA4** — um recurso nativo do Ads, ligado
uma vez e pronto.

- Precisa de: **Measurement ID** (`G-XXXXXXX`) e **API Secret**. Dois campos, cinco minutos.
- A conversão passa pelo GA4 antes de chegar ao Ads.
- **Não carrega o `gclid`** — o Measurement Protocol não tem campo para click id. A
  atribuição depende do que o GA4 já sabe sobre aquele navegador.

### `google_ads` — Google Ads API / Enhanced Conversions

O servidor faz OAuth2 e chama o `ConversionUploadService.UploadClickConversions` da
**Google Ads API**, entregando a conversão **direto na conta de anúncios**, sem passar pelo
GA4.

- Precisa de: **developer token aprovado**, OAuth2 (client id + secret + refresh token),
  `customer_id` e o *resource name* de uma **conversion action** por evento.
- **Carrega o `gclid`** (ou `gbraid`/`wbraid`) explicitamente — é o caminho principal de
  identificação do clique.
- Enhanced Conversions com e-mail e telefone hasheados, mais valor, moeda e `orderId`.

### Comparação direta

| | `ga4_mp` | `google_ads` |
|---|---|---|
| **Status** | ✅ implementado | ✅ implementado |
| **Esforço para ligar** | Baixo — 2 campos no painel | **Alto** — aprovação do developer token pelo Google |
| **Bloqueio externo** | Nenhum | **Developer token** precisa de análise humana do Google (dias a semanas, pode ser recusado) |
| **`gclid`/`gbraid`/`wbraid`** | ❌ não trafega | ✅ vai explicitamente |
| **Conversão de backend (sem navegador)** | Fraca | ✅ **Forte** — é o cenário que essa rota resolve |
| **Enhanced Conversions** | E-mail + telefone hasheados (via GA4) | E-mail + telefone hasheados (`userIdentifiers`) |
| **Valor / moeda / ID do pedido** | `value`, `currency`, params livres | `conversionValue`, `currencyCode`, `orderId` |
| **Latência até aparecer no Ads** | até 24h | horas |
| **Também alimenta o GA4** | ✅ sim | ❌ não — vai direto ao Ads |
| **Erro fica visível?** | ⚠️ parcialmente — o MP responde `204` para quase tudo | ✅ sim — erro explícito, inclusive `partialFailureError` |

### A recomendação

**Comece pela `ga4_mp`.** Ela coloca a operação no ar hoje, sem depender de aprovação de
ninguém, e alimenta o GA4 de quebra. Para a maioria dos projetos ela é suficiente.

**Migre (ou some) a `google_ads` quando** a conversão que importa acontece **fora do
navegador** — venda fechada por WhatsApp, PIX confirmado horas depois, aprovação manual de
cadastro. É exatamente aí que a `ga4_mp` fica fraca (seção 5.3) e que o upload com `gclid`
explícito faz diferença de verdade no relatório.

Comece o pedido de **developer token em paralelo**, no dia 1: como a aprovação demora e não
depende de você, quanto antes entrar na fila, melhor. Enquanto ela não sai, a `ga4_mp`
segura a operação.

> **Cada projeto tem uma rota só.** O seletor é excludente: o destino Google usa `ga4_mp`
> **ou** `google_ads`, não os dois ao mesmo tempo. Se precisar de ambos os efeitos
> (alimentar o GA4 **e** subir conversão com `gclid`), a saída hoje é manter a tag do GA4
> no navegador fazendo a parte do GA4 e apontar o Servidor Traker para `google_ads`.

---

## 2. Rota `ga4_mp` — Measurement ID e API Secret

Dois valores, dois lugares diferentes dentro do GA4. Você precisa de acesso de
**Administrador** à propriedade.

### 2.1 Measurement ID (`G-XXXXXXX`)

1. Abra o **GA4** → engrenagem **Administrador** (canto inferior esquerdo).
2. Coluna **Propriedade** → **Fluxos de dados**.
3. Clique no fluxo de dados **Web** do site (se não existir, crie um: **Adicionar fluxo →
   Web**, informe a URL e o nome).
4. No topo direito aparece o **ID da métrica** / *Measurement ID*, no formato `G-ABC1234567`.
   Copie.

> Não confunda com o **ID do fluxo** (só números, ex.: `1234567890`) nem com o antigo ID do
> Universal Analytics (`UA-...`). O que serve é o que começa com `G-`.

### 2.2 API Secret

Na **mesma tela** do fluxo de dados:

1. Role até **Configurações adicionais** → **Protocolo de medição — API secrets**.
2. Clique em **Criar**.
3. Dê um apelido: `Servidor Traker`.
4. Copie o **Valor do segredo**. É a única vez que ele aparece por inteiro.

> O API Secret é uma credencial. Ele fica **criptografado** no banco do Servidor Traker.
> Não coloque em GTM, planilha ou e-mail. Se vazar, volte nessa tela e **exclua** o secret —
> criar um novo é trivial, e o antigo para de funcionar na hora.

### 2.3 Configurar no painel

Painel → seu projeto → aba **Google**:

1. Ligue **Enviar conversões para o Google**.
2. **Rota**: `GA4 Measurement Protocol`.
3. **Measurement ID**: cole o `G-XXXXXXX`.
4. **API Secret**: cole o segredo. *(Campo em branco = mantém o atual. Ao reabrir a tela
   ele aparece vazio; isso é normal, ele está salvo e criptografado.)*
5. **Mapeamento de eventos → GA4**: já vem preenchido. Só mexa se souber por quê.
6. **Salvar Google**.

### 2.4 Mapeamento padrão de eventos

| Evento no seu site (`window.trk`) | Nome no GA4 |
|---|---|
| `page_view` | `page_view` |
| `view_content` | `view_item` |
| `sign_up` | `sign_up` |
| `lead` | `generate_lead` |
| `add_to_cart` | `add_to_cart` |
| `begin_checkout` | `begin_checkout` |
| `abandoned_checkout` | `abandoned_checkout` |
| `purchase` | `purchase` |

Só duas linhas realmente traduzem alguma coisa: `view_content` → `view_item` e `lead` →
`generate_lead`. As demais são idênticas, porque os eventos canônicos do produto já seguem a
nomenclatura do GA4.

> Esse mapeamento vale **só para a rota `ga4_mp`**. Na rota `google_ads` não existe tradução
> de nome: o que importa é o mapa de *conversion actions* (seção 4.5), e ele é consultado
> pelo **nome canônico do seu site** (`purchase`, `lead`…), não pelo nome do GA4.

> `abandoned_checkout` **não é um evento recomendado do GA4** — ele entra como evento
> personalizado. Funciona, aparece nos relatórios e dá para marcar como conversão, mas não
> ganha os relatórios prontos de e-commerce.

### 2.5 Uma coisa que o servidor resolve sozinho: o `client_id`

O GA4 exige um `client_id` em todo evento do Measurement Protocol — é o identificador do
navegador (normalmente o cookie `_ga`). O servidor resolve nesta ordem:

1. `user_data.ga_client_id` ou `custom_data.client_id`, se você mandar;
2. um `ga4ClientId` fixo configurado no projeto, se houver;
3. um pseudo-ID **estável derivado do `user_id`** — assim todos os eventos do mesmo usuário
   caem na mesma sessão lógica;
4. como último recurso, um valor aleatório.

Na prática: se o `user_id` estiver no dataLayer (o mesmo da ponte de identidade do
documento 04), a sessão do GA4 fica coerente sem você configurar nada. Se você quiser
precisão máxima de sessão, passe o cookie `_ga` real:

```js
window.trk('purchase', {
  user_id: {{DL - user_id}},
  user_data: { ga_client_id: {{Cookie - _ga}} },   // formato: GA1.1.123456789.1699999999
  custom_data: { value: 199.90, currency: 'BRL', order_id: '8812' }
});
```

Se você fizer isso, extraia só a parte `123456789.1699999999` do cookie — é o formato que o
GA4 espera. Não é obrigatório; sem ele o servidor se vira.

---

## 3. Rota `ga4_mp` — fazer o evento virar conversão no Google Ads

O evento chegou ao GA4. Agora ele precisa virar uma **conversão importada** no Ads. São
quatro etapas, todas na interface, feitas **uma vez** por conta.

### Etapa 1 — Vincular GA4 e Google Ads

1. **GA4 → Administrador → Vinculações de produtos → Vinculações do Google Ads**.
2. **Vincular** → escolha a conta do Google Ads → **Confirmar**.
3. Deixe ligado **Personalização de anúncios** e **Marcação automática**.
4. **Enviar**.

Você precisa ser Administrador na propriedade GA4 **e** ter acesso de administrador à conta
de Ads. Se o vínculo não existir, o Ads simplesmente não enxerga os eventos do GA4 — e a
mensagem de erro nesse caso é vaga o suficiente para queimar uma tarde.

### Etapa 2 — Marcar o evento como evento-chave no GA4

O Ads só oferece para importação eventos marcados como **evento-chave** (o que antigamente
se chamava "conversão" dentro do GA4).

1. **GA4 → Administrador → Eventos-chave** (ou **Dados de eventos → Eventos-chave**).
2. Se o evento já apareceu na lista (precisa ter sido recebido pelo menos uma vez), ligue a
   chavinha **Marcar como evento-chave**.
3. Se ainda não apareceu: **Criar evento-chave** e digite o nome exato — `purchase`,
   `generate_lead`, `sign_up`.

> **Dispare um evento de teste antes**, pelo botão "Enviar teste" da aba Instalação do
> painel, ou navegando no site. Eventos que o GA4 nunca recebeu não aparecem na lista.

### Etapa 3 — Importar no Google Ads

1. **Google Ads → Metas → Conversões → Ações de conversão** (menu Ferramentas, dependendo
   da versão da interface).
2. Botão **+ Nova ação de conversão**.
3. Escolha **Importar**.
4. Selecione **Google Analytics 4 properties** → **Web**.
5. **Continuar**. Aparece a lista de eventos-chave da propriedade vinculada.
6. Marque os que quer importar — normalmente `purchase` e `generate_lead`.
7. **Importar e continuar**.

### Etapa 4 — Configurar a ação de conversão importada

Clique no nome da conversão recém-importada e ajuste:

| Configuração | O que escolher | Por quê |
|---|---|---|
| **Meta** | `Compra` para `purchase`, `Envio de formulário de lead` para `generate_lead` | Define como o Ads categoriza no relatório |
| **Valor** | "Usar valores diferentes" (vem do `custom_data.value`) | Permite otimizar por ROAS em vez de por volume |
| **Contagem** | **Uma** para `purchase`/`lead`; **Todas** para `add_to_cart` | "Todas" numa compra conta cada recompra do mesmo clique |
| **Janela de conversão por clique** | 30 dias (padrão) — até 90 | Quanto tempo depois do clique a conversão ainda é atribuída |
| **Janela de visualização** | 1 dia | Conversões após ver o anúncio sem clicar |
| **Ação de conversão principal** | **Ligada** só para o evento que você **quer otimizar** | O que estiver ligado entra na coluna "Conversões" e é usado pelo lance inteligente |

> A configuração que mais estraga campanha é a **Ação de conversão principal** ligada em
> evento demais. Se `page_view`, `add_to_cart` e `purchase` estiverem todos como principais,
> o Smart Bidding otimiza para a mistura dos três e você acaba comprando `add_to_cart`
> barato. Deixe **um** evento como principal — normalmente `purchase`. Os outros ficam como
> secundários, visíveis em "Todas as conversões", e servem para diagnóstico.

---

## 4. Rota `google_ads` — configuração completa

Esta é a rota que entrega a conversão direto na conta de anúncios, com `gclid`. Ela dá mais
trabalho para ligar, e a maior parte do trabalho é **esperar o Google aprovar**.

São cinco peças. Junte todas antes de mexer no painel.

### 4.1 Developer token aprovado — comece por aqui

É o único item que **não depende de você**, então é o primeiro da fila.

1. Acesse a conta **MCC (Minha Central de Clientes)** do Google Ads. Se você não tem uma,
   crie: `ads.google.com/home/tools/manager-accounts`. O token pertence à MCC, não à conta
   de anúncios comum.
2. Na MCC: **Ferramentas → Configuração → Central de API** (*API Center*).
3. Preencha o formulário de solicitação: nome da empresa, site, para que você vai usar a
   API, se é uso interno ou ferramenta de terceiros.
4. Copie o **Developer token** que aparece.

Ele nasce no nível **Test account access** — funciona apenas em contas de teste, e chamadas
contra conta real falham. Para produção você precisa do nível **Basic**, e isso passa por
**análise humana do Google**: de dias a algumas semanas, e **pode ser recusado** se a
descrição de uso for vaga.

> Escreva a justificativa com cuidado: descreva que é uma integração server-side própria
> para upload de conversões offline da própria empresa. Solicitações genéricas ("integrar
> com a API") são a principal causa de recusa. Recusado, dá para reenviar corrigindo — mas
> você volta para o fim da fila.

### 4.2 OAuth2 — client ID e client secret

No **Google Cloud Console** (`console.cloud.google.com`), com o projeto certo selecionado:

1. **APIs e serviços → Biblioteca** → procure **Google Ads API** → **Ativar**.
2. **APIs e serviços → Tela de permissão OAuth**: preencha nome do app e e-mail de suporte.
   Escolha **Externo** se a conta não for Workspace.
3. **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**.
4. Tipo de aplicativo: **App para computador** (*Desktop app*). É o tipo que permite gerar o
   refresh token pelo Playground sem configurar URL de redirecionamento.
5. Copie o **Client ID** (`xxxxx.apps.googleusercontent.com`) e o **Client Secret**.

> ⚠️ **Publique o app.** Na tela de permissão OAuth, se o status ficar em **"Teste"**, o
> refresh token **expira em 7 dias** e a integração para de funcionar sozinha, sempre numa
> sexta-feira. Clique em **Publicar app** e confirme. Como o escopo `adwords` é sensível, o
> Google pode exibir um aviso de app não verificado no consentimento — para uso interno com
> a sua própria conta, isso é aceitável e não bloqueia.

### 4.3 Refresh token

O refresh token é o que permite ao servidor renovar o acesso sozinho, sem ninguém fazer
login. Você gera **uma vez**.

**Pelo OAuth 2.0 Playground** (o caminho mais simples):

1. Abra `developers.google.com/oauthplayground`.
2. Engrenagem ⚙️ no canto superior direito → marque **Use your own OAuth credentials**.
3. Cole o **Client ID** e o **Client Secret** da etapa anterior. Feche o painel.
4. No **Step 1**, no campo "Input your own scopes", digite exatamente:
   ```
   https://www.googleapis.com/auth/adwords
   ```
5. **Authorize APIs** → faça login **com a conta Google que tem acesso ao Google Ads** (não
   com uma conta pessoal aleatória — o token herda as permissões de quem autorizou).
6. Aceite o consentimento.
7. No **Step 2**, clique em **Exchange authorization code for tokens**.
8. Copie o **Refresh token** (começa com `1//`).

> Se o Playground reclamar de `redirect_uri_mismatch`, adicione
> `https://developers.google.com/oauthplayground` como URI de redirecionamento autorizada no
> seu client OAuth do Cloud Console e tente de novo.

O refresh token não expira, **desde que**: o app OAuth esteja publicado (4.2), a senha da
conta não mude, e o acesso não seja revogado manualmente. Se ele morrer, os Logs vão mostrar
`OAuth falhou:` com o motivo, e a correção é refazer esta seção.

### 4.4 Customer ID

É o número da conta do Google Ads, no canto superior direito da interface: `123-456-7890`.

- **Customer ID**: a conta que **recebe as conversões**. Pode colar com ou sem traços — o
  servidor remove tudo que não for dígito.
- **Login Customer ID**: só se o acesso for via MCC. É o ID **da MCC**, não da conta filha.
  Se você acessa a conta diretamente, deixe em branco.

### 4.5 Conversion actions — o resource name

Esta é a parte que mais confunde. A Google Ads API não aceita "nome do evento"; ela exige o
**resource name** de uma ação de conversão que já exista na conta.

**Primeiro, crie a ação de conversão do tipo certo:**

1. **Google Ads → Metas → Conversões → Ações de conversão → + Nova ação de conversão**.
2. Escolha **Importar** → **Importações manuais usando a API, cliques ou chamadas** (*Manual
   import using API, clicks or calls*) → **Rastrear conversões de cliques**.
3. Nomeie (`Compra — Servidor Traker`), defina meta, valor e janelas como na tabela da
   Etapa 4 da seção 3.
4. Salve.

> Precisa ser desse tipo. Uma ação de conversão criada como "Site" (tag) **não aceita**
> upload pela API — o retorno é um erro de `INVALID_CONVERSION_ACTION`.

**Depois, descubra o resource name.** Ele tem este formato:

```
customers/<CUSTOMER_ID_SEM_TRACOS>/conversionActions/<ID_DA_ACAO>
```

O jeito mais rápido de achar o `<ID_DA_ACAO>`: abra a ação de conversão na interface e olhe
a **URL do navegador**. Ela contém `ctId=` seguido de um número:

```
https://ads.google.com/aw/conversions/detail?ctId=987654321&ocid=...
                                                   ↑ este número
```

Então, para a conta `123-456-7890` e a ação `987654321`:

```
customers/1234567890/conversionActions/987654321
```

**Por fim, preencha o mapa no painel.** Campo **Conversion Actions (JSON)**, na aba Google:

```json
{
  "purchase": "customers/1234567890/conversionActions/987654321",
  "lead":     "customers/1234567890/conversionActions/987654322",
  "sign_up":  "customers/1234567890/conversionActions/987654323",
  "default":  "customers/1234567890/conversionActions/987654321"
}
```

Regras do mapa:

- A chave é o **nome canônico do evento no seu site** — `purchase`, `lead`, `sign_up` — o
  mesmo que você passa em `window.trk()`. **Não** é o nome do GA4 nem o da Meta.
- `"default"` é o coringa: evento sem entrada própria cai nele. Útil para começar com uma
  linha só.
- Evento sem entrada e sem `default` retorna erro não-retentável listando
  `conversion_action` como faltante — o evento não é enviado.

### 4.6 Preencher no painel

Painel → aba **Google** → **Rota**: `Google Ads API — Enhanced Conversions`. Aparecem os
campos:

| Campo | Valor | De onde veio |
|---|---|---|
| **Customer ID** | `123-456-7890` | 4.4 |
| **Login Customer ID** | ID da MCC, ou vazio | 4.4 |
| **OAuth Client ID** | `xxxxx.apps.googleusercontent.com` | 4.2 |
| **OAuth Client Secret** | o secret | 4.2 |
| **Refresh Token** | `1//...` | 4.3 |
| **Developer Token** | o token da MCC | 4.1 |
| **Conversion Actions (JSON)** | o mapa | 4.5 |

Os quatro segredos (client secret, refresh token, developer token, API secret) ficam
**criptografados** no banco e voltam vazios ao reabrir a tela — em branco significa "mantém
o atual". Salve e vá para a validação (seção 7.4).

### 4.7 O que o servidor faz com esses dados

Para cada evento, na rota `google_ads`:

1. Troca o refresh token por um **access token** no `oauth2.googleapis.com/token`, com
   **cache de ~1h** (renovado com 1 minuto de folga). Ou seja: não é uma chamada de OAuth
   por evento, é uma por hora.
2. Monta a conversão:
   - `conversionAction`: do mapa, pelo nome do evento (com fallback `default`);
   - `conversionDateTime`: no formato exigido, `yyyy-mm-dd hh:mm:ss+00:00` em UTC;
   - `conversionValue` + `currencyCode`: de `custom_data.value` / `custom_data.currency`
     (moeda padrão `BRL` quando há valor e não há moeda);
   - `orderId`: de `custom_data.order_id`;
   - **identificação do clique, nesta ordem de preferência**: `gclid`, senão `gbraid`,
     senão `wbraid`;
   - `userIdentifiers`: `hashedEmail` e `hashedPhoneNumber` em SHA-256.
3. `POST` em
   `https://googleads.googleapis.com/v17/customers/<id>:uploadClickConversions`, com
   `developer-token` e (se houver) `login-customer-id` nos cabeçalhos.
4. Envia com `partialFailure: true` e **trata `partialFailureError` como falha**, mesmo com
   HTTP `200`. Isso é deliberado: sem isso, uma conversão rejeitada apareceria como sucesso
   nos Logs e você só descobriria o problema no fim do mês.

A versão da API é **`v17`**, configurável pela variável de ambiente
`GOOGLE_ADS_API_VERSION` — o Google descontinua versões periodicamente, e dá para atualizar
sem mexer no código. Ver `06-operacao-runbook.md`.

Faltando qualquer credencial, o servidor **não tenta**: devolve erro não-retentável dizendo
exatamente o que falta, por exemplo:

```
Google Ads não configurado: faltam refresh_token, conversion_action
```

---

## 5. `gclid`, `gbraid` e `wbraid`

### 5.1 O que são

| Parâmetro | Quando aparece |
|---|---|
| `gclid` | Clique padrão do Google Ads (Search, Display, a maioria dos casos) |
| `gbraid` | Tráfego de **iOS** com o usuário sem permissão de rastreamento (ATT). Substitui o `gclid` |
| `wbraid` | Também iOS/web, em cenários onde o Google não pode usar identificador de usuário |

Os dois últimos existem por causa das restrições de privacidade da Apple. Se você só
capturar `gclid`, perde uma fatia relevante do tráfego de iOS — e no Brasil, em nichos de
ticket alto, isso é caro. O Servidor Traker captura os três.

### 5.2 Como o Servidor Traker captura

O **coletor** (`/s/x7k2v9ab.js`, instalado no All Pages conforme o documento 04) captura os
três da URL de entrada e guarda em `localStorage` de forma *sticky*:

```
tk_gclid, tk_gbraid, tk_wbraid
```

A **tag de captura** (`window.trk`) também lê o cookie `_gcl_aw` (o cookie da marcação
automática do Google) e o usa como `gclid` quando disponível.

Quando o coletor encontra um `user_id` no dataLayer, ele manda os três para o servidor,
amarrados àquele usuário. É a **ponte de identidade** — a mesma que serve à Meta.

> **Sticky importa muito aqui.** O `gclid` aparece **uma única vez**, na URL de entrada. Se
> o visitante clica no anúncio, navega três páginas e só converte na quarta, sem
> armazenamento persistente o `gclid` já se perdeu. Por isso o coletor tem que estar em
> **All Pages com prioridade alta**.

### 5.3 O que acontece com a conversão de backend — depende da rota

Este é o ponto onde as duas rotas divergem de verdade, e é o que deve guiar a sua escolha.

Em qualquer uma delas, o servidor **captura e guarda** `gclid`/`gbraid`/`wbraid`
corretamente. Quando a conversão chega pelo webhook do backend, ele completa o evento com
esses valores pela ponte de identidade — exatamente como faz com `fbc`/`fbp` para a Meta.
A diferença está no que cada destino **consegue receber**.

**Na rota `ga4_mp`:** o Measurement Protocol **não tem campo para click id**. O payload
aceita `client_id`, `user_id`, `events[].params` e `user_data` com e-mail/telefone hasheados
— e nada mais. O `gclid` guardado fica no banco e não trafega. A atribuição depende do
`client_id` e do que o GA4 já registrou naquele navegador:

| Cenário | Atribuição com `ga4_mp` |
|---|---|
| Conversão no **navegador**, GA4 web tag instalada normalmente | ✅ Boa — o GA4 já sabe a sessão e o `gclid` pela marcação automática |
| Conversão pelo **webhook**, com `user_id` que o GA4 já viu | ⚠️ Parcial — o `client_id` derivado amarra ao mesmo usuário, mas é mais fraco que um evento web |
| Conversão pelo **webhook**, usuário que nunca navegou identificado | ❌ Fraca — vira sessão nova, provavelmente "direto" |

Por isso, **usando `ga4_mp`, mantenha o GA4 do navegador funcionando normalmente** (tag de
configuração do GA4 no GTM Web, marcação automática ligada no Ads). O Servidor Traker
complementa — garante o registro mesmo com adblocker e leva o valor correto — mas não
substitui a coleta web para fins de atribuição.

**Na rota `google_ads`:** o `gclid` **vai explicitamente na conversão**, e é o caminho
principal de identificação. A ordem é `gclid` → `gbraid` → `wbraid`; o primeiro que existir
é usado. Isso muda o quadro:

| Cenário | Atribuição com `google_ads` |
|---|---|
| Conversão no **navegador** | ✅ Boa |
| Conversão pelo **webhook**, com `gclid` guardado pela ponte | ✅ **Boa** — é o cenário para o qual a rota existe |
| Conversão pelo **webhook**, sem nenhum click id | ⚠️ Cai para `userIdentifiers` (e-mail/telefone) — Enhanced Conversions, mais fraco que click id, mas ainda funciona |

Resumindo em uma frase: **se a conversão que paga a conta acontece longe do navegador, a
rota `google_ads` existe para esse caso e é ela que você quer.**

> **Enquanto o developer token não sai**, e a venda é 100% offline (fechada por telefone ou
> WhatsApp, sem página de obrigado), o caminho intermediário é o **upload manual de
> conversões offline** no Google Ads, com o `gclid` numa planilha. O painel guarda os
> `gclid` na identidade de cada `user_id`. É trabalho manual, mas tira a operação do zero
> até a API liberar.

---

## 6. Enhanced Conversions — o que vai em cada rota

### 6.1 Rota `ga4_mp`

O payload do Measurement Protocol inclui um bloco `user_data` quando há e-mail ou telefone
no evento:

```json
{
  "client_id": "123456789.1699999999",
  "user_id": "player-4821",
  "timestamp_micros": 1699999999000000,
  "non_personalized_ads": false,
  "user_data": {
    "sha256_email_address": ["8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4"],
    "sha256_phone_number":  ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"]
  },
  "events": [{
    "name": "purchase",
    "params": {
      "value": 199.90,
      "currency": "BRL",
      "order_id": "8812",
      "engagement_time_msec": 100,
      "page_location": "https://site.com/obrigado"
    }
  }]
}
```

### 6.2 Rota `google_ads`

A conversão enviada ao `UploadClickConversions`:

```json
{
  "conversions": [{
    "conversionAction": "customers/1234567890/conversionActions/987654321",
    "conversionDateTime": "2026-08-12 14:32:07+00:00",
    "conversionValue": 199.90,
    "currencyCode": "BRL",
    "orderId": "8812",
    "gclid": "Cj0KCQjw...",
    "userIdentifiers": [
      { "hashedEmail": "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4" },
      { "hashedPhoneNumber": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }
    ]
  }],
  "partialFailure": true
}
```

### 6.3 Normalização — igual nas duas rotas e igual à Meta

- **e-mail**: `trim` + minúsculas, depois SHA-256;
- **telefone**: só dígitos, zeros à esquerda removidos, DDI `55` acrescentado quando o
  número tem 10 ou 11 dígitos, depois SHA-256;
- valor já hasheado (64 caracteres hex) não é hasheado de novo;
- você manda **cru** — o servidor faz a normalização certa.

### 6.4 O que nenhuma das duas rotas faz hoje

| Recurso | `ga4_mp` | `google_ads` |
|---|---|---|
| E-mail hasheado | ✅ | ✅ |
| Telefone hasheado | ✅ | ✅ |
| `gclid`/`gbraid`/`wbraid` | ❌ | ✅ |
| Valor, moeda, ID do pedido | ✅ (como params) | ✅ (`conversionValue`, `currencyCode`, `orderId`) |
| Nome, sobrenome, endereço, CEP hasheados | ❌ | ❌ — a API aceita, o servidor ainda não envia |
| **Ajuste de conversão** (estorno, mudança de valor) | ❌ | ❌ — exigiria o `ConversionAdjustmentUploadService`, não implementado |

Ou seja: se uma venda é cancelada e você precisa **retirar** a conversão do relatório do
Ads, hoje isso é manual, na interface. Não há caminho automático em nenhuma das rotas.

### 6.5 Ligar o Enhanced Conversions no lado do Google

Mesmo com os dados chegando, o recurso precisa estar habilitado:

1. **Google Ads → Metas → Conversões → Configurações** → **Conversões otimizadas** → aceite
   os termos de serviço. Vale para as duas rotas.
2. Se estiver na rota `ga4_mp`: **GA4 → Administrador → Configurações de dados → Coleta de
   dados** → confirme que **Coleta de dados fornecidos pelo usuário** está ativada. Sem
   isso o GA4 descarta o `user_data` silenciosamente.

---

## 7. Validação

### 7.1 O aviso que vale para a rota `ga4_mp`

> ⚠️ **O Measurement Protocol do GA4 não valida o payload.** Ele responde **`204 No
> Content`** para praticamente tudo — inclusive para um evento com nome inválido, parâmetro
> errado ou API Secret de outra propriedade. **Erro de schema passa em silêncio.** Nos Logs
> do painel você vai ver `success`, e nada vai aparecer no GA4.

Na rota `google_ads` isso **não** acontece: o erro é explícito, com mensagem da própria
API, e até o `partialFailureError` (que vem dentro de um HTTP 200) é tratado como falha.
Nesse quesito, a rota mais difícil de ligar é a mais fácil de depurar.

### 7.2 Endpoint de debug do Measurement Protocol (rota `ga4_mp`)

É a única forma de ver o erro de verdade. Mesma URL do endpoint normal, com `/debug` na
frente:

```bash
curl -X POST \
  'https://www.google-analytics.com/debug/mp/collect?measurement_id=G-XXXXXXX&api_secret=SEU_API_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{
    "client_id": "123456789.1699999999",
    "events": [{
      "name": "purchase",
      "params": { "value": 199.90, "currency": "BRL", "engagement_time_msec": 100 }
    }]
  }'
```

Payload correto responde:

```json
{ "validationMessages": [] }
```

Payload com problema responde com a descrição exata:

```json
{
  "validationMessages": [{
    "fieldPath": "events[0].params.currency",
    "description": "Measurement value is invalid...",
    "validationCode": "VALUE_INVALID"
  }]
}
```

> **O endpoint de debug não grava nada no GA4.** Ele só valida. Use à vontade para conferir
> a forma do payload, e depois teste o fluxo real pelo painel.

Rode isso **uma vez** ao configurar o projeto. Se validar, o resto do caminho está livre.

### 7.3 DebugView do GA4 (rota `ga4_mp`)

1. **GA4 → Administrador → DebugView**.
2. Adicione `"debug_mode": true` dentro de `events[0].params`, ou use a extensão **Google
   Analytics Debugger** do Chrome para o tráfego do navegador.
3. Os eventos aparecem no fluxo em segundos, com todos os parâmetros abertos.

Sem `debug_mode`, o evento do Measurement Protocol **não aparece no DebugView** — falso
negativo clássico que faz muita gente refazer configuração que estava certa.

### 7.4 Validar a rota `google_ads`

Aqui a validação é direta: dispare um evento de teste pelo painel (aba Instalação → "Enviar
teste" ou "Disparar Webhook de Teste") e leia a aba **Logs**. A mensagem diz o que houve.

| Mensagem no log | O que fazer |
|---|---|
| `uploaded: true` | ✅ Funcionou. A conversão está na conta. |
| `Google Ads não configurado: faltam ...` | Preencha os campos listados (seção 4.6) |
| `OAuth falhou: invalid_grant` | Refresh token inválido, expirado ou revogado — refaça a 4.3, e confirme que o app OAuth está **publicado** |
| `OAuth falhou: invalid_client` | Client ID ou secret errados |
| `DEVELOPER_TOKEN_NOT_APPROVED` | O token ainda está em nível de teste — aguarde a aprovação (4.1) |
| `USER_PERMISSION_DENIED` | A conta que autorizou o OAuth não tem acesso a esse `customer_id`, ou falta o `login-customer-id` da MCC |
| `INVALID_CONVERSION_ACTION` | O resource name está errado, ou a ação de conversão não é do tipo importação por API (4.5) |
| `NO_CONVERSION_ACTION_FOUND` | O resource name aponta para algo que não existe nessa conta |

Depois, confirme na interface: **Google Ads → Metas → Conversões → Uploads** (*Conversion
uploads*) mostra o histórico dos envios pela API, com contagem de sucesso e erro. É a fonte
de verdade do lado do Google.

### 7.5 Relatórios e prazos

- **GA4 Tempo real**: segundos a minutos.
- **Relatórios padrão do GA4**: 24 a 48 horas de processamento.
- **Google Ads → Metas → Conversões → Resumo**, coluna **Status**:

| Status | Significado |
|---|---|
| "Nenhuma conversão recente" | Ainda não chegou nada. Espere ou revise a configuração |
| "Gravando conversões" | ✅ Funcionando |
| "Inativa" | Não recebe conversão há mais de 30 dias |
| "Não verificada" | Problema de configuração — clique para ver o detalhe |

### 7.6 Atrasos esperados — imprima isso na cabeça

| Etapa | Prazo típico |
|---|---|
| Servidor Traker → GA4 (`ga4_mp`) | segundos |
| Servidor Traker → Google Ads API (`google_ads`) | segundos |
| Aparecer no **Tempo real** do GA4 | segundos a 2 min |
| Aparecer no **DebugView** (com `debug_mode`) | segundos |
| Aparecer nos **relatórios padrão** do GA4 | 24 a 48 h |
| GA4 → **Google Ads** (conversão importada, rota `ga4_mp`) | **até 24 h**, tipicamente 3 a 9 h |
| Upload direto aparecer no relatório do Ads (rota `google_ads`) | **3 a 6 h** |
| Atribuição do Ads estabilizar | **até 72 h** (modelagem e correção retroativa) |

> **Não julgue a implementação no mesmo dia.** É diferente do Meta, onde o Test Events
> mostra o evento em segundos. No Google, você valida a *forma* na hora (endpoint de debug,
> DebugView, tela de Uploads), mas o *número* só fecha no dia seguinte. Muita gente refaz uma
> configuração correta por impaciência e acaba quebrando o que funcionava.

### 7.7 Checklist de validação

**Comum às duas rotas:**

- [ ] Painel → Logs: destino Google com status `success`.
- [ ] Google Ads → Ações de conversão: status "Gravando conversões" (24h depois).
- [ ] Só **um** evento marcado como "Ação de conversão principal".

**Se estiver em `ga4_mp`:**

- [ ] Endpoint `/debug/mp/collect` retorna `validationMessages: []`.
- [ ] DebugView mostra o evento com `debug_mode` ligado.
- [ ] GA4 → Tempo real mostra o evento.
- [ ] GA4 → Eventos-chave: o evento está marcado.
- [ ] GA4 → Administrador → Vinculações do Google Ads: vínculo ativo.
- [ ] Lembre: `success` no log significa só "o Google respondeu 204" — não é prova de aceite.

**Se estiver em `google_ads`:**

- [ ] Log do evento mostra `uploaded: true`.
- [ ] Google Ads → Metas → Conversões → **Uploads** registra o envio sem erro.
- [ ] A ação de conversão é do tipo **importação manual via API**.
- [ ] O app OAuth do Cloud Console está **publicado** (não em "Teste").
- [ ] Developer token no nível **Basic**, não "Test account access".

---

## 8. Diferenças de modelo em relação à Meta

Quem vem do Meta Ads tropeça sempre nos mesmos seis pontos. Vale a leitura mesmo que você
ache que já sabe.

### 8.1 Deduplicação: no Meta você configura, no Google não

| | Meta | Google |
|---|---|---|
| Mecanismo | `event_id` + `event_name`, janela de 48h | `transaction_id` (GA4) / `orderId` (Ads API) |
| Configuração | **Sua**: você passa o `eventID` no `fbq` | **Não existe** o equivalente |
| Se errar | Conversão em dobro | O GA4 dedupa `purchase` pelo `transaction_id` |

No Google não há "Pixel × CAPI" para deduplicar — não existe um par navegador/servidor
enviando o mesmo evento por dois canais que você tenha que costurar à mão.

**Mas há um risco de duplicação real:** se a tag do GA4 no navegador **e** o Servidor Traker
enviarem o mesmo `purchase`, o GA4 conta dois — a menos que os dois carreguem o mesmo
`transaction_id`. Duas saídas:

- **Mais simples e recomendada:** deixe `purchase` **só** no Servidor Traker (remova a tag
  de purchase do GA4 no GTM Web). Você ganha resistência a adblocker e mantém o GA4 web
  fazendo o resto (page_view, sessão, atribuição).
- **Se quiser manter os dois:** garanta `transaction_id` idêntico nos dois. No Servidor
  Traker, mande `order_id` **e** `transaction_id` com o mesmo valor no `custom_data` — o
  `custom_data` vai inteiro para os `params` do GA4.

```js
window.trk('purchase', {
  user_id: {{DL - user_id}},
  custom_data: {
    value: 199.90,
    currency: 'BRL',
    order_id: '8812',
    transaction_id: '8812'   // o GA4 dedupa purchase por este campo
  }
});
```

Na rota `google_ads`, o `order_id` vira `orderId` na conversão — o Google usa esse campo
para evitar contagem dupla do mesmo pedido em uploads repetidos. Mais uma razão para
**nunca omitir o `order_id`** no `purchase`.

### 8.2 Janela de atribuição

| | Meta | Google Ads |
|---|---|---|
| Padrão de clique | 7 dias | **30 dias** |
| Padrão de visualização | 1 dia | 1 dia (só Display/YouTube) |
| Máximo de clique | 7 dias | **90 dias** |
| Onde muda | Nível de conjunto de anúncios | Na **ação de conversão** |

**Consequência prática:** o Google atribui conversão a cliques mais antigos e vai atribuir
**mais** conversões que a Meta para o mesmo tráfego. Não é o Google "sendo melhor" — é
janela maior. Comparar CPA de Meta com CPA de Google sem normalizar a janela é comparar
coisas diferentes.

Na rota `google_ads` há um limite adicional que não existe na Meta: **o `gclid` precisa
estar dentro da janela de conversão da ação**. Um upload com `gclid` de 60 dias atrás numa
ação configurada para 30 dias é **rejeitado**, com erro explícito. Se o seu ciclo de venda é
longo, aumente a janela na ação de conversão antes de começar a subir.

### 8.3 Modelo de atribuição

- **Meta:** último clique dentro da janela, com modelagem própria.
- **Google Ads:** **baseado em dados** (*data-driven*) por padrão desde 2023. Distribui
  crédito **fracionado** entre os pontos de contato.

Por isso o Google mostra **conversões com casas decimais** — `3,47 conversões`. Não é bug,
não é erro de arredondamento: é meia conversão atribuída a esta campanha e meia a outra. No
Meta você nunca viu isso e o número vira `3` ou `4` inteiro.

### 8.4 Nomes de eventos

| | Meta | GA4 | Google Ads API |
|---|---|---|---|
| Convenção | `PascalCase` — `Purchase` | `snake_case` — `purchase` | **Não usa nome** — usa o resource name da conversion action |
| Lista fechada? | Sim, 17 padrão + personalizados | Não | Você cria as ações que quiser |
| Nome errado | Vira evento personalizado | Aceito sem reclamar | Erro explícito de resource name |

O Servidor Traker resolve isso com **mapeamentos independentes por destino**, a partir do
mesmo evento canônico do seu site. Você dispara `window.trk('view_content')` uma vez e o
servidor manda `ViewContent` para a Meta e `view_item` para o GA4. Na rota `google_ads`, o
nome canônico não é traduzido: ele é a **chave de busca** no mapa de conversion actions.
Não mexa em um mapeamento esperando que o outro acompanhe.

### 8.5 Validação: no Meta é imediata, no Google depende da rota

- **Meta:** Test Events mostra o evento em segundos, com todos os parâmetros e o selo de
  desduplicado. Feedback imediato e confiável.
- **Google `ga4_mp`:** o MP responde `204` para tudo. Validação real = endpoint de debug
  (forma) + DebugView (chegada) + esperar 24h (número).
- **Google `google_ads`:** erro explícito no log na hora, e a tela de Uploads no Ads
  confirma. Perto do MP, é um alívio.

### 8.6 Qualidade de match

- **Meta:** tem o **EMQ**, uma nota de 0 a 10 por evento, visível e acionável.
- **Google:** **não existe equivalente**. Há o diagnóstico de Enhanced Conversions na tela
  de configurações de conversão, bem mais vago.

O bloco de cobertura de campos no Dashboard do painel do Servidor Traker serve para os
dois: é o mesmo evento canônico alimentando ambos os destinos. Se `email` está em 90% dos
`purchase`, isso vale tanto para o EMQ da Meta quanto para o Enhanced Conversions do Google.
Para a rota `google_ads`, olhe também a linha de `gclid` — é o campo que mais pesa lá.

---

## 9. Erros comuns

### 9.1 Logs mostram `success` mas nada aparece no GA4 (rota `ga4_mp`)

O sintoma número um, e ele decorre direto do MP não validar payload.

1. Rode o payload no **endpoint de debug** (seção 7.2). É onde o erro aparece.
2. Confira o **Measurement ID**: `G-XXXXXXX`, não o ID do fluxo (só números), não `UA-...`.
3. Confira que o **API Secret pertence à mesma propriedade** do Measurement ID. Secret de
   outra propriedade responde `204` alegremente e o dado cai no vazio. Este é o erro mais
   frequente em conta com várias propriedades.
4. Você está olhando os relatórios padrão? Eles levam 24–48h. Olhe o **Tempo real**.

### 9.2 `Google Ads não configurado: faltam ...`

A rota `google_ads` está selecionada e falta credencial. A mensagem lista exatamente quais —
`client_id`, `client_secret`, `refresh_token`, `developer_token`, `customer_id`,
`conversion_action`. Volte à seção 4 e preencha o que falta.

O erro é **não-retentável de propósito**: o evento não fica batendo na fila indefinidamente,
porque insistir não resolveria uma configuração ausente. Depois de corrigir, os eventos
novos passam a fluir; os que já falharam precisam ser reenviados manualmente se importarem.
Ver `06-operacao-runbook.md`.

Se você ainda não tem o developer token aprovado, **volte a rota para `ga4_mp`** enquanto
espera — é melhor ter conversão chegando por um caminho subótimo do que não ter nenhuma.

### 9.3 `OAuth falhou: invalid_grant`

O refresh token não vale mais. Causas, em ordem de frequência:

1. **O app OAuth está em modo "Teste"** no Cloud Console — o token expira em 7 dias.
   Publique o app (seção 4.2) e gere um refresh token novo.
2. A senha da conta Google que autorizou foi trocada.
3. O acesso foi revogado em `myaccount.google.com/permissions`.
4. O token foi gerado com uma conta que perdeu o acesso ao Google Ads.

A correção é sempre a mesma: refaça a seção 4.3 e cole o novo refresh token no painel.

### 9.4 `DEVELOPER_TOKEN_NOT_APPROVED`

O token ainda está no nível **Test account access** e só funciona em contas de teste. Não há
o que ajustar no Servidor Traker — é esperar a aprovação do Google (seção 4.1). Enquanto
isso, opere em `ga4_mp`.

### 9.5 `USER_PERMISSION_DENIED`

A conta Google que autorizou o OAuth não tem permissão nesse `customer_id`. Confira:

- O `customer_id` é o da conta que recebe as conversões (sem traços tanto faz — o servidor
  limpa).
- Se o acesso é via MCC, o **Login Customer ID** precisa estar preenchido com o ID **da
  MCC**, não da conta filha.
- A conta que autorizou no Playground é a mesma que tem acesso ao Ads.

### 9.6 `INVALID_CONVERSION_ACTION` ou `NO_CONVERSION_ACTION_FOUND`

O resource name está errado ou a ação não serve para upload:

- Formato correto: `customers/1234567890/conversionActions/987654321` — customer id **sem
  traços**.
- A ação precisa ser do tipo **Importar → Importações manuais usando a API** com
  **conversões de cliques**. Uma ação criada como "Site" (tag) não aceita upload.
- O ID da ação está na URL da tela de detalhe, no parâmetro `ctId=` (seção 4.5).
- O customer id do resource name tem que ser o mesmo da conta para onde você está subindo.

### 9.7 Conversão rejeitada mesmo com HTTP 200

É o `partialFailureError`, e o servidor **já trata como falha** — a mensagem real aparece no
log do evento. As causas mais comuns:

- `gclid` fora da janela de conversão da ação (seção 8.2);
- `gclid` de uma conta de anúncios diferente da que está recebendo;
- `conversionDateTime` anterior à data do clique;
- conversão duplicada com o mesmo `orderId` (nesse caso, é o comportamento desejado).

### 9.8 Evento aparece no GA4 mas não chega ao Google Ads (rota `ga4_mp`)

Percorra na ordem:

1. O vínculo GA4 ↔ Google Ads existe e está ativo? (seção 3, Etapa 1)
2. O evento está marcado como **evento-chave** no GA4? (Etapa 2)
3. A conversão foi **importada** no Ads? (Etapa 3)
4. Já passaram 24h? (seção 7.6)
5. Na tela de ações de conversão, qual o **status**?

### 9.9 Conversão contando em dobro no GA4

Tag do GA4 no navegador **e** Servidor Traker mandando o mesmo `purchase`, sem
`transaction_id` igual. Ver seção 8.1.

### 9.10 `value` chegando errado ou zerado

- O `value` precisa ser **número**, não string: `199.90`, não `"R$ 199,90"`. O servidor
  converte com `Number()` — `"199,90"` (vírgula) vira `NaN` e você perde o valor.
- **Sempre mande `currency` junto.** Na rota `google_ads`, se houver valor sem moeda, o
  servidor assume `BRL`; na `ga4_mp`, valor sem moeda pode ser ignorado pelo GA4.
- Ponto como separador decimal, sempre. Vírgula quebra.

### 9.11 Conversões despencaram depois de ligar o Servidor Traker

Provavelmente **não** despencaram — mudou o que está sendo contado.

- Você removeu a tag antiga de conversão do GTM e agora conta só o que passa pelo servidor?
  Compare os volumes brutos antes de concluir.
- Marcou mais de um evento como "Ação de conversão principal", ou trocou qual é o principal?
  A coluna "Conversões" muda de significado.
- Mudou a janela de atribuição ao criar a ação de conversão nova? Uma janela de 7 dias
  contra os 30 anteriores derruba o número sem nada estar quebrado.
- Migrou de `ga4_mp` para `google_ads`? São ações de conversão **diferentes**. Durante a
  transição você vai ver as duas convivendo; decida qual é a principal e desligue a outra
  como principal, senão conta duas vezes na coluna "Conversões".

### 9.12 `client_id` inconsistente, sessões fragmentadas no GA4

Sintoma: cada evento vira uma sessão nova, todo mundo aparece como "novo usuário".

Acontece quando não há `user_id` no dataLayer **e** você não passa `ga_client_id` — aí o
servidor cai no último recurso, que é um valor aleatório por evento. A correção é a mesma da
ponte de identidade: **colocar o `user_id` no dataLayer** (documento 04, seção 5.3). Com
`user_id`, o pseudo-`client_id` derivado é estável e o usuário deixa de se fragmentar.

### 9.13 O `user_data` hasheado está sendo ignorado (rota `ga4_mp`)

GA4 → Administrador → Configurações de dados → **Coleta de dados** → ative **Coleta de
dados fornecidos pelo usuário**. Sem isso o GA4 descarta o bloco `user_data` sem avisar.

---

## 10. Resumo de uma página

1. **Duas rotas reais.** `ga4_mp` é fácil de ligar e alimenta o GA4, mas **não carrega
   `gclid`**. `google_ads` vai direto à conta de anúncios **com `gclid`**, mas exige
   developer token aprovado pelo Google.
2. **Comece pela `ga4_mp`** e peça o developer token em paralelo no dia 1.
3. Measurement ID + API Secret saem da mesma tela do GA4 (Administrador → Fluxos de dados).
4. Para `google_ads`: developer token (MCC → Central de API), OAuth no Cloud Console **com
   o app publicado**, refresh token pelo OAuth Playground com escopo `adwords`, customer id
   e o resource name `customers/<id>/conversionActions/<id>` no JSON de conversion actions.
5. Nenhuma tag nova no GTM — a instalação é a mesma do documento 04, para as duas rotas.
6. Conversão que acontece **fora do navegador** é o caso de uso da rota `google_ads`.
7. Enhanced Conversions: e-mail e telefone hasheados vão nas duas rotas. Endereço e ajuste
   de conversão (estorno) não existem em nenhuma.
8. Valide `ga4_mp` com o **endpoint de debug** e o **DebugView** — o `204` não prova nada.
   Valide `google_ads` pelo **log do evento** e pela tela **Uploads** do Ads.
9. Espere **24h** antes de julgar o número no Google Ads.

Para a Meta, veja `04-tagueamento-meta.md`. Para operação, variáveis de ambiente e
incidentes, `06-operacao-runbook.md`.
