import { createHash, randomUUID } from 'node:crypto'
import {
    evaluateOutreachDeliveryPolicy,
    DeliveryPolicyCode,
    DeliveryPolicyDecision,
    DeliveryPolicyInput,
    OutreachOrigin,
    effectiveDailyLimit,
    type AccountPolicySnapshot,
} from './outreach-delivery-policy'

type ErrorRecord = Record<string, unknown>

function asErrorRecord(error: unknown): ErrorRecord {
    return typeof error === 'object' && error !== null ? error as ErrorRecord : {}
}

function numericErrorField(error: ErrorRecord, ...fields: string[]): number | undefined {
    for (const field of fields) {
        const value = Number(error[field])
        if (Number.isFinite(value) && value > 0) return value
    }
    return undefined
}

function stringErrorField(error: ErrorRecord, field: string): string | undefined {
    const value = error[field]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export type ProviderAcceptance = 'accepted' | 'rejected' | 'unknown'
export type ProviderFailureClass = 'transient' | 'terminal' | 'ambiguous'

export interface ProviderFailure {
    code: string
    classification: ProviderFailureClass
    acceptance: Exclude<ProviderAcceptance, 'accepted'>
    retryable: boolean
    message: string
}

function providerFailure(
    code: string,
    classification: ProviderFailureClass,
    acceptance: Exclude<ProviderAcceptance, 'accepted'>,
    retryable: boolean,
    message: string,
): ProviderFailure {
    return { code, classification, acceptance, retryable, message: message.slice(0, 500) }
}

export function normalizeProviderFailure(error: unknown): ProviderFailure {
    const record = asErrorRecord(error)
    const rawCode = stringErrorField(record, 'code')?.toUpperCase()
    const command = stringErrorField(record, 'command')?.toUpperCase()
    const smtpResponseCode = numericErrorField(record, 'responseCode')
    const httpStatusCode = numericErrorField(record, 'statusCode', 'status')
    const message = error instanceof Error ? error.message : 'Unknown provider failure'
    const accepted = Array.isArray(record.accepted) && record.accepted.length > 0

    if (accepted) {
        return providerFailure('provider_outcome_unknown', 'ambiguous', 'unknown', false, message)
    }

    if (httpStatusCode === 408 || httpStatusCode === 429 || (httpStatusCode != null && httpStatusCode >= 500 && httpStatusCode <= 599)) {
        return providerFailure(`provider_${httpStatusCode}`, 'transient', 'rejected', true, message)
    }

    if (httpStatusCode != null && httpStatusCode >= 400 && httpStatusCode <= 499) {
        return providerFailure(`provider_${httpStatusCode}`, 'terminal', 'rejected', false, message)
    }

    if (smtpResponseCode != null && smtpResponseCode >= 400 && smtpResponseCode <= 499) {
        return providerFailure(`smtp_${smtpResponseCode}`, 'transient', 'rejected', true, message)
    }

    if (rawCode === 'EAUTH' || httpStatusCode === 401 || httpStatusCode === 403 || rawCode === 'EMESSAGE') {
        return providerFailure(rawCode?.toLowerCase() || `provider_${httpStatusCode}`, 'terminal', 'rejected', false, message)
    }

    const definitelyPreAcceptance = new Set([
        'EDNS',
        'ECONNECTION',
        'ECONNREFUSED',
        'EHOSTUNREACH',
        'ENETUNREACH',
    ])
    const preDataCommand = command != null && ['CONN', 'CONNECT', 'EHLO', 'HELO', 'MAIL', 'RCPT'].includes(command)
    const phaseSensitiveConnectionError = rawCode && ['ETIMEDOUT', 'ECONNRESET', 'ESOCKET'].includes(rawCode)
    if ((rawCode && definitelyPreAcceptance.has(rawCode)) || (phaseSensitiveConnectionError && preDataCommand)) {
        return providerFailure(rawCode?.toLowerCase() || 'connection_failed', 'transient', 'rejected', true, message)
    }

    if (smtpResponseCode != null && smtpResponseCode >= 500) {
        return providerFailure(`smtp_${smtpResponseCode}`, 'terminal', 'rejected', false, message)
    }

    return providerFailure('provider_outcome_unknown', 'ambiguous', 'unknown', false, message)
}

export type ProviderDispatchResult =
    | {
        success: true
        acceptance: 'accepted'
        messageId?: string
        finalHtml?: string
        finalText?: string
    }
    | {
        success: false
        acceptance: Exclude<ProviderAcceptance, 'accepted'>
        failure: ProviderFailure
    }

export interface DispatchOutreachInput {
    origin: OutreachOrigin
    organizationId: string
    emailAccountId: string
    campaignId?: string
    campaignLeadId?: string
    sequenceStepId?: string
    leadId?: string
    trackingToken?: string
    idempotencyKey: string
    to: string
    subject: string
    text?: string | null
    html?: string | null
    inReplyTo?: string | null
    references?: string | null
    abVariant?: 'a' | 'b'
    maxAttempts?: number
}

export interface DispatchClaimed {
    kind: 'claimed'
    rowId: string
    leaseToken: string
    attemptCount: number
    maxAttempts: number
    payload: {
        to: string
        subject: string
        text: string | null
        html: string | null
        trackingToken?: string
        inReplyTo?: string | null
        references?: string | null
        abVariant?: 'a' | 'b'
    }
}

export type DispatchClaimResult = DispatchClaimed | {
    kind: 'duplicate' | 'in_progress' | 'held' | 'exhausted'
    rowId: string
}

export interface DispatchRepository {
    claim(input: DispatchOutreachInput, context: {
        now: Date
        leaseToken: string
        leaseExpiresAt: Date
    }): Promise<DispatchClaimResult>
    startDispatch(
        claim: DispatchClaimed,
        now: Date,
        capacity: { account: AccountPolicySnapshot; dailyLimit: number },
    ): Promise<{ attemptCount: number; maxAttempts: number } | null>
    releaseClaim(claim: DispatchClaimed, code: DeliveryPolicyCode, now: Date): Promise<boolean>
    finalizeSent(claim: DispatchClaimed, result: Extract<ProviderDispatchResult, { success: true }>, now: Date): Promise<boolean>
    finalizeFailure(claim: DispatchClaimed, input: {
        status: 'failed' | 'held'
        failure: ProviderFailure
        nextAttemptAt: Date | null
        now: Date
    }): Promise<boolean>
}

export interface DispatchProvider {
    send(input: DispatchOutreachInput & { stableMessageId: string }): Promise<ProviderDispatchResult>
}

export interface DispatchDependencies {
    repository?: DispatchRepository
    provider: DispatchProvider
    evaluatePolicy?: (input: DeliveryPolicyInput) => Promise<DeliveryPolicyDecision>
    now?: () => Date
    leaseToken?: () => string
}

export type DispatchResult =
    | { status: 'sent'; rowId: string; messageId?: string }
    | { status: 'deferred'; code: DeliveryPolicyCode; retryAt?: Date }
    | { status: 'duplicate' | 'in_progress' | 'held' | 'exhausted' | 'lost_lease'; rowId: string }
    | { status: 'retry_scheduled' | 'failed'; rowId: string; code: string; nextAttemptAt?: Date }

export interface ExistingDispatchState {
    status: 'queued' | 'sent' | 'failed' | 'held'
    attemptCount: number
    maxAttempts: number
    nextAttemptAt: Date | null
    leaseExpiresAt: Date | null
    dispatchStartedAt: Date | null
}

export type ExistingDispatchDecision = 'claim' | 'duplicate' | 'in_progress' | 'held' | 'exhausted'

export function decideExistingDispatch(state: ExistingDispatchState, now: Date): ExistingDispatchDecision {
    if (state.status === 'sent') return 'duplicate'
    if (state.status === 'held') return 'held'

    if (state.status === 'failed') {
        if (state.attemptCount >= state.maxAttempts || !state.nextAttemptAt) return 'exhausted'
        return state.nextAttemptAt.getTime() <= now.getTime() ? 'claim' : 'in_progress'
    }

    const leaseExpired = !state.leaseExpiresAt || state.leaseExpiresAt.getTime() <= now.getTime()
    if (!leaseExpired) return 'in_progress'
    return state.dispatchStartedAt ? 'held' : 'claim'
}

const INITIAL_BACKOFF_MS = 60_000
const MAX_BACKOFF_MS = 60 * 60_000
const LEASE_DURATION_MS = 5 * 60_000

export function calculateDispatchBackoff(attemptCount: number, now: Date): Date {
    const exponent = Math.max(0, Math.min(10, attemptCount - 1))
    const delay = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * (2 ** exponent))
    return new Date(now.getTime() + delay)
}

