# Requirements — v1.4 Reliable Outreach + Unified Inbox

**Defined:** 2026-07-15  
**Status:** Planned

## Safety and execution reliability

- [x] **SAFE-01** — The organization outreach kill switch blocks campaign sends, manual outreach sends, and automated follow-ups before provider dispatch.
- [x] **SAFE-02** — Email, delay, and condition sequence steps have explicit execution semantics; only email steps can call a provider.
- [x] **SAFE-03** — Queue claims use leases, bounded attempts, retry classification, backoff, and stale-claim recovery without duplicate sends.
- [x] **SAFE-04** — Due work is deterministically ordered and fairly selected so blocked rows cannot starve sendable leads beyond a 200-row scan.
- [x] **SAFE-05** — Campaigns automatically complete only when every enrolled lead is terminal; pre-send exclusions do not corrupt completion or rates.
- [x] **SAFE-06** — A test harness covers queue claims, step transitions, suppression, retries, throttling, and tenant isolation.

## Provider parity and deliverability

- [x] **PROV-01** — SMTP presets and verification use correct implicit-TLS versus STARTTLS behavior, including port 587.
- [x] **PROV-02** — Outlook accounts ingest replies and bounces with bodies and stable provider identifiers, or cannot be activated for outreach until parity is available.
- [x] **PROV-03** — Every supported outbound provider emits equivalent unsubscribe metadata and preserves Message-ID/threading headers.
- [x] **PROV-04** — Native DSNs cannot be consumed as human replies; IMAP/Graph bounce scans are bounded, resumable, and idempotent.
- [x] **PROV-05** — Manual and agentic follow-ups use the shared delivery-policy gate and persist the same send-attempt/history records as campaign emails.

## Product and API consistency

- [x] **CONS-01** — Each campaign has an unambiguous canonical sequence; editing replaces/upserts ordered steps transactionally instead of appending duplicates.
- [x] **CONS-02** — Organization admins/members authorized by the backend can access outreach UI routes; platform-only administration remains separate.
- [x] **CONS-03** — Outreach settings are either consumed as documented defaults/notification policy or removed from the public contract.
- [x] **CONS-04** — Lead search, pagination, sort, and filters have matching UI/API contracts and bounded queries.
- [x] **CONS-05** — Campaign metrics use explicit eligible/sent denominators and exclude pre-send suppressions/unsubscribes where appropriate.
- [x] **CONS-06** — Service authentication binds identity and tenant scope server-side and never trusts a caller-selected user header.
- [x] **CONS-07** — API validation, Drizzle schema declarations, and hand-written SQL migrations enforce the same sequence/account invariants.

## Unified Inbox foundation

- [x] **UIF-01** — Durable conversation, message, participant, provider-cursor, and per-user read-state tables exist with tenant-safe indexes and SQL migration(s).
- [x] **UIF-02** — Native, IMAP, and Outlook ingestion persists full normalized messages idempotently, including text/html bodies, headers, attachments metadata, and direction.
- [x] **UIF-03** — Incoming messages are attributed to organization, account, lead, campaign, and outreach email using Message-ID/References plus bounded address heuristics.
- [x] **UIF-04** — Organization-scoped APIs provide conversation list/detail, filters, keyword search, unread counts, and read/unread mutation with cursor pagination.
- [x] **UIF-05** — Ingestion jobs, APIs, and database access explicitly enforce tenant boundaries and expose operational cursors/errors without leaking content.

## Unified Inbox operator experience

- [x] **UIX-01** — Outreach navigation includes a centralized Unified Inbox with a conversation list and full thread view across connected accounts.
- [x] **UIX-02** — Operators can filter by unread/status/campaign/account/label and perform bounded keyword search with shareable URL state.
- [x] **UIX-03** — Operators can reply, reply-all, and forward with quoted context, correct provider/thread headers, attachments, and shared send-policy enforcement.
- [x] **UIX-04** — Operators can mark read/unread, label, archive, bulk-act, and add a sender/domain to suppression/blocklist with confirmation.
- [x] **UIX-05** — Scheduled replies, reminders, reusable snippets/macros, and attachment handling are durable and recover across restarts.
- [x] **UIX-06** — New-reply notifications and unread counts are visible without polling every thread and degrade safely when provider sync fails.

## AI assistance and automation

- [x] **AI-01** — AI context is built from persisted conversation messages; reply body context is never inferred from headers-only data.
- [x] **AI-02** — The inbox offers on-demand draft suggestions with source context, editable output, failure fallback, and no implicit send.
- [ ] **AI-03** — Autonomous follow-up is explicitly enabled per organization/campaign and exposes pause/kill controls.
- [ ] **AI-04** — AI sends pass the same suppression, daily-limit, warm-up, spacing, account-health, and organization-enable checks as every other outreach send.
- [x] **AI-05** — Prompt/model/version/input references, decisions, approvals, sends, and failures are auditable; representative evaluations cover unsafe or incorrect actions.
- [x] **AI-06** — API/UI expose automation status and history without leaking credentials, prompts, or cross-tenant message content.

## Traceability

| Phase | Requirements |
|---|---|
| 18 — Outreach Safety and Execution Reliability | SAFE-01..SAFE-06 |
| 19 — Provider Parity and Deliverability | PROV-01..PROV-05 |
| 20 — Outreach Product and API Consistency | CONS-01..CONS-07 |
| 21 — Unified Inbox Foundation | UIF-01..UIF-05 |
| 22 — Unified Inbox Operator Experience | UIX-01..UIX-06 |
| 23 — AI Inbox Automation and Guardrails | AI-01..AI-06 |

**Coverage:** 35/35 requirements mapped.

