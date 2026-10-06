import { describe, expect, it } from 'vitest'
import type { Mailbox } from '../../hooks/useMailbox'
import { mailboxOptionLabel, sendableMailboxes } from './compose-sender'

function mailbox(email: string, extra: Partial<Mailbox> = {}): Mailbox {
    return {
        id: email,
        email,
        displayName: null,
        isDefault: false,
        isActive: true,
        isNative: true,
        lastSyncAt: null,
        syncError: null,
        ...extra,
    }
}

describe('sendableMailboxes', () => {
    const list = [
        mailbox('zeta@skale.club'),
        mailbox('alpha@skale.club'),
        mailbox('off@skale.club', { isActive: false }),
        mailbox('gustavo@gruporodobens.com.br', { isOperationMailbox: false }),
    ]

    it('lists active operation mailboxes sorted by address', () => {
        expect(sendableMailboxes(list, null).map(m => m.email)).toEqual(['alpha@skale.club', 'zeta@skale.club'])
    })

    it('keeps the currently chosen sender even when it is inactive or from another organization', () => {
        expect(sendableMailboxes(list, 'gustavo@gruporodobens.com.br').map(m => m.email))
            .toContain('gustavo@gruporodobens.com.br')
        expect(sendableMailboxes(list, 'off@skale.club').map(m => m.email)).toContain('off@skale.club')
    })

    it('formats option labels', () => {
        expect(mailboxOptionLabel({ email: 'a@x.com', displayName: 'Ana' })).toBe('Ana <a@x.com>')
        expect(mailboxOptionLabel({ email: 'a@x.com', displayName: null })).toBe('a@x.com')
    })
})
