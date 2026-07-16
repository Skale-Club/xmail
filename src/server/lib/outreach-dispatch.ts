import type {
    DeliveryPolicyCode,
    DeliveryPolicyDecision,
    DeliveryPolicyInput,
    OutreachOrigin,
} from './outreach-delivery-policy'

export type ProviderAcceptance = 'accepted' | 'rejected' | 'unknown'
export type ProviderFailureClass = 'transient' | 'terminal' | 'ambiguous'

export interface ProviderFailure {
    code: string
    classification: ProviderFailureClass
    acceptance: Exclude<ProviderAcceptance, 'accepted'>
    retryable: boolean
    message: string
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
    maxAttempts?: number
}

export interface DispatchClaimed {
    kind: 'claimed'
    rowId: string
    leaseToken: string
    attemptCount: number
    maxAttempts: number
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
    startDispatch(claim: DispatchClaimed, now: Date): Promise<{ attemptCount: number; maxAttempts: number } | null>
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

export function decideExistingDispatch(_state: ExistingDispatchState, _now: Date): ExistingDispatchDecision {
    return 'duplicate'
}

export function calculateDispatchBackoff(_attemptCount: number, _now: Date): Date {
    throw new Error('Not implemented')
}

export function createStableOutreachMessageId(_organizationId: string, _idempotencyKey: string): string {
    throw new Error('Not implemented')
}

export async function dispatchOutreachMessage(
    _input: DispatchOutreachInput,
    _dependencies: DispatchDependencies,
): Promise<DispatchResult> {
    throw new Error('Not implemented')
}
