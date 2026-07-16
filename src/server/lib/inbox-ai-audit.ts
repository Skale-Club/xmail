// ============================================================
// Redacted AI-run lifecycle audit service (Phase 23 AI-05)
// ============================================================
// The append-only audit trail for every AI draft/decision. It stores stable REFERENCES —
// input message ids + a deterministic context hash, prompt version, provider/model, allowlisted
// parameters, the sanitized draft, the delivery-policy result, actor/approval, and the durable
// send-command / outreach-email links — so any future model call or action can be reconstructed
// under authorization WITHOUT ever persisting API keys, Authorization headers, or the system
// prompt / hidden reasoning (locked decision #5).
//
// The lifecycle is state-machine driven with leases, bounded attempts, stable idempotency, and
// explicit allowed transitions (locked decision #4: no hidden retry loop). Every function carries
// the verified organizationId; the store's org-scoped queries are the tenant boundary (the app
// role bypasses RLS). The store is injected so the lifecycle logic is testable without a database;
// createDrizzleAiRunStore() is the production implementation.

import { randomUUID } from 'node:crypto'
import type {
    OutreachAiRun,
    OutreachAiRunAction,
    OutreachAiRunKind,
    OutreachAiRunStatus,
} from '../../db/schema'

export type AiRunKind = OutreachAiRunKind
export type AiRunStatus = OutreachAiRunStatus
export type AiRunAction = OutreachAiRunAction

/** Max characters of error detail retained on a run (a provider dump is truncated, never stored raw). */
export const AI_RUN_MAX_ERROR_DETAIL = 1000
export const AI_RUN_MAX_ERROR_CODE = 200
export const REDACTED_PLACEHOLDER = '[redacted]'
const DEFAULT_LEASE_MS = 60_000
const DEFAULT_MAX_ATTEMPTS = 5

/** A stored AI-run row (the allowlisted audit record). Mirrors outreach_ai_runs. */
export type AiRunRecord = OutreachAiRun

/** Fail-closed lifecycle error. `.code` is a stable machine code. */
export class AiRunError extends Error {
    code: string
    constructor(code: string, message?: string) {
        super(message ? `${code}: ${message}` : code)
        this.name = 'AiRunError'
        this.code = code
    }
}

/**
 * Persistence boundary for AI runs. Every method is organization-scoped: a runId under the wrong
 * organization resolves to null, which the lifecycle functions surface as `not_found`. The optional
 * `expectedLeaseToken` on update makes a lease-guarded transition atomic (the DB adds it to WHERE).
 */
export interface AiRunStore {
    findByIdempotencyKey(organizationId: string, idempotencyKey: string): Promise<AiRunRecord | null>
    insert(row: AiRunRecord): Promise<AiRunRecord>
    findById(organizationId: string, runId: string): Promise<AiRunRecord | null>
    update(
        organizationId: string,
        runId: string,
        patch: Partial<AiRunRecord>,
        opts?: { expectedLeaseToken?: string | null },
    ): Promise<AiRunRecord | null>
}

// ------------------------------------------------------------
// Redaction
// ------------------------------------------------------------
// A key is a secret indicator if it names authorization/secret/password/credential/bearer, an
// api/access/private key, or a standalone `token` (NOT a `tokens` usage counter like maxTokens).
const SECRET_KEY_RE =
    /(authorization|secret|password|passwd|credential|bearer|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|(^|[^a-z])token($|[^a-z]))/

function isSecretKey(key: string): boolean {
    return SECRET_KEY_RE.test(key.toLowerCase())
}

/**
 * Recursively redact secret-bearing keys in a parameter object. Values under a secret key become
 * REDACTED_PLACEHOLDER; every other value is preserved. Never mutates the input.
 */
export function sanitizeModelParameters(params: Record<string, unknown> | null | undefined): Record<string, unknown> {
    if (!params || typeof params !== 'object') return {}
    return redactObject(params, 0) as Record<string, unknown>
}

