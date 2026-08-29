-- 005_perfil — foto e nome/sobrenome do usuário do painel (épico E8: configurações).
--
-- `name` (existente desde 001_init) PERMANECE e continua sendo a coluna lida por todo
-- código antigo (convite, e-mails, listagem de usuários) — é o invariante I-3 do painel.
-- A partir desta fase, `name` passa a ser DERIVADO de first_name+last_name sempre que o
-- perfil é salvo pela tela nova (ver updateProfile em src/db/repos/users.js), mas nada
-- deixa de funcionar para quem só conhece `name`: usuário criado pelo fluxo antigo (só
-- `name` preenchido, sem first_name/last_name) continua exibindo normalmente em todo
-- lugar que já existia.
--
-- `avatar` guarda a foto como data-URI (ex.: "data:image/png;base64,...."). Sem storage
-- externo de propósito: o volume é de usuários do painel (dezenas, não milhares) e o
-- limite duro de 128 KB (validado na API, nunca só no navegador) mantém a linha do banco
-- pequena. CSP `img-src 'self' data:` já permite renderizar (src/admin/seguranca.js).
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar     TEXT;
