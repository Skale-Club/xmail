# Owned mailbox and unified-inbox streams (prepared, not activated)

Only `GET /api/mail/mailboxes/:uuid/events` and
`GET /api/outreach/unified-inbox/events?organizationId=:uuid` are admitted to
owned SSE. Other SSE endpoints retain their explicit denial. A server-admitted
owned principal selects this path regardless of the caller's Accept header;
machine/legacy handlers keep their existing authentication and tenant contracts.

Each opening, delivery batch and heartbeat requires a fresh owned session/provider
check. After that provider request finishes, a single SQL snapshot joins the same
session hash/user/authentication time/project, active binding, reviewed active
control, revocation cutoff, lifetime and current target permission. Mailbox access
keeps the existing owner-or-local-platform-admin rule and native-email sanity
check. Organization access keeps the existing current membership-or-local-admin
read rule, including viewer reads. No provider claim/contact grants access.
SQL is not reserved during provider calls. A canceled final snapshot is canceled
at the driver too; a late result cannot deliver a frame.

The stream has a hard timer at its first observed session expiry and never
extends that expiry. Each stream is also bounded to 30 minutes by default (the
existing mailbox lifetime override is retained). Idle admission is checked every
five seconds, with an eight-second absolute validation deadline. Thus idle
revocation/outage detection can take up to roughly thirteen seconds; detection
closes the stream immediately, and every data batch independently rechecks before
delivery. There is no claim of instantaneous remote-provider revocation detection.
There is no bearer resolution or legacy fallback on any owned failure.

Only the existing redacted signals are serialized: mailbox/folder/conversation
IDs, kind, counts, flags and timestamps. Subject/sender/address/body data stays out
of fanout. Validation is single-flight per stream, queued signals are bounded to
32, and frames over 4 KiB, queue overflow or socket backpressure end the stream.
Existing browser polling/reconnect remains the recovery path; no unbounded frame
buffer is kept behind a slow reader.

The existing bus capacities remain. Owned streams additionally share a process
registry bounded to six pending/open connections per exact user UUID and 2,000
total, plus at most eight simultaneous admission operations. An operation that
ignores cancellation keeps its admission slot until it actually finishes, so
reconnects cannot accumulate unlimited abandoned provider/SQL operations. Close,
error, abort, expiry and capacity failure release subscribers/timers exactly once.

Mocked socket tests exercise lifecycle, metadata redaction, expiry, revocation,
outage, queue/backpressure and reconnect capacity using the real in-process bus.
Provider/SQL seam tests verify fixed principals, no final SQL during provider wait,
kill-switch rereads and driver cancellation. Two disposable-CI PostgreSQL cases
extend the existing administration fixture to verify actual mailbox/org/session
authorization predicates; local skip is not SQL acceptance evidence.
An additional real loopback Express/HTTP test uses fake authorization and the real
bus: the completed GET remains open through delayed authorization and a signal
published after 100 ms, then revocation ends the response and leaves both
subscriber registries empty. No SMTP/IMAP sockets or provider/database are used.

These limits are static safeguards, not production load/capacity proof. The
candidate is still NOLOGIN and flags remain off. Storage migration, onboarding,
reviewed recovery, self-service native credential management, deletion and actual
runtime activation remain separate work.
