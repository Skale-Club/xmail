import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Mailbox } from '../../hooks/useMailbox'
import { MailboxSwitcherButton } from './MailboxSwitcherButton'
import { FOCUS_MAILBOX_SEARCH_EVENT, warmupExpandedStorageKey } from './mailbox-navigation'

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
        role: 'work',
        ...extra,
    }
}

const mailboxes: Mailbox[] = [
    mailbox('info@skale.club', { unreadCount: 7 }),
    mailbox('info@xkedule.com', { unreadCount: 40 }),
    mailbox('dmarc@skale.club'),
    mailbox('agenda@stuscle.com', { role: 'warmup', unreadCount: 99 }),
    mailbox('contato@stuscle.com', { role: 'warmup' }),
    mailbox('gustavo@gruporodobens.com.br', { role: 'other', isOperationMailbox: false, organizationName: 'Grupo Rodobens' }),
]

const state = vi.hoisted(() => ({
    selected: null as unknown,
    list: [] as unknown[],
    setSelected: vi.fn(),
}))
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
}))

vi.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }))
vi.mock('./ConnectMailboxDialog', () => ({ ConnectMailboxDialog: () => null }))

function renderSwitcher(collapsed = false) {
    return render(<MailboxSwitcherButton collapsed={collapsed} isMobile={false} onNavigate={() => undefined} />)
}

function openPanel() {
    fireEvent.click(screen.getByRole('button', { name: /switch mailbox/i }))
    return screen.findByRole('listbox')
}

