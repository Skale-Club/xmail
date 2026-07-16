---
phase: 19
phase_name: Provider Parity and Deliverability
status: passed
score: 12/12 declared truths verified (6/6 artifacts, 8/8 key links) after review-fix pass
verified_at: 2026-07-16T02:35:00Z
resolved_at: 2026-07-16T07:10:00Z
verifier: Claude (gsd-verifier, Opus 4.8)
re_verification: true
gaps:
  - truth: "A verified Outlook outreach account has proven read, write, and send capability"
    plan: 19-04
    requirement: PROV-02
    status: partial
    reason: >-
      Read capability is genuinely proven (a real bounded Graph sync must succeed before
      activation). Write (Mail.ReadWrite) and send (Mail.Send) capability are ASSERTED from
      the granted scope list, never probed. Additionally, plan 19-04's own <verification>
      block mandates a manual Outlook sandbox gate against a real Microsoft tenant; that gate
      has not been executed, so every Graph behaviour in this phase rests on mocked `fetch`.
    artifacts:
      - path: src/server/lib/outlook.ts:873-943
        issue: >-
          evaluateOutlookOutreachCapability proves inbound via probeInbound() but derives
          send/write purely from findMissingOutlookScopes(mailbox.scopes). Documented at
          OUTLOOK_CAPABILITY_GATE (outlook.ts:881) as a deliberate limitation.
    missing:
      - "Execute the manual Outlook sandbox gate from 19-04 <verification> against a real tenant: connect a test mailbox, confirm the initial delta cursor persists, send one MIME campaign fixture, reply, generate/ingest a DSN, and assert exactly one provider event and one side effect per message."
      - "Either downgrade the declared truth from 'proven send capability' to 'asserted send capability with proven inbound capability' (which is what the code and the response's `gate` field actually state), or add a probe that exercises Mail.Send without delivering to a real recipient."
human_verification:
  - test: "Outlook sandbox gate (mandated by 19-04 <verification>, not yet run)"
    expected: "Initial delta cursor persists; one MIME campaign fixture sends with List-Unsubscribe/Message-ID intact; a reply and a DSN each produce exactly one outreach_provider_events row and one side effect."
    why_human: "Requires a real Microsoft 365 tenant. All 38 outlook-inbound tests and the Graph MIME send tests mock `fetch`, so Graph's real contract (sendMail MIME content-type acceptance, delta/410 semantics, scope shape) is unexercised."
---

## Resolution addendum (2026-07-16, post review-fix)

The verdict above was `gaps_found` on GAP-1 only (PROV-02 over-claim). The Phase 19 code review
(`19-REVIEW.md`) additionally surfaced 3 critical + 5 warnings that the passing gates did not catch.
All were addressed in a fix pass (`19-REVIEW-FIX.md`) and independently re-reviewed: **all 8 findings
confirmed fixed, no new regressions, 353/353 tests, lint clean, both tsc projects clean.**

GAP-1 is resolved as a wording correction, exactly as this report recommended: 19-04's declared truth
and summary were changed from "proven send capability" to what the code actually guarantees — proven
**inbound** capability plus **asserted** send/write from the granted scope list (Graph has no zero-send
probe; 19-04 pre-authorised this fallback). The safety property that matters — an Outlook account is
**never** verified send-only — is proven and was hardened by the W-1 fix (a Graph 429/503 on the first
delta page now leaves the account `pending`, never `verified`).

The manual Outlook sandbox gate remains an **operator prerequisite** carried forward (see
`human_verification` above): the entire Graph surface is still verified only against mocked `fetch`.
This is the one item that cannot be closed without a real Microsoft 365 tenant and does not block the
phase, since no live cold outreach runs yet (no disposable sending domain).

Phase 19 status is therefore **passed**. The critical fixes closed real defects the phase would
otherwise have shipped: authenticated SMTP over cleartext on port 25, silent loss of inbound bounce
events on container restart, and an ex-member's personal INBOX being staged under their former
organization. A latent bug the review missed — `markAsReplied` binding a raw `Date` into a drizzle
`sql` template, which threw on every matched reply since it shipped — was also found and fixed during
the pass.

