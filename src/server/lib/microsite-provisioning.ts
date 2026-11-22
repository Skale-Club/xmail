/**
 * Microsite mailbox provisioning: the domain logic behind /api/provisioning/v1.
 *
 * The Skale Club Websites platform calls this server-to-server so that `info@<domain>` works for
 * each owned microsite. Everything here is bound to ONE Xmail organization taken from the
 * environment; callers never choose an organization. Database access goes through the
 * `ProvisioningStore` interface so the rules are testable with an in-memory fake; the drizzle
 * implementation lives in microsite-provisioning-store.ts.
 *
 * Product decision (owner D-015): info@ is a full native mailbox per domain, owned by a dedicated
 * mailbox user with no password, readable in webmail by designated delegate users.
 */
import { buildDnsRecords, type DomainVerificationUpdate } from './domain-dns'
import { getOperationDomains } from './operation-domains'

// ----------------------------------------------------------------------------
// Configuration (fail closed)
// ----------------------------------------------------------------------------

export interface ProvisioningConfig {
    apiKey: string
    organizationId: string
    delegateUserIds: string[]
}

type EnvLike = Record<string, string | undefined>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Null (feature disabled, every route answers 503) unless the key AND the bound org are set. */
export function resolveProvisioningConfig(env: EnvLike = process.env): ProvisioningConfig | null {
    const apiKey = env.XMAIL_PROVISIONING_API_KEY?.trim()
    const organizationId = env.XMAIL_PROVISIONING_ORG_ID?.trim()
    if (!apiKey || !organizationId || !UUID_RE.test(organizationId)) return null
    const delegateUserIds = (env.XMAIL_PROVISIONING_DELEGATE_USER_IDS ?? '')
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter((id) => UUID_RE.test(id))
    return { apiKey, organizationId: organizationId.toLowerCase(), delegateUserIds: [...new Set(delegateUserIds)] }
}

// ----------------------------------------------------------------------------
// Domain validation
// ----------------------------------------------------------------------------

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** Lowercase hostname with at least two labels and a non-numeric TLD. */
export function isValidDomainName(value: string): boolean {
    if (typeof value !== 'string' || value.length < 3 || value.length > 253) return false
    if (value !== value.toLowerCase()) return false
    const labels = value.split('.')
    if (labels.length < 2) return false
    if (!labels.every((label) => LABEL_RE.test(label))) return false
    return !/^[0-9]+$/.test(labels[labels.length - 1])
}

const ALWAYS_PROTECTED = ['skale.club']

/**
 * Domains this API must never touch: the platform's own mail domain, the operation's domains
 * (OUTREACH_PROTECTED_DOMAINS) and skale.club including every subdomain (staging hosts too).
 */
export function isProtectedDomain(domain: string, env: EnvLike = process.env): boolean {
    const protectedSet = new Set([...ALWAYS_PROTECTED, ...getOperationDomains(env)])
    const mailHost = env.MAIL_HOST?.trim().toLowerCase()
    if (mailHost) protectedSet.add(mailHost)
    for (const entry of protectedSet) {
        if (domain === entry || domain.endsWith(`.${entry}`)) return true
    }
    return false
}

const SITE_REF_RE = /^[A-Za-z0-9:_\-./]{1,200}$/

export function isValidSiteRef(value: unknown): value is string {
    return typeof value === 'string' && SITE_REF_RE.test(value)
}

// ----------------------------------------------------------------------------
// Store interface
// ----------------------------------------------------------------------------

export interface DomainRecord {
    id: string
    organizationId: string
    name: string
    verificationToken: string | null
    dkimSelector: string | null
    dkimPublicKey: string | null
    verificationStatus: string
    mxStatus: string | null
    spfStatus: string | null
    dkimStatus: string | null
    dmarcStatus: string | null
}

export type DomainLookup =
    | { kind: 'none' }
    | { kind: 'own'; domain: DomainRecord; siteRef: string | null }
    | { kind: 'foreign' }

export interface MailboxState {
    mailboxId: string
    isActive: boolean
    lastInboundAt: Date | null
    messageCount: number
}

export interface ProvisioningAuditEntry {
    action: string
    domain: string
    siteRef: string | null
    outcome: 'success' | 'denied' | 'failed'
    detail?: Record<string, unknown>
}

export interface ProvisioningStore {
    /** Read-only lookup. Must never write or generate key material. */
    lookupDomain(name: string, organizationId: string): Promise<DomainLookup>
    /**
     * Atomically ensure the domain exists in the bound org (one row, DKIM keys generated exactly
     * once) and that the microsite record carries `siteRef`. Concurrent calls converge.
     */
    ensureDomain(input: { name: string; organizationId: string; siteRef: string }): Promise<
        { kind: 'foreign' } | { kind: 'ok'; domain: DomainRecord; created: boolean }
    >
    /** Ensure the mailbox user, org membership, native mailbox, folders and delegate grants. */
    ensureMailbox(input: {
        domain: DomainRecord
        address: string
        organizationId: string
        delegateUserIds: string[]
    }): Promise<{ mailboxId: string; created: boolean; delegatesGranted: number; delegatesSkipped: number }>
    readMailboxState(address: string): Promise<MailboxState | null>
    saveVerification(domainId: string, update: DomainVerificationUpdate): Promise<DomainRecord>
    /** Reload the in-memory protected-domain set the sending guards read. */
    registerProtectedDomain(name: string): void
    audit(entry: ProvisioningAuditEntry): Promise<void>
}

