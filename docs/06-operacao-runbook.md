---
title: Runbook de operação do Servidor Traker
tags: [infra, operacao, runbook, monitoramento, lgpd, incidente, servidor-traker]
created: 2026-08-12
updated: 2026-08-12
---

# Runbook de operação do Servidor Traker

Documento de plantão: o que olhar no dia a dia e o que fazer quando algo quebra.
Se você chegou aqui no meio de um incidente, pule direto para a **seção 7 (Checklist de
incidente)** e volte depois para entender o resto.

Todos os comandos pressupõem que você está conectado na VM por SSH e dentro do diretório do
projeto:

```bash
ssh ubuntu@IP_DO_SERVIDOR
cd /opt/servidor-traker
```

---

## 1. Os quatro serviços e o que cada um faz

```
Internet ──► caddy ──► api ──► db ◄── worker ──► Meta CAPI / Google Ads
                                            (lê a fila e entrega)
```

| Serviço | Responsabilidade | Se cair, o que acontece |
|---|---|---|
| `caddy` | TLS, redirect HTTP→HTTPS, proxy para a `api` | **Site inteiro fora.** Nada entra. |
| `api` | Recebe `/e/:slug` e `/c/:slug`, serve `/s/:slug.js`, painel e `/api/*`. Grava o evento e enfileira as entregas. | Eventos param de ser **recebidos** (e são perdidos — o navegador não reenvia). |
| `worker` | Consome a fila em `deliveries` e chama as APIs de destino | Eventos continuam sendo **recebidos e guardados**, só param de ser **entregues**. A fila acumula e drena sozinha quando o worker volta. |
| `db` | PostgreSQL 16: dados, credenciais cifradas e a própria fila | Tudo para. `api` e `worker` entram em erro. |

Diferença que importa em incidente: **`api` fora = perda de dados. `worker` fora = atraso.**
Se precisar priorizar, a `api` vem primeiro.

**Sobre a fila:** não há Redis. O worker faz `SELECT ... FOR UPDATE SKIP LOCKED` na tabela
`deliveries`, o que permite vários workers em paralelo sem pegar a mesma linha duas vezes.
A consequência prática boa: **a fila é inspecionável com SQL** — é o que a seção 3 explora.

---

## 2. Ler os logs

### Comandos essenciais

```bash
docker compose ps                          # o que está de pé
docker compose logs -f api                 # acompanhar ao vivo (Ctrl+C sai)
docker compose logs --tail=200 worker      # últimas 200 linhas
docker compose logs --since=30m api        # últimos 30 minutos
docker compose logs --since=2026-08-12T14:00:00 api
docker compose logs                        # todos os serviços juntos, em ordem cronológica
```

O último é subestimado: ver `api`, `worker` e `caddy` intercalados no tempo é o que revela
causa e efeito em incidente.

### Filtrar o que interessa

```bash
docker compose logs api | grep -i error | tail -40
docker compose logs worker | grep -iE "fail|erro|retry|dead" | tail -40
docker compose logs caddy | grep -iE "certificate|challenge|error"

# Um evento específico, do recebimento até a entrega
docker compose logs | grep "ID_DO_EVENTO"

# Um projeto específico
docker compose logs api | grep "SLUG_DO_PROJETO"
```

### O que é normal e o que não é

| Aparece no log | Interpretação |
|---|---|
| `api` — linhas de request 200/204 em `/e/:slug` | ✅ funcionamento normal |
| `worker` — `delivery success` com `events_received: 1` | ✅ a Meta aceitou |
| `worker` — `retry attempt 2/8` esporádico | ⚠️ normal; a API do destino oscila |
| `worker` — muitos `retry`, sempre no mesmo destino | ❌ credencial ou payload — seção 7.2 |
| `api` — `unknown slug` | ⚠️ GTM configurado com slug errado, ou varredura de bot |
| `api` — `ECONNREFUSED db:5432` | ❌ banco fora |
| `caddy` — `obtained certificate` | ✅ emissão/renovação OK |
| qualquer serviço — `exited with code 137` | ❌ OOM, ficou sem memória |

