import { describe, expect, it } from 'vitest'
import {
    isConversationPending,
    needsFirstAlert,
    planAlerts,
    REMINDER_DIGEST_THRESHOLD,
    waitingState,
    type ConversationFacts,
    type PendingReply,
} from '../plan'

const at = (iso: string) => new Date(iso)

describe('isConversationPending', () => {
    const base: ConversationFacts = {
        status: 'open',
        archivedAt: null,
        lastInboundAt: at('2026-07-15T14:00:00Z'),
        lastOutboundAt: null,
        latestReplyAt: at('2026-07-15T14:00:00Z'),
    }

    it('is pending when a reply arrived and nobody answered', () => {
        expect(isConversationPending(base)).toBe(true)
    })

    it('is pending when our last outbound is older than the reply (cold email, then reply)', () => {
        expect(isConversationPending({ ...base, lastOutboundAt: at('2026-07-14T14:00:00Z') })).toBe(true)
    })

    it('stops when we answered after the reply', () => {
        expect(isConversationPending({ ...base, lastOutboundAt: at('2026-07-15T15:00:00Z') })).toBe(false)
    })

    it('treats an answer at the exact same instant as answered', () => {
        expect(isConversationPending({ ...base, lastOutboundAt: base.lastInboundAt })).toBe(false)
    })

    it('stops when the conversation is marked resolved (closed)', () => {
        expect(isConversationPending({ ...base, status: 'closed' })).toBe(false)
    })

    it('stops when the conversation is archived', () => {
        expect(isConversationPending({ ...base, archivedAt: at('2026-07-15T15:00:00Z') })).toBe(false)
    })

    it('is not pending without any human reply (only an auto-reply or a bounce arrived)', () => {
        expect(isConversationPending({ ...base, latestReplyAt: null })).toBe(false)
        expect(isConversationPending({ ...base, lastInboundAt: null, latestReplyAt: null })).toBe(false)
    })

    it('is not pending when the human reply was answered and only an out-of-office landed later', () => {
        expect(isConversationPending({
            ...base,
            latestReplyAt: at('2026-07-15T14:00:00Z'),
            lastOutboundAt: at('2026-07-15T15:00:00Z'),
            lastInboundAt: at('2026-07-15T16:00:00Z'), // the auto-reply moved last_inbound_at
        })).toBe(false)
    })

    it('is pending again after a NEW reply following our answer', () => {
        expect(isConversationPending({
            ...base,
            lastOutboundAt: at('2026-07-15T15:00:00Z'),
            lastInboundAt: at('2026-07-16T09:00:00Z'),
            latestReplyAt: at('2026-07-16T09:00:00Z'),
        })).toBe(true)
    })
})

describe('waitingState', () => {
    it('is unread until someone opens the conversation', () => {
        expect(waitingState({ isRead: false })).toBe('unread')
        expect(waitingState({ isRead: true })).toBe('read')
    })
})

let seq = 0
function row(overrides: Partial<PendingReply> = {}): PendingReply {
    seq++
    return {
        organizationId: 'org-1',
        conversationId: `conv-${seq}`,
        replyMessageId: `msg-${seq}`,
        repliedAt: at('2026-07-15T13:00:00Z'),
        isRead: false,
        alert: null,
        leadName: 'Boston Blendz',
        fromAddress: 'david.c@bostonblendz.com',
        inboxAddress: 'vanildo.skale@tryskaleclub.com',
        plainBody: 'Sounds good',
        htmlBody: null,
        ...overrides,
    }
}

/** A row already alerted about its current reply. */
function alerted(lastAlertedAt: string, overrides: Partial<PendingReply> = {}): PendingReply {
    const base = row(overrides)
    return { ...base, alert: { replyMessageId: base.replyMessageId, lastAlertedAt: at(lastAlertedAt) } }
}

describe('needsFirstAlert', () => {
    it('is true for a reply never alerted', () => {
        expect(needsFirstAlert(row())).toBe(true)
    })

    it('is false once that same reply was alerted', () => {
        expect(needsFirstAlert(alerted('2026-07-15T13:05:00Z'))).toBe(false)
    })

    it('is true again for a NEW reply in an already-alerted conversation', () => {
        const r = row({ alert: { replyMessageId: 'older-message', lastAlertedAt: at('2026-07-15T10:00:00Z') } })
        expect(needsFirstAlert(r)).toBe(true)
    })
})

