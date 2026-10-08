/**
 * Orquestração da varredura e do gancho, sem banco e sem rede: o carregamento das pendentes, a
 * gravação do estado e o envio entram por injeção. O que se prova aqui é o comportamento que o
 * Vanildo sente: o aviso sai, não sai duas vezes, e uma falha do Telegram nunca derruba o
 * processamento da resposta.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('../../logger', () => ({ createLogger: () => logMock }))
// sweep.ts importa o cliente do Drizzle, o Telegram e as queries do Unified Inbox; nenhum deles
// pode abrir conexão num teste unitário.
vi.mock('../../../../db', () => ({ db: {}, jobQueryClient: {}, queryClient: {} }))
vi.mock('../../telegram', () => ({
    isTelegramConfigured: vi.fn(async () => true),
    sendTelegram: vi.fn(async () => ({ ok: true })),
}))
vi.mock('../../unified-inbox/queries', () => ({ NEEDS_REPLY: {} }))
vi.mock('../../unified-inbox/ingest', () => ({ materializeProviderEvent: vi.fn() }))
vi.mock('../../inbox-events', () => ({ publishInboxEvent: vi.fn() }))
vi.mock('../../cron-lock', () => ({
    runWithLock: vi.fn(async (_name: string, fn: () => Promise<unknown>) => { await fn() }),
}))

import { notifyReplyReceived, runReplyAlertSweepWithLock, REPLY_ALERT_LOCK_NAME } from '../hook'
import type { PendingReply } from '../plan'
import { __resetUnconfiguredWarning, MAX_FIRST_ALERTS_PER_TICK, runReplyAlertSweep, type SweepDeps } from '../sweep'
import { runWithLock } from '../../cron-lock'
import { isTelegramConfigured, sendTelegram } from '../../telegram'

const at = (iso: string) => new Date(iso)
const NOON = at('2026-07-15T16:00:00Z') // 12:00 EDT

let seq = 0
function row(overrides: Partial<PendingReply> = {}): PendingReply {
    seq++
    return {
        organizationId: 'org-1',
        conversationId: `conv-${seq}`,
        replyMessageId: `msg-${seq}`,
        repliedAt: at('2026-07-15T13:00:00Z'),
        isRead: false,
        alert: null,
        leadName: 'Boston Blendz',
        fromAddress: 'david.c@bostonblendz.com',
        inboxAddress: 'vanildo.skale@tryskaleclub.com',
        plainBody: 'Sounds good',
        htmlBody: null,
        ...overrides,
    }
}

function deps(rows: PendingReply[], overrides: Partial<SweepDeps> = {}) {
    const send = vi.fn<NonNullable<SweepDeps['send']>>(async () => ({ ok: true }))
    const recordAlert = vi.fn(async () => {})
    const loadPending = vi.fn(async () => rows)
    const merged: SweepDeps = {
        now: () => NOON,
        baseUrl: 'https://mail.skale.club',
        isConfigured: async () => true,
        loadPending,
        recordAlert,
        send,
        ...overrides,
    }
    return { merged, send, recordAlert, loadPending }
}

beforeEach(() => {
    vi.clearAllMocks()
    __resetUnconfiguredWarning()
})

describe('runReplyAlertSweep', () => {
    it('sends through the OUTREACH Telegram channel by default (ops alerts stay on the ops chat)', async () => {
        const loadPending = vi.fn(async () => [row()])
        const result = await runReplyAlertSweep({}, { now: () => NOON, baseUrl: 'https://mail.skale.club', loadPending, recordAlert: vi.fn(async () => {}) })

        expect(result.first).toBe(1)
        expect(isTelegramConfigured).toHaveBeenCalledWith('outreach')
        expect(sendTelegram).toHaveBeenCalledTimes(1)
        expect(vi.mocked(sendTelegram).mock.calls[0][2]).toBe('outreach')
    })

    it('sends the first alert and records it', async () => {
        const fresh = row()
        const { merged, send, recordAlert } = deps([fresh])
        const result = await runReplyAlertSweep({}, merged)

        expect(result).toMatchObject({ considered: 1, first: 1, failed: 0 })
        expect(send).toHaveBeenCalledTimes(1)
        expect(send.mock.calls[0]).toEqual([
            expect.stringContaining('Resposta nova da Boston Blendz'),
            expect.stringContaining('unified-inbox?conversation=conv-'),
        ])
        expect(recordAlert).toHaveBeenCalledWith(fresh, 'first', NOON)
    })

    it('does not alert twice for a reply already alerted (no repeat from hook + cron)', async () => {
        const r = row()
        const already = { ...r, alert: { replyMessageId: r.replyMessageId, lastAlertedAt: at('2026-07-15T15:30:00Z') } }
        const { merged, send, recordAlert } = deps([already])
        await runReplyAlertSweep({}, merged)
        expect(send).not.toHaveBeenCalled()
        expect(recordAlert).not.toHaveBeenCalled()
    })

    it('does not record an alert Telegram refused, so the next tick retries it', async () => {
        const { merged, recordAlert } = deps([row()], {
            send: vi.fn(async () => ({ ok: false, reason: 'rejected' as const, detail: 'Bad Request' })),
        })
        const result = await runReplyAlertSweep({}, merged)
        expect(result).toMatchObject({ first: 0, failed: 1 })
        expect(recordAlert).not.toHaveBeenCalled()
        expect(logMock.warn).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'outreach.replyAlerts.send_failed', reason: 'rejected' }),
            expect.any(String),
        )
    })

    it('keeps going when one send fails', async () => {
        const send = vi.fn()
            .mockResolvedValueOnce({ ok: false, reason: 'network' })
            .mockResolvedValueOnce({ ok: true })
        const { merged, recordAlert } = deps([row(), row()], { send })
        const result = await runReplyAlertSweep({}, merged)
        expect(result).toMatchObject({ first: 1, failed: 1 })
        expect(recordAlert).toHaveBeenCalledTimes(1)
    })

    it('does not fail the sweep when saving the state fails after a successful send', async () => {
        const { merged } = deps([row()], { recordAlert: vi.fn(async () => { throw new Error('db down') }) })
        const result = await runReplyAlertSweep({}, merged)
        expect(result.first).toBe(1)
        expect(logMock.warn).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'outreach.replyAlerts.record_failed' }),
            expect.any(String),
        )
    })

    it('skips quietly, and logs once, when Telegram is not configured', async () => {
        const { merged, loadPending, send } = deps([row()], { isConfigured: async () => false })
        const first = await runReplyAlertSweep({}, merged)
        const second = await runReplyAlertSweep({}, merged)

        expect(first.skipped).toBe('unconfigured')
        expect(second.skipped).toBe('unconfigured')
        expect(loadPending).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
        const unconfiguredLogs = logMock.warn.mock.calls.filter(
            ([payload]) => (payload as { action?: string }).action === 'outreach.replyAlerts.unconfigured',
        )
        expect(unconfiguredLogs).toHaveLength(1)
    })

    it('records reminders with kind "reminder" and the morning summary with kind "summary"', async () => {
        const base = row()
        const dueReminder = { ...base, alert: { replyMessageId: base.replyMessageId, lastAlertedAt: at('2026-07-15T14:00:00Z') } }
        const reminders = deps([dueReminder])
        await runReplyAlertSweep({}, reminders.merged)
        expect(reminders.recordAlert).toHaveBeenCalledWith(dueReminder, 'reminder', NOON)
        expect(reminders.send.mock.calls[0][0]).toContain('Lembrete: a resposta da Boston Blendz está sem leitura há 3h')

        const b = row()
        const overnight = { ...b, alert: { replyMessageId: b.replyMessageId, lastAlertedAt: at('2026-07-15T02:00:00Z') } }
        const summary = deps([overnight], { now: () => at('2026-07-15T12:00:00Z') })
        await runReplyAlertSweep({}, summary.merged)
        expect(summary.recordAlert).toHaveBeenCalledWith(overnight, 'summary', at('2026-07-15T12:00:00Z'))
        expect(summary.send.mock.calls[0][0]).toContain('Bom dia: 1 resposta esperando você')
    })

    it('sends nothing at night about an alerted conversation', async () => {
        const base = row()
        const alertedRow = { ...base, alert: { replyMessageId: base.replyMessageId, lastAlertedAt: at('2026-07-14T14:00:00Z') } }
        const { merged, send } = deps([alertedRow], { now: () => at('2026-07-15T06:00:00Z') })
        await runReplyAlertSweep({}, merged)
        expect(send).not.toHaveBeenCalled()
    })

    it('caps the first alerts per tick; the rest wait for the next tick', async () => {
        const rows = Array.from({ length: MAX_FIRST_ALERTS_PER_TICK + 3 }, () => row())
        const { merged, send } = deps(rows)
        const result = await runReplyAlertSweep({}, merged)
        expect(result.first).toBe(MAX_FIRST_ALERTS_PER_TICK)
        expect(send).toHaveBeenCalledTimes(MAX_FIRST_ALERTS_PER_TICK)
    })

    it('passes the organization and conversation filter to the loader', async () => {
        const { merged, loadPending } = deps([])
        await runReplyAlertSweep({ organizationId: 'org-1', conversationId: 'conv-9' }, merged)
        expect(loadPending).toHaveBeenCalledWith({ organizationId: 'org-1', conversationId: 'conv-9' }, NOON)
    })

    it('never logs the reply text or the addresses', async () => {
        const { merged } = deps([row({ plainBody: 'SECRET-BODY-TEXT', fromAddress: 'secret.person@example.com' })], {
            send: vi.fn(async () => ({ ok: false, reason: 'network' as const })),
        })
        await runReplyAlertSweep({}, merged)
        const logged = JSON.stringify([...logMock.info.mock.calls, ...logMock.warn.mock.calls, ...logMock.error.mock.calls])
        expect(logged).not.toContain('SECRET-BODY-TEXT')
        expect(logged).not.toContain('secret.person@example.com')
    })
})

describe('notifyReplyReceived (hook in processReplies)', () => {
    const event = { id: 'evt-1', organizationId: 'org-1' }

    it('materializes the event, then sweeps only that conversation', async () => {
        const materialize = vi.fn(async () => ({ inserted: true, conversationId: 'conv-1' }))
        const runSweep = vi.fn(async () => {})
        await notifyReplyReceived(event, { materialize, runSweep })
        expect(materialize).toHaveBeenCalledWith('evt-1')
        expect(runSweep).toHaveBeenCalledWith({ organizationId: 'org-1', conversationId: 'conv-1' })
    })

    it('does not sweep when there is no conversation (warm-up traffic or a failed materialization)', async () => {
        const runSweep = vi.fn(async () => {})
        await notifyReplyReceived(event, { materialize: async () => ({ inserted: false, conversationId: null }), runSweep })
        expect(runSweep).not.toHaveBeenCalled()
    })

    it('does not throw when Telegram refuses the message', async () => {
        const { merged, recordAlert } = deps([row()], {
            send: vi.fn(async () => ({ ok: false, reason: 'rejected' as const, detail: 'chat not found' })),
        })
        await expect(notifyReplyReceived(event, {
            materialize: async () => ({ inserted: true, conversationId: 'conv-1' }),
            runSweep: async (filter) => { await runReplyAlertSweep(filter, merged) },
        })).resolves.toBeUndefined()
        expect(recordAlert).not.toHaveBeenCalled()
    })

    it('does not throw when Telegram throws', async () => {
        const { merged } = deps([row()], { send: vi.fn(async () => { throw new Error('socket hang up') }) })
        await expect(notifyReplyReceived(event, {
            materialize: async () => ({ inserted: true, conversationId: 'conv-1' }),
            runSweep: async (filter) => { await runReplyAlertSweep(filter, merged) },
        })).resolves.toBeUndefined()
        expect(logMock.warn).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'outreach.replyAlerts.hook_failed' }),
            expect.any(String),
        )
    })

    it('does not throw when the database fails while materializing', async () => {
        await expect(notifyReplyReceived(event, {
            materialize: async () => { throw new Error('connection terminated') },
            runSweep: async () => { throw new Error('should not be reached') },
        })).resolves.toBeUndefined()
    })

    it('does not throw when the sweep itself throws', async () => {
        await expect(notifyReplyReceived(event, {
            materialize: async () => ({ inserted: true, conversationId: 'conv-1' }),
            runSweep: async () => { throw new Error('boom') },
        })).resolves.toBeUndefined()
    })
})

describe('runReplyAlertSweepWithLock', () => {
    it('runs the sweep inside the named advisory lock so the hook and the cron cannot double-send', async () => {
        const sweep = vi.fn(async () => ({ considered: 0, first: 0, reminders: 0, summaries: 0, failed: 0 }))
        await runReplyAlertSweepWithLock({ conversationId: 'conv-1' }, sweep)
        expect(runWithLock).toHaveBeenCalledWith(REPLY_ALERT_LOCK_NAME, expect.any(Function), expect.objectContaining({ timeoutMs: expect.any(Number) }))
        expect(sweep).toHaveBeenCalledWith({ conversationId: 'conv-1' })
    })
})
