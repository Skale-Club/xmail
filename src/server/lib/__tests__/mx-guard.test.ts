/**
 * Pure unit tests for isOwnMeshSender — no real DB, `queryClient` is mocked (same convention as
 * cron-lock.test.ts).
 *
 * Guards the greylist self-exemption (2026-08-17/20 fix): the warm-up mesh sends between our own
 * verified inboxes, all routing back to our own MX, which used to greylist every pair on first
 * contact and only made it through because a retry never happened (see processWarmup.ts / the
 * lib/warmup/retry.ts fix in the same change). This predicate is what lets a genuine mesh sender
 * skip that hold — and what a stranger forging one of our domains must NOT be able to trigger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const queryClientMock = vi.hoisted(() => vi.fn())

vi.mock('../../../db', () => ({ queryClient: queryClientMock }))

import { isOwnMeshSender } from '../mx-guard'

/** Fakes queryClient's tagged-template call: resolves the SELECT to `rows`. */
function stubQuery(rows: Array<{ id: string }>) {
    queryClientMock.mockImplementation(async () => rows)
}

function stubQueryError(err: Error) {
    queryClientMock.mockImplementation(async () => { throw err })
}

beforeEach(() => {
    queryClientMock.mockReset()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('isOwnMeshSender', () => {
    it('exempts an address that matches a verified email_accounts row', async () => {
        stubQuery([{ id: 'acc-1' }])
        await expect(isOwnMeshSender('warmup1@ourdomain.com')).resolves.toBe(true)
    })

    it('is case-insensitive on the address', async () => {
        stubQuery([{ id: 'acc-1' }])
        await expect(isOwnMeshSender('WarmUp1@OurDomain.com')).resolves.toBe(true)
    })

    it('does NOT exempt a stranger who merely spoofs one of our domains with an unregistered local-part', async () => {
        // The whole point of the exact-match design: a forged MAIL FROM under a domain we own
        // (public DNS) is only exempt if it is a real, currently-verified account — not because
        // the domain happens to be ours.
        stubQuery([])
        await expect(isOwnMeshSender('totally-made-up@ourdomain.com')).resolves.toBe(false)
    })

    it('does not exempt an address on a domain we have nothing to do with', async () => {
        stubQuery([])
        await expect(isOwnMeshSender('someone@gmail.com')).resolves.toBe(false)
    })

    it('rejects a malformed address without querying the database', async () => {
        await expect(isOwnMeshSender('not-an-email')).resolves.toBe(false)
        await expect(isOwnMeshSender('')).resolves.toBe(false)
        expect(queryClientMock).not.toHaveBeenCalled()
    })

    it('fails closed (not exempt) on a database error', async () => {
        stubQueryError(new Error('connection reset'))
        await expect(isOwnMeshSender('warmup1@ourdomain.com')).resolves.toBe(false)
    })
})
