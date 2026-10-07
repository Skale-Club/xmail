// The webmail push bus: mailbox isolation, redaction, cleanup, caps — and the two write paths
// that matter most (MX/SMTP arrival via emitFolderChange, and the counter recompute).

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    MAILBOX_EVENT_MAX_SUBSCRIBERS_PER_USER,
    MailboxEventCapacityError,
    formatMailboxSseComment,
    formatMailboxSseEvent,
    mailboxEventSubscriberCount,
    publishMailboxEvent,
    subscribeToMailboxEvents,
    type MailboxEvent,
} from './mailbox-events'

const BOX_A = '11111111-1111-4111-8111-111111111111'
const BOX_B = '22222222-2222-4222-8222-222222222222'
const FOLDER = '33333333-3333-4333-8333-333333333333'

const cleanups: Array<() => void> = []
function track(unsub: () => void): () => void {
    cleanups.push(unsub)
    return unsub
}

afterEach(() => {
    while (cleanups.length) cleanups.pop()!()
    vi.resetModules()
})

describe('mailbox event bus', () => {
    it('delivers to the subscribed mailbox only (A never reaches B)', () => {
        const seenA: MailboxEvent[] = []
        const seenB: MailboxEvent[] = []
        track(subscribeToMailboxEvents(BOX_A, (e) => seenA.push(e)))
        track(subscribeToMailboxEvents(BOX_B, (e) => seenB.push(e)))

        publishMailboxEvent({ mailboxId: BOX_A, folderId: FOLDER, kind: 'message.new' })

        expect(seenA).toHaveLength(1)
        expect(seenA[0]).toMatchObject({ mailboxId: BOX_A, folderId: FOLDER, kind: 'message.new' })
        expect(typeof seenA[0].at).toBe('string')
        expect(seenB).toHaveLength(0)
    })

    it('fans out to every subscriber of the same mailbox (two tabs)', () => {
        const one = vi.fn()
        const two = vi.fn()
        track(subscribeToMailboxEvents(BOX_A, one))
        track(subscribeToMailboxEvents(BOX_A, two))
        publishMailboxEvent({ mailboxId: BOX_A, kind: 'folder.counts' })
        expect(one).toHaveBeenCalledTimes(1)
        expect(two).toHaveBeenCalledTimes(1)
        expect(one.mock.calls[0][0].folderId).toBeNull()
    })

    it('never carries content: extra fields are dropped on the bus and on the wire', () => {
        const seen: MailboxEvent[] = []
        track(subscribeToMailboxEvents(BOX_A, (e) => seen.push(e)))

        const leaky = {
            mailboxId: BOX_A,
            folderId: FOLDER,
            kind: 'message.new' as const,
            subject: 'Secret subject',
            from: 'someone@example.com',
            plainBody: 'hello',
        }
        publishMailboxEvent(leaky)

        expect(Object.keys(seen[0]).sort()).toEqual(['at', 'folderId', 'kind', 'mailboxId'])
        const frame = formatMailboxSseEvent(leaky)
        expect(frame).not.toContain('Secret')
        expect(frame).not.toContain('someone@example.com')
        expect(frame.startsWith('event: message.new\ndata: ')).toBe(true)
        expect(frame.endsWith('\n\n')).toBe(true)
        expect(formatMailboxSseComment('ping')).toBe(': ping\n\n')
    })

    it('unsubscribe releases the slot and is idempotent', () => {
        const before = mailboxEventSubscriberCount()
        const unsub = subscribeToMailboxEvents(BOX_A, vi.fn(), 'user-1')
        expect(mailboxEventSubscriberCount(BOX_A)).toBe(1)
        unsub()
        unsub()
        expect(mailboxEventSubscriberCount(BOX_A)).toBe(0)
        expect(mailboxEventSubscriberCount()).toBe(before)
    })

    it('isolates a throwing listener and never throws to the publisher', () => {
        const good = vi.fn()
        track(subscribeToMailboxEvents(BOX_A, () => { throw new Error('boom') }))
        track(subscribeToMailboxEvents(BOX_A, good))
        expect(() => publishMailboxEvent({ mailboxId: BOX_A, kind: 'message.updated' })).not.toThrow()
        expect(good).toHaveBeenCalledTimes(1)
    })

    it('caps concurrent subscribers per user and frees the slot on unsubscribe', () => {
        const unsubs: Array<() => void> = []
        for (let i = 0; i < MAILBOX_EVENT_MAX_SUBSCRIBERS_PER_USER; i++) {
            unsubs.push(track(subscribeToMailboxEvents(BOX_A, vi.fn(), 'user-cap')))
        }
        expect(() => subscribeToMailboxEvents(BOX_A, vi.fn(), 'user-cap')).toThrow(MailboxEventCapacityError)
        // Another user is not affected.
        track(subscribeToMailboxEvents(BOX_A, vi.fn(), 'someone-else'))

        unsubs[0]()
        track(subscribeToMailboxEvents(BOX_A, vi.fn(), 'user-cap'))
    })
})

