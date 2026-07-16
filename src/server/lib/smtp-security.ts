/**
 * SMTP submission security — the single source of truth for how a stored outreach
 * account maps onto Nodemailer transport options.
 *
 * Why this module exists (PROV-01): `email_accounts.smtp_port` defaults to 587 while
 * `email_accounts.smtp_secure` defaults to true, and both the sender and the account
 * verifier used to pass that boolean straight to Nodemailer. For Nodemailer `secure:true`
 * means "TLS from the first byte", which is port 465's contract — on 587 the server
 * answers in cleartext and expects STARTTLS, so the handshake fails or, worse, the two
 * call sites drift apart and an inbox verifies through one config and sends through another.
 *
 * The rule, once:
 *   - 465            → implicit TLS (`secure:true`)
 *   - 587            → STARTTLS, required (`secure:false`, `requireTLS:true`)
 *   - 25             → STARTTLS: required when the connection authenticates, opportunistic
 *                      only for an unauthenticated MX relay. See `authenticated` below.
 *   - anything else  → the stored flag is the only signal; `secure:true` is honoured as
 *                      deliberate nonstandard implicit TLS, otherwise required STARTTLS.
 *
 * Why port 25 is conditional (C-1): opportunistic STARTTLS means "encrypt if the peer
 * offers it". An on-path attacker simply strips `250-STARTTLS` from the EHLO response;
 * with no `requireTLS`, nodemailer has nothing to object to and continues in cleartext.
 * That is tolerable for MX relay — the alternative is refusing to deliver mail to peers
 * that genuinely have no TLS, and there are no credentials on the wire. It is NOT
 * tolerable for submission, where the very next command is `AUTH LOGIN` carrying the
 * decrypted mailbox password. Since `buildSmtpTransportOptions` attaches `auth`
 * unconditionally, every transport it builds is authenticated and therefore requires TLS.
 *
 * Legacy rows whose flag contradicts their port are normalized (not rejected) and reported
 * via `warning`, so an inbox written before this module still sends. New writes are
 * validated at the API boundary instead — see routes/outreach/email-accounts.ts.
 *
 * INTENTIONALLY DEPENDENCY-FREE. This module is imported by browser code
 * (src/pages/outreach/inboxes/*) so that presets, CSV import, API validation, verification
 * and delivery all share one implementation of the rule rather than four copies of a
 * `port === 465` guess. Keep it pure: no db, no nodemailer runtime import, no env access.
 */

/** Implicit TLS ("SMTPS") — TLS is established before the SMTP greeting. */
export const SMTP_IMPLICIT_TLS_PORT = 465
/** Message submission (RFC 6409) — cleartext greeting, upgraded via STARTTLS. */
export const SMTP_SUBMISSION_PORT = 587
/** MTA relay — STARTTLS where offered, but many peers still do not offer it. */
export const SMTP_RELAY_PORT = 25

/**
 * Floor for the negotiated TLS version. Everything below 1.2 is deprecated
 * (RFC 8996) and no mail provider we submit to requires it.
 */
export const SMTP_MIN_TLS_VERSION = 'TLSv1.2'

export type SmtpSubmissionMode = 'implicit_tls' | 'starttls_required' | 'starttls_opportunistic'

export interface SmtpSecurityInput {
    /** Stored `email_accounts.smtp_port`. Null/unset falls back to the 587 submission default. */
    port?: number | null
    /** Stored `email_accounts.smtp_secure`. Null/unset means "no explicit preference". */
    secure?: boolean | null
    /**
     * Will this connection present SMTP AUTH credentials?
     *
     * Defaults to true: every caller in this codebase resolves a stored outreach inbox,
     * which authenticates by definition. Only an unauthenticated MX relay may pass false,
     * and only port 25 reads it — on every other port the TLS mode is already unconditional.
     */
    authenticated?: boolean
}

export interface SmtpSecurityResolution {
    mode: SmtpSubmissionMode
    /** The port actually dialled, after fallback. */
    port: number
    /** Nodemailer `secure` — TLS from connection start. */
    secure: boolean
    /** Nodemailer `requireTLS` — fail rather than submit over cleartext. */
    requireTLS: boolean
    tls: { minVersion: typeof SMTP_MIN_TLS_VERSION }
    /** True when an explicit `secure` contradicted the port and was overridden. */
    normalized: boolean
    /** Operator-facing explanation of the override. Never contains credentials. */
    warning: string | null
}

function resolvePort(port: number | null | undefined): number {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        return SMTP_SUBMISSION_PORT
    }
    return port
}

/** Human label for a mode. Exported so operator UI names the mode the server will use. */
export function describeSmtpSecurityMode(mode: SmtpSubmissionMode): string {
    switch (mode) {
        case 'implicit_tls':
            return 'implicit TLS'
        case 'starttls_required':
            return 'STARTTLS (required)'
        case 'starttls_opportunistic':
            return 'STARTTLS (opportunistic)'
    }
}

