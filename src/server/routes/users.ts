import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../db'
import { users, organizationUsers, organizations } from '../../db/schema'
import { eq, and } from 'drizzle-orm'
import { isPlatformAdmin } from '../lib/admin'
import { hashPassword, createUserMailbox, validateEmailDomainForOrg, deleteUserMailbox } from '../lib/native-mail'
import { supabaseAdminClient, supabaseAnonClient } from '../lib/supabase'
import { ensureLocalUser, getAuthenticatedUserFromRequest } from '../lib/user-sync'

const router = Router()

function mapAdminUser(user: {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    isAdmin: boolean
    emailVerified: boolean
    createdAt: Date
    lastLoginAt: Date | null
    organizations?: Array<{
        role: 'admin' | 'member' | 'viewer'
        organization: {
            id: string
            name: string
            slug: string
        }
    }>
}) {
    return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        isAdmin: user.isAdmin,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        organizations: (user.organizations || []).map((membership) => ({
            id: membership.organization.id,
            name: membership.organization.name,
            slug: membership.organization.slug,
            role: membership.role,
        })),
    }
}

async function getAdminUserRecord(userId: string) {
    const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: {
            passwordHash: false,
            twoFactorSecret: false,
        },
        with: {
            organizations: {
                columns: {
                    role: true,
                },
                with: {
                    organization: {
                        columns: {
                            id: true,
                            name: true,
                            slug: true,
                        },
                    },
                },
            },
        },
    })

    return user ? mapAdminUser(user) : null
}

