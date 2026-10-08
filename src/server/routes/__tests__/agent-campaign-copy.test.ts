import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Route tests for the Hermes campaign-copy capability. No database: `db` is an in-memory fake with
 * just enough behaviour to prove the contract — scope gate, org isolation, validation, version
 * stored, revert, delay_hours_max left alone. Drizzle `where` clauses are rendered to SQL params
 * and matched against the ids in play, so a query that forgot the organization filter would
 * return the row and fail the isolation test instead of passing silently.
 *
 * What this cannot prove: real SQL (the audit-log jsonb filter, `FOR UPDATE`, the pooler). That
 * needs a reachable Postgres; see the report.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const CAMPAIGN = '22222222-2222-4222-8222-222222222222'
const SEQUENCE = '33333333-3333-4333-8333-333333333333'
const STEP_1 = '44444444-4444-4444-8444-444444444441'
const STEP_2 = '44444444-4444-4444-8444-444444444442'

type Row = Record<string, any>

const state = vi.hoisted(() => ({
    campaign: {} as Row,
    steps: [] as Row[],
    audits: [] as Row[],
    pendingApproval: false,
    updateSets: [] as Row[],
    failNextAudit: false,
}))
const principalMock = vi.hoisted(() => vi.fn())
const deniedAuditMock = vi.hoisted(() => vi.fn())

const dialect = new PgDialect()
function paramsOf(where: unknown): unknown[] {
    return dialect.sqlToQuery(where as any).params
}

vi.mock('../../../db', () => {
    const clone = <T,>(value: T): T => structuredClone(value)
    const stepFromWhere = (where: unknown) => {
        const params = paramsOf(where)
        return state.steps.find((step) => params.includes(step.id))
    }
    return {
        db: {
            query: {
                campaigns: {
                    findFirst: vi.fn(async ({ where }: { where: unknown }) => {
                        const params = paramsOf(where)
                        return params.includes(state.campaign.id) && params.includes(state.campaign.organizationId)
                            ? clone(state.campaign)
                            : undefined
                    }),
                },
                sequences: {
                    findFirst: vi.fn(async () => ({
                        id: SEQUENCE,
                        campaignId: CAMPAIGN,
                        steps: clone([...state.steps].sort((a, b) => a.stepOrder - b.stepOrder)),
                    })),
                },
                outreachActionApprovals: {
                    findFirst: vi.fn(async () => (state.pendingApproval ? { id: 'approval-1' } : undefined)),
                },
            },
            transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
                const stepsBefore = clone(state.steps)
                const auditsBefore = state.audits.length
                const tx = {
                    select: () => ({
                        from: () => ({
                            where: (where: unknown) => ({
                                for: async () => {
                                    const found = stepFromWhere(where)
                                    return found ? [clone(found)] : []
                                },
                            }),
                        }),
                    }),
                    update: () => ({
                        set: (values: Row) => ({
                            where: (where: unknown) => ({
                                returning: async () => {
                                    const found = stepFromWhere(where)
                                    if (!found) return []
                                    state.updateSets.push(clone(values))
                                    Object.assign(found, values)
                                    return [clone(found)]
                                },
                            }),
                        }),
                    }),
                }
                try {
                    return await callback(tx)
                } catch (error) {
                    state.steps = stepsBefore
                    state.audits.length = auditsBefore
                    throw error
                }
            }),
        },
    }
})

vi.mock('../../lib/agent-auth', () => ({
    getAgentPrincipal: principalMock,
    agentHasScope: (principal: { scopes: string[] }, scope: string) => principal.scopes.includes(scope),
}))

vi.mock('../../lib/agent-audit', () => ({
    writeAgentAudit: vi.fn(async (input: Row) => {
        if (input.outcome === 'denied') {
            deniedAuditMock(input)
            return
        }
        if (state.failNextAudit) {
            state.failNextAudit = false
            throw new Error('audit insert failed')
        }
        state.audits.push({ ...input, createdAt: new Date(2026, 9, 7, 12, 0, state.audits.length) })
    }),
}))