describe('planAlerts', () => {
    const noon = at('2026-07-15T16:00:00Z') // 12:00 EDT

    it('sends the immediate alert for a fresh reply', () => {
        const fresh = row()
        const plan = planAlerts([fresh], noon)
        expect(plan.first).toEqual([fresh])
        expect(plan.reminders).toEqual([])
        expect(plan.summary).toBeNull()
    })

    it('sends the immediate alert even in the quiet window', () => {
        const fresh = row()
        const plan = planAlerts([fresh], at('2026-07-15T03:00:00Z')) // 23:00 EDT
        expect(plan.first).toEqual([fresh])
    })

    it('stays silent at night about alerted conversations, however overdue', () => {
        const plan = planAlerts([alerted('2026-07-14T14:00:00Z')], at('2026-07-15T06:00:00Z')) // 02:00 EDT
        expect(plan).toEqual({ first: [], reminders: [], summary: null })
    })

    it('does not remind before two hours have passed', () => {
        const plan = planAlerts([alerted('2026-07-15T15:00:00Z')], noon) // alerted 11:00 EDT
        expect(plan.reminders).toEqual([])
        expect(plan.summary).toBeNull()
    })

    it('reminds after two hours, in the window', () => {
        const due = alerted('2026-07-15T14:00:00Z') // alerted 10:00 EDT, now 12:00
        const plan = planAlerts([due], noon)
        expect(plan.reminders).toEqual([due])
        expect(plan.summary).toBeNull()
    })

    it('sends the morning summary, not reminders, when pending replies went through the night', () => {
        const overnight = alerted('2026-07-15T00:30:00Z') // 20:30 EDT the evening before
        const recent = alerted('2026-07-15T11:55:00Z') // 07:55 EDT, also before the 08:00 anchor
        const plan = planAlerts([overnight, recent], at('2026-07-15T12:00:00Z')) // 08:00 EDT
        expect(plan.summary?.reason).toBe('morning')
        expect(plan.summary?.rows).toEqual([overnight, recent])
        expect(plan.reminders).toEqual([])
    })

    it('does not repeat the morning summary once everything was covered after 08:00', () => {
        const covered = alerted('2026-07-15T12:00:00Z') // summary sent at 08:00 EDT
        const plan = planAlerts([covered], at('2026-07-15T12:05:00Z'))
        expect(plan).toEqual({ first: [], reminders: [], summary: null })
    })

    it('keeps the new-reply alert separate from the morning summary', () => {
        const fresh = row()
        const overnight = alerted('2026-07-15T02:00:00Z')
        const plan = planAlerts([fresh, overnight], at('2026-07-15T12:00:00Z'))
        expect(plan.first).toEqual([fresh])
        expect(plan.summary?.rows).toEqual([overnight])
    })

    it('batches many due reminders into one digest', () => {
        const rows = Array.from({ length: REMINDER_DIGEST_THRESHOLD + 1 }, () => alerted('2026-07-15T14:00:00Z'))
        const plan = planAlerts(rows, noon)
        expect(plan.reminders).toEqual([])
        expect(plan.summary?.reason).toBe('digest')
        expect(plan.summary?.rows).toHaveLength(REMINDER_DIGEST_THRESHOLD + 1)
    })

    it('sends reminders one by one up to the digest threshold', () => {
        const rows = Array.from({ length: REMINDER_DIGEST_THRESHOLD }, () => alerted('2026-07-15T14:00:00Z'))
        const plan = planAlerts(rows, noon)
        expect(plan.reminders).toHaveLength(REMINDER_DIGEST_THRESHOLD)
        expect(plan.summary).toBeNull()
    })

    it('works across the DST change: 08:00 EDT on 2026-03-08 is 12:00Z', () => {
        const overnight = alerted('2026-03-08T02:00:00Z')
        expect(planAlerts([overnight], at('2026-03-08T11:59:00Z')).summary).toBeNull() // 07:59 EDT: quiet
        expect(planAlerts([overnight], at('2026-03-08T12:00:00Z')).summary?.reason).toBe('morning')
    })
})
