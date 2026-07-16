import { describe, expect, it, vi } from 'vitest'
import type { DeliveryPolicyDecision } from '../outreach-delivery-policy'
import {
    calculateDispatchBackoff,
    createStableOutreachMessageId,
    decideExistingDispatch,
    dispatchOutreachMessage,
    type DispatchClaimResult,
    type DispatchClaimed,
    type DispatchOutreachInput,
    type DispatchRepository,
    type ProviderDispatchResult,
} from '../outreach-dispatch'

const NOW = new Date('2026-07-16T12:00:00.000Z')
const INPUT: DispatchOutreachInput = {
    origin: 'campaign',
    organizationId: '00000000-0000-4000-8000-000000000001',
    emailAccountId: '00000000-0000-4000-8000-000000000002',
    campaignId: '00000000-0000-4000-8000-000000000003',
    campaignLeadId: '00000000-0000-4000-8000-000000000004',
    sequenceStepId: '00000000-0000-4000-8000-000000000005',
    leadId: '00000000-0000-4000-8000-000000000006',
    trackingToken: 'track-token',
    idempotencyKey: 'campaign:lead-1:step-1',
    to: 'lead@example.com',
    subject: 'Hello',
    text: 'Body',
}

const ALLOWED: DeliveryPolicyDecision = {
    allowed: true,
    organization: { id: INPUT.organizationId, outreachEnabled: true },
    account: {
        id: INPUT.emailAccountId,
        organizationId: INPUT.organizationId,
        status: 'verified',
        dailySendLimit: 50,
        currentDailySent: 0,
        warmupEnabled: false,
        warmupDays: 14,
        warmupCurrentDay: 14,
        minMinutesBetweenEmails: 0,
        lastSentAt: null,
    },
}

function claimed(overrides: Partial<DispatchClaimed> = {}): DispatchClaimed {
    return {
        kind: 'claimed',
        rowId: '00000000-0000-4000-8000-000000000010',
        leaseToken: '00000000-0000-4000-8000-000000000011',
        attemptCount: 0,
        maxAttempts: 3,
        ...overrides,
    }
}

function repository(claimResult: DispatchClaimResult = claimed()): DispatchRepository & {
    claim: ReturnType<typeof vi.fn>
    startDispatch: ReturnType<typeof vi.fn>
    releaseClaim: ReturnType<typeof vi.fn>
    finalizeSent: ReturnType<typeof vi.fn>
    finalizeFailure: ReturnType<typeof vi.fn>
} {
    return {
        claim: vi.fn().mockResolvedValue(claimResult),
        startDispatch: vi.fn().mockResolvedValue({ attemptCount: 1, maxAttempts: 3 }),
        releaseClaim: vi.fn().mockResolvedValue(true),
        finalizeSent: vi.fn().mockResolvedValue(true),
        finalizeFailure: vi.fn().mockResolvedValue(true),
    }
}

function dependencies(
    repo: DispatchRepository,
    providerResult: ProviderDispatchResult = {
        success: true,
        acceptance: 'accepted',
        messageId: '<provider-id@example.com>',
    },
) {
    return {
        repository: repo,
        provider: { send: vi.fn().mockResolvedValue(providerResult) },
        evaluatePolicy: vi.fn().mockResolvedValue(ALLOWED),
        now: () => NOW,
        leaseToken: () => '00000000-0000-4000-8000-000000000011',
    }
}

describe('durable outreach dispatch eligibility', () => {
    it('reclaims an expired lease only before provider dispatch began', () => {
        expect(decideExistingDispatch({
            status: 'queued',
            attemptCount: 0,
            maxAttempts: 3,
            nextAttemptAt: null,
            leaseExpiresAt: new Date(NOW.getTime() - 1),
            dispatchStartedAt: null,
        }, NOW)).toBe('claim')
    })

    it('holds an expired lease after provider dispatch began', () => {
        expect(decideExistingDispatch({
            status: 'queued',
            attemptCount: 1,
            maxAttempts: 3,
            nextAttemptAt: null,
            leaseExpiresAt: new Date(NOW.getTime() - 1),
            dispatchStartedAt: new Date(NOW.getTime() - 60_000),
        }, NOW)).toBe('held')
    })

    it('does not reclaim an active lease or an exhausted retry', () => {
        expect(decideExistingDispatch({
            status: 'queued',
            attemptCount: 0,
            maxAttempts: 3,
            nextAttemptAt: null,
            leaseExpiresAt: new Date(NOW.getTime() + 60_000),
            dispatchStartedAt: null,
        }, NOW)).toBe('in_progress')
        expect(decideExistingDispatch({
            status: 'failed',
            attemptCount: 3,
            maxAttempts: 3,
            nextAttemptAt: new Date(NOW.getTime() - 1),
            leaseExpiresAt: null,
            dispatchStartedAt: null,
        }, NOW)).toBe('exhausted')
    })
})

