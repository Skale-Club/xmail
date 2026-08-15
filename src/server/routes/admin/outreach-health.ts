/**
 * Phase 17 — Outreach health endpoint.
 *
 *   GET /api/admin/outreach/health
 *
 * Platform-admin-only. Returns aggregate metrics over rolling 1h / 24h / 7d
 * windows plus structured alerts. Operator's primary debugging surface for
 * the outreach module — see 17-CONTEXT.md for response-shape rationale.
 *
 * Auth: the parent /api JWT middleware in src/server/index.ts injects
 * `x-user-id`; this handler then gates on `isPlatformAdmin(userId)` so
 * non-admin authenticated users get 403, not 200 with empty data.
 *
 * Response shape:
 *   {
 *     asOf: ISO,
 *     overall: { sent1h, sent24h, sent7d, openRate24h, ..., processorTickP50Ms, ... },
 *     byOrg:   [{ organizationId, name, sent24h, bounceRate24h, replyRate24h, status }],
 *     topBouncingCampaigns: [{ campaignId, name, sent24h, bounceRate24h }],  // top 5
 *     silence: { warmupSends24h, doubleEncodedJsonbColumns, ... },  // ver outreach-silence.ts
 *     alerts:  [{ severity, kind, message, since }],
 *     thresholds: { bounceWarn1h, bounceError24h, processorSlowMs },
 *     _meta:   { latencyMs, notes }
 *   }
 *
 * Os alertas vêm de DUAS famílias, e a distinção é o ponto: `buildAlerts` cobre falha ("algo deu
 * erro e o erro foi gravado"), enquanto `buildSilenceAlerts` cobre ausência de resultado ("isto
 * deveria ter produzido algo e não produziu"). A segunda existe porque, em 2026-08-15, sete
 * defeitos reais foram encontrados de uma vez e nenhum deles teria disparado um alerta da primeira.
 */

import { Router, Request, Response } from 'express'
import { isPlatformAdmin } from '../../lib/admin'
import { createLogger } from '../../lib/logger'
import {
    computeOverallMetrics,
    computeByOrgMetrics,
    computeTopBouncingCampaigns,
    buildAlerts,
    OUTREACH_BOUNCE_WARN_1H,
    OUTREACH_BOUNCE_ERROR_24H,
    OUTREACH_PROCESSOR_SLOW_MS,
    computeAgentOpsMetrics,
} from '../../lib/outreach-metrics'
import { buildSilenceAlerts } from '../../lib/outreach-silence'
import { computeSilenceMetrics } from '../../lib/outreach-silence-query'

const router = Router()
const log = createLogger('outreach.health')

router.get('/health', async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string | undefined
    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' })
    }

    if (!(await isPlatformAdmin(userId))) {
        log.warn({ action: 'outreach.health.forbidden', userId }, 'non-admin attempted health endpoint')
        return res.status(403).json({ error: 'Forbidden — platform admin required' })
    }

    const now = new Date()
    const t0 = performance.now()

    try {
        const [overall, byOrg, topBouncingCampaigns, agentOps, silence] = await Promise.all([
            computeOverallMetrics(now),
            computeByOrgMetrics(now),
            computeTopBouncingCampaigns(now),
            computeAgentOpsMetrics(now),
            computeSilenceMetrics(now),
        ])

        const alerts = buildAlerts(overall, byOrg, topBouncingCampaigns, now)
        // Silêncio é uma classe de defeito distinta de falha: o subsistema não errou, apenas não
        // produziu nada — e zero é um valor válido, então ele se disfarça de operação normal. Ver
        // outreach-silence.ts para o incidente que motivou cada checagem.
        alerts.push(...buildSilenceAlerts(silence, now))
        if (agentOps.stuckExecutingApprovals > 0) {
            alerts.push({ severity: 'critical', kind: 'stuck_agent_approvals', message: `${agentOps.stuckExecutingApprovals} paid action approval(s) have been executing for more than 15 minutes; inspect before retrying.`, since: now.toISOString() })
        }
        if (agentOps.failedXphereDeliveries > 0) {
            alerts.push({ severity: 'critical', kind: 'failed_xphere_events', message: `${agentOps.failedXphereDeliveries} Xphere event(s) exhausted delivery retries.`, since: now.toISOString() })
        }
        if (agentOps.failedProspectingRuns24h > 0) {
            alerts.push({ severity: 'warning', kind: 'failed_prospecting_runs', message: `${agentOps.failedProspectingRuns24h} prospecting run(s) failed in the last 24 hours.`, since: now.toISOString() })
        }

        const latencyMs = Math.round(performance.now() - t0)
        log.info({
            action: 'outreach.health.served',
            latencyMs,
            alertCount: alerts.length,
            orgCount: byOrg.length,
        }, 'health snapshot served')

        return res.json({
            asOf: now.toISOString(),
            overall,
            byOrg,
            topBouncingCampaigns,
            agentOps,
            silence,
            alerts,
            thresholds: {
                bounceWarn1h: OUTREACH_BOUNCE_WARN_1H,
                bounceError24h: OUTREACH_BOUNCE_ERROR_24H,
                processorSlowMs: OUTREACH_PROCESSOR_SLOW_MS,
            },
            _meta: {
                latencyMs,
                notes: 'All rates are fractions in [0,1]. Bounce-rate alerts require sent>=20 (1h) and sent>=100 (24h) to avoid noise. Processor p50/p95 returns null when fewer than 5 ticks recorded since last restart.',
            },
        })
    } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        log.error({
            action: 'outreach.health.error',
            error: { message: e.message, stack: e.stack },
        }, 'health endpoint threw')
        return res.status(500).json({
            error: 'Internal server error',
            message: process.env.NODE_ENV === 'development' ? e.message : undefined,
        })
    }
})

export default router
