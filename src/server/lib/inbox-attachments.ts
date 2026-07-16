// ============================================================
// Unified Inbox attachment lifecycle (Phase 22 UIX-05, locked #7)
// ============================================================
// Attachments are BOUNDED, organization-owned, and NEVER base64 JSON blobs. Bytes live in one
// PRIVATE Supabase Storage bucket (migration 042); Postgres holds only metadata + an object
// reference. Every operation is organization-scoped: an attachment id from another tenant is
// indistinguishable from a missing one.
//
// Flow:
//   1. upload   — requireOutreachWrite streams the raw bytes (authenticated fetchWithAuth path,
//                 bounded by express.raw). The server validates count is impossible to exceed
//                 per-file (declared vs actual bytes match), size, and MIME/extension, then
//                 stores under a SERVER-CHOSEN path (never caller-selected) and marks it ready.
//   2. validate — createResolvedSendCommand asserts every attachment id is ready + owned before
//                 the durable command is persisted (assertAttachmentsUsable).
//   3. dispatch — the executor loads ready bytes for the command's ids (loadAttachmentsForDispatch)
//                 and hands them to the shared composer as MIME parts.
//   4. download — requireOutreachRead returns only a short-lived signed URL (getAttachmentDownloadUrl).
//   5. cleanup  — delete removes row + object; a lifecycle job (cleanupExpiredAttachments, wired
//                 in jobs/index.ts) prunes expired intents AND abandoned, never-bound `ready` uploads.
//
// The bounded validation is a PURE function so it is fully unit-testable without Storage/DB.

import { randomUUID } from 'node:crypto'
import { INBOX_ATTACHMENTS_BUCKET } from '../../db/schema'
import type { OutreachAttachmentInput } from './outreach-provider'

export const MAX_ATTACHMENTS_PER_COMMAND = 10
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 // 25 MiB — matches the DB size CHECK (26214400).
export const MAX_ATTACHMENT_AGGREGATE_BYTES = 25 * 1024 * 1024 // Total across a single command.
// Pending intents older than this with no ready object are pruned by the lifecycle job.
export const ATTACHMENT_INTENT_TTL_MS = 24 * 60 * 60 * 1000

export class InboxAttachmentError extends Error {
    status: number
    code: string
    constructor(status: number, code: string, message?: string) {
        super(message ?? code)
        this.name = 'InboxAttachmentError'
        this.status = status
        this.code = code
    }
}

// A conservative allow-list of document/image/text MIME types + their extensions. Anything a
// browser might interpret as active content (html, svg, scripts, executables) is rejected.
const ALLOWED_MIME_EXTENSIONS: Record<string, readonly string[]> = {
    'application/pdf': ['pdf'],
    'application/msword': ['doc'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
    'application/vnd.ms-excel': ['xls'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
    'application/vnd.ms-powerpoint': ['ppt'],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
    'application/zip': ['zip'],
    'application/json': ['json'],
    'text/plain': ['txt', 'text', 'log', 'csv'],
    'text/csv': ['csv'],
    'text/calendar': ['ics'],
    'image/png': ['png'],
    'image/jpeg': ['jpg', 'jpeg'],
    'image/gif': ['gif'],
    'image/webp': ['webp'],
}

function extensionOf(filename: string): string {
    const dot = filename.lastIndexOf('.')
    return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : ''
}

/** Reject a filename that could traverse paths or hide separators. Callers NEVER choose the object path. */
export function sanitizeAttachmentFilename(filename: string): string {
    // Keep only the basename, then reduce to a safe allow-list ([A-Za-z0-9._-]) so no path
    // separator, traversal sequence, or control character can survive into the object path.
    const base = (filename ?? '').trim().split(/[\\/]/).pop() ?? ''
    const cleaned = base
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^[._]+/, '')
        .replace(/_+/g, '_')
        .slice(0, 255)
    if (!cleaned || cleaned === '_') throw new InboxAttachmentError(400, 'attachment_filename_invalid', 'Attachment filename is invalid')
    return cleaned
}

export interface AttachmentDeclaration {
    filename: string
    mimeType: string
    sizeBytes: number
}

/** Validate ONE declared attachment (filename, MIME, extension, per-file size). Pure. */
export function validateAttachmentDeclaration(input: AttachmentDeclaration): { filename: string; mimeType: string; sizeBytes: number } {
    const filename = sanitizeAttachmentFilename(input.filename)
    const mimeType = (input.mimeType ?? '').trim().toLowerCase()
    const allowedExts = ALLOWED_MIME_EXTENSIONS[mimeType]
    if (!allowedExts) throw new InboxAttachmentError(415, 'attachment_type_unsupported', `Unsupported attachment type: ${mimeType || 'unknown'}`)
    const ext = extensionOf(filename)
    if (!allowedExts.includes(ext)) {
        throw new InboxAttachmentError(415, 'attachment_extension_mismatch', `Extension .${ext} does not match ${mimeType}`)
    }
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
        throw new InboxAttachmentError(400, 'attachment_size_invalid', 'Attachment size must be a positive integer')
    }
    if (input.sizeBytes > MAX_ATTACHMENT_BYTES) {
        throw new InboxAttachmentError(413, 'attachment_too_large', `Attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit`)
    }
    return { filename, mimeType, sizeBytes: input.sizeBytes }
}

