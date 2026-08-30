/**
 * These tests pin the transition semantics, which are the whole reason this
 * layer exists. A condition that alerts on every observation instead of every
 * CHANGE turns a six-hour incident into ~72 messages, and a channel that
 * floods is a channel that gets muted.
 *
 * `../telegram` is mocked so nothing here touches the database or the network:
 * the real module reads system_integrations at call time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    __resetOpsAlertState,
    alertOps,
    getActiveOpsAlerts,
    reportOpsCondition,
    resolveOps,
} from '../ops-alert'
import { sendTelegram } from '../telegram'

// vi.hoisted runs before the mocked module is loaded, so the capture array is
// already initialised when the factory below closes over it. A plain `const`
// here would still be in its temporal dead zone at that point.
const { sent } = vi.hoisted(() => ({ sent: [] as Array<{ title: string; body: string }> }))

vi.mock('../telegram', () => ({
    sendTelegram: vi.fn(async (title: string, body: string) => {
        sent.push({ title, body })
        return { ok: true }
    }),
    escapeHtml: (v: unknown) => String(v),
}))

describe('alertOps / resolveOps', () => {
    beforeEach(() => {
        __resetOpsAlertState()
        sent.length = 0
    })

    it('sends on the first observation of a condition', async () => {
        await alertOps('queue.stalled', 'Queue stalled', '12 stuck')
        expect(sent).toHaveLength(1)
        expect(sent[0].title).toBe('Queue stalled')
    })

    it('stays quiet while the same condition persists', async () => {
        for (let i = 0; i < 20; i += 1) {
            await alertOps('queue.stalled', 'Queue stalled', 'still stuck')
        }
        expect(sent).toHaveLength(1)
    })

    it('tracks distinct conditions independently', async () => {
        await alertOps('queue.stalled', 'Queue stalled')
        await alertOps('host.disk', 'Disk filling')
        expect(sent).toHaveLength(2)
        expect(getActiveOpsAlerts().sort()).toEqual(['host.disk', 'queue.stalled'])
    })

    it('sends exactly one recovery message when the condition clears', async () => {
        await alertOps('queue.stalled', 'Queue stalled')
        await resolveOps('queue.stalled', 'Queue draining again')
        expect(sent).toHaveLength(2)
        expect(sent[1].title).toBe('Queue draining again')
        expect(sent[1].body).toContain('Recovered after')
    })

    it('never announces a recovery for something that was never announced broken', async () => {
        await resolveOps('queue.stalled', 'Queue draining again')
        expect(sent).toHaveLength(0)
    })

    it('does not repeat the recovery if resolve is called again', async () => {
        await alertOps('queue.stalled', 'Queue stalled')
        await resolveOps('queue.stalled', 'Queue draining again')
        await resolveOps('queue.stalled', 'Queue draining again')
        expect(sent).toHaveLength(2)
    })

    it('re-arms after recovery, so the next incident alerts again', async () => {
        await alertOps('queue.stalled', 'Queue stalled')
        await resolveOps('queue.stalled', 'Queue draining again')
        await alertOps('queue.stalled', 'Queue stalled')
        expect(sent).toHaveLength(3)
        expect(sent[2].title).toBe('Queue stalled')
    })

    it('never throws, even if the sender does', async () => {
        vi.mocked(sendTelegram).mockRejectedValueOnce(new Error('network down'))
        await expect(alertOps('boom', 'Boom')).resolves.toBe(false)
    })
})

describe('reportOpsCondition', () => {
    beforeEach(() => {
        __resetOpsAlertState()
        sent.length = 0
    })

    it('drives a full down-then-up cycle from a boolean', async () => {
        const messages = {
            failTitle: 'Disk filling',
            okTitle: 'Disk back to normal',
        }

        await reportOpsCondition('host.disk', false, messages)
        expect(sent).toHaveLength(0)   // healthy start says nothing

        await reportOpsCondition('host.disk', true, messages)
        await reportOpsCondition('host.disk', true, messages)
        expect(sent).toHaveLength(1)   // one alert, not one per check

        await reportOpsCondition('host.disk', false, messages)
        expect(sent).toHaveLength(2)   // one recovery

        await reportOpsCondition('host.disk', false, messages)
        expect(sent).toHaveLength(2)   // and then quiet again
    })
})