**Aumentar o detalhe temporariamente** para investigar:

```bash
nano .env          # LOG_LEVEL=debug
docker compose up -d api worker
# ... investigue ...
nano .env          # LOG_LEVEL=info  ← VOLTE. debug em produção enche o disco.
docker compose up -d api worker
```

### Não deixar o log encher o disco

Se ainda não estiver no `docker-compose.yml`, adicione a cada serviço:

```yaml
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"
```

Sem isso, o log do Docker cresce indefinidamente até o disco acabar — e aí a seção 7.4
acontece.

---

## 3. Saúde da fila de entregas

Abrir o banco:

```bash
docker compose exec db psql -U traker -d traker
```

(`\q` sai, `\dt` lista tabelas, `\d deliveries` mostra as colunas.)

Os status possíveis em `deliveries.status`:

| Status | Significado |
|---|---|
| `pending` | na fila, aguardando o worker |
| `success` | entregue e aceito pelo destino |
| `failed` | falhou, mas ainda tem tentativas (`attempts < MAX_ATTEMPTS`) |
| `dead` | esgotou `MAX_ATTEMPTS`. **Dead-letter — exige ação humana.** |
| `skipped_consent` | não enviado por falta de consentimento. Correto, não é erro. |
| `skipped_unmapped` | evento sem mapeamento para aquele destino. Pode ser esperado ou esquecimento de configuração. |

### 3.1 Panorama geral (o comando do dia)

```sql
SELECT status, count(*)
FROM deliveries
WHERE created_at > now() - interval '24 hours'
GROUP BY status
ORDER BY 2 DESC;
```

Leitura: `success` deve dominar. `pending` alto e crescendo = worker parado ou lento.
Qualquer `dead` merece atenção.

### 3.2 Profundidade da fila e o item mais antigo

```sql
SELECT
  count(*) FILTER (WHERE status = 'pending')                AS pendentes,
  count(*) FILTER (WHERE status = 'failed')                 AS falhas_em_retry,
  count(*) FILTER (WHERE status = 'dead')                   AS dead_letter,
  now() - min(created_at) FILTER (WHERE status = 'pending') AS idade_do_mais_antigo
FROM deliveries;
```

**`idade_do_mais_antigo` é a métrica mais informativa deste runbook.** Ela responde direto:
a fila está drenando?

| Idade do mais antigo pendente | Diagnóstico |
|---|---|
| < 1 minuto | ✅ normal |
| 1–10 minutos | ⚠️ pico de volume ou destino lento — observe |
| > 30 minutos | ❌ worker parado, travado, ou destino fora |

### 3.3 Dead-letter: o que morreu e por quê

```sql
SELECT d.id, d.event_id, d.destination_id, d.attempts,
       d.response_code, left(d.last_error, 160) AS erro, d.delivered_at
FROM deliveries d
WHERE d.status = 'dead'
ORDER BY d.id DESC
LIMIT 30;
```

Agrupando por causa — é assim que você descobre se são 200 problemas ou 1 problema 200 vezes:

```sql
SELECT destination_id, response_code, left(last_error, 100) AS erro, count(*)
FROM deliveries
WHERE status = 'dead' AND created_at > now() - interval '7 days'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

Quase sempre são poucos padrões repetidos: token expirado, pixel desativado, campo
obrigatório faltando.

### 3.4 Taxa de sucesso por destino

```sql
SELECT destination_id,
       count(*)                                     AS total,
       count(*) FILTER (WHERE status = 'success')   AS ok,
       round(100.0 * count(*) FILTER (WHERE status = 'success') / nullif(count(*),0), 1) AS pct_ok
FROM deliveries
WHERE created_at > now() - interval '24 hours'
GROUP BY destination_id
ORDER BY pct_ok ASC;
```

Ordenado pelo pior primeiro. Abaixo de 95% em um destino, investigue.

### 3.5 Volume de eventos recebidos

```sql
-- Por hora, últimas 24h
SELECT date_trunc('hour', received_at) AS hora, count(*)
FROM events
WHERE received_at > now() - interval '24 hours'
GROUP BY 1 ORDER BY 1;