function redactObject(value: unknown, depth: number): unknown {
    if (depth > 8) return REDACTED_PLACEHOLDER // bound recursion on pathological input
    if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1))
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
            out[key] = isSecretKey(key) ? REDACTED_PLACEHOLDER : redactObject(v, depth + 1)
        }
        return out
    }
    return value
}

function boundText(value: string | null | undefined, max: number): string | null {
    if (value == null) return null
    return value.length > max ? value.slice(0, max) : value
}

// ------------------------------------------------------------
// Allowed transitions (locked decision #4: no hidden retry loop)
// ------------------------------------------------------------
const ALLOWED_TRANSITIONS: Record<AiRunStatus, AiRunStatus[]> = {
    pending: ['running', 'deferred', 'cancelled', 'failed'],
    running: ['awaiting_approval', 'completed', 'failed', 'deferred', 'cancelled'],
    awaiting_approval: ['completed', 'failed', 'cancelled'],
    deferred: ['pending', 'running', 'cancelled', 'failed'],
    completed: [],
    failed: [],
    cancelled: [],
}

const TERMINAL_STATUSES: ReadonlySet<AiRunStatus> = new Set(['completed', 'failed', 'cancelled'])

function assertTransition(from: AiRunStatus, to: AiRunStatus): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
        throw new AiRunError('invalid_transition', `Cannot move an AI run from ${from} to ${to}`)
    }
}

async function requireRun(store: AiRunStore, organizationId: string, runId: string): Promise<AiRunRecord> {
    const run = await store.findById(organizationId, runId)
    if (!run) throw new AiRunError('not_found', 'AI run not found for this organization')
    return run
}

// ------------------------------------------------------------
// Creation (idempotent)
// ------------------------------------------------------------
export interface CreateAiRunInput {
    organizationId: string
    runKind: AiRunKind
    idempotencyKey: string
    conversationId?: string | null
    campaignId?: string | null
    campaignLeadId?: string | null
    triggerMessageId?: string | null
    inputMessageIds?: string[]
    contextHash?: string | null
    promptVersion?: string | null
    provider?: string | null
    model?: string | null
    modelParameters?: Record<string, unknown>
    actorUserId?: string | null
    maxAttempts?: number
    now?: Date
}

/**
 * Create a pending AI run, idempotent on (organization, idempotency_key). A second create with the
 * same key returns the existing run with created:false — never a duplicate audit row. Only the
 * ALLOWLISTED fields are stored; model parameters are redacted; no raw request blob is accepted.
 */
export async function createAiRun(
    store: AiRunStore,
    input: CreateAiRunInput,
): Promise<{ run: AiRunRecord; created: boolean }> {
    if (!input.idempotencyKey || input.idempotencyKey.trim().length === 0) {
        throw new AiRunError('idempotency_key_required', 'An AI run requires a stable idempotency key')
    }

    const existing = await store.findByIdempotencyKey(input.organizationId, input.idempotencyKey)
    if (existing) return { run: existing, created: false }

    const now = input.now ?? new Date()
    const record: AiRunRecord = {
        id: randomUUID(),
        organizationId: input.organizationId,
        conversationId: input.conversationId ?? null,
        campaignId: input.campaignId ?? null,
        campaignLeadId: input.campaignLeadId ?? null,
        triggerMessageId: input.triggerMessageId ?? null,
        inputMessageIds: input.inputMessageIds ?? [],
        contextHash: input.contextHash ?? null,
        runKind: input.runKind,
        status: 'pending',
        action: null,
        promptVersion: input.promptVersion ?? null,
        provider: input.provider ?? null,
        model: input.model ?? null,
        modelParameters: sanitizeModelParameters(input.modelParameters),
        outputSubject: null,
        outputBody: null,
        outputOutcome: null,
        policyCode: null,
        policyRetryAt: null,
        actorUserId: input.actorUserId ?? null,
        approvedByUserId: null,
        approvedAt: null,
        sendCommandId: null,
        outreachEmailId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        idempotencyKey: input.idempotencyKey,
        latencyMs: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        errorCode: null,
        errorDetail: null,
        createdAt: now,
        updatedAt: now,
    }

    try {
        const inserted = await store.insert(record)
        return { run: inserted, created: true }
    } catch (error) {
        // Lost a create race on the unique (organization, idempotency_key) index: reuse the winner.
        const raced = await store.findByIdempotencyKey(input.organizationId, input.idempotencyKey)
        if (raced) return { run: raced, created: false }
        throw error
    }
}

