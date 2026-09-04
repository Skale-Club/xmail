import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { queryClient } from '../../db'
import { createLogger } from './logger'

// SEC-04 — cross-process / multi-tick cron mutual exclusion via Postgres advisory locks.
// See .planning/debug/system-wide-audit-2026-05-16.md H8 and
// .planning/phases/11-high-security/11-CONTEXT.md.
//
// IMPORTANT: The advisory-lock key is derived from the job NAME string.
// Renaming a job (e.g. `processQueue` → `processQueueV2`) would compute a
// different key, allowing old-name and new-name instances to overlap during
// rolling deploys. Keep names stable.

const log = createLogger('cron-lock')

/**
 * Maps an arbitrary job name to a stable signed BIGINT (Postgres bigint range)
 * via SHA-256 → first 8 bytes → BigInt → masked to positive signed 63-bit range.
 *
 * Deterministic across processes: the same name always yields the same key.
 */
export function computeLockKey(name: string): bigint {
    const hash = createHash('sha256').update(name).digest()
    let key = 0n
    for (let i = 0; i < 8; i++) {
        key = (key << 8n) | BigInt(hash[i])
    }
    // Mask to positive 63-bit range so it fits in Postgres signed bigint.
    const SIGNED_MAX = (1n << 63n) - 1n
    return key & SIGNED_MAX
}

/**
 * Every job name ever passed to `runWithLock`. `computeLockKey` is one-way (SHA-256), so a raw
 * numeric key read back out of `pg_locks` cannot be turned into a job name without this list —
 * outreach-silence-query.ts uses it to name which job a stuck lock belongs to instead of just
 * reporting an opaque bigint. Keep in sync: add the literal string here whenever a new call site
 * passes a new `jobName` to `runWithLock`. An entry that falls out of sync only degrades a stale
 * lock's alert message to an unresolved key — it does not stop the alert from firing.
 */
export const KNOWN_LOCK_NAMES: readonly string[] = [
    'amortizeSubscriptionCosts',
    'outreach-unified-inbox-materializer', // also covers backfillUnifiedInbox.ts (shares the name)
    'deliverOutreachEventsToXphere',
    'enforceDeliverabilityGuardrails',
    'expireOutreachApprovals',
    'measureProspectingOutcomes',
    'outreach-bounces-processor',
    'outreach-followups-processor',
    'outreach-inbox-commands',
    'outreach-sequences-processor',
    'outreach-replies-processor',
    'warmup-mesh-processor',
    'reconcileOutreachEvents',
]

/**
 * Default budget for the job body — see the "budget" section below. 10 minutes covers every
 * 5/15/30-minute-cadence cron job (jobs/index.ts) with room to spare, and matches the warmup
 * mesh's own 10-minute cadence (that job gets an explicit shorter override — see processWarmup.ts
 * — so its lock still clears with margin before its own next tick).
 */
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000

