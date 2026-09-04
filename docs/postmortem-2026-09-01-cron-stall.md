# Postmortem: 30-hour cron stall, 2026-09-01/02

**Window:** 2026-09-01 00:08 UTC → 2026-09-02 06:35 UTC (~30 hours).
**Severity:** every scheduled background job — sends, replies, bounces, warm-up, approvals,
reconciliation — was effectively down for the entire window. Nothing paged anyone. It ended
because the Docker daemon happened to restart, not because anything detected or fixed it.

This is the highest-value incident to understand in this codebase right now: not because the
underlying bug was exotic, but because every layer of observability that existed at the time
looked at it and reported "normal."

## Timeline

| When (UTC) | What |
| --- | --- |
| 2026-09-01 00:08 | First job timeout of the incident. |
| 2026-09-01 (all day) | 317 job timeouts, including jobs that normally complete in milliseconds. |
| 2026-09-02 (until 06:35) | 307 more job timeouts. |
| 2026-09-02 06:35 | Docker daemon restarts (`journald`: `docker0: Link UP`, a broken pipe on the
  Docker socket). Container comes back up. Every orphaned job body, every exhausted pool
  connection, is gone with it. Incident ends. |
| 2026-09-02 (post-restart burst) | 838 `Invalid greeting … 421 4.7.0 Too many connections from
  your IP` errors as the drained warm-up backlog reconnects into the MX's own connect-rate
  limiter. All recovered by the sender's 4xx retry; nothing lost. |

Not an OOM kill (`OOMKilled=false`) and not a deploy — no `main` push, no container replacement,
sits between two unrelated commits in `git log`.

## Symptom

317 timeouts on 09-01, 307 on 09-02, against a healthy baseline of 7-8 per day. The timed-out
jobs included ones with no plausible reason to be slow: `expireOutreachApprovals` (46 times) and
`reconcileOutreachEvents` (50 times) are DB-only jobs that normally finish in milliseconds. A job
that is pure SQL taking minutes to time out is a strong signal that the problem is not the job's
own logic — it is something external to every job, shared by all of them.

The only visible log line, for the entire 30 hours, was:

```
[cron-lock] <job> already running on another process/tick, skipping
```

That line is emitted by `runWithLock` (`src/server/lib/cron-lock.ts`) on ordinary lock
contention — two ticks overlapping by a second is expected and happens roughly 1000 times per 72
hours in normal operation. There was nothing about its shape, wording, or frequency that
distinguished routine contention from "this job has been dead for a day."

## Why nothing alerted

Three independent reasons, each on its own would have been enough:

1. **The timeout was reported through `console.error`, not the structured pino logger.**
   Error-spike alerting (`ERROR_SPIKE_THRESHOLD`, see `docs/TELEGRAM-ALERTS.md`) only observes
   structured log lines. A raw `console.error` is invisible to it by construction.
2. **`stale_advisory_lock` existed and could not fire.** That detector watches for a Postgres
   advisory lock held by a session sitting `idle in transaction` past a threshold — the exact
   shape of an earlier, different 2026-08 incident. But `runWithLock`'s timeout releases the lock
   via `COMMIT` before the job body has actually settled (see Mechanism below). From the
   detector's point of view, nothing was held. The lock was clean; only the orphaned job body
   behind it wasn't.
3. **The error-rate design itself is per-rate, not per-error.** The three-layer alerting
   strategy (external probe, internal detectors, aggregated error-spike) is deliberately built
   to catch a *rate* of errors, never a single error — and every layer's blind spot in this
   incident was a different instance of the same root cause: a signal that reads as normal
   operation because nothing measured the one thing that mattered, which body was still running.

## Mechanism

**Epistemic status: a strongly-supported inference, not a proven fact.** No instrumentation
existed at the time of the incident to directly observe an orphaned job body; the description
below is the leading hypothesis, later corroborated (not conclusively proven) by the
instrumentation added in the recovery itself, and further sharpened by the socket-timeout
measurement that followed it. Treat it as the best available explanation, not a settled trace.