-- Por projeto, hoje
SELECT project_id, event_name, count(*)
FROM events
WHERE received_at > current_date
GROUP BY 1, 2 ORDER BY 3 DESC;
```

Compare com o padrão do dia anterior no mesmo horário — queda abrupta é sinal de que o
tracking quebrou no site, não aqui.

### 3.6 Ponte de identidade

```sql
SELECT count(*) AS identidades,
       count(*) FILTER (WHERE last_seen_at > now() - interval '24 hours') AS ativas_24h
FROM identities;

-- Quantas identidades têm fbc/fbp/gclid preenchidos (proxy de qualidade de match)
SELECT
  count(*)                                                    AS total,
  count(*) FILTER (WHERE attrs ? 'fbp')                       AS com_fbp,
  count(*) FILTER (WHERE attrs ? 'fbc')                       AS com_fbc,
  count(*) FILTER (WHERE attrs ? 'gclid')                     AS com_gclid
FROM identities;
```

Se `com_fbc` cair de repente, provavelmente o coletor parou de capturar o `fbclid` na
chegada — o problema está no site do cliente, não no servidor.

### 3.7 Salvar isso como atalho

```bash
cat >> ~/.bashrc <<'EOF'
alias traker-fila='cd /opt/servidor-traker && docker compose exec db psql -U traker -d traker -c "SELECT count(*) FILTER (WHERE status='"'"'pending'"'"') AS pendentes, count(*) FILTER (WHERE status='"'"'failed'"'"') AS falhas, count(*) FILTER (WHERE status='"'"'dead'"'"') AS dead, now() - min(created_at) FILTER (WHERE status='"'"'pending'"'"') AS idade FROM deliveries;"'
EOF
source ~/.bashrc
```

Depois é só digitar `traker-fila`.

---

## 4. Reprocessar entregas com falha

### 4.1 Pelo painel (jeito preferido)

`https://traker.codigovencedor.com/painel` → **Logs de entrega** → filtre por status
`failed` ou `dead` → **Reenviar**.

O reenvio é **idempotente**: `deliveries` tem `UNIQUE (event_id, destination_id)` e o payload
carrega o mesmo `event_id` para a Meta deduplicar. Reenviar não gera conversão duplicada.
Use sem medo.

**Antes de reenviar, corrija a causa.** Reenviar contra um token expirado só gera mais 8
tentativas falhas.

### 4.2 Por SQL (volume grande)

Voltar entregas mortas para a fila = zerar tentativas e marcar como `pending`. O worker pega
sozinho.

```sql
-- SEMPRE veja o tamanho do estrago antes de agir
SELECT count(*) FROM deliveries
WHERE status = 'dead' AND destination_id = 42
  AND created_at > now() - interval '2 days';
```

```sql
-- Reprocessar um destino específico, janela definida
UPDATE deliveries
SET status = 'pending', attempts = 0, last_error = NULL, response_code = NULL
WHERE status = 'dead'
  AND destination_id = 42
  AND created_at > now() - interval '2 days';
```

```sql
-- Reprocessar por causa do erro (ex.: token que já foi renovado)
UPDATE deliveries
SET status = 'pending', attempts = 0, last_error = NULL
WHERE status = 'dead'
  AND last_error ILIKE '%access token%'
  AND created_at > now() - interval '7 days';
```

```sql
-- Uma entrega específica
UPDATE deliveries SET status='pending', attempts=0, last_error=NULL WHERE id = 12345;
```

**Regras de ouro:**

1. Rode o `SELECT count(*)` equivalente antes de cada `UPDATE`.
2. Sempre limite por janela de tempo. Reprocessar meses de dead-letter de uma vez inunda a
   fila e pode bater em rate limit da Meta.