vi.mock('../../lib/agent-campaign-copy-history', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/agent-campaign-copy-history')>()
    return {
        ...actual,
        loadStepCopyEvents: vi.fn(async (_executor: unknown, input: { campaignId: string; stepOrder: number }) =>
            state.audits
                .filter((audit) => audit.resourceId === input.campaignId
                    && audit.metadata.stepOrder === input.stepOrder
                    && [actual.STEP_COPY_UPDATED_ACTION, actual.STEP_COPY_REVERTED_ACTION].includes(audit.action))
                .map((audit) => ({
                    action: audit.action,
                    before: audit.metadata.before,
                    after: audit.metadata.after,
                    createdAt: audit.createdAt,
                }))),
    }
})

let server: http.Server
let baseUrl: string

async function call(method: string, pathname: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as any }
}

const stepPath = (order: number) => `/campaigns/${CAMPAIGN}/sequence/steps/${order}`
const currentStep = (order: number) => state.steps.find((step) => step.stepOrder === order)!

function emailStep(overrides: Row): Row {
    return {
        sequenceId: SEQUENCE,
        type: 'email',
        delayHours: 0,
        delayHoursMax: null,
        abTestEnabled: false,
        abTestPercentage: 50,
        subjectB: null,
        plainBodyB: null,
        htmlBodyB: null,
        totalSent: 0,
        totalOpens: 0,
        totalClicks: 0,
        totalReplies: 0,
        updatedAt: new Date(2026, 9, 1),
        ...overrides,
    }
}

const ORIGINAL_SUBJECT = 'Quick question for {{companyName}}'
const ORIGINAL_PLAIN = 'Hi {{firstName}},\n\nWe answer the phone for barbershops.\n\n{{unsubscribeUrl}}'

beforeEach(async () => {
    vi.clearAllMocks()
    state.audits = []
    state.updateSets = []
    state.pendingApproval = false
    state.failNextAudit = false
    state.campaign = { id: CAMPAIGN, organizationId: ORG, name: 'Barbershops Pilot', status: 'draft' }
    state.steps = [
        emailStep({
            id: STEP_1, stepOrder: 1, delayHours: 0, subject: ORIGINAL_SUBJECT,
            plainBody: ORIGINAL_PLAIN, htmlBody: null,
        }),
        emailStep({
            id: STEP_2, stepOrder: 2, delayHours: 48, delayHoursMax: 72, subject: 'Following up',
            plainBody: 'Hi {{firstName}},\n\nJust checking in.\n\n{{unsubscribeUrl}}',
            htmlBody: '<p>Hi {{firstName}},</p><p>Just checking in.</p><p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>',
        }),
    ]
    principalMock.mockReturnValue({
        credentialId: 'cred-1',
        organizationId: ORG,
        principalUserId: 'user-1',
        scopes: ['outreach:read', 'campaigns:copy'],
    })

    const router = (await import('../agent-campaign-copy')).default
    const app = express()
    app.use(express.json())
    app.use('/', router)
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 20_000)

afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.resetModules()
})

describe('GET /campaigns/:id/sequence', () => {
    it('returns the status and every step with its copy, delays and lint', async () => {
        currentStep(2).plainBody = 'Hi there,\n\nJust checking in.\n\n{{unsubscribeUrl}}'
        const result = await call('GET', `/campaigns/${CAMPAIGN}/sequence`)
        expect(result.status).toBe(200)
        expect(result.body.campaign).toEqual({ id: CAMPAIGN, name: 'Barbershops Pilot', status: 'draft' })
        expect(result.body.editable).toBe(true)
        expect(result.body.steps).toHaveLength(2)
        expect(result.body.steps[0]).toMatchObject({
            stepOrder: 1, type: 'email', delayHours: 0, delayHoursMax: null,
            subject: ORIGINAL_SUBJECT, plainBody: ORIGINAL_PLAIN, htmlBody: null, abTestEnabled: false,
        })
        expect(result.body.steps[1]).toMatchObject({ stepOrder: 2, delayHours: 48, delayHoursMax: 72 })
        expect(result.body.steps[1].lint.map((warning: Row) => warning.code)).toContain('greeting_hi_there')
    })

    it('needs outreach:read', async () => {
        principalMock.mockReturnValue({ credentialId: 'c', organizationId: ORG, principalUserId: 'u', scopes: ['campaigns:copy'] })
        const result = await call('GET', `/campaigns/${CAMPAIGN}/sequence`)
        expect(result.status).toBe(403)
        expect(result.body.error).toContain('outreach:read')
    })

    it('does not show another organization\'s campaign', async () => {
        principalMock.mockReturnValue({ credentialId: 'c', organizationId: OTHER_ORG, principalUserId: 'u', scopes: ['outreach:read'] })
        const result = await call('GET', `/campaigns/${CAMPAIGN}/sequence`)
        expect(result.status).toBe(404)
    })

    it('answers 404 to a malformed id without touching the database', async () => {
        const result = await call('GET', '/campaigns/not-a-uuid/sequence')
        expect(result.status).toBe(404)
    })
})

