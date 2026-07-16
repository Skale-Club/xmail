# Phase 22 — Unified Inbox Operator Experience UAT

**Scope:** the operator-facing Unified Inbox (`/outreach/unified-inbox`) delivered by plans
22-01..22-05. This is a deterministic, executable acceptance script covering responsive layout,
accessibility, tenant isolation, every async state, destructive flows, the durable send/schedule
path, near-real-time convergence + degraded-sync fallback, restart recovery, and provider reply
smoke.

**How to read this doc**

- **AUTO** steps are proven by the automated suite (`npm run test`); the referenced test file/case
  is the evidence. They pass in CI on every commit and require no manual action.
- **MANUAL** steps require a running app + browser (and, for provider smoke, deployed credentials).
  They are written as numbered steps with an explicit expected result and an **Evidence** slot.
- A step is only **PASS** when its expected result is observed. Provider-gated parity that cannot be
  exercised in this environment is recorded as **BLOCKED (provider-gated)** — never silently passed.

**Automated gate snapshot (2026-07-16, plan 22-05):**
`npm run test` → **692 passed / 692** (50 files) · `npm run build` PASS · `npm run lint` PASS
(0 warnings) · client `tsc` PASS · server `tsc` PASS.

---

## 0. Preconditions & deterministic fixtures

Two organizations with distinct members exercise tenant isolation; the fixtures cover every async
and destructive state the UI must render.

| Fixture | Value |
| --- | --- |
| **Org A** | `Acme Outreach` — user `operator-a@acme.test` (role: admin) |
| **Org B** | `Globex Outreach` — user `operator-b@globex.test` (role: member) + `viewer-b@globex.test` (role: viewer) |
| Sending accounts (Org A) | 1 × `native` (`rep@skale.club`), 1 × `smtp` (IMAP/SMTP), 1 × `outlook` (Graph) |
| Conversations (Org A) | ≥ 3 **unread** inbound replies; 1 with **attachments**; 1 with **unknown attribution** (`campaignId`/`leadId` NULL → "Not linked"); 1 **archived** |
| Sync health (Org A) | 1 account row with `last_error_at > last_success_at` → degraded (category e.g. `auth`) |
| Scheduled fixtures | 1 send command `scheduled` with `due_at` ~2 min out; 1 reminder `scheduled` due ~2 min out |
| Policy-denial fixture | Org A `outreach_settings.enabled = false` (paused) OR a suppressed recipient, to force a recoverable denial |
| Org B data | ≥ 2 conversations that must NEVER appear under Org A |

