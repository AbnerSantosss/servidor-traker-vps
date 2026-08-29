# Convenções do painel (front e back)

Documento de referência para qualquer alteração no painel administrativo. Nasceu junto
com a execução do `Plano-Melhorias-Painel.md` e vale para tudo que vier depois.

---

## 1 · Invariantes — o que nunca pode ser quebrado

| # | Invariante | Consequência prática |
|---|---|---|
| I-1 | **CSP intocada**: `script-src 'self'`, sem JS inline, sem CDN | Biblioteca nova entra vendorizada em `public/vendor/`. Nada de `onclick=`, `<script>código</script>` ou `eval`. Handler sempre por `addEventListener`. |
| I-2 | **Sem build step** | Nada de bundler, TypeScript, JSX ou `import` no front. Bibliotecas entram em UMD/IIFE já compilada. |
| I-3 | **Contrato `publicProject` estável** | `src/admin/router.js` só **acrescenta** campos; nunca renomeia nem muda tipo. |
| I-4 | **Endpoints existentes intactos** | Funcionalidade nova = endpoint novo. `/api/projects*`, `/api/auth*`, `/api/usuarios*`, `/e/:slug`, `/c/:slug`, `/s\|t/:slug.js` não mudam de assinatura. |
| I-5 | **Migrações aditivas** | Só `ADD COLUMN ... IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. Nunca `DROP`, `ALTER TYPE` ou renomear coluna com dados. |
| I-6 | **Fila e idempotência intocadas** | O par `events(project_id,event_id,event_name)` + `deliveries(event_row_id,destination_type)` e os status (`pending/processing/success/error/dead/skipped_*`) não mudam de semântica. |
| I-7 | **Segredos nunca chegam ao front** | Credenciais cifradas com `APP_SECRET` (`src/config/crypto.js`); a API devolve só flags `has*`. Chamada a terceiro (OpenRouter etc.) é sempre server-side. |
| I-8 | **PII protegida (LGPD)** | Nada de e-mail/telefone em claro em log, e-mail de notificação ou prompt de IA. |
| I-9 | **Testes verdes** | `npm test` passa ao fim de cada fase. Recurso novo chega com teste novo. |
| I-10 | **Papéis respeitados** | `operador` não vê credenciais nem usuários. Endpoint novo declara explicitamente `requireAuth` ou `requireAdmin`. |
| I-11 | **Dois processos** | `api` (`src/server.js`) e `worker` (`src/worker.js`) são containers separados; não compartilham memória. Comunicação entre eles é pelo Postgres. |

---

## 2 · Front-end: arquitetura sem build

### 2.1 Scripts clássicos, escopo global compartilhado

O painel **não usa módulos ES**. Cada arquivo em `public/admin/` é um *script clássico*:
declarações de topo (`function`, `const`, `let`) vivem no escopo global compartilhado por
todos os scripts da página. Por isso a divisão do antigo `admin.js` foi puramente textual —
nenhum `import`/`export`, nenhum wrapper IIFE, nenhum namespace.

Regras que decorrem disso:

- **A ordem das tags `<script>` em `admin.html` é significativa** para código de topo de
  arquivo que *executa* (não para declarações, que são içadas ou só usadas em runtime).
  Mantenha o boot (`main.js`) sempre por último.
- **Nomes são globais.** Prefixe funções de um módulo novo com o assunto
  (`falhasCarregar`, `falhasRenderizar`) para evitar colisão. Antes de criar um nome,
  faça `grep -rn "nomeCandidato" public/admin/`.
- Todo arquivo começa com um comentário de uma linha dizendo o que ele é, seguido de
  `'use strict';`.

### 2.2 Ordem de carga atual (`public/admin.html`)

```
vendor/echarts.min.js      biblioteca de gráficos (Apache ECharts, UMD)
vendor/lucide.min.js       biblioteca de ícones (Lucide, UMD)
admin/nucleo.js            $, $$, ICON, state, api(), sessão, toast, projetos
admin/ajudas.js            dicionário central dos textos de ajuda
admin/tooltip.js           componente de tooltip acessível
admin/icones.js            ponte com o Lucide (aplicarIcones)
admin/instalacao.js        aba Instalação: stepper de 4 passos (método → identidade/
                            page_view → webhook → verificação), a tag única do GTM
                            (/g/:slug.js) e a tag única sem GTM (/w/:slug.js)
admin/navegacao.js         activateTab + sub-navegação
admin/meta.js
admin/google.js
admin/postback.js
admin/logs.js
admin/utilitarios.js       modal de projeto, cópia, formatação
admin/graficos.js          helpers do ECharts (tema, criar/atualizar)
admin/falhas.js            hub Meta/Google (F2/F3): fluxo pedagógico, "Visão geral"
                            (métricas por destino) e "Falhas" explicadas —
                            compartilhado pelos dois hubs, parametrizado por destino
