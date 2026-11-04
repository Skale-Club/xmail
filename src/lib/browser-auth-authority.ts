export type BrowserAuthAuthority = 'legacy' | 'owned'
let authority: BrowserAuthAuthority | 'unresolved' | 'unavailable' = 'unresolved'
let pending: Promise<BrowserAuthAuthority> | undefined
let confirmedAt = 0, generation = 0, legacyBlocked = false, observingFocus = false
const listeners = new Set<() => void>()
const LEGACY_STATUS_TTL_MS = 10000

export function currentBrowserAuthAuthority() { return authority }
export function legacyBrowserAuthConfirmed() { return authority === 'legacy' && !legacyBlocked && Date.now() - confirmedAt < LEGACY_STATUS_TTL_MS }
export function browserAuthGeneration() { return generation }
export function legacyBrowserAuthSnapshotCurrent(value: number) { return legacyBrowserAuthConfirmed() && value === generation }
export function subscribeBrowserAuthBoundary(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
function notify() { generation++; for (const listener of listeners) { try { listener() } catch { /* Boundary remains closed even if cleanup fails. */ } } }
export function lockLegacyBrowserAuth() { if (!legacyBlocked) { legacyBlocked = true; notify() } }
function state(value: typeof authority) {
    if (authority === 'owned' && value !== 'owned') return
    const changed = authority !== value
    authority = value
    if (changed) notify()
}

/** A missing/failed status is never permission to initialize legacy credentials. */
export function resolveBrowserAuthAuthority(options: { force?: boolean } = {}): Promise<BrowserAuthAuthority> {
    if (!observingFocus && typeof window !== 'undefined') {
        observingFocus = true
        window.addEventListener('focus', () => { void resolveBrowserAuthAuthority({ force: true }).catch(() => {}) })
    }
    if (authority === 'owned') return Promise.resolve('owned')
    if (!options.force && authority === 'legacy' && Date.now() - confirmedAt < LEGACY_STATUS_TTL_MS) return Promise.resolve('legacy')
    pending ??= (async () => {
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Error('Sign-in status is unavailable.')) }, 8000)
            })
            const read = async () => {
                const response = await fetch('/api/auth/authority', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal })
                if (!response.ok || response.redirected) throw new Error('Sign-in status is unavailable.')
                const body = await response.json() as { authority?: unknown; available?: unknown }
                if (body.available !== true || (body.authority !== 'legacy' && body.authority !== 'owned') || controller.signal.aborted) throw new Error('Sign-in status is unavailable.')
                confirmedAt = Date.now()
                state(body.authority)
                return authority as BrowserAuthAuthority
            }
            return await Promise.race([read(), timeout])
        } catch {
            state('unavailable')
            throw new Error('Sign-in status is unavailable. Reload to try again.')
        } finally { clearTimeout(timer); controller.abort(); pending = undefined }
    })()
    return pending
}

export async function requireLegacyBrowserAuth() {
    if (await resolveBrowserAuthAuthority({ force: true }) !== 'legacy' || !legacyBrowserAuthConfirmed()) throw new Error('Use verified sign-in. Legacy browser authentication is unavailable.')
}
