// ============================================================
// Scheduling / booking marketplace email classification (Defeito 2, 2026-09-30)
// ============================================================
// Xcraper scrapes a barbershop/salon's page on a booking marketplace (Booksy, Vagaro, ...) and
// sometimes pulls the PLATFORM's own support address instead of the business's — the page shows
// it, the MX record resolves, so it sails through email verification. Evidence: importing the
// first 69 verified prospects on 2026-09-30, `help.us@booksy.com` (Booksy's own support inbox)
// showed up as the "company email" for 11 DIFFERENT barbershops. Had the batch not also hit the
// unrelated bulk-import 500 (Defeito 1, same day), the campaign would have cold-emailed Booksy
// support 11 times. Xmail is the one place every lead passes through before it can join a
// campaign, so this is the point to block it — bulk-import, single lead creation, and
// campaign/agent enrollment (defense in depth for leads that already made it into the leads
// table) all consult this list.
//
// Conservative by construction, mirrors public-email-domains.ts: only known scheduling/
// marketplace domains go in this set, and a subdomain match (e.g. `mail.booksy.com`) is caught
// too. Confirmed against each provider's own domain before listing:
//   - booksy.com              Booksy (evidence above)
//   - vagaro.com              Vagaro
//   - styleseat.com           StyleSeat
//   - schedulicity.com        Schedulicity
//   - fresha.com              Fresha
//   - setmore.com             Setmore
//   - squareup.com / square.site   Square Appointments (squareup.com is the account/support
//                                   domain; square.site is the auto-generated site domain Square
//                                   hands every merchant, so its inbox is Square's, not theirs)
//   - mindbodyonline.com      Mindbody
//   - glossgenius.com         GlossGenius
//   - genbook.com             Genbook
//   - acuityscheduling.com    Acuity Scheduling
//   - zenoti.com              Zenoti
//   - boulevard.io            Boulevard
//   - pocketsuite.io          PocketSuite — measured on the same 2026-09-30 batch: a barbershop
//                              prospect was recorded with `privacy@pocketsuite.io` (PocketSuite's
//                              own privacy inbox) as its "company email".

const PLATFORM_EMAIL_DOMAINS = new Set<string>([
    'booksy.com',
    'vagaro.com',
    'styleseat.com',
    'schedulicity.com',
    'fresha.com',
    'setmore.com',
    'squareup.com',
    'square.site',
    'mindbodyonline.com',
    'glossgenius.com',
    'genbook.com',
    'acuityscheduling.com',
    'zenoti.com',
    'boulevard.io',
    'pocketsuite.io',
    // 2026-10-07: alinhado com Xphere e Xcraper (as tres listas tem que ser iguais).
    'booksy.net',
    'getsquire.com',
    'mytime.com',
    'bookedin.com',
])

/**
 * True if `domain` (or any subdomain of it, e.g. `mail.booksy.com`) belongs to a known
 * scheduling/marketplace platform whose email is never the listed business's own address.
 */
export function isPlatformEmailDomain(domain: string | null | undefined): boolean {
    if (!domain) return false
    const normalized = domain.trim().toLowerCase()
    if (!normalized) return false
    for (const platformDomain of PLATFORM_EMAIL_DOMAINS) {
        if (normalized === platformDomain || normalized.endsWith(`.${platformDomain}`)) return true
    }
    return false
}

/**
 * True if `email`'s domain belongs to a scheduling/marketplace platform. Malformed input (no
 * `@`, empty string, null/undefined) returns false — this classifier only judges the domain,
 * not whether the email is otherwise well-formed (that's the caller's own Zod validation).
 */
export function isPlatformEmail(email: string | null | undefined): boolean {
    if (!email) return false
    const at = email.lastIndexOf('@')
    if (at === -1 || at === email.length - 1) return false
    return isPlatformEmailDomain(email.slice(at + 1))
}

export { PLATFORM_EMAIL_DOMAINS }