// -----------------------------------------------------------------------------------------------
// Fase 1 TASK 2 (2026-09-04) — budgets sized to measured production latency, kept in one place.
//
// The instrumentation landed in d5ba3e9 measured every job's normal latency in production over a
// 35-minute / 130-run window (see the incident/task doc for the raw numbers). Every budget below
// that has real measurement behind it is retuned from that data using ONE rule, applied uniformly:
//
//   timeoutMs = max(FLOOR_MS, 5 * observedNormalLatencyMs), rounded to a clean number.
//
// Why 5x: comfortably above every observed run (including the slow end of a measured range) so a
// healthy tick is never killed by ordinary jitter, while still being a small enough multiple of
// reality that a genuine hang is caught in a few minutes, not ten. Why a 30s floor: several of
// these jobs normally finish in 1-2 seconds, and 5x that is only single-digit seconds — too tight
// a budget would make the timeout trigger on ordinary noise (a slow query, a GC pause) rather than
// an actual hang. 30s gives those jobs 15-75x their normal latency in headroom, which is still a
// small fraction of their own cadence (see the ratio column below).
//
// Every value here also lands under the job's own cron cadence (jobs/index.ts) with margin, so a
// hang is caught within roughly one cadence tick rather than silently spanning several:
//
//   job                          | normal latency | cadence | rule result | ratio to cadence
//   warmup-mesh-processor        | 75s            | 600s    | 375s (5x)   | 62.5%
//   outreach-replies-processor   | 55-61s         | 900s    | 305s (5x61) | 33.9%
//   outreach-bounces-processor   | 1.6s           | 1800s   | 30s (floor) | 1.7%
//   outreach-inbox-commands      | 1.3-2s         | 60s     | 30s (floor) | 50%
//   deliverOutreachEventsToXphere| 0.4s           | 60s     | 30s (floor) | 50%
//
// `outreach-inbound-ingest` (src/server/lib/outreach-inbound-sources.ts, measured at ~55s normal /
// 600s current budget — same rule would give ~305s) is deliberately NOT retuned here: that file is
// owned by a parallel change, so it keeps its current default budget until that agent retunes it.
//
// Jobs with no measurement from this incident (amortizeSubscriptionCosts, expireOutreachApprovals,
// materializeUnifiedInbox/backfillUnifiedInbox, measureProspectingOutcomes, reconcileOutreachEvents,
// and processFollowUps/enforceDeliverabilityGuardrails, which already carry their own pre-existing
// explicit overrides) are deliberately left untouched — retuning without a measured normal latency
// would be a guess, not a fix, and is out of scope for this pass.
//
// Kept in one place (here) rather than as inline literals scattered across job files: every job
// file below imports its own key from this object instead of hardcoding `{ timeoutMs: N }`, so the
// next person retuning a budget has exactly one place to look and one place to change.
// -----------------------------------------------------------------------------------------------
export const JOB_TIMEOUT_BUDGETS_MS = {
    warmupMeshProcessor: 375_000, // 5 x 75s observed normal latency
    outreachRepliesProcessor: 305_000, // 5 x 61s (slow end of the observed 55-61s range)
    outreachBouncesProcessor: 30_000, // 30s floor (5 x 1.6s would be ~8s — too tight)
    outreachInboxCommands: 30_000, // 30s floor (5 x 1.3-2s would be single-digit seconds)
    deliverOutreachEventsToXphere: 30_000, // 30s floor (5 x 0.4s would be ~2s)
} as const

/** Distinguishes "the timer won the race" from any value `fn()` could legitimately resolve with. */
const JOB_TIMEOUT = Symbol('cron-lock-job-timeout')

// -----------------------------------------------------------------------------------------------
// TASK 2 — best-effort postgres-js pool snapshot.
// -----------------------------------------------------------------------------------------------

export interface PoolSnapshot {
    /** Configured pool ceiling (`DB_POOL_MAX`, default 20). Documented, stable, always present. */
    max: number
    /** Connections currently checked out via `.reserve()`-style bookkeeping, if observable. */
    reserved: number | null
    /** Connections currently idle/available, if observable. */
    idle: number | null
}

/**
 * Best-effort snapshot of the postgres-js connection pool's occupancy, logged alongside every
 * job's completion so the "orphaned runs slowly exhaust the pool" hypothesis (see the incident
 * doc below `runWithLock`) can be checked against real numbers instead of inferred after the
 * fact from a process restart clearing it.
 *
 * postgres-js (the `postgres` package, pinned to 3.4.8 as of writing) does NOT expose live
 * occupancy (reserved/idle/queued connection counts) anywhere on the object `postgres(...)`
 * returns — verified with `Object.getOwnPropertyNames(queryClient)`, which lists only
 * `types, typed, unsafe, notify, array, json, file, parameters, largeObject, subscribe, CLOSE,
 * END, PostgresError, options, reserve, listen, begin, close, end`. The library's live
 * connection queues (`open`, `reserved`, `busy`, `full`, `closed`, `connecting`, `ended` — see
 * postgres/src/index.js) exist only as variables closed over inside its internal `Postgres()`
 * factory and are never attached to the client object, so there is currently no supported *or*
 * unsupported way to read them from outside the library.
 *
 * The only thing that IS exposed, documented and stable is static configuration
 * (`queryClient.options.max`), which this always reports. `reserved`/`idle` are populated only
 * by a best-effort, defensively-typed probe for a `queues`-shaped field, in case a different
 * postgres-js version ever attaches one directly to the client (some pool libraries do, under
 * names like this). That probe is NOT documented API, is expected to keep finding nothing on the
 * pinned version (both fields will read `null`), and MUST be re-verified after any `postgres`
 * upgrade. Any shape that doesn't match — including the whole client being unrecognizable —
 * degrades to `null` rather than throwing: metric collection must never break a job.
 */
