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
})
