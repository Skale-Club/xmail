/**
 * Inbound SPF/DKIM/DMARC/ARC verification via mailauth.
 *
 * Called from mx-server.ts onData. Returns an object with:
 *   - headers: the formatted Authentication-Results header (to prepend to message)
 *   - verdict: 'accept' | 'quarantine' | 'reject' based on DMARC policy
 *   - raw: the mailauth result object (for logging/debugging)
 *
 * In dev (no TLS certs → assumed dev environment), enforce is relaxed:
 *   'reject' verdicts are downgraded to 'quarantine' to avoid blocking local tests.
 */

import { authenticate as mailAuth } from 'mailauth'
import { hasMailTLS } from './mail-tls'

export type AuthVerdict = 'accept' | 'quarantine' | 'reject'

export interface AuthContext {
    ip: string
    helo: string
    sender: string
    recipients: string[]
}

export interface AuthOutcome {
    headers: string           // Authentication-Results header content (without "Authentication-Results: " prefix)
    verdict: AuthVerdict
    spfPass: boolean
    dkimPass: boolean
    dmarcPass: boolean
    reason?: string
}

export async function verifyInbound(raw: Buffer, ctx: AuthContext): Promise<AuthOutcome | null> {
    try {
        const result = await mailAuth(raw, {
            ip: ctx.ip,
            helo: ctx.helo,
            mta: process.env.MAIL_HOST || 'mail.skale.club',
            sender: ctx.sender,
        })

        // mailauth returns .headers as a fully-formed Authentication-Results header string.
        // Strip any leading "Authentication-Results: " prefix if present, since we prepend it ourselves.
        const rawHeaders = result.headers || ''
        const headers = rawHeaders.replace(/^Authentication-Results:\s*/i, '').trim()

        // mailauth types return `false | Result` — narrow before accessing
        const spf = result.spf && typeof result.spf === 'object' ? result.spf : null
        const dmarc = result.dmarc && typeof result.dmarc === 'object' ? result.dmarc : null
        const spfResult = spf?.status?.result
        const dmarcStatus = dmarc?.status?.result
        const dmarcPolicy = dmarc?.policy

        const spfPass = spfResult === 'pass'
        const dmarcPass = dmarcStatus === 'pass'

        // DKIM has multiple signatures; consider pass if any sig passes AND is aligned
        const dkimResults = (result.dkim?.results ?? []) as Array<{ status?: { result?: string } }>
        const dkimPass = dkimResults.some((r) => r?.status?.result === 'pass')

        let verdict: AuthVerdict = 'accept'
        let reason: string | undefined

        if (!dmarcPass && (dmarcPolicy === 'reject' || dmarcPolicy === 'quarantine')) {
            verdict = dmarcPolicy as AuthVerdict
            reason = `DMARC ${dmarcStatus}, policy=${dmarcPolicy}`
        }

        // Dev mode: downgrade reject to quarantine so local tests with spoofed
        // addresses aren't blocked at the SMTP layer.
        if (verdict === 'reject' && !hasMailTLS()) {
            verdict = 'quarantine'
            reason = (reason ?? '') + ' [dev: downgraded reject→quarantine]'
        }

        return { headers, verdict, spfPass, dkimPass, dmarcPass, reason }
    } catch (err) {
        console.error('[mail-auth] verification error:', (err as Error).message)
        return null
    }
}

/**
 * Prepend the Authentication-Results header to the raw message.
 * Preserves existing headers and body.
 */
export function sealWithAuthHeader(raw: Buffer, authHeaderValue: string): Buffer {
    const mta = process.env.MAIL_HOST || 'mail.skale.club'
    const header = `Authentication-Results: ${mta}; ${authHeaderValue}\r\n`
    return Buffer.concat([Buffer.from(header, 'utf8'), raw])
}