// Get current user profile
router.get('/profile', async (req: Request, res: Response) => {
    try {
        const authUser = getAuthenticatedUserFromRequest(req)

        if (!authUser) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const user = await ensureLocalUser(authUser)

        res.json({
            user: {
                ...user,
                passwordHash: undefined,
                twoFactorSecret: undefined,
            },
        })
    } catch (error) {
        console.error('Error fetching user:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Update current user profile
router.patch('/profile', async (req: Request, res: Response) => {
    try {
        const authUser = getAuthenticatedUserFromRequest(req)

        if (!authUser) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        await ensureLocalUser(authUser)

        const updateSchema = z.object({
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            avatarUrl: z.string().url().optional(),
        })

        const updates = updateSchema.parse(req.body)

        const [updatedUser] = await db
            .update(users)
            .set({
                ...updates,
                updatedAt: new Date(),
            })
            .where(eq(users.id, authUser.id))
            .returning()

        if (!updatedUser) {
            return res.status(404).json({ error: 'User not found' })
        }

        res.json({
            user: {
                ...updatedUser,
                passwordHash: undefined,
                twoFactorSecret: undefined,
            },
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error updating user:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Get user's organizations
router.get('/organizations', async (req: Request, res: Response) => {
    try {
        const authUser = getAuthenticatedUserFromRequest(req)

        if (!authUser) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        await ensureLocalUser(authUser)

        const isAdmin = await isPlatformAdmin(authUser.id)

        if (isAdmin) {
            // Platform admins see all organizations
            const allOrgs = await db.query.organizations.findMany()
            const organizationsList = allOrgs.map((org) => ({
                ...org,
                role: 'admin' as const,
            }))
            return res.json({ organizations: organizationsList })
        }

        const memberships = await db.query.organizationUsers.findMany({
            where: eq(organizationUsers.userId, authUser.id),
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

// Admin: Create new user
router.post('/', async (req: Request, res: Response) => {
    try {
        const requestingUserId = req.headers['x-user-id'] as string

        if (!requestingUserId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        // Check if requesting user is admin
        const requestingUser = await db.query.users.findFirst({
            where: eq(users.id, requestingUserId),
        })

        if (!requestingUser?.isAdmin) {
            return res.status(403).json({ error: 'Forbidden - Admin access required' })
        }

        // Validation schema
        const createUserSchema = z
            .object({
                email: z.string().email('Invalid email address'),
                password: z.string().min(8, 'Password must be at least 8 characters').optional(),
                firstName: z.string().optional(),
                lastName: z.string().optional(),
                isAdmin: z.boolean().default(false),
                sendInvite: z.boolean().default(true), // If true, send password reset email instead of setting password
                organizationId: z.string().uuid().optional(),
                organizationRole: z.enum(['admin', 'member', 'viewer']).default('member'),
            })
            .superRefine((value, ctx) => {
                if (!value.sendInvite && !value.password) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: ['password'],
                        message: 'Password is required when invite sending is disabled',
                    })
                }
            })

        const userData = createUserSchema.parse(req.body)

        if (userData.organizationId) {
            const targetOrganization = await db.query.organizations.findFirst({
                where: eq(organizations.id, userData.organizationId),
                columns: {
                    id: true,
                },
            })

            if (!targetOrganization) {
                return res.status(404).json({ error: 'Organization not found' })
            }

            // Non-admin users must have email matching a verified domain in the org
            if (!userData.isAdmin) {
                const domainValid = await validateEmailDomainForOrg(userData.email, userData.organizationId)
                if (!domainValid) {
                    return res.status(400).json({
                        error: 'User email domain must match a verified domain of the organization. Verify the domain first, then create the user.',
                    })
                }
            }
        }

        // Check if user already exists
        const existingUser = await db.query.users.findFirst({
            where: eq(users.email, userData.email),
        })

        if (existingUser) {
            return res.status(400).json({ error: 'User with this email already exists' })
        }

        // Create the Supabase Auth user. For the invite flow, inviteUserByEmail both
        // creates the auth user AND sends the invitation email in one call — using
        // createUser() followed by a separate send would either leave the invite
        // unsent (the old bug) or fail with "user already registered" if we tried to
        // invite an email that createUser() had already provisioned.
        const authResult = userData.sendInvite
            ? await supabaseAdminClient.auth.admin.inviteUserByEmail(userData.email, {
                redirectTo: `${process.env.FRONTEND_URL}/reset-password`,
                data: {
                    firstName: userData.firstName,
                    lastName: userData.lastName,
                },
            })
            : await supabaseAdminClient.auth.admin.createUser({
                email: userData.email,
                password: userData.password,
                email_confirm: true,
                user_metadata: {
                    firstName: userData.firstName,
                    lastName: userData.lastName,
                },
            })

        const { data: authData, error: authError } = authResult

        if (authError) {
            console.error('Supabase auth error:', authError)
            return res.status(400).json({ error: authError.message })
        }

        if (!authData.user) {
            return res.status(500).json({ error: 'Failed to create user' })
        }

        // Hash password for SMTP/IMAP auth (non-admin users with immediate password)
        let passwordHash: string | null = null
        if (!userData.isAdmin && userData.password && !userData.sendInvite) {
            passwordHash = await hashPassword(userData.password)
        }

        // Create user profile in database
        const [newUser] = await db.insert(users).values({
            id: authData.user.id,
            email: userData.email,
            firstName: userData.firstName || null,
            lastName: userData.lastName || null,
            isAdmin: userData.isAdmin,
            emailVerified: true,
            passwordHash,
        }).returning()

        if (userData.organizationId) {
            await db.insert(organizationUsers).values({
                organizationId: userData.organizationId,
                userId: newUser.id,
                role: userData.organizationRole,
            })
        }

        // Auto-create native mailbox for non-admin users with a password
        if (!userData.isAdmin && passwordHash) {
            await createUserMailbox(newUser.id, userData.email)
        }

        const createdUser = await getAdminUserRecord(newUser.id)

        res.status(201).json({
            message: userData.sendInvite
                ? 'User created successfully. Invitation email sent.'
                : 'User created successfully',
            inviteSent: userData.sendInvite,
            user: createdUser,
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error creating user:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Admin: List all users
router.get('/', async (req: Request, res: Response) => {
    try {
        const requestingUserId = req.headers['x-user-id'] as string

        if (!requestingUserId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        // Check if requesting user is admin
        const requestingUser = await db.query.users.findFirst({
            where: eq(users.id, requestingUserId),
        })

        if (!requestingUser?.isAdmin) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        const allUsers = await db.query.users.findMany({
            columns: {
                passwordHash: false,
                twoFactorSecret: false,
            },
            with: {
                organizations: {
                    columns: {
                        role: true,
                    },
                    with: {
                        organization: {
                            columns: {
                                id: true,
                                name: true,
                                slug: true,
                            },
                        },
                    },
                },
            },
            orderBy: (usersTable, { desc }) => [desc(usersTable.createdAt)],
        })

        res.json({ users: allUsers.map(mapAdminUser) })
    } catch (error) {
        console.error('Error fetching users:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Admin: Update user
router.patch('/:id', async (req: Request, res: Response) => {
    try {
        const requestingUserId = req.headers['x-user-id'] as string
        const targetUserId = req.params.id

        if (!requestingUserId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        // Check if requesting user is admin
        const requestingUser = await db.query.users.findFirst({
            where: eq(users.id, requestingUserId),
        })

        if (!requestingUser?.isAdmin) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        // Validation schema
        const updateUserSchema = z.object({
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            isAdmin: z.boolean().optional(),
            emailVerified: z.boolean().optional(),
        })

        const updates = updateUserSchema.parse(req.body)

        const [updatedUser] = await db
            .update(users)
            .set({
                ...updates,
                updatedAt: new Date(),
            })
            .where(eq(users.id, targetUserId))
            .returning()

        if (!updatedUser) {
            return res.status(404).json({ error: 'User not found' })
        }

        const fullUser = await getAdminUserRecord(updatedUser.id)

        res.json({ user: fullUser })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error updating user:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Admin: Resend invitation
router.post('/:id/resend-invite', async (req: Request, res: Response) => {
    try {
        const requestingUserId = req.headers['x-user-id'] as string
        const targetUserId = req.params.id

        if (!requestingUserId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        // Check if requesting user is admin
        const requestingUser = await db.query.users.findFirst({
            where: eq(users.id, requestingUserId),
        })

        if (!requestingUser?.isAdmin) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        // Get target user
        const targetUser = await db.query.users.findFirst({
            where: eq(users.id, targetUserId),
        })

        if (!targetUser) {
            return res.status(404).json({ error: 'User not found' })
        }

        // Send password reset email as invitation (the target user already has a
        // Supabase Auth account, so this resends/re-triggers access rather than
        // creating a new one — same mechanism as the self-service reset in auth.ts).
        const { error } = await supabaseAnonClient.auth.resetPasswordForEmail(targetUser.email, {
            redirectTo: `${process.env.FRONTEND_URL}/reset-password`,
        })

        if (error) {
            console.error('Error sending invite:', error)
            return res.status(400).json({ error: error.message })
        }

        res.json({ message: 'Invitation email sent successfully', inviteSent: true })
    } catch (error) {
        console.error('Error resending invite:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Admin: Update user password
router.put('/:id/password', async (req: Request, res: Response) => {
    try {
        const requestingUserId = req.headers['x-user-id'] as string
        const targetUserId = req.params.id

        if (!requestingUserId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        // Allow platform admins OR org admins who share an org with the target user
        const isPlatAdmin = await isPlatformAdmin(requestingUserId)
        if (!isPlatAdmin) {
            const sharedOrg = await db.query.organizationUsers.findFirst({
                where: and(
                    eq(organizationUsers.userId, requestingUserId),
                    eq(organizationUsers.role, 'admin')
                ),
            })
            if (!sharedOrg) {
                return res.status(403).json({ error: 'Forbidden' })
            }
            // Verify target user is in same org
            const targetInOrg = await db.query.organizationUsers.findFirst({
                where: and(
                    eq(organizationUsers.userId, targetUserId),
                    eq(organizationUsers.organizationId, sharedOrg.organizationId)
                ),
            })
            if (!targetInOrg) {
                return res.status(403).json({ error: 'Forbidden' })
            }
        }

        const { password } = z.object({
            password: z.string().min(6, 'Password must be at least 6 characters'),
        }).parse(req.body)

        const { error } = await supabaseAdminClient.auth.admin.updateUserById(targetUserId, { password })

        if (error) {
            return res.status(400).json({ error: error.message })
        }

        // Sync passwordHash for SMTP/IMAP auth
        const targetUser = await db.query.users.findFirst({ where: eq(users.id, targetUserId) })
        if (targetUser && !targetUser.isAdmin) {
            const newHash = await hashPassword(password)
            await db.update(users)
                .set({ passwordHash: newHash, updatedAt: new Date() })
                .where(eq(users.id, targetUserId))

            // Create mailbox if it doesn't exist yet (e.g. first password set after invite)
            await createUserMailbox(targetUserId, targetUser.email)
        }

        res.json({ message: 'Password updated successfully' })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error updating password:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Admin: Delete user
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const requestingUserId = req.headers['x-user-id'] as string
        const targetUserId = req.params.id

        if (!requestingUserId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        // Check if requesting user is admin
        const requestingUser = await db.query.users.findFirst({
            where: eq(users.id, requestingUserId),
        })

        if (!requestingUser?.isAdmin) {
            return res.status(403).json({ error: 'Forbidden' })
        }

        // Prevent self-deletion
        if (requestingUserId === targetUserId) {
            return res.status(400).json({ error: 'Cannot delete yourself' })
        }

        // Delete from Supabase Auth
        const { error: authError } = await supabaseAdminClient.auth.admin.deleteUser(targetUserId)
        if (authError) {
            console.error('Error deleting user from auth:', authError)
        }

        // Delete native mailbox and messages
        await deleteUserMailbox(targetUserId)

        // Delete from database
        await db.delete(users).where(eq(users.id, targetUserId))

        res.json({ message: 'User deleted successfully' })
    } catch (error) {
        console.error('Error deleting user:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Self-service: change own password (syncs Supabase Auth + users.passwordHash)
router.post('/me/change-password', async (req: Request, res: Response) => {
    try {
        const authUser = getAuthenticatedUserFromRequest(req)
        if (!authUser) return res.status(401).json({ error: 'Unauthorized' })

        await ensureLocalUser(authUser)

        const { currentPassword, newPassword } = z.object({
            currentPassword: z.string(),
            newPassword: z.string().min(8, 'Password must be at least 8 characters'),
        }).parse(req.body)

        const user = await db.query.users.findFirst({ where: eq(users.id, authUser.id) })
        if (!user) return res.status(404).json({ error: 'User not found' })
        if (user.isAdmin) return res.status(403).json({ error: 'Platform admins cannot use this endpoint' })
        if (!user.passwordHash) return res.status(400).json({ error: 'No password set on this account' })

        const bcrypt = await import('bcrypt')
        const valid = await bcrypt.default.compare(currentPassword, user.passwordHash)
        if (!valid) return res.status(400).json({ error: 'Current password is incorrect' })

        const { error } = await supabaseAdminClient.auth.admin.updateUserById(authUser.id, { password: newPassword })
        if (error) return res.status(400).json({ error: error.message })

        const newHash = await hashPassword(newPassword)
        await db.update(users)
            .set({ passwordHash: newHash, updatedAt: new Date() })
            .where(eq(users.id, authUser.id))

        res.json({ message: 'Password changed successfully' })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: error.errors })
        }
        console.error('Error changing password:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