// ------------------------------------------------------------
// Claim (with lease recovery + bounded attempts)
// ------------------------------------------------------------
export interface ClaimAiRunInput {
    organizationId: string
    runId: string
    leaseMs?: number
    now?: Date
}

/**
 * Claim a pending/deferred run (or reclaim a running run whose lease expired) into 'running' with a
 * fresh lease and one more attempt. Refuses a live lease (`lease_held`), a terminal run
 * (`invalid_transition`), and fails the run closed when attempts would exceed the bound
 * (`exhausted`).
 */
export async function claimAiRun(store: AiRunStore, input: ClaimAiRunInput): Promise<AiRunRecord> {
    const now = input.now ?? new Date()
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
    const run = await requireRun(store, input.organizationId, input.runId)

    if (TERMINAL_STATUSES.has(run.status)) {
        throw new AiRunError('invalid_transition', `Cannot claim a ${run.status} AI run`)
    }
    if (run.status === 'running') {
        if (run.leaseExpiresAt && run.leaseExpiresAt.getTime() > now.getTime()) {
            throw new AiRunError('lease_held', 'AI run is already claimed with a live lease')
        }
        // else: expired lease → recover.
    } else if (run.status !== 'pending' && run.status !== 'deferred') {
        // e.g. awaiting_approval is not claimable by the worker.
        throw new AiRunError('invalid_transition', `Cannot claim a ${run.status} AI run`)
    }

    const nextAttempts = run.attempts + 1
    if (nextAttempts > run.maxAttempts) {
        await store.update(input.organizationId, input.runId, {
            status: 'failed',
            errorCode: 'attempts_exhausted',
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
        })
        throw new AiRunError('exhausted', 'AI run has exhausted its attempt budget')
    }

    const leaseToken = randomUUID()
    const updated = await store.update(input.organizationId, input.runId, {
        status: 'running',
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        attempts: nextAttempts,
        updatedAt: now,
    })
    if (!updated) throw new AiRunError('not_found', 'AI run vanished during claim')
    return updated
}

// ------------------------------------------------------------
// Lease-guarded terminal / deferral transitions
// ------------------------------------------------------------
function assertLease(run: AiRunRecord, leaseToken: string | null | undefined): void {
    const expected = leaseToken ?? null
    if ((run.leaseToken ?? null) !== expected) {
        throw new AiRunError('lease_mismatch', 'AI run lease token does not match')
    }
}

export interface CompleteAiRunInput {
    organizationId: string
    runId: string
    leaseToken: string | null
    action: AiRunAction
    outputSubject?: string | null
    outputBody?: string | null
    outputOutcome?: string | null
    policyCode?: string | null
    latencyMs?: number | null
    promptTokens?: number | null
    completionTokens?: number | null
    totalTokens?: number | null
    /** When true the run parks in 'awaiting_approval' for a human instead of 'completed'. */
    awaitingApproval?: boolean
    now?: Date
}

/**
 * Finalize a claimed run. With awaitingApproval it parks in 'awaiting_approval' (draft ready for a
 * human); otherwise it moves to 'completed'. The lease is verified and then cleared. Stores the
 * sanitized draft/action, the policy code, and any usage metadata.
 */
