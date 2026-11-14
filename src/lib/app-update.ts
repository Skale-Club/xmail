/** Defer automatic reloads while a sign-in flow holds in-memory provider proof. */
export function createAppUpdateCoordinator(reload: () => void, authPage: () => boolean) {
    let holds = 0
    let queued = false
    let preparation: (() => Promise<void>) | undefined
    let running = false

    async function flush() {
        if (!queued || running || holds > 0 || authPage()) return
        running = true
        try {
            const prepare = preparation
            preparation = undefined
            await prepare?.()
            // An async cache reset can overlap navigation into the login page.
            if (holds === 0 && !authPage()) { queued = false; reload() }
        } finally { running = false }
    }

    return {
        hold() {
            holds++
            let released = false
            return () => {
                if (released) return
                released = true
                holds--
                // React StrictMode immediately reacquires effects after cleanup.
                queueMicrotask(() => { void flush() })
            }
        },
        request(prepare?: () => Promise<void>) {
            queued = true
            if (prepare) preparation = prepare
            void flush()
        },
    }
}

const updates = createAppUpdateCoordinator(
    () => window.location.reload(),
    () => /^\/(?:auth\/identity|login|reset-password)\/?$/.test(window.location.pathname),
)

export const holdAppUpdates = updates.hold
export const requestAppReload = updates.request
