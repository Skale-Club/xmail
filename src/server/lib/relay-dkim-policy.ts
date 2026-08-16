/**
 * Política de assinatura DKIM própria por relay — função pura, sem I/O (por isso mora fora de
 * `dkim.ts`, que abre conexão com o banco: os testes deste módulo não precisam de DATABASE_URL).
 */

/**
 * Relays that rewrite the message body in transit (tracking pixels, link rewriting, footer,
 * re-encoding). Our own DKIM signature cannot survive that: the receiver sees
 * `dkim=neutral (body hash did not verify)` for OUR domain, which is at best noise and at worst
 * a negative signal — while the relay adds its own signature anyway (aligned with the sender
 * domain once the domain is authenticated on the relay side). Verified on 2026-08-16 against
 * Gmail's Authentication-Results for mail relayed through smtp-relay.brevo.com.
 */
const BODY_REWRITING_RELAY_HOSTS = ['brevo.com', 'sendinblue.com', 'mailin.fr']

/**
 * Whether to skip signing with the sender domain's own DKIM key because the configured relay
 * rewrites the body. `NATIVE_DKIM_SIGN=always` forces signing (e.g. after disabling tracking on
 * the relay); `NATIVE_DKIM_SIGN=never` skips it for any relay.
 */
export function shouldSkipOwnDkimForRelay(relayHost: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
    const mode = (env.NATIVE_DKIM_SIGN ?? 'auto').toLowerCase()
    if (mode === 'always') return false
    if (mode === 'never') return Boolean(relayHost)
    const host = (relayHost ?? '').toLowerCase()
    return BODY_REWRITING_RELAY_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}
