/**
 * The one place that talks to the Telegram Bot API.
 *
 * Credentials come from the ADMIN PANEL (`system_integrations`, surfaced at
 * /admin/integrations), not from the environment. That table, its encrypted
 * token column and its admin UI have existed since migration 023 (2026-05-21)
 * and nothing ever sent through them — `telegram_enabled` sat `false` for three
 * months. This module is the missing consumer, not a second system.
 *
 * Environment variables are a FALLBACK only, for contexts that have no database
 * (or when the panel row is deliberately disabled). The panel wins whenever it
 * is configured and enabled.
 *
 * ## Guarantees
 *
 * Never throws, never rejects, and never blocks a caller on the network. A
 * notification is not worth failing a request, a cron tick or a delivered mail
 * over — if Telegram is down the message is still sent, the campaign still
 * runs, and this returns ok:false.
 *
 * Unconfigured is a silent no-op by design: a fresh clone, CI, and every
 * developer machine have no panel row, and alerting must not make noise there.
 * The trade-off is that a MISconfigured bot also fails quietly, so every
 * rejection logs Telegram's own explanation — see describeFailure below.
 */
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { systemIntegrations } from '../../db/schema'
import { decryptSecret } from './crypto'
import { withTimeout } from './with-timeout'

const INTEGRATIONS_ID = 'default'

/** Telegram hard-rejects a message body over 4096 UTF-16 code units. */
const MAX_TEXT_LENGTH = 4096

/**
 * How long a resolved credential set is reused before re-reading the panel.
 *
 * Alerts arrive in bursts (an outage produces several within a minute) and each
 * one would otherwise be a round-trip to Postgres — on a path that fires
 * precisely when the database may be the thing that is broken. Sixty seconds
 * is short enough that changing the chat id in the panel takes effect while the
 * operator is still looking at the screen.
 */
const CONFIG_TTL_MS = 60_000

/**
 * Two destinations share one bot:
 *  - 'ops'      server, deploy, error, watchdog and uptime alerts (the original chat);
 *  - 'outreach' prospect replies and approval cards. Falls back to the ops chat until an outreach
 *               chat is configured, so nothing is lost before the second chat exists.
 */
export type TelegramChannel = 'ops' | 'outreach'

export interface TelegramConfig {
    token: string
    /** Where this channel sends: the outreach chat when set (outreach channel), else the ops chat. */
    chatId: string
    /** Only set for a group with Topics enabled; omitted from the request otherwise. */
    threadId?: string
    source: 'panel' | 'env'
    channel: TelegramChannel
    /** The ops chat, whichever channel was asked for. Its owner is the only user who may approve. */
    opsChatId: string
    /** The dedicated outreach chat, or undefined while outreach shares the ops chat. */
    outreachChatId?: string
}

/** What is stored, before a channel is picked. */
interface BaseTelegramConfig {
    token: string
    opsChatId: string
    opsThreadId?: string
    outreachChatId?: string
    outreachThreadId?: string
    source: 'panel' | 'env'
}

/** How long the panel row may take to load before the env fallback is used instead. */
const CONFIG_READ_TIMEOUT_MS = 5_000

let cached: { value: BaseTelegramConfig | null; at: number } | null = null

/** Test seam — the cache is module-global, so tests must be able to clear it. */
export function __resetTelegramConfigCache(): void {
    cached = null
}

/** Makes a changed chat id take effect now instead of after the 60 s TTL. */
export function invalidateTelegramConfigCache(): void {
    cached = null
}

/**
 * The optional outreach chat, read on its own so that a missing column (code deployed before
 * migration 075 ran) or a slow read costs only the outreach routing: outreach alerts then use the
 * ops chat, and every ops alert is untouched. Never throws.
 */
async function loadOutreachRoute(): Promise<{ chatId?: string; threadId?: string }> {
    try {
        const row = await withTimeout(
            db.query.systemIntegrations.findFirst({
                where: eq(systemIntegrations.id, INTEGRATIONS_ID),
                columns: { telegramOutreachChatId: true, telegramOutreachThreadId: true },
            }),
            CONFIG_READ_TIMEOUT_MS,
            'system_integrations outreach read',
        )
        return {
            chatId: row?.telegramOutreachChatId?.trim() || undefined,
            threadId: row?.telegramOutreachThreadId?.trim() || undefined,
        }
    } catch (err) {
        console.warn(
            '[telegram] could not read the outreach chat (is migration 075 applied?); outreach alerts use the ops chat:',
            err instanceof Error ? err.message : String(err),
        )
        return {}
    }
}

/**
 * Reads the panel row, falling back to the environment.
 *
 * Returns null (rather than throwing) for every failure mode: no row, disabled,
 * missing token or chat id, an undecryptable token, or an unreachable database.
 * The caller treats null as "not configured" and stays quiet.
 */