export function createStableOutreachMessageId(organizationId: string, idempotencyKey: string): string {
    const digest = createHash('sha256')
        .update(organizationId)
        .update('\0')
        .update(idempotencyKey)
        .digest('hex')
        .slice(0, 40)
    return `<xmail-${digest}@outreach.local>`
}

function validateDispatchInput(input: DispatchOutreachInput): void {
    if (!input.organizationId || !input.emailAccountId) throw new Error('Dispatch tenant and account are required')
    if (!input.idempotencyKey.trim() || !input.to.trim()) throw new Error('Dispatch idempotency key and recipient are required')
    if (!input.subject.trim()) throw new Error('Dispatch subject is required')

    if (input.origin === 'campaign') {
        if (!input.campaignId || !input.campaignLeadId || !input.sequenceStepId || !input.trackingToken) {
            throw new Error('Campaign dispatch requires campaign, lead, step, and tracking token')
        }
    } else if (input.origin === 'agentic') {
        if (!input.campaignId || !input.campaignLeadId || input.sequenceStepId) {
            throw new Error('Agentic dispatch requires campaign and lead without sequence step')
        }
    } else if (input.campaignId || input.campaignLeadId || input.sequenceStepId) {
        throw new Error(`${input.origin} dispatch cannot carry campaign linkage`)
    }
}

