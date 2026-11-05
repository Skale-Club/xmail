/**
 * Supabase projects that hold, or once held, real Xmail data. Development must never
 * point at one of these, and `npm run db:pull` refuses them as a destination.
 * Add a ref the moment a project starts serving real customers.
 */
export const PRODUCTION_PROJECT_REFS: readonly string[] = [
    'zzbudkfkcmqkavgwselc', // current hosted Auth project (its public schema is a stale copy)
    'ulzqxfeodxkyawfhjtpm', // retired production project (blocked by egress, 2026-08)
]

/** The known production ref found anywhere in `value` (a ref, host or URL), if any. */
export function findProductionProjectRef(value: string): string | undefined {
    const lower = value.toLowerCase()
    return PRODUCTION_PROJECT_REFS.find(ref => lower.includes(ref))
}