async function loadConfig(): Promise<BaseTelegramConfig | null> {
    try {
        // Bounded: the alert most worth delivering is "the database is unreachable", and a
        // read that hangs on that same database would swallow it. On timeout this falls
        // through to the env fallback below exactly as it does for any other failure.
        const row = await withTimeout(
            db.query.systemIntegrations.findFirst({
                where: eq(systemIntegrations.id, INTEGRATIONS_ID),
                // Only the original columns: the ops alerts must not depend on migration 075.
                columns: { telegramBotToken: true, telegramChatId: true, telegramEnabled: true },
            }),
            CONFIG_READ_TIMEOUT_MS,
            'system_integrations read',
        )

        if (row?.telegramEnabled && row.telegramBotToken && row.telegramChatId) {
            try {
                const token = decryptSecret(row.telegramBotToken, 'system_integrations.telegram_bot_token')
                const outreach = await loadOutreachRoute()
                return {
                    token,
                    opsChatId: row.telegramChatId,
                    opsThreadId: process.env.TELEGRAM_THREAD_ID || undefined,
                    outreachChatId: outreach.chatId,
                    outreachThreadId: outreach.threadId,
                    source: 'panel',
                }
            } catch (err) {
                // A wrong OUTLOOK_TOKEN_ENCRYPTION_KEY surfaces here rather than
                // as a bare crypto error. Named explicitly because this is the
                // 2026-08-15 failure mode: the row looks fine and is unreadable.
                console.warn(
                    '[telegram] panel token could not be decrypted — check OUTLOOK_TOKEN_ENCRYPTION_KEY:',
                    err instanceof Error ? err.message : String(err),
                )
            }
        }
    } catch (err) {
        // The database being unreachable is itself an alertable condition, so
        // this must degrade to the env fallback rather than abort the send.
        console.warn(
            '[telegram] could not read system_integrations; falling back to env:',
            err instanceof Error ? err.message : String(err),
        )
    }

    const token = process.env.TELEGRAM_BOT_TOKEN
    const chatId = process.env.TELEGRAM_CHAT_ID
    if (token && chatId) {
        return { token, opsChatId: chatId, opsThreadId: process.env.TELEGRAM_THREAD_ID || undefined, source: 'env' }
    }

    return null
}

async function getBaseConfig(): Promise<BaseTelegramConfig | null> {
    const now = Date.now()
    if (cached && now - cached.at < CONFIG_TTL_MS) return cached.value
    const value = await loadConfig()
    cached = { value, at: now }
    return value
}

async function getConfig(channel: TelegramChannel = 'ops'): Promise<TelegramConfig | null> {
    const base = await getBaseConfig()
    if (!base) return null
    const common = { token: base.token, source: base.source, opsChatId: base.opsChatId, outreachChatId: base.outreachChatId }
    if (channel === 'outreach' && base.outreachChatId) {
        // The ops thread belongs to the ops chat and must never leak into another one.
        return { ...common, chatId: base.outreachChatId, threadId: base.outreachThreadId, channel }
    }
    return { ...common, chatId: base.opsChatId, threadId: base.opsThreadId, channel }
}

// Re-exported so callers can keep importing it from here; the implementation
// lives in a dependency-free module because the spike detector needs it without
// pulling in this file's database import.
export { escapeHtml } from './html-escape'

interface TelegramErrorBody {
    description?: string
    error_code?: number
    parameters?: { migrate_to_chat_id?: number; retry_after?: number }
}

/**
 * Turns a Telegram rejection into something that names the fix.
 *
 * The status code alone almost never says what to do. Three cases matter enough
 * to spell out:
 *
 *  - **Supergroup migration.** When a group is upgraded — which Telegram does
 *    on its own once certain features are enabled — the chat id CHANGES and
 *    every later alert fails. Nothing looks broken; the messages simply stop.
 *    Telegram returns the replacement id in `parameters.migrate_to_chat_id`,
 *    so it is pulled out and printed as the literal value to paste back.
 *  - **403 from an unmessaged bot.** A bot cannot open a conversation. Until a
 *    human sends it one message, every send is forbidden — the single most
 *    common setup mistake.
 *  - **Chat not found**, which is what a typo'd or stale id looks like.
 */
function describeFailure(body: TelegramErrorBody): string {
    const base = body.description ?? `Telegram returned error_code ${body.error_code ?? 'unknown'}`

    const migrated = body.parameters?.migrate_to_chat_id
    if (migrated !== undefined) {
        return `${base} — the group became a supergroup and its id changed. Set the chat id to ${migrated} in the admin panel (Integrations) to restore alerts.`
    }
    if (body.error_code === 403) {
        return `${base} — a bot cannot start a conversation. Send the bot one message from the destination chat, then retry.`
    }
    if (body.error_code === 400 && /chat not found/i.test(base)) {
        return `${base} — the configured chat id does not exist for this bot. Re-read it from getUpdates after messaging the bot.`
    }
    const retryAfter = body.parameters?.retry_after
    if (retryAfter !== undefined) {
        return `${base} — rate limited, retry after ${retryAfter}s.`
    }
    return base
}

