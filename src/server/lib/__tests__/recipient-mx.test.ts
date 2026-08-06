import { describe, expect, it, vi, beforeEach } from 'vitest'

const resolveMx = vi.fn()

vi.mock('../dns-resolver', () => ({
    resolver: { resolveMx: (...args: unknown[]) => resolveMx(...args) },
}))

describe('hasMxRecord', () => {
    beforeEach(() => {
        vi.resetModules()
        resolveMx.mockReset()
    })

    it('returns true when the resolver finds at least one MX record', async () => {
        resolveMx.mockResolvedValue([{ exchange: 'mx.example.com', priority: 10 }])
        const { hasMxRecord } = await import('../recipient-mx')
        expect(await hasMxRecord('example.com')).toBe(true)
    })

    it('returns false on a definitive ENOTFOUND (no MX record exists)', async () => {
        const error = Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
        resolveMx.mockRejectedValue(error)
        const { hasMxRecord } = await import('../recipient-mx')
        expect(await hasMxRecord('nomx.example.com')).toBe(false)
    })

    it('returns false on a definitive ENODATA (no MX record exists)', async () => {
        const error = Object.assign(new Error('no data'), { code: 'ENODATA' })
        resolveMx.mockRejectedValue(error)
        const { hasMxRecord } = await import('../recipient-mx')
        expect(await hasMxRecord('nodata.example.com')).toBe(false)
    })

    it('fails open (null) on a transient DNS error — never marks a lead invalid on timeout', async () => {
        const error = Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })
        resolveMx.mockRejectedValue(error)
        const { hasMxRecord } = await import('../recipient-mx')
        expect(await hasMxRecord('flaky.example.com')).toBeNull()
    })

    it('caches a result so repeat lookups for the same domain do not hit the resolver again', async () => {
        resolveMx.mockResolvedValue([{ exchange: 'mx.example.com', priority: 10 }])
        const { hasMxRecord } = await import('../recipient-mx')
        await hasMxRecord('cached.example.com')
        await hasMxRecord('cached.example.com')
        await hasMxRecord('CACHED.example.com') // case-insensitive cache key
        expect(resolveMx).toHaveBeenCalledTimes(1)
    })
})
