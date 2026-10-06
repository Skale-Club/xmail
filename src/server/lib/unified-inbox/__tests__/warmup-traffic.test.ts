import { describe, expect, it } from 'vitest'
import {
    createWarmupExclusion,
    isMeshAccount,
    isWarmupMessageId,
    isWarmupTraffic,
    resetSkippedStatusCache,
    supportsSkippedStatus,
    warmupMessageIdTokens,
} from '../warmup-traffic'
import type { UnifiedInboxSql } from '../ingest'
import { escapeLikePattern } from '../like'
import {
    decodeConversationCursor,
    encodeConversationCursor,
    fingerprintConversationFilters,
    type ConversationCursorFilters,
} from '../cursor'

const MESH = new Set(['contato@skale.club', 'agenda@xkedule.com', 'vanildo.jr@tryskaleclub.com'])
const WARMUP_ID = 'w.0f8fad5b-d9cb-469f-a165-70867728950e@skale.club'

describe('isWarmupTraffic - account rule', () => {
    it('excludes everything that belongs to a warmup_only account, whoever the counterpart is', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: true,
            counterpartAddresses: ['lead@prospect.test'],
            meshAddresses: MESH,
        })).toBe(true)
    })
})

describe('isWarmupTraffic - gate: only a mesh mailbox can hold warm-up mail', () => {
    it('never classifies an info@ (non-mesh owner) conversation as warm-up, even from a mesh address', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            accountInMesh: false,
            counterpartAddresses: ['vanildo.jr@tryskaleclub.com'],
            meshAddresses: MESH,
        })).toBe(false)
    })

    it('never classifies an info@ conversation as warm-up because of a forwarded warm-up Message-ID', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            accountInMesh: false,
            counterpartAddresses: ['prospect@barbershop.example'],
            messageIds: [WARMUP_ID],
            meshAddresses: MESH,
        })).toBe(false)
    })

    it('defaults to NOT in the mesh when the caller does not say', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            counterpartAddresses: ['contato@skale.club'],
            meshAddresses: MESH,
        })).toBe(false)
    })

    it('treats only internal and warmup_only accounts as the mesh (not vendor/provider/none)', () => {
        expect(isMeshAccount({ warmupSource: 'internal', warmupOnly: false })).toBe(true)
        expect(isMeshAccount({ warmupSource: 'none', warmupOnly: true })).toBe(true)
        expect(isMeshAccount({ warmupSource: 'vendor', warmupOnly: false })).toBe(false)
        expect(isMeshAccount({ warmupSource: 'provider', warmupOnly: false })).toBe(false)
        expect(isMeshAccount({ warmupSource: 'none', warmupOnly: false })).toBe(false)
    })
})

describe('isWarmupTraffic - counterpart rule (owner in the mesh)', () => {
    it('excludes a message whose only counterpart is a mesh address (Icemail sender <-> mesh)', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            accountInMesh: true,
            counterpartAddresses: ['Contato@Skale.club'],
            meshAddresses: MESH,
        })).toBe(true)
    })

    it('handles display-name forms and brackets', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            accountInMesh: true,
            counterpartAddresses: ['"Agenda" <agenda@xkedule.com>'],
            meshAddresses: MESH,
        })).toBe(true)
    })

    it('keeps conversations with people outside the mesh', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            accountInMesh: true,
            counterpartAddresses: ['owner@barbershop.example'],
            messageIds: ['abc123@mail.gmail.com'],
            meshAddresses: MESH,
        })).toBe(false)
    })

    it('keeps a message that ALSO involves someone outside the mesh', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            accountInMesh: true,
            counterpartAddresses: ['contato@skale.club', 'owner@barbershop.example'],
            meshAddresses: MESH,
        })).toBe(false)
    })

    it('excludes an outbound send whose every recipient is in the mesh', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            accountInMesh: true,
            counterpartAddresses: ['contato@skale.club', 'agenda@xkedule.com'],
            meshAddresses: MESH,
        })).toBe(true)
    })

    it('does not treat a missing counterpart as a mesh match', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            accountInMesh: true,
            counterpartAddresses: [null, undefined, ''],
            meshAddresses: MESH,
        })).toBe(false)
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            accountInMesh: true,
            counterpartAddresses: [],
            meshAddresses: new Set(),
        })).toBe(false)
    })
})

describe('isWarmupTraffic - Message-ID shape (owner in the mesh)', () => {
    it('recognizes the engine-minted w.<uuid>@domain id, bracketed or not', () => {
        expect(isWarmupMessageId(WARMUP_ID)).toBe(true)
        expect(isWarmupMessageId(`<${WARMUP_ID}>`)).toBe(true)
        expect(isWarmupMessageId('w.not-a-uuid@skale.club')).toBe(false)
        expect(isWarmupMessageId('xmail-1@outreach.local')).toBe(false)
        expect(isWarmupMessageId(null)).toBe(false)
    })

    it('excludes a reply that only references a warm-up id even when the sender is outside the mesh', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            accountInMesh: true,
            counterpartAddresses: ['forwarder@alias.example'],
            messageIds: warmupMessageIdTokens({ messageId: 'x@y.test', inReplyTo: `<${WARMUP_ID}>` }),
            meshAddresses: MESH,
        })).toBe(true)
    })

    it('catches a DSN (mailer-daemon) answering a warm-up send via its References', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            accountInMesh: true,
            counterpartAddresses: ['mailer-daemon@googlemail.com'],
            messageIds: warmupMessageIdTokens({ messageId: 'dsn-1@googlemail.com', references: `<${WARMUP_ID}>` }),
            meshAddresses: MESH,
        })).toBe(true)
    })

    it('reads References tokens too', () => {
        const tokens = warmupMessageIdTokens({ references: `<a@x.test> <${WARMUP_ID}>` })
        expect(tokens).toContain(WARMUP_ID)
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            accountInMesh: true,
            counterpartAddresses: ['p@q.test'],
            messageIds: tokens,
            meshAddresses: MESH,
        })).toBe(true)
    })
})

