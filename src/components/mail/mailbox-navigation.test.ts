import { describe, expect, it } from 'vitest'
import type { Mailbox } from '../../hooks/useMailbox'
import {
    buildMailboxSections,
    formatUnreadBadge,
    mailboxDomain,
    mailboxLocalPart,
    mailboxRole,
    parseStoredIds,
    togglePinned,
    warmupExpandedStorageKey,
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
    it('extracts stable labels from malformed or ordinary addresses', () => {
        expect(mailboxLocalPart('info@skale.club')).toBe('info')
        expect(mailboxDomain('info@skale.club')).toBe('skale.club')
        expect(mailboxDomain('local-only')).toBe('Other')
    })
})

describe('buildMailboxSections', () => {
    const emails = (list: Mailbox[]) => list.map(item => item.email)
    const mixed: Mailbox[] = [
        { ...mailbox('info@skale.club'), role: 'work', unreadCount: 12 },
        { ...mailbox('info@xkedule.com'), role: 'work', unreadCount: 1 },
        { ...mailbox('info@skleanings.com'), role: 'work', unreadCount: 40 },
        { ...mailbox('dmarc@skale.club'), role: 'work' },
        { ...mailbox('contato@skale.club'), role: 'warmup', unreadCount: 99 },
        { ...mailbox('agenda@skale.club'), role: 'warmup', unreadCount: 99 },
        { ...mailbox('gustavo@gruporodobens.com.br'), role: 'other', isOperationMailbox: false, organizationName: 'Grupo Rodobens' },
    ]
    const base = { query: '', pinnedIds: new Set<string>(), showWarmup: false, showOthers: false }

    it('splits mailboxes into work, warm-up and other by the server role', () => {
        const sections = buildMailboxSections(mixed, base)
        expect(emails(sections.work)).toEqual(['info@skleanings.com', 'info@skale.club', 'info@xkedule.com', 'dmarc@skale.club'])
        expect(emails(sections.warmup)).toEqual(['agenda@skale.club', 'contato@skale.club'])
        expect(emails(sections.other)).toEqual(['gustavo@gruporodobens.com.br'])
        expect(sections.pinned).toEqual([])
    })

    it('sorts each section by unread count desc, then by name', () => {
        const sections = buildMailboxSections(mixed, base)
        // warm-up boxes tie on 99 unread: the name decides.
        expect(emails(sections.warmup)).toEqual(['agenda@skale.club', 'contato@skale.club'])
        // work: 40, 12, 1, then the one without unread.
        expect(emails(sections.work)[0]).toBe('info@skleanings.com')
        expect(emails(sections.work).at(-1)).toBe('dmarc@skale.club')
    })

    it('keeps warm-up and other-organization sections collapsed by default and counts them', () => {
        const sections = buildMailboxSections(mixed, base)
        expect(sections.warmupOpen).toBe(false)
        expect(sections.otherOpen).toBe(false)
        expect(sections.warmupCount).toBe(2)
        expect(sections.otherCount).toBe(1)
    })

    it('opens the sections the user expanded', () => {
        const sections = buildMailboxSections(mixed, { ...base, showWarmup: true, showOthers: true })
        expect(sections.warmupOpen).toBe(true)
        expect(sections.otherOpen).toBe(true)
    })

    it('searches across every section and auto-expands the collapsed ones', () => {
        const sections = buildMailboxSections(mixed, { ...base, query: 'agenda' })
        expect(sections.warmupOpen).toBe(true)
        expect(emails(sections.warmup)).toEqual(['agenda@skale.club'])
        expect(sections.work).toEqual([])

        const org = buildMailboxSections(mixed, { ...base, query: 'rodobens' })
        expect(org.otherOpen).toBe(true)
        expect(emails(org.other)).toEqual(['gustavo@gruporodobens.com.br'])
    })

    it('floats pinned mailboxes of any role to the top and removes them from their section', () => {
        const sections = buildMailboxSections(mixed, {
            ...base,
            pinnedIds: new Set(['info@xkedule.com', 'contato@skale.club']),
        })
        expect(emails(sections.pinned)).toEqual(['contato@skale.club', 'info@xkedule.com'])
        expect(emails(sections.work)).not.toContain('info@xkedule.com')
        expect(emails(sections.warmup)).toEqual(['agenda@skale.club'])
    })

    it('falls back to the operation flag when the API sends no role', () => {
        const legacy = [
            mailbox('info@skale.club'),
            { ...mailbox('gustavo@gruporodobens.com.br'), isOperationMailbox: false },
        ]
        const sections = buildMailboxSections(legacy, base)
        expect(emails(sections.work)).toEqual(['info@skale.club'])
        expect(emails(sections.other)).toEqual(['gustavo@gruporodobens.com.br'])
        expect(mailboxRole(legacy[0])).toBe('work')
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

    it('keys every preference per user', () => {
        expect(warmupExpandedStorageKey('u1')).not.toBe(warmupExpandedStorageKey('u2'))
        expect(warmupExpandedStorageKey(null)).toBe(warmupExpandedStorageKey(undefined))
    })

    it('formats unread badges', () => {
        expect(formatUnreadBadge(0)).toBeNull()
        expect(formatUnreadBadge(undefined)).toBeNull()
        expect(formatUnreadBadge(7)).toBe('7')
        expect(formatUnreadBadge(250)).toBe('99+')
    })
})
