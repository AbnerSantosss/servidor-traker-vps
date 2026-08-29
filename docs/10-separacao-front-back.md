---
title: Separação entre front-end e back-end
tags: [arquitetura, seguranca, painel, csp, cors]
created: 2026-08-12
updated: 2026-08-12
---

# Separação entre front-end e back-end

Requisito do projeto: **o painel e a API são camadas independentes, e nada sensível pode vazar para o navegador.** Este documento explica como isso é garantido — e como verificar que continua valendo depois de qualquer alteração.

---

## 1. O que "separado" significa aqui

O painel é um **cliente estático burro**. Ele não é gerado pelo servidor: são arquivos `.html`, `.css` e `.js` fixos, que ao abrir buscam tudo pela API. O servidor nunca injeta dado nenhum dentro do HTML.

```
public/                          src/
├── admin.html   ─┐              ├── admin/router.js    ─┐
├── admin/*.js    │  arquivos    ├── admin/usuarios.js   │  API JSON
├── estilos/*.css ├─ estáticos,  ├── admin/auth.js       ├─ sob /api,
├── vendor/*.js   │  sem dado    ├── ingest/…            │  autenticada
├── login.html    │              └── destinations/…     ─┘
├── login.js      │
├── definir-senha.html
└── app.css      ─┘
        │                                  ▲
        └──── fetch('/api/...') ────────────┘
```

A consequência prática: **`view-source` de qualquer página do painel não mostra nem um dado de cliente.** Só marcação vazia. Todo conteúdo aparece depois, via chamada autenticada.

Isso não é detalhe de estilo. Se o servidor renderizasse o HTML já com os dados, cada página viraria um lugar a mais onde um segredo poderia escapar — em cache do navegador, no histórico, num print de tela, num log de proxy.

---

## 2. Hospedar o painel em outro servidor

Por padrão a mesma aplicação serve os arquivos estáticos e a API, porque é um deploy só e menos coisa para operar. Mas a separação é real: para publicar o painel em outro lugar (um bucket, um CDN, outro host), basta

1. publicar o conteúdo de `public/` nesse outro lugar;
2. definir no servidor:

```
PANEL_ORIGINS=https://painel.codigovencedor.com
```

Nenhuma linha de código muda. O que a variável liga:

| Sem `PANEL_ORIGINS` (padrão) | Com `PANEL_ORIGINS` |
|---|---|
| Sem cabeçalhos de CORS — mesma origem, não precisa | CORS liberado **só** para as origens listadas, com credenciais |
| Cookie de sessão `SameSite=Lax` | Cookie `SameSite=None; Secure` (exigência do navegador para cross-site) |
| CSRF barrado pelo próprio `SameSite` | CSRF barrado pelo cabeçalho `X-Traker-Painel` exigido em toda escrita |

A troca de proteção contra CSRF é o detalhe que costuma ser esquecido: `SameSite=None` abre mão da defesa que o navegador dava de graça, então ela precisa ser reposta. O cabeçalho resolve porque um formulário HTML de outro site **não consegue** enviar cabeçalho customizado — só `fetch`/XHR consegue, e aí o CORS já barra a origem não autorizada.

> Nota: o CORS da **ingestão** (`/e/:slug`, `/c/:slug`) é outra coisa e continua aberto por natureza — eventos chegam de qualquer site de cliente. Quem restringe ali é `allowed_origins` por projeto. Ver [`07-referencia-api.md`](07-referencia-api.md).

---

## 3. O que nunca chega ao navegador

| Dado | Como é tratado |
|---|---|
| `access_token` da Meta, `api_secret` do GA4, `client_secret` / `refresh_token` / `developer_token` do Google Ads | Nunca saem da API. O painel recebe só as flags `hasAccessToken`, `hasApiSecret`, `hasRefreshToken`… |
| Token de webhook (`ingestToken`) | **Não** acompanha o payload do projeto. O projeto traz só `temIngestToken: true`. O valor sai por `GET /api/projects/:id/ingest-token`, restrito a admin e registrado em log |
| Senhas | Nunca trafegam de volta. Convite não manda senha provisória: o convidado define a dele |
| Token de sessão | Cookie `HttpOnly` — JavaScript nenhum consegue ler |
| Erro interno (SQL, stack) | Respostas 5xx devolvem só `{"error":"erro interno"}`; o detalhe fica no log do servidor |

