# Phase 19 Research — Provider and Inbound Findings

## SMTP

`email_accounts.smtp_port` defaults to 587 while `smtp_secure` defaults true. Both `createSmtpTransporter` and account verification pass that boolean directly to Nodemailer. For Nodemailer, `secure: true` means TLS from connection start (normally port 465); STARTTLS submission on 587 starts clear and upgrades, so it needs `secure: false` with TLS upgrade policy. Send and verification currently duplicate configuration and can disagree after future edits.

## Outlook outbound

`sendMessageWithOutlook` calls `/me/sendMail` with Graph JSON. The outreach sender explicitly notes that List-Unsubscribe headers are omitted. It also returns no Message-ID. `sendThreadedReply` is documented SMTP/native-only. Graph supports sending MIME content; composing MIME through Nodemailer first provides one header-preserving path for unsubscribe, Message-ID, In-Reply-To, References, and body alternatives.

## Outlook inbound

OAuth already requests `Mail.Read`, `Mail.ReadWrite`, and `Mail.Send`, and token refresh is implemented. Outreach account verification currently marks Outlook verified without testing inbound capability. Neither reply nor bounce processor includes Outlook accounts unless IMAP credentials happen to exist. A Graph delta poller can page a bounded number of inbox changes and retain `@odata.deltaLink` per account.

## Reply/bounce race and scan bounds

- Native reply processing scans unread mail first and does not test DSN classification. It can mark a DSN read, after which the native bounce processor (also unread-only) never sees it.
- IMAP replies are limited to unseen messages from seven days and 500 UIDs. IMAP bounce search does not have equivalent date/unseen/cursor bounds and repeatedly scans matching DSNs.
- External reply processing fetches only selected headers, so `campaign_leads.last_reply_text` remains null even when agentic follow-up is scheduled.
- User-visible read state is an unsafe ingestion cursor. Provider IDs/cursors plus a durable unique event are required for idempotent side effects.

## Provider event staging contract

Migration 039 should add:

- `outreach_provider_cursors`: organization/account/provider, opaque cursor, uid validity/high-water metadata, last success/error and retry timestamp; unique account/provider.
- `outreach_provider_events`: organization/account/provider/provider_message_id, internet Message-ID/In-Reply-To/References, classification, sender/recipients, subject, text/html body, selected headers, attachment metadata, received timestamp, processed timestamp/error; unique `(organization_id, email_account_id, provider, provider_message_id)`.

Phase 19 uses these rows for reply/bounce side effects. Phase 21 treats them as the idempotent ingestion source for conversation messages rather than re-polling providers.

## Verification approach

- Unit tests for SMTP option resolution and classification.
- Mocked Nodemailer/Graph fetch tests for MIME/header preservation and delta paging.
- Repository fixtures for event dedupe and exactly-once side effects.
- Integration smoke against a test Outlook tenant is an explicit manual gate before marking Graph parity production-ready.

The production migration apply command remains manual:

```powershell
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/migrations/039_outreach_provider_events.sql
```
