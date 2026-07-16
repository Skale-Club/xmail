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
