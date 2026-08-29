---
title: Usuários, papéis e e-mail transacional
tags: [painel, autenticacao, usuarios, email, smtp, seguranca]
created: 2026-08-12
updated: 2026-08-12
---

# Usuários, papéis e e-mail transacional

Como funciona o acesso ao painel: quem entra, o que cada um pode fazer, e como o sistema convida e recupera contas por e-mail.

---

## 1. Papéis

Existem dois, e a diferença entre eles é uma só pergunta: **essa pessoa pode ver e alterar credenciais de conta de anúncio?**

| | `admin` | `operador` |
|---|---|---|
| Dashboard, EMQ, logs de eventos | ✅ | ✅ |
| Aba Instalação (snippets, slug, token de webhook) | ✅ | ✅ |
| Domínios first-party | ✅ | ✅ |
| Credenciais Meta / Google / Postback | ✅ | ❌ |
| Convidar, promover e remover usuários | ✅ | ❌ |

O papel é verificado **no servidor** (`requireAdmin`), não só escondendo botões no painel: um operador que chame `GET /api/usuarios` na mão recebe **403**.

Duas travas existem para o sistema não ficar inacessível:
- ninguém remove a própria conta;
- não é possível remover **nem rebaixar** o último administrador.

Sem elas, um clique errado deixaria o sistema sem ninguém capaz de gerenciar usuários, e o conserto seria SQL na mão no banco.

---

## 2. Como um usuário novo entra

O fluxo é de **convite**, não de "criar com senha provisória". A diferença importa: senha que trafega por e-mail vaza — fica na caixa de entrada, no histórico, no backup do provedor.

```
Admin cadastra e-mail + papel
        │
        ▼
Servidor cria o usuário SEM senha  ──►  status: convite_pendente
        │                               (não consegue entrar)
        ▼
Gera token de uso único (72h)  ──►  guarda só o SHA-256 no banco
        │
        ▼
E-mail com link  →  /definir-senha?token=…
        │
        ▼
Convidado define a própria senha  ──►  status: ativo
        │                               sessão criada na hora
        ▼
E-mail de confirmação "sua senha foi definida"
```

**Se o e-mail não sair** (SMTP fora do ar, provedor bloqueando), a API devolve `conviteEnviado: false` junto com o campo `urlConvite`, e o painel mostra o link para o admin repassar por outro canal. O convite nunca fica preso numa falha de e-mail.

**Reenviar convite** gera um token novo e **invalida o anterior** — dois links válidos para a mesma conta seriam duas portas para o mesmo acesso.

---

## 3. Redefinição de senha

Disponível em `/login` → "Esqueci minha senha".

Três decisões de segurança que valem ser explicadas, porque parecem defeito:

1. **A resposta é sempre a mesma**, exista o e-mail ou não (`{ok: true}`). Se respondêssemos "e-mail não cadastrado", a tela viraria um verificador de quem tem conta.
2. **O link vale 2 horas**, bem menos que o convite (72h). A janela curta é justamente o ponto: é o tempo em que um e-mail interceptado ainda serve para alguma coisa.
3. **Definir senha nova derruba todas as outras sessões** daquele usuário. Se a troca foi feita por suspeita de invasão, manter a sessão do invasor aberta anularia o efeito.

O usuário sempre recebe um e-mail de confirmação depois da troca, com data, hora e IP — é assim que ele descobre uma alteração que não fez.

---

## 4. Onde ficam os segredos

| Item | Onde vive | Forma |
|---|---|---|
| Senha do usuário | `users.password_hash` | scrypt com sal aleatório |
| Sessão | `sessions.token_hash` | SHA-256 do token; o valor real só existe no cookie |
| Convite / redefinição | `user_tokens.token_hash` | SHA-256; o valor real só existe no link do e-mail |
| Senha de app do SMTP | variável de ambiente | nunca no banco, nunca no código |

Um dump do banco **não** permite assumir a conta de ninguém nem reaproveitar links de convite.

