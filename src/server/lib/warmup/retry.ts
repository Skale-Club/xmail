/**
 * Warm-up send-failure classification and retry backoff — pure functions, no I/O.
 *
 * Background (2026-08-17 incident): the mesh sends between our own inboxes, and it all routes to
 * our own MX (mx-guard.ts's `shouldGreylist`), which greylists new sender/recipient pairs with a
 * 451 asking the sender to retry in 5 minutes. `processWarmup.ts` used to set `status: 'failed'`
 * on ANY provider rejection, so the greylist hold — designed to resolve itself on the very next
 * retry — instead discarded the message outright. This module is the piece that tells the caller
 * whether a given failure deserves another attempt.
 *
 * Where the SMTP status actually comes from: `sendComposedOutreachMessage` (outreach-provider.ts)
 * funnels every thrown error through `normalizeProviderFailure` (outreach-dispatch.ts), which
 * reads `err.responseCode`/`err.code`/`err.statusCode` off the *original* error object and
 * returns a `ProviderFailure` with a `classification` of `'transient' | 'terminal' | 'ambiguous'`.
 * That works well for the relay path and for most Outlook/SMTP errors — but the warm-up mesh
 * currently runs in DIRECT-delivery mode (no SMTP_HOST relay configured), and
 * `outbound-transport.ts`'s `sendOutbound` wraps a per-MX-host failure into a *new* `Error(...)`
 * template string once every MX host for a domain has been tried:
 *
 *   `direct delivery to ${domain} failed on all ${n} MX host(s) (${hosts}): ${lastError.message}`
 *
 * That wrapping is exactly what produced the string in the 2026-08-17 incident. A `new Error(...)`
 * has no `.responseCode` — the numeric field is not carried across the wrap — so by the time it
 * reaches `normalizeProviderFailure` there is nothing structured left to read, and it falls
 * through to `classification: 'ambiguous'`, `code: 'provider_outcome_unknown'`. The SMTP reply
 * code is still in there, just as free text, nested two levels deep (our wrapper's message
 * contains smtp-connection's message, which contains the server's literal reply line). So
 * `classifySendFailure` below prefers the structured `classification` when one is available, and
 * only falls back to scanning the message text for an RFC 5321 reply code when it isn't.
 */

export const MAX_WARMUP_SEND_ATTEMPTS = 5

/**
 * Floor of the backoff, in ms. Set to exactly the greylist hold (mx-guard.ts's
 * `GREY_HOLD_MINUTES`) so a greylisted pair clears on its very first retry rather than waiting
 * longer than necessary.
 */
const RETRY_BASE_MS = 5 * 60 * 1000

export interface SendFailureClassification {
    /** true = give up now (a 5xx or an unrecoverable structured failure). */
    terminal: boolean
    /** The SMTP/HTTP status code if one could be determined, structured or scavenged from text. */
    code: number | null
}

interface FailureLike {
    classification?: unknown
    message?: unknown
    code?: unknown
}

function asFailureLike(err: unknown): FailureLike {
    if (typeof err === 'object' && err !== null) return err as FailureLike
    return {}
}

function messageOf(err: unknown, record: FailureLike): string {
    if (typeof record.message === 'string') return record.message
    if (err instanceof Error) return err.message
    return String(err ?? 'unknown error')
}

/**
 * First RFC 5321-shaped SMTP reply code (4xx or 5xx) found anywhere in `message`. Deliberately
 * defensive, not a structured parse: the string this runs against is free-form and can be
 * multiply-wrapped (see module docblock), so the code is not guaranteed to be at the start. Only
 * 4xx/5xx are matched — a 2xx/3xx embedded in surrounding text (a port number, a host, ...) is
 * not an SMTP reply code we care about classifying.
 */
function extractSmtpCode(message: string): number | null {
    const match = message.match(/\b([45]\d{2})\b/)
    return match ? Number(match[1]) : null
}