export function getPoolSnapshot(client: unknown = queryClient): PoolSnapshot | null {
    try {
        const candidate = client as {
            options?: { max?: unknown }
            queues?: { reserved?: { length?: unknown }, open?: { length?: unknown } }
        } | null | undefined

        const max = Number(candidate?.options?.max)
        if (!Number.isFinite(max)) return null

        const reservedLength = candidate?.queues?.reserved?.length
        const openLength = candidate?.queues?.open?.length
        return {
            max,
            reserved: typeof reservedLength === 'number' ? reservedLength : null,
            idle: typeof openLength === 'number' ? openLength : null,
        }
    } catch {
        return null
    }
}

// -----------------------------------------------------------------------------------------------
// TASK 4 — in-memory recent-timeout counter, consumed by the parallel silence-detector work.
// -----------------------------------------------------------------------------------------------

export interface JobTimeoutStats {
    windowMs: number
    total: number
    byJob: Record<string, number>
}

/** Default lookback window for `getRecentJobTimeouts`. */
const RECENT_TIMEOUT_WINDOW_MS = 60 * 60 * 1000

/**
 * Hard cap on the ring independent of time-based pruning — insurance against unbounded growth if
 * `getRecentJobTimeouts` (which prunes on read) simply never gets called for a long time while
 * timeouts keep happening. At one event per array slot this is a trivial amount of memory.
 */
const MAX_TIMEOUT_RING_SIZE = 1000

interface TimeoutEvent {
    jobName: string
    at: number
}

/**
 * In-memory only, by design — it resets on every process restart. That is acceptable, and even
 * informative: a restart is exactly the event that cleared the 2026-09-01/02 incident this file's
 * timeout budget exists to catch, so an empty counter right after a restart correctly reports
 * "the condition that caused the timeouts is gone," not a gap in the data.
 */
let recentTimeouts: TimeoutEvent[] = []

/** Records one timeout event. Called only from the JOB_TIMEOUT branch of `runWithLock`. */
function recordJobTimeout(jobName: string, at: number = Date.now()): void {
    recentTimeouts.push({ jobName, at })
    if (recentTimeouts.length > MAX_TIMEOUT_RING_SIZE) {
        recentTimeouts = recentTimeouts.slice(-MAX_TIMEOUT_RING_SIZE)
    }
}

/**
 * Recent job-timeout counts, for the silence detector's rate-based alert (a parallel change —
 * see outreach-silence.ts). Prunes events outside `windowMs` on every read.
 */
export function getRecentJobTimeouts(now: Date = new Date()): JobTimeoutStats {
    const cutoff = now.getTime() - RECENT_TIMEOUT_WINDOW_MS
    recentTimeouts = recentTimeouts.filter((event) => event.at >= cutoff)

    const byJob: Record<string, number> = {}
    for (const event of recentTimeouts) {
        byJob[event.jobName] = (byJob[event.jobName] ?? 0) + 1
    }
    return { windowMs: RECENT_TIMEOUT_WINDOW_MS, total: recentTimeouts.length, byJob }
}

// -----------------------------------------------------------------------------------------------
// Fase 1 TASK 1 (2026-09-04) — in-flight / orphan job-body tracking.
//
// getPoolSnapshot above always reads {max: 20, reserved: null, idle: null} on the pinned
// postgres-js 3.4.8 — the library exposes no live occupancy, so it cannot prove or disprove the
// leading hypothesis for the 2026-09-01/02 incident (~30h, 317+307 job timeouts, cured only by a
// Docker restart): that the timeout releases the advisory lock but does NOT cancel the job body
// (see the BUDGET doc on runWithLock below), and the orphaned promise keeps running, keeps
// holding a pooled connection, and slowly exhausts the pool.
//
// Orphans are directly observable without touching the database or postgres-js internals at
// all: a job body that started and never settled is visible right here, in the same process
// that started it. That is a far better instrument than pool occupancy, and it costs nothing.
// -----------------------------------------------------------------------------------------------

