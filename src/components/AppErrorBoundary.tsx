import React from 'react'

interface Props {
    children: React.ReactNode
}

interface State {
    hasError: boolean
    error: Error | null
    isResetting: boolean
}

/**
 * Top-level error boundary that catches:
 *   - React render exceptions
 *   - React.lazy chunk load failures (e.g. ChunkLoadError after a deploy)
 *
 * Provides a "Reset app" recovery flow that unregisters service workers,
 * clears Caches API entries, scrubs mailbox-related localStorage keys,
 * and reloads the page. This gives users an escape hatch when the
 * Workbox PWA service worker is serving stale or corrupt 0-byte
 * responses for the JS bundle.
 */
export class AppErrorBoundary extends React.Component<Props, State> {
    constructor(props: Props) {
        super(props)
        this.state = { hasError: false, error: null, isResetting: false }
    }

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { hasError: true, error }
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error('[AppErrorBoundary]', error, info)
    }

    handleReset = async () => {
        this.setState({ isResetting: true })
        try {
            // Unregister all service workers
            if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations()
                await Promise.all(regs.map((r) => r.unregister()))
            }
            // Clear Caches API
            if ('caches' in window) {
                const keys = await caches.keys()
                await Promise.all(keys.map((k) => caches.delete(k)))
            }
            // Scrub localStorage keys that can cause stale UI state
            const lsKeys = Object.keys(localStorage)
            for (const key of lsKeys) {
                if (key === 'selectedMailboxId' || key.startsWith('selectedMailboxId:')) {
                    localStorage.removeItem(key)
                }
            }
        } catch (err) {
            console.error('[AppErrorBoundary] reset failed', err)
        } finally {
            // Force reload bypassing cache where supported
            window.location.reload()
        }
    }

    render() {
        if (!this.state.hasError) return this.props.children

        const isChunkError =
            this.state.error?.name === 'ChunkLoadError' ||
            /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i.test(
                this.state.error?.message || ''
            )

        return (
            <div className="flex min-h-screen items-center justify-center bg-background p-6">
                <div className="max-w-md w-full bg-card border border-border rounded-2xl p-6 shadow-xl">
                    <h1 className="text-xl font-semibold text-foreground mb-2">
                        {isChunkError ? 'A new version is available' : 'Something went wrong'}
                    </h1>
                    <p className="text-sm text-muted-foreground mb-4">
                        {isChunkError
                            ? 'The app updated since you last opened it and the cached files are out of date. Reset to load the latest version.'
                            : 'The application hit an unexpected error. Resetting clears cached files and stale state, which usually fixes the problem.'}
                    </p>
                    {this.state.error && (
                        <pre className="text-xs text-muted-foreground bg-muted/50 rounded p-2 mb-4 overflow-x-auto whitespace-pre-wrap break-words">
                            {this.state.error.name}: {this.state.error.message}
                        </pre>
                    )}
                    <div className="flex gap-2">
                        <button
                            onClick={this.handleReset}
                            disabled={this.state.isResetting}
                            className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-60 transition-colors text-sm font-medium"
                        >
                            {this.state.isResetting ? 'Resetting…' : 'Reset app'}
                        </button>
                        <button
                            onClick={() => window.location.reload()}
                            className="px-4 py-2 border border-border rounded-lg hover:bg-accent transition-colors text-sm"
                        >
                            Reload
                        </button>
                    </div>
                </div>
            </div>
        )
    }
}