// ----------------------------------------------------------------------------
// Status
// ----------------------------------------------------------------------------

export type ProvisioningState = 'not_provisioned' | 'dns_pending' | 'inbound_pending' | 'ready' | 'suspended'

export interface DnsRecordStatus {
    type: 'TXT' | 'MX' | 'CNAME'
    name: string
    value: string
    purpose: 'ownership' | 'mx' | 'spf' | 'dkim' | 'dmarc' | 'return_path'
    required: boolean
    priority?: number
}

export interface ProvisioningStatus {
    domain: string
    state: ProvisioningState
    verification: { status: string; mx: string; spf: string; dkim: string; dmarc: string }
    dnsRecords: DnsRecordStatus[]
    mailbox: {
        address: string
        exists: boolean
        mailboxRef: string | null
        lastInboundAt: string | null
        messageCount: number
    }
    ready: boolean
}

export const INFO_LOCAL_PART = 'info'

export function infoAddress(domain: string): string {
    return `${INFO_LOCAL_PART}@${domain}`
}

/** DNS the domain needs to receive and authenticate mail. DMARC and Return-Path are advisory. */
export function isDnsVerified(domain: Pick<DomainRecord, 'verificationStatus' | 'mxStatus' | 'spfStatus' | 'dkimStatus'>): boolean {
    return domain.verificationStatus === 'verified'
        && domain.mxStatus === 'verified'
        && domain.spfStatus === 'verified'
        && domain.dkimStatus === 'verified'
}

export function buildStatus(domain: DomainRecord, mailbox: MailboxState | null): ProvisioningStatus {
    const records = buildDnsRecords(domain)
    const dnsRecords: DnsRecordStatus[] = []
    const push = (
        purpose: DnsRecordStatus['purpose'],
        required: boolean,
        spec: { type: 'TXT' | 'MX' | 'CNAME'; name: string; value: string | null; priority?: number },
    ) => {
        if (!spec.value) return
        dnsRecords.push({
            type: spec.type,
            name: spec.name,
            value: spec.value,
            purpose,
            required,
            ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
        })
    }
    push('ownership', true, records.verification)
    push('mx', true, records.mx)
    push('spf', true, records.spf)
    push('dkim', true, records.dkim)
    push('dmarc', false, records.dmarc)
    push('return_path', false, records.returnPath)

    const dnsOk = isDnsVerified(domain)
    const exists = mailbox !== null
    const hasInbound = exists && mailbox.messageCount > 0

    let state: ProvisioningState
    if (!exists) state = 'not_provisioned'
    else if (!mailbox.isActive) state = 'suspended'
    else if (!dnsOk) state = 'dns_pending'
    else if (!hasInbound) state = 'inbound_pending'
    else state = 'ready'

    return {
        domain: domain.name,
        state,
        verification: {
            status: domain.verificationStatus,
            mx: domain.mxStatus ?? 'pending',
            spf: domain.spfStatus ?? 'pending',
            dkim: domain.dkimStatus ?? 'pending',
            dmarc: domain.dmarcStatus ?? 'pending',
        },
        dnsRecords,
        mailbox: {
            address: infoAddress(domain.name),
            exists,
            mailboxRef: exists ? mailbox.mailboxId : null,
            lastInboundAt: exists && mailbox.lastInboundAt ? mailbox.lastInboundAt.toISOString() : null,
            messageCount: exists ? mailbox.messageCount : 0,
        },
        ready: state === 'ready',
    }
}

// ----------------------------------------------------------------------------
// Operations
// ----------------------------------------------------------------------------

export class ProvisioningError extends Error {
    constructor(public readonly status: number, public readonly code: string) {
        super(code)
    }
}

/** Shared pre-flight: validity, protection. Throws ProvisioningError. */
export function assertProvisionableDomain(domain: string, env: EnvLike = process.env): void {
    if (!isValidDomainName(domain)) throw new ProvisioningError(400, 'invalid_domain')
    if (isProtectedDomain(domain, env)) throw new ProvisioningError(403, 'protected_domain')
}

async function readStatus(store: ProvisioningStore, domain: DomainRecord): Promise<ProvisioningStatus> {
    const mailbox = await store.readMailboxState(infoAddress(domain.name))
    return buildStatus(domain, mailbox)
}