export interface InFlightJobStats {
    /** Bodies started and not yet settled. */
    inFlight: number
    /** Of those, ones whose run already reported a timeout — confirmed orphans. */
    orphaned: number
    /** Age of the oldest unsettled body, ms. null when nothing is in flight. */
    oldestAgeMs: number | null
    /** Orphan count per job name. Only jobs with at least one orphan appear. */
    orphansByJob: Record<string, number>
}

interface InFlightEntry {
    jobName: string
    /** Wall-clock start time (`Date.now()`), not `performance.now()` — ages are reported against
     * an arbitrary caller-supplied `now: Date` in `getInFlightJobs`, so both sides must agree on
     * the same clock. */
    startedAt: number
    /** Flipped to true the moment the timeout branch of `runWithLock` fires while this body is
     * still unsettled — from that instant on this entry is a confirmed orphan, not just a slow
     * run. */
    timedOut: boolean
}

/**
 * Hard cap on the in-flight list independent of settle-based removal — insurance against
 * unbounded growth if entries somehow stopped being removed (a bug in the removal path itself,
 * or a truly pathological number of simultaneous hangs). Mirrors `MAX_TIMEOUT_RING_SIZE` above:
 * oldest-eviction on overflow, same trivial per-slot memory cost. In the steady state this never
 * matters — entries are removed as soon as their body settles, and 17 registered jobs will never
 * come close to filling 1000 concurrent slots even during an incident.
 */
const MAX_IN_FLIGHT_ENTRIES = 1000

/**
 * In-memory only, by design — same rationale as `recentTimeouts` above: it resets on every
 * process restart, and a restart is exactly the event that cleared the 2026-09-01/02 incident,
 * so an empty list right after a restart correctly reports "nothing orphaned right now."
 */
let inFlightEntries: InFlightEntry[] = []

/** Registers a body as started. Returns the entry so the caller can flip `timedOut` and later
 * remove it on settle — see the two call sites inside `runWithLock`. */
function trackInFlightStart(jobName: string, startedAt: number = Date.now()): InFlightEntry {
    const entry: InFlightEntry = { jobName, startedAt, timedOut: false }
    inFlightEntries.push(entry)
    if (inFlightEntries.length > MAX_IN_FLIGHT_ENTRIES) {
        inFlightEntries = inFlightEntries.slice(-MAX_IN_FLIGHT_ENTRIES)
    }
    return entry
}

/** Removes one entry by identity once its body settles — resolved, rejected, or (for an orphan)
 * settling long after its run already reported `timeout`. Safe to call on an entry that was
 * already evicted by the hard cap above: filtering for an absent reference is a no-op. */
function untrackInFlight(entry: InFlightEntry): void {
    inFlightEntries = inFlightEntries.filter((e) => e !== entry)
}

/**
 * In-flight and orphan job-body stats, for the silence detector's orphan-accumulation alert (a
 * parallel change — see outreach-silence.ts). Nothing here touches the database; it only reads
 * this process's own bookkeeping.
 */
export function getInFlightJobs(now: Date = new Date()): InFlightJobStats {
    const nowMs = now.getTime()
    let oldestAgeMs: number | null = null
    let orphaned = 0
    const orphansByJob: Record<string, number> = {}

    for (const entry of inFlightEntries) {
        const age = nowMs - entry.startedAt
        if (oldestAgeMs === null || age > oldestAgeMs) oldestAgeMs = age
        if (entry.timedOut) {
            orphaned += 1
            orphansByJob[entry.jobName] = (orphansByJob[entry.jobName] ?? 0) + 1
        }
    }

    return { inFlight: inFlightEntries.length, orphaned, oldestAgeMs, orphansByJob }
}

// -----------------------------------------------------------------------------------------------
// TASK 1 / TASK 3 — one structured completion line per run, and structured (not console) errors.
// -----------------------------------------------------------------------------------------------

type JobOutcome =
    | 'completed'
    | 'timeout'
    | 'skipped_contention'
    | 'skipped_orphan_running'
    | 'lock_failed'
    | 'error'

