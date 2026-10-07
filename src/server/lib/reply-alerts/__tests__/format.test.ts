import { describe, expect, it } from 'vitest'
import {
    conversationLink,
    formatFirstAlert,
    formatReminder,
    formatSummary,
    formatWaiting,
    leadDisplayName,
    replySnippet,
    SNIPPET_MAX_CHARS,
    SUMMARY_MAX_LINES,
} from '../format'
import type { PendingReply } from '../plan'

const at = (iso: string) => new Date(iso)
const BASE = 'https://mail.skale.club'

function row(overrides: Partial<PendingReply> = {}): PendingReply {
    return {
        organizationId: 'org-1',
        conversationId: '11111111-2222-3333-4444-555555555555',
        replyMessageId: 'msg-1',
        repliedAt: at('2026-07-15T12:00:00Z'),
        isRead: false,
        alert: null,
        leadName: 'Boston Blendz',
        fromAddress: 'david.c@bostonblendz.com',
        inboxAddress: 'vanildo.skale@tryskaleclub.com',
        plainBody: 'Sounds good, send me the details.',
        htmlBody: null,
        ...overrides,
    }
}

describe('leadDisplayName', () => {
    it('prefers custom_fields.shortName', () => {
        expect(leadDisplayName({ customFields: { shortName: ' Boston Blendz ' }, companyName: 'Boston Blendz LLC' }))
            .toBe('Boston Blendz')
    })

    it('falls back to the company name when shortName is missing or blank', () => {
        expect(leadDisplayName({ customFields: {}, companyName: 'Boston Blendz LLC' })).toBe('Boston Blendz LLC')
        expect(leadDisplayName({ customFields: { shortName: '   ' }, companyName: 'Boston Blendz LLC' })).toBe('Boston Blendz LLC')
        expect(leadDisplayName({ customFields: null, companyName: 'Boston Blendz LLC' })).toBe('Boston Blendz LLC')
    })

    it('reads a double-encoded jsonb string', () => {
        expect(leadDisplayName({ customFields: '{"shortName":"Fade Lab"}', companyName: 'X' })).toBe('Fade Lab')
    })

    it('falls back to the e-mail domain, then to a neutral label', () => {
        expect(leadDisplayName({ companyName: null, email: 'owner@fadelab.com' })).toBe('fadelab.com')
        expect(leadDisplayName({})).toBe('um lead')
    })
})

describe('replySnippet', () => {
    it('returns short replies untouched', () => {
        expect(replySnippet('Sounds good', null)).toBe('Sounds good')
    })

    it('truncates to 300 characters with an ellipsis', () => {
        const long = 'a'.repeat(500)
        const snippet = replySnippet(long, null)
        expect(Array.from(snippet)).toHaveLength(SNIPPET_MAX_CHARS + 1)
        expect(snippet.endsWith('…')).toBe(true)
    })

    it('does not cut an emoji in half', () => {
        const snippet = replySnippet('💈'.repeat(400), null)
        expect(snippet.startsWith('💈')).toBe(true)
        expect(Array.from(snippet)).toHaveLength(SNIPPET_MAX_CHARS + 1)
    })

    it('removes "On ... wrote:" quoted history', () => {
        const body = 'Yes, call me tomorrow.\n\nOn Tue, Oct 6, 2026 at 3:00 PM Vanildo <vanildo@tryskaleclub.com> wrote:\n> Hi David\n> I wanted to ask'
        expect(replySnippet(body, null)).toBe('Yes, call me tomorrow.')
    })

    it('removes an attribution that wraps onto two lines', () => {
        const body = 'Interested.\n\nOn Tue, Oct 6, 2026 at 3:00 PM, Vanildo Junior <vanildo.skale@tryskaleclub.com>\nwrote:\n> hi'
        expect(replySnippet(body, null)).toBe('Interested.')
    })

    it('removes Portuguese attribution, ">" lines and Outlook header blocks', () => {
        expect(replySnippet('Pode ser.\nEm ter., 6 de out. de 2026 às 15:00, Vanildo escreveu:\n> oi', null)).toBe('Pode ser.')
        expect(replySnippet('Not now.\n\n> older\n> older', null)).toBe('Not now.')
        expect(replySnippet('Maybe later.\n\nFrom: Vanildo <v@x.com>\nSent: Tuesday, October 6, 2026 3:00 PM\nTo: David\nSubject: hi\n\nHi David', null))
            .toBe('Maybe later.')
        expect(replySnippet('Ok\n-----Original Message-----\nFrom: x', null)).toBe('Ok')
    })

    it('keeps text that merely mentions "From:" without a header block', () => {
        expect(replySnippet('From: what I saw, this looks fine.', null)).toBe('From: what I saw, this looks fine.')
    })

    it('falls back to HTML, dropping blockquotes, tags and scripts', () => {
        const html = '<style>p{color:red}</style><div>Yes please</div><blockquote>old thread</blockquote>'
        expect(replySnippet(null, html)).toBe('Yes please')
        expect(replySnippet('   ', '<p>Hi &amp; hello</p>')).toBe('Hi & hello')
    })

    it('returns an empty string when nothing was written', () => {
        expect(replySnippet(null, null)).toBe('')
        expect(replySnippet('> only quoted', null)).toBe('')
    })
})

