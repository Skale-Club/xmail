-- Least privilege for the secondary Kai agent.
--
-- Migration 072 added campaigns:copy to both Hermes and Kai but did not remove
-- the broad prospecting/outreach scopes Kai already had. The documented and
-- owner-approved boundary is narrower: Kai may read, edit and revert campaign
-- copy only. GET /api/agent/outreach/campaigns/:id/sequence now accepts this
-- scope directly, so outreach:read is not required for that workflow.
--
-- Idempotent and deliberately exact: rerunning this migration cannot restore
-- older scopes. Hermes and every other credential are untouched.

UPDATE outreach_agent_credentials
SET scopes = '["campaigns:copy"]'::jsonb,
    updated_at = now()
WHERE revoked_at IS NULL
  AND lower(name) = 'kai'
  AND scopes IS DISTINCT FROM '["campaigns:copy"]'::jsonb;