3. **Cuidado com evento antigo:** a Meta rejeita eventos com `event_time` muito no passado
   (a janela prática é de ~7 dias). Reprocessar algo de mês passado só gera falha nova.
4. Depois do `UPDATE`, acompanhe: `docker compose logs -f worker`.

### 4.3 Acelerar a drenagem de um backlog grande

```bash
nano .env         # WORKER_CONCURRENCY=4 → 10
docker compose up -d worker
docker compose logs -f worker
```

`FOR UPDATE SKIP LOCKED` garante que concorrência maior não duplica entrega. Só não exagere:
mais concorrência = mais chance de bater no rate limit da Meta. **Volte ao valor original**
quando a fila esvaziar.

---

## 5. Rotação do `APP_SECRET`

### 5.1 O que ele é, em uma frase

`APP_SECRET` é a chave AES-256-GCM que cifra a coluna `destinations.credentials_enc` — onde
moram os access tokens da Meta, os tokens do Google Ads e os api secrets de todos os
clientes.

**Consequências que você precisa ter internalizadas:**

- **Perdeu o `APP_SECRET` = perdeu todos os tokens.** O banco continua íntegro, mas
  `credentials_enc` vira lixo binário. Cada cliente terá que gerar e cadastrar token novo.
  **Nenhum backup do Postgres resolve isso** — o segredo não está no dump, está no `.env`.
- **Trocar o segredo sem re-cifrar** tem o mesmo efeito de perdê-lo. Não edite essa variável
  "para testar".
- Guarde uma cópia no gerenciador de senhas da empresa. Hoje, se ainda não guardou.

### 5.2 Quando rotacionar

- Suspeita ou confirmação de vazamento (segredo commitado, `.env` exposto, máquina
  comprometida).
- Saída de alguém que tinha acesso ao servidor.
- Política interna de rotação periódica, se houver.

Fora isso, não mexa.

### 5.3 Procedimento

O modelo de dados tem `key_version` em `credentials_enc` justamente para permitir rotação com
duas chaves convivendo. **Rode em janela de baixo tráfego.**

```bash
cd /opt/servidor-traker

# 1. Backup completo. Não negociável.
./backup.sh

# 2. Copie o APP_SECRET ATUAL para um lugar seguro fora do servidor.
grep APP_SECRET .env

# 3. Gere o novo
openssl rand -hex 32
```

```bash
# 4. Configure a chave nova mantendo a antiga disponível para leitura
nano .env
#   APP_SECRET=<NOVO>
#   APP_SECRET_PREVIOUS=<ANTIGO>     ← se a aplicação suportar re-cifra em background

docker compose up -d api worker

# 5. Confira nos logs que a re-cifra rodou e que não há erro de decrypt
docker compose logs api | grep -i "key_version\|rotat\|decrypt"
```

```sql
-- 6. Confirme que nenhuma credencial ficou na versão antiga
SELECT key_version, count(*) FROM destinations GROUP BY key_version;
```

```bash
# 7. Só quando tudo estiver na versão nova, remova APP_SECRET_PREVIOUS
nano .env
docker compose up -d api worker
```

**Validação final obrigatória:** entre no painel, abra um destino de cada cliente e confirme
que o token aparece mascarado corretamente (`EAAB...k2f9`); depois dispare um evento de teste
e veja `success` em `deliveries`. Se aparecer erro de decrypt, **pare, restaure o backup e
volte o `APP_SECRET` antigo**.

> Se a aplicação ainda não implementar `APP_SECRET_PREVIOUS` / re-cifra automática, a rotação
> vira: exportar as credenciais em claro por um script controlado, trocar a chave, re-inserir
> pelo painel. Nesse caso, planeje com o cliente — vale confirmar o suporte no código antes
> de iniciar.

---

## 6. Retenção e expurgo de dados (LGPD)

### 6.1 O que guardamos e por quanto tempo

