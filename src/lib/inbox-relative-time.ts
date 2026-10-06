// ============================================================
// Short relative times for the unified inbox ("2h ago")
// ============================================================
// Standalone helper (utils.ts keeps the long date-fns style used by the webmail). Dense list rows
// need the compact form: "now", "5m ago", "2h ago", "3d ago", "2mo ago", "1y ago". Units are
// floored so a boundary never reads "60m ago" / "24h ago" / "30d ago".

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/** With `bare`, the "ago" suffix is dropped ("2h") for labels that carry their own wording. */
export function formatRelativeShort(input: Date | string | number, now: Date | number = Date.now(), bare = false): string {
    const date = input instanceof Date ? input : new Date(input)
    const nowMs = now instanceof Date ? now.getTime() : now
    const seconds = Math.floor((nowMs - date.getTime()) / 1000)
    if (Number.isNaN(seconds)) return ''
    const suffix = bare ? '' : ' ago'
    if (seconds < 60) return 'now'
    if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m${suffix}`
    if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h${suffix}`
    if (seconds < MONTH) return `${Math.floor(seconds / DAY)}d${suffix}`
    if (seconds < YEAR) return `${Math.floor(seconds / MONTH)}mo${suffix}`
    return `${Math.floor(seconds / YEAR)}y${suffix}`
}

/** Exact local date and time for `title` attributes. */
export function formatDateTime(input: Date | string | number): string {
    const date = input instanceof Date ? input : new Date(input)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}
