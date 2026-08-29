-- 001_init — esquema inicial do Servidor Traker.
--
-- Princípios:
--   * Multi-tenant por linha: toda tabela de dado carrega project_id.
--   * Nenhuma credencial de cliente em variável de ambiente — tudo em `destinations.credentials_enc`,
--     cifrado em nível de aplicação (AES-256-GCM). O banco nunca vê o token em claro.
--   * Idempotência por constraint, não por disciplina de código:
--       events(project_id, event_id, event_name)   -> ingestão duplicada não cria evento novo
--       deliveries(event_row_id, destination_type) -> retry nunca posta duas vezes no mesmo destino
--   * A fila de entrega vive aqui mesmo (deliveries + FOR UPDATE SKIP LOCKED), sem Redis.

-- ---------------------------------------------------------------- usuários e sessões

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- Guardamos o HASH do token de sessão, não o token: vazamento do banco não permite
-- sequestrar sessões ativas.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------- projetos

CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,               -- prj_xxxxxxxxxxxx
  name            TEXT NOT NULL,
  domain          TEXT NOT NULL UNIQUE,           -- site principal (ex.: codigovencedor.com)
  slug            TEXT NOT NULL UNIQUE,           -- caminho curto de ingestão (anti-adblock)
  status          TEXT NOT NULL DEFAULT 'active', -- active | paused
  ingest_token    TEXT NOT NULL,                  -- autentica o webhook server-to-server
  allowed_origins TEXT[] NOT NULL DEFAULT '{}',   -- Origins aceitas no POST do navegador ([] = qualquer)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Domínios first-party que servem este projeto. É a tabela consultada pelo gate de
-- TLS on-demand do Caddy: só emite certificado para hostname aqui e verificado.
CREATE TABLE IF NOT EXISTS project_domains (
  id                  BIGSERIAL PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hostname            TEXT NOT NULL UNIQUE,
  pointing_method     TEXT NOT NULL DEFAULT 'a_record',  -- a_record | cname
  verification_status TEXT NOT NULL DEFAULT 'pending',   -- pending | verified | active | failed
  is_primary          BOOLEAN NOT NULL DEFAULT false,
  last_checked_at     TIMESTAMPTZ,
  last_error          TEXT,
  ssl_issued_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_domains_project_idx ON project_domains (project_id);

-- ---------------------------------------------------------------- destinos

-- Uma linha por destino por projeto. `config` guarda o que é público (pixel_id,
-- measurement_id, mapeamento de eventos); `credentials_enc` guarda os segredos cifrados,
-- no formato { "access_token": "v1:iv:tag:ciphertext", ... }.
CREATE TABLE IF NOT EXISTS destinations (
  id              BIGSERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,                       -- meta | google | postback
  enabled         BOOLEAN NOT NULL DEFAULT false,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  credentials_enc JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, type)
);

-- ---------------------------------------------------------------- ponte de identidade

-- user_id do site -> identificadores de marketing capturados no navegador.
-- É o ativo que permite a uma conversão vinda do backend (que não conhece fbc/fbp)
-- sair com qualidade de match de evento de navegador. Imune a ITP e limpeza de cookie.
CREATE TABLE IF NOT EXISTS identities (
  id            BIGSERIAL PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_key      TEXT NOT NULL,
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_key)
);
CREATE INDEX IF NOT EXISTS identities_last_seen_idx ON identities (last_seen_at);

-- ---------------------------------------------------------------- eventos

-- Log de eventos recebidos. `payload` guarda o Evento Interno já pós-consentimento e
-- com PII mascarada/hasheada — nunca e-mail em claro (LGPD + regra de log do projeto).
-- utm_source / value / currency ficam desnormalizados em coluna própria só para o
-- dashboard não precisar varrer JSONB em toda consulta.
CREATE TABLE IF NOT EXISTS events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL,
  event_name  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'web',   -- web | webhook
  occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_ip   TEXT,
  utm_source  TEXT,
  value       NUMERIC(14,2),
  currency    TEXT,
  payload     JSONB NOT NULL,
  consent     JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (project_id, event_id, event_name)
);
CREATE INDEX IF NOT EXISTS events_project_received_idx ON events (project_id, received_at DESC);
CREATE INDEX IF NOT EXISTS events_received_idx ON events (received_at);

-- ---------------------------------------------------------------- fila de entrega

-- Uma linha por (evento × destino). Serve simultaneamente como fila durável,
-- registro de auditoria e fonte da tela de logs do painel.
CREATE TABLE IF NOT EXISTS deliveries (
  id               BIGSERIAL PRIMARY KEY,
  event_row_id     UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  destination_type TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  -- pending | processing | success | error | dead | skipped_consent | skipped_unmapped
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at        TIMESTAMPTZ,
  http_status      INT,
  response         JSONB,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_row_id, destination_type)
);

-- Índice que sustenta o polling do worker (status + horário do próximo attempt).
CREATE INDEX IF NOT EXISTS deliveries_queue_idx
  ON deliveries (next_attempt_at)
  WHERE status IN ('pending', 'error');
CREATE INDEX IF NOT EXISTS deliveries_event_idx ON deliveries (event_row_id);
CREATE INDEX IF NOT EXISTS deliveries_project_status_idx ON deliveries (project_id, status);