/** Strictly read-only. */
export async function getDomainStatus(
    store: ProvisioningStore,
    config: ProvisioningConfig,
    domain: string,
    env: EnvLike = process.env,
): Promise<ProvisioningStatus> {
    assertProvisionableDomain(domain, env)
    const found = await store.lookupDomain(domain, config.organizationId)
    if (found.kind === 'foreign') throw new ProvisioningError(409, 'domain_owned_elsewhere')
    if (found.kind === 'none') throw new ProvisioningError(404, 'domain_not_found')
    return readStatus(store, found.domain)
}

export async function ensureDomain(
    store: ProvisioningStore,
    config: ProvisioningConfig,
    domain: string,
    siteRef: unknown,
    env: EnvLike = process.env,
): Promise<{ created: boolean; status: ProvisioningStatus }> {
    assertProvisionableDomain(domain, env)
    if (!isValidSiteRef(siteRef)) throw new ProvisioningError(400, 'invalid_site_ref')

    const result = await store.ensureDomain({ name: domain, organizationId: config.organizationId, siteRef })
    if (result.kind === 'foreign') {
        await store.audit({ action: 'ensure_domain', domain, siteRef, outcome: 'denied', detail: { reason: 'domain_owned_elsewhere' } })
        throw new ProvisioningError(409, 'domain_owned_elsewhere')
    }
    store.registerProtectedDomain(domain)
    await store.audit({ action: 'ensure_domain', domain, siteRef, outcome: 'success', detail: { created: result.created } })
    return { created: result.created, status: await readStatus(store, result.domain) }
}

/**
 * Ensure info@<domain>. If the domain is not provisioned yet it is ensured in the same call
 * (needs `siteRef`), so one request can do the whole thing; a repeat call just re-asserts.
 */
export async function ensureInfoMailbox(
    store: ProvisioningStore,
    config: ProvisioningConfig,
    domain: string,
    siteRef: unknown,
    env: EnvLike = process.env,
): Promise<{ created: boolean; domainCreated: boolean; status: ProvisioningStatus }> {
    assertProvisionableDomain(domain, env)

    let domainCreated = false
    let record: DomainRecord
    const existing = await store.lookupDomain(domain, config.organizationId)
    if (existing.kind === 'foreign') {
        await store.audit({ action: 'ensure_mailbox', domain, siteRef: typeof siteRef === 'string' ? siteRef : null, outcome: 'denied', detail: { reason: 'domain_owned_elsewhere' } })
        throw new ProvisioningError(409, 'domain_owned_elsewhere')
    }
    let effectiveSiteRef: string
    if (existing.kind === 'own' && existing.siteRef) {
        record = existing.domain
        effectiveSiteRef = existing.siteRef
    } else {
        // Missing domain, or a domain row nobody has claimed for a site yet: ensure it now.
        if (!isValidSiteRef(siteRef)) throw new ProvisioningError(400, 'invalid_site_ref')
        const ensured = await store.ensureDomain({ name: domain, organizationId: config.organizationId, siteRef })
        if (ensured.kind === 'foreign') {
            await store.audit({ action: 'ensure_mailbox', domain, siteRef, outcome: 'denied', detail: { reason: 'domain_owned_elsewhere' } })
            throw new ProvisioningError(409, 'domain_owned_elsewhere')
        }
        record = ensured.domain
        domainCreated = ensured.created
        effectiveSiteRef = siteRef
    }
    // Guards first: from this point the address can never be a sender, even if a later step fails.
    store.registerProtectedDomain(domain)

    const mailbox = await store.ensureMailbox({
        domain: record,
        address: infoAddress(domain),
        organizationId: config.organizationId,
        delegateUserIds: config.delegateUserIds,
    })
    await store.audit({
        action: 'ensure_mailbox',
        domain,
        siteRef: effectiveSiteRef,
        outcome: 'success',
        detail: {
            mailboxCreated: mailbox.created,
            domainCreated,
            delegatesGranted: mailbox.delegatesGranted,
            delegatesSkipped: mailbox.delegatesSkipped,
        },
    })
    return { created: mailbox.created, domainCreated, status: await readStatus(store, record) }
}

export async function verifyDomain(
    store: ProvisioningStore,
    config: ProvisioningConfig,
    domain: string,
    checkDns: (domain: DomainRecord) => Promise<DomainVerificationUpdate>,
    env: EnvLike = process.env,
): Promise<ProvisioningStatus> {
    assertProvisionableDomain(domain, env)
    const found = await store.lookupDomain(domain, config.organizationId)
    if (found.kind === 'foreign') throw new ProvisioningError(409, 'domain_owned_elsewhere')
    if (found.kind === 'none') throw new ProvisioningError(404, 'domain_not_found')

    const update = await checkDns(found.domain)
    const saved = await store.saveVerification(found.domain.id, update)
    await store.audit({
        action: 'verify_domain',
        domain,
        siteRef: found.siteRef,
        outcome: 'success',
        detail: { verification: update.verificationStatus, mx: update.mxStatus, spf: update.spfStatus, dkim: update.dkimStatus },
    })
    return readStatus(store, saved)
}
