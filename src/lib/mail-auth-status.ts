// Client-side parser for the `Authentication-Results` header that mx-server.ts persists onto
// `mail_messages.headers` (see src/server/lib/mail-auth.ts verifyInbound + sealWithAuthHeader,
// and src/server/mx-server.ts storeInbound -> `headers: parsed.headers`). Header keys coming
// back from the API are lowercased (mailparser convention), so we read `headers['authentication-results']`.
//
// This is the INBOUND sender-authentication signal (SPF/DKIM/DMARC) for anti-phishing display
// in the webmail inbox. It is unrelated to `leads.emailVerificationStatus` (outreach lead
// deliverability, see src/components/outreach/LeadVerificationBadge.tsx) — do not conflate.

export type SenderAuthStatus = 'pass' | 'fail' | null

function extractMechanismResult(headerValue: string, mechanism: 'spf' | 'dkim' | 'dmarc'): string | null {
    const match = headerValue.match(new RegExp(`\\b${mechanism}=([a-zA-Z]+)`, 'i'))
    return match ? match[1].toLowerCase() : null
}

/**
 * Defensively parses the Authentication-Results header value. The header format varies by
 * MTA, so we only ever assert 'pass' or 'fail' when a recognized mechanism explicitly says so.
 * Anything else — missing header, no recognized mechanism, softfail/neutral/temperror/none,
 * or a shape we don't understand — returns null so the caller shows nothing instead of a
 * false trust signal.
 */
export function getSenderAuthStatus(headers?: Record<string, string> | null | undefined): SenderAuthStatus {
    if (!headers) return null

    const raw = headers['authentication-results']
    if (!raw || typeof raw !== 'string') return null

    const spf = extractMechanismResult(raw, 'spf')
    const dkim = extractMechanismResult(raw, 'dkim')
    const dmarc = extractMechanismResult(raw, 'dmarc')

    if (!spf && !dkim && !dmarc) return null

    if (dmarc === 'pass' || (spf === 'pass' && dkim === 'pass')) {
        return 'pass'
    }

    if (spf === 'fail' || dkim === 'fail' || dmarc === 'fail') {
        return 'fail'
    }

    return null
}
