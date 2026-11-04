/** Drizzle shares postgres.js with these raw stores and installs string timestamp
 * codecs. Keep the Date-based identity contract at this boundary, never mutate
 * the shared driver's global serializers/parsers or allocate another pool. */
export function sqlTimestampDate(value: unknown): Date {
    let parsed: Date
    if (value instanceof Date) parsed = new Date(value.getTime())
    else if (typeof value === 'string' && value.length <= 64
        && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)?$/.test(value)) {
        let normalized = value.replace(' ', 'T')
        if (/[+-]\d\d$/.test(normalized)) normalized += ':00'
        // PostgreSQL timestamp without time zone follows the application's UTC
        // contract, matching Drizzle's timestamp date mapping.
        parsed = new Date(/(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(normalized) ? normalized : normalized + 'Z')
    } else throw new Error('Identity timestamp is unavailable.')
    if (!Number.isFinite(parsed.getTime())) throw new Error('Identity timestamp is unavailable.')
    return parsed
}

export function nullableSqlTimestampDate(value: unknown): Date | null {
    return value === null ? null : sqlTimestampDate(value)
}

export function sqlTimestampParameter(value: Date): string {
    return sqlTimestampDate(value).toISOString()
}
