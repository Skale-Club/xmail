/**
 * The dispatcher's provider boundary.
 *
 * Phase 18 made every origin (campaign, manual, agentic, and later Unified Inbox) go through
 * one durable dispatcher. Phase 19 (PROV-03/PROV-05) makes every origin go through one
 * provider adapter as well: these factories translate a claimed dispatch payload into a
 * content-level send, and translate the provider's normalized outcome back into the
 * dispatcher's result union.
 *
 * There is deliberately no `account.provider` branch left in this file. Outlook used to be
 * special-cased here onto Graph's JSON `message` shape, which silently dropped unsubscribe
 * and threading headers; provider differences now live only in outreach-provider.ts.
 */

import type { Campaign, EmailAccount, Lead, SequenceStep } from '../../db/schema'
import { sendOutreachEmail, sendThreadedReply } from './outreach-sender'
import type { OutreachUnsubscribeOptions } from './outreach-provider'
import type { DispatchProvider, ProviderDispatchResult } from './outreach-dispatch'

function toDispatch(result: Awaited<ReturnType<typeof sendThreadedReply>>): ProviderDispatchResult {
    if (result.success) {
        return {
            success: true,
            acceptance: 'accepted',
            messageId: result.messageId,
            finalHtml: result.finalHtml,
            finalText: result.finalText,
        }
    }
    return { success: false, acceptance: result.acceptance, failure: result.failure }
}

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
        send: async (input) => toDispatch(await sendOutreachEmail({
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
        })),
    }
}

export interface ThreadedDispatchProviderContext {
    account: EmailAccount
    fromName?: string | null
    replyTo?: string | null
    /**
     * Supplied by campaign-attached (agentic) follow-ups, which are bulk marketing and owe
     * the recipient a one-click opt-out. Omitted by transactional one-to-one sends.
     */
    unsubscribe?: OutreachUnsubscribeOptions | null
}

export function createThreadedDispatchProvider(
    context: ThreadedDispatchProviderContext,
): DispatchProvider {
    return {
        async send(input): Promise<ProviderDispatchResult> {
            return toDispatch(await sendThreadedReply({
                account: context.account,
                to: input.to,
                subject: input.subject,
                text: input.text ?? '',
                html: input.html ?? undefined,
                fromName: context.fromName,
                replyTo: context.replyTo,
                inReplyTo: input.inReplyTo,
                // Forwarding the frozen claim's chain is what keeps a retried reply in the
                // same thread rather than starting a new one.
                references: input.references,
                unsubscribe: context.unsubscribe,
                stableMessageId: input.stableMessageId,
            }))
        },
    }
}
