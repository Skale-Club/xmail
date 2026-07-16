import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../../test/postgres-harness'

// Information-disclosure boundary lock for GET /o/u/check (was unsubscribe.ts:408).
//
// The old route was `GET /check/:leadId/:campaignId`: unauthenticated, and it echoed the
// lead's status / unsubscribe state for ANY known lead+campaign UUID pair — protected only
// by v4-UUID unguessability. A leaked or logged id pair enabled cross-tenant enumeration of
// a lead's state (and the handler even SELECTed the email column).
//
// The hardening (a)+(b): the probe now REQUIRES the same HMAC `unsub` token as the one-click
// unsubscribe flow (raw ids are no longer a valid route shape), and the response is reduced
// to a single boolean `{ isUnsubscribed }` — never the email, lead status, or campaign-lead
// status. This suite proves both properties against a real database row.
//
// The unsubscribe router is deliberately mounted with NO auth middleware, mirroring
// production (`/o/u` lives outside `/api`): the token IS the authorization.

const ORG = 'f5000000-0000-4000-8000-0000000000a1'
const OWNER = 'f5000000-0000-4000-8000-000000000001'
const LEAD = 'f5000000-0000-4000-8000-0000000000d1'
const CAMPAIGN = 'f5000000-0000-4000-8000-0000000000c1'
const CAMPAIGN_LEAD = 'f5000000-0000-4000-8000-0000000000e1'
const LEAD_EMAIL = 'disclosure-target@example.test'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

let sql: ReturnType<typeof postgres>
let server: http.Server
let baseUrl: string
let validToken: string
let forgedToken: string
let closeApplicationDatabase: (() => Promise<void>) | undefined

async function get(pathname: string) {
    const response = await fetch(`${baseUrl}${pathname}`)
    const text = await response.text()
    let json: any = null
    try {
        json = text ? JSON.parse(text) : null
    } catch {
        json = null
    }
    return { status: response.status, text, json }
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    process.env.SUPABASE_URL ||= 'http://localhost:54321'
    process.env.SUPABASE_ANON_KEY ||= 'test-anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key'

    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })

    await sql`INSERT INTO users (id, email, is_admin) VALUES
        (${OWNER}::uuid, 'disclosure-owner@example.test', false)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO organizations (id, name, slug, owner_id) VALUES
        (${ORG}::uuid, 'Disclosure Org', 'disclosure-org', ${OWNER}::uuid)
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO leads (id, organization_id, email, status) VALUES
        (${LEAD}::uuid, ${ORG}::uuid, ${LEAD_EMAIL}, 'new')
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO campaigns (id, organization_id, name, status) VALUES
        (${CAMPAIGN}::uuid, ${ORG}::uuid, 'Disclosure Campaign', 'active')
        ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO campaign_leads (id, campaign_id, lead_id, status) VALUES
        (${CAMPAIGN_LEAD}::uuid, ${CAMPAIGN}::uuid, ${LEAD}::uuid, 'new')
        ON CONFLICT (id) DO NOTHING`

    // Import AFTER env is set: outreach-tokens throws at load without a secret, and the db
    // client binds DATABASE_URL at import time.
    const unsubscribeRouter = (await import('../unsubscribe')).default
    const { generateOutreachToken } = await import('../../../lib/outreach-tokens')
    closeApplicationDatabase = (await import('../../../../db')).closeDatabaseConnection

    // The unsubscribe token semantically carries campaignLeadId as `clid` (per-campaign row),
    // NOT the raw lead id — see generateUnsubscribeLink in unsubscribe.ts.
    validToken = generateOutreachToken({ kind: 'unsub', clid: CAMPAIGN_LEAD, cid: CAMPAIGN })
    // Tamper the HMAC signature: valid payload, wrong signature => must be rejected.
    forgedToken = `${validToken.slice(0, validToken.lastIndexOf('.'))}.${Buffer.from('forged').toString('base64url')}`

    const app = express()
    app.use(express.json())
    app.use('/o/u', unsubscribeRouter)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

describe('GET /o/u/check hardening — info disclosure', () => {
    it('rejects the old raw-id shape and discloses nothing', async () => {
        // The pre-hardening enumeration vector: raw lead + campaign UUIDs, no token. This URL
        // shape must no longer resolve to a data-bearing response.
        const res = await get(`/o/u/check/${LEAD}/${CAMPAIGN}`)

        expect(res.status).toBe(404)
        expect(res.text).not.toContain(LEAD_EMAIL)
        // None of the previously-leaked fields may appear.
        expect(res.text).not.toContain('leadStatus')
        expect(res.text).not.toContain('campaignLeadStatus')
        expect(res.text).not.toContain('unsubscribedAt')
    })

    it('accepts a valid HMAC token and returns only the boolean status', async () => {
        const res = await get(`/o/u/check/${validToken}`)

        expect(res.status).toBe(200)
        expect(res.json).toEqual({ isUnsubscribed: false })
        // Explicitly: no email and no other row data leaks through the token path either.
        expect(res.text).not.toContain(LEAD_EMAIL)
        expect(res.json).not.toHaveProperty('email')
        expect(res.json).not.toHaveProperty('leadStatus')
        expect(res.json).not.toHaveProperty('campaignLeadStatus')
        expect(res.json).not.toHaveProperty('leadId')
    })

    it('rejects a forged (bad-signature) token without disclosing anything', async () => {
        const res = await get(`/o/u/check/${forgedToken}`)

        expect(res.status).toBe(400)
        expect(res.text).not.toContain(LEAD_EMAIL)
    })

    it('reflects a real unsubscribe through the boolean, still without leaking the email', async () => {
        // Mutate the lead directly (this suite owns the row) and confirm the probe flips.
        await sql`UPDATE leads SET status = 'unsubscribed', unsubscribed_at = now() WHERE id = ${LEAD}::uuid`

        const res = await get(`/o/u/check/${validToken}`)

        expect(res.status).toBe(200)
        expect(res.json).toEqual({ isUnsubscribed: true })
        expect(res.text).not.toContain(LEAD_EMAIL)
    })
})
