import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Route, Switch, useLocation, useSearch } from 'wouter'
import { Toaster } from './components/ui/toaster'
import { ThemeProvider } from './components/theme-provider'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { MultiSessionProvider } from './hooks/useMultiSession'
import { MailboxProvider } from './hooks/useMailbox'
import { useCompose } from './hooks/useCompose'
import { useBranding } from './lib/branding'
import AdminLayout from './components/admin/AdminLayout'
import { OrganizationProvider } from './hooks/useOrganization'
import { ComposeProvider } from './hooks/useCompose'
import { MailLayout } from './components/mail/MailLayout'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import './index.css'

// ---------------------------------------------------------------------------
// Stale-chunk recovery
// ---------------------------------------------------------------------------
// When a new Docker build deploys, Workbox installs and activates the new SW
// (skipWaiting + clientsClaim), but does NOT reload open tabs.  Those tabs
// still hold the old index.html in memory, so any lazy import() referencing
// an old content-hash chunk (e.g. SentPage-DsScGhek.js) returns a text/html
// fallback from Express and the browser throws:
//   TypeError: Failed to fetch dynamically imported module
// This lands as an unhandledrejection — outside React's error boundary — and
// causes a blank screen.  The listener below catches it, nukes the stale SW
// cache, and reloads so the user gets the new build automatically.
const CHUNK_LOAD_RE = /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk/i

window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const message = reason instanceof Error ? reason.message : String(reason ?? '')
    if (!CHUNK_LOAD_RE.test(message)) return

    console.warn('[GSD] Stale chunk detected — clearing SW cache and reloading', message)
    event.preventDefault()

    const doReset = async () => {
        try {
            if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations()
                await Promise.all(regs.map((r) => r.unregister()))
            }
            if ('caches' in window) {
                const keys = await caches.keys()
                await Promise.all(keys.map((k) => caches.delete(k)))
            }
        } catch { /* best-effort */ }
        window.location.reload()
    }

    void doReset()
})

// When a new SW takes over (controllerchange), reload immediately so the tab
// starts using the new index.html with updated chunk hashes.
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        console.info('[GSD] New service worker active — reloading for fresh build')
        window.location.reload()
    })
}

const Login = React.lazy(() => import('./pages/Login'))

const AdminDashboard = React.lazy(() => import('./pages/admin/AdminDashboard'))
const OrganizationsPage = React.lazy(() => import('./pages/admin/OrganizationsPage'))
const OrganizationDetailPage = React.lazy(() => import('./pages/admin/OrganizationDetailPage'))
const AdminsPage = React.lazy(() => import('./pages/admin/AdminsPage'))
const BrandingPage = React.lazy(() => import('./pages/admin/BrandingPage'))
const CredentialsPage = React.lazy(() => import('./pages/admin/CredentialsPage'))
const RoutesPage = React.lazy(() => import('./pages/admin/RoutesPage'))
const WebhooksPage = React.lazy(() => import('./pages/admin/WebhooksPage'))
const MessagesPage = React.lazy(() => import('./pages/admin/MessagesPage'))

const OutreachDashboard = React.lazy(() => import('./pages/outreach/OutreachDashboard'))
const CampaignsPage = React.lazy(() => import('./pages/outreach/CampaignsPage'))
const NewCampaignPage = React.lazy(() => import('./pages/outreach/campaigns/NewCampaignPage'))
const CampaignDetailPage = React.lazy(() => import('./pages/outreach/campaigns/CampaignDetailPage'))
const LeadsPage = React.lazy(() => import('./pages/outreach/LeadsPage'))
const InboxesPage = React.lazy(() => import('./pages/outreach/InboxesPage'))
const NewInboxPage = React.lazy(() => import('./pages/outreach/inboxes/NewInboxPage'))
const SequencesPage = React.lazy(() => import('./pages/outreach/SequencesPage'))
const NewSequencePage = React.lazy(() => import('./pages/outreach/sequences/NewSequencePage'))
const OutreachAnalyticsPage = React.lazy(() => import('./pages/outreach/AnalyticsPage'))
const OutreachSettingsPage = React.lazy(() => import('./pages/outreach/SettingsPage'))

