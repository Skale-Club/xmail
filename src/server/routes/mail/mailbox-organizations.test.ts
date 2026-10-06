import { describe, expect, it } from 'vitest'
import { getOperationDomains } from '../../lib/operation-domains'
import { classifyMailboxes } from './mailbox-organizations'

const operationDomains = getOperationDomains({
    MAIL_DOMAIN: 'skale.club',
    OUTREACH_PROTECTED_DOMAINS: 'xkedule.com, XPHERE.app ,stuscle.com',
})

const memberships = [
    { userId: 'gustavo', organizationName: 'Grupo Rodobens' },
    { userId: 'eduardo', organizationName: 'Monte Carlo Postos' },
    { userId: 'multi', organizationName: 'Monte Carlo Postos' },
    { userId: 'multi', organizationName: 'Grupo Rodobens' },
]

const mailboxes = [
    { id: 'own', userId: 'admin', email: 'skale.club@gmail.com' },
    { id: 'info', userId: 'u1', email: 'info@xkedule.com' },
    { id: 'main', userId: 'u2', email: 'contato@skale.club' },
    { id: 'upper', userId: 'u3', email: 'agenda@XPHERE.app' },
    { id: 'rodobens', userId: 'gustavo', email: 'gustavo@gruporodobens.com.br' },
    { id: 'monte', userId: 'eduardo', email: 'eduardomunhoz@montecarlopostos.com.br' },
    { id: 'multi', userId: 'multi', email: 'x@client.com' },
    { id: 'noorg', userId: 'ghost', email: 'ghost@unknown.io' },
]

describe('classifyMailboxes', () => {
    const result = classifyMailboxes({ requesterId: 'admin', mailboxes, memberships, operationDomains })

    it('treats mailboxes on operation domains as operation mailboxes, ignoring case', () => {
        expect(result.get('info')?.isOperationMailbox).toBe(true)
        expect(result.get('main')?.isOperationMailbox).toBe(true)
        expect(result.get('upper')?.isOperationMailbox).toBe(true)
    })

    it('treats the requester own mailbox as operation even on a foreign domain and without organization', () => {
        expect(result.get('own')).toEqual({ organizationName: null, isOperationMailbox: true })
    })

    it('puts client organization mailboxes under their organization name', () => {
        expect(result.get('rodobens')).toEqual({ organizationName: 'Grupo Rodobens', isOperationMailbox: false })
        expect(result.get('monte')).toEqual({ organizationName: 'Monte Carlo Postos', isOperationMailbox: false })
    })

    it('uses the first organization alphabetically for owners in several organizations', () => {
        expect(result.get('multi')?.organizationName).toBe('Grupo Rodobens')
    })

    it('leaves organizationName null when the owner has no organization (client falls back to the domain)', () => {
        expect(result.get('noorg')).toEqual({ organizationName: null, isOperationMailbox: false })
    })

    it('hides everything but own mailboxes when the env lists no operation domains', () => {
        const noEnv = classifyMailboxes({
            requesterId: 'admin',
            mailboxes,
            memberships,
            operationDomains: getOperationDomains({}),
        })
        expect(noEnv.get('own')?.isOperationMailbox).toBe(true)
        expect(noEnv.get('info')?.isOperationMailbox).toBe(false)
    })
})

describe('getOperationDomains', () => {
    it('merges MAIL_DOMAIN and the comma-separated list, trimmed and lowercased', () => {
        expect([...operationDomains].sort()).toEqual(['skale.club', 'stuscle.com', 'xkedule.com', 'xphere.app'])
    })

    it('returns an empty set when neither variable is set', () => {
        expect(getOperationDomains({}).size).toBe(0)
    })
})
