-- 004_webhook_studio — fundação do Webhook Studio (Plano-Melhorias-Painel.md, épico
-- E4/E5, seção 7): captura de amostras de webhooks não reconhecidos e adaptadores
-- dinâmicos configuráveis por projeto (mapeamento declarativo, sem código).

-- ---------------------------------------------------------------- amostras de webhook

-- Payloads que NENHUM adaptador (hardcoded ou dinâmico) reconheceu. Alimenta a "Inbox
-- de webhooks" do painel: em vez do operador só saber pelo log que "chegou algo
-- estranho", ele vê o formato de verdade e pode mapear.
--
-- Retenção: esta tabela é conforto de operação, não auditoria — não pode crescer sem
-- limite. O corte NÃO é feito aqui (um DELETE por gatilho/cron seria mais uma peça de
-- infra para manter): é feito em src/db/repos/webhooks.js, a cada gravação, por TRÊS
-- tetos complementares:
--   1. no máximo N amostras por projeto por DIA (uma origem de alto volume que ninguém
--      reconhece não pode encher a tabela em poucas horas);
--   2. no máximo N amostras por (projeto, hash_estrutura) — depois de já ter uma boa
--      amostra de um formato, novas ocorrências IDÊNTICAS em estrutura não acrescentam
--      informação;
--   3. um teto TOTAL por projeto (retenção de fato) — apagando as mais antigas.
-- Ver MAX_AMOSTRAS_POR_DIA / MAX_AMOSTRAS_POR_HASH / MAX_AMOSTRAS_POR_PROJETO no repo.
CREATE TABLE IF NOT EXISTS webhook_amostras (
  id                  BIGSERIAL PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  body_mascarado      JSONB NOT NULL,
  formato_detectado    TEXT,                         -- NULL = ninguém reconheceu (o caso normal aqui)
  headers_relevantes   JSONB NOT NULL DEFAULT '{}'::jsonb,
  processada          BOOLEAN NOT NULL DEFAULT false,
  -- Hash do FORMATO do payload — conjunto ORDENADO de caminhos de chave, SEM valores
  -- (ver hashEstrutura em src/db/repos/webhooks.js). É o que permite ao painel mostrar
  -- "12 webhooks do mesmo formato" em vez de 12 linhas idênticas, mesmo quando o valor
  -- de cada campo muda de uma ocorrência para outra.
  hash_estrutura      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_amostras_projeto_recebido_idx
  ON webhook_amostras (project_id, received_at DESC);
CREATE INDEX IF NOT EXISTS webhook_amostras_projeto_hash_idx
  ON webhook_amostras (project_id, hash_estrutura);

-- ---------------------------------------------------------------- adaptadores dinâmicos

-- O par detecção+mapeamento que o interpretador de src/ingest/mapeamento.js executa.
-- Hardcoded (src/ingest/adaptadores.js) SEMPRE tem precedência — ver adaptarPayload: um
-- adaptador dinâmico com detecção ampla demais não pode "roubar" o payload de um
-- formato já conhecido e testado (mitigação registrada no Plano-Melhorias-Painel.md,
-- seção 13).
CREATE TABLE IF NOT EXISTS adaptadores_projeto (
  id           BIGSERIAL PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  nome         TEXT NOT NULL,
  deteccao     JSONB NOT NULL DEFAULT '{}'::jsonb,
  mapeamento   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ativo        BOOLEAN NOT NULL DEFAULT false,
  -- 'nativo'  -> roda de verdade quando ativo=true (substitui o evento).
  -- 'sombra'  -> NUNCA altera o evento, mesmo com ativo=true; só registra o que TERIA
  --              produzido (no formato_detectado da amostra correspondente). É o que
  --              permite validar um mapeamento novo contra tráfego real antes de
  --              arriscar dado de conversão (Plano-Melhorias-Painel.md, seção 7.1/13).
  modo         TEXT NOT NULL DEFAULT 'nativo' CHECK (modo IN ('nativo', 'sombra')),
  criado_via   TEXT NOT NULL DEFAULT 'manual' CHECK (criado_via IN ('manual', 'ia')),
  created_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, nome)
);
CREATE INDEX IF NOT EXISTS adaptadores_projeto_ativo_idx ON adaptadores_projeto (project_id, ativo);
