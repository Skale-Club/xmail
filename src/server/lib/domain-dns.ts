/**
 * Domain DNS configuration and verification, shared by the human domain routes
 * (routes/domains.ts) and the microsite provisioning API. Kept free of any database import so
 * both callers (and their tests) can use it without opening a connection.
 */
import { generateKeyPairSync } from 'node:crypto'
import type { domains } from '../../db/schema'
import { resolveMx, resolveTxt, resolveCname } from './dns-resolver'
import { isAcceptableSpf, SPF_REQUIREMENT_MESSAGE, MAIL_HOST, RECOMMENDED_SPF_RECORD } from './spf-policy'

export type DomainRow = typeof domains.$inferSelect

// One constant for the verification-TXT label. The value is kept: changing it would invalidate
// every already-published TXT record.
export const VERIFICATION_TXT_PREFIX = 'skaleclub-verification'

// Matches the `dkim_selector` column default in src/db/schema.ts.
export const DEFAULT_DKIM_SELECTOR = 'skaleclub'

// Return-Path CNAME target (MAIL_DOMAIN is the apex the platform sends as, e.g. skale.club).
const RETURN_PATH_BASE_DOMAIN = process.env.MAIL_DOMAIN || 'skale.club'
export const RETURN_PATH_TARGET = `rp.${RETURN_PATH_BASE_DOMAIN}`

export interface DnsRecordSpec {
    type: 'TXT' | 'MX' | 'CNAME'
    name: string
    value: string | null
    priority?: number
}

export interface DomainDnsRecords {
    verification: DnsRecordSpec
    spf: DnsRecordSpec
    dkim: DnsRecordSpec
    dmarc: DnsRecordSpec
    mx: DnsRecordSpec
    returnPath: DnsRecordSpec
}

type DnsSource = Pick<DomainRow, 'name' | 'dkimSelector' | 'dkimPublicKey' | 'verificationToken'>

/** Strip PEM headers/whitespace to get the base64 body for a DKIM TXT `p=` value. */
export function dkimPublicKeyToDnsValue(pem: string): string {
    return pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
}

export function generateDkimKeyPair(): { privateKey: string; publicKey: string } {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    return { privateKey, publicKey }
}

/** DNS records an admin must publish for a domain, built from the values verification checks. */
export function buildDnsRecords(domain: DnsSource): DomainDnsRecords {
    const selector = domain.dkimSelector || DEFAULT_DKIM_SELECTOR

    return {
        verification: {
            type: 'TXT',
            name: '@',
            value: domain.verificationToken ? `${VERIFICATION_TXT_PREFIX}:${domain.verificationToken}` : null,
        },
        spf: { type: 'TXT', name: '@', value: RECOMMENDED_SPF_RECORD },
        dkim: {
            type: 'TXT',
            name: `${selector}._domainkey.${domain.name}`,
            value: domain.dkimPublicKey ? `v=DKIM1; k=rsa; p=${dkimPublicKeyToDnsValue(domain.dkimPublicKey)}` : null,
        },
        dmarc: {
            type: 'TXT',
            name: `_dmarc.${domain.name}`,
            value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain.name}`,
        },
        mx: { type: 'MX', name: '@', value: MAIL_HOST, priority: 10 },
        returnPath: { type: 'CNAME', name: `rp.${domain.name}`, value: RETURN_PATH_TARGET },
    }
}

export interface DomainVerificationUpdate {
    verificationStatus: 'verified' | 'failed'
    verifiedAt: Date | null
    spfStatus: string
    spfError: string | null
    dkimStatus: string
    dkimError: string | null
    dmarcStatus: string
    dmarcError: string | null
    mxStatus: string
    mxError: string | null
    returnPathStatus: string
    returnPathError: string | null
}

export interface DomainVerificationOutcome {
    update: DomainVerificationUpdate
    dnsResults: {
        verification: { found: boolean }
        spf: { found: boolean; error: string | null }
        dkim: { found: boolean; error: string | null }
        dmarc: { found: boolean; error: string | null }
        mx: { found: boolean; error: string | null }
        returnPath: { found: boolean; error: string | null }
    }
}

/**
 * Resolve the live DNS for a domain and compute the verification columns. Performs DNS lookups
 * only; the caller decides whether and how to persist `update`.
 */
export async function checkDomainDns(domain: DnsSource): Promise<DomainVerificationOutcome> {
    const domainName = domain.name
    const expectedToken = buildDnsRecords(domain).verification.value
    const dkimSelector = domain.dkimSelector || DEFAULT_DKIM_SELECTOR

    const [rootTxt, dkimTxt, dmarcTxt, mxRecords, returnPathCname] = await Promise.all([
        resolveTxt(domainName),
        resolveTxt(`${dkimSelector}._domainkey.${domainName}`),
        resolveTxt(`_dmarc.${domainName}`),
        resolveMx(domainName),
        resolveCname(`rp.${domainName}`),
    ])

    const verificationFound = rootTxt.some((r) => r === expectedToken)
    const verificationStatus = verificationFound ? 'verified' as const : 'failed' as const

    const spfFound = rootTxt.some(isAcceptableSpf)
    const spfError = spfFound ? null : SPF_REQUIREMENT_MESSAGE

    const dkimFound = dkimTxt.length > 0 && dkimTxt.some((r) => r.startsWith('v=DKIM1'))
    const dkimError = dkimFound ? null : 'DKIM record not found'

    const dmarcFound = dmarcTxt.some((r) => r.startsWith('v=DMARC1'))
    const dmarcError = dmarcFound ? null : 'DMARC record not found'

    const mxFound = mxRecords.some((r) => r.exchange.toLowerCase() === MAIL_HOST.toLowerCase())
    const mxError = mxFound ? null : `MX record not found or does not point to ${MAIL_HOST}`

    const returnPathFound = returnPathCname.some((r) => r.toLowerCase() === RETURN_PATH_TARGET)
    const returnPathError = returnPathFound
        ? null
        : `Return-Path CNAME not found (expected rp.${domainName} → ${RETURN_PATH_TARGET})`

    const allVerified = verificationFound && spfFound && dkimFound && dmarcFound && mxFound && returnPathFound

    return {
        update: {
            verificationStatus,
            verifiedAt: allVerified ? new Date() : null,
            spfStatus: spfFound ? 'verified' : 'failed',
            spfError,
            dkimStatus: dkimFound ? 'verified' : 'failed',
            dkimError,
            dmarcStatus: dmarcFound ? 'verified' : 'failed',
            dmarcError,
            mxStatus: mxFound ? 'verified' : 'failed',
            mxError,
            returnPathStatus: returnPathFound ? 'verified' : 'failed',
            returnPathError,
        },
        dnsResults: {
            verification: { found: verificationFound },
            spf: { found: spfFound, error: spfError },
            dkim: { found: dkimFound, error: dkimError },
            dmarc: { found: dmarcFound, error: dmarcError },
            mx: { found: mxFound, error: mxError },
            returnPath: { found: returnPathFound, error: returnPathError },
        },
    }
}