/** Validate a SET: count ceiling + aggregate size. Pure. */
export function validateAttachmentSet(declarations: AttachmentDeclaration[]): void {
    if (declarations.length > MAX_ATTACHMENTS_PER_COMMAND) {
        throw new InboxAttachmentError(400, 'attachment_too_many', `A message may carry at most ${MAX_ATTACHMENTS_PER_COMMAND} attachments`)
    }
    const total = declarations.reduce((sum, d) => sum + (Number.isFinite(d.sizeBytes) ? d.sizeBytes : 0), 0)
    if (total > MAX_ATTACHMENT_AGGREGATE_BYTES) {
        throw new InboxAttachmentError(413, 'attachment_aggregate_too_large', `Attachments exceed the ${MAX_ATTACHMENT_AGGREGATE_BYTES}-byte total limit`)
    }
}

export interface InboxAttachmentDto {
    id: string
    filename: string
    mimeType: string
    sizeBytes: number
    status: string
    createdAt: string
}

// A server-chosen, unguessable object path — organization-prefixed so a bucket listing is
// tenant-partitioned, and never derived from caller input.
function buildStoragePath(organizationId: string, attachmentId: string, filename: string): string {
    return `${organizationId}/${attachmentId}/${filename}`
}

// ---------------------------------------------------------------------------
// Storage seam (injectable so unit tests never touch Supabase Storage).
// ---------------------------------------------------------------------------

export interface AttachmentStorage {
    upload(bucket: string, path: string, bytes: Buffer, contentType: string): Promise<void>
    download(bucket: string, path: string): Promise<Buffer>
    createSignedUrl(bucket: string, path: string, expiresInSeconds: number): Promise<string>
    remove(bucket: string, paths: string[]): Promise<void>
}

function defaultStorage(): AttachmentStorage {
    return {
        async upload(bucket, path, bytes, contentType) {
            const { supabaseAdminClient } = await import('./supabase')
            const { error } = await supabaseAdminClient.storage.from(bucket).upload(path, bytes, {
                contentType,
                upsert: false,
            })
            if (error) throw new InboxAttachmentError(502, 'attachment_storage_upload_failed', error.message)
        },
        async download(bucket, path) {
            const { supabaseAdminClient } = await import('./supabase')
            const { data, error } = await supabaseAdminClient.storage.from(bucket).download(path)
            if (error || !data) throw new InboxAttachmentError(502, 'attachment_storage_download_failed', error?.message)
            return Buffer.from(await data.arrayBuffer())
        },
        async createSignedUrl(bucket, path, expiresInSeconds) {
            const { supabaseAdminClient } = await import('./supabase')
            const { data, error } = await supabaseAdminClient.storage.from(bucket).createSignedUrl(path, expiresInSeconds)
            if (error || !data?.signedUrl) throw new InboxAttachmentError(502, 'attachment_storage_sign_failed', error?.message)
            return data.signedUrl
        },
        async remove(bucket, paths) {
            const { supabaseAdminClient } = await import('./supabase')
            await supabaseAdminClient.storage.from(bucket).remove(paths)
        },
    }
}

export interface AttachmentDeps {
    storage?: AttachmentStorage
    now?: () => Date
}

// ---------------------------------------------------------------------------
// Upload — validate declared + actual, store under a server path, mark ready.
// ---------------------------------------------------------------------------

