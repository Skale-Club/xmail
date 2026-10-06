/**
 * Turns the advanced-search form into the operator syntax the server parses
 * (see src/server/lib/mail-search-query.ts). Filtering by date and attachments
 * happens on the server so it covers the whole mailbox, not just the first page.
 */

export type SearchDateRange = 'all' | 'today' | 'week' | 'month' | 'year'

export interface SearchFilters {
    query: string
    from: string
    to: string
    subject: string
    hasAttachment: boolean | null
    dateRange: SearchDateRange
    folder: string
}

export const EMPTY_SEARCH_FILTERS: SearchFilters = {
    query: '',
    from: '',
    to: '',
    subject: '',
    hasAttachment: null,
    dateRange: 'all',
    folder: '',
}

function quoteValue(value: string): string {
    const cleaned = value.trim().replace(/"/g, '')
    return /\s/.test(cleaned) ? `"${cleaned}"` : cleaned
}

function toIsoDay(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

/** First calendar day (local) included by a relative range, as YYYY-MM-DD. */
export function dateRangeStart(range: SearchDateRange, now: Date = new Date()): string | null {
    if (range === 'all') return null
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    if (range === 'week') start.setDate(start.getDate() - 7)
    if (range === 'month') start.setDate(start.getDate() - 30)
    if (range === 'year') start.setDate(start.getDate() - 365)
    return toIsoDay(start)
}

export function buildSearchQuery(filters: SearchFilters, now: Date = new Date()): string {
    const parts: string[] = []
    if (filters.query.trim()) parts.push(filters.query.trim())
    if (filters.from.trim()) parts.push(`from:${quoteValue(filters.from)}`)
    if (filters.to.trim()) parts.push(`to:${quoteValue(filters.to)}`)
    if (filters.subject.trim()) parts.push(`subject:${quoteValue(filters.subject)}`)
    if (filters.hasAttachment === true) parts.push('has:attachment')
    if (filters.hasAttachment === false) parts.push('has:noattachment')
    const after = dateRangeStart(filters.dateRange, now)
    if (after) parts.push(`after:${after}`)
    return parts.join(' ')
}