admin/dashboard.js         faixas 1/2/4: KPIs, série temporal, funil, destinos
admin/dashboard-atribuicao.js  faixas 3/5: receita por UTM (drill-down), qualidade
                                de atribuição por dia, compras sem atribuição
admin/dominios.js          aba Domínios: por que existe, tutorial numerado, linha do
                            tempo de status por domínio, cadastro/verificação (F7)
admin/dashboard-emq.js     EMQ (barras + donut), embutido na faixa 3 do dashboard
admin/usuarios.js
admin/console-teste.js
admin/main.js              bind de eventos + init (SEMPRE por último)
```

Além dos scripts, o `<head>` carrega folhas de estilo por assunto, sempre depois de
`app.css` (que continua sendo a base — tokens, layout, componentes compartilhados):
`webhook-studio.css`, `tempo-real.css`, `configuracoes.css`, `instalacao.css` (stepper de
Instalação, escolha de método, tutorial e linha do tempo de Domínios), `dashboard.css`
(funil de dinheiro e faixas do dashboard) e `marca.css` (logo e cor por empresa). Tela
nova com CSS próprio ganha arquivo em `public/estilos/` e uma linha de `<link>` nessa
lista — o que também é o que permite vários agentes trabalharem em paralelo sem disputar
o mesmo arquivo.

Módulos acrescentados na reforma visual, na ordem de carga: `admin/marca.js` (chip da
empresa na barra lateral e no cabeçalho, modal de logo/cor) entra **depois** de
`configuracoes.js`, porque acrescenta uma seção àquela tela. A landing tem pilha
própria e separada: `vendor/gsap.min.js` + `landing.js` + `estilos/landing.css`, que o
painel **não** carrega.

Módulo novo: crie o arquivo, adicione a tag em `admin.html` na posição lógica (antes de
`main.js`) e registre aqui.

### 2.3 Ícones

Use **Lucide** (`vendor/lucide.min.js`, ISC). Marcação:

```html
<i data-lucide="trending-up" aria-hidden="true"></i>
```

e chame `aplicarIcones(raiz)` (de `admin/icones.js`) depois de injetar HTML — ele roda
`lucide.createIcons` só no trecho novo. Os ícones desenhados à mão do `ICON` em
`nucleo.js` continuam válidos onde já estão (não reescrever o que funciona); código novo
usa Lucide.

### 2.4 Gráficos

Sempre via `admin/graficos.js`, nunca chamando `echarts` direto na tela:

- `grafico(idOuElemento, opcao)` cria/reaproveita a instância e aplica o tema `traker`;
- o tema lê as cores dos tokens CSS já existentes em `app.css`;
- se `window.echarts` não existir, o helper devolve `null` e a tela **precisa** ter um
  caminho alternativo (texto/tabela). Gráfico é enfeite; dado é obrigação.

### 2.5 Ajuda contextual (tooltips)

- Marcação: `<button type="button" class="ajuda" data-ajuda="chave"></button>`;
- texto em `admin/ajudas.js`, no objeto `AJUDAS` (chave em kebab-case, agrupada por tela);
- o componente cuida de acessibilidade (`aria-describedby`, abre por foco e hover, fecha
  com Esc) — não reimplemente tooltip em outro lugar.

### 2.6 Estilo

- CSS novo vai em `public/app.css`, no fim, sob um comentário de seção
  `/* ===== Nome da seção ===== */`, ou num arquivo próprio em `public/estilos/`
  quando a feature for grande o bastante para justificar (é também o que evita
  dois agentes editando o mesmo arquivo ao mesmo tempo);
- reaproveite os tokens/variáveis já definidos no `:root` do arquivo;
- classes em pt-BR, no padrão que o arquivo já usa.

### 2.7 Design system (tema claro)

O painel usa o tema **claro**; a marca é neon (ciano→violeta) e aparece só em
"chips" escuros e no hero da landing. A separação que sustenta o sistema:

> **Cor de marca e cor de dado são coisas diferentes.** Antes o dourado era, ao
> mesmo tempo, botão primário, barra de gráfico, selo de papel e borda de alerta
> — e um dashboard saudável parecia em alerta permanente.

| Papel | Tokens |
|---|---|
| Superfícies | `--canvas` (fundo), `--surface` (cards), `--surface-2` (zebra/wells), `--surface-3` (hover) |
| Texto | `--text`, `--muted`, `--muted-2` (**só** rótulo/legenda — nunca corpo de texto) |
| Ação | `--accent`, `--accent-hover`, `--accent-soft`, `--accent-line`, `--on-accent` |
| Marca | `--brand-cyan`, `--brand-violet`, `--brand-ink`, `--brand-grad` — reservados à identidade |
| Semânticas | `--ok`, `--danger`, `--warning`, `--info` e os pares `-soft` |
| Séries de gráfico | `--dado-1` … `--dado-8` |
| Espaço / raio / sombra | `--esp-1..8`, `--radius-sm/--radius/--radius-lg`, `--shadow-1/2/3`, `--ring` |
| Movimento | `--dur-fast/base/slow`, `--ease-out`, `--ease-in-out` |

Regras que valem para todo código novo:

- **Nenhuma cor cravada.** Se falta um token para o que você precisa, o certo é
  discutir o token, não escrever o hex.
- Convenções fixas de gráfico: **receita/vendas em índigo** (`--dado-1`),
  **abandono em âmbar** (`--dado-5`), **erro no vermelho semântico**.
- Contraste mínimo de 4.5:1 para texto — há teste automatizado conferindo os
  pares token/superfície.
- Badge de status **sempre** com ícone junto da cor: cor não pode ser o único
  canal de informação (daltonismo).
- Números que atualizam sozinhos usam `tabular-nums` (classe `.num`), senão o
  valor "dança" a cada refresh do tempo real.
- Os aliases `--amber`, `--ink`, `--ink-2`, `--teal` existem só para a transição
  e apontam para os papéis novos. Código novo **não** os usa.

### 2.8 Movimento e animação

Bibliotecas vendorizadas disponíveis: **GSAP 3.12.5** (`vendor/gsap.min.js`,
gratuita para uso comercial desde a aquisição pela Webflow).

- **CSS primeiro.** Hover, foco, entrada de modal e toast são transições CSS.
  GSAP entra só onde CSS não alcança: timelines sequenciadas, count-up de número
  e o background da landing.
- GSAP **não é carregado no painel por padrão** — o painel é ferramenta de
  trabalho, não vitrine. A landing carrega sempre.
- Anime **apenas `transform` e `opacity`**. Animar `width`, `height`, `top` ou
  `left` força reflow a cada quadro.
- `prefers-reduced-motion: reduce` é respeitado por um bloco global em
  `app.css`; no JS, use `gsap.matchMedia()` para nem iniciar a timeline.
- Animação de fundo **pausa quando a aba está oculta** (`visibilitychange`) —
  não se gasta bateria do visitante animando o que ninguém vê.
- Durações e easings saem dos tokens; nada de `0.3s` mágico espalhado.

### 2.9 Estados obrigatórios de componente

Todo componente entregue com os seis: **repouso, hover, foco visível, ativo,
desabilitado, erro**. Mais três que o painel exige por ser uma ferramenta que
espera rede:

- **carregando** — botão com `data-carregando="true"` preserva a largura (o
  rótulo continua ocupando lugar), senão o botão encolhe e desloca o que está ao
  lado no meio do clique;
- **skeleton** nos cards e tabelas enquanto os dados não chegam;
- **vazio** com uma frase e uma ação, nunca um "Nenhum dado" seco.

Inputs precisam tratar `:-webkit-autofill`: sem isso o Chrome pinta o campo com
a cor dele e fura o tema.

---

## 3 · Back-end

### 3.1 Endpoints administrativos

Todos em `src/admin/router.js`, no padrão que já existe: `wrap(...)` para erro assíncrono,
`loadProject` para resolver o projeto, `requireAuth`/`requireAdmin` para papel. Resposta
sempre JSON. Nunca devolver segredo — só flags `has*`.

### 3.2 Migrações

Arquivo novo em `src/db/migrations/NNN_nome.sql`, numeração sequencial. Aditivo (I-5).
Backfill pesado não vai dentro da migração: vira script idempotente em `src/scripts/`.

### 3.3 Testes

```
npm test               # unit + integração (precisa do Postgres de teste)
npm run test:db:up     # sobe o Postgres descartável em 55432 (só na 1ª vez)
```

Os testes de integração sobem a aplicação de verdade contra um banco real. Teste novo
segue o estilo dos existentes: nome descritivo em português, uma asserção por
comportamento observável.

---

## 4 · Desenvolvimento local

O `docker-compose.override.yml` (não versionado, só local) monta `./public` e `./src`
dentro dos containers:

```
docker compose up -d          # sobe tudo já com o override
docker compose restart api    # depois de mexer em src/ (front não precisa de restart)
docker compose run --rm api npm run migrate
```

O painel fica em `http://localhost`.

---

## 5 · Estilo de escrita do código

O repositório tem uma característica deliberada: **comentários explicam o porquê, não o
quê**, em português, e frequentemente contam a decisão de projeto por trás da linha
(veja `src/ingest/adaptadores.js` ou `src/admin/seguranca.js`). Código novo mantém esse
padrão. Comentário que só repete o nome da função é ruído; comentário que registra uma
regra de negócio ou um risco evitado é o que faz este código ser mantível por outra
pessoa daqui a um ano.