`runWithLock` reserves one pooled connection, runs `BEGIN`, takes a Postgres advisory lock via
`pg_try_advisory_xact_lock`, and then races the job body (`fn()`) against a timeout. The
`finally` block always issues `COMMIT` on that reserved connection when the race settles — including
when the *timeout* wins the race. That `COMMIT` releases the advisory lock immediately. It does
**not** cancel `fn()`. Postgres has no cooperative cancellation mechanism reachable from a
`Promise.race` in Node; the orphaned promise (and whatever pooled connection *its own* queries
are holding, separate from the reserved lock connection) simply keeps running in the background,
unobserved, until it settles on its own — which in this incident's 30-hour window, for many
bodies, was never.

The suspected trigger: the week's logs show 61 `CONNECTION_DESTROYED`/`ECONNRESET`-family pooler
errors, clustered on the incident days — consistent with a Supavisor transaction-pooler hiccup.
A query hanging mid-flight on a hiccupping connection leaves that job's body with no way to
finish and no way to be cancelled. Each orphaned body holds a pooled connection open
indefinitely. The pool (`max: 20`, shared at the time between the HTTP request path and every
background job) drains connection by connection as more bodies orphan. Once the pool is
exhausted, every new query — including the next tick's `BEGIN`/lock/`COMMIT` on a *different*
job — queues waiting for a connection, eventually hits its own timeout, and produces its own
orphaned body. This is self-reinforcing: each timeout that occurs while the pool is starved
produces another orphan rather than resolving one. Only a process restart, which unconditionally
drops every open connection, breaks the loop — which is exactly what the accidental Docker
daemon restart did at 06:35.

## What later measurement showed (and how it corrected the fix)

The instrumentation landed in the first remediation commit measured real job latency in
production. `outreach-replies-processor` — one of only two jobs that talk to a raw socket with
no timeout of its own — completes in 55-61 seconds under normal conditions. It was budgeted at
600 seconds. A tenfold gap between observed-normal and configured-timeout is not "sometimes
slow," it is the signature of a hung socket that occasionally never resolves at all.

Tracing that down: `createImapInboundSource` (`src/server/lib/outreach-inbound-sources.ts`)
constructed its `ImapFlow` client with **no timeouts configured at all** — no
`connectionTimeout`, no `greetingTimeout`, no `socketTimeout`. Meanwhile `mail-sync.ts` and
`outbound-transport.ts`, in the same repository, have carried explicit timeouts on their own
`ImapFlow`/SMTP clients for a long time. The one inbound path that mattered for this incident was
also the one path in the codebase left unbounded.

This reframes the incident: the orphaned promise was the *symptom* — the mechanism by which one
hung socket turned into a pool-wide outage. The unbounded IMAP socket was the *disease*. Fixing
only the orphan bookkeeping (detecting/blocking pile-up) without bounding the socket would have
left the underlying hang free to recur indefinitely, just with better visibility into it.

## Remediation

Three commits, applied in sequence, each acting only on what the previous one's measurement
actually showed rather than on the original guess:

- **`d5ba3e9`** — *feat(observability): make job stalls and a stalled funnel visible.*
  Instrumentation only, deliberately shipped before any behavioral fix so the next change could
  be proven against real numbers instead of believed. Adds per-run latency/outcome logging to
  `runWithLock`, in-memory in-flight and confirmed-orphan body counts, and four new silence
  detections in `src/server/lib/outreach-silence.ts`: `orphaned_job_bodies` (critical — the check
  that would have caught this incident in its first hour instead of after 30), `job_timeout_rate`
  (critical — the sibling gap `stale_advisory_lock` cannot see, since the timeout already
  released the lock), `funnel_stalled` (warning), and `unpriced_cost` (warning).
- **`fec30b8`** — *fix(inbound,cron): bound the IMAP socket and stop stacking orphaned runs.*
  Adds `connectionTimeout`/`greetingTimeout`/`socketTimeout` plus a whole-fetch deadline to
  `createImapInboundSource`'s `ImapFlow` client, names the account and phase in the resulting
  error, and closes the client on every path (including a failed connect, which previously
  skipped the `finally` and leaked the socket outright). Adds a per-job orphan guard to
  `runWithLock`: a job whose previous body is a *confirmed* orphan is refused a new run (its own
  distinct outcome, `skipped_orphan_running`, never confused with routine contention) — scoped
  per job name, since different jobs overlapping is normal and measured at up to 10 concurrent
  bodies. Job timeout budgets move from one guessed global default to `JOB_TIMEOUT_BUDGETS_MS`,
  each one derived from measured normal latency via `max(30s floor, 5 × observed latency)` —
  `outreach-replies-processor` moves from a 600s guess to a measured 305s (5 × 61s).
