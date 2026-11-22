import { afterEach, describe, expect, it, vi } from 'vitest'

// native-mail pulls the database module at import time; the routing test below stubs it.
const queries = vi.hoisted(() => ({
    domain: vi.fn(),
    user: vi.fn(),
    domainList: vi.fn(async () => []),
}))
vi.mock('../../../db', () => ({
    db: { query: { domains: { findFirst: queries.domain, findMany: queries.domainList }, users: { findFirst: queries.user } } },
}))

import { checkProtectedSendingDomains, isCampaignSenderEligible } from '../sending-domain-guard'
import { findLocalUser } from '../native-mail'
import { addMicrositeProtectedDomain, isMicrositeMailAddress, setMicrositeProtectedDomains } from '../microsite-protected-domains'
import { classifyMailboxes } from '../../routes/mail/mailbox-organizations'
import { getOperationDomains } from '../operation-domains'
import { evaluateMailboxAccess } from '../mailbox-delegation'

afterEach(() => {
    setMicrositeProtectedDomains([])
    vi.clearAllMocks()
})

describe('microsite info@ is excluded from outreach and warm-up', () => {
    it('a provisioned microsite domain becomes a protected sending domain at runtime', () => {
        expect(checkProtectedSendingDomains([{ email: 'info@acme-plumbing.com' }])).toBeNull()
        addMicrositeProtectedDomain('acme-plumbing.com')
        const violation = checkProtectedSendingDomains([{ email: 'INFO@Acme-Plumbing.com' }])
        expect(violation?.code).toBe('protected_sending_domain')
    })

    it('is never an eligible campaign sender, and a Google/Icemail inbox still is', () => {
        setMicrositeProtectedDomains(['acme-plumbing.com'])
        expect(isCampaignSenderEligible({ email: 'info@acme-plumbing.com', status: 'verified', warmupOnly: false })).toBe(false)
        expect(isCampaignSenderEligible({ email: 'vanildo.jr@tryskaleclub.com', status: 'verified', warmupOnly: false })).toBe(true)
    })

    it('is recognized by the warm-up and email-account guards', () => {
        setMicrositeProtectedDomains(['acme-plumbing.com'])
        expect(isMicrositeMailAddress('info@acme-plumbing.com')).toBe(true)
        expect(isMicrositeMailAddress('contato@skale.club')).toBe(false)
        expect(isMicrositeMailAddress('not-an-address')).toBe(false)
    })
})

describe('inbound delivery routing', () => {
    const owner = { id: 'user-info-1', email: 'info@acme-plumbing.com', isAdmin: false }

    it('the MX path (findLocalUser) resolves info@ to the mailbox user once the domain is verified', async () => {
        queries.domain.mockResolvedValue({ name: 'acme-plumbing.com', verificationStatus: 'verified', organizationId: 'org-1' })
        queries.user.mockResolvedValue(owner)
        await expect(findLocalUser('info@acme-plumbing.com')).resolves.toEqual({ userId: 'user-info-1' })
    })

    it('does not accept mail while the domain is unverified', async () => {
        queries.domain.mockResolvedValue(undefined)
        await expect(findLocalUser('info@acme-plumbing.com')).resolves.toBeNull()
        expect(queries.user).not.toHaveBeenCalled()
    })
})

describe('grouping and isolation in the delegate webmail', () => {
    const operationDomains = getOperationDomains({ MAIL_DOMAIN: 'skale.club', OUTREACH_PROTECTED_DOMAINS: 'xkedule.com' })
    const delegate = 'owner-user'

    it('shows shared microsite mailboxes under the Microsites group, apart from personal mail', () => {
        const result = classifyMailboxes({
            requesterId: delegate,
            mailboxes: [
                { id: 'mine', userId: delegate, email: 'owner@personal.example' },
                { id: 'site-a', userId: 'info-a', email: 'info@acme-plumbing.com' },
                { id: 'site-b', userId: 'info-b', email: 'info@best-roofing.com' },
            ],
            memberships: [
                { userId: 'info-a', organizationName: 'Microsites' },
                { userId: 'info-b', organizationName: 'Microsites' },
            ],
            operationDomains,
        })
        expect(result.get('mine')).toMatchObject({ role: 'work', organizationName: null })
        for (const id of ['site-a', 'site-b']) {
            expect(result.get(id)).toMatchObject({ role: 'other', isOperationMailbox: false, organizationName: 'Microsites' })
        }
    })
})

describe('delegate access decision', () => {
    const delegate = { id: 'owner-user', isAdmin: false }
    const infoBox = { userId: 'info-a', email: 'info@acme-plumbing.com', isNative: true }
    const infoOwner = { email: 'info@acme-plumbing.com' }

    it('lets a delegate read the mailbox, but a non-delegate gets nothing', () => {
        expect(evaluateMailboxAccess({ requester: delegate, mailbox: infoBox, owner: infoOwner, isDelegate: true })).toBe('delegate')
        expect(evaluateMailboxAccess({ requester: delegate, mailbox: infoBox, owner: infoOwner, isDelegate: false })).toBeNull()
        expect(evaluateMailboxAccess({ requester: { id: 'stranger', isAdmin: false }, mailbox: infoBox, owner: infoOwner, isDelegate: false })).toBeNull()
    })

    it('never lets a delegate change the mailbox itself', () => {
        expect(evaluateMailboxAccess({ requester: delegate, mailbox: infoBox, owner: infoOwner, isDelegate: true, ownerOnly: true })).toBeNull()
    })

    it('keeps the owner and admin paths unchanged', () => {
        expect(evaluateMailboxAccess({ requester: { id: 'info-a', isAdmin: false }, mailbox: infoBox, owner: infoOwner, isDelegate: false })).toBe('owner')
        expect(evaluateMailboxAccess({ requester: { id: 'info-a', isAdmin: false }, mailbox: infoBox, owner: { email: 'other@x.com' }, isDelegate: false })).toBeNull()
        expect(evaluateMailboxAccess({ requester: { id: 'root', isAdmin: true }, mailbox: infoBox, owner: null, isDelegate: false })).toBe('admin')
    })

    it('refuses a delegate grant on a native mailbox whose email no longer matches its owner', () => {
        expect(evaluateMailboxAccess({ requester: delegate, mailbox: infoBox, owner: { email: 'changed@x.com' }, isDelegate: true })).toBeNull()
    })
})
