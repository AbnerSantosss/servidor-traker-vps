---
title: Briefing — remover login rápido + redesign da tela de login (identidade CV)
tags: [seguranca, autenticacao, login, design, briefing, servidor-traker]
created: 2026-08-13
updated: 2026-08-13
---

# Briefing de implementação: tela de login Código Vencedor + remoção do login rápido

> ## ✅ EXECUTADO em 2026-08-13
>
> A Parte 1 (código) foi implementada e verificada nesta base; a Parte 2 (runbook) foi
> executada no ambiente local. O documento fica como registro do que foi feito e por quê.
>
> | Item | Estado | Evidência |
> |---|---|---|
> | R1–R10 · remoção do login rápido | ✅ | resíduo funcional zero; sobraram só 3 comentários-lápide em `auth.js` e `env.js` |
> | Testes reescritos (§1.2) | ✅ | o teste passou a comparar com uma rota inventada — ver nota de correção abaixo |
> | Redesign da tela de login | ✅ | preto CV, título com destaque dourado, pílula vermelha, marca SVG local (`assets/marca.svg`) |
> | Olhinho mostrar/ocultar | ✅ | testado no navegador: `type` alterna, `aria-pressed` acompanha |
> | "Manter conectado 30 dias" | ✅ | cookie de 12h sem marcar, 30 dias marcando; 3 testes novos |
> | `/definir-senha` alinhada | ✅ | mesma marca, mesmo botão, mesmo card |
> | Admin master + senha forte | ✅ | login 200 com a senha do `.env`; senha ausente de todo storage do navegador |
> | E-mail (Fase C) | ✅ parcial | reset real enviado (`messageId` do Gmail); resposta idêntica p/ e-mail inexistente |
> | Suíte | ✅ | **159 testes, 0 falhas** (eram 156) |
> | Detector de design | ✅ | 0 achados |
>
> **Correção feita durante a execução:** o plano previa que a rota removida devolveria
> **404**. Na prática devolve **401** — qualquer caminho inexistente sob `/api/` cai no
> `requireAuth` do adminRouter antes do 404 final. É melhor assim (o servidor não revela
> quais rotas existem), então o teste foi reescrito para o que de fato importa: a rota
> não devolve 200, não emite cookie de sessão, e responde **exatamente igual** a um
> caminho inventado — quem sonda não descobre que ali houve um atalho.
>
> **Pendente da Fase C** (depende de segunda caixa de e-mail): convite completo a um
> usuário novo, reenvio invalidando o link anterior e as verificações D1–D7 de gestão.

---

**Documento originalmente escrito como PLANEJAMENTO para entrega a outra IA/dev.**
A Parte 1 é o trabalho de código; a Parte 2 é o runbook operacional (humano). Os números
de linha foram conferidos em 2026-08-13 — use-os como ponto de partida, não como verdade
absoluta: confirme com grep antes de editar.

---

## 0. Contexto que a IA executora precisa saber antes de tocar em qualquer arquivo

**O produto.** Servidor de tracking server-side (Node 22 + Express + PostgreSQL 16 +
Caddy, Docker Compose). O painel admin é **vanilla JS, sem framework e sem build** —
arquivos estáticos em `public/`, servidos pelo próprio Express.

**As regras invioláveis** (existem testes que FALHAM se forem violadas):

1. **CSP `script-src 'self'`** — nenhum `<script>` inline, nenhum handler `onclick=`
   no HTML. Todo JS vive em arquivo próprio (`login.js`, `definir-senha.js`).
2. **Nenhum recurso externo** — sem Google Fonts, sem CDN, sem imagem remota. Fontes
   são a pilha de sistema definida nos tokens. Assets novos entram em `public/assets/`.
3. **Nenhum segredo no HTML** — a suíte varre as páginas procurando vazamento.
4. **`npm test` com 156 testes passando** é o critério de pronto. Dois testes cobrem o
   login rápido e precisarão ser ATUALIZADOS (não removidos) — ver §1.2.
5. Design tokens vivem no `:root` de `public/app.css` — a identidade Código Vencedor
   (preto/dourado/CTA vermelho) **já está aplicada** no painel. A tela de login deve
   consumir esses tokens, não inventar hex novos.
6. Copy da interface em **pt-BR**, tom direto.
7. Acessibilidade: contraste ≥ 4.5:1, `:focus-visible` visível (padrão do arquivo:
   outline dourado), inputs com `<label>`, botões com `aria-label` quando só ícone.

