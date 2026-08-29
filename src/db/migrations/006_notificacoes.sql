-- 006_notificacoes — destinatários e assinaturas de notificação por e-mail (épico E8).
--
-- Por que "destinatário" é uma entidade PRÓPRIA e não reaproveita `users`:
--   o pedido explícito é permitir que gente SEM login no painel receba alertas (o dono
--   do negócio que só quer o resumo diário, por exemplo). `user_id` NULL é exatamente
--   esse caso — pessoa externa, cadastrada só pelo nome e e-mail por um admin. Quando
--   não é nulo, é o mesmo usuário do painel (referenciado por FK, não duplicado).
CREATE TABLE IF NOT EXISTS destinatarios_notificacao (
  id                BIGSERIAL PRIMARY KEY,
  nome              TEXT NOT NULL,
  email             TEXT NOT NULL UNIQUE,
  user_id           BIGINT REFERENCES users(id) ON DELETE SET NULL,
  criado_por        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  -- Descadastro de um clique (LGPD): a pessoa externa nunca pediu para entrar na lista,
  -- então sair dela não pode depender de login nenhum — só do link, que carrega o token.
  token_descadastro TEXT NOT NULL UNIQUE,
  ativo             BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uma linha por (destinatário, tipo, projeto). `project_id` NULL = recebe do tipo em
-- TODOS os projetos, presentes e futuros — sem precisar reinscrever a cada projeto novo.
--
-- A unicidade de (destinatario_id, tipo, project_id) não pode ser um UNIQUE comum: com
-- NULL a Postgres trata cada linha como distinta (duas assinaturas "todos os projetos"
-- do mesmo tipo poderiam coexistir). Em vez de depender de NULLS NOT DISTINCT (só a
-- partir do Postgres 15, e o projeto não fixa versão mínima em lugar nenhum), dois
-- índices parciais cobrem os dois casos e funcionam em qualquer versão suportada.
CREATE TABLE IF NOT EXISTS assinaturas_notificacao (
  id              BIGSERIAL PRIMARY KEY,
  destinatario_id BIGINT NOT NULL REFERENCES destinatarios_notificacao(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS assinaturas_notificacao_uniq_projeto
  ON assinaturas_notificacao (destinatario_id, tipo, project_id)
  WHERE project_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS assinaturas_notificacao_uniq_todos
  ON assinaturas_notificacao (destinatario_id, tipo)
  WHERE project_id IS NULL;

CREATE INDEX IF NOT EXISTS assinaturas_notificacao_tipo_idx ON assinaturas_notificacao (tipo, project_id);

-- Idempotência do motor: um reinício do worker (ou dois workers rodando em paralelo,
-- I-11) não pode redisparar o mesmo incidente nem o mesmo digest. `chave_incidente` é
-- construída pelo motor (src/notificacoes/motor.js) e o significado varia por tipo —
-- aqui é só um texto opaco de deduplicação.
CREATE TABLE IF NOT EXISTS notificacoes_enviadas (
  id              BIGSERIAL PRIMARY KEY,
  tipo            TEXT NOT NULL,
  chave_incidente TEXT NOT NULL,
  destinatario_id BIGINT NOT NULL REFERENCES destinatarios_notificacao(id) ON DELETE CASCADE,
  enviada_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tipo, chave_incidente, destinatario_id)
);
CREATE INDEX IF NOT EXISTS notificacoes_enviadas_destinatario_idx ON notificacoes_enviadas (destinatario_id, enviada_em);