/**
 * Classifies a warm-up send failure. `err` is typically the `ProviderFailure` returned in
 * `result.failure` by `sendComposedOutreachMessage`, but anything with a `message` (or an
 * `Error`) works so this stays testable without constructing the full provider type.
 *
 * Rules, in order:
 *   - A structured `classification: 'terminal'` (e.g. a real 5xx, EAUTH, ...) is always terminal.
 *   - A structured `classification: 'transient'` (e.g. a real 4xx, a connection error) is always
 *     non-terminal.
 *   - Otherwise (`'ambiguous'`, or no structured classification at all): scan the message text for
 *     an SMTP reply code. 5xx found in text -> terminal. 4xx found in text -> non-terminal.
 *   - No code could be determined anywhere: non-terminal. Retry is the safe default for an
 *     unknown/unparseable failure — treating it as terminal risks silently discarding a message a
 *     correct MTA would have retried, and the attempt cap (MAX_WARMUP_SEND_ATTEMPTS) already
 *     bounds how much that costs if the failure turns out to be permanently stuck.
 */
export function classifySendFailure(err: unknown): SendFailureClassification {
    const record = asFailureLike(err)
    const message = messageOf(err, record)
    const classification = typeof record.classification === 'string' ? record.classification : undefined

    if (classification === 'terminal') return { terminal: true, code: extractSmtpCode(message) }
    if (classification === 'transient') return { terminal: false, code: extractSmtpCode(message) }

    const code = extractSmtpCode(message)
    if (code == null) return { terminal: false, code: null }
    return { terminal: code >= 500, code }
}

/**
 * Backoff before attempt number `attemptsSoFar + 1`. Doubles each attempt starting from the
 * greylist-hold floor, purely to spread out a genuinely flaky pair over the attempt budget rather
 * than hammering it every 5 minutes: 5m, 10m, 20m, 40m for attempts 1-4 (attempt 5 is the last —
 * see MAX_WARMUP_SEND_ATTEMPTS — and never needs a delay computed for a 6th).
 */
export function nextWarmupAttemptDelayMs(attemptsSoFar: number): number {
    const exponent = Math.max(0, attemptsSoFar - 1)
    return RETRY_BASE_MS * 2 ** exponent
}

export interface WarmupSendOutcomeInput {
    /** Whatever `sendComposedOutreachMessage` reported as `result.failure`. */
    failure: unknown
    /** `warmup_messages.attempts` BEFORE this attempt (0 for a message never tried before). */
    attemptsSoFar: number
    now: Date
}

export interface WarmupSendOutcome {
    status: 'pending' | 'failed'
    /** New value to persist to `warmup_messages.attempts`. */
    attempts: number
    /** New value to persist to `warmup_messages.next_attempt_at`; null when terminal. */
    nextAttemptAt: Date | null
    lastError: string
}

/**
 * Combines `classifySendFailure` with the attempt cap to decide what a failed warm-up send
 * attempt should write back to the row: keep retrying (`status: 'pending'`, with a scheduled
 * `nextAttemptAt`) or give up (`status: 'failed'`).
 *
 * A terminal classification always gives up immediately, regardless of how many attempts remain.
 * A non-terminal classification gives up once `attempts` would reach MAX_WARMUP_SEND_ATTEMPTS —
 * a persistent "temporary" failure is, past that point, not actually temporary.
 */
export function decideWarmupSendOutcome(input: WarmupSendOutcomeInput): WarmupSendOutcome {
    const { failure, attemptsSoFar, now } = input
    const attempts = attemptsSoFar + 1
    const message = messageOf(failure, asFailureLike(failure))
    const { terminal } = classifySendFailure(failure)

    if (terminal) {
        return { status: 'failed', attempts, nextAttemptAt: null, lastError: message }
    }
    if (attempts >= MAX_WARMUP_SEND_ATTEMPTS) {
        return {
            status: 'failed',
            attempts,
            nextAttemptAt: null,
            lastError: `${message} (gave up after ${attempts} attempts)`,
        }
    }
    return {
        status: 'pending',
        attempts,
        nextAttemptAt: new Date(now.getTime() + nextWarmupAttemptDelayMs(attempts)),
        lastError: message,
    }
}
