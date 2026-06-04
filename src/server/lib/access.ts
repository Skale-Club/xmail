/**
 * Centralized access-control helpers for Xmail.
 *
 * IMPORTANT: This module is the canonical import surface for every
 * authorization check. See CLAUDE.md "Authentication Flow" for context.
 *
 * The app's Postgres connection uses the `DATABASE_URL` role, which
 * bypasses Row-Level Security (no `auth.uid()` is set per request).
 * RLS policies in `supabase/migrations/` remain as defense-in-depth,
 * but the real authorization happens here in JS.
 *
 * Every API route MUST call one of these helpers before reading
 * or writing tenant-scoped data — there is no DB safety net.
 *
 * NOTE (Phase 10): Implementations still live at their original
 * locations; this file re-exports them so call sites can migrate
 * gradually. Phase 11+ will move implementations here and normalize
 * signatures.
 *
 * All org-scoped helpers share the same signature:
 *   (userId: string, organizationId: string)
 *     => Promise<{ organization, membership }>
 * where `membership === null` means access is denied. Callers should
 * 403 when `organization === null` or `membership === null`.
 *
 * The mailbox-scoped helper returns the mailbox row (or undefined)
 * directly, since mailboxes are user-scoped, not org-scoped.
 */

// --- Org-scoped access checks (one per resource family) ---

export { checkDomainAccess } from '../routes/domains'
export { checkMessageAccess } from '../routes/messages'
export { checkCredentialAccess } from '../routes/credentials'
export { checkWebhookAccess } from '../routes/webhooks'
export { checkOutlookAccess } from '../routes/outlook'
export { checkOrganizationAccess } from '../routes/templates'
export { checkRouteAccess } from '../routes/routes'

// --- User-scoped access checks ---

export { checkUserMailboxAccess } from '../routes/mail/mailboxes'

// --- Admin-only checks ---

export { isPlatformAdmin } from './admin'

/*
 * Example usage (preferred pattern for new routes):
 *
 *   import { checkDomainAccess } from '../lib/access'
 *
 *   const userId = req.headers['x-user-id'] as string
 *   if (!userId) return res.status(401).json({ error: 'Unauthorized' })
 *
 *   const { organization, membership } = await checkDomainAccess(userId, organizationId)
 *   if (!organization || !membership) {
 *     return res.status(403).json({ error: 'Forbidden' })
 *   }
 *
 * Or, for mailbox-scoped routes:
 *
 *   import { checkUserMailboxAccess } from '../lib/access'
 *   const mailbox = await checkUserMailboxAccess(userId, mailboxId)
 *   if (!mailbox) return res.status(404).json({ error: 'Mailbox not found' })
 */