# Phase 19: Provider Parity and Deliverability — Verification Report

**Phase Goal:** Give SMTP, native, and Outlook accounts equivalent send/reply/bounce behavior and route every follow-up through the same deliverability controls.
**Verified:** 2026-07-16
**Status:** `gaps_found`
**Re-verification:** No — initial verification
**Diff under test:** `98f3afd..HEAD` (21 commits, 31 files, +8075/−1064)

## Verdict

**The engineering is strong and the phase goal is substantially achieved.** Every claim I could test against code, bytes, or a live Postgres held up — including several I actively tried to break. The provider-parity architecture is real, not aspirational: three adapters receive bytes from one composer, and the suite asserts that on the *transmitted buffers* rather than on mocks of the thing under test.

**The phase is marked `gaps_found` on a single, narrow point**, per the instruction that a requirement resting on inference or documentation rather than code/tests cannot pass: **PROV-02's declared truth says a verified Outlook account has "proven read, write, and send capability". Read is proven. Write and send are asserted from the OAuth scope list.** The code is honest about this (`OUTLOOK_CAPABILITY_GATE`, surfaced to the API caller as `gate`), and plan 19-04 explicitly pre-authorised the fallback — but the *declared truth* overstates what the code does, and the manual sandbox gate that plan 19-04's own `<verification>` block mandates has never been run. The entire Outlook path has never touched a real Microsoft tenant.

This is a documentation/assurance gap, not a safety defect. The property that actually protects users — **an Outlook account can never be verified send-only** — is proven by code and tests (`outlook-inbound.test.ts:750`, "never activates a send-only mailbox"). Closing the gap is a wording fix plus one sandbox run, not a redesign.

Notably, **two of the six self-reported deviations turned out to be better defended than the executors claimed** (details in Deviations). One — the client→server import — is empirically safe today but rests on an unguarded convention.

## Fresh Evidence

All gates re-run from a clean checkout at HEAD. No summary claims were taken on trust.

| Gate | Command | Result | Detail |
| --- | --- | --- | --- |
| Tests | `npm run test` | **PASS — 315/315, 19 files** | server 13 files, postgres 5 files, client 1 file. Duration 11.56s. Matches the expected ~315. |
| Build | `npm run build` | **PASS (exit 0)** | vite client build + `tsc -p tsconfig.server.json`. |
| Lint | `npm run lint` | **PASS (exit 0)** | `--max-warnings 0`, zero warnings. |
| Client typecheck | `npx tsc --noEmit -p tsconfig.json` | **PASS (exit 0)** | Run separately — `npm run build` does not typecheck the client. |
| Server typecheck | `npx tsc --noEmit -p tsconfig.server.json` | **PASS (exit 0)** | CI parity confirmed on both projects. |

### Phase-19 test suites (fresh counts)

| Suite | Tests | Project |
| --- | --- | --- |
| `smtp-security.test.ts` | 32 | server |
| `outreach-provider.test.ts` | 39 | server |
| `outlook-inbound.test.ts` | 38 | server |
| `provider-parity.test.ts` | 64 | server |
| `outreach-inbound.test.ts` | 25 | server |
| `parse-mailbox-csv.test.ts` | 5 | server |
| `outreach-provider-events-migration.db.test.ts` | 6 | **postgres (Testcontainers)** |
| **Phase-19 total** | **209** | |

**Phase 18 tenant-isolation regression still green:** `outreach-inbound-matching.db.test.ts` (2 tests, postgres) — *"tenant-safe inbound Message-ID matching > returns only the outreach email owned by the active reply account"*.

## Requirement Matrix