describe('dispatchOutreachMessage', () => {
    it.each(['duplicate', 'in_progress', 'held', 'exhausted'] as const)(
        'does not call a provider for a %s idempotency claim',
        async (kind) => {
            const repo = repository({ kind, rowId: 'row-existing' })
            const deps = dependencies(repo)

            await expect(dispatchOutreachMessage(INPUT, deps)).resolves.toEqual({
                status: kind,
                rowId: 'row-existing',
            })
            expect(deps.provider.send).not.toHaveBeenCalled()
        },
    )

    it('checks policy again after claim and releases the lease when pause wins the race', async () => {
        const repo = repository()
        const deps = dependencies(repo)
        vi.mocked(deps.evaluatePolicy)
            .mockResolvedValueOnce(ALLOWED)
            .mockResolvedValueOnce({ allowed: false, code: 'organization_disabled' })

        await expect(dispatchOutreachMessage(INPUT, deps)).resolves.toEqual({
            status: 'deferred',
            code: 'organization_disabled',
            retryAt: undefined,
        })
        expect(repo.releaseClaim).toHaveBeenCalledWith(
            expect.objectContaining({ leaseToken: '00000000-0000-4000-8000-000000000011' }),
            'organization_disabled',
            NOW,
        )
        expect(deps.provider.send).not.toHaveBeenCalled()
    })

    it('uses one stable Message-ID and rejects a stale-token success finalize', async () => {
        const repo = repository()
        vi.mocked(repo.finalizeSent).mockResolvedValue(false)
        const deps = dependencies(repo)

        await expect(dispatchOutreachMessage(INPUT, deps)).resolves.toEqual({
            status: 'lost_lease',
            rowId: expect.any(String),
        })
        expect(deps.provider.send).toHaveBeenCalledWith(expect.objectContaining({
            stableMessageId: createStableOutreachMessageId(INPUT.organizationId, INPUT.idempotencyKey),
        }))
        expect(repo.finalizeSent).toHaveBeenCalledWith(
            expect.objectContaining({ leaseToken: '00000000-0000-4000-8000-000000000011' }),
            expect.objectContaining({ acceptance: 'accepted' }),
            NOW,
        )
    })

    it('schedules capped backoff only for a known pre-acceptance transient failure', async () => {
        const repo = repository()
        const deps = dependencies(repo, {
            success: false,
            acceptance: 'rejected',
            failure: {
                code: 'smtp_421',
                classification: 'transient',
                acceptance: 'rejected',
                retryable: true,
                message: 'temporary negative response',
            },
        })

        await expect(dispatchOutreachMessage(INPUT, deps)).resolves.toEqual({
            status: 'retry_scheduled',
            rowId: expect.any(String),
            code: 'smtp_421',
            nextAttemptAt: calculateDispatchBackoff(1, NOW),
        })
        expect(repo.finalizeFailure).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: 'failed', nextAttemptAt: calculateDispatchBackoff(1, NOW) }),
        )
    })

    it('stops retrying when the current transient attempt exhausts maxAttempts', async () => {
        const repo = repository(claimed({ attemptCount: 2, maxAttempts: 3 }))
        vi.mocked(repo.startDispatch).mockResolvedValue({ attemptCount: 3, maxAttempts: 3 })
        const deps = dependencies(repo, {
            success: false,
            acceptance: 'rejected',
            failure: {
                code: 'provider_503',
                classification: 'transient',
                acceptance: 'rejected',
                retryable: true,
                message: 'known negative response',
            },
        })

        await expect(dispatchOutreachMessage(INPUT, deps)).resolves.toEqual({
            status: 'failed',
            rowId: expect.any(String),
            code: 'provider_503',
            nextAttemptAt: undefined,
        })
        expect(repo.finalizeFailure).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: 'failed', nextAttemptAt: null }),
        )
    })

    it('holds an ambiguous provider outcome and never schedules it again', async () => {
        const repo = repository()
        const deps = dependencies(repo, {
            success: false,
            acceptance: 'unknown',
            failure: {
                code: 'provider_outcome_unknown',
                classification: 'ambiguous',
                acceptance: 'unknown',
                retryable: false,
                message: 'connection closed after DATA',
            },
        })

        await expect(dispatchOutreachMessage(INPUT, deps)).resolves.toEqual({
            status: 'held',
            rowId: expect.any(String),
        })
        expect(repo.finalizeFailure).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: 'held', nextAttemptAt: null }),
        )
    })
})
