import { describe, expect, it, vi } from 'vitest'

/**
 * A follow-up's In-Reply-To / References must reach the bytes every provider ships. The composer
 * (outreach-provider.ts) writes them into the one MIME all three adapters transmit, so reading
 * the raw message handed to SMTP covers SMTP, the native relay and Outlook Graph alike.
 */

vi.mock('../../../db', () => ({ db: {}, queryClient: vi.fn() }))
// tracking.ts signs tokens at import time and needs a secret; nothing here injects tracking.
vi.mock('../tracking', () => ({ injectTracking: (html: string) => html }))
vi.mock('../../routes/outreach/unsubscribe', () => ({
    generateUnsubscribeLink: () => 'https://app.example.test/o/u/token',
}))

import { sendOutreachEmail } from '../outreach-sender'
import { readMimeHeader } from '../outreach-provider'

const account = {
    id: '00000000-0000-4000-8000-000000000002',
    organizationId: '00000000-0000-4000-8000-000000000001',
    email: 'seller@example.test',
    displayName: 'Seller',
    provider: 'smtp',
    smtpHost: 'smtp.example.test',
}
const lead = { id: 'lead-1', email: 'owner@barbershop.test', firstName: 'Sam', companyName: 'Sam Cuts' }
const campaign = { id: 'campaign-1', fromName: 'Vanildo', replyToEmail: null, contentLanguage: 'en' }
const step = {
    id: 'step-2',
    subject: 'Re: Quick question about {{companyName}}',
    plainBody: 'Bumping this. {{unsubscribeUrl}}',
    htmlBody: null,
    subjectB: null,
    plainBodyB: null,
    htmlBodyB: null,
}

async function sendAndCapture(threading: { inReplyTo?: string | null; references?: string | null }) {
    const sendMail = vi.fn(async (_message: { raw: Buffer }) => ({ response: '250 ok' }))
    const result = await sendOutreachEmail({
        account: account as never,
        lead: lead as never,
        campaign: campaign as never,
        step: step as never,
        campaignLeadId: 'cl-1',
        trackingToken: 'tok',
        stableMessageId: '<xmail-bbb@seller.test>',
        ...threading,
        providerDependencies: { createSmtpTransport: () => ({ sendMail }) as never },
    })
    expect(result.success).toBe(true)
    return sendMail.mock.calls[0][0].raw.toString('utf8')
}

describe('follow-up threading headers', () => {
    it('writes In-Reply-To and the References chain into the composed message', async () => {
        const raw = await sendAndCapture({
            inReplyTo: '<xmail-aaa@seller.test>',
            references: '<xmail-aaa@seller.test>',
        })

        expect(readMimeHeader(raw, 'In-Reply-To')).toBe('<xmail-aaa@seller.test>')
        expect(readMimeHeader(raw, 'References')).toBe('<xmail-aaa@seller.test>')
        // The step's subject is a template; it is interpolated for the lead at send time.
        expect(readMimeHeader(raw, 'Subject')).toBe('Re: Quick question about Sam Cuts')
        expect(readMimeHeader(raw, 'List-Unsubscribe')).toContain('https://app.example.test/o/u/token')
    })

    it('carries a longer chain for step 3, parent last', async () => {
        const raw = await sendAndCapture({
            inReplyTo: '<xmail-bbb@seller.test>',
            references: '<xmail-aaa@seller.test> <xmail-bbb@seller.test>',
        })

        expect(readMimeHeader(raw, 'In-Reply-To')).toBe('<xmail-bbb@seller.test>')
        expect(readMimeHeader(raw, 'References')).toBe('<xmail-aaa@seller.test> <xmail-bbb@seller.test>')
    })

    it('adds no threading headers to the first email', async () => {
        const raw = await sendAndCapture({})

        expect(readMimeHeader(raw, 'In-Reply-To')).toBeNull()
        expect(readMimeHeader(raw, 'References')).toBeNull()
    })
})