interface DispatchRow {
    id: string
    status: ExistingDispatchState['status']
    attemptCount: number
    maxAttempts: number
    nextAttemptAt: Date | null
    leaseToken: string | null
    leaseExpiresAt: Date | null
    dispatchStartedAt: Date | null
    toAddress: string
    subject: string
    plainBody: string | null
    htmlBody: string | null
    trackingToken: string | null
    inReplyTo: string | null
    messageReferences: string | null
    abVariant: 'a' | 'b' | null
}

function frozenPayload(row: DispatchRow): DispatchClaimed['payload'] {
    return {
        to: row.toAddress,
        subject: row.subject,
        text: row.plainBody,
        html: row.htmlBody,
        trackingToken: row.trackingToken ?? undefined,
        inReplyTo: row.inReplyTo,
        references: row.messageReferences,
        abVariant: row.abVariant ?? undefined,
    }
}

function firstRow<T>(rows: unknown): T | undefined {
    return Array.isArray(rows) ? rows[0] as T | undefined : undefined
}

export interface DispatchSqlClient {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>
}

export function createSqlDispatchRepository(
    getClient: () => Promise<DispatchSqlClient>,
): DispatchRepository {
    return {
        async claim(input, context) {
            const queryClient = await getClient()

            await queryClient`
                UPDATE outreach_emails AS outreach_email
                SET status = 'held',
                    lease_token = NULL,
                    lease_expires_at = NULL,
                    next_attempt_at = NULL,
                    last_error_code = 'ambiguous_stale_lease',
                    updated_at = ${context.now}
                WHERE organization_id = ${input.organizationId}
                  AND idempotency_key = ${input.idempotencyKey}
                  AND status = 'queued'
                  AND dispatch_started_at IS NOT NULL
                  AND (lease_expires_at IS NULL OR lease_expires_at <= ${context.now})
            `

            const claimedRows = await queryClient`
                INSERT INTO outreach_emails (
                    organization_id, origin, idempotency_key, to_address,
                    campaign_id, campaign_lead_id, sequence_step_id, email_account_id,
                    tracking_token, subject, plain_body, html_body, in_reply_to, message_references, ab_variant, status,
                    attempt_count, max_attempts, lease_token, lease_expires_at,
                    created_at, updated_at
                ) VALUES (
                    ${input.organizationId}, ${input.origin}, ${input.idempotencyKey}, ${input.to},
                    ${input.campaignId ?? null}, ${input.campaignLeadId ?? null}, ${input.sequenceStepId ?? null}, ${input.emailAccountId},
                    ${input.trackingToken ?? null}, ${input.subject}, ${input.text ?? null}, ${input.html ?? null},
                    ${input.inReplyTo ?? null}, ${input.references ?? null}, ${input.abVariant ?? null}, 'queued',
                    0, ${Math.max(1, input.maxAttempts ?? 3)}, ${context.leaseToken}::uuid, ${context.leaseExpiresAt},
                    ${context.now}, ${context.now}
                )
                ON CONFLICT (organization_id, idempotency_key) DO UPDATE SET
                    status = 'queued',
                    lease_token = EXCLUDED.lease_token,
                    lease_expires_at = EXCLUDED.lease_expires_at,
                    next_attempt_at = NULL,
                    last_error_code = NULL,
                    updated_at = EXCLUDED.updated_at
                WHERE (
                    outreach_emails.status = 'queued'
                    AND outreach_emails.dispatch_started_at IS NULL
                    AND (outreach_emails.lease_expires_at IS NULL OR outreach_emails.lease_expires_at <= ${context.now})
                ) OR (
                    outreach_emails.status = 'failed'
                    AND outreach_emails.attempt_count < outreach_emails.max_attempts
                    AND outreach_emails.next_attempt_at IS NOT NULL
                    AND outreach_emails.next_attempt_at <= ${context.now}
                )
                RETURNING id,
                    status::text AS status,
                    attempt_count AS "attemptCount",
                    max_attempts AS "maxAttempts",
                    next_attempt_at AS "nextAttemptAt",
                    lease_token::text AS "leaseToken",
                    lease_expires_at AS "leaseExpiresAt",
                    dispatch_started_at AS "dispatchStartedAt",
                    to_address AS "toAddress", subject,
                    plain_body AS "plainBody", html_body AS "htmlBody",
                    tracking_token AS "trackingToken", in_reply_to AS "inReplyTo",
                    message_references AS "messageReferences", ab_variant AS "abVariant"
            `
            const claimedRow = firstRow<DispatchRow>(claimedRows)
            if (claimedRow?.leaseToken) {
                return {
                    kind: 'claimed',
                    rowId: claimedRow.id,
                    leaseToken: claimedRow.leaseToken,
                    attemptCount: Number(claimedRow.attemptCount),
                    maxAttempts: Number(claimedRow.maxAttempts),
                    payload: frozenPayload(claimedRow),
                }
            }

            const existingRows = await queryClient`
                SELECT id,
                    status::text AS status,
                    attempt_count AS "attemptCount",
                    max_attempts AS "maxAttempts",
                    next_attempt_at AS "nextAttemptAt",
                    lease_token::text AS "leaseToken",
                    lease_expires_at AS "leaseExpiresAt",
                    dispatch_started_at AS "dispatchStartedAt",
                    to_address AS "toAddress", subject,
                    plain_body AS "plainBody", html_body AS "htmlBody",
                    tracking_token AS "trackingToken", in_reply_to AS "inReplyTo",
                    message_references AS "messageReferences", ab_variant AS "abVariant"
                FROM outreach_emails
                WHERE organization_id = ${input.organizationId}
                  AND idempotency_key = ${input.idempotencyKey}
                LIMIT 1
            `
            const existing = firstRow<DispatchRow>(existingRows)
            if (!existing) throw new Error('Dispatch claim was neither inserted nor found')
            const decision = decideExistingDispatch({
                    status: existing.status,
                    attemptCount: Number(existing.attemptCount),
                    maxAttempts: Number(existing.maxAttempts),
                    nextAttemptAt: existing.nextAttemptAt,
                    leaseExpiresAt: existing.leaseExpiresAt,
                    dispatchStartedAt: existing.dispatchStartedAt,
                }, context.now)
            return {
                // A second worker can change eligibility between the upsert and
                // diagnostic SELECT. The caller must not attempt a non-atomic reclaim.
                kind: decision === 'claim' ? 'in_progress' : decision,
                rowId: existing.id,
            }
        },

        async startDispatch(claim, now, capacity) {
            const queryClient = await getClient()
            const rows = await queryClient`
                WITH reserved_account AS (
                    UPDATE email_accounts
                    SET current_daily_sent = current_daily_sent + 1,
                        last_sent_at = ${now},
                        updated_at = ${now}
                    WHERE id = ${capacity.account.id}::uuid
                      AND organization_id = ${capacity.account.organizationId}::uuid
                      AND status = 'verified'
                      AND current_daily_sent < ${capacity.dailyLimit}
                      AND (
                          last_sent_at IS NULL
                          OR last_sent_at <= ${now} - (${Math.max(0, capacity.account.minMinutesBetweenEmails)} * INTERVAL '1 minute')
                      )
                      AND EXISTS (
                          SELECT 1 FROM outreach_emails
                          WHERE id = ${claim.rowId}::uuid
                            AND lease_token = ${claim.leaseToken}::uuid
                            AND status = 'queued'
                            AND dispatch_started_at IS NULL
                            AND lease_expires_at > ${now}
                            AND attempt_count < max_attempts
                            AND (capacity_reserved_at IS NULL OR capacity_released_at IS NOT NULL)
                      )
                    RETURNING id
                )
                UPDATE outreach_emails AS outreach_email
                SET dispatch_started_at = ${now},
                    last_attempt_at = ${now},
                    attempt_count = attempt_count + 1,
                    capacity_reserved_at = ${now},
                    capacity_released_at = NULL,
                    updated_at = ${now}
                FROM reserved_account
                WHERE outreach_email.id = ${claim.rowId}::uuid
                  AND outreach_email.lease_token = ${claim.leaseToken}::uuid
                  AND outreach_email.status = 'queued'
                  AND outreach_email.dispatch_started_at IS NULL
                  AND outreach_email.lease_expires_at > ${now}
                  AND outreach_email.attempt_count < outreach_email.max_attempts
                  AND outreach_email.email_account_id = reserved_account.id
                  AND (outreach_email.capacity_reserved_at IS NULL OR outreach_email.capacity_released_at IS NOT NULL)
                RETURNING outreach_email.attempt_count AS "attemptCount", outreach_email.max_attempts AS "maxAttempts"
            `
            const row = firstRow<{ attemptCount: number; maxAttempts: number }>(rows)
            return row ? { attemptCount: Number(row.attemptCount), maxAttempts: Number(row.maxAttempts) } : null
        },

        async releaseClaim(claim, code, now) {
            const queryClient = await getClient()
            const rows = await queryClient`
                UPDATE outreach_emails
                SET status = 'queued',
                    lease_token = NULL,
                    lease_expires_at = NULL,
                    dispatch_started_at = NULL,
                    next_attempt_at = NULL,
                    last_error_code = ${`policy_${code}`},
                    updated_at = ${now}
                WHERE id = ${claim.rowId}::uuid
                  AND lease_token = ${claim.leaseToken}::uuid
                  AND dispatch_started_at IS NULL
                RETURNING id
            `
            return firstRow(rows) != null
        },

        async finalizeSent(claim, result, now) {
            const queryClient = await getClient()
            const rows = await queryClient`
                WITH finalized AS (
                UPDATE outreach_emails
                SET status = 'sent',
                    message_id = ${result.messageId ?? null},
                    plain_body = COALESCE(${result.finalText ?? null}, plain_body),
                    html_body = COALESCE(${result.finalHtml ?? null}, html_body),
                    sent_at = ${now},
                    next_attempt_at = NULL,
                    lease_token = NULL,
                    lease_expires_at = NULL,
                    last_error_code = NULL,
                    updated_at = ${now}
                WHERE id = ${claim.rowId}::uuid
                  AND lease_token = ${claim.leaseToken}::uuid
                  AND status = 'queued'
                  AND dispatch_started_at IS NOT NULL
                RETURNING id, email_account_id
                ), counted AS (
                    UPDATE email_accounts
                    SET total_sent = total_sent + 1,
                        updated_at = ${now}
                    FROM finalized
                    WHERE email_accounts.id = finalized.email_account_id
                    RETURNING email_accounts.id
                )
                SELECT id FROM finalized
            `
            return firstRow(rows) != null
        },

        async finalizeFailure(claim, input) {
            const queryClient = await getClient()
            const rows = await queryClient`
                WITH finalized AS (
                UPDATE outreach_emails
                SET status = ${input.status}::message_status,
                    next_attempt_at = ${input.nextAttemptAt},
                    lease_token = NULL,
                    lease_expires_at = NULL,
                    dispatch_started_at = CASE WHEN ${input.status} = 'failed' THEN NULL ELSE dispatch_started_at END,
                    last_error_code = ${input.failure.code},
                    bounce_reason = ${input.failure.message},
                    capacity_released_at = CASE
                        WHEN ${input.status} = 'failed' THEN ${input.now}
                        ELSE capacity_released_at
                    END,
                    updated_at = ${input.now}
                WHERE id = ${claim.rowId}::uuid
                  AND lease_token = ${claim.leaseToken}::uuid
                  AND status = 'queued'
                  AND dispatch_started_at IS NOT NULL
                RETURNING id, email_account_id,
                    (${input.status} = 'failed' AND capacity_reserved_at IS NOT NULL) AS release_capacity
                ), released AS (
                    UPDATE email_accounts
                    SET current_daily_sent = GREATEST(current_daily_sent - 1, 0),
                        updated_at = ${input.now}
                    FROM finalized
                    WHERE email_accounts.id = finalized.email_account_id
                      AND finalized.release_capacity
                    RETURNING email_accounts.id
                )
                SELECT id FROM finalized
            `
            return firstRow(rows) != null
        },
    }
}

