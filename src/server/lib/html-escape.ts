/**
 * HTML escaping for Telegram's `parse_mode: HTML`.
 *
 * Lives in its own dependency-free module because the error-spike detector
 * needs it on a path that must NOT pull in the Telegram sender — that module
 * imports the Drizzle client, and importing it eagerly would mean a logging
 * tap opens a database connection. See error-spike-alert.ts.
 */

/**
 * Escapes the four characters Telegram's HTML parse mode treats as markup.
 *
 * Every dynamic fragment of an alert MUST go through this. Alert bodies carry
 * error messages, stack frames and email addresses — a stray angle bracket in
 * an exception makes Telegram reject the whole message with "can't parse
 * entities", which would drop the alert precisely when something is broken.
 */
export function escapeHtml(value: unknown): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}
