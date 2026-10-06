/**
 * Escape ILIKE wildcards so operator input matches literally. Postgres' default ILIKE escape
 * character is the backslash, so `%`, `_` and the backslash itself are each prefixed with one.
 * Without this a search for `100%` or `a_b` silently turned into a wildcard match.
 */
export function escapeLikePattern(input: string): string {
    return input.replace(/[\\%_]/g, (char) => `\\${char}`)
}
