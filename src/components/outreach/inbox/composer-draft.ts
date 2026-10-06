import type { InboxSendMode } from '../../../lib/unified-inbox-api'

// ============================================================
// Per-user, per-conversation composer draft (localStorage)
// ============================================================
// The composer remounts on every conversation switch and its state is local; without this the typed
// text vanished silently. We keep only what is needed to resume (mode, body, forward recipients).
// Attachments are NOT stored: they already live server-side as lifecycle-cleaned orphans.
//
// Drafts are namespaced by USER id as well as conversation id, so a shared browser never shows one
// operator's half-written reply to the next one. They expire after 30 days (checked on read AND
// swept on write) and are cleared on sign-out from the outreach layout.
// Every storage access is guarded (private mode, full quota, blocked storage).

const KEY_PREFIX = 'xmail:inbox-draft:v2:'
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface StoredComposerDraft {
    mode: InboxSendMode
    body: string
    forwardTo: string
    savedAt: number
}

const MODES: readonly InboxSendMode[] = ['reply', 'reply_all', 'forward']

function keyFor(userId: string, conversationId: string): string {
    return `${KEY_PREFIX}${userId}:${conversationId}`
}

function isValid(parsed: Partial<StoredComposerDraft> | null): parsed is StoredComposerDraft {
    return !!parsed
        && typeof parsed.body === 'string'
        && typeof parsed.forwardTo === 'string'
        && typeof parsed.savedAt === 'number'
        && MODES.includes(parsed.mode as InboxSendMode)
}

export function readComposerDraft(userId: string | undefined, conversationId: string | undefined): StoredComposerDraft | null {
    if (!userId || !conversationId) return null
    try {
        const raw = window.localStorage.getItem(keyFor(userId, conversationId))
        if (!raw) return null
        const parsed = JSON.parse(raw) as Partial<StoredComposerDraft> | null
        if (!isValid(parsed)) return null
        if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
            window.localStorage.removeItem(keyFor(userId, conversationId))
            return null
        }
        return parsed
    } catch {
        return null
    }
}

/** Remove every draft (any user) past its expiry. Cheap: bounded by the number of stored drafts. */
export function pruneExpiredComposerDrafts(): void {
    try {
        const storage = window.localStorage
        const stale: string[] = []
        for (let i = 0; i < storage.length; i += 1) {
            const key = storage.key(i)
            if (!key || !key.startsWith(KEY_PREFIX)) continue
            try {
                const parsed = JSON.parse(storage.getItem(key) ?? 'null') as Partial<StoredComposerDraft> | null
                if (!isValid(parsed) || Date.now() - parsed.savedAt > MAX_AGE_MS) stale.push(key)
            } catch {
                stale.push(key)
            }
        }
        for (const key of stale) storage.removeItem(key)
    } catch {
        /* storage unavailable: nothing to prune */
    }
}

/** Returns the save timestamp on success (drives the "Draft saved" hint), null otherwise. */
export function writeComposerDraft(
    userId: string | undefined,
    conversationId: string | undefined,
    draft: Omit<StoredComposerDraft, 'savedAt'>,
): number | null {
    if (!userId || !conversationId) return null
    try {
        pruneExpiredComposerDrafts()
        const savedAt = Date.now()
        window.localStorage.setItem(keyFor(userId, conversationId), JSON.stringify({ ...draft, savedAt }))
        return savedAt
    } catch {
        return null
    }
}

export function clearComposerDraft(userId: string | undefined, conversationId: string | undefined): void {
    if (!userId || !conversationId) return
    try {
        window.localStorage.removeItem(keyFor(userId, conversationId))
    } catch {
        /* storage unavailable: nothing to clear */
    }
}

/** Sign-out hygiene: drop every draft this user left on this browser. */
export function clearComposerDraftsForUser(userId: string | undefined): void {
    if (!userId) return
    try {
        const storage = window.localStorage
        const prefix = `${KEY_PREFIX}${userId}:`
        const mine: string[] = []
        for (let i = 0; i < storage.length; i += 1) {
            const key = storage.key(i)
            if (key && key.startsWith(prefix)) mine.push(key)
        }
        for (const key of mine) storage.removeItem(key)
    } catch {
        /* storage unavailable: nothing to clear */
    }
}
