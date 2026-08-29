-- 003_analytics — colunas desnormalizadas para o dashboard de atribuição/funil/destinos.
--
-- Segue o mesmo racional de utm_source/value/currency em 001_init: o dashboard não pode
-- varrer payload (JSONB) em toda consulta de métricas, então os campos usados em GROUP BY
-- e filtro ganham coluna própria.
--
-- Esta migração é SÓ DDL — não faz UPDATE nas linhas existentes. Uma tabela de eventos de
-- produção pode ter milhões de linhas; rodar um UPDATE em massa dentro da transação da
-- migração travaria o deploy (e a tabela, por causa do lock) pelo tempo do backfill. O
-- preenchimento dos eventos antigos é feito à parte, em lotes, por
-- `src/scripts/backfill-analytics.js` (`npm run backfill:analytics`), que pode ser
-- interrompido e retomado a qualquer momento. Eventos novos (via recordEvent) já nascem
-- com estas colunas preenchidas — não dependem do backfill.

ALTER TABLE events ADD COLUMN IF NOT EXISTS utm_medium   TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS utm_campaign TEXT;

-- NULL aqui significa "ainda não calculado" (evento antigo, pré-backfill) — diferente de
-- FALSE, que significa "calculado e não tem identificador de clique". O painel precisa
-- distinguir os dois casos para não contar um evento antigo como "sem atribuição" antes
-- mesmo do backfill rodar.
ALTER TABLE events ADD COLUMN IF NOT EXISTS tem_fbc   BOOLEAN;
ALTER TABLE events ADD COLUMN IF NOT EXISTS tem_gclid BOOLEAN;

-- Sustenta a consulta mais pesada do novo dashboard: receita e cobertura de atribuição
-- de compras por período (metrics/utm e metrics/atribuicao). Parcial porque só compra
-- importa para receita — indexar os demais nomes de evento aqui seria peso sem uso.
CREATE INDEX IF NOT EXISTS events_project_purchase_received_idx
  ON events (project_id, received_at)
  WHERE event_name = 'purchase';
