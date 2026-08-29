-- 009_marca_projeto — identidade visual de cada empresa/projeto (F-V5 da reforma visual).
--
-- Por que existe: com vários clientes no mesmo painel, "qual empresa estou olhando?" é a
-- pergunta que o operador faz dezenas de vezes por dia. Nome em texto responde devagar;
-- logo e cor respondem antes da leitura. Daí a marca ser dado do projeto, não preferência
-- de usuário.
--
-- `logo` guarda a imagem como data-URI (ex.: "data:image/png;base64,...."), exatamente o
-- padrão já adotado para a foto de perfil em 005_perfil.sql — e pelo mesmo motivo: o
-- volume é de dezenas de projetos, não de milhares de uploads, e um bucket externo
-- traria credencial, ciclo de vida e mais um ponto de falha para resolver um problema
-- que uma coluna resolve. O limite duro (200 KB, validado na API — nunca só no
-- navegador, que redimensiona para 128×128 antes de enviar) mantém a linha pequena.
-- A CSP do painel já permite renderizar: `img-src 'self' data:` (src/admin/seguranca.js).
--
-- `cor` guarda um hex `#RRGGBB` e é o plano B da identidade: sem logo, o painel desenha
-- as iniciais do nome sobre essa cor, de modo que TODO projeto tenha marca visual,
-- mesmo o que nunca subiu imagem alguma.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS logo TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS cor  TEXT;