describe('formatWaiting', () => {
    it.each([
        [20_000, 'menos de 1 min'],
        [45 * 60_000, '45 min'],
        [60 * 60_000, '1h'],
        [4 * 60 * 60_000 + 59 * 60_000, '4h'],
        [47 * 60 * 60_000, '47h'],
        [72 * 60 * 60_000, '3 dias'],
    ])('%i ms -> %s', (ms, text) => {
        expect(formatWaiting(ms)).toBe(text)
    })

    it('never goes negative', () => {
        expect(formatWaiting(-5_000)).toBe('menos de 1 min')
    })
})

describe('conversationLink', () => {
    it('points at the Unified Inbox with the conversation query param', () => {
        expect(conversationLink(BASE, 'abc')).toBe('https://mail.skale.club/outreach/unified-inbox?conversation=abc')
    })

    it('tolerates a trailing slash on the base', () => {
        expect(conversationLink(`${BASE}/`, 'abc')).toBe('https://mail.skale.club/outreach/unified-inbox?conversation=abc')
    })
})

describe('formatFirstAlert', () => {
    it('names the shop, the sender, the inbox, the snippet and the link', () => {
        const { title, body } = formatFirstAlert(row(), BASE)
        expect(title).toContain('Resposta nova da Boston Blendz')
        expect(body).toContain('De: david.c@bostonblendz.com, para vanildo.skale@tryskaleclub.com')
        expect(body).toContain('Sounds good, send me the details.')
        expect(body).toContain('https://mail.skale.club/outreach/unified-inbox?conversation=11111111-2222-3333-4444-555555555555')
    })

    it('escapes HTML coming from the lead so Telegram does not reject the message', () => {
        const { title, body } = formatFirstAlert(row({
            leadName: 'Fade <b>& Co',
            plainBody: 'I <3 this & that <script>',
        }), BASE)
        expect(title).toContain('Fade &lt;b&gt;&amp; Co')
        expect(body).toContain('I &lt;3 this &amp; that &lt;script&gt;')
        expect(body).not.toContain('<script>')
    })

    it('says so when the reply has no text', () => {
        expect(formatFirstAlert(row({ plainBody: null, htmlBody: null }), BASE).body).toContain('(sem texto na resposta)')
    })
})

describe('formatReminder', () => {
    const now = at('2026-07-15T16:00:00Z')

    it('uses the unread wording', () => {
        const { title } = formatReminder(row({ isRead: false }), BASE, now)
        expect(title).toContain('Lembrete: a resposta da Boston Blendz está sem leitura há 4h')
    })

    it('uses the read-but-unanswered wording', () => {
        const { title } = formatReminder(row({ isRead: true }), BASE, now)
        expect(title).toContain('Lembrete: a resposta da Boston Blendz foi lida, mas está sem resposta há 4h')
    })

    it('keeps the snippet and the link', () => {
        const { body } = formatReminder(row(), BASE, now)
        expect(body).toContain('Sounds good')
        expect(body).toContain('unified-inbox?conversation=')
    })
})

describe('formatSummary', () => {
    const now = at('2026-07-15T12:00:00Z')

    it('counts and lists one line per pending reply with a link, oldest first', () => {
        const older = row({ conversationId: 'c-old', leadName: 'Old Shop', repliedAt: at('2026-07-14T12:00:00Z'), isRead: true })
        const newer = row({ conversationId: 'c-new', leadName: 'New Shop', repliedAt: at('2026-07-15T08:00:00Z') })
        const { title, body } = formatSummary([newer, older], 'morning', BASE, now)
        expect(title).toContain('Bom dia: 2 respostas esperando você')
        const lines = body.split('\n')
        expect(lines).toHaveLength(2)
        expect(lines[0]).toContain('Old Shop (lida, sem resposta, há 24h)')
        expect(lines[0]).toContain('conversation=c-old')
        expect(lines[1]).toContain('New Shop (sem leitura, há 4h)')
    })

    it('uses the singular for one reply and the reminder title for a digest', () => {
        expect(formatSummary([row()], 'morning', BASE, now).title).toContain('1 resposta esperando você')
        expect(formatSummary([row(), row()], 'digest', BASE, now).title).toContain('Lembrete: 2 respostas esperando você')
    })

    it('caps the list and says how many were left out, staying under the Telegram limit', () => {
        const many = Array.from({ length: 40 }, (_, i) => row({
            conversationId: `11111111-2222-3333-4444-${String(i).padStart(12, '0')}`,
            leadName: 'A very long barbershop name that goes on and on and on',
        }))
        const { title, body } = formatSummary(many, 'morning', BASE, now)
        const lines = body.split('\n')
        expect(lines).toHaveLength(SUMMARY_MAX_LINES + 1)
        expect(lines[lines.length - 1]).toContain(`e mais ${40 - SUMMARY_MAX_LINES}`)
        expect(`${title}\n\n${body}`.length).toBeLessThan(4096)
    })

    it('never cuts inside an anchor tag, however long the names', () => {
        const huge = Array.from({ length: 15 }, (_, i) => row({ conversationId: `c-${i}`, leadName: 'N'.repeat(80) }))
        const { body } = formatSummary(huge, 'morning', BASE, now)
        const opens = (body.match(/<a /g) ?? []).length
        const closes = (body.match(/<\/a>/g) ?? []).length
        expect(opens).toBe(closes)
    })
})
