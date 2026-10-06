// ============================================================
// Short relative times for the unified inbox ("2h ago")
// ============================================================
// Standalone helper (utils.ts keeps the long date-fns style used by the webmail). Dense list rows
// need the compact form: "now", "5m ago", "2h ago", "3d ago", "2mo ago", "1y ago".

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

export function formatRelativeShort(input: Date | string | number, now: Date | number = Date.now()): string {
    const date = input instanceof Date ? input : new Date(input)
    const nowMs = now instanceof Date ? now.getTime() : now
    const seconds = Math.round((nowMs - date.getTime()) / 1000)
    if (Number.isNaN(seconds)) return ''
    if (seconds < 45) return 'now'
    if (seconds < HOUR) return `${Math.max(1, Math.round(seconds / MINUTE))}m ago`
    if (seconds < DAY) return `${Math.round(seconds / HOUR)}h ago`
    if (seconds < MONTH) return `${Math.round(seconds / DAY)}d ago`
    if (seconds < YEAR) return `${Math.max(1, Math.floor(seconds / MONTH))}mo ago`
    return `${Math.max(1, Math.floor(seconds / YEAR))}y ago`
}

/** Exact local date and time for `title` attributes. */
export function formatDateTime(input: Date | string | number): string {
    const date = input instanceof Date ? input : new Date(input)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}
