/**
 * Stateless HMAC-signed tokens for outreach unsubscribe AND open/click tracking.
 *
 * Format: `${base64url(payload)}.${base64url(hmac)}`
 * Payload: JSON `{ kind: 'unsub' | 'track', clid: campaignLeadId, cid?: campaignId, ts: epochMs }`
 *
 * Verifying does NOT require a DB lookup — the HMAC alone proves we issued the token.
 * Actions (unsubscribe, record open/click) DO write to the DB but never trust the token
 * payload as primary key for state changes; we always re-fetch the row by id.
 *
 * Replaces the base64-only token previously used in unsubscribe.ts (P1-12 noted that token
 * was forgeable). Now unsubscribe AND tracking share this signing layer.
 */

import { createHmac, timingSafeEqual } from 'crypto'

// Fail loud at module load — both prod and dev MUST have ENCRYPTION_KEY (or JWT_SECRET) set per CLAUDE.md.
// Without a secret the HMAC would be empty-keyed and tokens forgeable → mass-unsubscribe attack vector.
// Mirrors the src/db/index.ts:7-9 pattern.
const HMAC_SECRET = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET
if (!HMAC_SECRET) {
    throw new Error('outreach-tokens: ENCRYPTION_KEY or JWT_SECRET must be set')
}

// 60-day expiry — long enough for stale-link unsubscribes from old campaigns,
// short enough that a leaked HMAC eventually stops working.
const TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000

export type TokenKind = 'unsub' | 'track'

export interface OutreachTokenPayload {
    kind: TokenKind
    clid: string              // campaignLeadId
    cid?: string              // campaignId (required for unsub, optional for track)
    ts: number                // epoch ms when issued
}

function sign(payloadB64: string): string {
    return createHmac('sha256', HMAC_SECRET as string).update(payloadB64).digest('base64url')
}

export function generateOutreachToken(payload: Omit<OutreachTokenPayload, 'ts'>): string {
    const full: OutreachTokenPayload = { ...payload, ts: Date.now() }
    const payloadB64 = Buffer.from(JSON.stringify(full)).toString('base64url')
    const sig = sign(payloadB64)
    return `${payloadB64}.${sig}`
}

export function verifyOutreachToken(token: string, expectedKind: TokenKind): OutreachTokenPayload | null {
    if (!token || typeof token !== 'string') return null
    const dot = token.lastIndexOf('.')
    if (dot < 1) return null
    const payloadB64 = token.slice(0, dot)
    const providedSig = token.slice(dot + 1)
    const expectedSig = sign(payloadB64)

    // Constant-time compare to prevent timing oracle.
    let sigOk = false
    try {
        const a = Buffer.from(providedSig, 'base64url')
        const b = Buffer.from(expectedSig, 'base64url')
        if (a.length !== b.length) return null
        sigOk = timingSafeEqual(a, b)
    } catch { return null }
    if (!sigOk) return null

    let payload: OutreachTokenPayload
    try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
    } catch { return null }

    if (payload.kind !== expectedKind) return null
    if (!payload.clid || typeof payload.clid !== 'string') return null
    if (typeof payload.ts !== 'number') return null
    if (Date.now() - payload.ts > TOKEN_TTL_MS) return null

    return payload
}
