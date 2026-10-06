import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ComposeDialog } from './ComposeDialog'

const mocks = vi.hoisted(() => ({
    sendMock: vi.fn(),
    saveMock: vi.fn(),
    closeCompose: vi.fn(),
    registerGuard: vi.fn(),
    options: { replyToId: 'm1', replyAll: true, mailboxId: 'mb1' } as Record<string, unknown>,
    selectedId: 'mb1',
}))

const mailboxes = [
    { id: 'mb1', email: 'info@skale.club', displayName: null, isActive: true, isOperationMailbox: true },
    { id: 'mb2', email: 'contato@xkedule.com', displayName: 'Contato', isActive: true, isOperationMailbox: true },
]

const original = {
    id: 'm1',
    messageId: '<orig@client.com>',
    references: undefined,
    subject: 'Budget',
    from: { name: 'Ana Souza', email: 'ana@client.com' },
    to: [{ name: '', email: 'info@skale.club' }, { name: '', email: 'bob@client.com' }],
    cc: [{ name: '', email: 'carol@client.com' }],
    date: '2026-10-06T14:32:00.000Z',
    bodyHtml: '<p>Can you send the budget?</p>',
    attachments: [],
}

vi.mock('../../hooks/useMailbox', () => ({
    useMailbox: () => ({
        mailboxes,
        selectedMailbox: mailboxes.find(mailbox => mailbox.id === mocks.selectedId),
    }),
}))

vi.mock('../../hooks/useMail', () => ({
    useSendEmail: () => ({ mutateAsync: mocks.sendMock, isPending: false }),
    useSaveDraft: () => ({ mutateAsync: mocks.saveMock, isPending: false }),
    useMessage: () => ({ data: { message: original }, isError: false }),
}))

vi.mock('../../hooks/useCompose', () => ({
    useCompose: () => ({
        isOpen: true,
        options: mocks.options,
        sessionId: 1,
        closeCompose: mocks.closeCompose,
        registerGuard: mocks.registerGuard,
    }),
}))

vi.mock('../../lib/mail-api', () => ({
    mailApi: {
        getSignatures: vi.fn(() => Promise.resolve({
            signatures: [{ id: 's1', mailboxId: 'mb1', name: 'Main', content: '<p>-- Bia</p>', isDefault: true }],
        })),
        fetchAttachmentFile: vi.fn(),
        deleteMessage: vi.fn(() => Promise.resolve()),
    },
}))

vi.mock('./RichTextEditor', () => ({
    RichTextEditor: ({ value, onChange }: { value: string; onChange: (value: string, source?: string) => void }) => (
        <textarea aria-label="Body" value={value} onChange={(event) => onChange(event.target.value, 'user')} />
    ),
    htmlToPlainText: (html: string) => html.replace(/<[^>]*>/g, ' ').trim(),
}))

vi.mock('./ContactAutocomplete', () => ({
    ContactAutocomplete: ({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) => (
        <input aria-label={placeholder || 'Cc'} value={value} onChange={(event) => onChange(event.target.value)} />
    ),
}))

vi.mock('../ui/toaster', () => ({ toast: vi.fn() }))

function renderDialog() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={client}>
            <ComposeDialog />
        </QueryClientProvider>,
    )
}

describe('ComposeDialog', () => {
    beforeEach(() => {
        mocks.sendMock.mockReset().mockResolvedValue({ success: true })
        mocks.saveMock.mockReset()
        mocks.closeCompose.mockReset()
        mocks.options = { replyToId: 'm1', replyAll: true, mailboxId: 'mb1' }
        mocks.selectedId = 'mb1'
    })
    afterEach(() => cleanup())

    it('builds a reply with the signature above the quote and keeps To recipients in To', async () => {
        renderDialog()
        const body = (await screen.findByLabelText('Body')) as HTMLTextAreaElement

        await waitFor(() => expect(body.value).toContain('-- Bia'))
        expect(body.value).toContain('Can you send the budget?')
        expect(body.value.indexOf('-- Bia')).toBeLessThan(body.value.indexOf('wrote:'))
        expect(body.value.indexOf('wrote:')).toBeLessThan(body.value.indexOf('Can you send the budget?'))

        expect((screen.getByLabelText('Recipients') as HTMLInputElement).value).toBe('ana@client.com, bob@client.com')
        expect((screen.getByLabelText('Cc') as HTMLInputElement).value).toBe('carol@client.com')
        expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('Re: Budget')
    })

    it('sends from the explicitly chosen mailbox, not from the sidebar selection', async () => {
        renderDialog()
        await screen.findByLabelText('Body')
        await waitFor(() => expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toContain('-- Bia'))

        // The sidebar moves to another mailbox while the compose window is open.
        mocks.selectedId = 'mb2'

        const from = screen.getByLabelText('From') as HTMLSelectElement
        expect(from.value).toBe('mb1')
        fireEvent.change(from, { target: { value: 'mb2' } })
        // With nothing typed yet the message is rebuilt for the new sender (its own signature).
        await waitFor(() => expect((screen.getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(false))
        expect((screen.getByLabelText('From') as HTMLSelectElement).value).toBe('mb2')

        fireEvent.click(screen.getByRole('button', { name: /send/i }))
        await waitFor(() => expect(mocks.sendMock).toHaveBeenCalledTimes(1))
        expect(mocks.sendMock.mock.calls[0][0].mailboxId).toBe('mb2')
    })

    it('sends from the mailbox that owns the original even if the selection changed meanwhile', async () => {
        mocks.selectedId = 'mb2'
        renderDialog()
        await waitFor(() => expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toContain('Can you send'))

        fireEvent.click(screen.getByRole('button', { name: /send/i }))
        await waitFor(() => expect(mocks.sendMock).toHaveBeenCalledTimes(1))
        expect(mocks.sendMock.mock.calls[0][0].mailboxId).toBe('mb1')
    })

    it('registers a guard so a second compose cannot silently replace this one', async () => {
        renderDialog()
        await screen.findByLabelText('Body')
        await waitFor(() => expect(mocks.registerGuard).toHaveBeenCalledWith(expect.any(Function)))
    })

    it('does not autosave once the window started closing (discard, send)', async () => {
        renderDialog()
        const body = (await screen.findByLabelText('Body')) as HTMLTextAreaElement
        await waitFor(() => expect(body.value).toContain('-- Bia'))

        vi.useFakeTimers({ shouldAdvanceTime: true })
        try {
            fireEvent.change(body, { target: { value: `${body.value} more` } })
            fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
            await vi.advanceTimersByTimeAsync(8000)
            expect(mocks.saveMock).not.toHaveBeenCalled()
            expect(mocks.closeCompose).toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })

    it('autosaves after a pause when the message is edited', async () => {
        mocks.saveMock.mockResolvedValue({ draftId: 'd1' })
        renderDialog()
        const body = (await screen.findByLabelText('Body')) as HTMLTextAreaElement
        await waitFor(() => expect(body.value).toContain('-- Bia'))

        vi.useFakeTimers({ shouldAdvanceTime: true })
        try {
            fireEvent.change(body, { target: { value: `${body.value} more` } })
            await vi.advanceTimersByTimeAsync(5500)
            expect(mocks.saveMock).toHaveBeenCalledTimes(1)
            expect(mocks.saveMock.mock.calls[0][0].mailboxId).toBe('mb1')
        } finally {
            vi.useRealTimers()
        }
    })
})