describe('write paths publish', () => {
    it('emitFolderChange (the MX/SMTP arrival path) publishes message.new for that mailbox and folder', async () => {
        const publish = vi.fn()
        vi.doMock('./mailbox-events', async (importOriginal) => ({
            ...(await importOriginal<typeof import('./mailbox-events')>()),
            publishMailboxEvent: publish,
        }))
        const { emitFolderChange } = await import('./mail-events')

        emitFolderChange({ mailboxId: BOX_A, folderId: FOLDER, kind: 'new' })
        emitFolderChange({ mailboxId: BOX_A, folderId: FOLDER, kind: 'flags' })
        emitFolderChange({ mailboxId: BOX_A, folderId: FOLDER, kind: 'expunge' })

        expect(publish.mock.calls.map((c) => c[0])).toEqual([
            { mailboxId: BOX_A, folderId: FOLDER, kind: 'message.new' },
            { mailboxId: BOX_A, folderId: FOLDER, kind: 'message.updated' },
            { mailboxId: BOX_A, folderId: FOLDER, kind: 'message.updated' },
        ])
        vi.doUnmock('./mailbox-events')
    })

    it('emitFolderChange reaches a real subscriber and still feeds IMAP IDLE listeners', async () => {
        const bus = await import('./mailbox-events')
        const { emitFolderChange, mailEvents } = await import('./mail-events')
        const seen: MailboxEvent[] = []
        track(bus.subscribeToMailboxEvents(BOX_A, (e) => seen.push(e)))
        const idle = vi.fn()
        mailEvents.on('folder-change', idle)

        emitFolderChange({ mailboxId: BOX_A, folderId: FOLDER, kind: 'new' })

        expect(seen).toHaveLength(1)
        expect(seen[0]).toMatchObject({ mailboxId: BOX_A, folderId: FOLDER, kind: 'message.new' })
        expect(idle).toHaveBeenCalledWith({ mailboxId: BOX_A, folderId: FOLDER, kind: 'new' })
        mailEvents.off('folder-change', idle)
    })

    it('recomputeFolderCounts publishes folder.counts for the folder mailbox after the write', async () => {
        const publish = vi.fn()
        vi.doMock('./mailbox-events', async (importOriginal) => ({
            ...(await importOriginal<typeof import('./mailbox-events')>()),
            publishMailboxEvent: publish,
        }))
        const order: string[] = []
        vi.doMock('../../db', () => ({
            db: {
                select: () => ({ from: () => ({ where: () => Promise.resolve([{ total: 3, unread: 1 }]) }) }),
                update: () => ({
                    set: () => ({
                        where: () => ({
                            returning: () => {
                                order.push('write')
                                return Promise.resolve([{ mailboxId: BOX_A }])
                            },
                        }),
                    }),
                }),
            },
        }))
        publish.mockImplementation(() => { order.push('publish') })

        const { recomputeFolderCounts } = await import('./folder-counts')
        await recomputeFolderCounts(FOLDER)

        expect(publish).toHaveBeenCalledWith({ mailboxId: BOX_A, folderId: FOLDER, kind: 'folder.counts' })
        expect(order).toEqual(['write', 'publish'])
        vi.doUnmock('../../db')
        vi.doUnmock('./mailbox-events')
    })
})
