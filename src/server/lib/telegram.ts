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

export interface TelegramConfig {
    token: string
    chatId: string
    /** Only set for a group with Topics enabled; omitted from the request otherwise. */
    threadId?: string
    source: 'panel' | 'env'
}

let cached: { value: TelegramConfig | null; at: number } | null = null

/** Test seam — the cache is module-global, so tests must be able to clear it. */
export function __resetTelegramConfigCache(): void {
    cached = null
}

/**
 * Reads the panel row, falling back to the environment.
 *
 * Returns null (rather than throwing) for every failure mode: no row, disabled,
 * missing token or chat id, an undecryptable token, or an unreachable database.
 * The caller treats null as "not configured" and stays quiet.
 */
async function loadConfig(): Promise<TelegramConfig | null> {
    try {
        const row = await db.query.systemIntegrations.findFirst({
            where: eq(systemIntegrations.id, INTEGRATIONS_ID),
        })

        if (row?.telegramEnabled && row.telegramBotToken && row.telegramChatId) {
            try {
                return {
                    token: decryptSecret(row.telegramBotToken, 'system_integrations.telegram_bot_token'),
                    chatId: row.telegramChatId,
                    threadId: process.env.TELEGRAM_THREAD_ID || undefined,
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
        return { token, chatId, threadId: process.env.TELEGRAM_THREAD_ID || undefined, source: 'env' }
    }

    return null
}

async function getConfig(): Promise<TelegramConfig | null> {
    const now = Date.now()
    if (cached && now - cached.at < CONFIG_TTL_MS) return cached.value
    const value = await loadConfig()
    cached = { value, at: now }
    return value
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
 */
export async function sendTelegram(title: string, body = ''): Promise<SendResult> {
    try {
        const config = await getConfig()
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

/** True when an alert would actually go somewhere. Used to skip building bodies. */
export async function isTelegramConfigured(): Promise<boolean> {
    return (await getConfig()) !== null
}