const InboxPage = React.lazy(() => import('./pages/mail/InboxPage'))
const SentPage = React.lazy(() => import('./pages/mail/SentPage'))
const DraftsPage = React.lazy(() => import('./pages/mail/DraftsPage'))
const TrashPage = React.lazy(() => import('./pages/mail/TrashPage'))
const StarredPage = React.lazy(() => import('./pages/mail/StarredPage'))
const SpamPage = React.lazy(() => import('./pages/mail/SpamPage'))
const ArchivePage = React.lazy(() => import('./pages/mail/ArchivePage'))
const ContactsPage = React.lazy(() => import('./pages/mail/ContactsPage'))
const MailSettingsPage = React.lazy(() => import('./pages/mail/SettingsPage'))
const SearchPage = React.lazy(() => import('./pages/mail/SearchPage'))
const EmailDetailPage = React.lazy(() => import('./pages/mail/EmailDetailPage'))
const LazyComposeDialog = React.lazy(() =>
    import('./components/mail/ComposeDialog').then((module) => ({ default: module.ComposeDialog }))
)

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            retry: (failureCount, error) => {
                if (error instanceof Error && error.message === 'Unauthorized') return false
                if (error instanceof Error && error.message.includes('Too many requests')) return false
                return failureCount < 2
            },
            staleTime: 30_000,
            refetchOnWindowFocus: false,
        },
        mutations: {
            retry: false,
        },
    },
})

function Spinner() {
    return (
        <div className="flex min-h-screen items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
        </div>
    )
}

function AdminCheck({ children }: { children: React.ReactNode }) {
    const { user, isAdmin, isLoading } = useAuth()
    const [, navigate] = useLocation()

    if (isLoading) return <Spinner />

    if (!user) {
        navigate('/login')
        return null
    }

    if (isAdmin === null) return <Spinner />

    if (!isAdmin) {
        navigate('/mail/inbox')
        return null
    }

    return <>{children}</>
}

function MailCheck({ children }: { children: React.ReactNode }) {
    const { user, isAdmin, isLoading } = useAuth()
    const [, navigate] = useLocation()

    if (isLoading) return <Spinner />

    if (!user) {
        navigate('/login')
        return null
    }

    if (isAdmin === null) return <Spinner />

    return <>{children}</>
}

function RootRedirect() {
    const { user, isAdmin, isLoading } = useAuth()
    const [, navigate] = useLocation()

    if (isLoading) return <Spinner />

    if (!user) {
        navigate('/login')
        return null
    }

    if (isAdmin === null) return <Spinner />

    navigate(isAdmin ? '/admin' : '/mail/inbox')
    return null
}

function BrandingHead() {
    const { branding, isSuccess } = useBranding()

    const applyBranding = React.useCallback(() => {
        document.title = branding.applicationName

        const faviconUrl = new URL(branding.faviconUrl, window.location.origin)
        faviconUrl.searchParams.set('v', window.btoa(branding.faviconUrl).replace(/[+/=]/g, '').slice(0, 16))

        const faviconType = (() => {
            const pathname = faviconUrl.pathname.toLowerCase()

            if (pathname.endsWith('.svg')) return 'image/svg+xml'
            if (pathname.endsWith('.png')) return 'image/png'
            if (pathname.endsWith('.webp')) return 'image/webp'
            if (pathname.endsWith('.ico')) return 'image/x-icon'

            return undefined
        })()

        for (const link of document.head.querySelectorAll("link[rel='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']")) {
            if ((link as HTMLLinkElement).dataset.managedBrandingIcon !== 'true') {
                link.remove()
            }
        }

        const descriptors = [
            { key: 'icon', rel: 'icon' },
            { key: 'shortcut', rel: 'shortcut icon' },
            { key: 'apple', rel: 'apple-touch-icon' },
        ] as const

        for (const descriptor of descriptors) {
            const link = document.createElement('link')
            link.dataset.managedBrandingIcon = 'true'
            link.dataset.iconKey = descriptor.key
            link.rel = descriptor.rel
            link.href = faviconUrl.toString()

            if (faviconType) {
                link.type = faviconType
            }

            if (faviconType === 'image/svg+xml' && descriptor.rel !== 'apple-touch-icon') {
                link.sizes = 'any'
            }

            const existing = document.head.querySelector(
                `link[data-managed-branding-icon="true"][data-icon-key="${descriptor.key}"]`
            )

            if (existing) {
                existing.replaceWith(link)
            } else {
                document.head.appendChild(link)
            }
        }
    }, [branding.applicationName, branding.faviconUrl])

    React.useEffect(() => {
        if (!isSuccess) return

        applyBranding()

        const handleVisibilityRestore = () => {
            if (document.visibilityState === 'hidden') return
            applyBranding()
        }

        document.addEventListener('visibilitychange', handleVisibilityRestore)
        window.addEventListener('pageshow', handleVisibilityRestore)

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityRestore)
            window.removeEventListener('pageshow', handleVisibilityRestore)
        }
    }, [applyBranding, isSuccess])

    return null
}