| Req | Status | Evidence (file:line) |
| --- | --- | --- |
| **PROV-01** — SMTP presets/verification use correct implicit-TLS vs STARTTLS, incl. 587 | ✅ **SATISFIED** | `smtp-security.ts:98-135` single pure resolver (465→`secure:true`; 587→`secure:false,requireTLS:true`; 25→opportunistic; nonstandard→explicit flag honoured). **Verify** path `email-accounts.ts:897-911` and **send** path `outreach-provider.ts:390-409` both call `buildSmtpTransportOptions` (`smtp-security.ts:163`) — only permitted divergence is connect/greeting timeouts. Legacy contradictions normalized + warned (`:120-124`), never leaking credentials. Write paths all canonicalize: bulk import `email-accounts.ts:367`, create `:561`, update `:650`. Client presets `NewInboxPage.tsx:55,98,236`, CSV `parse-mailbox-csv.ts:116`. 32+5 tests. |
| **PROV-02** — Outlook ingests replies/bounces with bodies + stable IDs, or cannot be activated | ⚠️ **PARTIAL** | **Proven:** ingestion (`outlook.ts:206-360`), bodies + provider IDs (`outreach-inbound-sources.ts:375-480`), and the activation gate (`outlook.ts:891-943`, wired at `email-accounts.ts:751-825`) — a capability failure writes `status: pending\|failed` + sanitized code (`:775-782`) and returns 400; it can never fall through to verified. `outlook-inbound.test.ts:750` "never activates a send-only mailbox". **Not proven:** write/send capability is scope-asserted only (`outlook.ts:918`, gate documented `:881`); the mandated real-tenant sandbox gate is unexecuted. See Gaps. |
| **PROV-03** — Every outbound provider emits equivalent unsubscribe metadata + preserves Message-ID/threading | ✅ **SATISFIED** | One composer `outreach-provider.ts:259-328`; three adapters ship the same `raw` (`:411-506`). `outreach-provider.test.ts:405` asserts **byte-identical MIME across all three providers**. `provider-parity.test.ts:327-344` asserts on real transmitted bytes that each provider carries `List-Unsubscribe`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and the stable `Message-ID`; `:374-392` asserts `In-Reply-To`/`References`. Outlook now uses Graph **MIME** send (`outlook.ts:762`), not the header-losing JSON shape. Bcc correctly kept in envelope, out of `raw` (`:281-286`) — important, since bytes go to three transports. |
| **PROV-04** — Native DSNs cannot be consumed as human replies; scans bounded/resumable/idempotent | ✅ **SATISFIED** | Single classifier, DSN→auto-reply→human→other (`outreach-inbound.ts:113-167`). Dedupe **before** side effects: `recordEvent` on-conflict at `ingestInboundPage` (`:410-431`), consumers read durable rows via `claimPending` with `FOR UPDATE SKIP LOCKED` + claim-time `processed_at` (`:600-616`). Cursor saved **only after** every message staged (`:435-438`). Read-state untouched: no `isRead`/`seen:false`/`\Seen` anywhere in the inbound code, and **verified at library level** that imapflow's `source` fetch emits `BODY.PEEK[]` (`node_modules/imapflow/lib/commands/fetch.js:90`), so body fetch cannot set `\Seen`. Bounds: native `limit: pageSize` (`sources.ts:110`), IMAP `.slice(0,pageSize)` + no advance past an unreadable UID (`:299,322-325`), Graph `top=Math.min(50,maxEvents)` + between-page defer (`outlook.ts:214,320-322`). UIDVALIDITY reset handled (`outreach-inbound.ts:204`). 25 tests + 38 Outlook tests. |
| **PROV-05** — Manual/agentic follow-ups use shared policy gate + same attempt/history records | ✅ **SATISFIED** | Every origin routes through the Phase 18 dispatcher into one adapter boundary (`outreach-dispatch-provider.ts:16-18` → `outreach-sender.ts:299,375` → `sendComposedOutreachMessage`). Agentic follow-ups carry unsubscribe (`processFollowUps.ts:158-160`); campaigns likewise (`outreach-sender.ts:293-297`). `provider-parity.test.ts:437` runs **3 providers × 9 policy denials** (kill switch, campaign_inactive, account_not_verified, lead_unsubscribed, recipient_suppressed, outside_send_window, daily_limit, warmup_limit, account_spacing) asserting each "never reaches the wire"; `:459` asserts identical durable history; `outreach-provider.test.ts:718` asserts no Graph request when policy denies. |