**Como rodar/verificar localmente:**

```bash
docker compose up -d --build api     # rebuild (estáticos são copiados na imagem)
# http://localhost/login  ·  http://localhost/definir-senha?token=xxx
npm run test:db:up && npm test       # suíte completa (precisa Docker)
```

---

# PARTE 1 — Trabalho de código (para a IA executora)

## 1. Remover o login rápido POR COMPLETO (código, não flag)

Decisão do dono do produto: o atalho "entrar sem senha" deixa de existir no código —
não é mais uma flag desligada, é ausência. Mapa completo do que remover:

| # | Arquivo | O que remover | Referência |
|---|---|---|---|
| R1 | `src/admin/auth.js` | O endpoint inteiro `POST /login-rapido` (bloco ~linhas 214–241) | começa no comentário sobre LOGIN_RAPIDO |
| R2 | `src/admin/auth.js` | O campo `loginRapido` da resposta de `GET /setup-necessario` (linha ~206) | a tela de login usa esse campo para exibir o bloco |
| R3 | `src/config/env.js` | A linha `LOGIN_RAPIDO: bool(...)` (linha ~84) | |
| R4 | `src/server.js` | O aviso de boot `if (env.LOGIN_RAPIDO) {...}` (linhas ~140–142) | |
| R5 | `public/login.html` | O bloco `#blocoLoginRapido` inteiro (div `.auth-dev`, linhas ~50–57) | |
| R6 | `public/login.js` | A linha que exibe o bloco (linha ~81) e o handler do clique com o `fetch('/api/auth/login-rapido')` (bloco na linha ~93) | |
| R7 | `public/app.css` | As regras `.auth-dev`, `.auth-dev-tag`, `.auth-dev-btn`, `.auth-dev-aviso` (seção "Atalho de desenvolvimento na tela de login", fim do arquivo) | |
| R8 | `.env`, `.env.example`, `.env.producao` | A linha `LOGIN_RAPIDO=...` e o comentário associado | |
| R9 | `test/setup-env.js` | A linha `process.env.LOGIN_RAPIDO = 'false'` (linha ~29) | |
| R10 | `docs/11-onde-colocar-cada-coisa.md` e `docs/12-deploy-zyraflow.md` | Itens de checklist que mandam conferir `LOGIN_RAPIDO=false` — substituir por nota de que o atalho foi removido do código em 2026-08-13 | |

### 1.2 Testes: atualizar, não apagar

`test/integracao.test.js` (~linhas 104–114) tem dois asserts sobre o assunto. O
comportamento externo esperado **continua o mesmo** (rota inexistente → 404), então:

- O teste "a rota não existe quando LOGIN_RAPIDO está desligado" vira
  **"a rota de login sem senha não existe"** — `POST /api/auth/login-rapido` → **404**,
  agora incondicionalmente (é o 404 natural do Express para rota desconhecida).
- O assert `info.loginRapido === false` vira **`assert.ok(!('loginRapido' in info))`** —
  o campo não deve nem existir na resposta de `/setup-necessario`.

Esses testes são a prova permanente de que a porta não volta.

---

## 2. Redesign da tela de login — identidade Código Vencedor

### 2.1 Direção visual (referência: landing de codigovencedor.com)

A landing do produto define a linguagem: **fundo preto absoluto**, tipografia display
branca com destaques em **dourado**, o CTA principal em **pílula com gradiente
vermelho** (`QUERO VENCER`), e a assinatura gráfica **`///`** (três barras inclinadas
douradas) ao lado do wordmark.

Os tokens JÁ EXISTEM em `public/app.css` — usar, não recriar:

| Token/classe | Valor | Uso na tela |
|---|---|---|
| `--ink` | `#0A0A0B` | fundo da página |
| `--brand-gold` / `--amber` | `#E5B94E` | destaques, links, foco, `///` |
| `.btn-cta` | gradiente `#FF2D55 → #E01B41` | **botão Entrar** (ação principal, pílula, como na landing) |
| `.auth-brand` | preto escopado p/ telas de auth | aplicar no `<body>` do login (hoje só definir-senha usa) |
| `.brand-slash` | as `///` douradas inclinadas | já existe; usar ao lado do nome |
| `--font-display/body/mono` | pilha de sistema | títulos/corpo/código |

**Composição sugerida** (a executora tem liberdade dentro da identidade):

- Card central sobre preto, wordmark + `///` no topo (asset local: criar
  `public/assets/logo.svg` desenhado à mão — NUNCA hotlink da landing).
