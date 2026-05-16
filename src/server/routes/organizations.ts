import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../db'
import { organizations, organizationUsers, users, messages, statistics } from '../../db/schema'
import { eq, and, isNotNull, sql, gte, desc } from 'drizzle-orm'
import { deleteOrganizationCascade } from '../lib/cascade'
import { isPlatformAdmin } from '../lib/admin'
import { validateEmailDomainForOrg, createUserMailbox, deleteUserMailbox, hashPassword } from '../lib/native-mail'
import { supabaseAdminClient } from '../lib/supabase'

const router = Router()
const createOrganizationSchema = z.object({
    name: z.string().min(1, 'Name is required').max(100),
    slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
    timezone: z.string().optional(),
})

const updateOrganizationSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    timezone: z.string().optional(),
})

const addMemberSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(8).optional(),
    role: z.enum(['admin', 'member', 'viewer']).default('member'),
})

// List organizations for current user
router.get('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (await isPlatformAdmin(userId)) {
            const allOrgs = await db.query.organizations.findMany()
            return res.json({ organizations: allOrgs })
        }

        const memberships = await db.query.organizationUsers.findMany({
            where: eq(organizationUsers.userId, userId),
            with: {
                organization: true,
            },
        })

        const organizationsList = memberships.map((m) => ({
            ...m.organization,
            role: m.role,
        }))

        res.json({ organizations: organizationsList })
    } catch (error) {
        console.error('Error fetching organizations:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Get organization by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const isAdmin = await isPlatformAdmin(userId)

        if (!isAdmin) {
            const membership = await db.query.organizationUsers.findFirst({
                where: and(
                    eq(organizationUsers.organizationId, organizationId),
                    eq(organizationUsers.userId, userId)
                ),
            })
            if (!membership) {
                return res.status(404).json({ error: 'Organization not found' })
            }
        }

        const organization = await db.query.organizations.findFirst({
            where: eq(organizations.id, organizationId),
            with: {
                owner: true,
                members: {
                    with: {
                        user: {
                            columns: {
                                passwordHash: false,
                                twoFactorSecret: false,
                            },
                        },
                    },
                },
            },
        })

        const membership = isAdmin
            ? null
            : await db.query.organizationUsers.findFirst({
                where: and(
                    eq(organizationUsers.organizationId, organizationId),
                    eq(organizationUsers.userId, userId)
                ),
            })

        res.json({ organization, role: isAdmin ? 'admin' : membership?.role })
    } catch (error) {
        console.error('Error fetching organization:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Create organization
router.post('/', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const { name, slug, timezone } = createOrganizationSchema.parse(req.body)

        const existingOrg = await db.query.organizations.findFirst({
            where: eq(organizations.slug, slug),
        })

        if (existingOrg) {
            return res.status(400).json({ error: 'Organization slug already exists' })
        }

        const isAdmin = await isPlatformAdmin(userId)

        const [organization] = await db.insert(organizations).values({
            name,
            slug,
            timezone: timezone || 'UTC',
            ownerId: userId,
        }).returning()

        // Platform admins are not added as members — they manage orgs externally.
        // Regular users become admin members of the orgs they create.
        if (!isAdmin) {
            await db.insert(organizationUsers).values({
                organizationId: organization.id,
                userId,
                role: 'admin',
            })
        }

        res.status(201).json({ organization })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error creating organization:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Update organization
router.patch('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!await isPlatformAdmin(userId)) {
            const membership = await db.query.organizationUsers.findFirst({
                where: and(
                    eq(organizationUsers.organizationId, organizationId),
                    eq(organizationUsers.userId, userId)
                ),
            })
            if (!membership || membership.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden' })
            }
        }

        const updates = updateOrganizationSchema.parse(req.body)

        const [updatedOrg] = await db
            .update(organizations)
            .set({ ...updates, updatedAt: new Date() })
            .where(eq(organizations.id, organizationId))
            .returning()

        res.json({ organization: updatedOrg })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error updating organization:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Delete organization
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const organization = await db.query.organizations.findFirst({
            where: eq(organizations.id, organizationId),
        })

        if (!organization) {
            return res.status(404).json({ error: 'Organization not found' })
        }

        const isAdmin = await isPlatformAdmin(userId)
        if (!isAdmin && organization.ownerId !== userId) {
            return res.status(403).json({ error: 'Only the owner can delete the organization' })
        }

        await deleteOrganizationCascade(organizationId)

        res.json({ message: 'Organization deleted successfully' })
    } catch (error) {
        console.error('Error deleting organization:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Add member to organization
router.post('/:id/members', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!await isPlatformAdmin(userId)) {
            const membership = await db.query.organizationUsers.findFirst({
                where: and(
                    eq(organizationUsers.organizationId, organizationId),
                    eq(organizationUsers.userId, userId)
                ),
            })
            if (!membership || membership.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden' })
            }
        }

        const { email, password, role } = addMemberSchema.parse(req.body)

        // Domain must match a verified domain in the organization
        const domainValid = await validateEmailDomainForOrg(email, organizationId)
        if (!domainValid) {
            return res.status(400).json({
                error: 'Email domain does not match any verified domain of this organization.',
            })
        }

        let userToAdd = await db.query.users.findFirst({
            where: eq(users.email, email),
        })

        // Auto-create user if they don't exist and a password was provided
        if (!userToAdd) {
            if (!password) {
                return res.status(400).json({ error: 'Password is required to create a new user' })
            }

            // Create in Supabase Auth
            const { data: authData, error: authError } = await supabaseAdminClient.auth.admin.createUser({
                email,
                password,
                email_confirm: true,
            })

            if (authError || !authData.user) {
                return res.status(400).json({ error: authError?.message || 'Failed to create user' })
            }

            const passwordHash = await hashPassword(password)

            const [newUser] = await db.insert(users).values({
                id: authData.user.id,
                email,
                isAdmin: false,
                emailVerified: true,
                passwordHash,
            }).returning()

            userToAdd = newUser
        } else if (password) {
            // User exists but password was provided — update their passwordHash
            const passwordHash = await hashPassword(password)
            await db.update(users)
                .set({ passwordHash, updatedAt: new Date() })
                .where(eq(users.id, userToAdd.id))
            await supabaseAdminClient.auth.admin.updateUserById(userToAdd.id, { password })
        }

        const existingMembership = await db.query.organizationUsers.findFirst({
            where: and(
                eq(organizationUsers.organizationId, organizationId),
                eq(organizationUsers.userId, userToAdd.id)
            ),
        })

        if (existingMembership) {
            return res.status(400).json({ error: 'User is already a member' })
        }

        const [newMembership] = await db.insert(organizationUsers).values({
            organizationId,
            userId: userToAdd.id,
            role,
        }).returning()

        // Auto-create native mailbox (only if user has a password set)
        if (!userToAdd.isAdmin && userToAdd.passwordHash) {
            await createUserMailbox(userToAdd.id, userToAdd.email)
        }

        res.status(201).json({ membership: newMembership })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error adding member:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Remove member from organization
router.delete('/:id/members/:userId', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.params.id
        const targetUserId = req.params.userId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        if (!await isPlatformAdmin(userId)) {
            const membership = await db.query.organizationUsers.findFirst({
                where: and(
                    eq(organizationUsers.organizationId, organizationId),
                    eq(organizationUsers.userId, userId)
                ),
            })
            if (!membership || membership.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden' })
            }
        }

        const organization = await db.query.organizations.findFirst({
            where: eq(organizations.id, organizationId),
        })

        if (organization?.ownerId === targetUserId) {
            return res.status(400).json({ error: 'Cannot remove the owner' })
        }

        await db.delete(organizationUsers).where(
            and(
                eq(organizationUsers.organizationId, organizationId),
                eq(organizationUsers.userId, targetUserId)
            )
        )

        // Remove native mailbox and revoke SMTP/IMAP access
        await deleteUserMailbox(targetUserId)
        await db.update(users)
            .set({ passwordHash: null, updatedAt: new Date() })
            .where(eq(users.id, targetUserId))

        res.json({ message: 'Member removed successfully' })
    } catch (error) {
        console.error('Error removing member:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Update member role
router.patch('/:id/members/:userId', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.params.id
        const targetUserId = req.params.userId

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const { role } = z.object({
            role: z.enum(['admin', 'member', 'viewer']),
        }).parse(req.body)

        if (!await isPlatformAdmin(userId)) {
            const membership = await db.query.organizationUsers.findFirst({
                where: and(
                    eq(organizationUsers.organizationId, organizationId),
                    eq(organizationUsers.userId, userId)
                ),
            })
            if (!membership || membership.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden' })
            }
        }

        const organization = await db.query.organizations.findFirst({
            where: eq(organizations.id, organizationId),
        })

        if (organization?.ownerId === targetUserId) {
            return res.status(400).json({ error: "Cannot change the owner's role" })
        }

        const [updatedMembership] = await db
            .update(organizationUsers)
            .set({ role })
            .where(
                and(
                    eq(organizationUsers.organizationId, organizationId),
                    eq(organizationUsers.userId, targetUserId)
                )
            )
            .returning()

        res.json({ membership: updatedMembership })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error updating member role:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Get organization statistics
router.get('/:id/statistics', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const organizationId = req.params.id
        const days = parseInt(req.query.days as string) || 30

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const isAdmin = await isPlatformAdmin(userId)

        if (!isAdmin) {
            const membership = await db.query.organizationUsers.findFirst({
                where: and(
                    eq(organizationUsers.organizationId, organizationId),
                    eq(organizationUsers.userId, userId)
                ),
            })
            if (!membership) {
                return res.status(404).json({ error: 'Organization not found' })
            }
        }

        const organization = await db.query.organizations.findFirst({
            where: eq(organizations.id, organizationId),
        })

        if (!organization) {
            return res.status(404).json({ error: 'Organization not found' })
        }

        const since = new Date()
        since.setDate(since.getDate() - days)

        // Counts grouped by status
        const statusCounts = await db
            .select({
                status: messages.status,
                count: sql<number>`count(*)`,
            })
            .from(messages)
            .where(eq(messages.organizationId, organizationId))
            .groupBy(messages.status)

        const countMap: Record<string, number> = {}
        for (const row of statusCounts) {
            countMap[row.status] = Number(row.count)
        }

        const sent = (countMap['sent'] || 0) + (countMap['delivered'] || 0)
        const delivered = countMap['delivered'] || 0
        const bounced = countMap['bounced'] || 0
        const held = countMap['held'] || 0
        const pending = (countMap['pending'] || 0) + (countMap['queued'] || 0)

        // Opened count from messages
        const [openedRow] = await db
            .select({ count: sql<number>`count(*)` })
            .from(messages)
            .where(and(eq(messages.organizationId, organizationId), isNotNull(messages.openedAt)))

        const opened = Number(openedRow?.count || 0)

        // Total clicks from statistics table
        const [clickRow] = await db
            .select({ total: sql<number>`coalesce(sum(links_clicked), 0)` })
            .from(statistics)
            .where(eq(statistics.organizationId, organizationId))

        const clicked = Number(clickRow?.total || 0)

        const total = sent + (countMap['failed'] || 0) + pending + held + bounced

        // Daily stats for the last N days
        const daily = await db
            .select({
                date: statistics.date,
                sent: statistics.messagesSent,
                delivered: statistics.messagesDelivered,
                opened: statistics.messagesOpened,
                clicked: statistics.linksClicked,
                bounced: statistics.messagesBounced,
                held: statistics.messagesHeld,
            })
            .from(statistics)
            .where(and(eq(statistics.organizationId, organizationId), gte(statistics.date, since)))
            .orderBy(statistics.date)

        // Aggregate daily stats by date
        const dailyMap = new Map<string, { sent: number; delivered: number; opened: number; clicked: number; bounced: number; held: number }>()
        for (const row of daily) {
            const dateKey = row.date.toISOString().split('T')[0]
            const existing = dailyMap.get(dateKey) || { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, held: 0 }
            dailyMap.set(dateKey, {
                sent: existing.sent + (row.sent || 0),
                delivered: existing.delivered + (row.delivered || 0),
                opened: existing.opened + (row.opened || 0),
                clicked: existing.clicked + (row.clicked || 0),
                bounced: existing.bounced + (row.bounced || 0),
                held: existing.held + (row.held || 0),
            })
        }

        const aggregatedDaily = Array.from(dailyMap.entries()).map(([date, data]) => ({
            date,
            ...data,
        })).sort((a, b) => a.date.localeCompare(b.date))

        // Recent messages
        const recentMessages = await db.query.messages.findMany({
            where: eq(messages.organizationId, organizationId),
            orderBy: [desc(messages.createdAt)],
            limit: 20,
            columns: {
                id: true,
                subject: true,
                fromAddress: true,
                toAddresses: true,
                status: true,
                direction: true,
                openedAt: true,
                sentAt: true,
                deliveredAt: true,
                createdAt: true,
            },
        })

        res.json({
            summary: { total, sent, delivered, bounced, held, pending, opened, clicked },
            rates: {
                deliveryRate: sent > 0 ? Math.round((delivered / sent) * 1000) / 10 : 0,
                openRate:     sent > 0 ? Math.round((opened   / sent) * 1000) / 10 : 0,
                clickRate:    sent > 0 ? Math.round((clicked  / sent) * 1000) / 10 : 0,
                bounceRate:   sent > 0 ? Math.round((bounced  / sent) * 1000) / 10 : 0,
            },
            daily: aggregatedDaily,
            recentMessages,
        })
    } catch (error) {
        console.error('Error fetching statistics:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
