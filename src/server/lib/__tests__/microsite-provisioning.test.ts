import { beforeEach, describe, expect, it } from 'vitest'
import {
    ProvisioningError,
    ensureDomain,
    ensureInfoMailbox,
    getDomainStatus,
    isProtectedDomain,
    isValidDomainName,
    resolveProvisioningConfig,
    verifyDomain,
} from '../microsite-provisioning'
import { FakeProvisioningStore, TEST_CONFIG, verifiedUpdate } from './helpers/fake-provisioning-store'

const ENV = { MAIL_DOMAIN: 'skale.club', OUTREACH_PROTECTED_DOMAINS: 'xkedule.com,xphere.app', MAIL_HOST: 'mx.skale.club' }
const SITE = 'websites:tenant:27'

async function code(promise: Promise<unknown>): Promise<string> {
    try { await promise } catch (e) { return e instanceof ProvisioningError ? e.code : 'unexpected' }
    return 'no_error'
}

describe('resolveProvisioningConfig (fail closed)', () => {
    const org = '11111111-1111-4111-8111-111111111111'
    it('is null unless key and org are both set', () => {
        expect(resolveProvisioningConfig({})).toBeNull()
        expect(resolveProvisioningConfig({ XMAIL_PROVISIONING_API_KEY: 'k' })).toBeNull()
        expect(resolveProvisioningConfig({ XMAIL_PROVISIONING_ORG_ID: org })).toBeNull()
        expect(resolveProvisioningConfig({ XMAIL_PROVISIONING_API_KEY: 'k', XMAIL_PROVISIONING_ORG_ID: 'not-a-uuid' })).toBeNull()
        expect(resolveProvisioningConfig({ XMAIL_PROVISIONING_API_KEY: '  ', XMAIL_PROVISIONING_ORG_ID: org })).toBeNull()
    })
    it('parses delegates, dropping invalid and duplicate ids', () => {
        const d = '22222222-2222-4222-8222-222222222222'
        const cfg = resolveProvisioningConfig({
            XMAIL_PROVISIONING_API_KEY: 'k', XMAIL_PROVISIONING_ORG_ID: org,
            XMAIL_PROVISIONING_DELEGATE_USER_IDS: `${d}, bogus ,${d.toUpperCase()}`,
        })
        expect(cfg?.delegateUserIds).toEqual([d])
    })
})

describe('domain validation and protection', () => {
    it('accepts only lowercase hostnames', () => {
        expect(isValidDomainName('example.com')).toBe(true)
        expect(isValidDomainName('Example.com')).toBe(false)
        expect(isValidDomainName('nodot')).toBe(false)
        expect(isValidDomainName('a b.com')).toBe(false)
        expect(isValidDomainName('-a.com')).toBe(false)
        expect(isValidDomainName('1.2.3.4')).toBe(false)
        expect(isValidDomainName('x'.repeat(64) + '.com')).toBe(false)
        expect(isValidDomainName('exa_mple.com')).toBe(false)
    })
    it('protects the mail domain, operation domains, skale.club and every subdomain', () => {
        for (const d of ['skale.club', 'mail.skale.club', 'x.staging.skale.club', 'xkedule.com', 'www.xphere.app', 'mx.skale.club']) {
            expect(isProtectedDomain(d, ENV), d).toBe(true)
        }
        expect(isProtectedDomain('notskale.club', ENV)).toBe(false)
        expect(isProtectedDomain('plumber-example.com', ENV)).toBe(false)
    })
})

