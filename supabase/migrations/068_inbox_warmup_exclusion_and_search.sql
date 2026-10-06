-- 068 — Unified Inbox: exclusão de tráfego de warm-up + base da busca
--
-- 1. outreach_provider_events.materialization_status ganha 'skipped'. O mesh de warm-up (jobs/
--    processWarmup.ts) faz as nossas caixas trocarem e-mail entre si; em produção isso era 97% do
--    Unified Inbox (8.770 de 9.008 conversas, 0 respostas de campanha). Um evento de warm-up que
--    ainda estava na fila de materialização é encerrado como 'skipped' (nem 'failed', que alerta
--    o operador, nem 'materialized', que exige uma mensagem). A linha continua existindo como
--    registro de dedupe da mensagem do provedor.
--
--    ORDEM DE DEPLOY: aplicar esta migration ANTES de subir o código. Sem ela, o materializador
--    tenta gravar 'skipped', o CHECK rejeita, e o evento de warm-up cai em 'failed' depois de 5
--    tentativas (sem perda de dados reais, mas com ruído no log).
--
-- 2. Extensão pg_trgm, base dos índices GIN de busca por ILIKE '%termo%' (a busca do Unified Inbox
--    varre assunto, prévia e participantes). Os índices em si são CREATE INDEX CONCURRENTLY e
--    ficam em sql/indexes.sql (npm run db:indexes), porque o runner de migrations envolve cada
--    arquivo em uma transação.
--
-- Idempotente.

ALTER TABLE public.outreach_provider_events
    DROP CONSTRAINT IF EXISTS outreach_provider_events_materialization_status_check;
ALTER TABLE public.outreach_provider_events
    ADD CONSTRAINT outreach_provider_events_materialization_status_check
    CHECK (materialization_status IN ('pending', 'processing', 'materialized', 'failed', 'skipped'));

CREATE EXTENSION IF NOT EXISTS pg_trgm;