describe('PUT /campaigns/:id/sequence/steps/:stepOrder', () => {
    it('is refused without campaigns:copy, and the denial is audited', async () => {
        principalMock.mockReturnValue({ credentialId: 'c', organizationId: ORG, principalUserId: 'u', scopes: ['outreach:read', 'campaigns:draft'] })
        const result = await call('PUT', stepPath(1), { subject: 'New subject' })
        expect(result.status).toBe(403)
        expect(result.body.error).toContain('campaigns:copy')
        expect(currentStep(1).subject).toBe(ORIGINAL_SUBJECT)
        expect(deniedAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent.scope.denied' }))
    })

    it('treats another organization\'s campaign as not found and changes nothing', async () => {
        principalMock.mockReturnValue({ credentialId: 'c', organizationId: OTHER_ORG, principalUserId: 'u', scopes: ['campaigns:copy'] })
        const result = await call('PUT', stepPath(1), { subject: 'Hijacked' })
        expect(result.status).toBe(404)
        expect(currentStep(1).subject).toBe(ORIGINAL_SUBJECT)
        expect(state.audits).toHaveLength(0)
    })

    it('rejects an edit that removes {{unsubscribeUrl}} with 422 and the issue list, saving nothing', async () => {
        const result = await call('PUT', stepPath(1), { plainBody: 'Hi {{firstName}}, we answer the phone for barbershops.' })
        expect(result.status).toBe(422)
        expect(result.body.code).toBe('step_validation_failed')
        expect(result.body.issues.map((issue: Row) => issue.code)).toContain('missing_unsubscribe_placeholder')
        expect(currentStep(1).plainBody).toBe(ORIGINAL_PLAIN)
        expect(state.audits).toHaveLength(0)
    })

    it('rejects removing {{unsubscribeUrl}} from one body while the other still has it (prod 2026-10-07)', async () => {
        const original = currentStep(2).plainBody
        const result = await call('PUT', stepPath(2), { plainBody: 'Hey {{firstName}}, no link in this one.' })
        expect(result.status).toBe(422)
        expect(result.body.issues.map((issue: Row) => issue.code)).toContain('missing_unsubscribe_placeholder')
        expect(currentStep(2).plainBody).toBe(original)
        expect(state.audits).toHaveLength(0)
    })

    it('rejects a malformed template block with 422', async () => {
        const result = await call('PUT', stepPath(1), { plainBody: 'Hello {{firstName}} {{/nearby}}\n\n{{unsubscribeUrl}}' })
        expect(result.status).toBe(422)
        expect(result.body.issues.map((issue: Row) => issue.code)).toContain('malformed_template_block')
        expect(currentStep(1).plainBody).toBe(ORIGINAL_PLAIN)
    })

    it('saves the edit and returns lint warnings for em dash, "Hi there" and a street address', async () => {
        const plainBody = 'Hi there — we answer the phone.\n\nSkale Club, 123 Main Street, Smyrna, DE 19977\n\n{{unsubscribeUrl}}'
        const result = await call('PUT', stepPath(1), { plainBody })
        expect(result.status).toBe(200)
        expect(currentStep(1).plainBody).toBe(plainBody)
        const codes = result.body.warnings.map((warning: Row) => warning.code)
        expect(codes).toEqual(expect.arrayContaining(['dash_character', 'greeting_hi_there', 'postal_address']))
        expect(result.body.warnings.find((warning: Row) => warning.code === 'dash_character').matches[0]).toContain('—')
    })

    it('warns when only one of plainBody and htmlBody was edited, naming the one left unchanged', async () => {
        const result = await call('PUT', stepPath(2), { plainBody: 'Hi {{firstName}},\n\nShort note.\n\n{{unsubscribeUrl}}' })
        expect(result.status).toBe(200)
        const warning = result.body.warnings.find((entry: Row) => entry.code === 'body_left_unchanged')
        expect(warning).toMatchObject({ field: 'htmlBody' })
        expect(currentStep(2).htmlBody).toContain('Just checking in.')
    })

    it('stores the previous version and the change summary in the audit row, with who and where', async () => {
        const result = await call('PUT', stepPath(1), {
            subject: 'A better subject',
            reason: 'Vanildo asked for a shorter subject',
        })
        expect(result.status).toBe(200)
        expect(result.body.versionStored).toBe(true)
        expect(result.body.before).toEqual({ subject: ORIGINAL_SUBJECT })
        expect(result.body.after).toEqual({ subject: 'A better subject' })

        expect(state.audits).toHaveLength(1)
        const audit = state.audits[0]
        expect(audit).toMatchObject({
            action: 'agent.campaign.step_copy_updated',
            resourceType: 'campaign',
            resourceId: CAMPAIGN,
            principal: expect.objectContaining({ credentialId: 'cred-1', principalUserId: 'user-1', organizationId: ORG }),
        })
        expect(audit.executor).toBeDefined()
        expect(audit.metadata).toMatchObject({
            campaignId: CAMPAIGN,
            stepOrder: 1,
            stepId: STEP_1,
            reason: 'Vanildo asked for a shorter subject',
            changedFields: ['subject'],
            before: { subject: ORIGINAL_SUBJECT },
            after: { subject: 'A better subject' },
            summary: 'subject',
        })
    })

    it('rolls the edit back when the audit row cannot be written', async () => {
        state.failNextAudit = true
        const result = await call('PUT', stepPath(1), { subject: 'Will not stick' })
        expect(result.status).toBe(500)
        expect(currentStep(1).subject).toBe(ORIGINAL_SUBJECT)
    })

    it('never writes delay_hours_max unless the payload names it', async () => {
        const result = await call('PUT', stepPath(2), { subject: 'Following up again' })
        expect(result.status).toBe(200)
        expect(state.updateSets).toHaveLength(1)
        expect(Object.keys(state.updateSets[0])).not.toContain('delayHoursMax')
        expect(Object.keys(state.updateSets[0])).not.toContain('delayHours')
        expect(currentStep(2).delayHoursMax).toBe(72)
        expect(currentStep(2).delayHours).toBe(48)
    })

    it('changes delay_hours_max when named, including clearing it with null, and validates max >= min', async () => {
        const raised = await call('PUT', stepPath(2), { delayHoursMax: 96 })
        expect(raised.status).toBe(200)
        expect(currentStep(2).delayHoursMax).toBe(96)

        const cleared = await call('PUT', stepPath(2), { delayHoursMax: null })
        expect(cleared.status).toBe(200)
        expect(currentStep(2).delayHoursMax).toBeNull()

        await call('PUT', stepPath(2), { delayHoursMax: 72 })
        const inverted = await call('PUT', stepPath(2), { delayHoursMax: 10 })
        expect(inverted.status).toBe(422)
        expect(inverted.body.code).toBe('invalid_delay_range')

        // Raising delayHours above the stored max, without naming the max, is the same violation.
        const aboveStored = await call('PUT', stepPath(2), { delayHours: 100 })
        expect(aboveStored.status).toBe(422)
        expect(currentStep(2).delayHoursMax).toBe(72)
        expect(currentStep(2).delayHours).toBe(48)
    })

    it('answers appliesTo "future sends only" for an active campaign', async () => {
        state.campaign.status = 'active'
        currentStep(1).totalSent = 14
        const result = await call('PUT', stepPath(1), { subject: 'Edited while live' })
        expect(result.status).toBe(200)
        expect(result.body.appliesTo).toBe('future sends only')
        expect(result.body.alreadySent).toBe(14)
        expect(result.body.activationRequired).toBe(false)
        expect(state.audits[0].metadata.appliesTo).toBe('future sends only')
    })

    it('says a draft edit applies once the campaign is activated, which still needs a human', async () => {
        const result = await call('PUT', stepPath(1), { subject: 'Edited draft' })
        expect(result.body.appliesTo).toBe('all sends once the campaign is activated')
        expect(result.body.activationRequired).toBe(true)
    })

    it('allows a paused campaign', async () => {
        state.campaign.status = 'paused'
        const result = await call('PUT', stepPath(1), { subject: 'Edited while paused' })
        expect(result.status).toBe(200)
        expect(result.body.appliesTo).toBe('future sends only')
    })

    it.each(['completed', 'archived'])('refuses a %s campaign', async (status) => {
        state.campaign.status = status
        const result = await call('PUT', stepPath(1), { subject: 'Too late' })
        expect(result.status).toBe(409)
        expect(result.body.code).toBe('campaign_not_editable')
    })

    it('warns when an activation approval is waiting', async () => {
        state.pendingApproval = true
        const result = await call('PUT', stepPath(1), { subject: 'Edited under review' })
        expect(result.body.warnings.map((warning: Row) => warning.code)).toContain('pending_activation_approval')
    })

    it('warns when A/B testing is on, because only variant A is edited', async () => {
        currentStep(1).abTestEnabled = true
        currentStep(1).plainBodyB = 'Variant B\n\n{{unsubscribeUrl}}'
        const result = await call('PUT', stepPath(1), { subject: 'Edited A' })
        expect(result.body.warnings.map((warning: Row) => warning.code)).toContain('ab_variant_b_unchanged')
    })

    it('treats an identical payload as a no-op: nothing written, no version stored', async () => {
        const result = await call('PUT', stepPath(1), { subject: ORIGINAL_SUBJECT })
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({ changed: false, versionStored: false })
        expect(state.audits).toHaveLength(0)
        expect(state.updateSets).toHaveLength(0)
    })

    it('rejects unknown fields (the A/B columns are out of reach) and empty payloads', async () => {
        expect((await call('PUT', stepPath(1), { subjectB: 'x' })).status).toBe(400)
        expect((await call('PUT', stepPath(1), { type: 'delay' })).status).toBe(400)
        expect((await call('PUT', stepPath(1), {})).status).toBe(400)
    })

    it('refuses a blank subject on the first email step, but lets a follow-up go blank (sent as a reply)', async () => {
        const first = await call('PUT', stepPath(1), { subject: '   ' })
        expect(first.status).toBe(422)
        expect(first.body.code).toBe('step_validation_failed')
        expect(state.audits).toHaveLength(0)

        const followUp = await call('PUT', stepPath(2), { subject: '   ' })
        expect(followUp.status).toBe(200)
        expect(currentStep(2).subject).toBe('')
    })

    it('answers 404 for a step that does not exist or a bad step number', async () => {
        expect((await call('PUT', stepPath(9), { subject: 'x' })).status).toBe(404)
        expect((await call('PUT', stepPath(0), { subject: 'x' })).status).toBe(404)
        expect((await call('PUT', `/campaigns/${CAMPAIGN}/sequence/steps/abc`, { subject: 'x' })).status).toBe(404)
    })

    it('refuses copy fields on a non-email step but still allows its delay', async () => {
        state.steps.push({
            id: '44444444-4444-4444-8444-444444444443', sequenceId: SEQUENCE, stepOrder: 3, type: 'delay',
            delayHours: 24, delayHoursMax: null, subject: null, plainBody: null, htmlBody: null,
            abTestEnabled: false, abTestPercentage: 50, totalSent: 0, totalOpens: 0, totalClicks: 0, totalReplies: 0,
            updatedAt: new Date(),
        })
        const copy = await call('PUT', stepPath(3), { subject: 'x' })
        expect(copy.status).toBe(422)
        expect(copy.body.code).toBe('not_an_email_step')
        const delay = await call('PUT', stepPath(3), { delayHours: 36 })
        expect(delay.status).toBe(200)
        expect(currentStep(3).delayHours).toBe(36)
    })
})

describe('POST /campaigns/:id/sequence/steps/:stepOrder/revert', () => {
    it('is refused without campaigns:copy', async () => {
        principalMock.mockReturnValue({ credentialId: 'c', organizationId: ORG, principalUserId: 'u', scopes: ['outreach:read'] })
        const result = await call('POST', `${stepPath(1)}/revert`)
        expect(result.status).toBe(403)
    })

    it('does not revert another organization\'s campaign', async () => {
        await call('PUT', stepPath(1), { subject: 'Edited' })
        principalMock.mockReturnValue({ credentialId: 'c', organizationId: OTHER_ORG, principalUserId: 'u', scopes: ['campaigns:copy'] })
        const result = await call('POST', `${stepPath(1)}/revert`)
        expect(result.status).toBe(404)
        expect(currentStep(1).subject).toBe('Edited')
    })

    it('restores the version that was stored before the edit, and audits the revert', async () => {
        const plainBody = 'Hi {{firstName}},\n\nA completely different message.\n\n{{unsubscribeUrl}}'
        await call('PUT', stepPath(1), { subject: 'Edited subject', plainBody })
        expect(currentStep(1).subject).toBe('Edited subject')

        const result = await call('POST', `${stepPath(1)}/revert`, { reason: 'Vanildo did not like it' })
        expect(result.status).toBe(200)
        expect(result.body.reverted).toBe(true)
        expect(result.body.restoredFields.sort()).toEqual(['plainBody', 'subject'])
        expect(currentStep(1).subject).toBe(ORIGINAL_SUBJECT)
        expect(currentStep(1).plainBody).toBe(ORIGINAL_PLAIN)

        expect(state.audits.map((audit) => audit.action)).toEqual([
            'agent.campaign.step_copy_updated',
            'agent.campaign.step_copy_reverted',
        ])
        expect(state.audits[1].metadata).toMatchObject({
            reason: 'Vanildo did not like it',
            before: { subject: 'Edited subject', plainBody },
            after: { subject: ORIGINAL_SUBJECT, plainBody: ORIGINAL_PLAIN },
        })
    })

    it('restores a cleared delay_hours_max exactly (null, not 0)', async () => {
        await call('PUT', stepPath(2), { delayHoursMax: null })
        expect(currentStep(2).delayHoursMax).toBeNull()
        const result = await call('POST', `${stepPath(2)}/revert`)
        expect(result.status).toBe(200)
        expect(currentStep(2).delayHoursMax).toBe(72)
    })

    it('walks back through history on consecutive reverts and then has nothing left', async () => {
        await call('PUT', stepPath(1), { subject: 'Second subject' })
        await call('PUT', stepPath(1), { subject: 'Third subject' })

        expect((await call('POST', `${stepPath(1)}/revert`)).status).toBe(200)
        expect(currentStep(1).subject).toBe('Second subject')
        expect((await call('POST', `${stepPath(1)}/revert`)).status).toBe(200)
        expect(currentStep(1).subject).toBe(ORIGINAL_SUBJECT)

        const exhausted = await call('POST', `${stepPath(1)}/revert`)
        expect(exhausted.status).toBe(409)
        expect(exhausted.body.code).toBe('nothing_to_revert')
        expect(currentStep(1).subject).toBe(ORIGINAL_SUBJECT)
    })

    it('has nothing to revert on a step the agent never edited', async () => {
        const result = await call('POST', `${stepPath(2)}/revert`)
        expect(result.status).toBe(409)
        expect(result.body.code).toBe('nothing_to_revert')
    })

    it('refuses to overwrite a change a human made after the agent\'s edit', async () => {
        await call('PUT', stepPath(1), { subject: 'Agent subject' })
        currentStep(1).subject = 'Vanildo typed this in the admin UI'

        const result = await call('POST', `${stepPath(1)}/revert`)
        expect(result.status).toBe(409)
        expect(result.body.code).toBe('step_changed_since_agent_edit')
        expect(result.body.fields).toEqual(['subject'])
        expect(currentStep(1).subject).toBe('Vanildo typed this in the admin UI')
    })

    it('keeps the same activation checks: it will not restore a version that fails them', async () => {
        // The original (v0) body had no unsubscribe link; the agent's edit fixed it.
        currentStep(1).plainBody = 'Hi {{firstName}}, we answer the phone for barbershops.'
        currentStep(1).htmlBody = null
        await call('PUT', stepPath(1), { plainBody: ORIGINAL_PLAIN })
        expect(currentStep(1).plainBody).toBe(ORIGINAL_PLAIN)

        const result = await call('POST', `${stepPath(1)}/revert`)
        expect(result.status).toBe(422)
        expect(result.body.issues.map((issue: Row) => issue.code)).toContain('missing_unsubscribe_placeholder')
        expect(currentStep(1).plainBody).toBe(ORIGINAL_PLAIN)
    })

    it('reports appliesTo for an active campaign', async () => {
        state.campaign.status = 'active'
        await call('PUT', stepPath(1), { subject: 'Edited while live' })
        const result = await call('POST', `${stepPath(1)}/revert`)
        expect(result.body.appliesTo).toBe('future sends only')
    })
})