| Tabela | Conteúdo | Retenção |
|---|---|---|
| `events` | payload do evento (PII hasheada/mascarada), consentimento | `RETENTION_DAYS` (padrão 90) |
| `deliveries` | resultado de cada entrega por destino | acompanha `events` |
| `identities` | ponte de identidade por `user_key` (fbp, fbc, gclid, utm) | enquanto o projeto existir — é o ativo de match |

A base legal e a finalidade são responsabilidade do cliente (controlador); nós somos
**operador**. Na prática, isso significa duas obrigações técnicas: **respeitar o prazo de
retenção** e **conseguir excluir os dados de um titular quando solicitado**.

### 6.2 Expurgo por retenção

Se a aplicação tiver rotina automática, ela usa `RETENTION_DAYS`. Para conferir/forçar:

```sql
-- O que está fora da janela?
SELECT count(*), min(received_at), max(received_at)
FROM events
WHERE received_at < now() - interval '90 days';
```

```sql
-- Expurgo (deliveries primeiro, por causa da FK)
BEGIN;
DELETE FROM deliveries
WHERE event_id IN (SELECT id FROM events WHERE received_at < now() - interval '90 days');

DELETE FROM events WHERE received_at < now() - interval '90 days';
COMMIT;
```

Se `events`/`deliveries` forem particionadas por mês, o caminho certo e muito mais barato é
soltar a partição inteira:

```sql
SELECT tablename FROM pg_tables WHERE tablename LIKE 'events_%' ORDER BY 1;
DROP TABLE events_2026_04;   -- confira a data DUAS vezes antes
```

`DROP TABLE` de partição é instantâneo e não gera bloat; `DELETE` em massa exige `VACUUM`
depois:

```bash
docker compose exec db psql -U traker -d traker -c "VACUUM (ANALYZE) events;"
docker compose exec db psql -U traker -d traker -c "VACUUM (ANALYZE) deliveries;"
```

### 6.3 Exclusão a pedido do titular

Quando um cliente encaminhar um pedido de exclusão, você precisa do `user_key` (o `user_id`
que aquele site usa) ou do e-mail hasheado.

```sql
-- 1. Localizar
SELECT id, project_id, user_key, first_seen_at, last_seen_at
FROM identities
WHERE project_id = 7 AND user_key = 'VALOR_DO_USER_ID';
```

```sql
-- 2. Excluir identidade e eventos do titular
BEGIN;
DELETE FROM deliveries
WHERE event_id IN (
  SELECT id FROM events
  WHERE project_id = 7 AND payload->>'user_key' = 'VALOR_DO_USER_ID'
);

DELETE FROM events
WHERE project_id = 7 AND payload->>'user_key' = 'VALOR_DO_USER_ID';

DELETE FROM identities
WHERE project_id = 7 AND user_key = 'VALOR_DO_USER_ID';
COMMIT;
```

Sempre com `project_id` na cláusula — sem ele, você pode apagar o titular homônimo de outro
cliente.

**Registre**: data, solicitante, `project_id`, `user_key` e quantas linhas foram removidas.
Guarde fora do banco (o registro precisa sobreviver ao expurgo). E lembre que o dado já
enviado à Meta/Google não some com isso — a exclusão lá é solicitada pelo cliente nas
ferramentas do próprio destino.

### 6.4 Consentimento

Eventos com status `skipped_consent` **não foram enviados** — é o comportamento correto. Se
esse número for alto demais em um projeto, o problema geralmente é integração de CMP
(banner de cookies) mandando sinal errado, não o servidor.

```sql
SELECT project_id, count(*)
FROM deliveries
WHERE status = 'skipped_consent' AND created_at > now() - interval '7 days'
GROUP BY 1 ORDER BY 2 DESC;
```

---

## 7. Checklist de incidente

### 7.1 "Os eventos pararam de chegar"

**Sintoma:** volume em `events` despencou ou zerou; cliente reclama que não vê conversão.

```sql
-- 1. Confirmar o buraco
SELECT date_trunc('hour', received_at) AS hora, count(*)
FROM events WHERE received_at > now() - interval '6 hours'
GROUP BY 1 ORDER BY 1;
```