/** Safe, serializable shape for an unknown thrown value. */
function errorInfo(err: unknown): { message: string, stack?: string } {
    const asError = err instanceof Error ? err : new Error(String(err))
    return { message: asError.message, stack: asError.stack }
}

/**
 * Emits the one structured line every `runWithLock` run produces, regardless of how it ended.
 * `outcome` is the axis analysis pivots on; job name and latency are always present so a single
 * `jq` query can answer "how long did every tick of every job take, and how did it end" across
 * all 17 jobs without touching their individual bodies.
 *
 * `skipped_contention` deliberately skips the pool probe: it is by far the highest-volume
 * outcome (~1000/72h of routine tick overlap — see cron-lock.test.ts and outreach-silence.ts),
 * and a pool snapshot adds no diagnostic value to "this tick did not run, another one holds the
 * lock." Every other outcome includes it — `getPoolSnapshot` is a synchronous, in-process,
 * never-throwing read, so the extra field costs nothing worth economizing.
 *
 * `skipped_orphan_running` (Fase 1 TASK 1) is a DIFFERENT, much rarer and more serious condition
 * than `skipped_contention` and must never be folded into it: contention means the DB advisory
 * lock is still held by an in-budget run; this outcome means the previous run of this exact job
 * already blew its timeout budget (the lock was released) and its body is STILL executing,
 * orphaned, in the background. Logged at `warn` (not `info`, unlike contention) precisely so it
 * does not get lost in the routine-overlap noise — this is the guard that stops a second
 * concurrent body of the same job from starting while the first is still running unbounded.
 *
 * Never throws: a failure to log a run's outcome must never surface as that run's failure.
 */
function logRun(jobName: string, outcome: JobOutcome, startedAt: number, extra?: Record<string, unknown>): void {
    try {
        const latencyMs = Math.round(performance.now() - startedAt)
        // Always included, unlike `pool` below: this is a synchronous read of an in-process
        // array, not a DB round-trip, so there is no cost to economize even on the
        // highest-volume `skipped_contention` outcome — and this is the exact time series
        // (inFlight/orphaned per tick) that would show orphans accumulating during an incident.
        const inFlightStats = getInFlightJobs()
        const payload: Record<string, unknown> = {
            action: 'cron.lock.run',
            jobName,
            latencyMs,
            outcome,
            inFlight: inFlightStats.inFlight,
            orphaned: inFlightStats.orphaned,
            ...extra,
        }
        if (outcome !== 'skipped_contention') {
            payload.pool = getPoolSnapshot()
        }

        if (outcome === 'timeout') {
            // Keep the literal string "cron.lock.job_timeout" in the MESSAGE (not just the
            // `action` field below) — greps for this exact string predate structured logging
            // and must keep matching. This is also what makes the previously-silent failure mode
            // visible to the project's error-spike alerting, which only observes the pino stream.
            log.error(
                { ...payload, action: 'cron.lock.job_timeout' },
                `cron.lock.job_timeout: ${jobName} exceeded its ${extra?.timeoutMs ?? '?'}ms budget — `
                    + 'releasing the advisory lock now via COMMIT. The job body is NOT cancelled: it '
                    + 'keeps running orphaned, detached from this transaction, and its eventual result '
                    + 'is discarded. This is an abnormal stall, not normal tick overlap.',
            )
        } else if (outcome === 'lock_failed' || outcome === 'error') {
            log.error(payload, `[cron-lock] ${jobName} run ended with outcome=${outcome}`)
        } else if (outcome === 'skipped_contention') {
            // `info`, not `console`: routine tick overlap (~14/hour) is cheap for a JSON logger,
            // and folding it into the same structured stream as every other outcome is what lets
            // one `jq` query (or getRecentJobTimeouts' sibling rate view) see "contended vs
            // completed vs timed out" as one consistent shape, instead of splitting the single
            // highest-volume outcome into unstructured console lines nothing else can query.
            log.info(payload, `[cron-lock] ${jobName} already running on another process/tick, skipping`)
        } else if (outcome === 'skipped_orphan_running') {
            // `warn`, deliberately louder than `skipped_contention`'s `info` — this is the smoking
            // gun for a job whose body is running past its own timeout budget, not routine overlap.
            log.warn(
                payload,
                `[cron-lock] ${jobName} skipped: a previous run's body is still executing `
                    + `${extra?.runningForMs ?? '?'}ms after it started (it already exceeded its own `
                    + 'timeout budget and the advisory lock was released, but the orphaned body has not '
                    + 'settled yet) — refusing to start a second concurrent body of the same job.',
            )
        } else {
            log.info(payload, `[cron-lock] ${jobName} completed`)
        }
    } catch {
        /* Metric/log collection must never break a job. */
    }
}