export async function createInboxAttachment(input: {
    organizationId: string
    userId: string
    filename: string
    mimeType: string
    bytes: Buffer
}, deps: AttachmentDeps = {}): Promise<InboxAttachmentDto> {
    // Validate the DECLARED metadata against the ACTUAL received byte length — a client cannot
    // under-declare a size to slip past the ceiling, because the server measures the bytes.
    const declared = validateAttachmentDeclaration({
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.length,
    })
    validateAttachmentSet([declared])

    const storage = deps.storage ?? defaultStorage()
    const { db } = await import('../../db')
    const { inboxAttachments } = await import('../../db/schema')

    const attachmentId = randomUUID()
    const storagePath = buildStoragePath(input.organizationId, attachmentId, declared.filename)

    await storage.upload(INBOX_ATTACHMENTS_BUCKET, storagePath, input.bytes, declared.mimeType)

    try {
        const [row] = await db
            .insert(inboxAttachments)
            .values({
                id: attachmentId,
                organizationId: input.organizationId,
                createdByUserId: input.userId,
                storageBucket: INBOX_ATTACHMENTS_BUCKET,
                storagePath,
                filename: declared.filename,
                mimeType: declared.mimeType,
                sizeBytes: declared.sizeBytes,
                status: 'ready',
            })
            .returning()
        return toDto(row)
    } catch (error) {
        // Roll the object back so a failed insert never leaves an orphan in the bucket.
        await storage.remove(INBOX_ATTACHMENTS_BUCKET, [storagePath]).catch(() => {})
        throw error
    }
}

function toDto(row: {
    id: string
    filename: string
    mimeType: string
    sizeBytes: number
    status: string
    createdAt: Date
}): InboxAttachmentDto {
    return {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
    }
}

// ---------------------------------------------------------------------------
// Ownership assertion (called before persisting a durable command).
// ---------------------------------------------------------------------------

/**
 * Assert every id is ready, belongs to the organization, and is not already bound to a
 * DIFFERENT send command. Throws InboxAttachmentError on the first violation. A cross-tenant
 * id simply does not match the org predicate -> 'attachment_not_found'.
 */
export async function assertAttachmentsUsable(organizationId: string, attachmentIds: string[]): Promise<void> {
    if (attachmentIds.length === 0) return
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_COMMAND) {
        throw new InboxAttachmentError(400, 'attachment_too_many')
    }
    const unique = Array.from(new Set(attachmentIds))
    const { db } = await import('../../db')
    const { inboxAttachments } = await import('../../db/schema')
    const { and, eq, inArray } = await import('drizzle-orm')

    const rows = await db
        .select({ id: inboxAttachments.id, status: inboxAttachments.status, sendCommandId: inboxAttachments.sendCommandId, sizeBytes: inboxAttachments.sizeBytes })
        .from(inboxAttachments)
        .where(and(eq(inboxAttachments.organizationId, organizationId), inArray(inboxAttachments.id, unique)))

    if (rows.length !== unique.length) throw new InboxAttachmentError(404, 'attachment_not_found')
    for (const row of rows) {
        if (row.status !== 'ready') throw new InboxAttachmentError(409, 'attachment_not_ready')
        if (row.sendCommandId) throw new InboxAttachmentError(409, 'attachment_already_bound')
    }
    validateAttachmentSet(rows.map((r) => ({ filename: 'x.txt', mimeType: 'text/plain', sizeBytes: r.sizeBytes })))
}

/** Bind ready attachments to their owning command (after the command row is created). */
export async function bindAttachmentsToCommand(organizationId: string, commandId: string, attachmentIds: string[]): Promise<void> {
    if (attachmentIds.length === 0) return
    const { db } = await import('../../db')
    const { inboxAttachments } = await import('../../db/schema')
    const { and, eq, inArray, isNull } = await import('drizzle-orm')
    await db
        .update(inboxAttachments)
        .set({ sendCommandId: commandId, updatedAt: new Date() })
        .where(and(
            eq(inboxAttachments.organizationId, organizationId),
            inArray(inboxAttachments.id, Array.from(new Set(attachmentIds))),
            isNull(inboxAttachments.sendCommandId),
        ))
}

// ---------------------------------------------------------------------------
// Dispatch load — ready bytes for the executor (never base64 in the row).
// ---------------------------------------------------------------------------

