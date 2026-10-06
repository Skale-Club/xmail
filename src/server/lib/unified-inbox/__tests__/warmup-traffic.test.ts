import { describe, expect, it } from 'vitest'
import {
    createWarmupExclusion,
    isWarmupMessageId,
    isWarmupTraffic,
    warmupMessageIdTokens,
} from '../warmup-traffic'
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

describe('isWarmupTraffic - counterpart rule', () => {
    it('excludes a message whose only counterpart is a mesh address (Icemail sender <-> mesh)', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            counterpartAddresses: ['Contato@Skale.club'],
            meshAddresses: MESH,
        })).toBe(true)
    })

    it('handles display-name forms and brackets', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            counterpartAddresses: ['"Agenda" <agenda@xkedule.com>'],
            meshAddresses: MESH,
        })).toBe(true)
    })

    it('keeps info@ conversations with people outside the mesh', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            counterpartAddresses: ['owner@barbershop.example'],
            messageIds: ['abc123@mail.gmail.com'],
            meshAddresses: MESH,
        })).toBe(false)
    })

    it('keeps a message that ALSO involves someone outside the mesh', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            counterpartAddresses: ['contato@skale.club', 'owner@barbershop.example'],
            meshAddresses: MESH,
        })).toBe(false)
    })

    it('excludes an outbound send whose every recipient is in the mesh', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            counterpartAddresses: ['contato@skale.club', 'agenda@xkedule.com'],
            meshAddresses: MESH,
        })).toBe(true)
    })

    it('does not treat a missing counterpart as a mesh match', () => {
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            counterpartAddresses: [null, undefined, ''],
            meshAddresses: MESH,
        })).toBe(false)
        expect(isWarmupTraffic({ accountWarmupOnly: false, counterpartAddresses: [], meshAddresses: new Set() })).toBe(false)
    })
})

describe('isWarmupTraffic - Message-ID shape', () => {
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
            counterpartAddresses: ['forwarder@alias.example'],
            messageIds: warmupMessageIdTokens({ messageId: 'x@y.test', inReplyTo: `<${WARMUP_ID}>` }),
            meshAddresses: MESH,
        })).toBe(true)
    })

    it('reads References tokens too', () => {
        const tokens = warmupMessageIdTokens({ references: `<a@x.test> <${WARMUP_ID}>` })
        expect(tokens).toContain(WARMUP_ID)
        expect(isWarmupTraffic({
            accountWarmupOnly: false,
            counterpartAddresses: ['p@q.test'],
            messageIds: tokens,
            meshAddresses: MESH,
        })).toBe(true)
    })
})

describe('createWarmupExclusion', () => {
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

    it('keeps the fingerprint of a view-less filter set unchanged', () => {
        expect(fingerprintConversationFilters(base)).toBe(fingerprintConversationFilters({ ...base, view: null }))
    })

    it('binds a cursor to its view', () => {
        const position = { lastMessageAt: '2026-10-06 12:00:00', id: '22222222-2222-4222-8222-222222222222' }
        const cursor = encodeConversationCursor(position, { ...base, view: 'inbox' })
        expect(decodeConversationCursor(cursor, { ...base, view: 'inbox' })).toEqual(position)
        expect(() => decodeConversationCursor(cursor, { ...base, view: 'archived' })).toThrow()
    })
})
