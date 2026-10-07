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
    refresh: vi.fn(() => Promise.resolve()),
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
        refreshMailboxes: state.refresh,
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
    // The scroll area wraps one listbox per section; hand back its parent.
    return screen.findAllByRole('listbox').then(boxes => boxes[0].parentElement!.parentElement as HTMLElement)
}

describe('MailboxSwitcherButton and panel', () => {
    beforeEach(() => {
        window.localStorage.clear()
        state.selected = mailboxes[0]
        state.setSelected.mockClear()
        state.refresh.mockClear()
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
        const trigger = screen.getByRole('button', { name: /info@skale.club, 7 unread\. switch mailbox/i })
        expect(within(trigger).getByText('info')).toBeTruthy()
        expect(within(trigger).getByText('@skale.club')).toBeTruthy()
        expect(within(trigger).getByLabelText('7 unread')).toBeTruthy()
    })

    it('shows only the avatar and the badge when the sidebar is collapsed', () => {
        renderSwitcher(true)
        const trigger = screen.getByRole('button', { name: /info@skale.club, 7 unread\. switch mailbox/i })
        expect(within(trigger).getByTestId('mailbox-avatar').textContent).toBe('I')
        expect(within(trigger).getByLabelText('7 unread')).toBeTruthy()
        expect(within(trigger).queryByText('@skale.club')).toBeNull()
        expect(within(trigger).queryByText('info')).toBeNull()
    })

    it('lists work mailboxes sorted by unread, with warm-up and other organizations collapsed', async () => {
        renderSwitcher()
        const list = await openPanel()

        // Only the Work rows are listed: warm-up and other organizations are collapsed.
        expect(screen.getAllByRole('listbox')).toHaveLength(1)

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

    it('does nothing on a quick Enter when the current mailbox sits in a collapsed section', async () => {
        state.selected = mailboxes[3] // agenda@stuscle.com, warm-up (collapsed)
        renderSwitcher()
        await openPanel()
        const input = screen.getByLabelText('Search mailboxes')

        fireEvent.keyDown(input, { key: 'Enter' })
        expect(state.setSelected).not.toHaveBeenCalled()
        expect(screen.queryByRole('option', { selected: true })).toBeNull()

        // The arrows then start from the first visible row.
        fireEvent.keyDown(input, { key: 'ArrowDown' })
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(state.setSelected.mock.calls[0][0]).toMatchObject({ email: 'info@xkedule.com' })
    })

    it('jumps to the first and last visible row with Home and End', async () => {
        renderSwitcher()
        await openPanel()
        const input = screen.getByLabelText('Search mailboxes')

        fireEvent.keyDown(input, { key: 'End' })
        expect(input.getAttribute('aria-activedescendant')).toMatch(/dmarc@skale\.club$/)

        fireEvent.keyDown(input, { key: 'Home' })
        expect(input.getAttribute('aria-activedescendant')).toMatch(/info@xkedule\.com$/)
    })

    it('keeps the listbox clean: options only, aria-selected on the active row, aria-current on the current mailbox', async () => {
        renderSwitcher()
        await openPanel()

        for (const box of screen.getAllByRole('listbox')) {
            expect(within(box).queryAllByRole('button')).toHaveLength(0)
            expect(box.querySelector('section, header, [aria-busy], [aria-label="Loading mailboxes"]')).toBeNull()
            expect(within(box).getAllByRole('option').length).toBeGreaterThan(0)
        }
        const current = screen.getAllByRole('option').find(option => option.textContent?.includes('info@skale.club')) as HTMLElement
        expect(current.getAttribute('aria-current')).toBe('true')
        // Active (keyboard) row starts on the current mailbox, then follows the arrows.
        expect(current.getAttribute('aria-selected')).toBe('true')
        fireEvent.keyDown(screen.getByLabelText('Search mailboxes'), { key: 'ArrowDown' })
        expect(current.getAttribute('aria-selected')).toBe('false')
        const dmarc = screen.getAllByRole('option').find(option => option.textContent?.includes('dmarc@skale.club')) as HTMLElement
        expect(dmarc.getAttribute('aria-selected')).toBe('true')
        expect(current.getAttribute('aria-current')).toBe('true')
    })

    it('refreshes the mailboxes in the background when the panel opens', async () => {
        renderSwitcher()
        expect(state.refresh).not.toHaveBeenCalled()
        await openPanel()
        expect(state.refresh).toHaveBeenCalled()
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

    it('leaves Ctrl+K alone inside the compose window', () => {
        renderSwitcher()
        const compose = document.createElement('div')
        compose.setAttribute('data-compose-window', '')
        const subject = document.createElement('input')
        compose.appendChild(subject)
        document.body.appendChild(compose)

        fireEvent.keyDown(subject, { key: 'k', ctrlKey: true })
        expect(screen.queryByRole('listbox')).toBeNull()
        expect(screen.queryByLabelText('Search mailboxes')).toBeNull()
        compose.remove()
    })

    it('leaves Ctrl+K alone inside any other dialog', () => {
        renderSwitcher()
        const dialog = document.createElement('div')
        dialog.setAttribute('role', 'dialog')
        const field = document.createElement('input')
        dialog.appendChild(field)
        document.body.appendChild(dialog)

        fireEvent.keyDown(field, { key: 'k', ctrlKey: true })
        expect(screen.queryByLabelText('Search mailboxes')).toBeNull()
        dialog.remove()
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
