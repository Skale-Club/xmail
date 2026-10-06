import { describe, expect, it } from 'vitest'
import { computeMailboxOrganizationInfo } from './mailbox-organizations'

const memberships = [
    { userId: 'admin', organizationId: 'skale', organizationName: 'Skale Club' },
    { userId: 'ana', organizationId: 'skale', organizationName: 'Skale Club' },
    { userId: 'gustavo', organizationId: 'rodobens', organizationName: 'Grupo Rodobens' },
    { userId: 'multi', organizationId: 'rodobens', organizationName: 'Grupo Rodobens' },
    { userId: 'multi', organizationId: 'skale', organizationName: 'Skale Club' },
]

const mailboxes = [
    { id: 'mb-admin', userId: 'admin' },
    { id: 'mb-ana', userId: 'ana' },
    { id: 'mb-gustavo', userId: 'gustavo' },
    { id: 'mb-multi', userId: 'multi' },
    { id: 'mb-orphan', userId: 'orphan' },
]

describe('computeMailboxOrganizationInfo', () => {
    const info = computeMailboxOrganizationInfo({ requesterId: 'admin', mailboxes, memberships })

    it('marks the requester own mailbox and mailboxes of org mates as mine', () => {
        expect(info.get('mb-admin')?.inMyOrganizations).toBe(true)
        expect(info.get('mb-ana')?.inMyOrganizations).toBe(true)
    })

    it('marks mailboxes of other organizations as not mine', () => {
        expect(info.get('mb-gustavo')?.inMyOrganizations).toBe(false)
        expect(info.get('mb-gustavo')?.organizations).toEqual([{ id: 'rodobens', name: 'Grupo Rodobens' }])
    })

    it('counts an owner that belongs to several organizations as mine if any is shared', () => {
        const multi = info.get('mb-multi')
        expect(multi?.inMyOrganizations).toBe(true)
        expect(multi?.organizations.map(org => org.name)).toEqual(['Grupo Rodobens', 'Skale Club'])
    })

    it('treats an owner without memberships as another organization (empty list)', () => {
        expect(info.get('mb-orphan')).toEqual({ organizations: [], inMyOrganizations: false })
    })

    it('keeps the requester own mailbox visible even without any membership', () => {
        const alone = computeMailboxOrganizationInfo({
            requesterId: 'solo',
            mailboxes: [{ id: 'mb-solo', userId: 'solo' }],
            memberships: [],
        })
        expect(alone.get('mb-solo')?.inMyOrganizations).toBe(true)
    })
})
