import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { db } from '../../../db'
import { emailAccounts, organizationUsers, outlookMailboxes, users } from '../../../db/schema'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { isPlatformAdmin } from '../../lib/admin'
import { encryptSecret, decryptSecret } from '../../lib/crypto'
import { paginate, paginationQuerySchema } from '../../lib/pagination'
import { getEffectiveDailySendLimit } from '../../lib/outreach-sender'
import { listInboxProviders } from '../../lib/inbox-providers'
import { getNativeMailboxByEmail, getNativeMailboxForOrganization } from '../../lib/native-send'
import { isPrivateHostWithDns } from '../../lib/network-guard'
import { buildSmtpTransportOptions, resolveSmtpSecurity } from '../../lib/smtp-security'
import {
    evaluateOutlookOutreachCapability,
    REQUIRED_OUTLOOK_OUTREACH_SCOPES,
    type OutlookCapabilityCode,
} from '../../lib/outlook'
import { createDrizzleInboundEventStore } from '../../lib/outreach-inbound'
import { syncOutlookInboundOnce } from '../../lib/outreach-inbound-sources'
import { createLogger } from '../../lib/logger'

const log = createLogger('outreach.email-accounts')

/**
 * Operator-facing text for a sanitized capability code. The code is what gets stored; this
 * only ever reaches the HTTP response, so it can explain the fix without leaking Graph
 * internals.
 */
function describeOutlookCapability(code: OutlookCapabilityCode, missingScopes?: string[]): string {
    switch (code) {
        case 'outlook_mailbox_unlinked':
            return 'This Outlook account is not linked to a connected mailbox. Reconnect it through the Outlook OAuth flow.'
        case 'outlook_mailbox_unreachable':
            return 'The linked Outlook mailbox no longer exists in this organization.'
        case 'outlook_mailbox_address_mismatch':
            return 'The linked Outlook mailbox belongs to a different address; Graph only permits sending as the mailbox owner.'
        case 'outlook_mailbox_inactive':
            return 'The Outlook grant is expired or revoked. Reconnect the mailbox.'
        case 'outlook_missing_scopes':
            return `Outreach needs ${REQUIRED_OUTLOOK_OUTREACH_SCOPES.join(', ')}. Missing: ${(missingScopes ?? []).join(', ')}. Reconnect and accept every permission.`
        case 'outlook_auth_failed':
            return 'Microsoft rejected the mailbox credentials. Reconnect the mailbox.'
        case 'outlook_inbound_sync_failed':
            return 'The initial inbox sync did not complete (Microsoft was unavailable or throttling). The account stays pending — retry verification shortly.'
    }
}

/** Stable code so clients can branch on the TLS mismatch rather than parse the message. */
const SMTP_TLS_MODE_MISMATCH = 'smtp_tls_mode_mismatch'

// PROV-01 — reject a port/flag pair that cannot mean what the caller asked for, but only when
// the caller stated a preference. An omitted smtpSecure is derived from the port instead (see
// canonicalSmtpSecure), which is what stops new port-587 inboxes from persisting implicit TLS.
// Legacy rows are NOT re-validated on read: verification and send normalize them instead, so
// this check cannot strand an inbox that was already working.
function checkSmtpSecurityConflict(
    port: number | null | undefined,
    secure: boolean | null | undefined,
): { error: string; code: string; details: Record<string, unknown> } | null {
    if (secure === undefined || secure === null) return null
    const resolution = resolveSmtpSecurity({ port, secure })
    if (!resolution.normalized) return null
    return {
        error: `SMTP port ${resolution.port} cannot use secure=${secure}. Port ${resolution.port} means ${resolution.mode === 'implicit_tls' ? 'implicit TLS (secure=true)' : 'STARTTLS (secure=false)'}.`,
        code: SMTP_TLS_MODE_MISMATCH,
        details: { port: resolution.port, requestedSecure: secure, expectedSecure: resolution.secure, mode: resolution.mode },
    }
}

/** The value actually stored: the caller's when coherent, otherwise derived from the port. */
function canonicalSmtpSecure(port: number | null | undefined, secure: boolean | null | undefined): boolean {
    return resolveSmtpSecurity({ port, secure }).secure
}

