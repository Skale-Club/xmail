import React from 'react'
import { Link, useLocation } from 'wouter'
import { useAuth } from '../../hooks/useAuth'
import { useOrganization } from '../../hooks/useOrganization'
import { useInboxUnreadCount } from '../../hooks/useUnifiedInbox'
import { useBranding } from '../../lib/branding'
import { supabase } from '../../lib/supabase'
import { AppLogo } from '../AppLogo'
import { Button } from '../ui/button'
import { DeployFooter } from '../DeployFooter'
import {
    ArrowLeft,
    Inbox,
    LayoutDashboard,
    Mail,
    Users,
    Target,
    Send,
    BarChart3,
    Settings,
    LogOut,
    Menu,
    X,
    Building2,
    ChevronDown,
} from 'lucide-react'

import { ModeToggle } from '../mode-toggle'

interface OutreachLayoutProps {
    children: React.ReactNode
}

interface NavItem {
    label: string
    href: string
    icon: React.ReactNode
}

const navItems: NavItem[] = [
    { label: 'Dashboard', href: '/outreach', icon: <LayoutDashboard className="w-5 h-5" /> },
    { label: 'Inbox', href: '/outreach/unified-inbox', icon: <Inbox className="w-5 h-5" /> },
    { label: 'Campaigns', href: '/outreach/campaigns', icon: <Target className="w-5 h-5" /> },
    { label: 'Leads', href: '/outreach/leads', icon: <Users className="w-5 h-5" /> },
    // Renamed from "Inboxes" to disambiguate sender-account management from the unified
    // Inbox workspace; the /outreach/inboxes URL is retained for link compatibility.
    { label: 'Sending accounts', href: '/outreach/inboxes', icon: <Mail className="w-5 h-5" /> },
    { label: 'Sequences', href: '/outreach/sequences', icon: <Send className="w-5 h-5" /> },
    { label: 'Analytics', href: '/outreach/analytics', icon: <BarChart3 className="w-5 h-5" /> },
    { label: 'Settings', href: '/outreach/settings', icon: <Settings className="w-5 h-5" /> },
]

/** Accessible unread badge for the Inbox nav item. Caps the visual at 99+, keeps the full
 *  count in the accessible name, and renders nothing while zero/loading. */
function InboxUnreadBadge() {
    const { currentOrganization } = useOrganization()
    const { data: unreadCount } = useInboxUnreadCount(currentOrganization?.id)

    if (!unreadCount || unreadCount <= 0) return null
    const display = unreadCount > 99 ? '99+' : String(unreadCount)

    return (
        <span
            className="ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[0.65rem] font-semibold leading-none text-primary-foreground"
            aria-label={`${unreadCount} unread conversations`}
        >
            <span aria-hidden="true">{display}</span>
        </span>
    )
}

