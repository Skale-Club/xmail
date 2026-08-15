-- 060 — carimba custom_fields.source_run_id nos leads que já existem (2026-08-15)
--
-- measureProspectingOutcomes credita um lead a um run pelo caminho (b):
--
--     leads.custom_fields->>'source_run_id' = prospecting_runs.idempotency_key
--
-- É o caminho REAL de produção. O caminho (a), via prospect_candidates, é o do Apollo e nunca rodou
-- aqui: a tabela tem zero linhas.
--
-- O defeito: o Xmail procura `source_run_id`, o Xphere carimba `xcraper_run_id`. Chaves diferentes,
-- o join nunca casa, e TODO run de xcraper fica com outcome_* zerado para sempre — reply, bounce e
-- unsubscribe nunca voltam para creditar o run que originou o lead, e custo-por-resposta vira uma
-- divisão por zero. O `leads.ts` só PRESERVAVA `source_run_id` no re-import, nunca o gerava, então
-- ninguém escrevia essa chave.
--
-- O código passou a normalizar no boundary de import (lib/prospecting/source-run-id.ts). Esta
-- migration cobre o que já estava gravado, na mesma ordem de precedência da função:
--   1. `source_run_id` explícito vence e nunca é reescrito (regra de primeiro toque: deixar um
--      re-import posterior sobrescrever faria dois runs reivindicarem o mesmo humano);
--   2. senão, o apelido que o produtor mandou (`xcraper_run_id`, `external_run_id`);
--   3. senão, o id embutido no próprio `source`, no formato `<provider>:<run-id>`.
--
-- Idempotente: o WHERE só alcança linhas sem a chave, então reexecutar não faz nada.

-- (2) a partir dos apelidos conhecidos
UPDATE public.leads
SET custom_fields = custom_fields || jsonb_build_object(
        'source_run_id',
        COALESCE(
            NULLIF(custom_fields ->> 'xcraper_run_id', ''),
            NULLIF(custom_fields ->> 'external_run_id', ''),
            NULLIF(custom_fields ->> 'prospecting_run_id', '')
        )
    )
WHERE jsonb_typeof(custom_fields) = 'object'
  AND NULLIF(custom_fields ->> 'source_run_id', '') IS NULL
  AND COALESCE(
        NULLIF(custom_fields ->> 'xcraper_run_id', ''),
        NULLIF(custom_fields ->> 'external_run_id', ''),
        NULLIF(custom_fields ->> 'prospecting_run_id', '')
      ) IS NOT NULL;

-- (3) a partir do `source` no formato `<provider>:<run-id>`
UPDATE public.leads
SET custom_fields = COALESCE(custom_fields, '{}'::jsonb)
    || jsonb_build_object('source_run_id', split_part(source, ':', 2))
WHERE (custom_fields IS NULL OR jsonb_typeof(custom_fields) = 'object')
  AND NULLIF(custom_fields ->> 'source_run_id', '') IS NULL
  AND source LIKE '%:%'
  AND NULLIF(split_part(source, ':', 2), '') IS NOT NULL;