// SEC — mail hosts are attacker-controllable free text, and both the verify endpoint and the
// sender open outbound connections to them. Unguarded, that is an SSRF oracle and an internal
// port scanner (cloud metadata, 127.0.0.1, RFC1918) for anyone who can write an inbox.
// Guarded on write as well as at connect time, so a host that passes verification cannot be
// swapped for an internal one afterwards. Hosts are deduped because a bulk import is usually
// many mailboxes behind one or two vendor hosts, and each check costs a DNS round trip.
// Returns an error message, or null when every host is acceptable.
async function rejectPrivateMailHosts(hosts: (string | null | undefined)[]): Promise<string | null> {
    const unique = [...new Set(hosts.filter((h): h is string => !!h && h.trim().length > 0))]
    for (const host of unique) {
        if (await isPrivateHostWithDns(host)) {
            // isPrivateHostWithDns fails closed: it also returns true when DNS is unreachable or
            // times out. Saying "this is a private address" in that case would send whoever hits
            // it hunting for a network misconfiguration that isn't there, so the message covers
            // both causes rather than asserting the one we cannot distinguish.
            return `Mail host "${host}" could not be accepted — it resolves to a private/internal address, or its DNS lookup failed. Check the hostname and retry.`
        }
    }
    return null
}
import nodemailer from 'nodemailer'
import { ImapFlow } from 'imapflow'

const router = Router()

// Validation schemas
//
// provider='native' accounts send through the platform's native mailbox model
// (src/server/lib/native-send.ts) instead of stored SMTP/IMAP credentials — no
// password is ever collected or persisted for these accounts. SMTP fields are
// only required when provider is (or defaults to) 'smtp'; see superRefine below.
// 'outlook' accounts are created via src/server/routes/outlook.ts (OAuth flow),
// not through this route, so it is intentionally excluded from this enum.
const createEmailAccountSchema = z.object({
    // Lowercased to match importMailboxSchema below. The two write paths disagreeing on case is
    // what let one mailbox become two rows, each with its own daily cap — see migration 036.
    email: z.string().email('Invalid email address').transform((v) => v.trim().toLowerCase()),
    displayName: z.string().optional(),
    provider: z.enum(['smtp', 'native']).default('smtp'),
    smtpHost: z.string().min(1).optional(),
    smtpPort: z.number().int().min(1).max(65535).default(587),
    smtpUsername: z.string().min(1).optional(),
    smtpPassword: z.string().min(1).optional(),
    // No default: an omitted flag is derived from the port by canonicalSmtpSecure. Defaulting
    // this to true is what made every 587 inbox claim implicit TLS (PROV-01).
    smtpSecure: z.boolean().optional(),
    imapHost: z.string().optional(),
    imapPort: z.number().int().min(1).max(65535).default(993),
    imapUsername: z.string().optional(),
    imapPassword: z.string().optional(),
    imapSecure: z.boolean().default(true),
    dailySendLimit: z.number().int().min(1).max(10000).default(50),
    minMinutesBetweenEmails: z.number().int().min(1).default(5),
    maxMinutesBetweenEmails: z.number().int().min(1).default(30),
    warmupEnabled: z.boolean().default(true),
    warmupDays: z.number().int().min(1).max(60).default(14),
}).superRefine((data, ctx) => {
    if (data.provider === 'smtp') {
        if (!data.smtpHost) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['smtpHost'], message: 'SMTP host is required' })
        }
        if (!data.smtpUsername) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['smtpUsername'], message: 'SMTP username is required' })
        }
        if (!data.smtpPassword) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['smtpPassword'], message: 'SMTP password is required' })
        }
    }
})

// P006 — bulk import of provider-exported SMTP/IMAP credentials (IceMail, Primeforge, or manual).
const importMailboxSchema = z.object({
    email: z.string().email('Invalid email address').transform((v) => v.trim().toLowerCase()),
    displayName: z.string().optional(),
    smtpHost: z.string().min(1, 'SMTP host is required'),
    smtpPort: z.number().int().min(1).max(65535).default(587),
    smtpUsername: z.string().min(1, 'SMTP username is required'),
    smtpPassword: z.string().min(1, 'SMTP password is required'),
    // As in createEmailAccountSchema: derived from the port when the vendor export omits it.
    smtpSecure: z.boolean().optional(),
    imapHost: z.string().optional(),
    imapPort: z.number().int().min(1).max(65535).default(993),
    imapUsername: z.string().optional(),
    imapPassword: z.string().optional(),
    imapSecure: z.boolean().default(true),
    dailySendLimit: z.number().int().min(1).max(10000).default(50),
    minMinutesBetweenEmails: z.number().int().min(1).default(5),
    maxMinutesBetweenEmails: z.number().int().min(1).default(30),
    warmupEnabled: z.boolean().default(true),
    warmupDays: z.number().int().min(1).max(60).default(14),
    // Vendor-side mailbox reference (for later warmup sync / re-provisioning).
    providerRef: z.string().optional(),
})

