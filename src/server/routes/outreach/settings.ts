import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../../db'
import { outreachSettings, organizationUsers } from '../../../db/schema'
import { eq, and } from 'drizzle-orm'
import { isPlatformAdmin } from '../../lib/admin'

const router = Router()

// Helper to check org membership (platform admins bypass membership check)
async function checkOrgMembership(userId: string, organizationId: string) {
    const admin = await isPlatformAdmin(userId)
    if (admin) return { role: 'admin' as const }

    const membership = await db.query.organizationUsers.findFirst({
        where: and(
            eq(organizationUsers.organizationId, organizationId),
            eq(organizationUsers.userId, userId)
        ),
    })
    return membership
}

// Default values used when no settings row exists yet
const DEFAULTS = {
    defaultTimezone: 'UTC',
    defaultSendStartTime: '09:00',
    defaultSendEndTime: '17:00',
    sendOnWeekends: false,
    trackOpens: true,
    trackClicks: true,
    defaultDailyLimit: 50,
    defaultMinMinutesBetweenEmails: 5,
    warmupEnabled: true,
    warmupDays: 21,
    notifyOnReply: true,
    notifyOnBounce: true,
    notifyOnUnsubscribe: false,
    weeklyReport: true,
}

function formatSettings(row: typeof DEFAULTS & { organizationId?: string; id?: string; createdAt?: Date; updatedAt?: Date }) {
    return {
        general: {
            defaultTimezone: row.defaultTimezone,
            defaultSendStartTime: row.defaultSendStartTime,
            defaultSendEndTime: row.defaultSendEndTime,
            sendOnWeekends: row.sendOnWeekends,
            trackOpens: row.trackOpens,
            trackClicks: row.trackClicks,
        },
        sending: {
            defaultDailyLimit: row.defaultDailyLimit,
            defaultMinMinutesBetweenEmails: row.defaultMinMinutesBetweenEmails,
            warmupEnabled: row.warmupEnabled,
            warmupDays: row.warmupDays,
        },
        notifications: {
            emailOnReply: row.notifyOnReply,
            emailOnBounce: row.notifyOnBounce,
            emailOnUnsubscribe: row.notifyOnUnsubscribe,
            weeklyReport: row.weeklyReport,
        },
    }
}

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
        emailOnReply: z.boolean().optional(),
        emailOnBounce: z.boolean().optional(),
        emailOnUnsubscribe: z.boolean().optional(),
        weeklyReport: z.boolean().optional(),
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

        const membership = await checkOrgMembership(userId, organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const row = await db.query.outreachSettings.findFirst({
            where: eq(outreachSettings.organizationId, organizationId),
        })

        // Return defaults if no row exists yet — do not create one on read
        const data = row ?? DEFAULTS

        return res.json(formatSettings(data))
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

        const membership = await checkOrgMembership(userId, organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        const validatedData = updateSettingsSchema.parse(req.body)

        // Flatten the nested body into DB column names
        const updateValues: Partial<typeof DEFAULTS> & { updatedAt: Date } = {
            updatedAt: new Date(),
        }

        if (validatedData.general) {
            if (validatedData.general.defaultTimezone !== undefined) updateValues.defaultTimezone = validatedData.general.defaultTimezone
            if (validatedData.general.defaultSendStartTime !== undefined) updateValues.defaultSendStartTime = validatedData.general.defaultSendStartTime
            if (validatedData.general.defaultSendEndTime !== undefined) updateValues.defaultSendEndTime = validatedData.general.defaultSendEndTime
            if (validatedData.general.sendOnWeekends !== undefined) updateValues.sendOnWeekends = validatedData.general.sendOnWeekends
            if (validatedData.general.trackOpens !== undefined) updateValues.trackOpens = validatedData.general.trackOpens
            if (validatedData.general.trackClicks !== undefined) updateValues.trackClicks = validatedData.general.trackClicks
        }

        if (validatedData.sending) {
            if (validatedData.sending.defaultDailyLimit !== undefined) updateValues.defaultDailyLimit = validatedData.sending.defaultDailyLimit
            if (validatedData.sending.defaultMinMinutesBetweenEmails !== undefined) updateValues.defaultMinMinutesBetweenEmails = validatedData.sending.defaultMinMinutesBetweenEmails
            if (validatedData.sending.warmupEnabled !== undefined) updateValues.warmupEnabled = validatedData.sending.warmupEnabled
            if (validatedData.sending.warmupDays !== undefined) updateValues.warmupDays = validatedData.sending.warmupDays
        }

        if (validatedData.notifications) {
            if (validatedData.notifications.emailOnReply !== undefined) updateValues.notifyOnReply = validatedData.notifications.emailOnReply
            if (validatedData.notifications.emailOnBounce !== undefined) updateValues.notifyOnBounce = validatedData.notifications.emailOnBounce
            if (validatedData.notifications.emailOnUnsubscribe !== undefined) updateValues.notifyOnUnsubscribe = validatedData.notifications.emailOnUnsubscribe
            if (validatedData.notifications.weeklyReport !== undefined) updateValues.weeklyReport = validatedData.notifications.weeklyReport
        }

        // UPSERT: insert defaults + overrides on first save, or update existing row
        const [upserted] = await db
            .insert(outreachSettings)
            .values({
                organizationId,
                ...DEFAULTS,
                ...updateValues,
            })
            .onConflictDoUpdate({
                target: outreachSettings.organizationId,
                set: updateValues,
            })
            .returning()

        if (!upserted) {
            return res.status(500).json({ error: 'Upsert failed — no row returned' })
        }

        return res.json(formatSettings(upserted))
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error updating outreach settings:', error)
        return res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
