import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('Phase 18 review regressions', () => {
    it('scopes reply and bounce Message-ID matches to the active account and organization', () => {
        const replies = source('src/server/jobs/processReplies.ts')
        const bounces = source('src/server/jobs/processBounces.ts')

        expect(replies).toContain('eq(outreachEmails.emailAccountId, accountId)')
        expect(replies).toContain('eq(emailAccounts.organizationId, outreachEmails.organizationId)')
        expect(bounces).toContain('eq(outreachEmails.emailAccountId, accountId)')
        expect(bounces).toContain('eq(outreachEmails.organizationId, organizationId)')
        expect(bounces).not.toContain('LIKE LOWER')
    })

    it('persists bounded reply context in the same campaign-lead mutation that schedules agentic work', () => {
        const replies = source('src/server/jobs/processReplies.ts')

        expect(replies).toContain('lastReplyMessageId: inbound.messageId')
        expect(replies).toContain('lastReplyText: inbound.text')
        expect(replies).toContain('campaigns.agentic_followup_enabled = TRUE')
        expect(replies).not.toContain('await scheduleAgenticFollowUpIfEnabled(')
    })

    it('uses guarded progress finalization and one conditional campaign completion update', () => {
        const processor = source('src/server/jobs/processOutreachSequences.ts')
        const campaignsRoute = source('src/server/routes/outreach/campaigns.ts')

        expect(processor).toContain('eq(campaignLeads.currentStepId, sequenceAction.step.id)')
        expect(processor).toContain('outreach.processor.terminal_race_preserved')
        expect(processor).toContain('UPDATE campaigns AS campaign')
        expect(processor).not.toContain('const completedCampaigns = await db')
        expect(processor).toContain('campaign_leads.next_follow_up_at IS NOT NULL')
        expect(campaignsRoute).toContain('FOR UPDATE')
        expect(campaignsRoute).toContain("code: 'campaign_enrollment_closed'")
    })
})

describe('Phase 23 review regressions', () => {
    // M-1: the suggestion-path context loader must stamp each message's organization/conversation from
    // the actual DB ROW (like the autonomous runtime resolver does), NOT from the request args — so
    // buildInboxAiContext's attribution_mismatch guard is a LIVE second line of defense rather than
    // inert. Stamping from the args would make the guard incapable of ever firing on that path.
    it('stamps suggestion-path AI context attribution from the persisted message row', () => {
        const unifiedInbox = source('src/server/routes/outreach/unified-inbox.ts')

        // The select must fetch the row's own scope columns, and the projection must use them.
        expect(unifiedInbox).toContain('organizationId: outreachConversationMessages.organizationId')
        expect(unifiedInbox).toContain('conversationId: outreachConversationMessages.conversationId')
        expect(unifiedInbox).toContain('organizationId: m.organizationId')
        expect(unifiedInbox).toContain('conversationId: m.conversationId')
    })

    // M-2: the pre-dispatch pause recheck must not be silently skippable — `reloadAutonomy` is a
    // REQUIRED dep with no stale fallback, so a caller cannot lose the pause race by omitting it.
    it('keeps reloadAutonomy a required dependency with no stale-autonomy fallback', () => {
        const automation = source('src/server/lib/inbox-ai-automation.ts')

        expect(automation).toContain('reloadAutonomy: (run: AiRunRecord) => Promise<EffectiveAutonomyInputs | null>')
        expect(automation).toContain('const fresh = await deps.reloadAutonomy(claimed)')
        // The removed fallback that returned the stale pre-model autonomy must not come back.
        expect(automation).not.toContain('deps.reloadAutonomy ?? (async () => resolution')
    })

    // C-1: the autonomous follow-up ceiling must be enforced against the advancing audit-derived count,
    // never the dead campaign_leads.follow_up_count column (nothing increments it on the send path).
    it('derives the autonomous follow-up ceiling source from the audit trail, not follow_up_count', () => {
        const runtime = source('src/server/lib/inbox-ai-automation-runtime.ts')

        expect(runtime).toContain('countAutonomousSends')
        expect(runtime).toContain('autonomousFollowUpsSent = await countAutonomousSends(')
        // The frozen column must no longer be read as the ceiling source.
        expect(runtime).not.toContain('autonomousFollowUpsSent: campaignLead.followUpCount')
    })
})