export function OutreachLayout({ children }: OutreachLayoutProps) {
    const { user } = useAuth()
    const { branding } = useBranding()
    const { organizations, currentOrganization, setCurrentOrganization, isLoading } = useOrganization()
    const [location, navigate] = useLocation()
    const currentRole = currentOrganization?.role
    const roleLabel = currentRole ? currentRole.charAt(0).toUpperCase() + currentRole.slice(1) : 'Member'
    const isViewer = currentRole === 'viewer'
    const [sidebarOpen, setSidebarOpen] = React.useState(false)
    const [orgSelectorOpen, setOrgSelectorOpen] = React.useState(false)

    const handleSignOut = async () => {
        await supabase.auth.signOut()
        navigate('/login')
    }

    const handleOrganizationChange = (orgId: string) => {
        const org = organizations.find(o => o.id === orgId)
        if (org) {
            setCurrentOrganization(org)
        }
        setOrgSelectorOpen(false)
    }

    const isActiveRoute = (href: string) => {
        if (href === '/outreach') {
            return location === '/outreach'
        }
        return location.startsWith(href)
    }

    return (
        <div className="min-h-screen bg-background">
            {/* Mobile sidebar backdrop */}
            {sidebarOpen && (
                <div
                    className="fixed inset-0 z-40 bg-black/50 lg:hidden"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            {/* Sidebar */}
            <aside className={`
        fixed top-0 left-0 z-50 h-full w-64 bg-card border-r border-border
        transform transition-transform duration-300 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        lg:translate-x-0
      `}>
                <div className="flex h-full flex-col">
                    {/* Logo */}
                    <div className="flex h-16 items-center justify-between px-4 border-b">
                        <Link href="/outreach" className="flex items-center gap-3">
                            <AppLogo className="h-9 w-9 shrink-0" />
                            <div className="min-w-0">
                                <span className="block text-base font-bold leading-tight text-foreground">{branding.applicationName}</span>
                                <span className="block text-xs text-muted-foreground">Outreach</span>
                            </div>
                        </Link>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="lg:hidden"
                            onClick={() => setSidebarOpen(false)}
                        >
                            <X className="w-5 h-5" />
                        </Button>
                    </div>

                    {/* Organization Selector */}
                    <div className="px-4 py-3 border-b">
                        {isLoading ? (
                            <div className="h-10 bg-muted animate-pulse rounded-md" />
                        ) : organizations.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No organizations</p>
                        ) : (
                            <div className="relative">
                                <button
                                    onClick={() => setOrgSelectorOpen(!orgSelectorOpen)}
                                    className="flex items-center gap-2 w-full px-3 py-2 text-sm bg-muted/50 hover:bg-muted rounded-md border border-border transition-colors"
                                >
                                    <Building2 className="w-4 h-4 text-muted-foreground" />
                                    <span className="flex-1 text-left truncate font-medium">
                                        {currentOrganization?.name || 'Select Organization'}
                                    </span>
                                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                                </button>
                                {orgSelectorOpen && (
                                    <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-md shadow-lg z-10 max-h-60 overflow-y-auto">
                                        {organizations.map((org) => (
                                            <button
                                                key={org.id}
                                                onClick={() => handleOrganizationChange(org.id)}
                                                className={`w-full px-3 py-2 text-sm text-left hover:bg-accent transition-colors ${
                                                    currentOrganization?.id === org.id ? 'bg-accent text-accent-foreground' : ''
                                                }`}
                                            >
                                                <span className="block truncate">{org.name}</span>
                                                <span className="block text-xs text-muted-foreground capitalize">{org.role}</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Navigation */}
                    <nav className="flex-1 overflow-y-auto p-4">
                        <div className="space-y-1">
                            {navItems.map((item) => (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                                        isActiveRoute(item.href)
                                            ? 'bg-accent text-accent-foreground'
                                            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                                    }`}
                                    onClick={() => setSidebarOpen(false)}
                                >
                                    {item.icon}
                                    <span>{item.label}</span>
                                    {item.href === '/outreach/unified-inbox' && <InboxUnreadBadge />}
                                </Link>
                            ))}
                        </div>
                    </nav>

                    {/* User section */}
                    <div className="border-t p-4">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground font-semibold">
                                {user?.email?.charAt(0).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{user?.email}</p>
                                <p className="text-xs text-muted-foreground capitalize">{roleLabel}</p>
                            </div>
                        </div>
                        <Button
                            variant="ghost"
                            className="w-full justify-start text-muted-foreground border border-border/50"
                            onClick={handleSignOut}
                        >
                            <LogOut className="w-4 h-4 mr-2" />
                            Logout
                        </Button>
                        <DeployFooter />
                    </div>
                </div>
            </aside>

            {/* Main content */}
            <div className="lg:pl-64">
                {/* Top bar */}
                <header className="sticky top-0 z-30 h-16 bg-background/80 backdrop-blur-md border-b border-border">
                    <div className="flex items-center justify-between h-full px-4">
                        <button
                            className="lg:hidden p-2 rounded-md hover:bg-accent text-muted-foreground transition-colors"
                            onClick={() => setSidebarOpen(true)}
                        >
                            <Menu className="w-6 h-6" />
                        </button>
                        <div className="flex-1" />
                        {isViewer && (
                            <span className="inline-flex items-center rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                                Read-only access
                            </span>
                        )}
                        <div className="flex items-center gap-4">
                            <button
                                onClick={() => navigate('/mail/inbox')}
                                className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                            >
                                <Inbox className="w-4 h-4" />
                                <span className="hidden sm:inline">Open Inbox</span>
                            </button>
                            <button
                                onClick={() => navigate('/admin')}
                                className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                            >
                                <ArrowLeft className="w-4 h-4" />
                                <span className="hidden sm:inline">Exit Outreach</span>
                            </button>
                            <ModeToggle />
                        </div>
                    </div>
                </header>

                {/* Page content */}
                <main className="p-4 lg:p-6 bg-background">
                    {children}
                </main>
            </div>
        </div>
    )
}

export default OutreachLayout
