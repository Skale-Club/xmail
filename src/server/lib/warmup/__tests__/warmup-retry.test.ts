/**
 * Pure unit tests for lib/warmup/retry.ts — no DB, no network.
 *
 * Guards against the 2026-08-17 incident: 38 warm-up sends were marked `failed` on a 451
 * greylist rejection, which explicitly asks the sender to retry in 5 minutes. `classifySendFailure`
 * is what tells the caller "this is worth retrying" vs "give up now"; `decideWarmupSendOutcome`
 * layers the attempt cap on top so a persistently-transient failure eventually stops too.
 */
import { describe, expect, it } from 'vitest'
import {
    classifySendFailure,
    decideWarmupSendOutcome,
    MAX_WARMUP_SEND_ATTEMPTS,
    nextWarmupAttemptDelayMs,
} from '../retry'

// The exact shape normalizeProviderFailure (outreach-dispatch.ts) returns when it DID find a
// structured code (relay path, or any error that still carries responseCode/statusCode).
function structuredFailure(classification: 'transient' | 'terminal' | 'ambiguous', message: string) {
    return { code: 'irrelevant', classification, acceptance: 'rejected', retryable: classification === 'transient', message }
}

describe('classifySendFailure', () => {
    it('a 451 greylist message is non-terminal', () => {
        // The exact double-wrapped shape outbound-transport.ts produces when every MX host for a
        // domain fails direct delivery — see the module docblock. No structured `classification`
        // survives the wrap, so this exercises the text-scanning fallback.
        const message = "direct delivery to example.com failed on all 1 MX host(s) (mx.skale.club): "
            + "Can't send mail - all recipients were rejected: 451 4.7.1 Greylisted; please retry in 5 minutes"
        const result = classifySendFailure(new Error(message))
        expect(result.terminal).toBe(false)
        expect(result.code).toBe(451)
    })

    it('a 550 is terminal', () => {
        const message = 'direct delivery to example.com failed on all 1 MX host(s) (mx.example.com): '
            + '550 5.1.1 The email account that you tried to reach does not exist'
        const result = classifySendFailure(new Error(message))
        expect(result.terminal).toBe(true)
        expect(result.code).toBe(550)
    })

    it('an unparseable message is treated as non-terminal (retry is the safe default)', () => {
        const result = classifySendFailure(new Error('socket hang up'))
        expect(result.terminal).toBe(false)
        expect(result.code).toBeNull()
    })

    it('trusts a structured terminal classification without needing a code in the text', () => {
        const result = classifySendFailure(structuredFailure('terminal', 'EAUTH: invalid credentials'))
        expect(result.terminal).toBe(true)
    })

    it('trusts a structured transient classification without needing a code in the text', () => {
        const result = classifySendFailure(structuredFailure('transient', 'ETIMEDOUT connecting to host'))
        expect(result.terminal).toBe(false)
    })

    it('falls back to text-scanning when the structured classification is only "ambiguous"', () => {
        const result = classifySendFailure(structuredFailure('ambiguous', 'upstream said 452 4.3.1 mailbox full'))
        expect(result.terminal).toBe(false)
        expect(result.code).toBe(452)
    })

    it('ignores non-error input gracefully', () => {
        expect(classifySendFailure(undefined)).toEqual({ terminal: false, code: null })
        expect(classifySendFailure('plain string, no code here')).toEqual({ terminal: false, code: null })
    })
})

describe('nextWarmupAttemptDelayMs', () => {
    it('floors at exactly the greylist hold (5 minutes) for the first retry', () => {
        expect(nextWarmupAttemptDelayMs(1)).toBe(5 * 60 * 1000)
    })

    it('grows modestly (doubles) on each subsequent attempt', () => {
        expect(nextWarmupAttemptDelayMs(2)).toBe(10 * 60 * 1000)
        expect(nextWarmupAttemptDelayMs(3)).toBe(20 * 60 * 1000)
        expect(nextWarmupAttemptDelayMs(4)).toBe(40 * 60 * 1000)
    })
})

describe('decideWarmupSendOutcome', () => {
    const now = new Date('2026-08-20T12:00:00Z')

    it('a transient failure with attempts remaining stays pending with a scheduled retry', () => {
        const outcome = decideWarmupSendOutcome({
            failure: new Error('451 4.7.1 Greylisted; please retry in 5 minutes'),
            attemptsSoFar: 0,
            now,
        })
        expect(outcome.status).toBe('pending')
        expect(outcome.attempts).toBe(1)
        expect(outcome.nextAttemptAt).toEqual(new Date(now.getTime() + 5 * 60 * 1000))
    })

    it('a terminal (5xx) failure gives up immediately regardless of attempts remaining', () => {
        const outcome = decideWarmupSendOutcome({
            failure: new Error('550 5.1.1 mailbox does not exist'),
            attemptsSoFar: 0,
            now,
        })
        expect(outcome.status).toBe('failed')
        expect(outcome.nextAttemptAt).toBeNull()
    })

    it('attempt cap produces terminal: a transient failure stops retrying once the cap is reached', () => {
        const outcome = decideWarmupSendOutcome({
            failure: new Error('451 4.7.1 Greylisted; please retry in 5 minutes'),
            attemptsSoFar: MAX_WARMUP_SEND_ATTEMPTS - 1,
            now,
        })
        expect(outcome.attempts).toBe(MAX_WARMUP_SEND_ATTEMPTS)
        expect(outcome.status).toBe('failed')
        expect(outcome.nextAttemptAt).toBeNull()
        expect(outcome.lastError).toContain('gave up after')
    })

    it('stays pending right up to (but not past) the cap', () => {
        const outcome = decideWarmupSendOutcome({
            failure: new Error('451 4.7.1 Greylisted; please retry in 5 minutes'),
            attemptsSoFar: MAX_WARMUP_SEND_ATTEMPTS - 2,
            now,
        })
        expect(outcome.attempts).toBe(MAX_WARMUP_SEND_ATTEMPTS - 1)
        expect(outcome.status).toBe('pending')
        expect(outcome.nextAttemptAt).not.toBeNull()
    })
})
