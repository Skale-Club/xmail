-- Escopo `outreach:manage` do gateway do agente: operar o dia a dia do outreach que já existe
-- (campanhas, leads, caixas, supressões; mais leitura da caixa de entrada e das métricas), em
-- /api/agent/outreach:
--   PATCH /campaigns/:id, POST /campaigns/:id/duplicate, POST /campaigns/:id/resume,
--   PATCH /leads/:id, DELETE /campaigns/:id/leads/:leadId, POST/PATCH /lead-lists,
--   PATCH /email-accounts/:id, POST/DELETE /suppressions.
-- Não envia e-mail e não ativa campanha: ativação e resposta a prospect continuam na aprovação
-- humana (`outreach_action_approvals`).
--
-- Esta migration SÓ CONCEDE o escopo à(s) credencial(is) do Hermes que já existe(m). O Kai fica de
-- fora por decisão do dono (2026-10-07): a 072 já deu a ele `campaigns:copy`, e nada além disso. Não cria tabela nenhuma: `outreach_agent_credentials.scopes` é jsonb sem
-- CHECK sobre os valores (só `jsonb_typeof = 'array'`, migration 045), então um escopo novo não
-- precisa de DDL; o que o código aceita é `OUTREACH_AGENT_SCOPES` em src/db/schema.ts.
--
-- Quais credenciais recebem: não revogadas e nome contém "hermes". Se a
-- credencial de produção não se encaixar o UPDATE não toca nada — confira antes com:
--   SELECT id, name, scopes, revoked_at FROM outreach_agent_credentials;
-- e, nesse caso, conceda pela API (POST /api/outreach/agent-credentials, sessão admin) ou
-- ajuste o WHERE.
--
-- Idempotente: `jsonb_exists` evita duplicar o escopo (não usa o operador `?` para não colidir com
-- placeholders de parâmetro de drivers). O literal jsonb é constante, sem parâmetro, então não há
-- risco de dupla codificação (docs/outreach-hermes-system-map.md §13).
--
-- Sem BEGIN/COMMIT: o runner já envolve cada arquivo numa transação (CLAUDE.md, "Applying").

UPDATE outreach_agent_credentials
SET scopes = scopes || '["outreach:manage"]'::jsonb,
    updated_at = now()
WHERE revoked_at IS NULL
  AND jsonb_typeof(scopes) = 'array'
  AND NOT jsonb_exists(scopes, 'outreach:manage')
  -- Só o Hermes (decisão do dono, 2026-10-07). O Kai não recebe `outreach:manage`.
  AND name ILIKE '%hermes%';