export async function completeAiRun(store: AiRunStore, input: CompleteAiRunInput): Promise<AiRunRecord> {
    const now = input.now ?? new Date()
    const run = await requireRun(store, input.organizationId, input.runId)
    assertLease(run, input.leaseToken)
    const target: AiRunStatus = input.awaitingApproval ? 'awaiting_approval' : 'completed'
    assertTransition(run.status, target)

    const updated = await store.update(
        input.organizationId,
        input.runId,
        {
            status: target,
            action: input.action,
            outputSubject: input.outputSubject ?? null,
            outputBody: input.outputBody ?? null,
            outputOutcome: input.outputOutcome ?? null,
            policyCode: input.policyCode ?? run.policyCode ?? null,
            latencyMs: input.latencyMs ?? run.latencyMs ?? null,
            promptTokens: input.promptTokens ?? run.promptTokens ?? null,
            completionTokens: input.completionTokens ?? run.completionTokens ?? null,
            totalTokens: input.totalTokens ?? run.totalTokens ?? null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
        },
        { expectedLeaseToken: input.leaseToken },
    )
    if (!updated) throw new AiRunError('lease_mismatch', 'AI run lease token does not match')
    return updated
}

export interface FailAiRunInput {
    organizationId: string
    runId: string
    leaseToken: string | null
    errorCode: string
    errorDetail?: string | null
    policyCode?: string | null
    now?: Date
}

/** Move a claimed run to 'failed' with a bounded error code/detail. Lease verified and cleared. */
export async function failAiRun(store: AiRunStore, input: FailAiRunInput): Promise<AiRunRecord> {
    const now = input.now ?? new Date()
    const run = await requireRun(store, input.organizationId, input.runId)
    assertLease(run, input.leaseToken)
    assertTransition(run.status, 'failed')

    const updated = await store.update(
        input.organizationId,
        input.runId,
        {
            status: 'failed',
            errorCode: boundText(input.errorCode, AI_RUN_MAX_ERROR_CODE),
            errorDetail: boundText(input.errorDetail, AI_RUN_MAX_ERROR_DETAIL),
            policyCode: input.policyCode ?? run.policyCode ?? null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
        },
        { expectedLeaseToken: input.leaseToken },
    )
    if (!updated) throw new AiRunError('lease_mismatch', 'AI run lease token does not match')
    return updated
}

export interface DeferAiRunInput {
    organizationId: string
    runId: string
    leaseToken: string | null
    policyCode?: string | null
    policyRetryAt?: Date | null
    now?: Date
}

/** Move a claimed run to 'deferred' with a policy code + retry time. Re-armable via claimAiRun. */
export async function deferAiRun(store: AiRunStore, input: DeferAiRunInput): Promise<AiRunRecord> {
    const now = input.now ?? new Date()
    const run = await requireRun(store, input.organizationId, input.runId)
    assertLease(run, input.leaseToken)
    assertTransition(run.status, 'deferred')

    const updated = await store.update(
        input.organizationId,
        input.runId,
        {
            status: 'deferred',
            policyCode: input.policyCode ?? null,
            policyRetryAt: input.policyRetryAt ?? null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
        },
        { expectedLeaseToken: input.leaseToken },
    )
    if (!updated) throw new AiRunError('lease_mismatch', 'AI run lease token does not match')
    return updated
}

// ------------------------------------------------------------
// Approval + command linkage
// ------------------------------------------------------------
export interface ApproveAiRunInput {
    organizationId: string
    runId: string
    approverUserId: string
    now?: Date
}

/**
 * Record human approval of a run that is awaiting approval, as an atomic (approver, time) pair.
 * Only valid from 'awaiting_approval' and only with a real approver id.
 */