O cookie de sessão é `HttpOnly` + `SameSite=Lax` + `Secure` (em HTTPS): JavaScript de página nenhuma consegue lê-lo.

---

## 5. Configuração do e-mail

Provedor atual: **Gmail com senha de app**. Variáveis no `.env`:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=notificacoes010@gmail.com
SMTP_PASS=senha-de-app-de-16-caracteres
SMTP_FROM="Servidor Traker <notificacoes010@gmail.com>"
CONVITE_TTL_HORAS=72
RESET_TTL_HORAS=2
```

### Como gerar a senha de app

1. Conta Google → **Segurança**
2. **Verificação em duas etapas** precisa estar **ativa** (sem isso a opção não aparece)
3. **Senhas de app** → criar → copiar os 16 caracteres

A senha é exibida com espaços; pode colar com ou sem — o código remove.

> **Segurança:** uma senha de app dá acesso **total** à conta Google, não só ao envio de e-mail. Trate como segredo de produção. Se uma senha de app aparecer em captura de tela, conversa ou chamado, **revogue e gere outra** — leva 30 segundos e é a única forma de fechar a porta.

### Limites e troca de provedor

O Gmail entrega cerca de **500 mensagens por dia** numa conta comum. É folgado para convites e alertas operacionais, e insuficiente para qualquer envio em massa.

Trocar por um provedor transacional (Resend, Amazon SES, Postmark) é só alterar as variáveis `SMTP_*` — nenhuma outra parte do código conhece o provedor. Vale a pena quando os alertas passarem a ser frequentes ou quando a entregabilidade importar (domínio próprio com SPF/DKIM entrega melhor que um Gmail genérico).

### Verificar se está funcionando

```bash
docker compose exec api node -e "import('./src/config/mailer.js').then(m=>m.verificarSmtp().then(console.log))"
```

Resposta esperada: `{ ok: true, host: 'smtp.gmail.com', usuario: '...' }`.

Se vier `Invalid login`, quase sempre é um destes três: verificação em duas etapas desativada, senha da conta usada no lugar da senha de app, ou senha de app revogada.

---

## 6. Os e-mails que o sistema envia

Todos seguem a identidade visual da marca (preto, dourado `#E5B94E`, ação em `#F02649`) e existem em HTML e texto puro.

| E-mail | Para | Quando |
|---|---|---|
| **Convite** | usuário | admin cadastra alguém novo |
| **Redefinir senha** | usuário | pedido em "Esqueci minha senha" |
| **Senha alterada** | usuário | confirmação, com data/hora e IP |
| **Novo usuário no time** | demais admins | alguém foi adicionado |
| **Alerta de entregas** | admins | acúmulo de entregas mortas num destino |

Os dois últimos são **operacionais**: trazem faixa de alerta e dados em tabela, para responder de relance qual projeto, qual destino e quantas conversões podem ter sido perdidas.

Os templates ficam em `src/emails/templates.js`, escritos com tabelas aninhadas e CSS inline — HTML de e-mail não é HTML de site, e cliente de e-mail ignora flexbox, grid e folha de estilo externa.

---

## 7. Se o e-mail parar de funcionar

O sistema **não trava**: nenhuma falha de SMTP derruba cadastro de usuário nem o worker de entregas. O que acontece é:

- **Convite**: a API devolve `urlConvite` e o painel mostra o link para envio manual.
- **Redefinição**: o pedido responde `{ok:true}` normalmente (a resposta é sempre igual, por segurança) e o link não chega. Nesse caso, o admin remove o usuário e convida de novo, ou gera o link direto no banco.
- **Alertas**: ficam só no log da aplicação e na tela de logs do painel.

Para diagnosticar, comece pelo comando de verificação da seção 5 e pelos logs: `docker compose logs api | grep -i email`.

---

Ver também: [`07-referencia-api.md`](07-referencia-api.md) (contratos dos endpoints) e [`06-operacao-runbook.md`](06-operacao-runbook.md) (operação e incidentes).
