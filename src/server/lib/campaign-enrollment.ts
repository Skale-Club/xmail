import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
    campaignLeads,
    campaigns,
    emailAccounts,
    leads,
    suppressions,
    type CampaignLead,
} from '../../db/schema'
import { getCanonicalSequence } from './outreach-sequences'
import { isPlatformEmail } from './platform-emails'
import { checkProtectedSendingDomains, isCampaignSenderEligible } from './sending-domain-guard'

/**
 * The one place that puts leads onto a campaign.
 *
 * Used by the human route (`POST /api/outreach/campaigns/:campaignId/leads`), the Hermes gateway
 * (`POST /api/agent/outreach/campaigns/:id/enroll`, draft campaigns) and the approval executor
 * (`campaign_enrollment`, approved by the owner on Telegram or in the panel), so org scoping, the
 * campaign row lock, the terminal-status re-check, the per-(campaign, lead) dedup, lead
 * eligibility, sender assignment and the scheduling of the first send are decided exactly once.
 *
 * Two policies, because the two callers have always had different rules:
 *   - `human`: the panel/Xphere route. Legacy and manually imported leads are legitimately
 *     'unknown', so only a confirmed 'invalid' address and a booking-platform address are refused.
 *     Unsubscribed or suppressed leads are NOT filtered at enroll time (the delivery policy parks
 *     them at send time); an id that is not in the organization is a 400 for the whole request.
 *   - `agent`: Hermes and the approval executor. Stricter: the lead must belong to the org, have
 *     an email, not be unsubscribed or suppressed, not be a booking-platform address, and carry a
 *     'verified' or 'likely' verification status. Ineligible leads are skipped and reported with a
 *     reason, never silently dropped and never a reason to refuse the whole batch.
 *
 * Senders: only inboxes that can carry cold campaign traffic (`isCampaignSenderEligible`: verified,
 * not warm-up-only, not on a protected company domain, so never `info@` or a warm-up box).
 */

export type EnrollmentPolicy = 'human' | 'agent'

export type EnrollmentSkipReason =
    | 'not_found'
    | 'no_email'
    | 'unsubscribed'
    | 'suppressed'
    | 'invalid_email'
    | 'platform_email'
    | 'email_not_verified'

/**
 * How each new campaign lead gets its sending inbox.
 *  - `explicit`: one named inbox for all of them.
 *  - `auto`: round-robin across the campaign's eligible sending inboxes (balanced by how many open
 *    leads each already carries); a campaign with no inbox yet uses every eligible inbox of the org.
 *  - `unassigned`: leave it NULL. This is the human route's historical behaviour when the panel sends
 *    no inbox; such a row is not sendable until an inbox is assigned.
 */
export type SenderSelection =
    | { mode: 'explicit'; emailAccountId: string }
    | { mode: 'auto' }
    | { mode: 'unassigned' }

