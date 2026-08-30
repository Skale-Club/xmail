/**
 * The spike detector is the one alert with a tuning number in it, so the
 * properties that keep the channel usable — fires once, not per error; stays
 * quiet during the cooldown; cannot alert about itself — are pinned here rather
 * than left to be rediscovered the first time production floods.
 *
 * `now` is passed explicitly into recordError so nothing here depends on wall
 * clock or fake timers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    __resetErrorSpikeState,
    __setErrorSpikeDispatcher,
    getErrorSpikeState,
    normalizeEventName,
    recordError,
} from '../error-spike-alert'

/** Matches the module's default; the env var is not set under test. */
const THRESHOLD = 15
const T0 = 1_700_000_000_000

describe('normalizeEventName', () => {
    it('collapses ids, emails and numbers so one fault reports as one event', () => {
        const a = normalizeEventName('Failed to send to ada@example.com for org 550e8400-e29b-41d4-a716-446655440000')
        const b = normalizeEventName('Failed to send to bob@other.org for org 6ba7b810-9dad-11d1-80b4-00c04fd430c8')
        expect(a).toBe(b)
        expect(a).toContain('<email>')
        expect(a).toContain('<id>')
    })

    it('reads an Error instance and survives non-string input', () => {
        expect(normalizeEventName(new Error('boom'))).toBe('boom')
        expect(normalizeEventName(undefined)).toBe('undefined')
        expect(normalizeEventName(null)).toBe('null')
    })

    it('caps the length so one enormous message cannot dominate the list', () => {
        expect(normalizeEventName('x'.repeat(500)).length).toBeLessThanOrEqual(80)
    })
})

describe('recordError', () => {
    let sent: Array<{ title: string; body: string }>

    beforeEach(() => {
        __resetErrorSpikeState()
        sent = []
        __setErrorSpikeDispatcher(async (title, body) => {
            sent.push({ title, body })
        })
    })

    it('stays silent below the threshold', () => {
        for (let i = 0; i < THRESHOLD - 1; i += 1) recordError('boom', T0)
        expect(sent).toHaveLength(0)
    })

    it('fires exactly once when the threshold is crossed', () => {
        for (let i = 0; i < THRESHOLD; i += 1) recordError('boom', T0)
        expect(sent).toHaveLength(1)
        expect(sent[0].title).toContain('error spike')
    })

    it('names the most frequent events, so the alert says WHAT broke', () => {
        // Both counts scale with THRESHOLD: a fixed split would either stop
        // reaching the alert when the threshold rises, or — as happened when it
        // dropped from 60 to 15 — quietly make the "minor" event the larger of
        // the two and turn the ordering assertion below into its own opposite.
        const minor = Math.max(2, Math.floor(THRESHOLD / 5))
        for (let i = 0; i < THRESHOLD - minor; i += 1) recordError('database unreachable', T0)
        for (let i = 0; i < minor; i += 1) recordError('r2 upload failed', T0)
        expect(sent).toHaveLength(1)
        expect(sent[0].body).toContain('database unreachable')
        expect(sent[0].body).toContain('r2 upload failed')
        // The dominant one is listed first.
        const body = sent[0].body
        expect(body.indexOf('database unreachable')).toBeLessThan(body.indexOf('r2 upload failed'))
    })

    it('does not re-alert during the cooldown, even under a sustained storm', () => {
        for (let i = 0; i < THRESHOLD; i += 1) recordError('boom', T0)
        expect(sent).toHaveLength(1)

        // Ten minutes later, still broken, still inside the 30min cooldown.
        for (let i = 0; i < THRESHOLD * 3; i += 1) recordError('boom', T0 + 10 * 60_000)
        expect(sent).toHaveLength(1)
    })

    it('speaks again for a fresh burst once the cooldown has lapsed', async () => {
        for (let i = 0; i < THRESHOLD; i += 1) recordError('boom', T0)

        // Let the in-flight dispatch settle. The re-entrancy guard drops errors
        // logged WHILE an alert is being sent, so without yielding the event
        // loop the second burst would be swallowed by the guard rather than by
        // the cooldown — which is not what this test is about, and never
        // happens in production where 31 real minutes pass between the two.
        await new Promise((resolve) => setTimeout(resolve, 0))

        const later = T0 + 31 * 60_000
        for (let i = 0; i < THRESHOLD; i += 1) recordError('boom', later)
        expect(sent).toHaveLength(2)
    })

    it('forgets a trickle that never reaches the threshold within one window', () => {
        for (let i = 0; i < THRESHOLD - 1; i += 1) recordError('boom', T0)
        // A new window opens; the earlier near-miss must not carry over.
        for (let i = 0; i < THRESHOLD - 1; i += 1) recordError('boom', T0 + 6 * 60_000)
        expect(sent).toHaveLength(0)
    })

    it('ignores its own failures, so a broken notifier cannot feed itself', () => {
        for (let i = 0; i < THRESHOLD * 2; i += 1) recordError('[telegram] rejected something', T0)
        expect(sent).toHaveLength(0)
    })

    it('never throws, whatever the dispatcher does', () => {
        __setErrorSpikeDispatcher(() => {
            throw new Error('dispatcher exploded')
        })
        expect(() => {
            for (let i = 0; i < THRESHOLD; i += 1) recordError('boom', T0)
        }).not.toThrow()
    })

    it('measures its own background rate so the threshold can be set from data', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        try {
            // Two quiet windows, then a tick past the hourly baseline log.
            recordError('minor', T0)
            recordError('minor', T0 + 6 * 60_000)
            recordError('minor', T0 + 61 * 60_000)

            const emitted = log.mock.calls
                .map((c) => String(c[0]))
                .filter((line) => line.includes('error_spike.baseline'))
            expect(emitted.length).toBeGreaterThan(0)
            const parsed = JSON.parse(emitted[0])
            expect(parsed.configuredThreshold).toBe(THRESHOLD)
            expect(parsed).toHaveProperty('meanErrorsPerWindow')
        } finally {
            log.mockRestore()
        }
    })

    it('reports its configured threshold for diagnostics', () => {
        expect(getErrorSpikeState().threshold).toBe(THRESHOLD)
    })
})
