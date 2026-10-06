import { describe, expect, it } from 'vitest'
import type { Mailbox } from '../../hooks/useMailbox'
import {
    buildMailboxSections,
    formatUnreadBadge,
    groupMailboxes,
    mailboxDomain,
    mailboxLocalPart,
    parseStoredIds,
    togglePinned,
} from './mailbox-navigation'

function mailbox(email: string, displayName: string | null = null): Mailbox {
    return {
        id: email,
        email,
        displayName,
        isDefault: true,
        isActive: true,
        isNative: true,
        lastSyncAt: null,
        syncError: null,
    }
}

describe('mailbox navigation', () => {
    it('groups mailboxes by domain and sorts groups and labels', () => {
        const groups = groupMailboxes([
            mailbox('zeta@skale.club'),
            mailbox('agenda@stuscle.com'),
            mailbox('alpha@skale.club'),
        ], '')

        expect(groups.map(group => group.domain)).toEqual(['skale.club', 'stuscle.com'])
        expect(groups[0].mailboxes.map(item => item.email)).toEqual([
            'alpha@skale.club',
            'zeta@skale.club',
        ])
    })

    it('searches display names, local parts, and domains without empty groups', () => {
        const mailboxes = [
            mailbox('info@skale.club', 'Main Inbox'),
            mailbox('agenda@stuscle.com'),
            mailbox('contato@stuscle.com'),
        ]

        expect(groupMailboxes(mailboxes, 'main').flatMap(group => group.mailboxes).map(item => item.email))
            .toEqual(['info@skale.club'])
        expect(groupMailboxes(mailboxes, 'stuscle').flatMap(group => group.mailboxes).map(item => item.email))
            .toEqual(['agenda@stuscle.com', 'contato@stuscle.com'])
        expect(groupMailboxes(mailboxes, 'missing')).toEqual([])
    })

    it('extracts stable labels from malformed or ordinary addresses', () => {
        expect(mailboxLocalPart('info@skale.club')).toBe('info')
        expect(mailboxDomain('info@skale.club')).toBe('skale.club')
        expect(mailboxDomain('local-only')).toBe('Other')
    })
})

describe('buildMailboxSections', () => {
    const operation = [
        mailbox('info@skale.club'),
        mailbox('contato@xkedule.com'),
    ]
    const clients = [
        { ...mailbox('gustavo@gruporodobens.com.br'), isOperationMailbox: false, organizationName: 'Grupo Rodobens' },
        { ...mailbox('juliana@gruporodobens.com.br'), isOperationMailbox: false, organizationName: 'Grupo Rodobens' },
        { ...mailbox('eduardo@montecarlopostos.com.br'), isOperationMailbox: false, organizationName: 'Monte Carlo Postos' },
        { ...mailbox('lone@unknown.io'), isOperationMailbox: false, organizationName: null },
    ]
    const all = [...operation, ...clients]
    const base = { query: '', pinnedIds: new Set<string>(), selectedId: null, showOthers: false }

    it('hides other-organization mailboxes by default and counts them', () => {
        const sections = buildMailboxSections(all, base)
        expect(sections.operationGroups.flatMap(g => g.mailboxes).map(m => m.email))
            .toEqual(['info@skale.club', 'contato@xkedule.com'])
        expect(sections.otherGroups).toEqual([])
        expect(sections.hiddenOtherCount).toBe(4)
        expect(sections.otherCount).toBe(4)
    })

    it('groups revealed mailboxes by organization name, falling back to the email domain', () => {
        const sections = buildMailboxSections(all, { ...base, showOthers: true })
        expect(sections.otherGroups.map(g => g.domain)).toEqual(['Grupo Rodobens', 'Monte Carlo Postos', 'unknown.io'])
        expect(sections.otherGroups[0].mailboxes.map(m => m.email))
            .toEqual(['gustavo@gruporodobens.com.br', 'juliana@gruporodobens.com.br'])
        expect(sections.hiddenOtherCount).toBe(0)
    })

    it('keeps the selected mailbox visible even when it belongs to another organization', () => {
        const sections = buildMailboxSections(all, { ...base, selectedId: 'eduardo@montecarlopostos.com.br' })
        expect(sections.otherGroups.map(g => g.domain)).toEqual(['Monte Carlo Postos'])
        expect(sections.hiddenOtherCount).toBe(3)
    })

    it('lets a search find hidden mailboxes without flipping the toggle', () => {
        const sections = buildMailboxSections(all, { ...base, query: 'rodobens' })
        expect(sections.otherGroups.flatMap(g => g.mailboxes)).toHaveLength(2)
        expect(sections.operationGroups).toEqual([])
    })

    it('floats pinned mailboxes to the top and removes them from their group', () => {
        const sections = buildMailboxSections(all, { ...base, pinnedIds: new Set(['info@skale.club']) })
        expect(sections.pinned.map(m => m.email)).toEqual(['info@skale.club'])
        expect(sections.operationGroups.flatMap(g => g.mailboxes).map(m => m.email)).toEqual(['contato@xkedule.com'])
    })

    it('treats mailboxes from an API without the flag as operation mailboxes', () => {
        expect(buildMailboxSections(operation, base).hiddenOtherCount).toBe(0)
    })
})

describe('mailbox preferences', () => {
    it('parses stored ids defensively', () => {
        expect([...parseStoredIds('["a","b",3]')]).toEqual(['a', 'b'])
        expect(parseStoredIds('not json').size).toBe(0)
        expect(parseStoredIds('{"a":1}').size).toBe(0)
        expect(parseStoredIds(null).size).toBe(0)
    })

    it('toggles pins immutably', () => {
        const start = new Set(['a'])
        expect([...togglePinned(start, 'b')]).toEqual(['a', 'b'])
        expect([...togglePinned(start, 'a')]).toEqual([])
        expect(start.size).toBe(1)
    })

    it('formats unread badges', () => {
        expect(formatUnreadBadge(0)).toBeNull()
        expect(formatUnreadBadge(undefined)).toBeNull()
        expect(formatUnreadBadge(7)).toBe('7')
        expect(formatUnreadBadge(250)).toBe('99+')
    })
})
