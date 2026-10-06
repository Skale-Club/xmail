import type { InboxSendMode } from '../../../lib/unified-inbox-api'

// ============================================================
// Per-conversation composer draft (localStorage)
// ============================================================
// The composer remounts on every conversation switch and its state is local; without this the typed
// text vanished silently. We keep only what is needed to resume (mode, body, forward recipients).
// Attachments are NOT stored: they already live server-side as lifecycle-cleaned orphans.
// Every storage access is guarded (private mode, full quota, blocked storage).

const KEY_PREFIX = 'xmail:inbox-draft:v1:'
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface StoredComposerDraft {
    mode: InboxSendMode
    body: string
    forwardTo: string
    savedAt: number
}

const MODES: readonly InboxSendMode[] = ['reply', 'reply_all', 'forward']

function keyFor(conversationId: string): string {
    return `${KEY_PREFIX}${conversationId}`
}

export function readComposerDraft(conversationId: string | undefined): StoredComposerDraft | null {
    if (!conversationId) return null
    try {
        const raw = window.localStorage.getItem(keyFor(conversationId))
        if (!raw) return null
        const parsed = JSON.parse(raw) as Partial<StoredComposerDraft> | null
        if (
            !parsed
            || typeof parsed.body !== 'string'
            || typeof parsed.forwardTo !== 'string'
            || typeof parsed.savedAt !== 'number'
            || !MODES.includes(parsed.mode as InboxSendMode)
        ) {
            return null
        }
        if (Date.now() - parsed.savedAt > MAX_AGE_MS) {
            window.localStorage.removeItem(keyFor(conversationId))
            return null
        }
        return parsed as StoredComposerDraft
    } catch {
        return null
    }
}

/** Returns the save timestamp on success (drives the "Draft saved" hint), null otherwise. */
export function writeComposerDraft(
    conversationId: string | undefined,
    draft: Omit<StoredComposerDraft, 'savedAt'>,
): number | null {
    if (!conversationId) return null
    try {
        const savedAt = Date.now()
        window.localStorage.setItem(keyFor(conversationId), JSON.stringify({ ...draft, savedAt }))
        return savedAt
    } catch {
        return null
    }
}

export function clearComposerDraft(conversationId: string | undefined): void {
    if (!conversationId) return
    try {
        window.localStorage.removeItem(keyFor(conversationId))
    } catch {
        /* storage unavailable: nothing to clear */
    }
}
