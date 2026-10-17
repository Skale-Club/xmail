import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Concurrent message mutations must not refetch the list while one of them is still in flight:
 * that refetch reads the server before the pending change lands and puts the deleted message
 * back on screen for a moment ("deleted, came back, then vanished").
 */

const getMessages = vi.hoisted(() => vi.fn())
const getFolders = vi.hoisted(() => vi.fn())
const deleteMessage = vi.hoisted(() => vi.fn())
const updateMessage = vi.hoisted(() => vi.fn())

vi.mock('../lib/mail-api', () => ({ mailApi: { getMessages, getFolders, deleteMessage, updateMessage } }))
vi.mock('./useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }))
vi.mock('./useMailbox', () => {
    const mailbox = { id: 'box-1' }
    return { useMailbox: () => ({ selectedMailbox: mailbox }) }
})
vi.mock('./useMailboxEvents', () => ({
    useMailboxEvents: () => ({ status: 'live' }),
}))

import { useDeleteMessage, useInfiniteMessages, useUpdateMessage } from './useMail'

function message(id: string) {
    return {
        id,
        mailboxId: 'box-1',
        folder: 'inbox',
        messageId: id,
        from: { name: '', email: 'a@b.c' },
        to: [],
        subject: id,
        read: false,
        starred: false,
        createdAt: '2026-10-06T00:00:00.000Z',
    }
}
const pageOf = (...ids: string[]) => ({ messages: ids.map(message), total: ids.length, hasMore: false })

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    return { promise, resolve }
}

function wrapper() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
}

function useInbox() {
    const list = useInfiniteMessages('inbox')
    return {
        ids: list.data?.pages.flatMap((page) => page.messages.map((m) => m.id)) ?? [],
        remove: useDeleteMessage(),
        update: useUpdateMessage(),
    }
}

beforeEach(() => {
    getMessages.mockReset()
    getFolders.mockReset()
    deleteMessage.mockReset()
    updateMessage.mockReset()
    getFolders.mockResolvedValue({ folders: [{ id: 'f-inbox', name: 'Inbox', type: 'inbox', count: 2, unread: 2 }] })
    getMessages.mockResolvedValue(pageOf('m1', 'm2'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})

describe('concurrent message mutations', () => {
    it('keeps a deleted message gone while an earlier mark-as-read settles first', async () => {
        const { result } = renderHook(() => useInbox(), { wrapper: wrapper() })
        await waitFor(() => expect(result.current.ids).toEqual(['m1', 'm2']))

        const read = deferred()
        const removal = deferred()
        updateMessage.mockReturnValue(read.promise.then(() => ({ message: message('m1') })))
        deleteMessage.mockReturnValue(removal.promise)

        // Opening the email marks it read; the user deletes it before that request returns.
        act(() => { result.current.update.mutate({ messageId: 'm1', data: { read: true } }) })
        act(() => { result.current.remove.mutate('m1') })
        await waitFor(() => expect(result.current.ids).toEqual(['m2']))

        // The server has not moved m1 yet: a refetch now would bring it back.
        const listCallsBefore = getMessages.mock.calls.length
        await act(async () => { read.resolve(); await read.promise })
        await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
        expect(getMessages.mock.calls.length).toBe(listCallsBefore)
        expect(result.current.ids).toEqual(['m2'])

        // The last mutation to settle refetches, and by then the server agrees.
        getMessages.mockResolvedValue(pageOf('m2'))
        await act(async () => { removal.resolve(); await removal.promise })
        await waitFor(() => expect(getMessages.mock.calls.length).toBeGreaterThan(listCallsBefore))
        expect(result.current.ids).toEqual(['m2'])
    })

    it('still refetches after a lone mutation settles', async () => {
        const { result } = renderHook(() => useInbox(), { wrapper: wrapper() })
        await waitFor(() => expect(result.current.ids).toEqual(['m1', 'm2']))

        deleteMessage.mockResolvedValue(undefined)
        getMessages.mockResolvedValue(pageOf('m2'))
        const listCallsBefore = getMessages.mock.calls.length
        act(() => { result.current.remove.mutate('m1') })

        await waitFor(() => expect(getMessages.mock.calls.length).toBeGreaterThan(listCallsBefore))
        expect(result.current.ids).toEqual(['m2'])
    })
})