export function createDrizzleDispatchRepository(): DispatchRepository {
    return createSqlDispatchRepository(async () => {
        const { queryClient } = await import('../../db')
        return queryClient as unknown as DispatchSqlClient
    })
}

function policyInput(input: DispatchOutreachInput, now: Date): DeliveryPolicyInput {
    return {
        origin: input.origin,
        organizationId: input.organizationId,
        emailAccountId: input.emailAccountId,
        campaignId: input.campaignId,
        leadId: input.leadId,
        recipientEmail: input.to,
        now,
    }
}

function deferred(decision: Extract<DeliveryPolicyDecision, { allowed: false }>): DispatchResult {
    return { status: 'deferred', code: decision.code, retryAt: decision.retryAt }
}

export async function dispatchOutreachMessage(
    input: DispatchOutreachInput,
    dependencies: DispatchDependencies,
): Promise<DispatchResult> {
    validateDispatchInput(input)
    const now = dependencies.now ?? (() => new Date())
    const evaluatePolicy = dependencies.evaluatePolicy ?? evaluateOutreachDeliveryPolicy
    const repository = dependencies.repository ?? createDrizzleDispatchRepository()

    const beforeClaim = await evaluatePolicy(policyInput(input, now()))
    if (!beforeClaim.allowed) return deferred(beforeClaim)

    const claimNow = now()
    const claim = await repository.claim(input, {
        now: claimNow,
        leaseToken: dependencies.leaseToken?.() ?? randomUUID(),
        leaseExpiresAt: new Date(claimNow.getTime() + LEASE_DURATION_MS),
    })
    if (claim.kind !== 'claimed') return { status: claim.kind, rowId: claim.rowId }

    const beforeProvider = await evaluatePolicy(policyInput(input, now()))
    if (!beforeProvider.allowed) {
        const released = await repository.releaseClaim(claim, beforeProvider.code, now())
        if (!released) return { status: 'lost_lease', rowId: claim.rowId }
        return deferred(beforeProvider)
    }

    const reserveNow = now()
    const dispatchStarted = await repository.startDispatch(claim, reserveNow, {
        account: beforeProvider.account,
        dailyLimit: effectiveDailyLimit(beforeProvider.account),
    })
    if (!dispatchStarted) {
        const capacityDecision = await evaluatePolicy(policyInput(input, now()))
        if (!capacityDecision.allowed) {
            const released = await repository.releaseClaim(claim, capacityDecision.code, now())
            return released ? deferred(capacityDecision) : { status: 'lost_lease', rowId: claim.rowId }
        }
        return { status: 'lost_lease', rowId: claim.rowId }
    }

    const stableMessageId = createStableOutreachMessageId(input.organizationId, input.idempotencyKey)
    const providerInput: DispatchOutreachInput = { ...input, ...claim.payload }
    let providerResult: ProviderDispatchResult
    try {
        providerResult = await dependencies.provider.send({ ...providerInput, stableMessageId })
    } catch (error) {
        const normalized = normalizeProviderFailure(error)
        providerResult = { success: false, acceptance: normalized.acceptance, failure: normalized }
    }

    const finalizeNow = now()
    if (providerResult.success) {
        const normalizedMessageId = providerResult.messageId?.replace(/[<>]/g, '').trim()
        const acceptedResult = { ...providerResult, messageId: normalizedMessageId }
        const finalized = await repository.finalizeSent(claim, acceptedResult, finalizeNow)
        return finalized
            ? { status: 'sent', rowId: claim.rowId, messageId: normalizedMessageId }
            : { status: 'lost_lease', rowId: claim.rowId }
    }

    if (providerResult.acceptance === 'unknown' || providerResult.failure.classification === 'ambiguous') {
        const finalized = await repository.finalizeFailure(claim, {
            status: 'held',
            failure: providerResult.failure,
            nextAttemptAt: null,
            now: finalizeNow,
        })
        return finalized
            ? { status: 'held', rowId: claim.rowId }
            : { status: 'lost_lease', rowId: claim.rowId }
    }

    const canRetry = providerResult.failure.retryable
        && providerResult.acceptance === 'rejected'
        && dispatchStarted.attemptCount < dispatchStarted.maxAttempts
    const nextAttemptAt = canRetry
        ? calculateDispatchBackoff(dispatchStarted.attemptCount, finalizeNow)
        : null
    const finalized = await repository.finalizeFailure(claim, {
        status: 'failed',
        failure: providerResult.failure,
        nextAttemptAt,
        now: finalizeNow,
    })
    if (!finalized) return { status: 'lost_lease', rowId: claim.rowId }
    return canRetry
        ? { status: 'retry_scheduled', rowId: claim.rowId, code: providerResult.failure.code, nextAttemptAt: nextAttemptAt! }
        : { status: 'failed', rowId: claim.rowId, code: providerResult.failure.code, nextAttemptAt: undefined }
}