## Declared Must-Have Verification

### Plan 19-01 — SMTP TLS parity

| Truth | Status | Evidence |
| --- | --- | --- |
| Port 465 implicit TLS while 587 uses STARTTLS | ✅ VERIFIED | `smtp-security.ts:103-117`; 32 tests incl. 465/587/25/nonstandard/override. |
| Verification and delivery derive identical transport options | ✅ VERIFIED | Both call `buildSmtpTransportOptions`; `email-accounts.ts:897` vs `outreach-provider.ts:395`. Only timeouts differ, by design (`smtp-security.ts:157-162`). |
| UI/CSV presets no longer persist secure=true for standard 587 | ✅ VERIFIED | `NewInboxPage.tsx:55,98` (derived, never hardcoded), `parse-mailbox-csv.ts:116`; 422 conflict at write (`email-accounts.ts:57-69,547,647`). |

**Artifact:** `smtp-security.ts` — exists, substantive (182 lines, pure), wired to 4 call sites. **Key links:** both ✅ (send link is transitive via `outreach-provider.ts`, which is the intended boundary).

### Plan 19-02 — Compose-once MIME + provider adapters

| Truth | Status | Evidence |
| --- | --- | --- |
| SMTP/native/Outlook send the same composed MIME headers and body alternatives | ✅ VERIFIED | `outreach-provider.test.ts:405` byte-identical across providers; `provider-parity.test.ts:346` observable-equality. |
| Outlook campaign/manual/agentic replies return a stable Message-ID | ✅ VERIFIED | `outreach-provider.ts:500-503` returns the **precomposed** id (Graph 202 has no body). Bracket handling is consistent end-to-end — dispatcher stores unbracketed (`outreach-dispatch.ts:632`), matcher strips + `LOWER()` compares (`processReplies.ts:350,369`). I traced this specifically because a bracket mismatch would have silently broken Outlook reply matching; it does not. |
| List-Unsubscribe and threading headers verified before provider dispatch | ✅ VERIFIED (with caveat) | Asserted on real transmitted bytes for all three providers (`provider-parity.test.ts:337-341`, `outreach-provider.test.ts:530`). **Caveat:** the *runtime* pre-dispatch guard `findMissingMimeHeaders` checks only `From/To/Subject/Message-ID` (`outreach-provider.ts:160`) and runs only on the Outlook adapter (`:488`). A compose regression dropping List-Unsubscribe would be caught by tests, not at runtime. Campaign/agentic paths supply unsubscribe unconditionally, so the deliverability outcome holds. |

**Artifact:** `outreach-provider.ts` — exists, substantive (541 lines), wired. **Key links:** both ✅.

### Plan 19-03 — Migration 039 + provider-neutral staging

| Truth | Status | Evidence |
| --- | --- | --- |
| Inbound messages deduplicated durably before reply/bounce side effects | ✅ VERIFIED | `outreach-inbound.ts:410-431` then `:459-486`; unique `(org, account, provider, provider_message_id)` (`039:228`); db test `:134` "deduplicates provider messages on the tenant-scoped event key". |
| DSN classification runs before human-reply classification | ✅ VERIFIED | `outreach-inbound.ts:119-167`; tests `:124` "classifies a DSN as a bounce even when it also looks like a reply", `:406` "delivers a bounce to the bounce consumer and never to the reply consumer". |
| Native/IMAP scans bounded and resumable without consuming unread state | ✅ VERIFIED | Bounds + cursors above; `outreach-inbound.test.ts:391` "does not read or mutate user read state"; BODY.PEEK confirmed in imapflow itself. |

