# AGENTS.md — Xmail

<!-- journal-protocol:v1 -->
## Journal (mandatory)

This app's history (what it does, how each part was built, decisions and releases) lives in its Notion Journal. It replaces the old GSD/PAUL planning flow; `.planning/` and `.paul/`, if present, are a read-only legacy archive.

- Journal hub: https://app.notion.com/p/411b7a686121814abf98e7c623e2539a
- Journal Entries data source: collection://1ed041df-1ece-4cf7-9b7e-facc2ecbe5f7
- Latest view: view://411b7a68-6121-813c-a6bc-000c0703ae26
- Entry prefix: XML
- Rules (they win on any conflict): https://app.notion.com/p/411b7a68612181b3ac36f4ce2b2c3850 (skill: `app-journal`)

**Start of session:** fetch the hub and read Identity and Current State; list the latest 20 entries with Notion query-data-sources in `view` mode on the Latest view above (`page_size` 20; view mode has no plan quota) and read only titles and summaries; use `rows` mode with a filter only to narrow down (it has a plan quota); if a read fails, say so and continue from the code, never guess journal content; open only the entries you need; never read the whole database. Cross-check with the code: the code is the fact.

**End of every task that changed code, behavior, infrastructure or a decision:**
1. Create ONE entry in the data source above (one per logical unit of work, not per commit): `Title` = `YYYY-MM-DD — <imperative summary>`, `date:Date:start` (YYYY-MM-DD, with `date:Date:is_datetime` = 0), `Type`, `Area` (JSON array of existing options), `Status`, `Summary` (max 280 characters), `Agent`, `Model`, `Repo / Branch`, `Commits / PR`, `Tests` (what ran, or "Not run"), and `Decision ID` / `Decision Status` when a choice was made.
2. Body headings: Context · What changed · How it was built · Decisions and why · Tests and evidence · Not done / risks · Next.
3. If the app changed, rewrite the affected part of the hub's Current State. Read back what you wrote; never report a write you did not see.
4. Notion unavailable: append the full entry to `docs/journal/PENDING-NOTION.md` and tell the owner.

Journal records are in English. No secrets.
<!-- /journal-protocol -->

<!-- model-routing:v1 -->
## Model routing (token economy) — mandatory, every task

The model the owner chose for this session is the **orchestrator**. It plans the work, splits it into pieces, picks the right model for each piece, and **audits and validates** every result. It does not have to execute everything itself: execution goes to faster, cheaper models whenever they can do the piece well. Without routing, tokens drain fast.

**Delegation ladder** (delegate one or two tiers down, never up):

| Session model (orchestrator) | Delegates execution to |
|---|---|
| Claude Fable | Opus (hard sub-problems), Sonnet (standard implementation, analysis, writing) |
| Claude Opus | Sonnet (implementation, analysis, writing), Haiku (bulk reads, search, mechanical edits, data entry) |
| Claude Sonnet | Haiku (bulk reads, search, mechanical edits), when it pays off |
| Claude Haiku | does the work itself |
| Codex / ChatGPT top model | the same idea with the smaller models available there (a mini model for bulk and mechanical work) |

**Rules**
1. **Routing plan first.** Before a multi-step task, list the pieces and give each one a tier. A trivial task (a handful of tool calls, or a lookup whose target is known) is done directly: an extra agent would cost more than it saves.
2. **Delegate:** bulk file reading and search, codebase mapping, mechanical multi-file edits, data entry (Notion rows, seed data), log and test-output triage, first drafts.
3. **Keep on the orchestrator:** decisions and trade-offs, architecture, anything touching production, credentials, money or customer data, security review, and the **final verification** of every delegated result.
4. **Self-contained briefs:** goal, files, constraints, what done looks like, output format. Ask for a concise report, never raw dumps.
5. **Audit before accepting:** read the diff, re-run the tests, spot-check the data. A subagent's report is a claim, not proof.
6. **Parallel when independent:** independent pieces run at the same time; dependent pieces run in order.
7. **Record it:** the journal entry says which models did what (Agent / Model fields).

How (Claude Code): the Agent tool with `model: "opus" | "sonnet" | "haiku"`; read-only searches can use the Explore agent type. Skill: `model-routing`. Notion: Projects → Templates → AI Model Routing Protocol.
<!-- /model-routing -->

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
