/**
 * HTML escaping for Telegram's `parse_mode: HTML`.
 *
 * Lives in its own dependency-free module because the error-spike detector
 * needs it on a path that must NOT pull in the Telegram sender — that module
 * imports the Drizzle client, and importing it eagerly would mean a logging
 * tap opens a database connection. See error-spike-alert.ts.
 */

/**
 * Escapes the five characters that matter when interpolating into HTML markup or an HTML
 * attribute: Telegram's HTML parse mode only treats `& < > "` as markup, but this module is
 * also the canonical `escapeHtml` for every other HTML-interpolation site in the server
 * (template-variables.ts, routes/messages.ts, routes/templates.ts,
 * routes/outreach/unsubscribe.ts), several of which quote values inside `'...'`-delimited
 * attributes too, so `'` is escaped as well — a superset of what Telegram alone needs is
 * harmless for it (an unnecessary `&#39;` still renders as `'`), while dropping it would
 * silently reintroduce the gap those call sites depend on this module to close.
 *
 * Every dynamic fragment of a Telegram alert MUST go through this. Alert bodies carry error
 * messages, stack frames and email addresses — a stray angle bracket in an exception makes
 * Telegram reject the whole message with "can't parse entities", which would drop the alert
 * precisely when something is broken.
 */
export function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}
