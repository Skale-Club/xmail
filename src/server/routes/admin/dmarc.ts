/**
 * Fase 1 Part A.3 (docs/outbound-authentication-audit.md) — read-only DMARC authentication
 * rate endpoint, mounted alongside the existing outreach health route (routes/admin/outreach-
 * health.ts) with the same platform-admin gate.
 *
 *   GET /api/admin/dmarc/rates?domain=skale.club&sinceHours=168
 *
 * Answers the question the audit says the system could not answer before: for a domain and a
 * date range, what share of reported mail passed DKIM, what share passed SPF, and what share
 * passed DMARC alignment (a different, usually lower or equal, number — see dmarc-query.ts's
 * module header). Backed entirely by ingested DMARC aggregate reports (dmarc_reports /
 * dmarc_report_records, migration 067) — an empty result means no report has covered that
 * domain/range yet, not "0% passed" (see computeDmarcAuthenticationRates's null handling).
 */

import { Router, Request, Response } from 'express'
import { isPlatformAdmin } from '../../lib/admin'
import { createLogger } from '../../lib/logger'
import { computeDmarcAuthenticationRatesForDomain } from '../../lib/dmarc-query'

const router = Router()
const log = createLogger('dmarc.rates')

/** Default lookback when `sinceHours` is omitted — one week, comfortably wider than the
 *  roughly-daily report cadence (see DMARC_REPORT_GAP_HOURS in outreach-silence.ts) so a
 *  first-glance request without query params already returns something meaningful. */
const DEFAULT_LOOKBACK_HOURS = 168
const MAX_LOOKBACK_HOURS = 24 * 366 // a bit over a year — generous, still bounded

router.get('/rates', async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string | undefined
    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' })
    }
    if (!(await isPlatformAdmin(userId))) {
        log.warn({ action: 'dmarc.rates.forbidden', userId }, 'non-admin attempted DMARC rates endpoint')
        return res.status(403).json({ error: 'Forbidden — platform admin required' })
    }

    const domain = typeof req.query.domain === 'string' ? req.query.domain.trim().toLowerCase() : ''
    if (!domain) {
        return res.status(400).json({ error: 'domain query parameter is required' })
    }

    const requestedHours = Number(req.query.sinceHours)
    const lookbackHours = Number.isFinite(requestedHours) && requestedHours > 0
        ? Math.min(requestedHours, MAX_LOOKBACK_HOURS)
        : DEFAULT_LOOKBACK_HOURS

    const until = new Date()
    const since = new Date(until.getTime() - lookbackHours * 60 * 60 * 1000)

    try {
        const rates = await computeDmarcAuthenticationRatesForDomain(domain, since, until)
        return res.json({
            domain,
            since: since.toISOString(),
            until: until.toISOString(),
            ...rates,
        })
    } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        log.error(
            { action: 'dmarc.rates.error', domain, error: { message: e.message, stack: e.stack } },
            'DMARC rates endpoint threw',
        )
        return res.status(500).json({
            error: 'Internal server error',
            message: process.env.NODE_ENV === 'development' ? e.message : undefined,
        })
    }
})

export default router
