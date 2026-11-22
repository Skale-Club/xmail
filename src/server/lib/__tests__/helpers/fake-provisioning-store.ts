import type {
    DomainLookup,
    DomainRecord,
    MailboxState,
    ProvisioningAuditEntry,
    ProvisioningStore,
} from '../../microsite-provisioning'
import type { DomainVerificationUpdate } from '../../domain-dns'

/**
 * In-memory ProvisioningStore. Atomic per call like the real one (the drizzle store gets its
 * atomicity from an advisory lock plus unique indexes). Records every write so tests can prove
 * that read-only operations wrote nothing.
 */
export class FakeProvisioningStore implements ProvisioningStore {
    domains = new Map<string, DomainRecord>()
    sites = new Map<string, string>()
    mailboxes = new Map<string, MailboxState & { delegates: string[] }>()
    foreignDomains = new Set<string>()
    audits: ProvisioningAuditEntry[] = []
    protectedDomains = new Set<string>()
    writes: string[] = []
    keyGenerations = 0
    ensureDomainDelayMs = 0

    async lookupDomain(name: string, organizationId: string): Promise<DomainLookup> {
        if (this.foreignDomains.has(name)) return { kind: 'foreign' }
        const domain = this.domains.get(name)
        if (!domain) return { kind: 'none' }
        if (domain.organizationId !== organizationId) return { kind: 'foreign' }
        return { kind: 'own', domain, siteRef: this.sites.get(name) ?? null }
    }

    async ensureDomain(input: { name: string; organizationId: string; siteRef: string }) {
        if (this.foreignDomains.has(input.name)) return { kind: 'foreign' as const }
        // Yield so concurrent callers interleave; the check-and-insert below is one atomic step.
        if (this.ensureDomainDelayMs) await new Promise((r) => setTimeout(r, this.ensureDomainDelayMs))
        let domain = this.domains.get(input.name)
        let created = false
        if (!domain) {
            this.keyGenerations += 1
            domain = {
                id: `dom-${this.domains.size + 1}`,
                organizationId: input.organizationId,
                name: input.name,
                verificationToken: 'token-123',
                dkimSelector: 'skaleclub',
                dkimPublicKey: '-----BEGIN PUBLIC KEY-----\nQUJD\n-----END PUBLIC KEY-----',
                verificationStatus: 'pending',
                mxStatus: 'pending',
                spfStatus: 'pending',
                dkimStatus: 'pending',
                dmarcStatus: 'pending',
            }
            this.domains.set(input.name, domain)
            created = true
            this.writes.push('domain.insert')
        }
        this.sites.set(input.name, input.siteRef)
        this.writes.push('site.upsert')
        return { kind: 'ok' as const, domain, created }
    }

    async ensureMailbox(input: { domain: DomainRecord; address: string; organizationId: string; delegateUserIds: string[] }) {
        const existing = this.mailboxes.get(input.address)
        const mailbox = existing ?? { mailboxId: `mbx-${this.mailboxes.size + 1}`, isActive: true, lastInboundAt: null, messageCount: 0, delegates: [] }
        mailbox.delegates = [...input.delegateUserIds]
        this.mailboxes.set(input.address, mailbox)
        this.writes.push('mailbox.ensure')
        return { mailboxId: mailbox.mailboxId, created: !existing, delegatesGranted: input.delegateUserIds.length, delegatesSkipped: 0 }
    }

    async readMailboxState(address: string): Promise<MailboxState | null> {
        const m = this.mailboxes.get(address)
        return m ? { mailboxId: m.mailboxId, isActive: m.isActive, lastInboundAt: m.lastInboundAt, messageCount: m.messageCount } : null
    }

    async saveVerification(domainId: string, update: DomainVerificationUpdate) {
        const domain = [...this.domains.values()].find((d) => d.id === domainId)
        if (!domain) throw new Error('missing domain')
        Object.assign(domain, {
            verificationStatus: update.verificationStatus,
            mxStatus: update.mxStatus,
            spfStatus: update.spfStatus,
            dkimStatus: update.dkimStatus,
            dmarcStatus: update.dmarcStatus,
        })
        this.writes.push('domain.verification')
        return domain
    }

    registerProtectedDomain(name: string) {
        this.protectedDomains.add(name)
    }

    async audit(entry: ProvisioningAuditEntry) {
        this.audits.push(entry)
    }
}

export const TEST_CONFIG = {
    apiKey: 'test-key-abcdefghijklmnop',
    organizationId: '11111111-1111-4111-8111-111111111111',
    delegateUserIds: ['22222222-2222-4222-8222-222222222222'],
}

export function verifiedUpdate(overrides: Partial<DomainVerificationUpdate> = {}): DomainVerificationUpdate {
    return {
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        spfStatus: 'verified', spfError: null,
        dkimStatus: 'verified', dkimError: null,
        dmarcStatus: 'verified', dmarcError: null,
        mxStatus: 'verified', mxError: null,
        returnPathStatus: 'verified', returnPathError: null,
        ...overrides,
    }
}
