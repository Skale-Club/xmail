import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function listHermesTools() {
    const message = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n'
    const result = spawnSync(process.execPath, [path.join(process.cwd(), 'hermes', 'xmail-mcp', 'server.mjs')], {
        input: message,
        encoding: 'utf8',
        timeout: 5_000,
    })
    if (result.status !== 0) throw new Error(result.stderr || 'Hermes MCP exited unsuccessfully')
    return JSON.parse(result.stdout.trim()).result.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>
}

describe('Hermes MCP capability contract', () => {
    it('exposes the complete governed workflow', () => {
        const names = new Set(listHermesTools().map((tool) => tool.name))
        expect(names.size).toBeGreaterThanOrEqual(15)
        for (const required of [
            'xmail_search_prospects',
            'xmail_request_enrichment_approval',
            'xmail_get_approval',
            'xmail_execute_approved_enrichment',
            'xmail_assess_prospect_candidate',
            'xmail_import_prospect_candidates',
            'xmail_create_campaign_draft',
            'xmail_enroll_campaign_draft',
            'xmail_request_campaign_activation',
            'xmail_pause_campaign',
            'xmail_poll_events',
        ]) {
            expect(names.has(required), `missing ${required}`).toBe(true)
        }
    })

    it('has no direct send or direct activation capability', () => {
        const names = listHermesTools().map((tool) => tool.name)
        expect(names.some((name) => /send|activate_campaign|dispatch/i.test(name))).toBe(false)
        expect(names).toContain('xmail_request_campaign_activation')
    })

    it('keeps every tool input bounded and object-shaped', () => {
        for (const tool of listHermesTools()) {
            expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
        }
    })

    it('lets the assessment tool optionally report LLM token usage', () => {
        const tool = listHermesTools().find((entry) => entry.name === 'xmail_assess_prospect_candidate')
        expect(tool).toBeDefined()
        const schema = tool!.inputSchema as {
            required?: string[]
            properties: Record<string, { type: string; minimum?: number }>
        }
        for (const property of ['prompt_tokens', 'completion_tokens']) {
            expect(schema.properties[property]).toMatchObject({ type: 'integer', minimum: 0 })
            expect(schema.required ?? []).not.toContain(property)
        }
    })

    it('exposes campaign copy read/edit/revert, bounded, with the audit and warning duties in the description', () => {
        const tools = listHermesTools() as Array<{
            name: string
            description?: string
            inputSchema: { required?: string[]; properties: Record<string, unknown> }
        }>
        const byName = new Map(tools.map((tool) => [tool.name, tool]))
        for (const name of ['outreach_campaign_sequence_get', 'outreach_campaign_step_update', 'outreach_campaign_step_revert']) {
            expect(byName.has(name), `missing ${name}`).toBe(true)
        }
        const update = byName.get('outreach_campaign_step_update')!
        expect(update.inputSchema.required).toEqual(['campaignId', 'stepOrder'])
        // The A/B variant B columns and the step type are out of reach of the agent.
        expect(Object.keys(update.inputSchema.properties).sort()).toEqual([
            'campaignId', 'delayHours', 'delayHoursMax', 'htmlBody', 'plainBody', 'reason', 'stepOrder', 'subject',
        ])
        for (const name of ['outreach_campaign_step_update', 'outreach_campaign_step_revert']) {
            const description = byName.get(name)!.description ?? ''
            expect(description, name).toMatch(/audited/i)
            expect(description, name).toMatch(/future sends only/i)
            expect(description, name).toMatch(/cannot send/i)
            expect(description, name).toMatch(/warnings/i)
            expect(description, name).toMatch(/Vanildo/)
        }
    })
    it('exposes the outreach:manage tools with the destructive ones gated by confirm and no way to send or activate', () => {
        const tools = listHermesTools() as Array<{
            name: string
            description?: string
            inputSchema: { required?: string[]; properties: Record<string, unknown> }
        }>
        const byName = new Map(tools.map((tool) => [tool.name, tool]))
        const manage = [
            'outreach_campaign_get', 'outreach_campaign_update_settings', 'outreach_campaign_duplicate', 'outreach_campaign_resume',
            'outreach_campaign_leads_list', 'outreach_lead_get', 'outreach_lead_update', 'outreach_campaign_lead_remove',
            'outreach_lead_lists_list', 'outreach_lead_list_create', 'outreach_lead_list_update',
            'outreach_email_accounts_list', 'outreach_email_account_update',
            'outreach_inbox_threads_list', 'outreach_inbox_thread_get',
            'outreach_analytics_campaigns', 'outreach_analytics_email_accounts',
            'outreach_suppressions_list', 'outreach_suppression_add', 'outreach_suppression_remove',
        ]
        for (const name of manage) expect(byName.has(name), `missing ${name}`).toBe(true)

        // Destructive tools carry confirm in the schema and say so.
        for (const name of ['outreach_campaign_lead_remove', 'outreach_suppression_remove']) {
            const tool = byName.get(name)!
            expect(Object.keys(tool.inputSchema.properties), name).toContain('confirm')
            expect(tool.description, name).toMatch(/confirm=true/)
        }
        // The settings update has no status, replyToEmail or autonomy field; the inbox update has
        // no credential field and no warmupOnly/warmupSource switch.
        const settings = Object.keys(byName.get('outreach_campaign_update_settings')!.inputSchema.properties)
        for (const forbidden of ['status', 'replyToEmail', 'aiAutonomousEnabled', 'agenticFollowupEnabled']) expect(settings).not.toContain(forbidden)
        const inbox = Object.keys(byName.get('outreach_email_account_update')!.inputSchema.properties)
        for (const forbidden of ['provider', 'smtpPassword', 'imapPassword', 'smtpHost', 'warmupOnly', 'warmupSource']) expect(inbox).not.toContain(forbidden)
        // Resume tells the model when it will refuse and where to go instead.
        expect(byName.get('outreach_campaign_resume')!.description).toMatch(/xmail_request_campaign_activation/)
        // Reading a prospect reply is flagged as untrusted text.
        expect(byName.get('outreach_inbox_thread_get')!.description).toMatch(/UNTRUSTED/)
    })
})
