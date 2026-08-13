import { db, queryClient } from '../../db'
import { runWithLock } from '../lib/cron-lock'
import { createLogger } from '../lib/logger'
import { recordCost } from '../lib/outreach-costs'

const log = createLogger('outreach.costs.amortize')

interface EmailAccountRow {
    id: string
    organizationId: string
    email: string
    mailboxProvider: string | null
}

export interface AmortizeSubscriptionCostsSummary {
    accounts: number
    written: number
    duplicates: number
    rateMissing: number
}

/** First instant (00:00:00.000 UTC) of the calendar month containing `date`. */
export function startOfMonthUtc(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0))
}

/** `YYYY-MM` for the calendar month containing `date`, evaluated in UTC. */
export function monthKeyUtc(date: Date): string {
    const year = date.getUTCFullYear()
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    return `${year}-${month}`
}

/** Dedup key for one email account's inbox_subscription entry in the calendar month containing `date`. */
export function inboxSubscriptionDedupKey(emailAccountId: string, date: Date): string {
    return `inbox:${emailAccountId}:${monthKeyUtc(date)}`
}

/**
 * Posts one `inbox_subscription` cost entry per (live) email account for the current
 * calendar month.
 *
 * - `occurredAt` is pinned to the first instant of the billing month (UTC), NOT
 *   `new Date()`, so a re-run later in the same month resolves the same price-book rate
 *   and — combined with `dedupKey` — is a no-op rather than a second charge.
 * - Deliberately NOT prorated: an account added on the 28th is still charged a full
 *   month, same as one that existed on the 1st. Amortized billing here approximates the
 *   platform's own subscription cost, which isn't prorated either; modeling partial
 *   periods would add complexity this ledger doesn't need.
 * - `email_accounts` has no soft-delete column (confirmed against src/db/schema.ts), so
 *   every row is billed — there is nothing to exclude.
 * - Never throws: this runs under cron via runAmortizeSubscriptionCostsWithLock, and
 *   recordCost itself already never throws (see src/server/lib/outreach-costs.ts). The
 *   outer try/catch only guards the account-listing query.
 */
export async function amortizeSubscriptionCosts(now: Date = new Date()): Promise<AmortizeSubscriptionCostsSummary> {
    const occurredAt = startOfMonthUtc(now)
    const summary: AmortizeSubscriptionCostsSummary = { accounts: 0, written: 0, duplicates: 0, rateMissing: 0 }

    let rows: EmailAccountRow[]
    try {
        rows = await queryClient<EmailAccountRow[]>`
            SELECT id::text, organization_id::text AS "organizationId", email, mailbox_provider AS "mailboxProvider"
            FROM email_accounts
        `
    } catch (error) {
        const e = error instanceof Error ? error : new Error(String(error))
        log.error({
            action: 'outreach.costs.amortize_list_failed',
            error: { message: e.message, stack: e.stack },
        }, 'failed to list email accounts for subscription amortization')
        return summary
    }

    summary.accounts = rows.length

    for (const row of rows) {
        const result = await recordCost(db, {
            organizationId: row.organizationId,
            category: 'inbox_subscription',
            basis: 'amortized',
            quantity: 1,
            unit: 'month',
            provider: row.mailboxProvider ?? null,
            emailAccountId: row.id,
            dedupKey: inboxSubscriptionDedupKey(row.id, occurredAt),
            occurredAt,
        })

        if (result.written) {
            summary.written++
        } else {
            summary.duplicates++
        }
        if (result.rateMissing) {
            summary.rateMissing++
        }
    }

    log.info({
        action: 'outreach.costs.amortize_summary',
        month: monthKeyUtc(occurredAt),
        ...summary,
    }, 'amortized inbox subscription costs')

    return summary
}

export async function runAmortizeSubscriptionCostsWithLock(): Promise<void> {
    await runWithLock('amortizeSubscriptionCosts', amortizeSubscriptionCosts)
}