- Título display branco com uma palavra em dourado (eco da landing: "E se o problema
  **não for sua sorte?**") — ex.: `Entrar no **painel**`.
- Botão Entrar: pílula `.btn-cta` (gradiente vermelho), largura total do card.
- Links secundários ("Esqueci minha senha", "Voltar") em dourado com sublinhado no
  hover — a classe `.auth-link` já existe nesse padrão.
- Estados obrigatórios: erro de credencial (`.auth-alert` existe), sucesso de e-mail
  enviado (`.auth-ok` existe), campo em foco (anel dourado, já padrão), botão em
  estado de carregando (desabilitar + texto "Entrando…" — hoje o login.js já faz isso,
  preservar).

### 2.2 O que a tela já tem e deve ser PRESERVADO (não reescrever a lógica)

`public/login.html` + `public/login.js` já implementam, funcionando e testado:

- Login com e-mail/senha (`POST /api/auth/login`), rate limit no servidor.
- **Modo "Esqueci minha senha"** — o link `#linkEsqueci` alterna a mesma tela para o
  modo de recuperação (`POST /api/auth/esqueci-senha`), com resposta idêntica para
  e-mail existente e inexistente (anti-enumeração — NÃO mudar essa copy para algo
  como "e-mail não encontrado").
- **Modo primeiro acesso** (`/api/auth/setup-necessario` → cria o primeiro admin).
- Redirecionamento pós-login para `/painel`.

`public/definir-senha.html` + `definir-senha.js` já implementam a **rota de
redefinição** (`/definir-senha?token=...`): validação do token, medidor de força
(fraca/média/forte), botão mostrar/ocultar senha (`.pw-toggle`), confirmação, e-mail
de aviso com IP/hora. O trabalho aqui é só **alinhar o visual** ao novo login
(mesma composição de card, mesmo botão `.btn-cta`).

Ou seja: "ter esqueci minha senha" e "ter uma rota pra redefinir senha" = **retrabalho
visual sobre fluxos prontos**, não desenvolvimento de fluxo novo.

---

## 3. Funcionalidades novas na tela de login

### 3.1 Olhinho (mostrar/ocultar senha)

Já existe o padrão pronto na tela de definir senha — **replicar, não reinventar**:

- HTML: envolver o input em `.pw-wrap` e acrescentar o botão `.pw-toggle`
  (ver `public/definir-senha.html:52-58` como modelo).
- CSS: `.pw-wrap`/`.pw-toggle` já existem em `app.css` (dourado da marca) — zero CSS novo.
- JS (em `login.js`, nunca inline): alternar `type` entre `password`↔`text`;
  atualizar o rótulo do botão ("Mostrar"/"Ocultar") e `aria-pressed`; não roubar o
  foco do input. Copiar a lógica de `definir-senha.js`.

### 3.2 "Lembrar" — REGRA DE SEGURANÇA INEGOCIÁVEL

O pedido é "opção de lembrar a senha". A implementação correta tem duas metades, e
uma proibição absoluta:

**PROIBIDO:** gravar a senha (ou qualquer derivado dela) em localStorage, cookie
legível, sessionStorage ou variável persistida. Se a implementação final tiver a
senha em qualquer storage do navegador, está errada e será rejeitada.

**Metade A — gerenciador de senhas do navegador (custo zero):** os atributos
`autocomplete="username"` / `autocomplete="current-password"` já estão corretos no
HTML (conferido) — o Chrome/Safari/Firefox já oferecem salvar a senha. Manter os
atributos intactos no redesign; é isso que "lembra a senha" com segurança.

**Metade B — checkbox "Manter conectado por 30 dias" (persistência de sessão):**

| Camada | Mudança |
|---|---|
| `src/db/repos/users.js` (~linha 192) | `createSession(userId, { userAgent, ip, ttlHours })` — aceitar TTL opcional; default continua `env.SESSION_TTL_HOURS` (12h) |
| `src/admin/auth.js` (rota `POST /login`, ~linha 159) | ler `remember` (boolean) do body; se `true`, chamar `createSession` com `ttlHours: 720` (30 dias) |
| `public/login.html` | checkbox estilizado "Manter conectado por 30 dias" entre a senha e o botão |
| `public/login.js` | enviar `remember` no body do login |
| Cookie | nada a fazer além do que existe: `setSessionCookie` já usa o `expiresAt` da sessão (HttpOnly, SameSite; `Secure` em https) |
| Teste novo | login com `remember: true` → sessão no banco com `expires_at` ~30 dias; sem `remember` → ~12h |

Opcional barato (aprovado): lembrar o **e-mail** digitado em `localStorage`
(`tk_last_email`) e pré-preencher no retorno — e-mail não é segredo; senha jamais.

---

## 4. Critérios de aceite da Parte 1 (a executora entrega esta lista verificada)

- [ ] `grep -ri "login.rapido\|loginRapido\|LOGIN_RAPIDO" src/ public/ test/ *.yml .env*`
      devolve **zero** ocorrências (docs podem citar como histórico).
- [ ] `POST /api/auth/login-rapido` → 404; `/setup-necessario` sem o campo `loginRapido`.
- [ ] Tela de login na identidade CV: preto `--ink`, dourado só como acento, botão
      Entrar em `.btn-cta` (gradiente vermelho), sem hex fora dos tokens.
- [ ] Nenhum `<script>` inline, nenhum recurso externo, nenhuma fonte remota
      (asserções existentes da suíte continuam verdes).
- [ ] Olhinho funcionando no login E no definir-senha, com `aria-pressed`.
- [ ] Checkbox "Manter conectado": sessão de 30 dias com ele, 12h sem ele (teste novo).
- [ ] Senha ausente de qualquer storage do navegador (inspeção manual: Application →
      Local/Session Storage e Cookies após login com o checkbox marcado).
- [ ] Fluxo esqueci-senha: mesma resposta visual para e-mail existente/inexistente.
- [ ] `/definir-senha` visualmente alinhada à nova tela de login.
- [ ] `npm test` — suíte inteira verde, incluindo os dois testes reescritos (§1.2) e o
      teste novo do remember.
- [ ] Mobile 390px: sem overflow horizontal; card ocupa a largura útil.

## 5. O que a executora NÃO deve fazer

- Não adicionar framework, bundler, biblioteca de UI ou fonte externa.
- Não tocar na CSP, nos cabeçalhos de segurança nem no `no-store` da API.
- Não alterar as rotas/contratos de `auth.js` além do parâmetro `remember`.
- Não mudar a copy anti-enumeração do esqueci-senha.
- Não remover testes — atualizar os dois do login rápido e somar o do remember.
- Não copiar imagens/fontes da landing por URL — assets são locais e autorais.
- Não versionar `.env`/`.env.producao` (o `.gitignore` já cobre; não "consertar").

---

# PARTE 2 — Runbook operacional (humano, roda DEPOIS da Parte 1)

Resumo do plano anterior, que continua válido (detalhes nas fases B–D da versão
2026-08-13 anterior deste documento, incorporadas aqui):

1. **Admin master:** `binho_captiva@hotmail.com`. A senha é **forte, gerada
   aleatoriamente** (16 caracteres, sem caracteres ambíguos) e vive em exatamente dois
   lugares: o `ADMIN_PASSWORD` dos arquivos `.env` / `.env.producao` (ambos fora do git
   pelo `.gitignore` `.env.*`) e o gerenciador de senhas do dono. **Nunca escreva o
   valor neste documento nem em qualquer arquivo versionado.** Para aplicar com banco
   já populado: `docker compose run --rm api npm run criar-usuario -- binho_captiva@hotmail.com "<senha do .env>"`.
   Em produção o primeiro boot cria sozinho (`bootstrapAdmin`, só com banco vazio).
2. **Não há senha descartável de bootstrap.** A decisão anterior (`Mudar@123` + troca
   obrigatória) foi substituída em 2026-08-13: como a senha já nasce forte e só o dono
   a conhece, não existe janela de exposição a fechar. Trocar continua possível a
   qualquer momento pelo fluxo "Esqueci minha senha" — que segue sendo verificado na
   lista de evidências abaixo, agora como teste do fluxo e não como correção de risco.
3. **Verificação de e-mail (8 evidências):** convite chega e loga; reset chega (2h);
   e-mail inexistente = resposta idêntica; reenvio de convite mata o link anterior;
   troca de senha derruba sessões antigas e notifica; SMTP fora → painel exibe o
   link de convite para repasse manual.
4. **Gestão pelo master (7 verificações):** convidar (admin/operador), reenviar,
   excluir com confirmação inline, travas (não se auto-remove, não remove/rebaixa o
   último admin → 400), operador chamando rota de admin → 403.
5. **Backlog opcional** (decidir depois): troca obrigatória no 1º login, "alterar
   senha" logado, mínimo de senha > 8, e-mail transacional dedicado.
