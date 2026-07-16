import { describe, expect, it, vi } from 'vitest'
import {
    executeInboxSendCommand,
    resolveSendCommand,
    createResolvedSendCommand,
    InboxCommandResolutionError,
    type ClaimedInboxCommand,
    type CreateResolvedSendCommandDeps,
    type PersistedThreadMessage,
    type ResolveSendCommandInput,
} from './inbox-command-dispatch'
import type { DispatchOutreachInput, DispatchResult } from './outreach-dispatch'

// ============================================================
// Fixtures
// ============================================================

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'
const CONV_1 = '33333333-3333-4333-8333-333333333333'
const ACCOUNT_1 = '55555555-5555-4555-8555-555555555555'
const MSG_INBOUND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MSG_OUTBOUND = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const SELF = 'rep@skale.club'

function inbound(overrides: Partial<PersistedThreadMessage> = {}): PersistedThreadMessage {
    return {
        id: MSG_INBOUND,
        direction: 'inbound',
        internetMessageId: '<lead-msg-1@acme.example>',
        inReplyTo: '<our-outbound-1@skale.club>',
        messageReferences: '<our-outbound-1@skale.club>',
        subject: 'Re: Demo request',
        fromAddress: 'lead@acme.example',
        fromName: 'Lead Person',
        toAddresses: [{ address: SELF, name: 'Rep' }],
        ccAddresses: [{ address: 'colleague@acme.example', name: 'Colleague' }],
        replyToAddresses: [],
        sortIndex: 2,
        ...overrides,
    }
}

function outbound(overrides: Partial<PersistedThreadMessage> = {}): PersistedThreadMessage {
    return {
        id: MSG_OUTBOUND,
        direction: 'outbound',
        internetMessageId: '<our-outbound-1@skale.club>',
        inReplyTo: null,
        messageReferences: null,
        subject: 'Demo request',
        fromAddress: SELF,
        fromName: 'Rep',
        toAddresses: [{ address: 'lead@acme.example', name: 'Lead Person' }],
        ccAddresses: [],
        replyToAddresses: [],
        sortIndex: 1,
        ...overrides,
    }
}

// ============================================================
// Pure resolver — recipients + threading headers come from persisted
// messages, never from the client.
// ============================================================

describe('resolveSendCommand: reply', () => {
    it('resolves the recipient from the source inbound From and excludes the sending account', () => {
        const input: ResolveSendCommandInput = {
            mode: 'reply',
            accountAddress: SELF,
            messages: [outbound(), inbound()],
        }
        const resolved = resolveSendCommand(input)
        expect(resolved.to.map((r) => r.address)).toEqual(['lead@acme.example'])
        expect(resolved.cc).toEqual([])
        // Threading headers come from the persisted source message.
        expect(resolved.inReplyTo).toBe('<lead-msg-1@acme.example>')
        expect(resolved.references).toContain('<lead-msg-1@acme.example>')
        expect(resolved.references).toContain('<our-outbound-1@skale.club>')
        expect(resolved.subject).toBe('Re: Demo request')
        expect(resolved.sourceMessageId).toBe(MSG_INBOUND)
    })

    it('prefers Reply-To over From when the source declares one', () => {
        const resolved = resolveSendCommand({
            mode: 'reply',
            accountAddress: SELF,
            messages: [inbound({ replyToAddresses: [{ address: 'sales@acme.example', name: null }] })],
        })
        expect(resolved.to.map((r) => r.address)).toEqual(['sales@acme.example'])
    })

    it('does not double-prefix an already-Re: subject', () => {
        const resolved = resolveSendCommand({
            mode: 'reply',
            accountAddress: SELF,
            messages: [inbound({ subject: 'RE: RE: Demo request' })],
        })
        expect(resolved.subject).toBe('Re: Demo request')
    })
})

describe('resolveSendCommand: reply_all', () => {
    it('copies the original To and Cc (minus the sending account), deduplicated case-insensitively', () => {
        const resolved = resolveSendCommand({
            mode: 'reply_all',
            accountAddress: SELF,
            messages: [inbound({
                toAddresses: [
                    { address: SELF, name: 'Rep' },
                    { address: 'Manager@ACME.example', name: 'Manager' },
                ],
                ccAddresses: [
                    { address: 'colleague@acme.example', name: 'Colleague' },
                    { address: 'MANAGER@acme.example', name: 'Manager dup' },
                ],
            })],
        })
        // Primary recipient is the source From.
        expect(resolved.to.map((r) => r.address)).toEqual(['lead@acme.example'])
        // Cc is the union of original To+Cc minus self and minus the primary To, deduped.
        const cc = resolved.cc.map((r) => r.address).sort()
        expect(cc).toEqual(['colleague@acme.example', 'manager@acme.example'])
        expect(cc).not.toContain(SELF)
    })
})

