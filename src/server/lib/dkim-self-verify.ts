/**
 * Verify what was actually signed, not the intention to sign.
 *
 * docs/outbound-authentication-audit.md, Fase 2: `native-send.ts` and `smtp-server.ts` each
 * logged `DKIM enabled: selector=... domain=...` right before handing bytes to the
 * transport. That line records INTENT — a key was found in the DB and handed to
 * Nodemailer — never whether the signature Nodemailer produced actually verifies. Production
 * showed that exact line for every one of 11 domains (all `verified`, all with a DKIM key)
 * while 11.4% of native mail to Gmail landed in spam anyway, and nobody could say whether
 * the signature that arrived was valid. That is the failure mode this file closes; the
 * callers no longer trust "a key existed" as a proxy for "the message is signed correctly".
 *
 * How: sign the message ourselves with Nodemailer's OWN DKIM signer (`nodemailer/lib/dkim`
 * — the identical class the transport would otherwise invoke internally when `dkim` is
 * passed to `createTransport`/`sendMail`, so the resulting bytes are byte-for-byte what the
 * transport would have produced), then immediately verify that exact buffer with mailauth's
 * `dkimVerify` (already a dependency, already used for INBOUND verification in
 * mail-auth.ts's `verifyInbound`). The caller hands `sendOutbound` the ALREADY-SIGNED bytes
 * this returns and passes no `dkim` option of its own — the message is signed exactly once,
 * by us, and only ever delivered once it has passed a real verification against its own
 * bytes.
 */

import DKIM from 'nodemailer/lib/dkim'
import { dkimVerify } from 'mailauth'
import type { DNSResolver } from 'mailauth'
import type { OutboundDkim } from './outbound-transport'

export interface DkimSelfCheck {
    /** Bytes to hand to the transport. Identical to the input when `dkim` was undefined. */
    raw: Buffer
    /**
     * True when there was nothing of ours to verify (no `dkim` supplied — unsigned by
     * design, e.g. `shouldSkipOwnDkimForRelay`), or when we signed and mailauth confirmed
     * the signature verifies for `dkim.domainName`. False means: do not deliver these bytes.
     */
    verified: boolean
    /** Present whenever `dkim` was supplied. A one-line measurement for the caller's log. */
    reason?: string
}

function signWithNodemailerDkim(raw: Buffer, dkim: OutboundDkim): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const signer = new DKIM({
            domainName: dkim.domainName,
            keySelector: dkim.keySelector,
            privateKey: dkim.privateKey,
        })
        const chunks: Buffer[] = []
        const stream = signer.sign(raw)
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => resolve(Buffer.concat(chunks)))
        stream.on('error', reject)
    })
}

export interface SignAndSelfVerifyOptions {
    /**
     * Injectable DNS TXT resolver, forwarded to mailauth's `dkimVerify`. Production omits
     * this and gets mailauth's default (real DNS — the same lookup Gmail itself would do).
     * Tests supply a fake resolver that answers `<selector>._domainkey.<domain>` with the
     * TXT record for a throwaway keypair, so verification is exercised without a network.
     */
    resolver?: DNSResolver
}

/**
 * Sign `raw` with `dkim` and verify the exact resulting bytes before anything is handed to a
 * transport. When `dkim` is `undefined` this is a no-op (`verified: true`, bytes unchanged) —
 * there is deliberately nothing of ours to verify, the same cases `relayMessage` already
 * treats as "unsigned by design" (no key configured, or `shouldSkipOwnDkimForRelay` decided
 * the relay re-signs on its own and ours would only fail the body hash for a body the relay
 * is about to rewrite).
 */
export async function signAndSelfVerify(
    raw: Buffer,
    dkim: OutboundDkim | undefined,
    options: SignAndSelfVerifyOptions = {},
): Promise<DkimSelfCheck> {
    if (!dkim) return { raw, verified: true }

    const signed = await signWithNodemailerDkim(raw, dkim)
    const domain = dkim.domainName.toLowerCase()

    let outcome
    try {
        outcome = await dkimVerify(signed, { resolver: options.resolver })
    } catch (err) {
        // mailauth itself threw (malformed message, DNS resolver blew up, ...): treat as a
        // failed verification rather than letting the error escape uncaught — the caller's
        // job is to fail the send either way, and it wants a reason string either way.
        return {
            raw: signed,
            verified: false,
            reason: `dkimVerify threw: ${err instanceof Error ? err.message : String(err)}`,
        }
    }

    const match = (outcome.results ?? []).find((r) => (r.signingDomain || '').toLowerCase() === domain)

    if (match?.status?.result === 'pass') {
        return {
            raw: signed,
            verified: true,
            reason: `pass (d=${match.signingDomain} s=${match.selector ?? dkim.keySelector})`,
        }
    }

    const reason = match
        ? `${match.status.result}${match.status.comment ? ` (${match.status.comment})` : ''} (d=${match.signingDomain} s=${match.selector ?? dkim.keySelector})`
        : `no DKIM-Signature found for d=${dkim.domainName} in the signed message`
    return { raw: signed, verified: false, reason }
}
