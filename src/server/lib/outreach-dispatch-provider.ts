import type { Campaign, EmailAccount, Lead, SequenceStep } from '../../db/schema'
import { sendMessageWithOutlook } from './outlook'
import { sendOutreachEmail, sendThreadedReply } from './outreach-sender'
import type { DispatchProvider, ProviderDispatchResult } from './outreach-dispatch'

export interface CampaignDispatchProviderContext {
    account: EmailAccount
    lead: Lead
    campaign: Campaign
    step: SequenceStep
    campaignLeadId: string
    trackingToken: string
    trackOpens?: boolean
    trackClicks?: boolean
    trackingBaseUrl?: string
    abVariant?: 'a' | 'b'
}

export function createCampaignDispatchProvider(
    context: CampaignDispatchProviderContext,
): DispatchProvider {
    return {
        send: (input) => sendOutreachEmail({
            ...context,
            step: {
                ...context.step,
                subject: input.subject,
                plainBody: input.text ?? null,
                htmlBody: input.html ?? null,
                subjectB: null,
                plainBodyB: null,
                htmlBodyB: null,
                abTestEnabled: false,
            },
            trackingToken: input.trackingToken ?? context.trackingToken,
            abVariant: 'a',
            stableMessageId: input.stableMessageId,
        }),
    }
}

export interface ThreadedDispatchProviderContext {
    account: EmailAccount
    fromName?: string | null
    replyTo?: string | null
}

export function createThreadedDispatchProvider(
    context: ThreadedDispatchProviderContext,
): DispatchProvider {
    return {
        async send(input): Promise<ProviderDispatchResult> {
            // Outlook already has a Graph send capability. Phase 19 owns MIME/header
            // parity; this adapter deliberately uses today's supported payload only.
            if (context.account.provider === 'outlook' && context.account.outlookMailboxId) {
                await sendMessageWithOutlook({
                    organizationId: context.account.organizationId,
                    mailboxId: context.account.outlookMailboxId,
                    fromAddress: context.account.email,
                    to: [input.to],
                    subject: input.subject,
                    htmlBody: input.html ?? undefined,
                    plainBody: input.text ?? undefined,
                })
                return { success: true, acceptance: 'accepted' }
            }

            return sendThreadedReply({
                account: context.account,
                to: input.to,
                subject: input.subject,
                text: input.text ?? '',
                html: input.html ?? undefined,
                fromName: context.fromName,
                replyTo: context.replyTo,
                inReplyTo: input.inReplyTo,
                stableMessageId: input.stableMessageId,
            })
        },
    }
}