const bulkImportEmailAccountsSchema = z.object({
    provider: z.enum(['manual', 'icemail', 'primeforge']).default('manual'),
    mailboxes: z.array(importMailboxSchema).min(1).max(200),
})

const updateEmailAccountSchema = z.object({
    displayName: z.string().optional(),
    smtpHost: z.string().min(1).optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
    smtpUsername: z.string().min(1).optional(),
    smtpPassword: z.string().min(1).optional(),
    smtpSecure: z.boolean().optional(),
    imapHost: z.string().optional(),
    imapPort: z.number().int().min(1).max(65535).optional(),
    imapUsername: z.string().optional(),
    imapPassword: z.string().optional(),
    imapSecure: z.boolean().optional(),
    dailySendLimit: z.number().int().min(1).max(10000).optional(),
    minMinutesBetweenEmails: z.number().int().min(1).optional(),
    maxMinutesBetweenEmails: z.number().int().min(1).optional(),
    warmupEnabled: z.boolean().optional(),
    warmupDays: z.number().int().min(1).max(60).optional(),
    status: z.enum(['pending', 'verified', 'failed', 'paused']).optional(),
})

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

function canWriteOutreach(membership: Awaited<ReturnType<typeof checkOrgMembership>>): boolean {
    return membership?.role === 'admin' || membership?.role === 'member'
}

// NOTE: getDecryptedCredentials helper previously defined here was removed (Phase 12 COR-07 lint
// cleanup); routes inline `decryptSecret` calls. Re-add helper if needed by future routes.

// List email accounts for organization
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

        const { page, limit } = paginationQuerySchema.parse(req.query)

        const result = await paginate(db, emailAccounts, {
            where: eq(emailAccounts.organizationId, organizationId),
            page,
            limit,
            orderBy: desc(emailAccounts.createdAt),
        })

        // Remove sensitive data
        const safeAccounts = result.data.map((account) => ({
            ...account,
            dailyLimit: getEffectiveDailySendLimit(account),
            configuredDailyLimit: account.dailySendLimit,
            sentToday: account.currentDailySent,
            warmupDay: account.warmupCurrentDay,
            warmupProgress: account.warmupEnabled
                ? Math.min(100, Math.round((account.warmupCurrentDay / Math.max(1, account.warmupDays)) * 100))
                : 100,
            smtpPassword: undefined,
            imapPassword: undefined,
        }))

        res.json({ emailAccounts: safeAccounts, pagination: result.pagination })
    } catch (error) {
        console.error('Error fetching email accounts:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// List available inbox providers (P006). Registered before /:id so "providers" is not matched
// as an account id. Static registry — no tenant data — so only auth (x-user-id) is required.
router.get('/providers', async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string
    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' })
    }
    res.json({ providers: listInboxProviders() })
})