/**
 * Runs `fn` only if the named advisory lock can be acquired immediately.
 *
 * The lock is TRANSACTION-scoped (`pg_try_advisory_xact_lock` inside an explicit
 * `BEGIN … COMMIT` on one reserved connection), not session-scoped. That is
 * deliberate: production reaches Postgres through the Supabase pooler in
 * transaction mode (`:6543`), where every statement outside a transaction may
 * land on a DIFFERENT backend. With `pg_try_advisory_lock`/`pg_advisory_unlock`
 * that meant the lock was taken on backend A and the unlock ran on backend B —
 * A kept the lock forever, and from then on roughly every other tick of EVERY
 * job (whichever landed on a backend other than A) logged
 * "already running … skipping" while nothing was running. Inside an open
 * transaction the pooler pins the backend, so lock, body and release all see
 * the same session, and COMMIT (or the connection dying) always frees it.
 *
 * Behavior:
 *   - If the lock is already held by another tick/process, logs a skip
 *     message and returns without error.
 *   - If acquired, runs `fn` and commits (releasing the lock) in `finally`.
 *   - On `kill -9` / process crash, the connection dies and Postgres rolls the
 *     transaction back, releasing the lock — no orphan-lock risk.
 *   - Session-scoped holders (`pg_advisory_lock` on the same key) still contend
 *     with this lock: session and xact advisory locks share one lock space.
 *
 * Never throws on lock-acquisition or release failure — those are logged and
 * swallowed so a single cron tick failure does not crash the scheduler.
 * Errors thrown by `fn` itself propagate to the caller.
 *
 * BUDGET (why this exists): `fn()` used to run unbounded inside the transaction. If it never
 * settled — a hung IMAP/SMTP socket with no timeout of its own was the real 2026-08-19/20
 * incident — the `finally` that commits (and releases the lock) never ran either. The
 * transaction sat `idle in transaction` holding the advisory lock forever, and every later tick
 * logged the ordinary-looking "already running … skipping" — indistinguishable from healthy
 * contention. Three jobs died silently that way for 2-4 days before a human noticed.
 *
 * `fn()` is now raced against a per-call `timeoutMs` (default `DEFAULT_JOB_TIMEOUT_MS`, override
 * via the `options.timeoutMs` param on the specific job — cadences differ, so one global number
 * cannot be right for all of them). If the timer wins:
 *   - A single, loudly-distinct log line fires (`cron.lock.job_timeout` in the message, at pino
 *     `error` level — see `logRun` above) — this is NOT the routine "skipping" line; it means a
 *     job ACTUALLY overran, not that two ticks merely overlapped. Grep for `cron.lock.job_timeout`
 *     to find every occurrence.
 *   - The `finally` below still runs and COMMITs, so the transaction ends and the advisory lock
 *     is released on schedule regardless of what `fn()` is still doing. A job that overran must
 *     never keep the lock — that is the entire point of this change.
 *   - `runWithLock` does NOT throw for a timeout and returns normally, same as a successful run.
 *     Every caller in jobs/index.ts already does `.catch(err => log.error(...))` on the returned
 *     promise; making a timeout reject here would route it through that generic "<job> failed"
 *     log instead of (or on top of) the distinct line above, which is a worse signal, not a
 *     better one. The distinct log line above is the deliberate signal for this case.
 *   - The orphaned `fn()` promise is NOT cancelled — Postgres has no cooperative cancellation for
 *     an in-flight query from here, and Node has none for arbitrary async work. It keeps running
 *     in the background against a transaction that COMMITs (and a reserved connection that gets
 *     released back to the pool) out from under it; whatever it was doing when it finally settles
 *     is discarded — no result of a timed-out run is ever used. We attach a `.catch()` to it so a
 *     late rejection cannot surface as an unhandled promise rejection and crash the process; that
 *     is its only remaining purpose after a timeout.
 *
 * INSTRUMENTATION (2026-09-04, incident 2026-09-01/02): every completed run — including a
 * contended skip — now emits one structured `cron.lock.run` line via `logRun` above (job name,
 * `latencyMs`, `outcome`, best-effort pool snapshot). This proves or disproves the leading
 * hypothesis for that 30-hour incident (orphaned timed-out runs slowly exhausting the pool) with
 * real numbers instead of inference; see `getPoolSnapshot` and `getRecentJobTimeouts` above. This
 * change is instrumentation only — it does not touch the orphan-promise behavior documented above.
 *
 * Same date, second pass: `logRun` above now also carries `inFlight`/`orphaned` on every line,
 * from `trackInFlightStart`/`untrackInFlight` around `fn()` just below and `getInFlightJobs`
 * further above. Where the pool snapshot is structurally unable to show an orphan (postgres-js
 * exposes no live occupancy at all), an orphaned body is directly observable in this same
 * process — it is a body that started and has not settled, flagged the moment its own timeout
 * fires. This is the instrument that would have caught 2026-09-01/02 in its first hour: see
 * `ORPHANED_JOBS_THRESHOLD` in outreach-silence.ts.
 */