export async function approveAiRun(store: AiRunStore, input: ApproveAiRunInput): Promise<AiRunRecord> {
    const now = input.now ?? new Date()
    const run = await requireRun(store, input.organizationId, input.runId)
    if (!input.approverUserId || input.approverUserId.trim().length === 0) {
        throw new AiRunError('approver_required', 'Approval requires an approver user id')
    }
    if (run.status !== 'awaiting_approval') {
        throw new AiRunError('invalid_transition', `Cannot approve a run in status ${run.status}`)
    }
    const updated = await store.update(input.organizationId, input.runId, {
        approvedByUserId: input.approverUserId,
        approvedAt: now,
        updatedAt: now,
    })
    if (!updated) throw new AiRunError('not_found', 'AI run not found for this organization')
    return updated
}

export interface LinkAiRunCommandInput {
    organizationId: string
    runId: string
    sendCommandId: string
    outreachEmailId?: string | null
    now?: Date
}

/** Attach the durable send-command (and optional resulting outreach-email) links to the run. */
export async function linkAiRunCommand(store: AiRunStore, input: LinkAiRunCommandInput): Promise<AiRunRecord> {
    const now = input.now ?? new Date()
    const run = await requireRun(store, input.organizationId, input.runId)
    const updated = await store.update(input.organizationId, input.runId, {
        sendCommandId: input.sendCommandId,
        outreachEmailId: input.outreachEmailId ?? run.outreachEmailId ?? null,
        updatedAt: now,
    })
    if (!updated) throw new AiRunError('not_found', 'AI run not found for this organization')
    return updated
}

// ------------------------------------------------------------
// Production Drizzle-backed store
// ------------------------------------------------------------
/**
 * The production AI-run store. Every query is organization-scoped (the app role bypasses RLS, so
 * this JS predicate is the tenant boundary). Lazily imports the DB layer so this module stays
 * importable without DATABASE_URL in unit tests. Later plans' .db suites exercise it end to end.
 */
export function createDrizzleAiRunStore(): AiRunStore {
    return {
        async findByIdempotencyKey(organizationId, idempotencyKey) {
            const { db } = await import('../../db')
            const { and, eq } = await import('drizzle-orm')
            const { outreachAiRuns } = await import('../../db/schema')
            const rows = await db
                .select()
                .from(outreachAiRuns)
                .where(and(eq(outreachAiRuns.organizationId, organizationId), eq(outreachAiRuns.idempotencyKey, idempotencyKey)))
                .limit(1)
            return rows[0] ?? null
        },
        async insert(row) {
            const { db } = await import('../../db')
            const { outreachAiRuns } = await import('../../db/schema')
            const inserted = await db.insert(outreachAiRuns).values(row).returning()
            return inserted[0]
        },
        async findById(organizationId, runId) {
            const { db } = await import('../../db')
            const { and, eq } = await import('drizzle-orm')
            const { outreachAiRuns } = await import('../../db/schema')
            const rows = await db
                .select()
                .from(outreachAiRuns)
                .where(and(eq(outreachAiRuns.organizationId, organizationId), eq(outreachAiRuns.id, runId)))
                .limit(1)
            return rows[0] ?? null
        },
        async update(organizationId, runId, patch, opts) {
            const { db } = await import('../../db')
            const { and, eq, isNull } = await import('drizzle-orm')
            const { outreachAiRuns } = await import('../../db/schema')
            const conditions = [eq(outreachAiRuns.organizationId, organizationId), eq(outreachAiRuns.id, runId)]
            if (opts && 'expectedLeaseToken' in opts) {
                conditions.push(
                    opts.expectedLeaseToken == null
                        ? isNull(outreachAiRuns.leaseToken)
                        : eq(outreachAiRuns.leaseToken, opts.expectedLeaseToken),
                )
            }
            const rows = await db
                .update(outreachAiRuns)
                .set({ ...patch, updatedAt: patch.updatedAt ?? new Date() })
                .where(and(...conditions))
                .returning()
            return rows[0] ?? null
        },
    }
}