**Migration state:** migration `042_unified_inbox_operator_workflows.sql` applied after 038→041.
Windows apply (revalidated filename):

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/042_unified_inbox_operator_workflows.sql
```

**Start the app:** `npm run dev` (client `:9000`, server `:9001`). Sign in as `operator-a@acme.test`,
select **Acme Outreach**, open **Inbox** in the outreach nav.

---

## 1. Tenant isolation & authorization (verification boundary)

| # | Type | Step | Expected | Result |
| --- | --- | --- | --- | --- |
| 1.1 | AUTO | Org-scoped query keys never reuse another tenant's cache | `inboxKeys.*(ORG_A) !== *(ORG_B)`; list signature ignores cursor/selection | PASS — `UnifiedInboxPage.test.tsx › unified-inbox-api: org-scoped query keys` |
| 1.2 | AUTO | Optimistic rollback never touches another org's cache | Org B cache byte-identical after an Org A rollback | PASS — `operator mutations › never touches another organization’s cache on rollback` |
| 1.3 | AUTO | SSE stream is org-scoped; cross-tenant events never delivered | Org A subscriber receives nothing for an Org B publish | PASS — `inbox-events.test.ts › cross-tenant denial` |
| 1.4 | MANUAL | As `operator-a`, deep-link an Org B conversation id (`?conversation=<orgB id>`) | Thread pane shows a not-found/`Select a conversation` state; no Org B content renders | ☐ |
| 1.5 | MANUAL | As `viewer-b`, open the inbox | Conversations are readable; every mutation control (archive/label/reply/block) is absent or disabled (viewer read-only) | ☐ |

---

## 2. Responsive layout — 1440×900, 1024×768, 390×844

Resize the viewport (DevTools device toolbar) to each width and verify the staged layout.

| # | Type | Viewport | Step / Expected | Result |
| --- | --- | --- | --- | --- |
| 2.1 | MANUAL | **1440×900 (desktop)** | Three regions visible: filter rail (224px) + list (360–420px) + thread (fluid). 1px borders, no nested cards. | ☐ |
| 2.2 | MANUAL | 1440×900 | Thread pane shows subject/status header, attribution strip, ordered messages, composer footer. | ☐ |
| 2.3 | MANUAL | **1024×768 (tablet)** | Filter rail hidden behind a **Filters** button with an active-filter count; list + thread stay split. | ☐ |
| 2.4 | MANUAL | 1024×768 | Opening **Filters** shows the overlay sheet; Escape / backdrop closes it and restores focus to the Filters button. | ☐ |
| 2.5 | MANUAL | **390×844 (mobile)** | Exactly ONE stage visible: the conversation list. No three-column squeeze. | ☐ |
| 2.6 | MANUAL | 390×844 | Tapping a row swaps to the thread stage with a labeled **Back** control; Back returns to the list preserving search/filter/scroll. | ☐ |
| 2.7 | MANUAL | 390×844 | The composer opens as a full-height stage; Attach/Schedule controls remain reachable above the on-screen keyboard. | ☐ |
| 2.8 | AUTO | Stage swap is pure CSS keyed on selection; Back returns to list | List→thread swap + Back wiring | PASS — `UnifiedInboxPage: tenant isolation + selection › returns to the list stage when Back is pressed` |

---

## 3. Async states — list + thread (loading / empty / error / success)

| # | Type | Step | Expected | Result |
| --- | --- | --- | --- | --- |
| 3.1 | AUTO | List loading | 8 fixed-size row skeletons + an accessible `Loading conversations` status | PASS — `ConversationList: async states › shows fixed row skeletons…` |
| 3.2 | AUTO | Global empty | `No outreach replies yet` | PASS — `ConversationList › shows the global empty state` |
| 3.3 | AUTO | Filtered empty | `No conversations match these filters` + working **Clear filters** | PASS — `ConversationList › shows a filtered empty state with Clear filters` |
| 3.4 | AUTO | Search empty | Echoes a safely-truncated search term | PASS — `ConversationList › echoes a truncated search term` |
| 3.5 | AUTO | List error | Inline **Retry**; a loaded thread is never blanked | PASS — `ConversationList › renders an inline retry on list failure` |
| 3.6 | AUTO | Thread loading | Header/message skeletons only in the thread pane; list stays interactive | PASS — `ConversationThread: async states › shows a thread skeleton while loading` |
| 3.7 | AUTO | Thread error | Thread-only **Retry**; list stays usable | PASS — `ConversationThread › offers a thread-only retry on failure` |
| 3.8 | AUTO | Thread success | Subject/attribution/campaign render; HTML isolated in a non-`allow-scripts` iframe | PASS — `ConversationThread › renders the subject…` + `isolates malformed HTML…` |
| 3.9 | AUTO | Unknown attribution | Shows `Not linked` (× participants/campaign) | PASS — `ConversationThread › shows "Not linked" when attribution is unknown` |
| 3.10 | MANUAL | Load-more | One inline row spinner with `aria-live=polite`; prior rows retained; bounded cursor page appended | ☐ |
| 3.11 | MANUAL | Mutation-in-flight | Only the affected control disables; the workspace does not freeze | ☐ |

---

## 4. Filters, search & URL state

| # | Type | Step | Expected | Result |
| --- | --- | --- | --- | --- |
| 4.1 | AUTO | Every filter round-trips through the URL | Full state build→parse is lossless; defaults omitted; deterministic | PASS — `unified-inbox-url: parse + serialize round-trip` |
| 4.2 | AUTO | Invalid/unknown params scrubbed | Bad enums/uuids/unknown keys dropped to defaults | PASS — `unified-inbox-url: validation + bounding` |
| 4.3 | AUTO | Cursor resets only on a filter change | Cursor kept across selection/load-more; dropped when a filter changes | PASS — `unified-inbox-url: cursor reset semantics` |
| 4.4 | AUTO | Server-side query mapping | State maps to the exact Phase 21 `GET /conversations` query; archived hidden by default | PASS — `unified-inbox-api: server query mapping` |
| 4.5 | MANUAL | Type a search term, reload the page | The URL carries `q=`; results match; filter chips retained | ☐ |
| 4.6 | MANUAL | Switch quick views (Inbox/Unread/Needs reply/Reminders/Archived) | Each view updates the URL and highlights; a shared link reproduces the exact view | ☐ |

---

## 5. Keyboard navigation, focus & accessibility contract

| # | Type | Step | Expected | Result |
| --- | --- | --- | --- | --- |
| 5.1 | MANUAL | Tab through the workspace | Ordered landmarks: filters → list → thread. One visible `<h1>` "Unified Inbox". | ☐ |
| 5.2 | MANUAL | List rows | Arrow Up/Down move focus; Enter opens; every row is a real link/button with a visible `:focus-visible` ring. | ☐ |
| 5.3 | MANUAL | Icon buttons | Every icon control has an accessible name; mobile targets are ≥ 44×44px. | ☐ |
| 5.4 | MANUAL | Dialogs (suppression, discard-draft) | Opening moves focus into the dialog; Escape/close restores focus to the trigger. | ☐ |
| 5.5 | MANUAL | Live region | Result count, new-reply arrival, load failures, and command-state changes are announced (`aria-live`). | ☐ |
| 5.6 | MANUAL | Contrast (light + dark) | Toggle theme; unread and error states use text + icon, never hue alone; contrast passes in both themes. | ☐ |
| 5.7 | AUTO | Checkbox labels name the conversation, not "Select row" | Bulk checkbox is `Select conversation with <lead>` | PASS — `UnifiedInboxPage: bulk selection is loaded-set bounded` |
| 5.8 | AUTO | Escape does not silently drop an unsaved composer | Dirty Cancel opens a "Discard draft?" alertdialog with Keep editing | PASS — `ConversationComposer › asks for confirmation before discarding an unsaved draft` |
| 5.9 | AUTO | Older messages toggle by keyboard-operable buttons | `aria-expanded` toggles; latest inbound auto-expands | PASS — `ConversationThread: expansion` |

---

## 6. Operator actions — read/label/archive/status + bounded bulk

| # | Type | Step | Expected | Result |
| --- | --- | --- | --- | --- |
| 6.1 | AUTO | Single actions (read/archive/status) | Accessible controls fire the right handler with current state | PASS — `ConversationActions: single accessible actions` |
| 6.2 | AUTO | Optimistic update + rollback on 4xx/5xx | Both list + thread caches restored byte-for-byte on 403/409/500 | PASS — `operator mutations › restores the EXACT prior list + thread state…` |
| 6.3 | AUTO | Labels attach/detach as named checkbox controls | `aria-checked` reflects state | PASS — `ConversationActions › attaches/detaches a label` |
| 6.4 | AUTO | Bulk is bounded + honest | Real selected count; disabled at 0; refuses > 100 with an alert; select loaded-only | PASS — `BulkActionsBar: bounded + honest selection` |
| 6.5 | AUTO | Bulk request carries exactly the selected ids | POST body is the chosen loaded ids, never a filter-wide selector | PASS — `operator mutations › applies a bounded bulk read to only the selected loaded ids` |
| 6.6 | MANUAL | Mark a conversation read | Row unread weight/dot clears immediately; unread badge decrements; server reconciles | ☐ |
| 6.7 | MANUAL | Archive from the thread header | Row leaves the (non-archived) view after the server re-filter; appears under Archived | ☐ |

---

## 7. Destructive suppression (server-authoritative, locked #8)

| # | Type | Step | Expected | Result |
| --- | --- | --- | --- | --- |
| 7.1 | AUTO | Cancel makes NO apply call | `apply` never called after Cancel | PASS — `suppression confirmation gating › cancelling the block makes NO apply call` |
| 7.2 | AUTO | Sender block on explicit confirm | `apply(email, 'sender')` after confirm | PASS — `… › blocks a sender on explicit confirm` |
| 7.3 | AUTO | Domain block requires TWO confirms | Continue → Block domain → `apply(email,'domain')` | PASS — `… › requires TWO confirms for a safe domain block` |
| 7.4 | AUTO | Public/free-mail domain refused | "Domain block not allowed"; only safe sender scope offered; no domain apply | PASS — `… › refuses a domain block on a public/free-mail domain` |
| 7.5 | AUTO | Server denial keeps dialog + reason | 403 keeps the dialog open with a Retry; selection intact | PASS — `… › keeps the dialog open with the reason when the server denies` |
| 7.6 | MANUAL | Block the fixture sender, then verify a fresh reply from that sender/domain is denied by the delivery policy | New outbound to the blocked address/domain is suppressed (`recipient_suppressed`) | ☐ |

---

## 8. Reply / reply-all / forward composer + attachments + schedule

| # | Type | Step | Expected | Result |
| --- | --- | --- | --- | --- |
| 8.1 | AUTO | Collapsed to modes; never sends inline | Reply/Reply all/Forward buttons; no body until a mode is chosen | PASS — `ConversationComposer › is collapsed to mode buttons and never sends inline` |
| 8.2 | AUTO | Durable reply command with stable idempotency key; server resolves recipients | Input has mode/body/`idempotencyKey` and NO reply-mode recipients | PASS — `… › creates a durable reply command carrying a stable idempotency key` |
| 8.3 | AUTO | Reply-all Cc is server-resolved (display note) | Cc shown "resolved by the server" | PASS — `… › shows resolved Cc for reply-all` |
| 8.4 | AUTO | Forward requires valid recipients before send | Send disabled until a valid email is entered | PASS — `… › requires valid forward recipients before it can send` |
| 8.5 | AUTO | No double-submit while a create is in flight | Button disabled during send; single call | PASS — `… › does not submit twice while a create is in flight` |
| 8.6 | AUTO | Schedule shows the timezone; sends `scheduledAt` | TZ displayed; `scheduledAt` non-null | PASS — `… › schedules a reply with an explicit time and shows the timezone` |
| 8.7 | AUTO | Snippet insertion | Snippet inserted into the body | PASS — `… › inserts a snippet into the body` |
| 8.8 | AUTO | Attachment upload error preserves the body | Error surfaced; typed body kept | PASS — `… › shows an upload error and preserves the typed body` |
| 8.9 | AUTO | Create failure preserves the draft + shows the reason | Body intact; reason shown | PASS — `… › preserves the draft and shows the reason when the create fails` |
| 8.10 | AUTO | Recoverable policy denial from polled command | e.g. `organization_disabled` → "Outreach is paused"; body kept | PASS — `… › renders a recoverable policy denial from the polled command state` |
| 8.11 | AUTO | Cancel a scheduled command | `onCancelCommand(id)` fired | PASS — `… › offers Cancel for a scheduled command` |
| 8.12 | MANUAL | Attachment success | Filename/size/MIME shown; a real (bounded, private-bucket) attachment uploads and is downloadable via a signed URL | ☐ (needs Storage) |

---

## 9. Near-real-time convergence + degraded-sync fallback (UIX-06, locked #9)

| # | Type | Step | Expected | Result |
| --- | --- | --- | --- | --- |
| 9.1 | AUTO | Stream carries only ids/counts (no bodies/addresses) | Redaction whitelist; SSE frame excludes content | PASS — `inbox-events.test.ts › carries the unread aggregate…` + `SSE framing` |
| 9.2 | AUTO | Client connects with authenticated fetch, NOT EventSource | `fetchWithAuth` to `/events?organizationId=…`; EventSource never constructed | PASS — `useUnifiedInboxEvents › connects with an authenticated fetch…` |
| 9.3 | AUTO | Signal converges badge + list + open thread only | unread/list/detail-namespace invalidated (only the open thread refetches) | PASS — `… › converges the badge, list, and OPEN thread` |
| 9.4 | AUTO | Disconnect → bounded unread/list polling; never per-thread; visible stale | `reconnecting`/`isStale`; poll invalidates unread+list, NOT detail | PASS — `… › falls back to BOUNDED unread/list polling with a visible stale state` |
| 9.5 | AUTO | Teardown aborts the stream on unmount/org switch | `AbortSignal.aborted === true` after unmount | PASS — `… › aborts the stream and clears timers on unmount` |
| 9.6 | AUTO | An incoming event never clobbers the composer or steals focus | Body value + `document.activeElement` preserved across an event-driven re-render | PASS — `near-real-time convergence does not clobber an active composer or steal focus` |
| 9.7 | AUTO | Degraded state is visible + color-independent | "Updates delayed" + "Conversations remain readable" | PASS — `InboxSyncStatus: visible degraded near-real-time state` |
| 9.8 | MANUAL | With two browsers (both Org A) open on the inbox, ingest a new inbound reply (materializer tick) | The other browser's unread badge + list update within seconds WITHOUT a manual refresh; the open thread converges | ☐ |
| 9.9 | MANUAL | Kill the SSE connection (DevTools → offline, or block `/events`) | Footer shows "Updates delayed"; list/unread keep refreshing on the bounded poll; NO per-thread polling; existing threads stay readable | ☐ |
| 9.10 | MANUAL | Restore the connection | Footer returns to live; push resumes; the fallback poll stops | ☐ |

> **Fanout scope (documented):** production runs a single `xmail` container (CLAUDE.md), so the
> in-process event bus reaches every open SSE connection. Multi-process fanout is intentionally not
> implemented; the bounded list/unread polling fallback is the authoritative safety net if a signal
> is ever missed (proxy buffering, a future horizontal scale-out). Behind a buffering proxy the
> stream may never deliver — 9.9's polling fallback is what keeps the inbox correct there.

---

## 10. Durable scheduling & restart recovery (locked #6)

| # | Type | Step | Expected | Result |
| --- | --- | --- | --- | --- |
| 10.1 | AUTO | Claimer is lease-safe + at-most-once across a restart | Reclaimed `sending` row finalizes `sent` via idempotency, no resend | PASS — `inbox-command-dispatch.test.ts` (executor/lease) + 22-01 DB claimer tests |
| 10.2 | AUTO | Reminder notifies exactly once (transactional) | Duplicate tick / restart notifies once | PASS — 22-01 `inbox-operator.db.test.ts` reminder dedup |
| 10.3 | MANUAL | Schedule a reply ~2 min out. Before `due_at`, restart the Node process (`Ctrl-C`, `npm run dev`). | After restart the scheduled command dispatches **exactly once** at its due time; `inbox_send_commands.status = 'sent'`; the thread shows one new outbound message. | ☐ |
| 10.4 | MANUAL | Same for a scheduled reminder | The reminder fires once (a single `user_notification`), never twice. | ☐ |

---

## 11. Provider reply smoke (do NOT pass unsupported parity)

Reply/reply-all/forward ride the Phase 19 shared dispatch path (`createThreadedDispatchProvider` →
`composeOutreachMime`), so the composed MIME is byte-identical across providers.

| # | Provider | Step | Expected | Result |
| --- | --- | --- | --- | --- |
| 11.1 | `native` | Reply from the native account to a seeded inbound thread | Sent; `In-Reply-To`/`References` set; sent copy filed | ☐ BLOCKED (needs deployed native mailbox) |
| 11.2 | `smtp` (IMAP/SMTP) | Reply-all with Cc + attachment | Sent; Bcc rides the envelope, not the header | ☐ BLOCKED (needs deployed SMTP creds) |
| 11.3 | `outlook` (Graph) | Reply with Cc | Sent; Bcc is refused by Graph MIME (documented, not a regression) | ☐ BLOCKED (needs deployed Outlook OAuth) |

> Provider smoke is **BLOCKED (provider-gated)** in this environment — no production credentials or
> Supabase Storage are available. The send path itself is the same policy-gated dispatcher verified
> in Phases 18–21 and is exercised end-to-end by the DB executor test. Outlook Bcc non-parity is a
> known provider limitation (Graph refuses Bcc), recorded in 22-04 — it must be re-verified on the
> deployed host, not marked pass here.

---

## 12. Acceptance summary

| Area | Automated (CI) | Manual (deployed) |
| --- | --- | --- |
| Tenant isolation / auth | ✅ 1.1–1.3 | ☐ 1.4–1.5 |
| Responsive stages | ✅ 2.8 | ☐ 2.1–2.7 |
| Async states (list/thread) | ✅ 3.1–3.9 | ☐ 3.10–3.11 |
| URL/filter state | ✅ 4.1–4.4 | ☐ 4.5–4.6 |
| Keyboard/focus/a11y | ✅ 5.7–5.9 | ☐ 5.1–5.6 |
| Operator actions + bulk | ✅ 6.1–6.5 | ☐ 6.6–6.7 |
| Suppression | ✅ 7.1–7.5 | ☐ 7.6 |
| Composer/schedule/attachments | ✅ 8.1–8.11 | ☐ 8.12 |
| Near-real-time + fallback | ✅ 9.1–9.7 | ☐ 9.8–9.10 |
| Restart recovery | ✅ 10.1–10.2 | ☐ 10.3–10.4 |
| Provider smoke | — | ☐ 11.1–11.3 BLOCKED (provider-gated) |

**Automated acceptance: PASS** — every AUTO row is green in `npm run test` (692/692) at plan 22-05.
**Manual acceptance: PENDING** — the MANUAL rows require a deployed app + browser; provider smoke
(§11) is **BLOCKED (provider-gated)** until deployed credentials + Supabase Storage exist, and must
not be recorded as pass from screenshots or unit tests alone.

### Unresolved / carried-forward items

1. Real attachment upload/download (8.12) needs the private Supabase `inbox-attachments` bucket
   (created by migration 042 where a `storage` schema exists) — verify post-deploy.
2. Provider reply smoke (11.1–11.3) needs deployed native/SMTP/Outlook accounts — BLOCKED here.
3. Behind a stream-buffering proxy, near-real-time may degrade to the bounded polling fallback
   (9.9) permanently; this is safe and visible by design, not a defect.