export class CampaignEnrollmentError extends Error {
    constructor(
        readonly status: 400 | 404 | 409 | 422,
        readonly code: string,
        message: string,
    ) {
        super(message)
    }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type EnrollmentExecutor = Pick<typeof db, 'query' | 'select' | 'execute'> | Transaction

export interface EnrollmentInput {
    organizationId: string
    campaignId: string
    leadIds: string[]
    senders: SenderSelection
    policy: EnrollmentPolicy
}

export interface PlannedLead {
    leadId: string
    email: string
    companyName: string | null
    assignedEmailAccountId: string | null
}

export interface PlannedSender {
    emailAccountId: string
    email: string
    count: number
}

export interface EnrollmentPlan {
    campaign: { id: string; name: string; status: string }
    /** Distinct lead ids that were asked for. */
    requested: number
    toAdd: PlannedLead[]
    alreadyEnrolled: string[]
    ineligible: Array<{ leadId: string; reason: EnrollmentSkipReason }>
    senders: PlannedSender[]
    /** Requested leads (not 'invalid') whose address is not confirmed verified/likely yet. Informational. */
    unverifiedCount: number
}

export interface EnrollmentResult {
    plan: EnrollmentPlan
    inserted: CampaignLead[]
}

export const TERMINAL_CAMPAIGN_STATUSES = ['completed', 'archived'] as const

export function isTerminalCampaignStatus(status: string): boolean {
    return (TERMINAL_CAMPAIGN_STATUSES as readonly string[]).includes(status)
}

export function campaignEnrollmentClosedError(status: string): CampaignEnrollmentError {
    return new CampaignEnrollmentError(409, 'campaign_enrollment_closed', `Cannot enroll leads into a ${status} campaign`)
}

function resultRows<T>(value: unknown): T[] {
    if (Array.isArray(value)) return value as T[]
    if (value && typeof value === 'object' && 'rows' in value) {
        const rows = (value as { rows?: unknown }).rows
        return Array.isArray(rows) ? rows as T[] : []
    }
    return []
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

interface SenderCandidate {
    id: string
    email: string
    load: number
}

type SenderPool = { kind: 'unassigned' } | { kind: 'pool'; senders: SenderCandidate[] }

async function resolveExplicitSender(
    executor: EnrollmentExecutor,
    organizationId: string,
    emailAccountId: string,
    policy: EnrollmentPolicy,
): Promise<SenderCandidate> {
    const account = await executor.query.emailAccounts.findFirst({
        where: and(eq(emailAccounts.id, emailAccountId), eq(emailAccounts.organizationId, organizationId)),
        columns: { id: true, email: true, warmupOnly: true, status: true },
    })
    if (!account) {
        throw new CampaignEnrollmentError(
            400,
            'sender_not_found',
            policy === 'agent' ? 'Verified sending inbox not found or access denied' : 'Email account not found or access denied',
        )
    }
    if (account.warmupOnly) {
        throw new CampaignEnrollmentError(422, 'sender_warmup_only', 'This inbox is warm-up-only and cannot be assigned to campaign leads')
    }
    // System map §8 finding #7 / P009: cold outreach must never send from the primary transactional
    // domain. Checked at enroll time so a violation surfaces here and not at activation.
    const protectedViolation = checkProtectedSendingDomains([account])
    if (protectedViolation) {
        throw new CampaignEnrollmentError(422, protectedViolation.code, protectedViolation.message)
    }
    // The panel never required a verified inbox here (activation does); the agent always did.
    if (policy === 'agent' && account.status !== 'verified') {
        throw new CampaignEnrollmentError(400, 'sender_not_found', 'Verified sending inbox not found or access denied')
    }
    return { id: account.id, email: account.email, load: 0 }
}

async function resolveAutoSenders(
    executor: EnrollmentExecutor,
    organizationId: string,
    campaignId: string,
): Promise<SenderCandidate[]> {
    // The inboxes this campaign already uses, with how many of its leads are still open on each.
    const used = await executor
        .select({
            id: campaignLeads.assignedEmailAccountId,
            open: sql<number>`count(*) filter (where ${campaignLeads.completedAt} is null)::int`,
        })
        .from(campaignLeads)
        .where(and(eq(campaignLeads.campaignId, campaignId), isNotNull(campaignLeads.assignedEmailAccountId)))
        .groupBy(campaignLeads.assignedEmailAccountId)
    const loadById = new Map<string, number>()
    for (const row of used) if (row.id) loadById.set(row.id, Number(row.open) || 0)

    const columns = { id: true, email: true, status: true, warmupOnly: true } as const
    const campaignAccounts = loadById.size === 0 ? [] : await executor.query.emailAccounts.findMany({
        where: and(eq(emailAccounts.organizationId, organizationId), inArray(emailAccounts.id, [...loadById.keys()])),
        columns,
    })
    let eligible = campaignAccounts.filter(isCampaignSenderEligible)
    if (eligible.length === 0) {
        // A campaign with no usable inbox of its own (a fresh draft): every eligible inbox of the org.
        const orgAccounts = await executor.query.emailAccounts.findMany({
            where: and(
                eq(emailAccounts.organizationId, organizationId),
                eq(emailAccounts.status, 'verified'),
                eq(emailAccounts.warmupOnly, false),
            ),
            columns,
        })
        eligible = orgAccounts.filter(isCampaignSenderEligible)
    }
    return eligible
        .map((account) => ({ id: account.id, email: account.email, load: loadById.get(account.id) ?? 0 }))
        .sort((a, b) => a.load - b.load || a.email.localeCompare(b.email))
}

async function resolveSenderPool(
    executor: EnrollmentExecutor,
    input: EnrollmentInput,
): Promise<SenderPool> {
    const { senders } = input
    if (senders.mode === 'unassigned') return { kind: 'unassigned' }
    if (senders.mode === 'explicit') {
        return { kind: 'pool', senders: [await resolveExplicitSender(executor, input.organizationId, senders.emailAccountId, input.policy)] }
    }
    return { kind: 'pool', senders: await resolveAutoSenders(executor, input.organizationId, input.campaignId) }
}

/** Round-robin over the pool, always handing the next lead to the inbox carrying the fewest open leads. */
export function distributeAcrossSenders(count: number, senders: SenderCandidate[]): Array<SenderCandidate> {
    const loads = senders.map((sender) => ({ sender, load: sender.load }))
    const picks: SenderCandidate[] = []
    for (let i = 0; i < count; i++) {
        let best = loads[0]
        for (const candidate of loads) if (candidate.load < best.load) best = candidate
        best.load++
        picks.push(best.sender)
    }
    return picks
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

async function loadSuppressedKeys(
    executor: EnrollmentExecutor,
    organizationId: string,
    emails: string[],
): Promise<Set<string>> {
    const keys = new Set<string>()
    for (const email of emails) {
        keys.add(email)
        const domain = email.split('@')[1]
        if (domain) keys.add(`@${domain}`)
    }
    if (keys.size === 0) return new Set()
    const lowered = sql`lower(${suppressions.emailAddress})`
    const rows = await executor
        .select({ key: sql<string>`lower(${suppressions.emailAddress})` })
        .from(suppressions)
        .where(and(eq(suppressions.organizationId, organizationId), inArray(lowered, [...keys])))
    return new Set(rows.map((row) => row.key))
}

/**
 * Build the enrollment plan against the executor's current view of the database: who would be
 * added, who is already on the campaign, who is ineligible and why, and which inbox each new lead
 * would get. Read-only. Called on `db` for a dry run and on the locked transaction for the real thing.
 */
export async function planCampaignEnrollment(
    executor: EnrollmentExecutor,
    input: EnrollmentInput,
): Promise<EnrollmentPlan> {
    const { organizationId, campaignId, policy } = input
    const campaign = await executor.query.campaigns.findFirst({
        where: and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, organizationId)),
        columns: { id: true, name: true, status: true },
    })
    if (!campaign) throw new CampaignEnrollmentError(404, 'campaign_not_found', 'Campaign not found')

    const requestedIds = policy === 'human' ? input.leadIds : [...new Set(input.leadIds)]
    const uniqueIds = [...new Set(requestedIds)]

    const sender = await resolveSenderPool(executor, input)

    const found = uniqueIds.length === 0 ? [] : await executor.query.leads.findMany({
        where: and(eq(leads.organizationId, organizationId), inArray(leads.id, uniqueIds)),
    })
    if (policy === 'human' && found.length !== requestedIds.length) {
        throw new CampaignEnrollmentError(400, 'leads_not_found', 'Some leads not found or access denied')
    }
    const foundById = new Map(found.map((lead) => [lead.id, lead]))

    const existing = uniqueIds.length === 0 ? [] : await executor.query.campaignLeads.findMany({
        where: and(eq(campaignLeads.campaignId, campaignId), inArray(campaignLeads.leadId, uniqueIds)),
        columns: { leadId: true },
    })
    const existingIds = new Set(existing.map((row) => row.leadId))

    const suppressedKeys = policy === 'agent'
        ? await loadSuppressedKeys(executor, organizationId, found.map((lead) => lead.email?.trim().toLowerCase()).filter((email): email is string => Boolean(email)))
        : new Set<string>()

    const ineligible: EnrollmentPlan['ineligible'] = []
    const eligible: Array<typeof found[number]> = []
    const alreadyEnrolled: string[] = []
    for (const leadId of uniqueIds) {
        const lead = foundById.get(leadId)
        if (!lead) {
            ineligible.push({ leadId, reason: 'not_found' })
            continue
        }
        if (existingIds.has(leadId)) {
            alreadyEnrolled.push(leadId)
            continue
        }
        const reason = skipReason(lead, policy, suppressedKeys)
        if (reason) ineligible.push({ leadId, reason })
        else eligible.push(lead)
    }

    const unverifiedCount = found.filter((lead) => (
        lead.emailVerificationStatus !== 'invalid'
        && lead.emailVerificationStatus !== 'verified'
        && lead.emailVerificationStatus !== 'likely'
    )).length

    let picks: Array<SenderCandidate | null>
    if (sender.kind === 'unassigned') {
        picks = eligible.map(() => null)
    } else {
        if (eligible.length > 0 && sender.senders.length === 0) {
            throw new CampaignEnrollmentError(
                422,
                'no_eligible_sender',
                'No eligible sending inbox: the organization has no verified, non-warm-up inbox outside the protected company domains',
            )
        }
        picks = distributeAcrossSenders(eligible.length, sender.senders)
    }

    const countBySender = new Map<string, PlannedSender>()
    const toAdd: PlannedLead[] = eligible.map((lead, index) => {
        const pick = picks[index]
        if (pick) {
            const entry = countBySender.get(pick.id) ?? { emailAccountId: pick.id, email: pick.email, count: 0 }
            entry.count++
            countBySender.set(pick.id, entry)
        }
        return {
            leadId: lead.id,
            email: lead.email,
            companyName: lead.companyName ?? null,
            assignedEmailAccountId: pick?.id ?? null,
        }
    })

    return {
        campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
        requested: uniqueIds.length,
        toAdd,
        alreadyEnrolled,
        ineligible,
        senders: [...countBySender.values()].sort((a, b) => b.count - a.count || a.email.localeCompare(b.email)),
        unverifiedCount,
    }
}

function skipReason(
    lead: { email: string | null; unsubscribedAt: Date | null; status: string; emailVerificationStatus: string },
    policy: EnrollmentPolicy,
    suppressedKeys: Set<string>,
): EnrollmentSkipReason | null {
    if (policy === 'agent') {
        const email = lead.email?.trim().toLowerCase()
        if (!email) return 'no_email'
        if (lead.unsubscribedAt || lead.status === 'unsubscribed') return 'unsubscribed'
        const domain = email.split('@')[1]
        if (suppressedKeys.has(email) || (domain && suppressedKeys.has(`@${domain}`))) return 'suppressed'
    }
    // Verification gate: a confirmed-bad address is never enrolled, by anyone.
    if (lead.emailVerificationStatus === 'invalid') return 'invalid_email'
    // Defeito 2 (2026-09-30): a scheduling/marketplace platform's own address (Booksy support
    // etc, see platform-emails.ts) may already sit in the leads table; never let it onto a campaign.
    if (lead.email && isPlatformEmail(lead.email)) return 'platform_email'
    if (policy === 'agent' && lead.emailVerificationStatus !== 'verified' && lead.emailVerificationStatus !== 'likely') {
        return 'email_not_verified'
    }
    return null
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export interface EnrollCampaignLeadsOptions extends EnrollmentInput {
    /**
     * Plan (and so re-check eligibility) inside the transaction, after the campaign row is locked,
     * instead of before it. The approval executor needs this: it must decide on the state at the
     * moment of the insert, not on what was true when the owner tapped. The panel route keeps the
     * cheaper "plan, then lock and dedup" shape and its "nothing to add, no transaction" answer.
     */
    planInsideTransaction?: boolean
    /** Runs inside the same transaction after the rows are inserted; throwing rolls the enrollment back. */
    beforeCommit?: (tx: Transaction, result: EnrollmentResult) => Promise<void>
}

export async function requireCampaignFirstStep(organizationId: string, campaignId: string) {
    const canonicalSequence = await getCanonicalSequence(campaignId, organizationId)
    if (!canonicalSequence) {
        throw new CampaignEnrollmentError(
            400,
            'campaign_has_no_sequence',
            'Campaign has no sequence — create a sequence with at least one step before adding leads',
        )
    }
    const firstStep = canonicalSequence.steps[0]
    if (!firstStep) {
        throw new CampaignEnrollmentError(
            400,
            'campaign_sequence_empty',
            'Campaign sequence has no steps — add at least one step before adding leads',
        )
    }
    return firstStep
}

export async function enrollCampaignLeads(options: EnrollCampaignLeadsOptions): Promise<EnrollmentResult> {
    const { organizationId, campaignId, planInsideTransaction, beforeCommit, ...input } = options
    const planInput: EnrollmentInput = { organizationId, campaignId, ...input }

    let prePlan: EnrollmentPlan | null = null
    if (!planInsideTransaction) {
        prePlan = await planCampaignEnrollment(db, planInput)
        if (isTerminalCampaignStatus(prePlan.campaign.status)) throw campaignEnrollmentClosedError(prePlan.campaign.status)
        if (prePlan.toAdd.length === 0) {
            // Not an error for orchestration callers: every submitted lead is already in the campaign
            // or ineligible. Idempotent retries must succeed.
            return { plan: prePlan, inserted: [] }
        }
    }
    const firstStep = await requireCampaignFirstStep(organizationId, campaignId)

    return db.transaction(async (tx) => {
        const lockedCampaign = resultRows<{ status: string }>(await tx.execute(sql`
            SELECT status::text AS status
            FROM campaigns
            WHERE id = ${campaignId}::uuid AND organization_id = ${organizationId}::uuid
            FOR UPDATE
        `))[0]
        if (!lockedCampaign) throw new CampaignEnrollmentError(409, 'campaign_enrollment_closed', 'Campaign no longer exists')
        if (isTerminalCampaignStatus(lockedCampaign.status)) throw campaignEnrollmentClosedError(lockedCampaign.status)

        let plan = prePlan
        let toAdd: PlannedLead[]
        if (plan) {
            // Leads enrolled by someone else between the plan and the lock.
            const currentRows = await tx
                .select({ leadId: campaignLeads.leadId })
                .from(campaignLeads)
                .where(and(
                    eq(campaignLeads.campaignId, campaignId),
                    inArray(campaignLeads.leadId, plan.toAdd.map((lead) => lead.leadId)),
                ))
            const currentLeadIds = new Set(currentRows.map((row) => row.leadId))
            toAdd = plan.toAdd.filter((lead) => !currentLeadIds.has(lead.leadId))
        } else {
            plan = await planCampaignEnrollment(tx, planInput)
            toAdd = plan.toAdd
        }

        let inserted: CampaignLead[] = []
        if (toAdd.length > 0) {
            // nextScheduledAt MUST be non-NULL or the processor's lte(nextScheduledAt, now) filter
            // treats the row as not-yet-due (NULL semantics in SQL). See audit P0-01.
            const now = new Date()
            inserted = await tx.insert(campaignLeads).values(toAdd.map((lead) => ({
                campaignId,
                leadId: lead.leadId,
                assignedEmailAccountId: lead.assignedEmailAccountId ?? undefined,
                currentStepId: firstStep.id,
                currentStepOrder: firstStep.stepOrder,
                nextScheduledAt: now,
            }))).returning()
            await tx.update(campaigns)
                .set({ totalLeads: sql`${campaigns.totalLeads} + ${inserted.length}` })
                .where(eq(campaigns.id, campaignId))
        }

        const result: EnrollmentResult = { plan, inserted }
        if (beforeCommit) await beforeCommit(tx, result)
        return result
    })
}

// ---------------------------------------------------------------------------
// Summaries (dry run, approval payload, audit)
// ---------------------------------------------------------------------------

export interface EnrollmentSummary {
    willAdd: number
    alreadyEnrolled: number
    ineligible: number
    /** Everything left out, `already_enrolled` included, by reason. */
    leftOutByReason: Record<string, number>
    senders: Array<{ emailAccountId: string; email: string; count: number }>
    exampleCompanies: string[]
}

export const EXAMPLE_COMPANY_LIMIT = 8

export function summarizeEnrollmentPlan(plan: EnrollmentPlan): EnrollmentSummary {
    const leftOutByReason: Record<string, number> = {}
    if (plan.alreadyEnrolled.length > 0) leftOutByReason.already_enrolled = plan.alreadyEnrolled.length
    for (const entry of plan.ineligible) leftOutByReason[entry.reason] = (leftOutByReason[entry.reason] ?? 0) + 1
    const exampleCompanies: string[] = []
    for (const lead of plan.toAdd) {
        const name = lead.companyName?.trim()
        if (name && !exampleCompanies.includes(name)) exampleCompanies.push(name)
        if (exampleCompanies.length >= EXAMPLE_COMPANY_LIMIT) break
    }
    return {
        willAdd: plan.toAdd.length,
        alreadyEnrolled: plan.alreadyEnrolled.length,
        ineligible: plan.ineligible.length,
        leftOutByReason,
        senders: plan.senders,
        exampleCompanies,
    }
}