describe('createWarmupExclusion (applied to mesh accounts only)', () => {
    const exclude = createWarmupExclusion(MESH)
    const base = {
        provider: 'native' as const,
        providerMessageId: 'm1',
        messageId: 'm1@x.test',
        inReplyTo: null,
        references: null,
        fromAddress: 'owner@barbershop.example',
        toAddresses: ['info@xkedule.com'],
        ccAddresses: [],
        subject: 's',
        textBody: null,
        htmlBody: null,
        headers: {},
        attachments: [],
        receivedAt: new Date(),
    }

    it('drops mesh senders and keeps real ones', () => {
        expect(exclude({ ...base, fromAddress: 'contato@skale.club' })).toBe(true)
        expect(exclude(base)).toBe(false)
    })
})

describe('escapeLikePattern', () => {
    it('escapes %, _ and the backslash so input matches literally', () => {
        expect(escapeLikePattern('100%')).toBe('100\\%')
        expect(escapeLikePattern('a_b')).toBe('a\\_b')
        expect(escapeLikePattern('c:\\dir')).toBe('c:\\\\dir')
        expect(escapeLikePattern('plain')).toBe('plain')
    })
})

describe('cursor fingerprint with views', () => {
    const base: ConversationCursorFilters = {
        organizationId: '11111111-1111-4111-8111-111111111111',
        unread: false,
        status: null,
        campaignId: null,
        emailAccountId: null,
        search: null,
    }
    const position = { lastMessageAt: '2026-10-06 12:00:00', id: '22222222-2222-4222-8222-222222222222' }

    it('keeps the fingerprint of a view-less filter set unchanged', () => {
        expect(fingerprintConversationFilters(base)).toBe(fingerprintConversationFilters({ ...base, view: null }))
    })

    it('accepts a cursor minted before views existed (the in-flight load-more across a deploy)', () => {
        // What the old client/server pair fingerprinted: archived=false outside the Archived view.
        const oldInbox = encodeConversationCursor(position, { ...base, archived: false })
        expect(decodeConversationCursor(oldInbox, { ...base, view: 'inbox' })).toEqual(position)
        const oldArchived = encodeConversationCursor(position, { ...base, archived: true })
        expect(decodeConversationCursor(oldArchived, { ...base, view: 'archived' })).toEqual(position)
        const oldUnread = encodeConversationCursor(position, { ...base, unread: true, archived: false })
        expect(decodeConversationCursor(oldUnread, { ...base, view: 'unread' })).toEqual(position)
        const oldReminders = encodeConversationCursor(position, { ...base, reminderState: 'active', archived: false })
        expect(decodeConversationCursor(oldReminders, { ...base, view: 'reminders' })).toEqual(position)
        const oldNeedsReply = encodeConversationCursor(position, { ...base, status: 'open', archived: false })
        expect(decodeConversationCursor(oldNeedsReply, { ...base, view: 'needs_reply' })).toEqual(position)
    })

    it('still rejects a legacy cursor against a different view, another org, or the awaiting view', () => {
        const oldInbox = encodeConversationCursor(position, { ...base, archived: false })
        expect(() => decodeConversationCursor(oldInbox, { ...base, view: 'archived' })).toThrow()
        expect(() => decodeConversationCursor(oldInbox, { ...base, view: 'awaiting' })).toThrow()
        expect(() => decodeConversationCursor(oldInbox, {
            ...base,
            organizationId: '33333333-3333-4333-8333-333333333333',
            view: 'inbox',
        })).toThrow()
    })

    it('binds a cursor to its view', () => {
        const cursor = encodeConversationCursor(position, { ...base, view: 'inbox' })
        expect(decodeConversationCursor(cursor, { ...base, view: 'inbox' })).toEqual(position)
        expect(() => decodeConversationCursor(cursor, { ...base, view: 'archived' })).toThrow()
    })
})

describe('supportsSkippedStatus (the deploy may land before migration 068)', () => {
    function fakeSql(rows: Array<{ def: string }>) {
        const state = { calls: 0 }
        const fn = (async () => {
            state.calls++
            return rows
        }) as unknown as UnifiedInboxSql
        return { sql: fn, state }
    }

    it('is false while the CHECK lists the old values, and true once it lists skipped', async () => {
        resetSkippedStatusCache()
        const before = fakeSql([{ def: "CHECK ((materialization_status = ANY (ARRAY['pending'::text, 'failed'::text])))" }])
        expect(await supportsSkippedStatus(before.sql, 0)).toBe(false)
        // Inside the re-probe window the negative answer is cached (no query).
        expect(await supportsSkippedStatus(before.sql, 1_000)).toBe(false)
        expect(before.state.calls).toBe(1)

        const after = fakeSql([{ def: "CHECK ((materialization_status = ANY (ARRAY['pending'::text, 'skipped'::text])))" }])
        expect(await supportsSkippedStatus(after.sql, 120_000)).toBe(true)
        // A positive answer is cached for good.
        expect(await supportsSkippedStatus(before.sql, 999_999)).toBe(true)
        expect(before.state.calls).toBe(1)
        resetSkippedStatusCache()
    })

    it('is true when the constraint does not exist (nothing can reject the value)', async () => {
        resetSkippedStatusCache()
        expect(await supportsSkippedStatus(fakeSql([]).sql, 0)).toBe(true)
        resetSkippedStatusCache()
    })
})