export interface SendResult {
    ok: boolean
    /** 'unconfigured' is a success-shaped no-op, not a failure to investigate. */
    reason?: 'unconfigured' | 'rejected' | 'network'
    detail?: string
}

/**
 * Sends one message. Resolves ok:false instead of rejecting, always.
 *
 * `title` and `body` are inserted into HTML parse mode verbatim, so callers
 * compose them from literal markup plus escapeHtml()-ed fragments.
 *
 * `channel` defaults to 'ops', so every existing caller is unchanged. Outreach callers pass
 * 'outreach', which lands in the dedicated chat when one is set and in the ops chat otherwise.
 */
export async function sendTelegram(title: string, body = '', channel: TelegramChannel = 'ops'): Promise<SendResult> {
    try {
        const config = await getConfig(channel)
        if (!config) return { ok: false, reason: 'unconfigured' }

        let text = body ? `${title}\n\n${body}` : title
        if (text.length > MAX_TEXT_LENGTH) {
            text = `${text.slice(0, MAX_TEXT_LENGTH - 20)}\n\n[truncated]`
        }

        const payload: Record<string, unknown> = {
            chat_id: config.chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        }
        if (config.threadId) payload.message_thread_id = config.threadId

        // Node's fetch has no default timeout; without this an unreachable
        // Telegram would hold the handle open indefinitely.
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), 20_000)

        try {
            const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: abort.signal,
            })

            const parsed = await response.json().catch(() => ({})) as TelegramErrorBody & { ok?: boolean }

            if (parsed.ok) return { ok: true }

            const detail = describeFailure(parsed)
            console.error(`[telegram] rejected "${title}" — ${detail}`)
            return { ok: false, reason: 'rejected', detail }
        } finally {
            clearTimeout(timer)
        }
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        console.error(`[telegram] could not deliver "${title}" — ${detail}`)
        return { ok: false, reason: 'network', detail }
    }
}

/** The resolved bot config (panel row, else env), or null when Telegram is not set up. */
export async function getTelegramConfig(channel: TelegramChannel = 'ops'): Promise<TelegramConfig | null> {
    return getConfig(channel)
}

/**
 * Stores (or clears, with null) the dedicated outreach chat. A new chat starts without a thread:
 * the old thread id belonged to the old chat. Throws if the database write fails, so the caller
 * can tell the owner instead of confirming something that did not happen.
 */
export async function setTelegramOutreachChat(chatId: string | null): Promise<void> {
    await db
        .update(systemIntegrations)
        .set({ telegramOutreachChatId: chatId, telegramOutreachThreadId: null, updatedAt: new Date() })
        .where(eq(systemIntegrations.id, INTEGRATIONS_ID))
    invalidateTelegramConfigCache()
}

/**
 * Calls one Bot API method with a JSON body. Resolves `{ ok: false }` instead of throwing, like
 * sendTelegram. Used by the approval buttons (lib/telegram-approvals.ts) for sendMessage with an
 * inline keyboard, editMessageText, answerCallbackQuery and setWebhook.
 */
export async function callTelegramApi<T = unknown>(
    method: string,
    payload: Record<string, unknown>,
): Promise<{ ok: true; result: T } | { ok: false; detail: string }> {
    try {
        const config = await getConfig()
        if (!config) return { ok: false, detail: 'unconfigured' }
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), 20_000)
        try {
            const response = await fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: abort.signal,
            })
            const parsed = await response.json().catch(() => ({})) as TelegramErrorBody & { ok?: boolean; result?: T }
            if (parsed.ok) return { ok: true, result: parsed.result as T }
            const detail = describeFailure(parsed)
            console.error(`[telegram] ${method} rejected — ${detail}`)
            return { ok: false, detail }
        } finally {
            clearTimeout(timer)
        }
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        console.error(`[telegram] ${method} failed — ${detail}`)
        return { ok: false, detail }
    }
}

/** True when an alert would actually go somewhere. Used to skip building bodies. */
export async function isTelegramConfigured(channel: TelegramChannel = 'ops'): Promise<boolean> {
    return (await getConfig(channel)) !== null
}

/**
 * Which source the credentials came from, or null when unconfigured.
 *
 * Exists so the startup line can say 'panel' or 'env' truthfully rather than
 * naming one of them unconditionally. An ops message that misreports where its
 * own configuration came from is worse than no message: it is the line someone
 * will trust while debugging why the panel edit had no effect.
 */
export async function getTelegramConfigSource(): Promise<'panel' | 'env' | null> {
    return (await getConfig())?.source ?? null
}
