// ============================================================
// Public / free-mail domain classification (Phase 22 UIX-04, locked decision #8)
// ============================================================
// Blocking a whole domain is destructive and organization-wide. If the domain is a public or
// free-mail provider (gmail.com, outlook.com, …), a domain-scope block would suppress countless
// unrelated recipients — so the server refuses it and forces the safe per-sender scope instead.
// This list is intentionally conservative: it errs toward classifying a provider as public
// (safer to refuse a domain block) rather than risking a catastrophic organization-wide block.

const PUBLIC_EMAIL_DOMAINS = new Set<string>([
    // Google
    'gmail.com', 'googlemail.com',
    // Microsoft
    'outlook.com', 'outlook.co.uk', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'live.com', 'live.co.uk', 'msn.com',
    // Yahoo / AOL / Verizon
    'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.ca', 'ymail.com', 'rocketmail.com', 'aol.com',
    // Apple
    'icloud.com', 'me.com', 'mac.com',
    // Privacy-focused
    'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'tuta.com', 'hey.com',
    // Other large free-mail providers
    'gmx.com', 'gmx.net', 'gmx.de', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru',
    'fastmail.com', 'hushmail.com', 'inbox.com', 'mail.ru',
    // High-volume regional free-mail
    'qq.com', '163.com', '126.com', 'sina.com', 'naver.com', 'daum.net',
])

/**
 * True if `domain` is a public / free-mail provider that must NOT be blocked at domain scope.
 * The input is lowercased/trimmed defensively; an empty or malformed domain returns false so
 * the caller's own validation (not this classifier) decides how to reject it.
 */
export function isPublicEmailDomain(domain: string | null | undefined): boolean {
    if (!domain) return false
    return PUBLIC_EMAIL_DOMAINS.has(domain.trim().toLowerCase())
}

export { PUBLIC_EMAIL_DOMAINS }
