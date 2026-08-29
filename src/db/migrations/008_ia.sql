-- 008_ia — integração com a OpenRouter para estruturar payloads de webhook com IA
-- (Plano-Melhorias-Painel.md, seção 3.4 e épico E4/E5, seções 7.3/7.4).
--
-- Onde guardar a chave da OpenRouter: COLUNA em `projects`, não tabela própria nem
-- reaproveitamento de `destinations`. `destinations` existe para N linhas por projeto
-- (uma por TIPO de destino de ENVIO — meta/google/postback, cada um com seu próprio
-- schema de config/credenciais). A configuração de IA é um-para-um com o projeto: uma
-- chave, um modelo, um interruptor — não há "tipo" para discriminar. Uma tabela própria
-- só se justificaria se o produto um dia precisasse de mais de uma config de IA por
-- projeto; forçar essa forma agora seria complexidade sem uso concreto. Cifrada com a
-- MESMA master key (APP_SECRET) e o MESMO helper (encrypt/decrypt) de
-- src/config/crypto.js que já cifra access_token/api_secret/refresh_token em
-- `destinations` — nenhum mecanismo novo de segredo, só mais um campo cifrado.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS ia_openrouter_key_enc TEXT,
  ADD COLUMN IF NOT EXISTS ia_modelo TEXT,
  ADD COLUMN IF NOT EXISTS ia_habilitada BOOLEAN NOT NULL DEFAULT false;

-- Modo "IA por evento" (7.4): a IA estrutura CADA webhook recebido de uma origem
-- polimórfica, em vez de gerar um mapeamento uma única vez (7.3). É um modo de
-- operação do ADAPTADOR DINÂMICO, então vive na coluna `modo` que já existe
-- (004_webhook_studio.sql) — só precisa aceitar o valor novo. Trocar o CHECK não é
-- ADD COLUMN, mas também não é o tipo de mudança que a I-5 proíbe (DROP de coluna,
-- ALTER TYPE, renomear coluna com dado): nem a coluna nem os dados existentes são
-- tocados, só a LISTA de valores aceitos cresce — toda linha 'nativo'/'sombra' já
-- gravada continua válida, sem backfill nenhum.
ALTER TABLE adaptadores_projeto DROP CONSTRAINT IF EXISTS adaptadores_projeto_modo_check;
ALTER TABLE adaptadores_projeto
  ADD CONSTRAINT adaptadores_projeto_modo_check CHECK (modo IN ('nativo', 'sombra', 'ia_por_evento'));

-- Custo acumulado por projeto/mês (7.4: "telemetria: custo estimado acumulado no mês
-- exibido na UI"). Granularidade MENSAL, não por chamada: uma linha por chamada
-- guardaria detalhe que ninguém consulta individualmente no painel (a própria
-- OpenRouter já tem um dashboard de uso por chamada) e cresceria sem teto de retenção
-- óbvio. Upsert por (projeto, mês) mantém a tabela do tamanho de "projetos × meses de
-- operação" para sempre.
CREATE TABLE IF NOT EXISTS ia_uso_mensal (
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ano_mes        TEXT NOT NULL,            -- 'YYYY-MM', calculado em UTC
  custo_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
  chamadas       INT NOT NULL DEFAULT 0,
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, ano_mes)
);
