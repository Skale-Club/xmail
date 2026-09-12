/**
 * Fase 1 Part A.2 (docs/outbound-authentication-audit.md) — cron entry point for DMARC
 * aggregate report ingestion. Advisory-locked like every other polling job in this directory
 * (see cron-lock.ts); the lock name is registered in KNOWN_LOCK_NAMES so a stuck lock on this
 * job is nameable by outreach-silence-query.ts instead of showing up as an opaque key.
 */
import { JOB_TIMEOUT_BUDGETS_MS, runWithLock } from '../lib/cron-lock'
import { ingestDmarcReports } from '../lib/dmarc-ingest'

export const DMARC_REPORTS_PROCESSOR_LOCK_NAME = 'dmarc-reports-processor'

/** Failure handling (log + swallow) happens at the jobs/index.ts cron call site, matching
 *  every other `run*WithLock` wrapper in this directory. */
export async function runDmarcReportsProcessorWithLock(): Promise<void> {
    await runWithLock(DMARC_REPORTS_PROCESSOR_LOCK_NAME, async () => {
        await ingestDmarcReports()
    }, { timeoutMs: JOB_TIMEOUT_BUDGETS_MS.dmarcReportsProcessor })
}