Se **zerou para todos os projetos**, o problema é nosso. Se **caiu só em um projeto**, o
problema está no site daquele cliente.

Se é nosso, siga na ordem (cada passo elimina uma camada):

```bash
# 2. Os containers estão de pé?
docker compose ps

# 3. A app responde por dentro?
curl -i http://localhost:3000/health

# 4. Responde por fora?
curl -i https://traker.codigovencedor.com/health

# 5. Erro nos logs?
docker compose logs --since=1h api | grep -i error | tail -40
```

| Onde falhou | Causa provável | Ação |
|---|---|---|
| passo 2 | container caído/reiniciando | `docker compose logs --tail=200 api`, depois `docker compose up -d` |
| passo 3 ok, passo 4 falha | firewall, DNS ou certificado | seções 7.3 e `02-deploy-oracle-cloud.md` §12.1 |
| passo 3 falha | app ou banco | `docker compose logs db`, seção 7.5 |
| tudo ok, mas sem evento | quebrou do lado do site | ver abaixo |

**Se o servidor está saudável e mesmo assim não chega nada de um projeto:** o slug mudou, o
container do GTM foi despublicado, o consentimento está bloqueando, ou o CNAME do cliente
caiu. Teste do lado de fora:

```bash
curl -i https://traker.codigovencedor.com/s/SLUG_DO_PROJETO.js       # o coletor é servido?
curl -i -X POST https://traker.codigovencedor.com/e/SLUG_DO_PROJETO \
  -H 'Content-Type: application/json' \
  -d '{"event_name":"teste_runbook","event_id":"runbook-001"}'
```

Depois confirme que caiu no banco:

```sql
SELECT * FROM events WHERE event_id = 'runbook-001';
```

### 7.2 "A Meta está retornando erro"

```sql
SELECT response_code, left(last_error, 140) AS erro, count(*)
FROM deliveries
WHERE status IN ('failed','dead') AND created_at > now() - interval '6 hours'
GROUP BY 1,2 ORDER BY 3 DESC;
```

| Código / mensagem | Significado | Ação |
|---|---|---|
| `190` / `OAuthException` / `access token` | token expirado ou revogado | cliente gera novo token no Events Manager → cadastrar no painel → reprocessar (4.2) |
| `100` / `Invalid parameter` | payload malformado ou campo obrigatório faltando | ver `last_error`; ajustar mapeamento no painel |
| `200` / `permissions` | app/usuário sem permissão no pixel | cliente precisa reconceder acesso |
| `HTTP 400` com `Missing user data` | evento sem sinal de match | é qualidade de dado — ver `identities` (3.6) |
| `HTTP 429` | rate limit | reduzir `WORKER_CONCURRENCY`, esperar, reprocessar depois |
| `HTTP 500/503` | instabilidade do lado da Meta | não faça nada; o retry com backoff resolve |
| timeout / `ETIMEDOUT` | rede ou destino lento | se persistir, checar saída da VM: `curl -I https://graph.facebook.com` |

**Regra:** `4xx` = problema nosso ou de configuração → exige ação. `5xx` e `429` = problema
deles → o retry resolve, não mexa.

Depois de corrigir, confirme no **Test Events** do Events Manager (com `test_event_code`
configurado no destino) antes de reprocessar o backlog inteiro.

### 7.3 "O certificado expirou"

Não deveria acontecer — o Caddy renova ~30 dias antes. Se aconteceu, algo bloqueou a
renovação por um mês inteiro.

```bash
# 1. Confirmar
echo | openssl s_client -servername traker.codigovencedor.com \
  -connect traker.codigovencedor.com:443 2>/dev/null | openssl x509 -noout -dates

# 2. O que o Caddy tentou?
docker compose logs caddy | grep -iE "certificate|challenge|error|renew" | tail -60
```

Causas, em ordem de frequência:

1. **Porta 80 fechou.** É quase sempre isso. Alguém mexeu no firewall, ou um reboot subiu
   sem as regras persistidas. O desafio HTTP-01 entra pela 80.
   ```bash
   sudo iptables -L INPUT -n --line-numbers | grep -E "dpt:(80|443)|REJECT"
   nc -vz traker.codigovencedor.com 80      # rode do SEU computador, não da VM
   ```
   Correção: `02-deploy-oracle-cloud.md` §3.2 — e não esqueça do `netfilter-persistent save`.
2. **DNS mudou ou o IP mudou.** `dig +short traker.codigovencedor.com` tem que bater com o IP
   da VM (`curl -s ifconfig.me` rodado na VM).
3. **Volume `caddy_data` foi apagado.** Perdeu conta ACME e certificados. Ele reemite, mas
   pode esbarrar em rate limit.
4. **Rate limit da Let's Encrypt.** Log diz `too many` — só esperando.

Depois de corrigir a causa, force:

```bash
docker compose restart caddy
docker compose logs -f caddy      # acompanhe até ver "obtained certificate"
```

**Enquanto estiver expirado, o navegador bloqueia as requisições do coletor** — ou seja,
certificado vencido = perda de eventos em tempo real, não só um aviso feio. Trate como P1.

### 7.4 "Disco cheio"

```bash
df -h                    # onde acabou
docker system df         # quanto é do Docker
du -sh /var/lib/docker/volumes/* 2>/dev/null | sort -h | tail
du -sh /opt/backups
```

Alívio imediato, do mais seguro para o menos:

```bash
docker image prune -a -f
docker builder prune -f
sudo journalctl --vacuum-time=7d
find /opt/backups -name 'traker_*.sql.gz' -mtime +7 -delete
sudo truncate -s 0 $(docker inspect --format='{{.LogPath}}' $(docker compose ps -q api))
```

⛔ **Nunca** rode `docker system prune --volumes` — `pgdata` é um volume, e você apagaria o
banco.

Se quem cresceu foi o banco:

```sql
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS tamanho
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;
```

Aí a solução estrutural é a seção 6 (expurgo/retenção) — e, se for recorrente, aumentar o
boot volume na console da OCI e rodar:

```bash
sudo /usr/libexec/oci-growfs -y      # expande o filesystem após aumentar o volume na console
```

**Prevenção:** limite de log no compose (seção 2), rotina de expurgo ativa, e um alerta em
80% de uso.

### 7.5 "O banco não conecta"

```bash
docker compose ps db
docker compose logs --tail=80 db
docker compose exec db pg_isready -U traker
docker compose exec db psql -U traker -d traker -c "SELECT now();"
```

| Sintoma | Causa | Ação |
|---|---|---|
| `pg_isready` recusa | container subindo ainda | espere 30s |
| `password authentication failed` | `POSTGRES_PASSWORD` mudou no `.env` depois da criação do volume | `02-deploy-oracle-cloud.md` §12.4 |
| `too many connections` | pool vazando ou concorrência alta demais | `docker compose restart api worker`; revisar `WORKER_CONCURRENCY` |
| `no space left on device` | disco | seção 7.4 |
| `PANIC: could not write` | disco ou corrupção | restore (`02-deploy-oracle-cloud.md` §10.4) |

Conexões abertas no momento:

```sql
SELECT count(*), state FROM pg_stat_activity GROUP BY state;
```

### 7.6 Ordem de restart segura

Do menos ao mais invasivo — pare assim que resolver:

```bash
docker compose restart worker            # 1. mais barato: só atrasa a fila
docker compose restart api               # 2. derruba requisições em voo
docker compose restart caddy             # 3. site fora por alguns segundos
docker compose down && docker compose up -d   # 4. tudo (dados nos volumes permanecem)
sudo reboot                              # 5. último recurso
```

Depois de um reboot da VM, **confirme que os containers voltaram** (precisam de
`restart: unless-stopped` no compose) e que o firewall persistiu:

```bash
docker compose ps
sudo iptables -L INPUT -n | grep -E "dpt:(80|443)"
curl -i https://traker.codigovencedor.com/health
```

