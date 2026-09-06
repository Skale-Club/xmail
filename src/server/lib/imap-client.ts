/**
 * The ONE place an ImapFlow client is constructed.
 *
 * Why this exists (2026-09-02 crash): `ImapFlow` is an EventEmitter. When its socket times out
 * outside IDLE — a remote IMAP server that stops answering mid-FETCH — imapflow's
 * `_socketTimeout` handler calls `emitError(err)`, which does `this.emit('error', err)`. Every
 * caller in this codebase awaited `connect()`/`search()`/`fetchOne()` inside try/catch and
 * assumed the rejection was the only signal. It is not: an `'error'` event on an emitter with NO
 * listener is re-thrown by Node as an uncaught exception, and install-alerting.ts exits the
 * process on those. One slow mailbox took the whole mail server down:
 *
 *   Error: Socket timeout
 *       at TLSSocket._socketTimeout (/app/node_modules/imapflow/lib/imap-flow.js:861:29)
 *
 * Every client built here has an `'error'` listener attached BEFORE `connect()`, so the event
 * is logged and the in-flight command still rejects (imapflow closes the connection, which
 * rejects every pending request) — the caller's try/catch handles it as it always should have.
 *
 * The timeouts are also pinned here rather than left at imapflow's defaults. The default
 * `socketTimeout` is 5 minutes of silence per command; two stalled mailboxes in one inbound
 * pass would consume the cron-lock's entire 10-minute budget on their own. Two minutes is
 * plenty for a single FETCH on a healthy server and fails a dead one fast enough for the rest
 * of the accounts to still get their turn.
 */
import { ImapFlow, type ImapFlowOptions } from 'imapflow'
import { createLogger } from './logger'

const log = createLogger('imap.client')

/** Silence on the socket, per command, before the connection is declared dead. */
export const IMAP_SOCKET_TIMEOUT_MS = 2 * 60 * 1000
/** TCP/TLS connect. */
export const IMAP_CONNECTION_TIMEOUT_MS = 30 * 1000
/** Server greeting after connect. */
export const IMAP_GREETING_TIMEOUT_MS = 30 * 1000

export interface ImapClientTarget {
    host: string
    port?: number | null
    /** `false` for STARTTLS/plain; anything else means implicit TLS on the port. */
    secure?: boolean | null
    auth: { user: string; pass: string }
    /**
     * Per-call-site timeout overrides. The defaults above are a safe ceiling for a path with
     * no budget of its own; a caller that runs under a cron lock has measured its own latency
     * and its budget is tighter than any generic default can be. outreach-inbound-sources.ts
     * is the worked example: 10s/10s/15s, derived from an observed 55-61s job, so a stalled
     * socket is caught well before that path's own 20s per-account deadline. Overriding here
     * keeps the crash guard universal without flattening a budget somebody measured.
     */
    timeouts?: {
        connectionTimeout?: number
        greetingTimeout?: number
        socketTimeout?: number
    }
}

export interface ImapClientContext {
    /** Which account/mailbox the client is for. Logged with every socket error. */
    emailAccountId?: string
    /** Free-form purpose, e.g. 'inbound-ingest', 'warmup-groom', 'verify'. */
    purpose: string
}

/**
 * Builds an ImapFlow client with the crash guard and bounded timeouts described above.
 * Callers still `await client.connect()` and `client.logout()` exactly as before.
 */
export function createImapClient(target: ImapClientTarget, context: ImapClientContext): ImapFlow {
    const options: ImapFlowOptions = {
        host: target.host,
        port: target.port || 993,
        secure: target.secure !== false,
        auth: target.auth,
        logger: false,
        socketTimeout: target.timeouts?.socketTimeout ?? IMAP_SOCKET_TIMEOUT_MS,
        connectionTimeout: target.timeouts?.connectionTimeout ?? IMAP_CONNECTION_TIMEOUT_MS,
        greetingTimeout: target.timeouts?.greetingTimeout ?? IMAP_GREETING_TIMEOUT_MS,
    }
    const client = new ImapFlow(options)
    attachImapErrorGuard(client, context)
    return client
}

/**
 * Attaches the `'error'` listener. Exported separately so a test can prove the guard on a
 * bare emitter, and so any future ImapFlow constructed outside createImapClient (there should
 * be none — grep for `new ImapFlow`) can at least be guarded.
 *
 * Logged at WARN, not error: the command that was in flight rejects with the same failure and
 * the caller logs that as the error. Counting the event as well would double every IMAP
 * failure in the error-spike detector.
 */
export function attachImapErrorGuard(
    client: Pick<ImapFlow, 'on'>,
    context: ImapClientContext,
): void {
    client.on('error', (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err))
        log.warn({
            action: 'imap.client.socket_error',
            purpose: context.purpose,
            emailAccountId: context.emailAccountId ?? null,
            error: {
                message: error.message,
                code: (error as { code?: unknown }).code ?? null,
            },
        }, 'IMAP connection error (handled — the in-flight command rejects with it)')
    })
}