describe('provisioning operations', () => {
    let store: FakeProvisioningStore
    beforeEach(() => { store = new FakeProvisioningStore() })

    it('rejects invalid and protected domains before touching the store', async () => {
        expect(await code(ensureDomain(store, TEST_CONFIG, 'BAD', SITE, ENV))).toBe('invalid_domain')
        expect(await code(ensureDomain(store, TEST_CONFIG, 'staging.skale.club', SITE, ENV))).toBe('protected_domain')
        expect(await code(ensureInfoMailbox(store, TEST_CONFIG, 'xkedule.com', SITE, ENV))).toBe('protected_domain')
        expect(await code(getDomainStatus(store, TEST_CONFIG, 'skale.club', ENV))).toBe('protected_domain')
        expect(store.writes).toEqual([])
    })

    it('reports a domain that belongs to another organization without revealing which', async () => {
        store.foreignDomains.add('taken.com')
        expect(await code(getDomainStatus(store, TEST_CONFIG, 'taken.com', ENV))).toBe('domain_owned_elsewhere')
        expect(await code(ensureDomain(store, TEST_CONFIG, 'taken.com', SITE, ENV))).toBe('domain_owned_elsewhere')
        expect(await code(ensureInfoMailbox(store, TEST_CONFIG, 'taken.com', SITE, ENV))).toBe('domain_owned_elsewhere')
        expect(await code(verifyDomain(store, TEST_CONFIG, 'taken.com', async () => verifiedUpdate(), ENV))).toBe('domain_owned_elsewhere')
        expect(store.writes).toEqual([])
        expect(store.audits.every((a) => a.outcome === 'denied')).toBe(true)
    })

    it('ensureDomain is idempotent: created first, then created=false, keys generated once', async () => {
        const first = await ensureDomain(store, TEST_CONFIG, 'acme-plumbing.com', SITE, ENV)
        const second = await ensureDomain(store, TEST_CONFIG, 'acme-plumbing.com', SITE, ENV)
        expect(first.created).toBe(true)
        expect(second.created).toBe(false)
        expect(store.keyGenerations).toBe(1)
        expect(store.domains.size).toBe(1)
        expect(first.status.state).toBe('not_provisioned')
        expect(store.protectedDomains.has('acme-plumbing.com')).toBe(true)
    })

    it('concurrent ensure calls converge on one row and one creation', async () => {
        store.ensureDomainDelayMs = 5
        const results = await Promise.all(
            Array.from({ length: 6 }, () => ensureDomain(store, TEST_CONFIG, 'acme-plumbing.com', SITE, ENV)),
        )
        expect(results.filter((r) => r.created)).toHaveLength(1)
        expect(store.domains.size).toBe(1)
        expect(store.keyGenerations).toBe(1)
    })

    it('rejects a missing or malformed siteRef', async () => {
        expect(await code(ensureDomain(store, TEST_CONFIG, 'acme-plumbing.com', undefined, ENV))).toBe('invalid_site_ref')
        expect(await code(ensureDomain(store, TEST_CONFIG, 'acme-plumbing.com', 'has space', ENV))).toBe('invalid_site_ref')
    })

    it('one mailbox call ensures the domain too, returns the full status, and is repeatable', async () => {
        const first = await ensureInfoMailbox(store, TEST_CONFIG, 'acme-plumbing.com', SITE, ENV)
        expect(first.created).toBe(true)
        expect(first.domainCreated).toBe(true)
        expect(first.status.mailbox.address).toBe('info@acme-plumbing.com')
        expect(first.status.mailbox.exists).toBe(true)
        expect(first.status.state).toBe('dns_pending')
        expect(first.status.dnsRecords.length).toBeGreaterThan(0)

        // Repeat without a siteRef: the stored one is reused, nothing is created again.
        const again = await ensureInfoMailbox(store, TEST_CONFIG, 'acme-plumbing.com', undefined, ENV)
        expect(again.created).toBe(false)
        expect(again.domainCreated).toBe(false)
        expect(store.keyGenerations).toBe(1)
        expect(store.mailboxes.size).toBe(1)
        expect(store.mailboxes.get('info@acme-plumbing.com')?.delegates).toEqual(TEST_CONFIG.delegateUserIds)
        expect(store.audits.at(-1)).toMatchObject({ action: 'ensure_mailbox', outcome: 'success', siteRef: SITE })
    })

    it('concurrent single-call provisioning converges on one domain and one mailbox', async () => {
        store.ensureDomainDelayMs = 5
        const results = await Promise.all(
            Array.from({ length: 5 }, () => ensureInfoMailbox(store, TEST_CONFIG, 'acme-plumbing.com', SITE, ENV)),
        )
        expect(results.filter((r) => r.domainCreated)).toHaveLength(1)
        expect(store.domains.size).toBe(1)
        expect(store.mailboxes.size).toBe(1)
    })

    it('registers the domain with the sending guards before creating the mailbox', async () => {
        await ensureInfoMailbox(store, TEST_CONFIG, 'acme-plumbing.com', SITE, ENV)
        expect(store.protectedDomains.has('acme-plumbing.com')).toBe(true)
    })

    it('walks the state machine and only reports ready after DNS plus a real inbound message', async () => {
        await ensureInfoMailbox(store, TEST_CONFIG, 'acme-plumbing.com', SITE, ENV)
        let status = await getDomainStatus(store, TEST_CONFIG, 'acme-plumbing.com', ENV)
        expect(status.state).toBe('dns_pending')
        expect(status.ready).toBe(false)

        status = await verifyDomain(store, TEST_CONFIG, 'acme-plumbing.com', async () => verifiedUpdate(), ENV)
        expect(status.state).toBe('inbound_pending')
        expect(status.verification).toMatchObject({ status: 'verified', mx: 'verified', spf: 'verified', dkim: 'verified' })
        expect(status.ready).toBe(false)

        const mailbox = store.mailboxes.get('info@acme-plumbing.com')!
        mailbox.messageCount = 1
        mailbox.lastInboundAt = new Date('2026-11-20T10:00:00Z')
        status = await getDomainStatus(store, TEST_CONFIG, 'acme-plumbing.com', ENV)
        expect(status.state).toBe('ready')
        expect(status.ready).toBe(true)
        expect(status.mailbox.lastInboundAt).toBe('2026-11-20T10:00:00.000Z')

        mailbox.isActive = false
        status = await getDomainStatus(store, TEST_CONFIG, 'acme-plumbing.com', ENV)
        expect(status.state).toBe('suspended')
        expect(status.ready).toBe(false)
    })

    it('does not report ready when inbound exists but DNS is not verified', async () => {
        await ensureInfoMailbox(store, TEST_CONFIG, 'acme-plumbing.com', SITE, ENV)
        store.mailboxes.get('info@acme-plumbing.com')!.messageCount = 3
        const status = await getDomainStatus(store, TEST_CONFIG, 'acme-plumbing.com', ENV)
        expect(status.ready).toBe(false)
        expect(status.state).toBe('dns_pending')
    })

    it('status exposes public DNS values only, never the DKIM private key or a mailbox credential', async () => {
        const { status } = await ensureInfoMailbox(store, TEST_CONFIG, 'acme-plumbing.com', SITE, ENV)
        const json = JSON.stringify(status)
        expect(json).not.toMatch(/PRIVATE|password|secret/i)
        const purposes = status.dnsRecords.map((r) => r.purpose)
        expect(purposes).toEqual(expect.arrayContaining(['ownership', 'mx', 'spf', 'dkim']))
        expect(status.dnsRecords.find((r) => r.purpose === 'dkim')?.name).toBe('skaleclub._domainkey.acme-plumbing.com')
        expect(status.dnsRecords.find((r) => r.purpose === 'mx')?.required).toBe(true)
        expect(status.dnsRecords.find((r) => r.purpose === 'dmarc')?.required).toBe(false)
    })

    it('GET is strictly read-only: no writes, no key generation, no audit', async () => {
        await ensureInfoMailbox(store, TEST_CONFIG, 'acme-plumbing.com', SITE, ENV)
        const writesBefore = [...store.writes]
        const keysBefore = store.keyGenerations
        const auditsBefore = store.audits.length
        await getDomainStatus(store, TEST_CONFIG, 'acme-plumbing.com', ENV)
        await getDomainStatus(store, TEST_CONFIG, 'acme-plumbing.com', ENV)
        expect(store.writes).toEqual(writesBefore)
        expect(store.keyGenerations).toBe(keysBefore)
        expect(store.audits).toHaveLength(auditsBefore)
        expect(await code(getDomainStatus(store, TEST_CONFIG, 'unknown-site.com', ENV))).toBe('domain_not_found')
        expect(store.domains.has('unknown-site.com')).toBe(false)
    })

    it('verify writes only verification columns and audits', async () => {
        await ensureDomain(store, TEST_CONFIG, 'acme-plumbing.com', SITE, ENV)
        store.writes.length = 0
        await verifyDomain(store, TEST_CONFIG, 'acme-plumbing.com', async () => verifiedUpdate({ mxStatus: 'failed' }), ENV)
        expect(store.writes).toEqual(['domain.verification'])
        expect(store.audits.at(-1)).toMatchObject({ action: 'verify_domain', siteRef: SITE })
        expect(await code(verifyDomain(store, TEST_CONFIG, 'nope.com', async () => verifiedUpdate(), ENV))).toBe('domain_not_found')
    })
})
