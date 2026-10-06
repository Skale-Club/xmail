import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit tests, no DB: validation of the domain payload and that every query is scoped to the
 * authenticated user (x-user-id). drizzle's eq/and are replaced by tagged objects so the
 * WHERE clauses the route builds can be inspected.
 */

const selectRowsMock = vi.hoisted(() => vi.fn())
const insertValuesMock = vi.hoisted(() => vi.fn())
const deleteWhereMock = vi.hoisted(() => vi.fn())
const selectWhereMock = vi.hoisted(() => vi.fn())

vi.mock('drizzle-orm', async (importOriginal) => {
    const actual = await importOriginal<typeof import('drizzle-orm')>()
    return {
        ...actual,
        eq: (col: { name: string }, val: unknown) => ({ op: 'eq', col: col.name, val }),
        and: (...args: unknown[]) => ({ op: 'and', args }),
        asc: (col: unknown) => col,
    }
})

vi.mock('../../../db', () => ({
    db: {
        select: () => ({
            from: () => ({
                where: (cond: unknown) => {
                    selectWhereMock(cond)
                    return { orderBy: () => Promise.resolve(selectRowsMock()) }
                },
            }),
        }),
        insert: () => ({
            values: (rows: unknown) => {
                insertValuesMock(rows)
                return { onConflictDoNothing: () => Promise.resolve(undefined) }
            },
        }),
        delete: () => ({
            where: (cond: unknown) => {
                deleteWhereMock(cond)
                return Promise.resolve(undefined)
            },
        }),
    },
}))

let server: http.Server
let baseUrl: string

async function call(method: string, pathname: string, opts: { body?: unknown; user?: string | null } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const user = opts.user === undefined ? 'user-a' : opts.user
    if (user) headers['x-user-id'] = user
    const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

beforeEach(async () => {
    vi.clearAllMocks()
    selectRowsMock.mockReturnValue([{ domain: 'dataforseo.com' }, { domain: 'example.com' }])
    const router = (await import('./trusted-image-domains')).default
    const app = express()
    app.use(express.json())
    app.use('/', router)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // Loading the router's module graph cold can exceed the default 10s hook timeout on a loaded machine.
}, 20_000)

afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.resetModules()
})

describe('GET /', () => {
    it('lists only the caller domains', async () => {
        const result = await call('GET', '/')
        expect(result.status).toBe(200)
        expect(result.body).toEqual({ domains: ['dataforseo.com', 'example.com'] })
        expect(selectWhereMock).toHaveBeenCalledWith({ op: 'eq', col: 'user_id', val: 'user-a' })
    })

    it('rejects a request without a user', async () => {
        const result = await call('GET', '/', { user: null })
        expect(result.status).toBe(401)
        expect(selectWhereMock).not.toHaveBeenCalled()
    })
})

describe('POST /', () => {
    it('stores the normalized registrable domain under the caller id', async () => {
        const result = await call('POST', '/', { body: { domain: '  News.Example.CO.UK ' } })
        expect(result.status).toBe(201)
        expect(result.body).toEqual({ domains: ['example.co.uk'] })
        expect(insertValuesMock).toHaveBeenCalledWith([{ userId: 'user-a', domain: 'example.co.uk' }])
    })

    it('ignores a userId smuggled into the body', async () => {
        await call('POST', '/', { body: { domain: 'example.com', userId: 'user-b' } })
        expect(insertValuesMock).toHaveBeenCalledWith([{ userId: 'user-a', domain: 'example.com' }])
    })

    it('accepts a deduplicated bulk list', async () => {
        const result = await call('POST', '/', { body: { domains: ['a.com', 'mail.a.com', 'b.com'] } })
        expect(result.status).toBe(201)
        expect(insertValuesMock).toHaveBeenCalledWith([
            { userId: 'user-a', domain: 'a.com' },
            { userId: 'user-a', domain: 'b.com' },
        ])
    })

    it.each([
        ['empty string', { domain: '' }],
        ['IPv4', { domain: '1.2.3.4' }],
        ['single label', { domain: 'localhost' }],
        ['public suffix', { domain: 'co.uk' }],
        ['URL', { domain: 'https://example.com/x' }],
        ['email', { domain: 'a@example.com' }],
        ['too long', { domain: `${'a'.repeat(250)}.com` }],
        ['not a string', { domain: 42 }],
        ['missing field', {}],
        ['empty bulk', { domains: [] }],
        ['bulk with a bad entry', { domains: ['a.com', '1.2.3.4'] }],
    ])('rejects %s with 400 and writes nothing', async (_label, body) => {
        const result = await call('POST', '/', { body })
        expect(result.status).toBe(400)
        expect(insertValuesMock).not.toHaveBeenCalled()
    })

    it('rejects a request without a user', async () => {
        const result = await call('POST', '/', { body: { domain: 'example.com' }, user: null })
        expect(result.status).toBe(401)
        expect(insertValuesMock).not.toHaveBeenCalled()
    })
})

describe('DELETE /:domain', () => {
    it('deletes only the caller row for that domain', async () => {
        const result = await call('DELETE', '/Example.com')
        expect(result.status).toBe(200)
        expect(deleteWhereMock).toHaveBeenCalledWith({
            op: 'and',
            args: [
                { op: 'eq', col: 'user_id', val: 'user-a' },
                { op: 'eq', col: 'domain', val: 'example.com' },
            ],
        })
    })

    it('rejects an invalid domain', async () => {
        const result = await call('DELETE', '/not%20a%20domain')
        expect(result.status).toBe(400)
        expect(deleteWhereMock).not.toHaveBeenCalled()
    })

    it('rejects a request without a user', async () => {
        const result = await call('DELETE', '/example.com', { user: null })
        expect(result.status).toBe(401)
        expect(deleteWhereMock).not.toHaveBeenCalled()
    })
})
