-- Escopo `campaigns:copy` do gateway do agente: ler, editar e reverter o texto dos e-mails de
-- campanhas que já existem (GET /api/agent/outreach/campaigns/:id/sequence, PUT .../steps/:n,
-- POST .../steps/:n/revert). Não envia nem ativa nada.
--
-- Esta migration SÓ CONCEDE o escopo à credencial do Hermes que já existe. Não cria tabela
-- nenhuma: a versão anterior do texto fica no próprio `outreach_agent_audit_log`
-- (action `agent.campaign.step_copy_updated`, metadata.before/after).
--
-- `outreach_agent_credentials.scopes` é jsonb sem CHECK sobre os valores (só `jsonb_typeof =
-- 'array'`, migration 045), então um escopo novo não precisa de DDL: o que o código aceita é
-- `OUTREACH_AGENT_SCOPES` em src/db/schema.ts.
--
-- Quais credenciais recebem: não revogadas e (nome contém "hermes" OU já têm o conjunto inteiro
-- do fluxo governado: campaigns:draft + campaigns:request_activation + campaigns:pause). Se a
-- credencial de produção não se encaixar em nenhum dos dois critérios o UPDATE não toca nada —
-- confira antes com:
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
SET scopes = scopes || '["campaigns:copy"]'::jsonb,
    updated_at = now()
WHERE revoked_at IS NULL
  AND jsonb_typeof(scopes) = 'array'
  AND NOT jsonb_exists(scopes, 'campaigns:copy')
  -- So o Hermes. Em 2026-10-07 havia tambem a credencial "Kai" com os mesmos escopos de campanha;
  -- ela nao recebe a permissao de editar texto sem pedido explicito do Vanildo.
  AND name ILIKE '%hermes%';
