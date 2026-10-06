import { describe, expect, it } from 'vitest'
import type { Mailbox } from '../../hooks/useMailbox'
import { groupMailboxes, mailboxDomain, mailboxLocalPart } from './mailbox-navigation'

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
