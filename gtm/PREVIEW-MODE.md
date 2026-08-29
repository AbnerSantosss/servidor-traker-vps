# Validar a instalação no Preview Mode do GTM

Guia do passo que nenhum teste automatizado cobre: o disparo real dentro do navegador, no seu container do GTM. O guia completo de tagueamento está em [`../docs/04-tagueamento-meta.md`](../docs/04-tagueamento-meta.md) — aqui fica só o roteiro de validação.

## Antes de começar

O que já é coberto por teste automatizado (`npm test`, na raiz do repositório): normalização e hash de PII, `_fbp`/`_fbc` preservados em texto plano, remoção de PII com `ad_user_data=denied`, LDU com `ad_personalization=denied`, enriquecimento de IP/User-Agent pelo servidor, deduplicação por `event_id` e a entrega com retry. Nada disso precisa ser reconferido no navegador.

O que **só** o Preview Mode valida: se a tag dispara no gatilho certo, com os dados certos, no site real.

Pré-requisitos:
- Projeto criado no painel (`/painel`), com o `slug` em mãos (aba **Instalação**).
- Endpoint respondendo no subdomínio first-party — em produção, `https://traker.codigovencedor.com`.
- Destino Meta configurado e, de preferência, com um **`test_event_code`** preenchido (aba Meta), para os eventos caírem no *Test Events* do Events Manager em vez de contaminarem os dados de produção.

## Roteiro

### 1. Instale a tag

As URLs exatas estão na aba **Instalação** do painel, já com o slug do projeto.

| Ordem | Tag | Gatilho | Papel |
|---|---|---|---|
| 1ª | **TrackServer** — `<script src="https://traker.codigovencedor.com/g/<slug>.js"></script>` | *All Pages*, prioridade alta | Captura `fbclid`, `gclid`, UTMs e cookies de forma sticky, amarra ao `user_id`, cria `window.trk(...)` e dispara o `page_view` |
| 2ª | Suas tags de evento (Custom HTML) chamando `window.trk('purchase', {...})` | O gatilho de cada conversão | Envia o evento |

A ordem importa: `window.trk` precisa existir antes de qualquer tag que o chame. Use **Prioridade de disparo da tag** no GTM (número maior dispara primeiro) em vez de confiar na ordem visual. Dentro da própria `/g/` a ordem já está garantida — é um arquivo só, executado de cima para baixo.

Alternativa: importe o template `TrackServer.tpl` (*Modelos → Modelos de tag → Novo → ⋮ → Importar*) se preferir uma tag configurável por interface em vez de Custom HTML.

### 2. Confirme no Tag Assistant

Abra o **Visualizar** do GTM e navegue no site:

- As tags aparecem em **Tags Fired**, na ordem esperada, e nenhuma em *Failed*.
- Na aba **Console** do navegador, `window.trk` existe (digite `typeof window.trk` → `"function"`).
- Na aba **Network**, filtre por `/e/` e `/c/`: as requisições saem para o **seu subdomínio**, com status **202**.

Se as requisições não aparecem na Network: o `sendBeacon` não fica visível em todos os navegadores — confira pela aba Logs do painel, que é a fonte de verdade.

### 3. Confirme a chegada no painel

Painel → **Logs**. O evento precisa aparecer com:
- `event_name` correto;
- `event_id` preenchido;
- status **sucesso** no destino Meta.

Se o status for erro, o motivo aparece no tooltip da coluna do destino.

### 4. Confirme a deduplicação (o passo mais importante)

Se o site também roda o Pixel no navegador — o caso normal — este é o teste que separa uma instalação correta de uma que duplica conversões:

```html
<script>
  var id = window.trk('purchase', {
    user_id: '{{DL - user_id}}',
    custom_data: { value: 199.90, currency: 'BRL', order_id: '{{DL - order_id}}' }
  });
  fbq('track', 'Purchase', { value: 199.90, currency: 'BRL' }, { eventID: id });
</script>
```

No **Events Manager → Test Events**, o evento deve aparecer marcado como recebido pelos dois canais (navegador e servidor) e **contado uma vez**. Se aparecerem dois eventos separados, confira:
- o `eventID` do `fbq` é exatamente o valor devolvido por `window.trk` (a chave é `eventID`, com o **D** maiúsculo);
- o `event_name` traduzido pelo mapeamento do painel é idêntico ao usado no `fbq` (`purchase` → `Purchase`).

### 5. Confira a qualidade de correspondência

Painel → **Dashboard** → bloco *Qualidade de correspondência (EMQ)*. Ele mostra quantos por cento dos eventos recentes carregam cada campo de match. `client_ip_address` e `client_user_agent` devem estar em ~100%; se estiverem baixos, o proxy não está repassando o IP real e o EMQ vai despencar sem nenhum erro aparente.

O número oficial continua sendo o do Events Manager, que leva algumas horas para consolidar.

## Antes de ir para produção

- [ ] Remover o `test_event_code` do painel (senão os eventos continuam indo só para o Test Events).
- [ ] Conferir que o evento de conversão principal aparece dedupado.
- [ ] Conferir que o `user_id` está no dataLayer antes do coletor rodar — sem ele a ponte de identidade não amarra nada, e a conversão de backend perde o `fbc`.
- [ ] Publicar a versão do container no GTM (o Preview não vale para os visitantes reais).
