import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendOutreachEmail, sendThreadedReply } = vi.hoisted(() => ({
    sendOutreachEmail: vi.fn(),
    sendThreadedReply: vi.fn(),
}))

vi.mock('../outreach-sender', () => ({
    sendOutreachEmail,
    sendThreadedReply,
}))

import {
    createCampaignDispatchProvider,
    createThreadedDispatchProvider,
} from '../outreach-dispatch-provider'

const repositoryRoot = resolve(process.cwd())

function source(relativePath: string): string {
    return readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
}

describe('outreach entrypoint wiring', () => {
    it.each([
        'src/server/jobs/processOutreachSequences.ts',
        'src/server/jobs/processFollowUps.ts',
        'src/server/routes/outreach/send-message.ts',
    ])('%s delegates delivery to the durable dispatcher only', (relativePath) => {
        const contents = source(relativePath)
        expect(contents).toContain('dispatchOutreachMessage')
        expect(contents).not.toMatch(/\bsendOutreachEmail\s*\(/)
        expect(contents).not.toMatch(/\bsendThreadedReply\s*\(/)
        expect(contents).not.toMatch(/\brelayMessage\s*\(/)
    })

    it('uses stable origin-specific idempotency keys', () => {
        expect(source('src/server/jobs/processOutreachSequences.ts'))
            .toContain('campaign:${campaignLead.id}:${emailStep.id}')
        expect(source('src/server/jobs/processFollowUps.ts'))
            .toContain('agentic:${cl.id}:${cl.lastReplyMessageId}:${cl.followUpCount + 1}')
        expect(source('src/server/routes/outreach/send-message.ts'))
            .toContain('manual:${requestId}')
    })
})

describe('shared dispatch providers', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('forwards the dispatcher message id to campaign delivery', async () => {
        sendOutreachEmail.mockResolvedValue({ success: true, acceptance: 'accepted' })
        const provider = createCampaignDispatchProvider({
            account: { id: 'account' },
            lead: { id: 'lead' },
            campaign: { id: 'campaign' },
            step: { id: 'step' },
            campaignLeadId: 'campaign-lead',
            trackingToken: 'token',
            abVariant: 'a',
        } as never)

        await provider.send({ stableMessageId: '<stable@outreach.local>' } as never)

        expect(sendOutreachEmail).toHaveBeenCalledWith(expect.objectContaining({
            stableMessageId: '<stable@outreach.local>',
            campaignLeadId: 'campaign-lead',
            trackingToken: 'token',
        }))
    })

    it('forwards content, threading, and the stable message id for manual or agentic delivery', async () => {
        sendThreadedReply.mockResolvedValue({ success: true, acceptance: 'accepted' })
        const provider = createThreadedDispatchProvider({
            account: { id: 'account' },
            fromName: 'Seller',
            replyTo: 'reply@example.com',
        } as never)

        await provider.send({
            to: 'lead@example.com',
            subject: 'Re: hello',
            text: 'Follow-up',
            html: '<p>Follow-up</p>',
            inReplyTo: 'inbound@example.com',
            references: '<root@example.com> <inbound@example.com>',
            stableMessageId: '<stable@outreach.local>',
        } as never)

        expect(sendThreadedReply).toHaveBeenCalledWith(expect.objectContaining({
            to: 'lead@example.com',
            inReplyTo: 'inbound@example.com',
            // The frozen claim's chain must survive a retry, or the reply starts a new thread.
            references: '<root@example.com> <inbound@example.com>',
            stableMessageId: '<stable@outreach.local>',
        }))
    })

    // PROV-03: Outlook was special-cased here onto Graph's JSON `message` shape, which has
    // nowhere to put List-Unsubscribe and returns no Message-ID. Provider differences now
    // belong to outreach-provider.ts alone.
    it('keeps provider branching out of the dispatch boundary', () => {
        const contents = source('src/server/lib/outreach-dispatch-provider.ts')
        expect(contents).not.toMatch(/\bsendMessageWithOutlook\b/)
        expect(contents).not.toMatch(/provider === 'outlook'/)
    })

    it('routes outreach content through the single compose-once provider module', () => {
        const sender = source('src/server/lib/outreach-sender.ts')
        expect(sender).toContain('sendComposedOutreachMessage')
        expect(sender).not.toMatch(/provider === 'native'/)
        expect(sender).not.toMatch(/provider === 'outlook'/)
    })

    it('sends Outlook outreach as MIME rather than the header-losing JSON shape', () => {
        const provider = source('src/server/lib/outreach-provider.ts')
        expect(provider).toContain('sendMimeMessageWithOutlook')
        expect(provider).not.toMatch(/\bsendMessageWithOutlook\b/)
    })
})