- **`e8fa1f8`** — *fix(mx,db,costs): stop self-limiting, isolate the job pool, price native
  inboxes.* Exempts the platform's own host (loopback, the Docker bridge range, and `MAIL_HOST`'s
  resolved IP) from the MX's own per-IP connect-rate limiter, fixing the 838-error post-restart
  burst described above. Gives background jobs their own connection pool
  (`jobQueryClient`, preferring `DIRECT_URL` over the transaction-pooled `DATABASE_URL`, sized at
  12 against the request path's 20) so a job pile-up can no longer starve the HTTP API, and vice
  versa. Also seeds migration `063_seed_native_inbox_rate.sql`, pricing `provider = 'native'`
  mailboxes at an explicit zero rather than leaving them `rate_missing` — unrelated to the stall
  mechanically, but landed in the same recovery pass once the cost-visibility work it depended on
  was in place.

## Collateral damage

- The warm-up mesh — which depends on cron jobs to send at all — fell from 388 to 158
  messages/day for the duration of the stall.
- The 838 `Invalid greeting … 421 4.7.0 Too many connections from your IP` errors on 09-02 were
  the platform's own MX rate-limiting its own drained backlog reconnecting after the restart, not
  an external actor and not a second unrelated bug. Every one of them was recovered by the
  sender's standard 4xx retry; none were permanently lost. This is fixed separately (the
  self-exemption in `e8fa1f8`), and is included here because the two are easy to conflate as one
  larger incident when they are in fact cause-then-symptom-of-recovery.

## Deliberately not done: cooperative cancellation

`fec30b8`'s commit message states this explicitly: cooperative cancellation of the job body via
`AbortSignal` was considered and deliberately **not** built. The reasoning: if bounding the IMAP
socket removes the hang, cooperative cancellation would be defending against an event that no
longer occurs — speculative complexity with no incident behind it. This is pending measurement,
not settled. What would justify building it: a `job_timeout_rate` or `orphaned_job_bodies` alert
firing again — post-`fec30b8` — for a job whose socket is already bounded, which would mean an
unbounded-I/O hang was not the only way to produce an orphan, and that cancellation (not just a
tighter timeout somewhere else) is the actual missing piece.

## Lessons

These are stated as transferable rules for anyone touching cron jobs, connection pools, or
alerting in this codebase — not as a recap of the incident above.

1. **Zero is a valid value, so absence disguises itself as normal operation.** This is the
   founding principle of `src/server/lib/outreach-silence.ts`, and this incident is its purest
   example yet: the only symptom visible for 30 hours was a log line — `already running on
   another process/tick, skipping` — that is *indistinguishable in shape* from healthy
   contention. A system that measures "did an error happen" will never catch "did the thing that
   was supposed to happen just... not."
2. **A lock release is not evidence that the work behind it finished.** Any pattern of
   acquire-lock → do work → release-on-timeout has this hole by construction, unless the timeout
   also cancels the work. Watch the lock's *lifecycle claim* ("this job is not running") against
   its *actual claim* ("this job's body has settled") — they silently diverge exactly when a
   timeout fires.
3. **A tenfold gap between a component's configured budget and its measured normal behavior is
   itself a finding**, independent of whether anything is currently on fire. `600s` budgeted
   against `55-61s` observed was not a conservative safety margin; it was ten minutes of unnoticed
   hang tolerated on every affected tick.
4. **An unbounded socket anywhere in a codebase that bounds every sibling socket is not an
   oversight to shrug at — it is the one path guaranteed to be exercised eventually.**
   `mail-sync.ts` and `outbound-transport.ts` had carried IMAP/SMTP timeouts for a long time;
   `createImapInboundSource` was the one left without them, and it was the one that hung.
5. **console.error and the structured logger are not interchangeable, even when they both "log
   the error."** Alerting that only observes one of them has a blind spot shaped exactly like
   whatever code still calls the other one.
6. **Fix what the measurement shows, not what the first hypothesis guessed** — even when the
   guess turns out to be part of the answer. The orphan-tracking instrumentation (`d5ba3e9`) was
   shipped *before* the socket-timeout fix specifically so the second commit could act on
   `outreach-replies-processor`'s real 55-61s latency instead of a plausible-sounding story about
   pool exhaustion in the abstract.
