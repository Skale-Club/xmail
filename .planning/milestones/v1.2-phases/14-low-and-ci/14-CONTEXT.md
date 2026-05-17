# Phase 14: LOW Cleanup + CI / Observability - Context

**Gathered:** 2026-05-16
**Status:** Ready for planning
**Mode:** Auto-generated (autonomous mode — audit is the spec)

<domain>
## Phase Boundary

Final pass — kill cosmetic debt and turn on the CI gates so v1.2 stays green.

**ROADMAP success criteria:**
1. `/api/system/mail-diag` no personal email; accepts `?testEmail=`.
2. `git ls-files | grep -E "^(nul|scripts/_)"` returns no matches.
3. `npm run build` no Vite "can't be bundled without type=module" warning.
4. `MAX_WEBHOOK_RESPONSE_BODY` is a named export from `tracking.ts`.
5. CI runs `npm run lint` and `npx tsc --noEmit` as required checks.
6. `docs/runbook.md` (or README section) documents `/health/ready` readiness probe.
7. CI-04 decision recorded (error sink implemented or formally deferred to v1.3).

</domain>

<decisions>
## Implementation Decisions

### CLN-01 mail-diag (audit L1)
- `src/server/routes/system.ts /mail-diag`: replace hardcoded `testEmail = 'vanildo@skale.club'` with `req.query.testEmail` (validate with Zod). Default = no diagnostic test.

### CLN-02 cleanup files (audit L2, L3)
- `git rm nul` if exists.
- Rename or delete `scripts/_check-db.ts` and `scripts/_setup-user.ts` (drop `_` prefix or remove).

### CLN-03 index.html script (audit L4)
- Update `index.html` `<script src="/app-config.js">` tag to suppress Vite warning. Add `type="text/javascript"` explicitly or move to inline.

### CLN-04 magic constant (audit L5)
- `src/server/lib/tracking.ts`: extract `MAX_WEBHOOK_RESPONSE_BODY = 5000` as a named constant; use in `responseBody.substring(0, MAX_WEBHOOK_RESPONSE_BODY)`.

### CI-01 + CI-02 (CI gates)
- Detect existing CI (GitHub Actions, GitLab CI). If none, create `.github/workflows/ci.yml` with: `npm ci`, `npm run lint`, `npx tsc --noEmit -p tsconfig.json`, `npx tsc --noEmit -p tsconfig.server.json`, `npm run build`.
- If existing CI, add/extend lint + tsc steps.

### CI-03 runbook
- Create `docs/runbook.md` (or add section to README) documenting:
  - `/health/ready` returns 200 OK or 503 with `database.ok=false`
  - Expected behavior on DB outage
  - Probe interval recommendation

### CI-04 error log sink decision
- Document decision in PROJECT.md "Key Decisions" table.
- Recommended: Defer to v1.3 (Sentry/Datadog requires budget/infra decision).

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `.eslintrc.cjs` exists (Phase 12 COR-07).
- `package.json` lint + tsc scripts present and tested.

### Integration Points
- `.github/workflows/` may or may not exist — check.

</code_context>

<specifics>
## Specific Ideas

Audit Fase 4 Blocos 4.1–4.4 + Fase 5.

</specifics>

<deferred>
## Deferred Ideas

- Actual Sentry/Datadog wiring (deferred to v1.3 per CI-04 decision).

</deferred>
