import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { reset, rows, startServer, state, type Row, type TestServer } from './fake-agent-db'

/**
 * Route tests for the Hermes/Kai campaign operations (scope outreach:manage). No database: `db` is
 * the in-memory fake in fake-agent-db.ts, whose `where` evaluation makes a missing organization
 * filter fail a test instead of passing silently.
 *
 * Guards proven here:
 *   - scope gate (a denied call is audited), tenant isolation (another org's id is a 404);
 *   - a settings update is partial, cannot touch status/replyTo/autonomy flags, and writes its
 *     audit row through the same transaction (a failed audit rolls the change back);
 *   - a duplicate is a DRAFT with the cadence (delay_hours_max) and no leads;
 *   - resume needs an executed activation approval, an agent-made pause and the same readiness
 *     checks as activation, which is where the three-mailbox rule (info@, warm-up seeds) bites.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const CAMPAIGN = '22222222-2222-4222-8222-222222222222'
const OTHER_CAMPAIGN = '22222222-2222-4222-8222-222222222299'
const SEQUENCE = '33333333-3333-4333-8333-333333333333'
const STEP_1 = '44444444-4444-4444-8444-444444444441'
const STEP_2 = '44444444-4444-4444-8444-444444444442'
const APPROVAL = '55555555-5555-4555-8555-555555555555'
const GOOD_ACCOUNT = '66666666-6666-4666-8666-666666666661'
const INFO_ACCOUNT = '66666666-6666-4666-8666-666666666662'
const SEED_ACCOUNT = '66666666-6666-4666-8666-666666666663'
const CREDENTIAL = 'cred-1'

const principalMock = vi.hoisted(() => vi.fn())
const publishMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../../../db', async () => ({ db: (await import('./fake-agent-db')).fakeDb }))
vi.mock('../../lib/agent-auth', () => ({
    getAgentPrincipal: principalMock,
    agentHasScope: (principal: { scopes: string[] }, scope: string) => principal.scopes.includes(scope),
}))
vi.mock('../../lib/agent-audit', async () => ({ writeAgentAudit: (await import('./fake-agent-db')).recordAudit }))
vi.mock('../../lib/xphere-events', () => ({ publishOutreachEvent: publishMock }))
vi.mock('../../lib/outreach-campaign-metrics', () => ({
    computeCampaignMetrics: async () => ({ totalLeads: 1, contactedLeads: 0, sentEmails: 0, openRate: 0, replyRate: 0, bounceRate: 0 }),
}))

let server: TestServer

const UNSUB = '{{unsubscribeUrl}}'

function account(overrides: Row): Row {
    return {
        organizationId: ORG, displayName: null, provider: 'smtp', mailboxProvider: 'icemail', status: 'verified', lastError: null,
        dailySendLimit: 50, currentDailySent: 0, minMinutesBetweenEmails: 5, maxMinutesBetweenEmails: 30,
        warmupEnabled: false, warmupDays: 14, warmupCurrentDay: 14, warmupSource: 'internal', warmupOnly: false, warmupSentToday: 0,
        verifiedAt: null, lastSentAt: null, totalSent: 0, totalOpens: 0, totalClicks: 0, totalReplies: 0, totalBounces: 0,
        smtpHost: 'smtp.example.test', smtpUsername: 'user', smtpPassword: 'ENCRYPTED-SMTP-SECRET',
        imapHost: 'imap.example.test', imapUsername: 'user', imapPassword: 'ENCRYPTED-IMAP-SECRET',
        ...overrides,
    }
}

function emailStep(id: string, stepOrder: number, overrides: Row = {}): Row {
    return {
        id, sequenceId: SEQUENCE, stepOrder, type: 'email', delayHours: stepOrder === 1 ? 0 : 48, delayHoursMax: stepOrder === 1 ? null : 72,
        subject: `Subject ${stepOrder}`, plainBody: `Hi {{firstName}},\n\nBody ${stepOrder}\n\n${UNSUB}`,
        htmlBody: `<p>Body ${stepOrder}</p><p><a href="${UNSUB}">Unsubscribe</a></p>`,
        subjectB: 'Variant B', plainBodyB: `B ${UNSUB}`, htmlBodyB: null, abTestEnabled: true, abTestPercentage: 40,
        totalSent: 7, totalOpens: 3, totalClicks: 1, totalReplies: 1, ...overrides,
    }
}

function campaign(overrides: Row = {}): Row {
    return {
        id: CAMPAIGN, organizationId: ORG, name: 'Barbershops Pilot', description: 'Pilot description', status: 'active',
        contentLanguage: 'en', fromName: 'Vanildo', replyToEmail: 'replies@tryskaleclub.com', timezone: 'America/New_York',
        sendOnWeekends: false, sendStartTime: '09:00', sendEndTime: '17:00', trackOpens: true, trackClicks: true,
        agenticFollowupEnabled: true, maxFollowUps: 3, aiAutonomousEnabled: true,
        agentCredentialId: null, agentIdempotencyKey: null, activationApprovalId: null,
        totalLeads: 1, startedAt: new Date(2026, 9, 1), pausedAt: null, pausedReason: null, completedAt: null,
        ...overrides,
    }
}

const principal = (scopes: string[], organizationId = ORG) => ({ credentialId: CREDENTIAL, organizationId, principalUserId: 'user-1', scopes })

beforeAll(async () => {
    process.env.ENCRYPTION_KEY ||= 'test-encryption-key'
    const router = (await import('../agent-campaign-manage')).default
    server = await startServer(router)
}, 60_000)

afterAll(async () => {
    await server.close()
})

beforeEach(() => {
    delete process.env.OUTREACH_PROTECTED_DOMAINS
    process.env.OUTREACH_PROTECTED_DOMAINS = 'xkedule.com,skale.club'
    reset({
        campaigns: [campaign()],
        sequences: [{ id: SEQUENCE, campaignId: CAMPAIGN, name: 'Main Sequence', description: null }],
        sequenceSteps: [emailStep(STEP_1, 1), emailStep(STEP_2, 2)],
        campaignLeads: [{ id: 'cl-1', campaignId: CAMPAIGN, leadId: 'lead-1', assignedEmailAccountId: GOOD_ACCOUNT, status: 'contacted' }],
        emailAccounts: [
            account({ id: GOOD_ACCOUNT, email: 'vanildo.jr@tryskaleclub.com' }),
            account({ id: INFO_ACCOUNT, email: 'info@xkedule.com' }),
            account({ id: SEED_ACCOUNT, email: 'contato@tryskaleclub.com', warmupOnly: true }),
        ],
        outreachActionApprovals: [],
    }, { campaigns: [['organizationId', 'agentCredentialId', 'agentIdempotencyKey']] })
    publishMock.mockClear()
    principalMock.mockReturnValue(principal(['outreach:read', 'outreach:manage']))
})

const stored = (id = CAMPAIGN) => rows('campaigns').find((row) => row.id === id)!

describe('GET /campaigns/:id', () => {
    it('returns settings, schedule, linked inboxes and stats, and never a credential', async () => {
        const result = await server.call('GET', `/campaigns/${CAMPAIGN}`)
        expect(result.status).toBe(200)
        expect(result.body.campaign.settings).toMatchObject({
            name: 'Barbershops Pilot', timezone: 'America/New_York', sendStartTime: '09:00', sendEndTime: '17:00', sendOnWeekends: false,
        })
        expect(result.body.sequence.steps[1]).toMatchObject({ stepOrder: 2, delayHours: 48, delayHoursMax: 72 })
        expect(result.body.sendingInboxes).toHaveLength(1)
        expect(result.body.sendingInboxes[0]).toMatchObject({ email: 'vanildo.jr@tryskaleclub.com', leadCount: 1 })
        expect(result.body.stats.totalLeads).toBe(1)
        expect(JSON.stringify(result.body)).not.toMatch(/ENCRYPTED|smtpPassword|imapPassword|smtp\.example/)
    })

    it('needs outreach:read', async () => {
        principalMock.mockReturnValue(principal(['outreach:manage']))
        expect((await server.call('GET', `/campaigns/${CAMPAIGN}`)).status).toBe(403)
    })

    it('answers 404 for another organization\'s campaign and for a malformed id', async () => {
        principalMock.mockReturnValue(principal(['outreach:read'], OTHER_ORG))
        expect((await server.call('GET', `/campaigns/${CAMPAIGN}`)).status).toBe(404)
        expect((await server.call('GET', '/campaigns/not-a-uuid')).status).toBe(404)
    })
})

describe('PATCH /campaigns/:id', () => {
    it('is refused without outreach:manage, and the denial is audited', async () => {
        principalMock.mockReturnValue(principal(['outreach:read', 'campaigns:copy']))
        const result = await server.call('PATCH', `/campaigns/${CAMPAIGN}`, { name: 'Renamed' })
        expect(result.status).toBe(403)
        expect(result.body.error).toContain('outreach:manage')
        expect(stored().name).toBe('Barbershops Pilot')
        expect(state.deniedAudits[0]).toMatchObject({ action: 'agent.scope.denied', metadata: { requiredScope: 'outreach:manage' } })
    })

    it('treats another organization\'s campaign as not found and changes nothing', async () => {
        principalMock.mockReturnValue(principal(['outreach:manage'], OTHER_ORG))
        const result = await server.call('PATCH', `/campaigns/${CAMPAIGN}`, { name: 'Hijacked' })
        expect(result.status).toBe(404)
        expect(stored().name).toBe('Barbershops Pilot')
        expect(state.audits).toHaveLength(0)
    })

    it('is partial: only the named settings change, everything else keeps its stored value', async () => {
        const result = await server.call('PATCH', `/campaigns/${CAMPAIGN}`, { sendEndTime: '16:00', sendOnWeekends: true, reason: 'Vanildo asked for earlier stop' })
        expect(result.status).toBe(200)
        expect(result.body.changedFields.sort()).toEqual(['sendEndTime', 'sendOnWeekends'])
        expect(stored()).toMatchObject({
            sendEndTime: '16:00', sendOnWeekends: true,
            name: 'Barbershops Pilot', description: 'Pilot description', timezone: 'America/New_York', sendStartTime: '09:00',
            trackOpens: true, replyToEmail: 'replies@tryskaleclub.com', status: 'active',
        })
        // The cadence lives on the steps; a campaign settings update never reaches them.
        expect(rows('sequenceSteps').find((step) => step.id === STEP_2)).toMatchObject({ delayHours: 48, delayHoursMax: 72 })
    })

    it('writes the audit row through the same transaction, with before and after', async () => {
        await server.call('PATCH', `/campaigns/${CAMPAIGN}`, { timezone: 'America/Chicago', reason: 'client is in Texas' })
        expect(state.audits).toHaveLength(1)
        expect(state.audits[0]).toMatchObject({
            action: 'agent.campaign.settings_updated',
            resourceType: 'campaign',
            resourceId: CAMPAIGN,
            principal: expect.objectContaining({ credentialId: CREDENTIAL, organizationId: ORG }),
            metadata: {
                reason: 'client is in Texas',
                changedFields: ['timezone'],
                before: { timezone: 'America/New_York' },
                after: { timezone: 'America/Chicago' },
            },
        })
        expect(state.audits[0].executor.isTransaction).toBe(true)
    })

    it('rolls the change back when the audit row cannot be written', async () => {
        state.failNextAudit = true
        const result = await server.call('PATCH', `/campaigns/${CAMPAIGN}`, { name: 'Will not stick' })
        expect(result.status).toBe(500)
        expect(stored().name).toBe('Barbershops Pilot')
    })

    it('cannot change status, replyToEmail or the autonomy flags (strict schema)', async () => {
        for (const body of [
            { status: 'completed' },
            { status: 'active' },
            { replyToEmail: 'attacker@evil.test' },
            { aiAutonomousEnabled: true },
            { agenticFollowupEnabled: true },
            { maxFollowUps: 50 },
        ]) {
            const result = await server.call('PATCH', `/campaigns/${CAMPAIGN}`, body)
            expect(result.status, JSON.stringify(body)).toBe(400)
        }
        expect(stored()).toMatchObject({ status: 'active', replyToEmail: 'replies@tryskaleclub.com' })
        expect(state.audits).toHaveLength(0)
    })

    it('validates the send window against the stored half when only one end is sent', async () => {
        const result = await server.call('PATCH', `/campaigns/${CAMPAIGN}`, { sendStartTime: '18:00' })
        expect(result.status).toBe(422)
        expect(result.body.code).toBe('invalid_send_window')
        expect(stored().sendStartTime).toBe('09:00')
    })

    it('rejects an unknown timezone, a bad time and an empty payload', async () => {
        expect((await server.call('PATCH', `/campaigns/${CAMPAIGN}`, { timezone: 'Mars/Olympus' })).status).toBe(400)
        expect((await server.call('PATCH', `/campaigns/${CAMPAIGN}`, { sendStartTime: '25:00' })).status).toBe(400)
        expect((await server.call('PATCH', `/campaigns/${CAMPAIGN}`, {})).status).toBe(400)
        expect((await server.call('PATCH', `/campaigns/${CAMPAIGN}`, { reason: 'only a reason' })).status).toBe(400)
    })

    it.each(['completed', 'archived'])('refuses a %s campaign', async (status) => {
        stored().status = status
        const result = await server.call('PATCH', `/campaigns/${CAMPAIGN}`, { name: 'Too late' })
        expect(result.status).toBe(409)
        expect(result.body.code).toBe('campaign_not_editable')
    })

    it('treats an identical payload as a no-op: nothing written, no audit row', async () => {
        const result = await server.call('PATCH', `/campaigns/${CAMPAIGN}`, { name: 'Barbershops Pilot' })
        expect(result.status).toBe(200)
        expect(result.body.changed).toBe(false)
        expect(state.audits).toHaveLength(0)
    })
})

describe('POST /campaigns/:id/duplicate', () => {
    const body = { idempotencyKey: 'dup-key-0001' }

    it('creates a DRAFT with the cadence (delay_hours_max included) and no leads', async () => {
        const result = await server.call('POST', `/campaigns/${CAMPAIGN}/duplicate`, body)
        expect(result.status).toBe(201)
        expect(result.body).toMatchObject({ copiedFrom: CAMPAIGN, leadsCopied: 0, activationRequired: true, idempotentReplay: false })
        expect(result.body.campaign).toMatchObject({ name: 'Barbershops Pilot (copy)', status: 'draft' })

        const copy = rows('campaigns').find((row) => row.id === result.body.campaign.id)!
        expect(copy).toMatchObject({
            organizationId: ORG, status: 'draft', agentCredentialId: CREDENTIAL, agentIdempotencyKey: 'dup-key-0001',
            timezone: 'America/New_York', sendStartTime: '09:00', sendEndTime: '17:00',
        })
        expect(copy.activationApprovalId ?? null).toBeNull()
        // Autonomy opt-ins are never inherited by an agent-made copy.
        expect(copy).toMatchObject({ aiAutonomousEnabled: false, agenticFollowupEnabled: false })

        const copiedSteps = rows('sequenceSteps').filter((step) => step.sequenceId !== SEQUENCE)
        expect(copiedSteps).toHaveLength(2)
        expect(copiedSteps.find((step) => step.stepOrder === 2)).toMatchObject({
            delayHours: 48, delayHoursMax: 72, subject: 'Subject 2', subjectB: 'Variant B', abTestEnabled: true, abTestPercentage: 40,
        })
        // The copy starts clean: no leads, and the send counters are the column defaults, not copied.
        expect(rows('campaignLeads').filter((lead) => lead.campaignId === copy.id)).toHaveLength(0)
        expect(copiedSteps.every((step) => step.totalSent === undefined)).toBe(true)
        // The source is untouched.
        expect(stored()).toMatchObject({ status: 'active', aiAutonomousEnabled: true })
    })

    it('audits through the transaction and is idempotent per key', async () => {
        const first = await server.call('POST', `/campaigns/${CAMPAIGN}/duplicate`, body)
        expect(state.audits).toHaveLength(1)
        expect(state.audits[0]).toMatchObject({ action: 'agent.campaign.duplicated', metadata: { sourceCampaignId: CAMPAIGN, stepCount: 2 } })
        expect(state.audits[0].executor.isTransaction).toBe(true)

        const replay = await server.call('POST', `/campaigns/${CAMPAIGN}/duplicate`, body)
        expect(replay.status).toBe(200)
        expect(replay.body).toMatchObject({ idempotentReplay: true })
        expect(replay.body.campaign.id).toBe(first.body.campaign.id)
        expect(rows('campaigns')).toHaveLength(2)
    })

    it('rolls the copy back when the audit row cannot be written', async () => {
        state.failNextAudit = true
        const result = await server.call('POST', `/campaigns/${CAMPAIGN}/duplicate`, body)
        expect(result.status).toBe(500)
        expect(rows('campaigns')).toHaveLength(1)
        expect(rows('sequenceSteps')).toHaveLength(2)
    })

    it('needs the manage scope, a key, and the campaign must be in the caller\'s organization', async () => {
        principalMock.mockReturnValue(principal(['outreach:read']))
        expect((await server.call('POST', `/campaigns/${CAMPAIGN}/duplicate`, body)).status).toBe(403)
        principalMock.mockReturnValue(principal(['outreach:manage']))
        expect((await server.call('POST', `/campaigns/${CAMPAIGN}/duplicate`, {})).status).toBe(400)
        principalMock.mockReturnValue(principal(['outreach:manage'], OTHER_ORG))
        expect((await server.call('POST', `/campaigns/${CAMPAIGN}/duplicate`, body)).status).toBe(404)
        expect(rows('campaigns')).toHaveLength(1)
    })
})

describe('POST /campaigns/:id/resume', () => {
    function pausedByAgent(overrides: Row = {}) {
        Object.assign(stored(), { status: 'paused', pausedReason: 'agent', pausedAt: new Date(), activationApprovalId: APPROVAL, ...overrides })
        rows('outreachActionApprovals').push({
            id: APPROVAL, organizationId: ORG, actionKind: 'campaign_activation', resourceType: 'campaign', resourceId: CAMPAIGN, status: 'executed',
        })
    }

    it('resumes a campaign a human approved earlier and the agent paused, with audit and event', async () => {
        pausedByAgent()
        const result = await server.call('POST', `/campaigns/${CAMPAIGN}/resume`, { reason: 'Vanildo said go' })
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({ resumed: true, basedOnApproval: APPROVAL })
        expect(stored()).toMatchObject({ status: 'active', pausedReason: null, pausedAt: null })
        expect(state.audits).toHaveLength(1)
        expect(state.audits[0]).toMatchObject({
            action: 'agent.campaign.resumed',
            metadata: { previousStatus: 'paused', pausedReason: 'agent', activationApprovalId: APPROVAL, reason: 'Vanildo said go' },
        })
        expect(state.audits[0].executor.isTransaction).toBe(true)
        expect(publishMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'campaign.resumed', organizationId: ORG }))
    })

    it('refuses a campaign that was never activated through an approval, and says to request one', async () => {
        Object.assign(stored(), { status: 'paused', pausedReason: 'agent', activationApprovalId: null })
        const result = await server.call('POST', `/campaigns/${CAMPAIGN}/resume`, {})
        expect(result.status).toBe(409)
        expect(result.body.code).toBe('activation_approval_required')
        expect(result.body.howToProceed).toContain('xmail_request_campaign_activation')
        expect(stored().status).toBe('paused')
        expect(state.audits).toHaveLength(0)
        expect(publishMock).not.toHaveBeenCalled()
    })

    it('refuses when the recorded approval is not an executed activation of THIS campaign', async () => {
        pausedByAgent()
        rows('outreachActionApprovals')[0].status = 'requested'
        expect((await server.call('POST', `/campaigns/${CAMPAIGN}/resume`, {})).body.code).toBe('activation_approval_required')
        rows('outreachActionApprovals')[0].status = 'executed'
        rows('outreachActionApprovals')[0].resourceId = OTHER_CAMPAIGN
        expect((await server.call('POST', `/campaigns/${CAMPAIGN}/resume`, {})).body.code).toBe('activation_approval_required')
        rows('outreachActionApprovals')[0].resourceId = CAMPAIGN
        rows('outreachActionApprovals')[0].organizationId = OTHER_ORG
        expect((await server.call('POST', `/campaigns/${CAMPAIGN}/resume`, {})).body.code).toBe('activation_approval_required')
        expect(stored().status).toBe('paused')
    })

    it.each(['human', 'bounce_rate', 'unsubscribe_rate'])('does not undo a pause made by "%s"', async (reason) => {
        pausedByAgent({ pausedReason: reason })
        const result = await server.call('POST', `/campaigns/${CAMPAIGN}/resume`, {})
        expect(result.status).toBe(409)
        expect(result.body.code).toBe('not_paused_by_agent')
        expect(stored().status).toBe('paused')
    })

    it('does not resume a draft, and is a no-op for an active campaign', async () => {
        stored().status = 'draft'
        expect((await server.call('POST', `/campaigns/${CAMPAIGN}/resume`, {})).body.code).toBe('campaign_not_paused')
        stored().status = 'active'
        const active = await server.call('POST', `/campaigns/${CAMPAIGN}/resume`, {})
        expect(active.body).toMatchObject({ resumed: false, alreadyActive: true })
        expect(state.audits).toHaveLength(0)
    })

    it('runs the activation readiness gate: an info@ company inbox blocks the resume (three-mailbox rule)', async () => {
        pausedByAgent()
        rows('campaignLeads')[0].assignedEmailAccountId = INFO_ACCOUNT
        const result = await server.call('POST', `/campaigns/${CAMPAIGN}/resume`, {})
        expect(result.status).toBe(422)
        expect(result.body.code).toBe('campaign_not_ready')
        expect(result.body.issues.map((issue: Row) => issue.code)).toContain('protected_sending_domain')
        expect(stored().status).toBe('paused')
        expect(state.audits).toHaveLength(0)
    })

    it('runs the activation readiness gate: a warm-up-only seed blocks the resume (three-mailbox rule)', async () => {
        pausedByAgent()
        rows('campaignLeads')[0].assignedEmailAccountId = SEED_ACCOUNT
        const result = await server.call('POST', `/campaigns/${CAMPAIGN}/resume`, {})
        expect(result.status).toBe(422)
        expect(result.body.issues.map((issue: Row) => issue.code)).toContain('email_account_invalid')
        expect(result.body.details.join(' ')).toContain('Warm-up-only')
        expect(stored().status).toBe('paused')
    })

    it('runs the activation readiness gate: an unwarmed inbox blocks the resume', async () => {
        pausedByAgent()
        Object.assign(rows('emailAccounts')[0], { warmupEnabled: true, warmupCurrentDay: 3, warmupDays: 14 })
        const result = await server.call('POST', `/campaigns/${CAMPAIGN}/resume`, {})
        expect(result.status).toBe(422)
        expect(result.body.issues.map((issue: Row) => issue.code)).toContain('sending_inbox_not_warmed')
    })

    it('needs the manage scope and the caller\'s own organization', async () => {
        pausedByAgent()
        principalMock.mockReturnValue(principal(['outreach:read']))
        expect((await server.call('POST', `/campaigns/${CAMPAIGN}/resume`, {})).status).toBe(403)
        principalMock.mockReturnValue(principal(['outreach:manage'], OTHER_ORG))
        expect((await server.call('POST', `/campaigns/${CAMPAIGN}/resume`, {})).status).toBe(404)
        expect(stored().status).toBe('paused')
    })

    it('rolls the status change back when the audit row cannot be written', async () => {
        pausedByAgent()
        state.failNextAudit = true
        const result = await server.call('POST', `/campaigns/${CAMPAIGN}/resume`, {})
        expect(result.status).toBe(500)
        expect(stored().status).toBe('paused')
        expect(publishMock).not.toHaveBeenCalled()
    })
})