export async function loadAttachmentsForDispatch(
    organizationId: string,
    attachmentIds: string[],
    deps: AttachmentDeps = {},
): Promise<OutreachAttachmentInput[]> {
    if (attachmentIds.length === 0) return []
    const storage = deps.storage ?? defaultStorage()
    const unique = Array.from(new Set(attachmentIds))
    const { db } = await import('../../db')
    const { inboxAttachments } = await import('../../db/schema')
    const { and, eq, inArray } = await import('drizzle-orm')

    const rows = await db
        .select()
        .from(inboxAttachments)
        .where(and(
            eq(inboxAttachments.organizationId, organizationId),
            inArray(inboxAttachments.id, unique),
            eq(inboxAttachments.status, 'ready'),
        ))
    // Re-assert the command's attachment set is INTACT at dispatch: every referenced id must still
    // resolve to a ready, org-owned row. If the operator deleted SOME (not all) attachments before
    // a scheduled send, the loaded rows will not cover every id — refuse to send a partial reply
    // missing files rather than dropping them silently.
    if (rows.length !== unique.length) throw new InboxAttachmentError(404, 'attachment_missing', 'One or more attachments referenced by this command are missing')

    const attachments: OutreachAttachmentInput[] = []
    for (const row of rows) {
        const bytes = await storage.download(row.storageBucket, row.storagePath)
        attachments.push({ filename: row.filename, content: bytes, contentType: row.mimeType })
    }
    return attachments
}

// ---------------------------------------------------------------------------
// Download — a short-lived signed URL, org-authorized only.
// ---------------------------------------------------------------------------

export async function getAttachmentDownloadUrl(
    organizationId: string,
    attachmentId: string,
    deps: AttachmentDeps = {},
): Promise<{ url: string; filename: string }> {
    const storage = deps.storage ?? defaultStorage()
    const { db } = await import('../../db')
    const { inboxAttachments } = await import('../../db/schema')
    const { and, eq } = await import('drizzle-orm')
    const rows = await db
        .select()
        .from(inboxAttachments)
        .where(and(eq(inboxAttachments.organizationId, organizationId), eq(inboxAttachments.id, attachmentId)))
        .limit(1)
    const row = rows[0]
    if (!row || row.status === 'deleted') throw new InboxAttachmentError(404, 'attachment_not_found')
    const url = await storage.createSignedUrl(row.storageBucket, row.storagePath, 120)
    return { url, filename: row.filename }
}

// ---------------------------------------------------------------------------
// Delete + lifecycle cleanup.
// ---------------------------------------------------------------------------

export async function deleteInboxAttachment(organizationId: string, attachmentId: string, deps: AttachmentDeps = {}): Promise<void> {
    const storage = deps.storage ?? defaultStorage()
    const { db } = await import('../../db')
    const { inboxAttachments } = await import('../../db/schema')
    const { and, eq } = await import('drizzle-orm')
    const rows = await db
        .delete(inboxAttachments)
        .where(and(eq(inboxAttachments.organizationId, organizationId), eq(inboxAttachments.id, attachmentId)))
        .returning({ bucket: inboxAttachments.storageBucket, path: inboxAttachments.storagePath })
    if (rows.length === 0) throw new InboxAttachmentError(404, 'attachment_not_found')
    await storage.remove(rows[0].bucket, [rows[0].path]).catch(() => {})
}

/**
 * Prune abandoned attachment rows older than the TTL (row + object). Returns the count removed.
 * Covers pending/failed intents AND abandoned `ready` uploads that were never bound to a send
 * command — an upload marks the row `ready` immediately, so a `ready` row with no sendCommandId
 * older than the TTL is an orphaned upload whose object would otherwise leak in the private bucket.
 * The isNull(sendCommandId) guard + the 24h TTL leave any in-flight compose→bind window untouched.
 */
export async function cleanupExpiredAttachments(deps: AttachmentDeps = {}): Promise<number> {
    const storage = deps.storage ?? defaultStorage()
    const now = (deps.now ?? (() => new Date()))()
    const cutoff = new Date(now.getTime() - ATTACHMENT_INTENT_TTL_MS)
    const { db } = await import('../../db')
    const { inboxAttachments } = await import('../../db/schema')
    const { and, eq, lt, isNull, or } = await import('drizzle-orm')
    const rows = await db
        .delete(inboxAttachments)
        .where(and(
            lt(inboxAttachments.createdAt, cutoff),
            isNull(inboxAttachments.sendCommandId),
            or(
                eq(inboxAttachments.status, 'pending'),
                eq(inboxAttachments.status, 'failed'),
                eq(inboxAttachments.status, 'ready'),
            ),
        ))
        .returning({ bucket: inboxAttachments.storageBucket, path: inboxAttachments.storagePath })
    if (rows.length > 0) {
        const byBucket = new Map<string, string[]>()
        for (const r of rows) {
            const list = byBucket.get(r.bucket) ?? []
            list.push(r.path)
            byBucket.set(r.bucket, list)
        }
        for (const [bucket, paths] of byBucket) await storage.remove(bucket, paths).catch(() => {})
    }
    return rows.length
}
