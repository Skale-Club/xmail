/**
 * Per-IP auth throttle for IMAP/SMTP sockets.
 * Locks an IP after 5 failed auth attempts within 15 minutes for 15 minutes.
 */

interface Entry {
    failCount: number
    firstFailAt: number
    lockedUntil: number
}

const ATTEMPTS_PER_WINDOW = 5
const WINDOW_MS = 15 * 60 * 1000
const LOCK_MS = 15 * 60 * 1000

const attempts = new Map<string, Entry>()

export function isIpLocked(ip: string): boolean {
    const entry = attempts.get(ip)
    if (!entry) return false
    const now = Date.now()
    if (entry.lockedUntil > now) return true
    if (now - entry.firstFailAt > WINDOW_MS) {
        attempts.delete(ip)
    }
    return false
}

export function recordAuthFailure(ip: string): void {
    const now = Date.now()
    const entry = attempts.get(ip)
    if (!entry || now - entry.firstFailAt > WINDOW_MS) {
        attempts.set(ip, { failCount: 1, firstFailAt: now, lockedUntil: 0 })
        return
    }
    entry.failCount += 1
    if (entry.failCount >= ATTEMPTS_PER_WINDOW) {
        entry.lockedUntil = now + LOCK_MS
    }
}

export function clearAuthFailures(ip: string): void {
    attempts.delete(ip)
}

const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [ip, entry] of attempts) {
        if (entry.lockedUntil < now && now - entry.firstFailAt > WINDOW_MS) {
            attempts.delete(ip)
        }
    }
}, 5 * 60 * 1000)
cleanup.unref()
