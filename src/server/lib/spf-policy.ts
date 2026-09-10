/**
 * O que conta como SPF aceitável para um domínio nosso.
 *
 * Até 2026-08-16 isto exigia literalmente `include:spf.skaleclub.com`. Esse host é um CNAME para
 * `easthamptonhigh.org` — um domínio de TERCEIRO, cujo SPF autoriza `api.lizardlink.com`,
 * `api.superherosunman.com` e outros a enviar em nome de quem o inclui. Ou seja: a verificação
 * reprovava um SPF correto e aprovava um que delega autorização de envio a desconhecidos.
 *
 * O critério certo é: o registro autoriza os remetentes que a plataforma de fato usa —
 * o mecanismo `mx` (entrega direta pelo nosso próprio MX) ou o include do relay configurado.
 * O include legado continua aceito para não reprovar os domínios que ainda o carregam.
 */
// Exported so callers building the DNS setup instructions (routes/domains.ts) read the exact
// same host the verifier below checks against — this used to be a second hardcoded literal in
// domains.ts that had drifted to the wrong domain (`mx.skaleclub.com` in the UI vs the real
// `mx.skale.club` in production).
export const MAIL_HOST = process.env.MAIL_HOST || 'mx.skaleclub.com'

export const SPF_REQUIREMENT_MESSAGE =
    'SPF record not found, or does not authorize this platform (expected the `mx` mechanism, include:spf.brevo.com, or the legacy include:spf.skaleclub.com)'

// The record we tell admins to publish. Deliberately just the `mx` mechanism plus the Brevo
// relay include — the two senders isAcceptableSpf() below actually recognizes as us (the legacy
// `include:spf.skaleclub.com` is accepted for compatibility but never recommended for new
// domains). Exported as a single constant so the UI-facing copy and the acceptance check can
// never disagree about what "correct" looks like.
export const RECOMMENDED_SPF_RECORD = 'v=spf1 mx include:spf.brevo.com ~all'

export function isAcceptableSpf(record: string): boolean {
    const value = record.trim().toLowerCase()
    if (!value.startsWith('v=spf1')) return false
    const terms = value.split(/\s+/).slice(1)
    return terms.some((term) => {
        const bare = term.replace(/^[+\-~?]/, '')
        // `mx` autoriza o próprio MX do domínio, que é o nosso host de e-mail.
        if (bare === 'mx') return true
        if (bare === 'include:spf.brevo.com' || bare === 'include:spf.sendinblue.com') return true
        if (bare === 'include:spf.skaleclub.com') return true
        return bare === `a:${MAIL_HOST.toLowerCase()}` || bare === `mx:${MAIL_HOST.toLowerCase()}`
    })
}
