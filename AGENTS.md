# AGENTS.md — Xmail

**The agent instructions for this repo live in [`CLAUDE.md`](CLAUDE.md). Read that file.**

This file used to be a full copy of `CLAUDE.md`. The copy drifted — it advertised
the wrong CI workflow, listed `db:generate`/`db:push` scripts that had been
deliberately removed, claimed no test framework was configured (there are 69
`*.test.ts` files running under Vitest), froze the migration numbering at `019`,
and never learned about the Hermes agent gateway. Anything that trusted it as
authoritative would have reasoned from a stale picture of the system.

Rather than maintain two copies that diverge again, `CLAUDE.md` is the single
source of truth for:

- Deployment topology (Hetzner + Coolify/Traefik, blue-green rollout via
  `.github/workflows/build-deploy.yml`, mail ports bypassing the proxy)
- Tech stack, project structure, and commands
- Authentication and the JS-side multi-tenancy model (`src/server/lib/access.ts`)
- The outreach email-account providers, including `native`
- Environment variables and GitHub secrets
- The schema & migration workflow, and the rules about what we do **not** do

Additional deep-dive docs:

| Doc | Covers |
| --- | --- |
| [`docs/outreach-hermes-architecture.md`](docs/outreach-hermes-architecture.md) | Hermes security boundary, event flow, `/api/agent/outreach` scope contract |
| [`docs/outreach-hermes-runbook.md`](docs/outreach-hermes-runbook.md) | Agent credential setup, smoke path, monitoring, incident + rollback |
| [`docs/outreach-hermes-roadmap.md`](docs/outreach-hermes-roadmap.md) | Phase 24–32 status |
| [`docs/native-smtp-imap-server.md`](docs/native-smtp-imap-server.md) | Embedded SMTP/IMAP/MX servers inside the Node process |
| [`docs/runbook.md`](docs/runbook.md) | General ops runbook (health probes, triage) |
| [`hermes/README.md`](hermes/README.md) | Hermes sidecar deployment, LLM config, gotchas |

If you are editing agent guidance, edit `CLAUDE.md`. Do not re-expand this file
back into a duplicate.