export async function runWithLock(
    jobName: string,
    fn: () => Promise<unknown>,
    options?: { timeoutMs?: number },
): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS
    const key = computeLockKey(jobName)
    const startedAt = performance.now()

    // Fase 1 TASK 1 (2026-09-04) — per-job overlap guard, checked BEFORE reserving a connection
    // or touching the DB lock at all. This is the fix for the actual 2026-09-01/02-shaped bug: once
    // a run's timeout fires, the `finally` below COMMITs and releases the advisory lock right away
    // (see the BUDGET doc), so a later tick of the SAME job would otherwise acquire that lock
    // cleanly and start a second concurrent body while the first orphaned one is still running —
    // e.g. two IMAP scans over the same 34 mailboxes at once. The DB lock alone cannot prevent
    // this: it only ever reflects the state of the (already-committed) transaction, not whether
    // the JS body it used to guard is still executing. `inFlightEntries` is the only place that
    // fact is visible, so the guard reads it here, per-job-name, before anything else happens.
    //
    // Scoped to CONFIRMED orphans (`timedOut === true`) only — never to every in-flight entry for
    // this job. A body that is merely still running within its own budget is already handled by
    // the ordinary `skipped_contention` path a few lines down (its transaction is still open, so
    // the advisory lock is still held); folding that case in here too would misreport routine tick
    // overlap as this rarer, more serious condition. Different job names never interfere with each
    // other — `inFlightEntries` is filtered by `jobName`, so e.g. warmup-mesh-processor and
    // outreach-replies-processor running at the same time (measured: up to 10 concurrent bodies)
    // is completely unaffected.
    const orphansOfThisJob = inFlightEntries.filter((e) => e.jobName === jobName && e.timedOut)
    if (orphansOfThisJob.length > 0) {
        // Report the OLDEST orphan's age — the longest-running one is the most useful number for
        // an on-call human staring at this log line.
        const oldestOrphan = orphansOfThisJob.reduce((oldest, e) => (e.startedAt < oldest.startedAt ? e : oldest))
        const runningForMs = Date.now() - oldestOrphan.startedAt
        logRun(jobName, 'skipped_orphan_running', startedAt, { runningForMs, orphanCount: orphansOfThisJob.length })
        return
    }

    // Reserve a single connection so BEGIN, the lock and COMMIT travel on the
    // same client connection (and therefore the same pooled backend).
    let reserved: Awaited<ReturnType<typeof queryClient.reserve>>
    try {
        reserved = await queryClient.reserve()
    } catch (reserveErr) {
        log.error(
            { action: 'cron.lock.reserve_failed', jobName, error: errorInfo(reserveErr) },
            `[cron-lock] ${jobName} failed to reserve connection`,
        )
        logRun(jobName, 'lock_failed', startedAt, { reason: 'reserve_failed' })
        return
    }

    // postgres-js tagged-template parameters don't accept bigint; pass as string
    // and cast in SQL. The deterministic key still maps 1:1 across processes.
    const keyParam = key.toString()

    try {
        let acquired = false
        let inTransaction = false
        try {
            await reserved`BEGIN`
            inTransaction = true
            const rows = await reserved`SELECT pg_try_advisory_xact_lock(${keyParam}::bigint) AS got`
            const first = rows[0] as { got?: boolean } | undefined
            acquired = Boolean(first?.got)
        } catch (lockErr) {
            log.error(
                { action: 'cron.lock.acquire_failed', jobName, error: errorInfo(lockErr) },
                `[cron-lock] ${jobName} failed to acquire lock`,
            )
            if (inTransaction) await endTransaction(jobName, reserved, 'ROLLBACK')
            logRun(jobName, 'lock_failed', startedAt, { reason: 'acquire_failed' })
            return
        }

        if (!acquired) {
            await endTransaction(jobName, reserved, 'ROLLBACK')
            logRun(jobName, 'skipped_contention', startedAt)
            return
        }

        let timer: ReturnType<typeof setTimeout> | undefined
        let outcome: JobOutcome = 'completed'
        let hasRejection = false
        let rejection: unknown
        try {
            const fnPromise = fn()

            // Fase 1 TASK 1: track this body from the moment it starts. Removed on settle
            // (resolve, reject, or — for an orphan — settling long after this run already
            // logged `timeout`) regardless of which path below runs; see `untrackInFlight`.
            const inFlightEntry = trackInFlightStart(jobName)
            fnPromise.then(() => untrackInFlight(inFlightEntry), () => untrackInFlight(inFlightEntry))

            const timeoutPromise = new Promise<typeof JOB_TIMEOUT>((resolve) => {
                timer = setTimeout(() => resolve(JOB_TIMEOUT), timeoutMs)
            })

            let raced: unknown
            try {
                raced = await Promise.race([fnPromise, timeoutPromise])
            } catch (fnErr) {
                hasRejection = true
                rejection = fnErr
                outcome = 'error'
            }

            if (!hasRejection && raced === JOB_TIMEOUT) {
                outcome = 'timeout'

                // The timeout won the race, so fnPromise has not settled yet: this entry is now
                // a confirmed orphan (getInFlightJobs' `orphaned` count) until it eventually
                // settles and the `.then` above removes it — which may be seconds, minutes, or
                // (2026-09-01/02) never within the incident's 30-hour window.
                inFlightEntry.timedOut = true

                // See the BUDGET doc above: never awaited, never cancelled — only guarded against
                // becoming an unhandled rejection once it finally settles.
                fnPromise.catch((orphanErr) => {
                    console.error(
                        `[cron-lock] ${jobName} orphaned job body rejected after cron.lock.job_timeout `
                            + '(result already discarded, lock already released):',
                        orphanErr,
                    )
                })
            }
        } finally {
            if (timer) clearTimeout(timer)
            // Ending the transaction is what releases the xact lock.
            await endTransaction(jobName, reserved, 'COMMIT')

            if (outcome === 'timeout') {
                recordJobTimeout(jobName)
                logRun(jobName, outcome, startedAt, { timeoutMs })
            } else if (outcome === 'error') {
                logRun(jobName, outcome, startedAt, { error: errorInfo(rejection) })
            } else {
                logRun(jobName, outcome, startedAt)
            }
        }

        if (hasRejection) throw rejection
    } finally {
        // Always return the reserved connection to the pool.
        try {
            reserved.release()
        } catch (releaseErr) {
            log.error(
                { action: 'cron.lock.release_failed', jobName, error: errorInfo(releaseErr) },
                `[cron-lock] ${jobName} connection release failed`,
            )
        }
    }
}

async function endTransaction(
    jobName: string,
    reserved: Awaited<ReturnType<typeof queryClient.reserve>>,
    verb: 'COMMIT' | 'ROLLBACK',
): Promise<void> {
    try {
        await reserved.unsafe(verb)
    } catch (endErr) {
        log.error(
            { action: 'cron.lock.end_transaction_failed', jobName, verb, error: errorInfo(endErr) },
            `[cron-lock] ${jobName} ${verb} failed`,
        )
    }
}
