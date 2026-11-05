import net from 'node:net'

/**
 * Fail-closed network guard for the development server.
 *
 * `npm run db:pull` puts a copy of real mail (bodies, addresses, mailbox settings)
 * into the development database. From then on, any code path that reached an
 * external server with that data would hit real people: an SMTP relay, direct MX
 * delivery on port 25, an IMAP account sync, Outlook/Graph, webhooks, Telegram,
 * Xphere, AI providers or MillionVerifier.
 *
 * Auditing each call site is not enough, so the guard sits at the lowest layer all of
 * them share: `net.Socket#connect`. `fetch`, `http(s)`, `tls`, nodemailer, imapflow
 * and the AWS/Supabase SDKs all end up here. A connection to a host that is not on
 * the allow-list is destroyed with `EDEVOUTBOUND` before a single byte is sent.
 *
 * Allowed by default: loopback (Vite, the dev server, the SSH tunnel), the pinned
 * development database hosts and the pinned development Supabase project. Anything
 * else needs an explicit, host-by-host `XMAIL_DEV_OUTBOUND_ALLOW_HOSTS` entry.
 * There is deliberately no "allow everything" switch.
 */

export const OUTBOUND_BLOCKED_CODE = 'EDEVOUTBOUND'

const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|::1|0:0:0:0:0:0:0:1)$/

export function normalizeHost(host: string): string {
    return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

/** Hosts the dev process may talk to, derived from the declared development settings. */
export function devAllowedHosts(env: NodeJS.ProcessEnv): string[] {
    const hosts = new Set<string>()
    const add = (value: string | undefined) => {
        if (!value) return
        try { hosts.add(normalizeHost(new URL(value).hostname)) } catch { /* ignore malformed */ }
    }
    add(env.XMAIL_DEV_DATABASE_URL)
    add(env.XMAIL_DEV_DIRECT_URL)
    // Derived from the declared DEV project, never from SUPABASE_URL (which may still
    // hold the production value in a shell or .env).
    const ref = env.XMAIL_DEV_SUPABASE_PROJECT_REF?.trim().toLowerCase()
    if (ref && /^[a-z0-9]+$/.test(ref)) hosts.add(`${ref}.supabase.co`)
    for (const entry of (env.XMAIL_DEV_OUTBOUND_ALLOW_HOSTS ?? '').split(',')) {
        const host = normalizeHost(entry)
        // A bare wildcard would be the "allow everything" switch in disguise.
        if (host && host !== '*' && !host.startsWith('*') && !host.includes('/')) hosts.add(host)
    }
    return [...hosts]
}

export function isHostAllowed(host: string, allowed: readonly string[]): boolean {
    const h = normalizeHost(host)
    return LOOPBACK.test(h) || allowed.includes(h)
}

/** The host a `Socket#connect(...)` call is about to dial, or null for a unix socket. */
export function connectTarget(args: unknown[]): string | null {
    let first = args[0]
    if (Array.isArray(first)) first = first[0] // node's internal normalized form [options, cb]
    if (first && typeof first === 'object') {
        const options = first as { host?: string; path?: string }
        if (options.path) return null
        return options.host || 'localhost'
    }
    if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
        return typeof args[1] === 'string' ? args[1] : 'localhost'
    }
    return null // a string path: unix domain socket
}

type ConnectFn = (...args: unknown[]) => unknown
const installed = Symbol.for('xmail.devOutboundGuard')
const original = Symbol.for('xmail.devOutboundGuard.original')

/**
 * Install the guard on `net.Socket.prototype.connect`. Idempotent. Returns the list
 * of hosts that were blocked (live array, for tests and diagnostics).
 */
export function installDevOutboundGuard(
    env: NodeJS.ProcessEnv,
    log: (message: string) => void = message => console.warn(message),
): string[] {
    const proto = net.Socket.prototype as unknown as Record<symbol, unknown> & { connect: ConnectFn }
    const existing = proto[installed] as string[] | undefined
    if (existing) return existing

    const blocked: string[] = []
    const real = proto.connect
    proto.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
        const host = connectTarget(args)
        if (host === null || isHostAllowed(host, devAllowedHosts(env))) return real.apply(this, args)
        const error = Object.assign(
            new Error(
                `Outbound connection to ${normalizeHost(host)} blocked: development never contacts external servers ` +
                `(add the host to XMAIL_DEV_OUTBOUND_ALLOW_HOSTS only if it is safe with real data).`,
            ),
            { code: OUTBOUND_BLOCKED_CODE },
        )
        if (!blocked.includes(normalizeHost(host))) {
            blocked.push(normalizeHost(host))
            log(`[dev-guard] ${error.message}`)
        }
        process.nextTick(() => this.destroy(error))
        return this
    }
    proto[installed] = blocked
    proto[original] = real
    return blocked
}

/** Test helper: put the real `connect` back. Never called by the application. */
export function uninstallDevOutboundGuard(): void {
    const proto = net.Socket.prototype as unknown as Record<symbol, unknown> & { connect: ConnectFn }
    if (!proto[installed]) return
    proto.connect = proto[original] as ConnectFn
    delete proto[installed]
    delete proto[original]
}