function ComposeDialogHost() {
    const { isOpen } = useCompose()

    if (!isOpen) return null

    return (
        <Suspense fallback={null}>
            <LazyComposeDialog />
        </Suspense>
    )
}

function PageSuspense({ children }: { children: React.ReactNode }) {
    return <Suspense fallback={<Spinner />}>{children}</Suspense>
}

function ComposeRouteBridge() {
    const search = useSearch()
    const [, setLocation] = useLocation()
    const { openCompose } = useCompose()

    React.useEffect(() => {
        const params = new URLSearchParams(search)

        openCompose({
            replyToId: params.get('reply') || undefined,
            forwardId: params.get('forward') || undefined,
            draftId: params.get('draft') || undefined,
            replyAll: params.get('replyAll') === 'true',
        })

        setLocation('/mail/inbox')
    }, [openCompose, search, setLocation])

    return null
}

function MailRoutes() {
    return (
        <MailLayout>
            <Switch>
                <Route path="/mail/inbox">
                    <PageSuspense><InboxPage /></PageSuspense>
                </Route>
                <Route path="/mail/sent">
                    <PageSuspense><SentPage /></PageSuspense>
                </Route>
                <Route path="/mail/drafts">
                    <PageSuspense><DraftsPage /></PageSuspense>
                </Route>
                <Route path="/mail/trash">
                    <PageSuspense><TrashPage /></PageSuspense>
                </Route>
                <Route path="/mail/starred">
                    <PageSuspense><StarredPage /></PageSuspense>
                </Route>
                <Route path="/mail/spam">
                    <PageSuspense><SpamPage /></PageSuspense>
                </Route>
                <Route path="/mail/archive">
                    <PageSuspense><ArchivePage /></PageSuspense>
                </Route>
                <Route path="/mail/contacts">
                    <PageSuspense><ContactsPage /></PageSuspense>
                </Route>
                <Route path="/mail/:folder/:id">
                    <PageSuspense><EmailDetailPage /></PageSuspense>
                </Route>
                <Route path="/mail/compose">
                    <ComposeRouteBridge />
                </Route>
                <Route path="/mail/settings">
                    <PageSuspense><MailSettingsPage /></PageSuspense>
                </Route>
                <Route path="/mail/search">
                    <PageSuspense><SearchPage /></PageSuspense>
                </Route>
                <Route path="/mail">
                    <PageSuspense><InboxPage /></PageSuspense>
                </Route>
            </Switch>
        </MailLayout>
    )
}