**Artifacts:** `039_outreach_provider_events.sql` (271 lines) + `outreach-inbound.ts` (671 lines) — both substantive and wired. **Key links:** both ✅.

### Plan 19-04 — Outlook parity + reply context

| Truth | Status | Evidence |
| --- | --- | --- |
| A verified Outlook account has proven read, **write**, and **send** capability | ⚠️ **PARTIAL** | Read proven via real bounded sync (`outlook.ts:923-936`). Write/send **asserted from scopes** (`:918`), not probed. See Gaps. |
| Graph delta pages create the same normalized reply/bounce events as IMAP/native | ✅ VERIFIED | `outlook-inbound.test.ts:589-692` ("stages a Graph DSN as a bounce, not as a reply"; "records a replayed Graph message exactly once"; "persists the deltaLink only after every event of the chain is staged"). Mocked Graph. |
| Reply body context and all follow-up sends use durable shared contracts | ✅ VERIFIED | `processReplies.ts:404` populates `lastReplyText` via `normalizeReplyText(event.textBody, event.htmlBody)` — the **HTML fallback (`:78-83`) is load-bearing**: Graph returns HTML-only bodies, so without it an Outlook reply would reach the agentic decider as an empty string. |

**Artifacts:** `outlook.ts` bounded delta reader + `provider-parity.test.ts` (743 lines, 64 tests) — both substantive. **Key links:** both ✅ (`lastReplyText` populated; deltaLink persisted only post-staging).

## Migration Discipline

| Check | Result |
| --- | --- |
| 039 hand-written, sequential, idempotent | ✅ `CREATE TABLE/INDEX IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS ... ADD`, guarded `DO $$` blocks. db test applies it **twice** (`:34-37`) against real Postgres. |
| Applied only to disposable Testcontainers Postgres | ✅ `postgres-harness.ts` fails closed on 6 independent guards: per-run guard token (`:51`), explicit test URL (`:55`), Postgres-only (`:66`), **loopback-only host** (`:70`), test marker in DB name (`:75`), and **explicitly refuses to reuse the application `DATABASE_URL`** (`:82`). |
| No `drizzle-kit generate` / `db:push` | ✅ Absent from `package.json`; no occurrence anywhere in the phase diff. |
| `schema.ts` TS mirror matches the SQL | ✅ **Verified by programmatic column diff, not by eye:** cursors 17/17 columns, events 22/22 columns, zero missing/extra, naming consistent, `notNull()` counts match exactly (5/5 and 12/12). Enforced in CI by db test `:264` "keeps the Drizzle mirror aligned with every migration identifier". |
| Tenant binding | ✅ SQL uses a **composite FK** `(email_account_id, organization_id) → email_accounts(id, organization_id)` (`039:93-96,188-190`), proven by db test `:211` "refuses to bind an event to an account owned by another organization". RLS defense-in-depth present (`:232`). |

*Nit (INFO):* the TS mirror expresses single-column `.references()` (`schema.ts:1504-1505,1549-1550`) rather than the composite FK. Harmless — per CLAUDE.md the SQL is the source of truth and Drizzle constraints are never applied — but the TS is weaker than the DB it mirrors.

## Tenant Isolation

| Check | Result |
| --- | --- |
| Phase 18 cross-tenant regression | ✅ Passing (fresh run). |
| New reply-matching queries scoped | ✅ `processReplies.ts:315,368` scope by `emailAccountId`; `findOutreachEmailByMessageId` additionally joins `emailAccounts` on `(id, organizationId)` (`:363-366`); mutations scope by account **and** org (`:390-393,429,436`). |
| Outlook mailbox resolution scoped | ✅ Re-checked against the account's org at both the verify gate (`email-accounts.ts:759-763`) and ingestion (`outreach-inbound-sources.ts:618-622`), with an explicit comment that RLS is bypassed by the app role. |
| Tier-3 correspondent lookup scoped | ✅ `createKnownCorrespondentLookup` binds `oe.email_account_id = accountId` (`sources.ts:652`). |
| `loadCursor` scoping | ✅ Account+provider scoped, not org-scoped (`outreach-inbound.ts:547-554`) — safe, because the composite FK makes `email_account_id` determine the organization. No leak path. |

