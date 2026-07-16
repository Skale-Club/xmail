# Phase 19 Context — Provider Parity and Deliverability

## Goal

Make SMTP, native, and Outlook outreach accounts obey equivalent transport, unsubscribe, threading, reply, and bounce contracts. Provider differences may affect implementation, but they must not silently remove safety or history.

## Inputs

- Phase 18 shared `outreach-delivery-policy.ts` and `outreach-dispatch.ts`
- `src/server/lib/outreach-sender.ts`
- `src/server/lib/outlook.ts`
- `src/server/routes/outreach/email-accounts.ts`
- `src/server/jobs/processReplies.ts`
- `src/server/jobs/processBounces.ts`
- `src/server/jobs/processFollowUps.ts`
- `src/db/schema.ts`
- `.planning/REQUIREMENTS.md` (`PROV-01` through `PROV-05`)

## Locked decisions

1. SMTP port 465 defaults to implicit TLS (`secure: true`). Ports 587/25 use explicit STARTTLS semantics (`secure: false`, with `requireTLS` when configured/expected). The same resolver is used for verify and send.
2. Outreach messages are composed once as MIME, with stable Message-ID, unsubscribe, reply-to, and threading headers, then dispatched through a provider adapter. Outlook uses Graph MIME send rather than the limited JSON message shape so headers do not disappear.
3. Inbound sync is provider-neutral. Native rows, IMAP messages, and Graph delta messages normalize into durable `outreach_provider_events` keyed by `(email_account_id, provider_message_id)` before side effects.
4. `outreach_provider_cursors` stores bounded resumable provider state. Graph stores delta links; IMAP stores UID validity/high-water data without using read/unread as a processing cursor; native stores a received-at/id tie breaker.
5. Classification happens once, DSN/bounce before auto-reply before human reply. Reply and bounce jobs consume the same durable classification so they cannot race by marking a DSN read first.
6. Full text/html reply bodies and provider attachment metadata (ID, name, MIME type, size, inline/content-id) are retained in provider events; binary blobs are deferred. `campaign_leads.last_reply_text` is populated from normalized text.
7. Migration 039 creates provider-event/cursor tables with RLS defense-in-depth and tenant/index constraints. Phase 21 consumes these rows to materialize conversation messages.
8. Outlook activation requires Mail.Read, Mail.ReadWrite, and Mail.Send plus a successful initial bounded sync. A capability failure leaves the outreach account pending/failed, never send-only verified.
9. Manual/agentic sends continue through Phase 18's dispatcher and therefore receive the same attempt record, policy, limits, spacing, and provider adapters as campaigns.

## Deferred

- Conversation/read-state APIs: Phase 21.
- Operator thread UI, attachments, scheduling: Phase 22.
- AI prompt/decision audit and autonomous controls: Phase 23.