**Nenhuma resposta da API pode ser cacheada.** Todas saem com `Cache-Control: no-store, no-cache, must-revalidate, private`. Sem isso, a resposta de um endpoint sensível poderia sobreviver ao logout no cache de disco do navegador.

---

## 4. Content-Security-Policy

As páginas do painel são servidas com:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'self' <origens do painel>;
form-action 'self';
base-uri 'none';
frame-ancestors 'none';
object-src 'none';
```

O que cada escolha compra:

- **`script-src 'self'`** — nenhum script inline e nenhum script de outro domínio executa. É o que transforma um eventual XSS de "roubo de sessão" em "nada acontece": mesmo conseguindo injetar código, o atacante não consegue carregá-lo nem enviar dado para fora. **Isto só funciona porque não existe JavaScript inline nas páginas** — todo script vive em arquivo próprio. Manter assim é requisito, não preferência.
- **`connect-src`** limitado — mesmo um script malicioso não conseguiria exfiltrar dado para um servidor de terceiro.
- **`frame-ancestors 'none'`** (+ `X-Frame-Options: DENY`) — o painel não pode ser embutido em iframe, o que elimina clickjacking.
- **`style-src` com `'unsafe-inline'`** — a única concessão. A marcação usa atributos `style=` à vontade; injeção de estilo é um risco muito menor que injeção de script.
- **`font-src 'self'`** — nenhuma fonte externa. As páginas **não carregam Google Fonts**: cada abertura do painel seria uma requisição contando a um terceiro quem está usando a ferramenta e de onde. A tipografia usa a cadeia de fallback local.

---

## 5. Como verificar que continua valendo

A suíte de testes cobre isso — não é documentação que envelhece sozinha. Em `test/integracao.test.js`, o bloco *"separação entre painel e API"* falha se alguém:

- devolver o `ingestToken` no payload do projeto;
- esquecer o `no-store` em alguma resposta da API;
- afrouxar a CSP;
- adicionar um `<script>` inline em qualquer página;
- adicionar qualquer recurso de terceiro (`https://…`) no HTML;
- deixar um segredo aparecer no HTML servido.

Verificação manual rápida:

```bash
# nenhum recurso externo, nenhum script inline
curl -s https://traker.codigovencedor.com/painel | grep -E 'src="https?://|<script>'

# cabeçalhos de segurança
curl -sI https://traker.codigovencedor.com/painel | grep -i 'content-security-policy\|x-frame-options'

# a API não cacheia
curl -sI https://traker.codigovencedor.com/api/auth/me | grep -i cache-control
```

Os três devem sair como esperado: o primeiro sem nenhuma saída, os outros dois com os cabeçalhos presentes.

---

## 6. O que ainda não está fechado

Honestidade sobre os limites atuais:

- **Não há token CSRF por sessão.** No modo padrão (mesma origem), `SameSite=Lax` cobre; no modo separado, o cabeçalho cobre. Um token por sessão seria mais forte, e continua na dívida técnica.
- **`users.role` é global, não por projeto.** Um operador enxerga todos os projetos. Se um dia houver clientes distintos com operadores distintos, será preciso escopo por projeto.
- **O painel confia no servidor para esconder o que operador não pode ver.** Isso está certo — a verificação real é no `requireAdmin` do servidor, e o teste comprova que um operador chamando a rota na mão recebe 403. Esconder botão é conveniência, não segurança.

---

Ver também: [`09-usuarios-e-email.md`](09-usuarios-e-email.md) (papéis e convites) e [`01-arquitetura.md`](01-arquitetura.md) (arquitetura geral).