describe('resolveSendCommand: forward', () => {
    it('requires explicit recipients and does not thread by default', () => {
        const resolved = resolveSendCommand({
            mode: 'forward',
            accountAddress: SELF,
            messages: [inbound()],
            forwardRecipients: [{ address: 'newcontact@partner.example', name: null }],
        })
        expect(resolved.to.map((r) => r.address)).toEqual(['newcontact@partner.example'])
        expect(resolved.inReplyTo).toBeNull()
        expect(resolved.references).toBeNull()
        expect(resolved.subject).toBe('Fwd: Demo request')
    })

    it('throws when forward has no recipients', () => {
        expect(() => resolveSendCommand({
            mode: 'forward',
            accountAddress: SELF,
            messages: [inbound()],
            forwardRecipients: [],
        })).toThrow(InboxCommandResolutionError)
    })
})

describe('resolveSendCommand: safety', () => {
    it('throws when the thread has no source message to reply to', () => {
        expect(() => resolveSendCommand({ mode: 'reply', accountAddress: SELF, messages: [] }))
            .toThrow(InboxCommandResolutionError)
    })

    it('throws when the only reply recipient would be the sending account itself', () => {
        expect(() => resolveSendCommand({
            mode: 'reply',
            accountAddress: SELF,
            messages: [inbound({ fromAddress: SELF, replyToAddresses: [], toAddresses: [{ address: SELF, name: null }] })],
        })).toThrow(InboxCommandResolutionError)
    })

    it('ignores a client-supplied source id that is not in the persisted thread (cross-tenant/spoof)', () => {
        expect(() => resolveSendCommand({
            mode: 'reply',
            accountAddress: SELF,
            messages: [inbound()],
            sourceMessageId: 'deadbeef-dead-4ead-8ead-deaddeaddead',
        })).toThrow(InboxCommandResolutionError)
    })
})

// ============================================================
// Orchestrator — the route hands off a durable command; recipients and
// headers are ALWAYS resolved server-side from persisted messages. A client
// cannot inject recipients/headers, and the orchestrator NEVER dispatches.
// ============================================================

function orchestratorDeps(overrides: Partial<CreateResolvedSendCommandDeps> = {}): {
    deps: CreateResolvedSendCommandDeps
    persistCommand: ReturnType<typeof vi.fn>
} {
    const persistCommand = vi.fn(async (args: Parameters<CreateResolvedSendCommandDeps['persistCommand']>[0]) => ({
        command: {
            id: 'cmd-1',
            conversationId: args.conversationId,
            status: 'scheduled',
            mode: args.mode,
            scheduledAt: args.scheduledAt ?? null,
            dueAt: args.scheduledAt ?? new Date(),
            attempts: 0,
            idempotencyKey: 'idem',
            createdAt: new Date(),
            updatedAt: new Date(),
        },
        created: true,
    }))
    const deps: CreateResolvedSendCommandDeps = {
        loadConversation: vi.fn(async () => ({ leadId: null })),
        loadAccountAddress: vi.fn(async () => SELF),
        loadThreadMessages: vi.fn(async () => [outbound(), inbound()]),
        validateAttachments: vi.fn(async () => undefined),
        persistCommand,
        ...overrides,
    }
    return { deps, persistCommand }
}

describe('createResolvedSendCommand', () => {
    const base = {
        organizationId: ORG_A,
        conversationId: CONV_1,
        actorUserId: '99999999-9999-4999-8999-999999999999',
        emailAccountId: ACCOUNT_1,
        bodyText: 'Thanks!',
    }

    it('persists a command whose recipients + headers were resolved from persisted messages, not the caller', async () => {
        const { deps, persistCommand } = orchestratorDeps()
        await createResolvedSendCommand({ ...base, mode: 'reply' }, deps)

        expect(persistCommand).toHaveBeenCalledTimes(1)
        const args = persistCommand.mock.calls[0][0]
        // Recipient + threading headers were server-derived from the thread.
        expect(args.to.map((r: { address: string }) => r.address)).toEqual(['lead@acme.example'])
        expect(args.inReplyTo).toBe('<lead-msg-1@acme.example>')
        expect(args.references).toContain('<lead-msg-1@acme.example>')
        expect(args.subject).toBe('Re: Demo request')
        // The body is the caller's; recipients/headers are not.
        expect(args.bodyText).toBe('Thanks!')
    })

    it('never dispatches inline — no provider/executor is reachable from the create path', async () => {
        const { deps, persistCommand } = orchestratorDeps()
        // The deps surface has NO dispatch capability at all; the only side effect is persistCommand.
        expect('dispatch' in deps).toBe(false)
        await createResolvedSendCommand({ ...base, mode: 'reply' }, deps)
        expect(persistCommand).toHaveBeenCalledOnce()
    })

    it('rejects a conversation outside the caller organization (cross-tenant)', async () => {
        const { deps } = orchestratorDeps({ loadConversation: vi.fn(async () => null) })
        await expect(createResolvedSendCommand({ ...base, organizationId: ORG_B, mode: 'reply' }, deps))
            .rejects.toThrow(InboxCommandResolutionError)
    })

    it('rejects when the sending account does not belong to the organization', async () => {
        const { deps } = orchestratorDeps({ loadAccountAddress: vi.fn(async () => null) })
        await expect(createResolvedSendCommand({ ...base, mode: 'reply' }, deps))
            .rejects.toThrow(InboxCommandResolutionError)
    })

    it('validates attachment ownership before persisting the command', async () => {
        const validateAttachments = vi.fn(async () => { throw new InboxCommandResolutionError('attachment_not_owned', 'x') })
        const { deps, persistCommand } = orchestratorDeps({ validateAttachments })
        await expect(createResolvedSendCommand({ ...base, mode: 'reply', attachmentIds: ['att-1'] }, deps))
            .rejects.toThrow(InboxCommandResolutionError)
        expect(validateAttachments).toHaveBeenCalledWith(ORG_A, ['att-1'])
        expect(persistCommand).not.toHaveBeenCalled()
    })
})

