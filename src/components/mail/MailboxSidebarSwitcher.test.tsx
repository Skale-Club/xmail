import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Mailbox } from '../../hooks/useMailbox'
import { MailboxSidebarSwitcher } from './MailboxSidebarSwitcher'
import { SHOW_OTHER_ORGS_STORAGE_KEY } from './mailbox-navigation'

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
        isOperationMailbox: true,
        ...extra,
    }
}

const mailboxes: Mailbox[] = [
    mailbox('info@skale.club', { unreadCount: 7 }),
    mailbox('contato@xkedule.com'),
    mailbox('gustavo@gruporodobens.com.br', { isOperationMailbox: false, organizationName: 'Grupo Rodobens' }),
    mailbox('eduardo@montecarlopostos.com.br', { isOperationMailbox: false, organizationName: 'Monte Carlo Postos' }),
]

const state = vi.hoisted(() => ({ selected: null as unknown, list: [] as unknown[], setSelected: () => undefined }))
state.list = mailboxes

// The real hook module pulls in Supabase at import time; only the pieces the switcher uses are needed.
vi.mock('../../hooks/useMailbox', () => ({
    useMailbox: () => ({
        mailboxes: state.list,
        selectedMailbox: state.selected,
        setSelectedMailbox: state.setSelected,
        isLoading: false,
        isRefreshing: false,
        refreshMailboxes: () => Promise.resolve(),
    }),
    getProviderColor: () => 'bg-gray-600',
    getProviderIcon: () => '@',
}))

vi.mock('./ConnectMailboxDialog', () => ({ ConnectMailboxDialog: () => null }))

function renderSwitcher() {
    return render(<MailboxSidebarSwitcher collapsed={false} isMobile={false} onNavigate={() => undefined} />)
}

describe('MailboxSidebarSwitcher', () => {
    beforeEach(() => {
        window.localStorage.clear()
        state.selected = mailboxes[0]
        Element.prototype.scrollIntoView = vi.fn()
    })
    afterEach(() => cleanup())

    it('shows operation mailboxes and hides client organizations behind a counted toggle', () => {
        renderSwitcher()
        expect(screen.getByText('info@skale.club')).toBeTruthy()
        expect(screen.getByText('contato@xkedule.com')).toBeTruthy()
        expect(screen.queryByText('gustavo@gruporodobens.com.br')).toBeNull()
        expect(screen.getByRole('button', { name: 'Show mailboxes from other organizations (2)' })).toBeTruthy()
    })

    it('reveals other organizations grouped by name and remembers the choice', () => {
        renderSwitcher()
        fireEvent.click(screen.getByRole('button', { name: 'Show mailboxes from other organizations (2)' }))

        expect(screen.getByText('gustavo@gruporodobens.com.br')).toBeTruthy()
        expect(screen.getByText('Grupo Rodobens')).toBeTruthy()
        expect(screen.getByText('Monte Carlo Postos')).toBeTruthy()
        expect(window.localStorage.getItem(SHOW_OTHER_ORGS_STORAGE_KEY)).toBe('1')
    })

    it('starts expanded when the toggle was saved', () => {
        window.localStorage.setItem(SHOW_OTHER_ORGS_STORAGE_KEY, '1')
        renderSwitcher()
        expect(screen.getByText('eduardo@montecarlopostos.com.br')).toBeTruthy()
    })

    it('keeps a selected client-organization mailbox visible while the others stay hidden', () => {
        state.selected = mailboxes[2]
        renderSwitcher()
        expect(screen.getByText('gustavo@gruporodobens.com.br')).toBeTruthy()
        expect(screen.queryByText('eduardo@montecarlopostos.com.br')).toBeNull()
    })

    it('shows the unread count on the row', () => {
        renderSwitcher()
        expect(screen.getByLabelText('7 unread')).toBeTruthy()
    })

    it('lets a search find hidden mailboxes', () => {
        renderSwitcher()
        fireEvent.change(screen.getByLabelText('Search mailboxes'), { target: { value: 'eduardo' } })
        expect(screen.getByText('eduardo@montecarlopostos.com.br')).toBeTruthy()
    })
})
