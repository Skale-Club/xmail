-- 068 — Unified Inbox: exclusão de tráfego de warm-up + base da busca
--
-- 1. outreach_provider_events.materialization_status ganha 'skipped'. O mesh de warm-up (jobs/
--    processWarmup.ts) faz as nossas caixas trocarem e-mail entre si; em produção isso era 97% do
--    Unified Inbox (8.770 de 9.008 conversas, 0 respostas de campanha). Um evento de warm-up que
--    ainda estava na fila de materialização é encerrado como 'skipped' (nem 'failed', que alerta
--    o operador, nem 'materialized', que exige uma mensagem). A linha continua existindo como
--    registro de dedupe da mensagem do provedor.
--
--    ORDEM DE DEPLOY: preferível aplicar esta migration ANTES de subir o código, mas não é
--    obrigatório: o materializador detecta se o CHECK já aceita 'skipped' (supportsSkippedStatus) e,
--    enquanto não aceita, mantém o comportamento anterior (materializa normalmente) em vez de falhar
--    o evento. A exclusão liga sozinha em até 1 minuto depois que a migration entra.
--
-- 2. Extensão pg_trgm, base dos índices GIN de busca por ILIKE '%termo%' (a busca do Unified Inbox
--    varre assunto, prévia e participantes). Os índices em si são CREATE INDEX CONCURRENTLY e
--    ficam em sql/indexes.sql (npm run db:indexes), porque o runner de migrations envolve cada
--    arquivo em uma transação.
--
-- Idempotente.

ALTER TABLE public.outreach_provider_events
    DROP CONSTRAINT IF EXISTS outreach_provider_events_materialization_status_check;
-- NOT VALID + VALIDATE: o ADD toma só um lock curto e não varre a tabela; a varredura de validação
-- roda depois com lock que não bloqueia escrita. Idempotente (o DROP antecede o ADD).
ALTER TABLE public.outreach_provider_events
    ADD CONSTRAINT outreach_provider_events_materialization_status_check
    CHECK (materialization_status IN ('pending', 'processing', 'materialized', 'failed', 'skipped')) NOT VALID;
ALTER TABLE public.outreach_provider_events
    VALIDATE CONSTRAINT outreach_provider_events_materialization_status_check;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