// Bulk-import mailbox credentials from an inbox provider (P006).
// Vendors like IceMail and Primeforge export standard SMTP/IMAP credentials in bulk; this endpoint
// ingests them into email_accounts (encrypted, status 'pending'), tagging each row with its
// mailbox_provider. Imported accounts are verified through the existing POST /:id/verify flow —
// inline bulk verification is deliberately NOT done here (N sequential SMTP/IMAP connects would be
// slow and widen the SSRF surface flagged in the audit).
router.post('/bulk-import', async (req: Request, res: Response) => {
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
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const { provider, mailboxes } = bulkImportEmailAccountsSchema.parse(req.body)

        // De-dupe against existing inboxes in this org (unique on org+email).
        const submittedEmails = mailboxes.map((m) => m.email)
        const existing = await db.query.emailAccounts.findMany({
            where: and(
                eq(emailAccounts.organizationId, organizationId),
                inArray(emailAccounts.email, submittedEmails)
            ),
            columns: { email: true },
        })
        const existingEmails = new Set(existing.map((e) => e.email))

        // Also drop in-payload duplicates (keep first occurrence).
        const seen = new Set<string>()
        const toInsert = mailboxes.filter((m) => {
            if (existingEmails.has(m.email) || seen.has(m.email)) return false
            seen.add(m.email)
            return true
        })

        if (toInsert.length === 0) {
            return res.status(200).json({
                imported: 0,
                duplicates: mailboxes.length,
                provider,
                emailAccounts: [],
            })
        }

        // Checked across the whole batch before inserting any of it, so a rejected import
        // leaves nothing behind to clean up.
        const hostError = await rejectPrivateMailHosts(
            toInsert.flatMap((m) => [m.smtpHost, m.imapHost]),
        )
        if (hostError) {
            return res.status(400).json({ error: hostError })
        }

        // Same all-or-nothing rule as the host check: a sheet that states an impossible
        // port/TLS pair is a broken export, and half-importing it leaves the operator
        // reconciling which rows landed. Rows that simply omit the flag are fine — they
        // get the port's canonical value below.
        const conflicts = toInsert
            .map((m) => ({ email: m.email, conflict: checkSmtpSecurityConflict(m.smtpPort, m.smtpSecure) }))
            .filter((entry): entry is { email: string; conflict: NonNullable<ReturnType<typeof checkSmtpSecurityConflict>> } => entry.conflict !== null)

        if (conflicts.length > 0) {
            return res.status(422).json({
                error: `${conflicts.length} mailbox(es) declare an SMTP port and TLS mode that cannot both be true.`,
                code: SMTP_TLS_MODE_MISMATCH,
                details: conflicts.map((c) => ({ email: c.email, ...c.conflict.details })),
            })
        }

        const inserted = await db.insert(emailAccounts).values(
            toInsert.map((m) => ({
                organizationId,
                email: m.email,
                displayName: m.displayName,
                mailboxProvider: provider,
                providerRef: m.providerRef ?? null,
                smtpHost: m.smtpHost,
                smtpPort: m.smtpPort,
                smtpUsername: m.smtpUsername,
                smtpPassword: encryptSecret(m.smtpPassword),
                smtpSecure: canonicalSmtpSecure(m.smtpPort, m.smtpSecure),
                imapHost: m.imapHost,
                imapPort: m.imapPort,
                imapUsername: m.imapUsername,
                imapPassword: m.imapPassword ? encryptSecret(m.imapPassword) : null,
                imapSecure: m.imapSecure,
                dailySendLimit: m.dailySendLimit,
                minMinutesBetweenEmails: m.minMinutesBetweenEmails,
                maxMinutesBetweenEmails: m.maxMinutesBetweenEmails,
                warmupEnabled: m.warmupEnabled,
                warmupDays: m.warmupDays,
                status: 'pending' as const,
            }))
        ).returning()

        res.status(201).json({
            imported: inserted.length,
            duplicates: mailboxes.length - inserted.length,
            provider,
            emailAccounts: inserted.map((a) => ({
                ...a,
                smtpPassword: undefined,
                imapPassword: undefined,
            })),
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error bulk-importing email accounts:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Get email account by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const accountId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const account = await db.query.emailAccounts.findFirst({
            where: eq(emailAccounts.id, accountId),
        })

        if (!account) {
            return res.status(404).json({ error: 'Email account not found' })
        }

        const membership = await checkOrgMembership(userId, account.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }

        res.json({
            emailAccount: {
                ...account,
                dailyLimit: getEffectiveDailySendLimit(account),
                configuredDailyLimit: account.dailySendLimit,
                sentToday: account.currentDailySent,
                warmupDay: account.warmupCurrentDay,
                warmupProgress: account.warmupEnabled
                    ? Math.min(100, Math.round((account.warmupCurrentDay / Math.max(1, account.warmupDays)) * 100))
                    : 100,
                smtpPassword: undefined,
                imapPassword: undefined,
            },
        })
    } catch (error) {
        console.error('Error fetching email account:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Create email account
router.post('/', async (req: Request, res: Response) => {
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
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        // createEmailAccountSchema lowercases email, so validatedData.email is already the canonical
        // form used for the duplicate check, the lookups and storage alike — and it matches the
        // case-insensitive unique index from migration 036. Previously this handler computed a
        // normalizedEmail and then checked for duplicates against the raw value anyway, so a case
        // variant slipped past the check and past the (then case-sensitive) index.
        const validatedData = createEmailAccountSchema.parse(req.body)

        // Check for duplicate email
        const existing = await db.query.emailAccounts.findFirst({
            where: and(
                eq(emailAccounts.organizationId, organizationId),
                eq(emailAccounts.email, validatedData.email)
            ),
        })

        if (existing) {
            return res.status(400).json({ error: 'Email account already exists' })
        }

        let newAccount: typeof emailAccounts.$inferSelect

        if (validatedData.provider === 'native') {
            // No SMTP/IMAP credentials are collected or stored for native accounts —
            // sending goes through src/server/lib/native-send.ts's internal relay,
            // authenticated implicitly by the fact that the mailbox belongs to a
            // member of this organization. Validate all three preconditions BEFORE
            // inserting: (1) a platform user exists with this email, (2) that user
            // has a native mailbox, (3) that user is a member of this organization.
            const targetUser = await db.query.users.findFirst({
                where: eq(users.email, validatedData.email),
            })
            if (!targetUser) {
                return res.status(400).json({ error: 'No platform user found with that email address' })
            }

            const nativeMailbox = await getNativeMailboxByEmail(validatedData.email)
            if (!nativeMailbox) {
                return res.status(400).json({ error: 'That user does not have a native mailbox' })
            }

            const targetMembership = await db.query.organizationUsers.findFirst({
                where: and(
                    eq(organizationUsers.organizationId, organizationId),
                    eq(organizationUsers.userId, targetUser.id)
                ),
            })
            if (!targetMembership) {
                return res.status(400).json({ error: 'That user is not a member of this organization' })
            }

            const [inserted] = await db.insert(emailAccounts).values({
                organizationId,
                email: validatedData.email,
                displayName: validatedData.displayName,
                provider: 'native',
                smtpHost: null,
                smtpPort: null,
                smtpUsername: null,
                smtpPassword: null,
                smtpSecure: null,
                imapHost: null,
                imapPort: null,
                imapUsername: null,
                imapPassword: null,
                imapSecure: null,
                dailySendLimit: validatedData.dailySendLimit,
                minMinutesBetweenEmails: validatedData.minMinutesBetweenEmails,
                maxMinutesBetweenEmails: validatedData.maxMinutesBetweenEmails,
                warmupEnabled: validatedData.warmupEnabled,
                warmupDays: validatedData.warmupDays,
                status: 'pending',
            }).returning()
            newAccount = inserted
        } else {
            const hostError = await rejectPrivateMailHosts([validatedData.smtpHost, validatedData.imapHost])
            if (hostError) {
                return res.status(400).json({ error: hostError })
            }

            const securityConflict = checkSmtpSecurityConflict(validatedData.smtpPort, validatedData.smtpSecure)
            if (securityConflict) {
                return res.status(422).json(securityConflict)
            }

            // validatedData.smtpHost/smtpUsername/smtpPassword are guaranteed present by
            // superRefine when provider === 'smtp' (the default).
            const [inserted] = await db.insert(emailAccounts).values({
                organizationId,
                email: validatedData.email,
                displayName: validatedData.displayName,
                provider: 'smtp',
                smtpHost: validatedData.smtpHost as string,
                smtpPort: validatedData.smtpPort,
                smtpUsername: validatedData.smtpUsername as string,
                smtpPassword: encryptSecret(validatedData.smtpPassword as string),
                smtpSecure: canonicalSmtpSecure(validatedData.smtpPort, validatedData.smtpSecure),
                imapHost: validatedData.imapHost,
                imapPort: validatedData.imapPort,
                imapUsername: validatedData.imapUsername,
                imapPassword: validatedData.imapPassword ? encryptSecret(validatedData.imapPassword) : null,
                imapSecure: validatedData.imapSecure,
                dailySendLimit: validatedData.dailySendLimit,
                minMinutesBetweenEmails: validatedData.minMinutesBetweenEmails,
                maxMinutesBetweenEmails: validatedData.maxMinutesBetweenEmails,
                warmupEnabled: validatedData.warmupEnabled,
                warmupDays: validatedData.warmupDays,
                status: 'pending',
            }).returning()
            newAccount = inserted
        }

        res.status(201).json({
            emailAccount: {
                ...newAccount,
                smtpPassword: undefined,
                imapPassword: undefined,
            },
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error creating email account:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Update email account
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const accountId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const account = await db.query.emailAccounts.findFirst({
            where: eq(emailAccounts.id, accountId),
        })

        if (!account) {
            return res.status(404).json({ error: 'Email account not found' })
        }

        const membership = await checkOrgMembership(userId, account.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const validatedData = updateEmailAccountSchema.parse(req.body)

        // Without this, an inbox could be verified against a public host and then repointed at
        // an internal one — the sender would dial it on the next tick, having never re-verified.
        const hostError = await rejectPrivateMailHosts([validatedData.smtpHost, validatedData.imapHost])
        if (hostError) {
            return res.status(400).json({ error: hostError })
        }

        const updateValues: Record<string, unknown> = {
            updatedAt: new Date(),
        }

        if (validatedData.displayName !== undefined) updateValues.displayName = validatedData.displayName
        if (validatedData.smtpHost !== undefined) updateValues.smtpHost = validatedData.smtpHost
        if (validatedData.smtpPort !== undefined) updateValues.smtpPort = validatedData.smtpPort
        if (validatedData.smtpUsername !== undefined) updateValues.smtpUsername = validatedData.smtpUsername
        if (validatedData.smtpPassword !== undefined) updateValues.smtpPassword = encryptSecret(validatedData.smtpPassword)

        // Port and TLS mode are one setting in two columns, so resolve them together against
        // the row's post-update state. Editing only the port must re-derive the flag —
        // otherwise moving 465 → 587 would silently keep implicit TLS and break sending.
        // A stale stored flag is normalized silently; only an explicit contradiction is a 422.
        if (validatedData.smtpPort !== undefined || validatedData.smtpSecure !== undefined) {
            const nextPort = validatedData.smtpPort ?? account.smtpPort
            if (validatedData.smtpSecure !== undefined) {
                const securityConflict = checkSmtpSecurityConflict(nextPort, validatedData.smtpSecure)
                if (securityConflict) {
                    return res.status(422).json(securityConflict)
                }
            }
            updateValues.smtpSecure = canonicalSmtpSecure(nextPort, validatedData.smtpSecure ?? account.smtpSecure)
        }
        if (validatedData.imapHost !== undefined) updateValues.imapHost = validatedData.imapHost
        if (validatedData.imapPort !== undefined) updateValues.imapPort = validatedData.imapPort
        if (validatedData.imapUsername !== undefined) updateValues.imapUsername = validatedData.imapUsername
        if (validatedData.imapPassword !== undefined) updateValues.imapPassword = validatedData.imapPassword ? encryptSecret(validatedData.imapPassword) : null
        if (validatedData.imapSecure !== undefined) updateValues.imapSecure = validatedData.imapSecure
        if (validatedData.dailySendLimit !== undefined) updateValues.dailySendLimit = validatedData.dailySendLimit
        if (validatedData.minMinutesBetweenEmails !== undefined) updateValues.minMinutesBetweenEmails = validatedData.minMinutesBetweenEmails
        if (validatedData.maxMinutesBetweenEmails !== undefined) updateValues.maxMinutesBetweenEmails = validatedData.maxMinutesBetweenEmails
        if (validatedData.warmupEnabled !== undefined) updateValues.warmupEnabled = validatedData.warmupEnabled
        if (validatedData.warmupDays !== undefined) updateValues.warmupDays = validatedData.warmupDays
        if (validatedData.status !== undefined) updateValues.status = validatedData.status

        const [updatedAccount] = await db.update(emailAccounts)
            .set(updateValues)
            .where(eq(emailAccounts.id, accountId))
            .returning()

        if (!updatedAccount) return res.status(500).json({ error: 'Update failed — record not found' })

        res.json({
            emailAccount: {
                ...updatedAccount,
                smtpPassword: undefined,
                imapPassword: undefined,
            },
        })
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: 'Validation error', details: error.errors })
        }
        console.error('Error updating email account:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Delete email account
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const accountId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const account = await db.query.emailAccounts.findFirst({
            where: eq(emailAccounts.id, accountId),
        })

        if (!account) {
            return res.status(404).json({ error: 'Email account not found' })
        }

        const membership = await checkOrgMembership(userId, account.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        await db.delete(emailAccounts).where(eq(emailAccounts.id, accountId))

        res.json({ success: true })
    } catch (error) {
        console.error('Error deleting email account:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

// Verify email account (test connection)
router.post('/:id/verify', async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string
        const accountId = req.params.id

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' })
        }

        const account = await db.query.emailAccounts.findFirst({
            where: eq(emailAccounts.id, accountId),
        })

        if (!account) {
            return res.status(404).json({ error: 'Email account not found' })
        }

        const membership = await checkOrgMembership(userId, account.organizationId)
        if (!membership) {
            return res.status(403).json({ error: 'Access denied' })
        }
        if (!canWriteOutreach(membership)) {
            return res.status(403).json({ error: 'Write access denied' })
        }

        const smtpPassword = account.smtpPassword ? decryptSecret(account.smtpPassword) : null
        const errors: string[] = []

        if (account.provider === 'outlook') {
            // PROV-02: this used to mark the account verified unconditionally — no scope
            // check, no token check, no mailbox check, no network call at all. An Outlook
            // inbox therefore reported "verified" while being unable to read a single reply
            // or bounce, which is precisely how an Outlook-assigned lead kept receiving a
            // sequence after hard-bouncing. Verified now means both directions work.
            const capability = await evaluateOutlookOutreachCapability({
                account,
                loadMailbox: (mailboxId, organizationId) => db.query.outlookMailboxes.findFirst({
                    where: and(
                        eq(outlookMailboxes.id, mailboxId),
                        eq(outlookMailboxes.organizationId, organizationId),
                    ),
                }),
                // The probe's own result is the evidence — discarding it (as `.then(() =>
                // undefined)` did) left "it didn't throw" as the only signal, which a
                // throttled Graph satisfies without reading anything (W-1).
                probeInbound: async (mailbox) => {
                    const ingested = await syncOutlookInboundOnce({
                        account,
                        mailbox,
                        store: createDrizzleInboundEventStore(),
                    })
                    return { pagesFetched: ingested.pagesFetched, retryAfter: ingested.retryAfter }
                },
            })

            if (!capability.verified) {
                // Sanitized codes only: a raw Graph error can carry mailbox names, tenant
                // ids and request context that has no business in a stored column.
                const [updatedAccount] = await db.update(emailAccounts)
                    .set({
                        status: capability.status,
                        lastError: capability.code,
                        updatedAt: new Date(),
                    })
                    .where(eq(emailAccounts.id, accountId))
                    .returning()

                log.warn({
                    action: 'outreach.email_accounts.outlook_capability_denied',
                    emailAccountId: account.id,
                    code: capability.code,
                    status: capability.status,
                }, 'Outlook account failed the outreach capability gate')

                return res.status(400).json({
                    emailAccount: {
                        ...updatedAccount,
                        smtpPassword: undefined,
                        imapPassword: undefined,
                    },
                    verified: false,
                    code: capability.code,
                    missingScopes: capability.missingScopes,
                    errors: [describeOutlookCapability(capability.code, capability.missingScopes)],
                })
            }

            const [updatedAccount] = await db.update(emailAccounts)
                .set({
                    status: 'verified',
                    verifiedAt: new Date(),
                    lastError: null,
                    lastSyncAt: new Date(),
                    updatedAt: new Date(),
                })
                .where(eq(emailAccounts.id, accountId))
                .returning()

            return res.json({
                emailAccount: {
                    ...updatedAccount,
                    smtpPassword: undefined,
                    imapPassword: undefined,
                },
                verified: true,
                scopes: capability.scopes,
                // Stated explicitly so nobody reads "verified" as "we sent a test email".
                gate: capability.gate,
            })
        }

        if (account.provider === 'native') {
            // No network test — re-validate all three create-time preconditions, because
            // every one of them is revocable: the platform user still exists, still has a
            // native mailbox, and is STILL a member of this organization. Checking only the
            // first two would re-verify an account whose owner has left the org (C-3),
            // which is the same hole the inbound scanner had.
            const targetUser = await db.query.users.findFirst({
                where: eq(users.email, account.email.toLowerCase()),
            })
            const nativeMailbox = targetUser
                ? await getNativeMailboxForOrganization(account.email, account.organizationId)
                : null

            if (!targetUser || !nativeMailbox) {
                const reason = 'No native mailbox for a member of this organization matches this address'
                const [updatedAccount] = await db.update(emailAccounts)
                    .set({
                        status: 'failed',
                        lastError: reason,
                        updatedAt: new Date(),
                    })
                    .where(eq(emailAccounts.id, accountId))
                    .returning()

                return res.status(400).json({
                    emailAccount: {
                        ...updatedAccount,
                        smtpPassword: undefined,
                        imapPassword: undefined,
                    },
                    verified: false,
                    errors: [reason],
                })
            }

            const [updatedAccount] = await db.update(emailAccounts)
                .set({
                    status: 'verified',
                    verifiedAt: new Date(),
                    lastError: null,
                    updatedAt: new Date(),
                })
                .where(eq(emailAccounts.id, accountId))
                .returning()

            return res.json({
                emailAccount: {
                    ...updatedAccount,
                    smtpPassword: undefined,
                    imapPassword: undefined,
                },
                verified: true,
            })
        }

        if (!account.smtpHost || !smtpPassword) {
            return res.status(400).json({
                error: 'SMTP credentials not configured',
                verified: false,
            })
        }

        // Re-checked at connect time, not just on write: rows predating this guard, or written
        // through any other path, must not be able to make us dial an internal address.
        const hostError = await rejectPrivateMailHosts([account.smtpHost, account.imapHost])
        if (hostError) {
            return res.status(400).json({ error: hostError, verified: false })
        }

        // Test SMTP connection.
        // PROV-01: same resolver as createSmtpTransporter (lib/outreach-sender.ts), so what
        // verifies here is exactly what the sender will dial later. Legacy rows whose
        // smtp_secure contradicts their port are normalized rather than failed — they predate
        // the write-time validation on the create/import/update handlers above.
        try {
            const { options, resolution } = buildSmtpTransportOptions({
                host: account.smtpHost,
                port: account.smtpPort,
                secure: account.smtpSecure,
                username: account.smtpUsername || account.email,
                password: smtpPassword,
                connectionTimeoutMs: 10_000,
                greetingTimeoutMs: 10_000,
            })

            if (resolution.warning) {
                log.warn({ emailAccountId: account.id, mode: resolution.mode }, resolution.warning)
            }

            const smtpTransporter = nodemailer.createTransport(options as nodemailer.TransportOptions)

            await smtpTransporter.verify()
            smtpTransporter.close()
        } catch (smtpError) {
            const msg = smtpError instanceof Error ? smtpError.message : 'SMTP connection failed'
            errors.push(`SMTP: ${msg}`)
        }

        // Test IMAP connection (if configured)
        if (account.imapHost && account.imapUsername && account.imapPassword) {
            try {
                const imapPassword = decryptSecret(account.imapPassword)
                const imapClient = new ImapFlow({
                    host: account.imapHost,
                    port: account.imapPort || 993,
                    secure: account.imapSecure !== false,
                    auth: {
                        user: account.imapUsername,
                        pass: imapPassword,
                    },
                    logger: false,
                })

                await imapClient.connect()
                await imapClient.logout()
            } catch (imapError) {
                const msg = imapError instanceof Error ? imapError.message : 'IMAP connection failed'
                errors.push(`IMAP: ${msg}`)
            }
        }

        if (errors.length > 0) {
            const [updatedAccount] = await db.update(emailAccounts)
                .set({
                    status: 'failed',
                    lastError: errors.join('; '),
                    updatedAt: new Date(),
                })
                .where(eq(emailAccounts.id, accountId))
                .returning()

            return res.status(400).json({
                emailAccount: {
                    ...updatedAccount,
                    smtpPassword: undefined,
                    imapPassword: undefined,
                },
                verified: false,
                errors,
            })
        }

        const [updatedAccount] = await db.update(emailAccounts)
            .set({
                status: 'verified',
                verifiedAt: new Date(),
                lastError: null,
                updatedAt: new Date(),
            })
            .where(eq(emailAccounts.id, accountId))
            .returning()

        res.json({
            emailAccount: {
                ...updatedAccount,
                smtpPassword: undefined,
                imapPassword: undefined,
            },
            verified: true,
        })
    } catch (error) {
        console.error('Error verifying email account:', error)
        res.status(500).json({ error: 'Internal server error' })
    }
})

export default router
