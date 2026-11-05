import { installDevOutboundGuard } from './dev-outbound-guard'

/**
 * Imported first by src/server/index.ts. In development only (the same
 * `NODE_ENV === 'development'` switch the DB target and scheduler use) it makes the
 * process incapable of sending or receiving real mail:
 *   - the embedded SMTP/IMAP/MX servers stay off (they already require non-development),
 *     and ENABLE_MAIL_SERVER is forced to 'false' as a second lock;
 *   - the outbound SMTP relay settings are blanked, so nothing is configured to relay;
 *   - every TCP connection to a host that is not loopback, the development database or
 *     the development Supabase project is destroyed (direct MX delivery on port 25,
 *     IMAP account sync, Outlook, webhooks, Telegram, Xphere, AI, verification APIs).
 */
export function applyDevelopmentMailIsolation(env: NodeJS.ProcessEnv): boolean {
    if (env.NODE_ENV !== 'development') return false
    env.ENABLE_MAIL_SERVER = 'false'
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) env[key] = ''
    installDevOutboundGuard(env)
    return true
}

applyDevelopmentMailIsolation(process.env)
