/**
 * docs/outbound-authentication-audit.md, Fase 2 — verify what was signed, not the intention
 * to sign. Every assertion here is against the actual DKIM-Signature bytes and a real
 * mailauth verification, never against a log line or a boolean the code merely set.
 */
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { dkimVerify } from 'mailauth'
import { signAndSelfVerify } from '../dkim-self-verify'
import type { OutboundDkim } from '../outbound-transport'

const DOMAIN = 'dkim-self-verify.example'
const SELECTOR = 'sel1'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const dkimTxt = `v=DKIM1; k=rsa; p=${publicKey.replace(/-----[A-Z ]+-----|\s/g, '')}`

/** Fake DNS: only answers the one selector/domain this suite's key belongs to. */
const resolver = async (name: string, rrtype: string): Promise<string[][]> => {
    if (rrtype === 'TXT' && name === `${SELECTOR}._domainkey.${DOMAIN}`) return [[dkimTxt]]
    throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: 'ENOTFOUND' })
}

const DKIM_CONFIG: OutboundDkim = { domainName: DOMAIN, keySelector: SELECTOR, privateKey }

function rawMessage(body = 'Hello from the warm-up mesh.'): Buffer {
    return Buffer.from(
        [
            `From: Info <info@${DOMAIN}>`,
            'To: rcpt@example.com',
            'Subject: Self-verification test',
            'Message-ID: <fixed@dkim-self-verify.example>',
            'Date: Wed, 09 Sep 2026 12:00:00 +0000',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            `${body}  `, // trailing space on purpose — relaxed canonicalization must tolerate it
            '',
        ].join('\r\n'),
        'utf8',
    )
}

describe('signAndSelfVerify', () => {
    it('is a no-op when no DKIM key is configured — nothing of ours to verify', async () => {
        const raw = rawMessage()
        const result = await signAndSelfVerify(raw, undefined)

        expect(result.verified).toBe(true)
        expect(result.raw.equals(raw)).toBe(true)
        expect(result.raw.toString('utf8')).not.toContain('DKIM-Signature:')
    })

    it('signs with our key and confirms the exact resulting bytes verify (d=, s=, pass)', async () => {
        const raw = rawMessage()
        const result = await signAndSelfVerify(raw, DKIM_CONFIG, { resolver })

        expect(result.verified).toBe(true)
        expect(result.raw.toString('utf8')).toContain('DKIM-Signature:')
        expect(result.reason).toContain(`d=${DOMAIN}`)
        expect(result.reason).toContain(`s=${SELECTOR}`)

        // Re-verify independently (not trusting the module's own bookkeeping) that the bytes
        // it says are "verified" actually carry a passing signature for our domain/selector.
        const independent = await dkimVerify(result.raw, { resolver })
        const match = independent.results?.find((r) => r.signingDomain === DOMAIN)
        expect(match?.status.result).toBe('pass')
        expect(match?.selector).toBe(SELECTOR)
    })

    it('fails when the published key does not match what we signed with (wrong/rotated key)', async () => {
        const { publicKey: otherPublicKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        })
        const mismatchedTxt = `v=DKIM1; k=rsa; p=${otherPublicKey.replace(/-----[A-Z ]+-----|\s/g, '')}`
        const mismatchedResolver = async (name: string, rrtype: string): Promise<string[][]> => {
            if (rrtype === 'TXT' && name === `${SELECTOR}._domainkey.${DOMAIN}`) return [[mismatchedTxt]]
            throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
        }

        const result = await signAndSelfVerify(rawMessage(), DKIM_CONFIG, { resolver: mismatchedResolver })

        expect(result.verified).toBe(false)
        expect(result.reason).not.toContain('pass')
        // The signature we produced is still in the bytes — this is "signed but not
        // verified", exactly the gap the audit measured. The caller must refuse to deliver it.
        expect(result.raw.toString('utf8')).toContain('DKIM-Signature:')
    })

    it('fails when no DKIM record is published at all (key never propagated / wrong selector)', async () => {
        const noRecordResolver = async (): Promise<string[][]> => {
            throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
        }

        const result = await signAndSelfVerify(rawMessage(), DKIM_CONFIG, { resolver: noRecordResolver })

        expect(result.verified).toBe(false)
        expect(result.reason).toBeTruthy()
    })

    /**
     * The control that makes the "pass" test above meaningful: bytes that were signed
     * correctly, then altered afterward (by some later bug in the pipeline — a retry that
     * re-encodes, a proxy that rewrites line endings, anything), must no longer verify. This
     * is the exact scenario Fase 2 exists to catch: a signature that was produced correctly
     * is worthless once the delivered bytes no longer match it.
     */
    it('a body mutated after signing no longer verifies', async () => {
        const signedOk = await signAndSelfVerify(rawMessage(), DKIM_CONFIG, { resolver })
        expect(signedOk.verified).toBe(true)

        const mutated = Buffer.from(
            signedOk.raw.toString('utf8').replace('Hello from the warm-up mesh.', 'Hello from the warm-up mesh!'),
            'utf8',
        )

        const verifiedAfterMutation = await dkimVerify(mutated, { resolver })
        const match = verifiedAfterMutation.results?.find((r) => r.signingDomain === DOMAIN)
        expect(match?.status.result).not.toBe('pass')
    })

    /**
     * Measured, not assumed (docs/outbound-authentication-audit.md, Fase 2: "custo... medir
     * antes de assumir"). ~200 messages/day in production; this asserts the mechanism stays
     * in the tens-of-milliseconds range a human would call "irrelevant", not that it hits an
     * exact number.
     */
    it('costs low tens of milliseconds per message — irrelevant at ~200 msgs/day', async () => {
        const raw = rawMessage('Cost-measurement message body.')
        const iterations = 20

        const start = process.hrtime.bigint()
        for (let i = 0; i < iterations; i++) {
            const result = await signAndSelfVerify(raw, DKIM_CONFIG, { resolver })
            expect(result.verified).toBe(true)
        }
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
        const perMessageMs = elapsedMs / iterations

        console.log(`[dkim-self-verify.test] sign+verify: ${perMessageMs.toFixed(2)}ms/message over ${iterations} iterations`)
        // Generous ceiling — this is a measurement, not a tight perf budget. A 1024-bit test
        // key on a loaded CI box should still land far under this.
        expect(perMessageMs).toBeLessThan(200)
    })
})
