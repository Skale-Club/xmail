import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../../db'
import { outreachSettings } from '../../../db/schema'
import { requireOutreachRead, requireOutreachWrite } from '../../lib/outreach-access'
import {
    OUTREACH_SETTINGS_DEFAULTS,
    resolveOutreachSettings,
    toApiOutreachSettings,
} from '../../lib/outreach-settings'

const router = Router()

// The API accepts and returns exactly the settings that are actually consumed somewhere.
// `weekly_report` is deliberately absent: there is no weekly-report transport, so the control
// was removed from both the API and the UI rather than left decorative (Phase 20 CONS-03).
// The `notifications.*` flags are the resolved policy read by the reply/bounce/unsubscribe
// event paths — see src/server/lib/outreach-settings.ts.
const updateSettingsSchema = z.object({
    general: z.object({
        defaultTimezone: z.string().optional(),
        defaultSendStartTime: z.string().regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
        defaultSendEndTime: z.string().regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).optional(),
        sendOnWeekends: z.boolean().optional(),
        trackOpens: z.boolean().optional(),
        trackClicks: z.boolean().optional(),
    }).optional(),
    sending: z.object({
        defaultDailyLimit: z.number().int().min(1).max(10000).optional(),
        defaultMinMinutesBetweenEmails: z.number().int().min(0).max(1440).optional(),
        warmupEnabled: z.boolean().optional(),
        warmupDays: z.number().int().min(1).max(365).optional(),
    }).optional(),
    notifications: z.object({
        notifyOnReply: z.boolean().optional(),
        notifyOnBounce: z.boolean().optional(),
        notifyOnUnsubscribe: z.boolean().optional(),
    }).optional(),
    deliverability: z.object({
        guardEnabled: z.boolean().optional(),
        bounceRateLimitPercent: z.number().int().min(1).max(100).optional(),
        bounceRateMinSample: z.number().int().min(10).max(10_000).optional(),
        unsubscribeRateLimitPercent: z.number().int().min(1).max(100).optional(),
        unsubscribeRateMinSample: z.number().int().min(10).max(10_000).optional(),
    }).optional(),
})

// GET /api/outreach/settings?organizationId=
router.get('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'organizationId is required' })
        }

        const membership = await requireOutreachRead(req, res, organizationId)
        if (!membership) return

        const resolved = await resolveOutreachSettings(organizationId)
        return res.json(toApiOutreachSettings(resolved))
    } catch (error) {
        console.error('Error fetching outreach settings:', error)
        return res.status(500).json({ error: 'Internal server error' })
    }
})

// PATCH /api/outreach/settings?organizationId=
router.patch('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.query.organizationId as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!organizationId) {
            return res.status(400).json({ error: 'organizationId is required' })
        }

        const membership = await requireOutreachWrite(req, res, organizationId)
        if (!membership) return

        const validatedData = updateSettingsSchema.parse(req.body)

        // Flatten the nested body into DB column names. Only explicitly-provided fields are set,
        // so a partial PATCH never clobbers an untouched column back to its default.
        const updateValues: Record<string, unknown> = { updatedAt: new Date() }

        if (validatedData.general) {
            const g = validatedData.general
            if (g.defaultTimezone !== undefined) updateValues.defaultTimezone = g.defaultTimezone
            if (g.defaultSendStartTime !== undefined) updateValues.defaultSendStartTime = g.defaultSendStartTime
            if (g.defaultSendEndTime !== undefined) updateValues.defaultSendEndTime = g.defaultSendEndTime
            if (g.sendOnWeekends !== undefined) updateValues.sendOnWeekends = g.sendOnWeekends
            if (g.trackOpens !== undefined) updateValues.trackOpens = g.trackOpens
            if (g.trackClicks !== undefined) updateValues.trackClicks = g.trackClicks
        }

        if (validatedData.sending) {
            const s = validatedData.sending
            if (s.defaultDailyLimit !== undefined) updateValues.defaultDailyLimit = s.defaultDailyLimit
            if (s.defaultMinMinutesBetweenEmails !== undefined) updateValues.defaultMinMinutesBetweenEmails = s.defaultMinMinutesBetweenEmails
            if (s.warmupEnabled !== undefined) updateValues.warmupEnabled = s.warmupEnabled
            if (s.warmupDays !== undefined) updateValues.warmupDays = s.warmupDays
        }

        if (validatedData.notifications) {
            const n = validatedData.notifications
            if (n.notifyOnReply !== undefined) updateValues.notifyOnReply = n.notifyOnReply
            if (n.notifyOnBounce !== undefined) updateValues.notifyOnBounce = n.notifyOnBounce
            if (n.notifyOnUnsubscribe !== undefined) updateValues.notifyOnUnsubscribe = n.notifyOnUnsubscribe
        }

        if (validatedData.deliverability) {
            const d = validatedData.deliverability
            if (d.guardEnabled !== undefined) updateValues.deliverabilityGuardEnabled = d.guardEnabled
            if (d.bounceRateLimitPercent !== undefined) updateValues.bounceRateLimitPercent = d.bounceRateLimitPercent
            if (d.bounceRateMinSample !== undefined) updateValues.bounceRateMinSample = d.bounceRateMinSample
            if (d.unsubscribeRateLimitPercent !== undefined) updateValues.unsubscribeRateLimitPercent = d.unsubscribeRateLimitPercent
            if (d.unsubscribeRateMinSample !== undefined) updateValues.unsubscribeRateMinSample = d.unsubscribeRateMinSample
        }

        // UPSERT: insert defaults + overrides on first save, or update the existing row.
        await db
            .insert(outreachSettings)
            .values({
                organizationId,
                ...OUTREACH_SETTINGS_DEFAULTS,
                ...updateValues,
            })
            .onConflictDoUpdate({
                target: outreachSettings.organizationId,
                set: updateValues,
            })

        const resolved = await resolveOutreachSettings(organizationId)
        return res.json(toApiOutreachSettings(resolved))
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error updating outreach settings:', error)
        return res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