function App() {
    const [location] = useLocation()

    return (
        <ThemeProvider defaultTheme="system">
            <QueryClientProvider client={queryClient}>
                <AuthProvider>
                    <MultiSessionProvider>
                    <MailboxProvider>
                        <ComposeProvider>
                            <BrandingHead />
                            <div className="min-h-screen bg-background">
                                {location.startsWith('/mail') ? (
                                    <MailCheck>
                                        <MailRoutes />
                                    </MailCheck>
                                ) : (
                                <Switch>
                                <Route path="/login">
                                    <PageSuspense><Login /></PageSuspense>
                                </Route>

                                <Route path="/admin">
                                    <AdminCheck>
                                        <AdminLayout>
                                            <PageSuspense><AdminDashboard /></PageSuspense>
                                        </AdminLayout>
                                    </AdminCheck>
                                </Route>
                                <Route path="/admin/organizations">
                                    <AdminCheck>
                                        <AdminLayout>
                                            <PageSuspense><OrganizationsPage /></PageSuspense>
                                        </AdminLayout>
                                    </AdminCheck>
                                </Route>
                                <Route path="/admin/organizations/:id">
                                    <AdminCheck>
                                        <AdminLayout>
                                            <PageSuspense><OrganizationDetailPage /></PageSuspense>
                                        </AdminLayout>
                                    </AdminCheck>
                                </Route>
                                <Route path="/admin/admins">
                                    <AdminCheck>
                                        <AdminLayout>
                                            <PageSuspense><AdminsPage /></PageSuspense>
                                        </AdminLayout>
                                    </AdminCheck>
                                </Route>
                                <Route path="/admin/branding">
                                    <AdminCheck>
                                        <AdminLayout>
                                            <PageSuspense><BrandingPage /></PageSuspense>
                                        </AdminLayout>
                                    </AdminCheck>
                                </Route>
                                <Route path="/admin/credentials">
                                    <AdminCheck>
                                        <AdminLayout>
                                            <PageSuspense><CredentialsPage /></PageSuspense>
                                        </AdminLayout>
                                    </AdminCheck>
                                </Route>
                                <Route path="/admin/routes">
                                    <AdminCheck>
                                        <AdminLayout>
                                            <PageSuspense><RoutesPage /></PageSuspense>
                                        </AdminLayout>
                                    </AdminCheck>
                                </Route>
                                <Route path="/admin/webhooks">
                                    <AdminCheck>
                                        <AdminLayout>
                                            <PageSuspense><WebhooksPage /></PageSuspense>
                                        </AdminLayout>
                                    </AdminCheck>
                                </Route>
                                <Route path="/admin/messages">
                                    <AdminCheck>
                                        <AdminLayout>
                                            <PageSuspense><MessagesPage /></PageSuspense>
                                        </AdminLayout>
                                    </AdminCheck>
                                </Route>

                                <Route path="/outreach">
                                    <AdminCheck>
                                        <OrganizationProvider>
                                            <PageSuspense><OutreachDashboard /></PageSuspense>
                                        </OrganizationProvider>
                                    </AdminCheck>
                                </Route>
                                <Route path="/outreach/campaigns/new">
                                    <AdminCheck>
                                        <OrganizationProvider>
                                            <PageSuspense><NewCampaignPage /></PageSuspense>
                                        </OrganizationProvider>
                                    </AdminCheck>
                                </Route>
                                <Route path="/outreach/campaigns/:id/sequences/new">
                                    <AdminCheck>
                                        <OrganizationProvider>
                                            <PageSuspense><NewSequencePage /></PageSuspense>
                                        </OrganizationProvider>
                                    </AdminCheck>
                                </Route>
                                <Route path="/outreach/campaigns/:id">
                                    <AdminCheck>
                                        <OrganizationProvider>
                                            <PageSuspense><CampaignDetailPage /></PageSuspense>
                                        </OrganizationProvider>
                                    </AdminCheck>
                                </Route>
                                <Route path="/outreach/campaigns">
                                    <AdminCheck>
                                        <OrganizationProvider>
                                            <PageSuspense><CampaignsPage /></PageSuspense>
                                        </OrganizationProvider>
                                    </AdminCheck>
                                </Route>
                                <Route path="/outreach/leads">
                                    <AdminCheck>
                                        <OrganizationProvider>
                                            <PageSuspense><LeadsPage /></PageSuspense>
                                        </OrganizationProvider>
                                    </AdminCheck>
                                </Route>
                                <Route path="/outreach/inboxes">
                                    <AdminCheck>
                                        <OrganizationProvider>
                                            <PageSuspense><InboxesPage /></PageSuspense>
                                        </OrganizationProvider>
                                    </AdminCheck>
                                </Route>
                                <Route path="/outreach/inboxes/new">
                                    <AdminCheck>
                                        <OrganizationProvider>
                                            <PageSuspense><NewInboxPage /></PageSuspense>
                                        </OrganizationProvider>
                                    </AdminCheck>
                                </Route>
                                <Route path="/outreach/sequences">
                                    <AdminCheck>
                                        <OrganizationProvider>
                                            <PageSuspense><SequencesPage /></PageSuspense>
                                        </OrganizationProvider>
                                    </AdminCheck>
                                </Route>
                                <Route path="/outreach/analytics">
                                    <AdminCheck>
                                        <OrganizationProvider>
                                            <PageSuspense><OutreachAnalyticsPage /></PageSuspense>
                                        </OrganizationProvider>
                                    </AdminCheck>
                                </Route>
                                <Route path="/outreach/settings">
                                    <AdminCheck>
                                        <OrganizationProvider>
                                            <PageSuspense><OutreachSettingsPage /></PageSuspense>
                                        </OrganizationProvider>
                                    </AdminCheck>
                                </Route>

                                <Route path="/">
                                    <RootRedirect />
                                </Route>
                            </Switch>
                                )}
                            <Toaster />
                            <ComposeDialogHost />
                        </div>
                        </ComposeProvider>
                    </MailboxProvider>
                    </MultiSessionProvider>
                </AuthProvider>
            </QueryClientProvider>
        </ThemeProvider>
    )
}

export default App

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <AppErrorBoundary>
            <App />
        </AppErrorBoundary>
    </React.StrictMode>
)
