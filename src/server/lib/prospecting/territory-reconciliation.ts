/**
 * Fase 36 defect fix (2026-09-12) — pure decision logic for reconciling a territory left
 * `status='running'` by a prior daily-prospecting tick.
 *
 * ROOT CAUSE (measured in production): `runDailyProspecting` marks a territory 'running' the
 * moment Xcraper's `POST /scrape` accepts the job and hands back a `searchId`
 * (`last_external_run_id` — see runDailyProspecting.ts). Xcraper does NOT push a finished scrape
 * to Xphere on its own; it only pushes from inside its `GET /scrape/:id` handler (Xcraper repo,
 * backend/src/routes/service.ts ~line 205), whichever request happens to observe the Apify run
 * finishing first. `runDailyProspecting` was written to never poll, on the (wrong) assumption
 * that Xphere would register the run on its own once the scrape finished. Nothing ever polled,
 * so two territories sat at `status='running'` for a full day and more (Hudson, MA —
 * searchId b301ddcc-d66a-41d4-ade2-5c47fbaf1d0c, completed at Apify 2026-09-11 but only reached
 * Xphere at 2026-09-12T13:47, when this was investigated by hand; Maynard, MA — searchId
 * aafe53e4-0809-4fb0-8862-7024a3f96e20, same story a day later).
 *
 * THE FIX: `runDailyProspecting.ts` now polls `GET /scrape/:id` for every 'running' territory at
 * the START of each tick — this is not an optimization-away-able extra step, it is THE completion
 * mechanism. Do not remove the poll on the theory that "Xphere should register the run on its
 * own" — that is the exact assumption that caused this defect.
 *
 * This module is the PURE half of that reconciliation — given the scrape status Xcraper reports
 * and how long the territory has been 'running', decide what to do. It has no I/O so it is
 * unit-testable without a fetch mock or a database (same split as daily-territory-budget.ts /
 * runDailyProspecting.ts for the sizing decision). The IO half (the actual GET, and applying the
 * decision to the database) lives in runDailyProspecting.ts.
 *
 * `action: 'completed'` NEVER means "flip this territory to done" here — Xphere creates the
 * matching `prospecting_runs` row (keyed by `idempotency_key = last_external_run_id`)
 * ASYNCHRONOUSLY after the push this poll just triggered/confirmed, and the existing
 * join-based reconciliation in runDailyProspecting.ts's `reconcileTerritories` is what flips
 * 'running' -> 'done' once that row exists (possibly not until a LATER tick). This module never
 * writes 'done' itself, and never re-fires a scrape for a territory that already has a
 * `last_external_run_id` — a paid Xcraper scrape must never be duplicated by a reconciliation
 * pass.
 */

/** A territory 'running' longer than this without resolving is stalled -- logged and skipped,
 *  never silently re-fired (that would duplicate a paid scrape) and never silently left forever
 *  either (the stalled log line is what a human acts on). 48h: generous next to the 3-12 minute
 *  scrapes actually observed, but long enough to never fire on a scrape that is merely slow. */
export const STALLED_RUNNING_THRESHOLD_MS = 48 * 60 * 60 * 1000

/**
 * The `status` field from Xcraper's `GET /scrape/:id` response. Xcraper's own vocabulary for
 * "not finished yet" is not pinned down here (could be 'processing', 'running', 'pending', ...)
 * — anything other than the two states this module DOES special-case ('completed' / 'failed')
 * is treated as "still running", which is the safe default (never re-fires, never marks failed
 * on an unrecognized string). Plain `string` rather than a narrower union so an unrecognized
 * value from Xcraper is a normal, expected input, not a type error.
 */
export type XcraperScrapeStatus = string

export interface TerritoryReconciliationInput {
    /** `status` from Xcraper's GET /scrape/:id response for this territory's last_external_run_id. */
    scrapeStatus: XcraperScrapeStatus
    /** now - territory.last_attempted_at, in ms. Only consulted when the scrape is neither
     *  'completed' nor 'failed', to detect a wedged run. */
    elapsedSinceAttemptMs: number
    /** Override for STALLED_RUNNING_THRESHOLD_MS, exposed for tests. */
    stalledThresholdMs?: number
}

export type TerritoryReconciliationDecision =
    /** Xcraper reports the scrape finished (and, per the GET handler, has pushed or confirmed
     *  push to Xphere by now). Leave the territory 'running' -- see module doc for why this is
     *  correct, not a bug. */
    | { action: 'completed' }
    /** Xcraper reports the scrape failed. Caller marks the territory 'paused' (the status CHECK
     *  constraint in migration 065 has no 'failed' value) with a reason, so it stops blocking
     *  the queue. */
    | { action: 'failed'; reason: string }
    /** Still in progress at Xcraper, and not stalled yet. Leave it, log it. */
    | { action: 'still_running' }
    /** Been 'running' longer than the stall threshold with no terminal status. Log and skip --
     *  never re-fire (would duplicate a paid scrape) and never flip status on a guess. */
    | { action: 'stalled' }

/**
 * Decides what a single 'running' territory's reconciliation poll should do. Pure: no fetch, no
 * database. See the module doc comment for the full rationale and the invariants this enforces.
 */
export function decideTerritoryReconciliation(
    input: TerritoryReconciliationInput,
): TerritoryReconciliationDecision {
    if (input.scrapeStatus === 'completed') {
        return { action: 'completed' }
    }

    if (input.scrapeStatus === 'failed') {
        return { action: 'failed', reason: `xcraper reported scrape status 'failed' for this territory's last_external_run_id` }
    }

    const threshold = input.stalledThresholdMs ?? STALLED_RUNNING_THRESHOLD_MS
    if (input.elapsedSinceAttemptMs >= threshold) {
        return { action: 'stalled' }
    }

    return { action: 'still_running' }
}
