import { describe, expect, it, vi } from 'vitest'
import type { DeliveryPolicyDecision } from '../outreach-delivery-policy'
import {
    calculateDispatchBackoff,
    createSqlDispatchRepository,
    createStableOutreachMessageId,
    decideExistingDispatch,
    dispatchOutreachMessage,
    normalizeProviderFailure,
    type DispatchClaimResult,
    type DispatchClaimed,
    type DispatchOutreachInput,
    type DispatchRepository,
    type DispatchSqlClient,
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
        email: 'seller@skale.club',
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
        payload: {
            to: INPUT.to,
            subject: INPUT.subject,
            text: INPUT.text ?? null,
            html: INPUT.html ?? null,
            trackingToken: INPUT.trackingToken,
            inReplyTo: INPUT.inReplyTo,
            references: INPUT.references,
            abVariant: INPUT.abVariant,
        },
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

describe('provider failure normalization', () => {
    it('retries explicit HTTP and pre-connection negative outcomes', () => {
        expect(normalizeProviderFailure(Object.assign(new Error('unavailable'), { statusCode: 503 })))
            .toMatchObject({ classification: 'transient', acceptance: 'rejected', retryable: true })
        expect(normalizeProviderFailure(Object.assign(new Error('dns failed'), { code: 'EDNS', command: 'CONN' })))
            .toMatchObject({ classification: 'transient', acceptance: 'rejected', retryable: true })
        expect(normalizeProviderFailure(Object.assign(new Error('rate limited'), { responseCode: 421 })))
            .toMatchObject({ classification: 'transient', acceptance: 'rejected', retryable: true })
    })

    it('treats SMTP 5xx as terminal and a post-DATA timeout as ambiguous', () => {
        expect(normalizeProviderFailure(Object.assign(new Error('mailbox unavailable'), { responseCode: 550 })))
            .toMatchObject({ classification: 'terminal', acceptance: 'rejected', retryable: false })
        expect(normalizeProviderFailure(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', command: 'DATA' })))
            .toMatchObject({ classification: 'ambiguous', acceptance: 'unknown', retryable: false })
        expect(normalizeProviderFailure(Object.assign(new Error('invalid content'), { statusCode: 422 })))
            .toMatchObject({ classification: 'terminal', acceptance: 'rejected', retryable: false })
        expect(normalizeProviderFailure(Object.assign(new Error('phase unknown'), { code: 'ETIMEDOUT' })))
            .toMatchObject({ classification: 'ambiguous', acceptance: 'unknown', retryable: false })
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

    // W-4. `.local` is reserved for mDNS (RFC 6762): it never resolves publicly and it does
    // not match From, and receiver-side filters score both Message-ID domain validity and
    // From-domain correspondence on unsolicited bulk mail. The digest is derived from
    // (organizationId, idempotencyKey) and the LOCAL PART carries identity, so the domain
    // can move to the sender's real one without touching Phase 18 idempotency.
    it('mints a Message-ID on the sender domain rather than the mDNS-reserved .local', () => {
        const id = createStableOutreachMessageId(INPUT.organizationId, INPUT.idempotencyKey, 'seller@skale.club')

        expect(id).toMatch(/^<xmail-[0-9a-f]{40}@skale\.club>$/)
        expect(id).not.toContain('.local')
    })

    it('keeps the local part stable across senders, so Phase 18 idempotency is untouched', () => {
        const local = (id: string) => id.slice(1, id.indexOf('@'))

        // Same (organizationId, idempotencyKey) => same identity, whatever the domain. This
        // is what makes a retry reuse one Message-ID rather than mint a second.
        expect(local(createStableOutreachMessageId(INPUT.organizationId, INPUT.idempotencyKey, 'a@one.test')))
            .toBe(local(createStableOutreachMessageId(INPUT.organizationId, INPUT.idempotencyKey, 'b@two.test')))

        expect(local(createStableOutreachMessageId(INPUT.organizationId, 'other-key', 'a@one.test')))
            .not.toBe(local(createStableOutreachMessageId(INPUT.organizationId, INPUT.idempotencyKey, 'a@one.test')))
    })

    it('lowercases the sender domain so the stored id matches the LOWER() matcher', () => {
        // The dispatcher stores the id unbracketed and processReplies compares with LOWER();
        // minting a mixed-case domain would still match, but normalizing here keeps the
        // stored value and the composed header byte-identical.
        expect(createStableOutreachMessageId(INPUT.organizationId, INPUT.idempotencyKey, 'Seller@Skale.Club'))
            .toBe(createStableOutreachMessageId(INPUT.organizationId, INPUT.idempotencyKey, 'seller@skale.club'))
    })

    it('refuses to mint an id for a sender with no usable domain', () => {
        // Better a dispatch failure than a message shipped with an unroutable Message-ID.
        expect(() => createStableOutreachMessageId(INPUT.organizationId, INPUT.idempotencyKey, 'not-an-address'))
            .toThrow(/domain/i)
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
            stableMessageId: createStableOutreachMessageId(INPUT.organizationId, INPUT.idempotencyKey, 'seller@skale.club'),
        }))
        expect(repo.finalizeSent).toHaveBeenCalledWith(
            expect.objectContaining({ leaseToken: '00000000-0000-4000-8000-000000000011' }),
            expect.objectContaining({ acceptance: 'accepted' }),
            NOW,
        )
    })

    it('sends the payload frozen by the first durable claim on a retry', async () => {
        const repo = repository(claimed({
            payload: {
                to: INPUT.to,
                subject: 'Original subject',
                text: 'Original body',
                html: '<p>Original body</p>',
                trackingToken: 'persisted-token',
                abVariant: 'b',
            },
        }))
        const deps = dependencies(repo)

        await dispatchOutreachMessage({
            ...INPUT,
            subject: 'Edited subject',
            text: 'Edited body',
            trackingToken: 'new-token',
        }, deps)

        expect(deps.provider.send).toHaveBeenCalledWith(expect.objectContaining({
            subject: 'Original subject',
            text: 'Original body',
            trackingToken: 'persisted-token',
            abVariant: 'b',
        }))
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

    it('materializes the outbound send once, after the durable finalize (UIF-05)', async () => {
        const repo = repository()
        const materializeOutbound = vi.fn().mockResolvedValue(undefined)
        const deps = { ...dependencies(repo), materializeOutbound }

        await expect(dispatchOutreachMessage(INPUT, deps)).resolves.toEqual({
            status: 'sent',
            rowId: claimed().rowId,
            messageId: 'provider-id@example.com',
        })
        expect(materializeOutbound).toHaveBeenCalledTimes(1)
        expect(materializeOutbound).toHaveBeenCalledWith(claimed().rowId)
    })

    it('is best-effort: an outbound materialization failure never fails or resends the send', async () => {
        const repo = repository()
        const materializeOutbound = vi.fn().mockRejectedValue(new Error('unified inbox unavailable'))
        const deps = { ...dependencies(repo), materializeOutbound }

        // The send still reports sent — the mail is already durable — and the provider is not
        // called a second time (no resend).
        await expect(dispatchOutreachMessage(INPUT, deps)).resolves.toEqual({
            status: 'sent',
            rowId: claimed().rowId,
            messageId: 'provider-id@example.com',
        })
        expect(deps.provider.send).toHaveBeenCalledTimes(1)
        expect(materializeOutbound).toHaveBeenCalledTimes(1)
    })

    it('does not materialize an outbound message when the finalize lost the lease', async () => {
        const repo = repository()
        vi.mocked(repo.finalizeSent).mockResolvedValue(false)
        const materializeOutbound = vi.fn().mockResolvedValue(undefined)
        const deps = { ...dependencies(repo), materializeOutbound }

        await expect(dispatchOutreachMessage(INPUT, deps)).resolves.toEqual({
            status: 'lost_lease',
            rowId: claimed().rowId,
        })
        expect(materializeOutbound).not.toHaveBeenCalled()
    })
})

describe('SQL dispatch timestamp parameters', () => {
    it('never hands Date objects directly to postgres-js', async () => {
        const boundValues: unknown[][] = []
        const sqlClient: DispatchSqlClient = async (_strings, ...values) => {
            boundValues.push(values)
            return [{
                id: claimed().rowId,
                leaseToken: claimed().leaseToken,
                attemptCount: 1,
                maxAttempts: 3,
                toAddress: INPUT.to,
                subject: INPUT.subject,
                plainBody: INPUT.text,
                htmlBody: null,
                trackingToken: INPUT.trackingToken,
            }]
        }
        const repo = createSqlDispatchRepository(async () => sqlClient)
        const dispatchClaim = claimed()

        await repo.claim(INPUT, {
            now: NOW,
            leaseToken: dispatchClaim.leaseToken,
            leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        })
        await repo.startDispatch(dispatchClaim, NOW, { account: ALLOWED.account, dailyLimit: 50 })
        await repo.releaseClaim(dispatchClaim, 'account_spacing', NOW)
        await repo.finalizeSent(dispatchClaim, {
            success: true,
            acceptance: 'accepted',
            messageId: '<provider-id@example.com>',
        }, NOW)
        await repo.finalizeFailure(dispatchClaim, {
            status: 'failed',
            failure: {
                code: 'provider_503',
                classification: 'transient',
                acceptance: 'rejected',
                retryable: true,
                message: 'temporary failure',
            },
            nextAttemptAt: new Date(NOW.getTime() + 60_000),
            now: NOW,
        })

        expect(boundValues.flat().some((value) => value instanceof Date)).toBe(false)
        expect(boundValues.flat()).toContain(NOW.toISOString())
    })
})