describe('MailboxSwitcherButton and panel', () => {
    beforeEach(() => {
        window.localStorage.clear()
        state.selected = mailboxes[0]
        state.setSelected.mockClear()
        Element.prototype.scrollIntoView = vi.fn()
        // Radix popper measures its anchor with ResizeObserver, which jsdom does not provide.
        globalThis.ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    })
    afterEach(() => cleanup())

    it('shows the current mailbox and its unread badge on the trigger', () => {
        renderSwitcher()
        const trigger = screen.getByRole('button', { name: /switch mailbox, current: info@skale.club/i })
        expect(within(trigger).getByText('info')).toBeTruthy()
        expect(within(trigger).getByText('@skale.club')).toBeTruthy()
        expect(within(trigger).getByLabelText('7 unread')).toBeTruthy()
    })

    it('shows only the avatar and the badge when the sidebar is collapsed', () => {
        renderSwitcher(true)
        const trigger = screen.getByRole('button', { name: /switch mailbox, current: info@skale.club/i })
        expect(within(trigger).getByTestId('mailbox-avatar').textContent).toBe('I')
        expect(within(trigger).getByLabelText('7 unread')).toBeTruthy()
        expect(within(trigger).queryByText('@skale.club')).toBeNull()
        expect(within(trigger).queryByText('info')).toBeNull()
    })

    it('lists work mailboxes sorted by unread, with warm-up and other organizations collapsed', async () => {
        renderSwitcher()
        const list = await openPanel()

        const headings = within(list).getAllByRole('region').map(section => section.getAttribute('aria-labelledby'))
        expect(headings).toHaveLength(3) // work, warm-up, other organizations (nothing pinned)

        const options = within(list).getAllByRole('option').map(option => option.textContent)
        expect(options[0]).toContain('info@xkedule.com') // 40 unread first
        expect(options[1]).toContain('info@skale.club') // then 7
        expect(options[2]).toContain('dmarc@skale.club') // then no unread
        expect(options).toHaveLength(3)

        expect(within(list).getByRole('button', { name: /warm-up \(2\)\s*show/i })).toBeTruthy()
        expect(within(list).getByRole('button', { name: /other organizations \(1\)\s*show/i })).toBeTruthy()
        expect(screen.queryByText('agenda')).toBeNull()
    })

    it('puts pinned mailboxes first under a Pinned heading', async () => {
        window.localStorage.setItem('xmail:mail:pinned-mailboxes:user-1', JSON.stringify(['dmarc@skale.club']))
        renderSwitcher()
        const list = await openPanel()
        const options = within(list).getAllByRole('option').map(option => option.textContent)
        expect(options[0]).toContain('dmarc@skale.club')
        expect(within(list).getByText('Pinned')).toBeTruthy()
    })

    it('expands warm-up on demand and remembers it', async () => {
        renderSwitcher()
        const list = await openPanel()
        fireEvent.click(within(list).getByRole('button', { name: /warm-up/i }))

        expect(within(list).getByText('agenda')).toBeTruthy()
        expect(within(list).getByText('contato')).toBeTruthy()
        expect(window.localStorage.getItem(warmupExpandedStorageKey('user-1'))).toBe('1')
    })

    it('opens the warm-up section by itself when a search matches it', async () => {
        renderSwitcher()
        await openPanel()
        fireEvent.change(screen.getByLabelText('Search mailboxes'), { target: { value: 'agenda' } })

        expect(screen.getByText('agenda')).toBeTruthy()
        expect(screen.queryByText('contato')).toBeNull()
        expect(screen.queryByText('dmarc')).toBeNull()
    })

    it('finds other-organization mailboxes through search without touching the toggle', async () => {
        renderSwitcher()
        await openPanel()
        fireEvent.change(screen.getByLabelText('Search mailboxes'), { target: { value: 'rodobens' } })
        expect(screen.getByText('gustavo')).toBeTruthy()
    })

    it('selects with the keyboard: search, Enter, panel closes', async () => {
        renderSwitcher()
        await openPanel()
        const input = screen.getByLabelText('Search mailboxes')
        fireEvent.change(input, { target: { value: 'xked' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        expect(state.setSelected).toHaveBeenCalledTimes(1)
        expect(state.setSelected.mock.calls[0][0]).toMatchObject({ email: 'info@xkedule.com' })
        await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    })

    it('moves the active row with the arrow keys', async () => {
        renderSwitcher()
        await openPanel()
        const input = screen.getByLabelText('Search mailboxes')
        // Active row starts on the current mailbox (info@skale.club); one step down is dmarc@.
        fireEvent.keyDown(input, { key: 'ArrowDown' })
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(state.setSelected.mock.calls[0][0]).toMatchObject({ email: 'dmarc@skale.club' })
    })

    it('selects with a click and closes the panel', async () => {
        renderSwitcher()
        const list = await openPanel()
        fireEvent.click(within(list).getByText('dmarc'))

        expect(state.setSelected.mock.calls[0][0]).toMatchObject({ email: 'dmarc@skale.club' })
        await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    })

    it('closes with Escape and gives focus back to the trigger', async () => {
        renderSwitcher()
        await openPanel()
        fireEvent.keyDown(screen.getByLabelText('Search mailboxes'), { key: 'Escape' })

        await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /switch mailbox/i })))
    })

    it('opens the panel with the search focused on Ctrl+K', async () => {
        renderSwitcher()
        expect(screen.queryByRole('listbox')).toBeNull()

        fireEvent.keyDown(document, { key: 'k', ctrlKey: true })

        const input = await screen.findByLabelText('Search mailboxes')
        await waitFor(() => expect(document.activeElement).toBe(input))
    })

    it('opens the panel with the search focused on the "g m" event', async () => {
        renderSwitcher()
        window.dispatchEvent(new Event(FOCUS_MAILBOX_SEARCH_EVENT))

        const input = await screen.findByLabelText('Search mailboxes')
        await waitFor(() => expect(document.activeElement).toBe(input))
    })

    it('leaves Ctrl+K alone while typing in a rich-text editor', () => {
        renderSwitcher()
        const editor = document.createElement('div')
        editor.contentEditable = 'true'
        // jsdom does not implement isContentEditable; mirror what a browser reports.
        Object.defineProperty(editor, 'isContentEditable', { value: true })
        document.body.appendChild(editor)

        fireEvent.keyDown(editor, { key: 'k', ctrlKey: true })
        expect(screen.queryByRole('listbox')).toBeNull()
        editor.remove()
    })
})
