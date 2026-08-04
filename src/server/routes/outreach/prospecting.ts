import { Router } from 'express'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../../db'
import { prospectAiAssessments, prospectCandidates, prospectingRuns } from '../../../db/schema'
import { requireOutreachRead } from '../../lib/outreach-access'

const router = Router()

router.get('/runs', async (req, res) => {
    try {
        const query = z.object({
            organizationId: z.string().uuid(),
            status: z.enum(['pending', 'searching', 'discovered', 'enriching', 'ready', 'imported', 'failed']).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
        }).parse(req.query)
        if (!await requireOutreachRead(req, res, query.organizationId)) return
        const where = query.status
            ? and(eq(prospectingRuns.organizationId, query.organizationId), eq(prospectingRuns.status, query.status))
            : eq(prospectingRuns.organizationId, query.organizationId)
        const runs = await db.query.prospectingRuns.findMany({
            where,
            orderBy: [desc(prospectingRuns.createdAt)],
            limit: query.limit,
        })
        res.json({ runs })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Error listing prospecting runs:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

router.get('/runs/:id/candidates', async (req, res) => {
    try {
        const query = z.object({ organizationId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(100).default(100) }).parse(req.query)
        if (!await requireOutreachRead(req, res, query.organizationId)) return
        const run = await db.query.prospectingRuns.findFirst({
            where: and(eq(prospectingRuns.id, req.params.id), eq(prospectingRuns.organizationId, query.organizationId)),
            columns: { id: true },
        })
        if (!run) return res.status(404).json({ error: 'Prospecting run not found' })
        const candidates = await db.query.prospectCandidates.findMany({
            where: and(eq(prospectCandidates.organizationId, query.organizationId), eq(prospectCandidates.runId, run.id)),
            orderBy: [desc(prospectCandidates.score), desc(prospectCandidates.createdAt)],
            limit: query.limit,
        })
        const candidateIds = candidates.map((candidate) => candidate.id)
        const assessments = candidateIds.length === 0 ? [] : await db.query.prospectAiAssessments.findMany({
            where: and(
                eq(prospectAiAssessments.organizationId, query.organizationId),
                inArray(prospectAiAssessments.candidateId, candidateIds),
            ),
            orderBy: [desc(prospectAiAssessments.createdAt)],
        })
        res.json({ candidates, assessments })
    } catch (error) {
        if (error instanceof z.ZodError) return res.status(400).json({ error: 'Validation error', details: error.errors })
        console.error('Error listing prospect candidates:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