## Known Deviations — Assessment

| # | Deviation | Verdict |
| --- | --- | --- |
| 1 | Client (`src/pages/outreach/inboxes/*`) imports server `smtp-security.ts`, crossing `tsconfig.json`'s `exclude: ["src/server/**"]` | **ACCEPTABLE today — but unguarded.** I verified empirically rather than trusting the argument: (a) `smtp-security.ts` has **zero imports** — genuinely dependency-free; (b) the built client bundle contains **no** `nodemailer`/`drizzle-orm`/`imapflow` (the only `postgres` hits are supabase-realtime's `postgres_changes` strings — a false positive I chased down); (c) `exclude` does **not** exclude imported files, so `tsc -p tsconfig.json --listFiles` confirms `smtp-security.ts` **is** in the client program and is typechecked. The executor's reasoning (one rule beats four drifting copies) is sound and the sharing is exactly what makes PROV-01 hold end-to-end. **Risk:** the "keep it pure" invariant is enforced only by a code comment — there is no `no-restricted-imports` rule and no test. A future `import { db }` in that file would silently pull server deps into the client bundle. Recommend the proposed `src/shared/` tier, or a lint rule, in a later phase. Not a phase-19 gap. |
| 2 | Outlook send capability asserted via scopes, not probed; manual sandbox gate unproven | **GAP** — the one item flipping this phase to `gaps_found`. The *reasoning* is correct (Graph genuinely has no zero-send probe; a draft exercises Mail.ReadWrite, not Mail.Send; sending a live test email is the exact behaviour this phase exists to prevent) and the code documents it honestly and surfaces `gate` to the caller. But the **declared truth says "proven"**, and 19-04's own `<verification>` mandates a real-tenant sandbox run that never happened. See Gaps. |
| 3 | `retry_at` persisted but not honoured | **REAL, minor — confirmed.** `recordCursorRetry` writes it (`outreach-inbound.ts:657`) and `039:136` even indexes it (`idx_outreach_provider_cursors_due`), but `loadCursor` never selects it (`:550`) and `ingestOutreachInbound` visits **every** verified account each tick with no due-filter (`sources.ts:533-552`). So a Graph `Retry-After` is bookkeeping only — the next tick calls Graph anyway. Not in any declared truth (locked decision #4 requires *storing* bounded resumable state, which is done), and not a safety issue, but it is an index and a column supporting behaviour that does not exist. Worth closing when Graph throttling becomes real. |
| 4 | `ingestInboundPage` truncate-and-advance is a latent trap | **LATENT — and better defended than self-reported.** I tried hard to make this live and could not. `ingestInboundPage` does truncate then advance (`:384,438`), and `outreach-inbound.test.ts:230` even codifies the lossy behaviour (900→500 staged) without asserting the loss. But all three real sources cannot overshoot: native uses SQL `limit: pageSize` (`sources.ts:110`); IMAP slices to `pageSize` and derives its high-water only from messages actually fetched (`:299,302-313`); Graph sets **`top = Math.min(GRAPH_DELTA_PAGE_TOP, maxEvents)`** (`outlook.ts:214`) *and* defers a page that would overshoot (`:320-322`, "Invariant 3"). I specifically checked the `syncOutlookInboundOnce` path (`pageSize: 25` — below `$top`'s 50) expecting data loss; the `Math.min` makes it safe. Residual is first-page-only, and only if a provider ignores `$top`. Accept. |
| 5 | `schema.ts` retains DB-level `.default(true)` on `smtpSecure` | **COSMETIC.** All three outreach write paths canonicalize explicitly (`email-accounts.ts:367,561,650` via `canonicalSmtpSecure`), and native accounts store `null` (`:525`), so the default is never exercised. Even if a future path omitted it, the resolver normalizes at both verify and send, so it cannot cause a wrong dial. Defense in depth holds. |
| 6 | `mailboxes` (webmail) carries the same latent TLS bug, out of scope | **ACCEPTABLE — correctly scoped, worth tracking.** Confirmed live: `mail-sync.ts:521` passes `secure: smtpSecure` straight to Nodemailer with `smtp_port` defaulting to 587 and `smtp_secure` to `true` (`schema.ts:1228,1231`) — the identical PROV-01 bug class. The phase goal is outreach-only, so excluding it is right. But the resolver now exists and this path is one import away from adopting it; it should not be forgotten. |

## Gaps

### GAP-1 (only blocking gap) — PROV-02: "proven send capability" is asserted, and the real-tenant gate is unrun

**Declared truth (19-04):** *"A verified Outlook outreach account has proven read, write, and send capability."*

**What the code actually does:**
- **Read — proven.** `probeInbound` runs a real bounded delta sync; failure ⇒ `pending`/`failed`, never verified (`outlook.ts:923-936`).
- **Write (`Mail.ReadWrite`) — asserted.** Scope-list membership only (`outlook.ts:918`).
- **Send (`Mail.Send`) — asserted.** Scope-list membership only. Documented at `OUTLOOK_CAPABILITY_GATE` (`:881-883`) and returned to the caller as `gate` (`email-accounts.ts:824`).

**Why it is a gap rather than a nit:** the truth claims proof; the code provides an assertion. Per the rule that a requirement resting on inference or documentation rather than code/tests cannot pass, this cannot be scored ✅. Compounding it, **plan 19-04's `<verification>` block mandates a manual Outlook sandbox gate that has not been executed** — so the whole Graph surface (MIME `sendMail` acceptance, delta/410 semantics, throttling, scope shape) is verified only against `vi.mock`'d `fetch`. 38 well-designed tests cannot tell you that Microsoft agrees with your mock.

**Why it is narrow:** the safety property that matters — *an Outlook account can never be verified send-only* — **is** proven by code and tests. The gate refuses on unlinked mailbox, cross-org mailbox, address mismatch, inactive mailbox, missing scopes, and failed inbound sync, with a correct transient (`pending`) vs terminal (`failed`) split (`:926-935`). Nothing here can ship a regression to a user; it can only ship an over-claim.

**To close:**
1. Run the 19-04 sandbox gate against a real tenant (see `human_verification` in the frontmatter).
2. Reword the declared truth to match reality — *"proven inbound capability; send capability asserted from granted scopes"* — which is precisely what `OUTLOOK_CAPABILITY_GATE` already says. The code is more honest than the plan.

### Advisory (non-blocking, no re-plan required)

- **A-1** `retry_at` is written and indexed but never honoured (Deviation 3). Close when Graph throttling is observed in production.
- **A-2** The runtime pre-dispatch header guard excludes `List-Unsubscribe`/threading and runs only on the Outlook adapter (`outreach-provider.ts:160,488`). Tests cover the gap; runtime does not.
- **A-3** The client→server import boundary is safe but enforced only by a comment (Deviation 1). Prefer `src/shared/` or a `no-restricted-imports` rule.
- **A-4** The webmail `mailboxes` TLS path retains the PROV-01 bug class (Deviation 6). Out of scope; track it.
- **A-5** `outreach-inbound.test.ts:230` codifies truncate-and-advance without asserting the resulting message loss — it documents the trap rather than guarding it.

## Score

**11/12 declared truths verified** · **6/6 artifacts** exist, substantive, wired · **8/8 key links** wired · **315/315 tests**, 4/4 gates green.

The single partial truth is GAP-1.

---

*Verified: 2026-07-16 · Verifier: Claude (gsd-verifier, Opus 4.8)*
*Methodology: goal-backward verification against source, composed bytes, live Postgres, and the imapflow library itself. Summaries were treated as claims under test, not as evidence. Not committed — left for the orchestrator to bundle.*
