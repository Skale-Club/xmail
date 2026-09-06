/**
 * Per-tick circuit breaker for outbound delivery. Pure; no I/O.
 *
 * Why (2026-09-02, 07:00 local): fifteen `[Send:Relay] FAILED via direct delivery` lines in one
 * five-minute window. When outbound port 25 (or DNS, or the network) is down from this host,
 * EVERY send in a tick fails the same way. Continuing through the batch has no upside — nothing
 * later in the list will succeed — and two real costs: each lead burns one of its `max_attempts`
 * on a failure that had nothing to do with it, and the alert channel gets one identical error
 * per lead instead of one summary.
 *
 * Only TRANSPORT failures trip the breaker: connection refused/timed out, DNS, socket errors —
 * the codes `normalizeProviderFailure` (outreach-dispatch.ts) assigns before any SMTP dialogue
 * happened. A 4xx/5xx reply is the recipient's verdict on that one message and says nothing
 * about the next; it never trips this. Any success resets the count, so a single flaky MX
 * between healthy sends stays a per-message retry.
 */

export const OUTBOUND_CIRCUIT_TRIP_AFTER = 3

/**
 * Failure codes that mean "we could not talk to the remote server at all". Lower-case, as
 * `normalizeProviderFailure` emits them; `connection_failed` is its fallback name for a
 * phase-sensitive connection error with no `code` of its own.
 */
const TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set([
    'edns',
    'econnection',
    'econnrefused',
    'ehostunreach',
    'enetunreach',
    'etimedout',
    'econnreset',
    'esocket',
    'connection_failed',
])

export function isTransportFailureCode(code: string | null | undefined): boolean {
    return code != null && TRANSPORT_FAILURE_CODES.has(code.toLowerCase())
}

export class OutboundCircuit {
    private consecutive = 0

    constructor(private readonly tripAfter: number = OUTBOUND_CIRCUIT_TRIP_AFTER) {}

    /** Records the outcome of one send. `code` is the failure code, or null/undefined on success. */
    record(code: string | null | undefined): void {
        if (isTransportFailureCode(code)) {
            this.consecutive += 1
        } else {
            this.consecutive = 0
        }
    }

    /** True once `tripAfter` consecutive transport failures have been recorded. */
    get open(): boolean {
        return this.consecutive >= this.tripAfter
    }

    get consecutiveTransportFailures(): number {
        return this.consecutive
    }
}