---

## 8. Métricas e alertas mínimos

Não vale montar Prometheus + Grafana agora. Vale ter **poucos sinais confiáveis**, porque um
alerta que ninguém confia é ruído — e ruído é a razão pela qual alertas reais são ignorados.

### 8.1 As cinco métricas que importam

| # | Métrica | Como obter | Alerta quando |
|---|---|---|---|
| 1 | **Idade do pendente mais antigo** | query 3.2 | > 15 min |
| 2 | **Taxa de sucesso por destino (1h)** | query 3.4 | < 95% |
| 3 | **Eventos recebidos por hora** | query 3.5 | queda > 60% vs. mesma hora do dia anterior |
| 4 | **Dead-letter novos (24h)** | `status='dead'` | > 0 (comece assim; ajuste se for barulhento) |
| 5 | **Uso de disco** | `df -h` | > 80% |

A #1 e a #3 pegam quase todo incidente real. Se só der para acompanhar duas, são essas.

Complementares (baratas, valem o esforço):

- **Uptime externo** do `/health` — um monitor gratuito (UptimeRobot e similares) batendo a
  cada 5 min já cobre "o site caiu" e "o certificado venceu" de uma vez, e avisa **de fora**,
  que é justamente o ponto de vista que falta quando o problema é firewall/DNS.
- **Validade do certificado** — alerta em < 20 dias.
- **Backup do dia anterior existe e tem tamanho plausível.**

### 8.2 Script simples de verificação diária

```bash
nano /opt/servidor-traker/checkup.sh
```

```bash
#!/usr/bin/env bash
cd /opt/servidor-traker

echo "=== $(date '+%F %T') ==="

echo "--- Containers ---"
docker compose ps --format 'table {{.Service}}\t{{.Status}}'

echo "--- Fila ---"
docker compose exec -T db psql -U traker -d traker -qtA -c "
SELECT 'pendentes=' || count(*) FILTER (WHERE status='pending')
    || ' falhas='   || count(*) FILTER (WHERE status='failed')
    || ' dead='     || count(*) FILTER (WHERE status='dead')
    || ' idade='    || coalesce((now() - min(created_at) FILTER (WHERE status='pending'))::text,'-')
FROM deliveries;"

echo "--- Eventos na última hora ---"
docker compose exec -T db psql -U traker -d traker -qtA -c "
SELECT count(*) FROM events WHERE received_at > now() - interval '1 hour';"

echo "--- Disco ---"
df -h / | tail -1

echo "--- Certificado ---"
echo | openssl s_client -servername traker.codigovencedor.com \
  -connect traker.codigovencedor.com:443 2>/dev/null | openssl x509 -noout -enddate

echo "--- Último backup ---"
ls -lht /opt/backups | head -2
```

```bash
chmod +x /opt/servidor-traker/checkup.sh
/opt/servidor-traker/checkup.sh
```

Agende para receber por e-mail (se houver MTA configurado) ou só rode manualmente na segunda
de manhã:

```
0 8 * * 1-5 /opt/servidor-traker/checkup.sh >> /var/log/traker-checkup.log 2>&1
```

### 8.3 Ritmo sugerido

| Frequência | O que |
|---|---|
| **Diário** (2 min) | `checkup.sh` — fila, volume, disco |
| **Semanal** (10 min) | dead-letter por causa (3.3), taxa de sucesso por destino (3.4), conferir que o backup do dia existe |
| **Mensal** (30 min) | testar restore num ambiente descartável, revisar retenção, `docker image prune`, aplicar updates do Ubuntu (`sudo apt-get update && sudo apt-get upgrade`) |
| **Trimestral** | revisar quem tem acesso SSH e ao painel; conferir que o `APP_SECRET` está no gerenciador de senhas da empresa |

---

## Ver também

- `02-deploy-oracle-cloud.md` — instalação, firewall, backup/restore, atualização.
- `03-dns-tls-subdominio.md` — DNS e certificado em detalhe.