// ============================================================
// Executor — policy denial preserves the draft (reschedule, not destroy).
// ============================================================

interface FakeSqlResult {
    sql: ClaimedInboxCommand extends never ? never : import('./inbox-command-dispatch').InboxSql
    unsafeCalls: { query: string; params: unknown[] }[]
}

function fakeSql(conversationInOrg = true): FakeSqlResult {
    const unsafeCalls: { query: string; params: unknown[] }[] = []
    const tag = ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
        Promise.resolve(conversationInOrg ? [{ lead_id: null }] : [])) as unknown as FakeSqlResult['sql']
    ;(tag as unknown as { unsafe: (q: string, p: unknown[]) => Promise<unknown[]> }).unsafe = (query, params) => {
        unsafeCalls.push({ query, params })
        return Promise.resolve([{ id: 'row' }])
    }
    return { sql: tag, unsafeCalls }
}

function command(overrides: Partial<ClaimedInboxCommand> = {}): ClaimedInboxCommand {
    return {
        id: 'cmd-1',
        organizationId: ORG_A,
        conversationId: CONV_1,
        emailAccountId: ACCOUNT_1,
        actorUserId: '99999999-9999-4999-8999-999999999999',
        mode: 'reply',
        toRecipients: [{ address: 'lead@acme.example', name: 'Lead' }],
        ccRecipients: [],
        bccRecipients: [],
        subject: 'Re: Demo request',
        bodyText: 'Thanks!',
        bodyHtml: null,
        inReplyTo: '<lead-msg-1@acme.example>',
        messageReferences: '<lead-msg-1@acme.example>',
        attachmentIds: [],
        idempotencyKey: 'inbox-cmd:1',
        leaseToken: '00000000-0000-4000-8000-000000000011',
        attempts: 1,
        maxAttempts: 8,
        ...overrides,
    }
}

describe('executeInboxSendCommand: policy denial preserves the draft', () => {
    it('reschedules (does not fail/clear) when the shared policy gate defers the send', async () => {
        const { sql, unsafeCalls } = fakeSql()
        const dispatch = vi.fn(async (_input: DispatchOutreachInput): Promise<DispatchResult> => ({
            status: 'deferred',
            code: 'organization_disabled',
            retryAt: new Date('2026-07-16T13:00:00.000Z'),
        }))

        const outcome = await executeInboxSendCommand(command(), { sql, dispatch, now: () => new Date('2026-07-16T12:00:00.000Z') })

        expect(outcome).toBe('rescheduled')
        // The finalize UPDATE restores 'scheduled' (draft alive), never 'failed'/'cancelled'.
        const finalize = unsafeCalls.at(-1)!
        expect(finalize.query).toContain("status = 'scheduled'")
        expect(finalize.query).not.toContain("status = 'failed'")
        // The policy code is recorded so the operator sees WHY it was deferred.
        expect(finalize.params).toContain('organization_disabled')
    })

    it('routes the send through the injected policy-gated dispatcher exactly once', async () => {
        const { sql } = fakeSql()
        const dispatch = vi.fn(async (_input: DispatchOutreachInput): Promise<DispatchResult> => ({ status: 'sent', rowId: 'e1' }))
        await executeInboxSendCommand(command(), { sql, dispatch })
        expect(dispatch).toHaveBeenCalledTimes(1)
        // The dispatch input carries the frozen recipient + threading headers.
        const input = dispatch.mock.calls[0][0]
        expect(input.to).toBe('lead@acme.example')
        expect(input.inReplyTo).toBe('<lead-msg-1@acme.example>')
        expect(input.origin).toBe('unified_inbox')
    })
})
