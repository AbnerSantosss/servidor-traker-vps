-- 002_usuarios — convites, redefinição de senha e papéis.
--
-- Um usuário convidado nasce SEM senha (password_hash nulo): ele só existe de fato
-- quando aceita o convite e define a própria senha. Isso evita o antipadrão de gerar
-- uma senha provisória e mandá-la por e-mail — senha que trafega por e-mail vaza.

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- Papéis aceitos:
--   admin    — acesso total, inclusive credenciais dos destinos e gestão de usuários
--   operador — acompanha projetos, métricas e logs; não gerencia usuários nem credenciais
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'operador'));

-- Tokens de uso único para convite e redefinição de senha.
-- Guardamos apenas o HASH do token: um dump do banco não permite assumir a conta de
-- ninguém, do mesmo modo que já fazemos com as sessões.
CREATE TABLE IF NOT EXISTS user_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('convite', 'redefinicao')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS user_tokens_user_idx ON user_tokens (user_id, purpose);
CREATE INDEX IF NOT EXISTS user_tokens_expires_idx ON user_tokens (expires_at);