/**
 * True when the port alone determines the TLS mode, so a user-supplied flag is redundant
 * (and, if it disagrees, rejected). Only nonstandard ports need to be asked about.
 */
export function isStandardSmtpPort(port: number | null | undefined): boolean {
    const resolved = resolvePort(port)
    return resolved === SMTP_IMPLICIT_TLS_PORT || resolved === SMTP_SUBMISSION_PORT || resolved === SMTP_RELAY_PORT
}

/**
 * Map a stored port/flag pair onto deterministic Nodemailer transport semantics.
 * Pure: same input, same output, no I/O.
 */
export function resolveSmtpSecurity(input: SmtpSecurityInput): SmtpSecurityResolution {
    const port = resolvePort(input.port)
    const requested = typeof input.secure === 'boolean' ? input.secure : null
    const authenticated = input.authenticated !== false

    let mode: SmtpSubmissionMode
    if (port === SMTP_IMPLICIT_TLS_PORT) {
        mode = 'implicit_tls'
    } else if (port === SMTP_SUBMISSION_PORT) {
        mode = 'starttls_required'
    } else if (port === SMTP_RELAY_PORT) {
        // Credentials on the wire are what make opportunistic indefensible, so the
        // presence of AUTH — not the port number — decides.
        mode = authenticated ? 'starttls_required' : 'starttls_opportunistic'
    } else {
        // Nonstandard port: we have no convention to lean on, so an explicit secure=true is
        // taken at face value (some vendors do run implicit TLS on e.g. 2465). Absent that,
        // require STARTTLS — the safe reading of an unknown submission port.
        mode = requested === true ? 'implicit_tls' : 'starttls_required'
    }

    const secure = mode === 'implicit_tls'
    const requireTLS = mode === 'starttls_required'

    // Only an explicit flag can be "wrong". An unset flag has nothing to contradict.
    const normalized = requested !== null && requested !== secure
    const warning = normalized
        ? `SMTP port ${port} implies ${describeSmtpSecurityMode(mode)}, but this account stores secure=${requested}. ` +
          `Using ${describeSmtpSecurityMode(mode)} instead. Re-save the inbox to store secure=${secure} for port ${port}.`
        : null

    return {
        mode,
        port,
        secure,
        requireTLS,
        tls: { minVersion: SMTP_MIN_TLS_VERSION },
        normalized,
        warning,
    }
}

/**
 * True when the resolved transport cannot end up in cleartext: TLS either precedes the
 * greeting, or STARTTLS is mandatory and the connection fails rather than downgrade.
 */
export function guaranteesTls(resolution: SmtpSecurityResolution): boolean {
    return resolution.secure || resolution.requireTLS
}

export interface SmtpTransportInput extends SmtpSecurityInput {
    host: string
    username: string
    /** Already-decrypted password. Never logged, never echoed into errors. */
    password: string
    connectionTimeoutMs?: number
    greetingTimeoutMs?: number
}

export interface SmtpTransportOptions {
    host: string
    port: number
    secure: boolean
    requireTLS: boolean
    tls: { minVersion: typeof SMTP_MIN_TLS_VERSION }
    auth: { user: string; pass: string }
    connectionTimeout?: number
    greetingTimeout?: number
}

/**
 * Compose the full Nodemailer transport options for an account. Both the verification
 * transporter and the send transporter go through here, which is what guarantees they
 * cannot disagree: the only permitted difference is the verify path's connect/greeting
 * timeouts.
 */
export function buildSmtpTransportOptions(input: SmtpTransportInput): {
    options: SmtpTransportOptions
    resolution: SmtpSecurityResolution
} {
    // authenticated:true is not a default being relied on — this function attaches `auth`
    // below, so the fact is stated at the one place that makes it true.
    const resolution = resolveSmtpSecurity({
        port: input.port,
        secure: input.secure,
        authenticated: true,
    })

    // Unreachable by construction, asserted anyway: this is the only place credentials and
    // transport options meet, so the invariant lives here rather than in a comment that a
    // future resolver change could silently outgrow. Failing closed loses a send; the
    // alternative loses the password.
    if (!guaranteesTls(resolution)) {
        throw new Error(
            `SMTP submission on port ${resolution.port} resolved to ${describeSmtpSecurityMode(resolution.mode)}, `
            + 'which permits cleartext. Refusing to attach credentials.',
        )
    }

    const options: SmtpTransportOptions = {
        host: input.host,
        port: resolution.port,
        secure: resolution.secure,
        requireTLS: resolution.requireTLS,
        tls: resolution.tls,
        auth: { user: input.username, pass: input.password },
    }

    if (input.connectionTimeoutMs !== undefined) options.connectionTimeout = input.connectionTimeoutMs
    if (input.greetingTimeoutMs !== undefined) options.greetingTimeout = input.greetingTimeoutMs

    return { options, resolution }
}
