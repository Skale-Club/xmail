import React from 'react'
import { Link, useLocation } from 'wouter'
import { useBranding } from '../../lib/branding'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useGoToShortcuts, useKeyboardShortcutHelp } from '../../hooks/useKeyboardShortcuts'
import { FOCUS_MAILBOX_SEARCH_EVENT } from './mailbox-navigation'
import { findFolderByKind } from './folder-lookup'
import { AppLogo } from '../AppLogo'
import { ModeToggle } from '../mode-toggle'
import { DeployFooter } from '../DeployFooter'
import { supabase } from '../../lib/supabase'
import { MailboxSidebarSwitcher } from './MailboxSidebarSwitcher'
import { UserAccountMenu } from './UserAccountMenu'
import { CommandPalette } from '../ui/command-palette'
import { KeyboardShortcutsHelp, KeyboardShortcutsButton } from './KeyboardShortcutsHelp'
import { useAuth } from '../../hooks/useAuth'
import {
    Inbox,
    Send,
    FileText,
    Trash2,
    Star,
    Settings,
    Menu,
    X,
    Search,
    Plus,
    Archive,
    ShieldAlert,
    Users,
    Shield,
    Target
} from 'lucide-react'
import { useFolders } from '../../hooks/useMail'
import { NotificationBell } from './NotificationBell'
import { useCompose } from '../../hooks/useCompose'

const MailLayoutContext = React.createContext(false)

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'xmail:mail:sidebar-collapsed'

function readSidebarCollapsed(): boolean {
    try {
        return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
    } catch {
        return false
    }
}

function writeSidebarCollapsed(collapsed: boolean) {
    try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0')
    } catch {
        // Storage blocked: the sidebar just forgets its state on reload.
    }
}

interface MailLayoutProps {
    children: React.ReactNode
}

interface FolderItem {
    id: string
    label: string
    icon: React.ReactNode
    href: string
    badge?: number
}

interface SidebarContentProps {
    isCollapsed: boolean
    setIsCollapsed: (v: boolean) => void
    isMobile: boolean
    location: string
    branding: { applicationName: string }
    closeSidebar: () => void
    openCompose: () => void
}

function SidebarContent({ isCollapsed, setIsCollapsed, isMobile, location, branding, closeSidebar, openCompose }: SidebarContentProps) {
    const { data: foldersData } = useFolders()
    const inboxUnread = findFolderByKind(foldersData?.folders, 'inbox')?.unread ?? 0
    const spamUnread = foldersData?.folders.find(f => f.type === 'spam')?.unread ?? 0
    const archiveUnread = foldersData?.folders.find(
        f => f.type === 'archive' || f.remoteId === 'Archive'
    )?.unread ?? 0

    const isActiveRoute = (href: string) => location.startsWith(href)

    const folders: FolderItem[] = [
        { id: 'inbox',   label: 'Inbox',   icon: <Inbox className="w-5 h-5" />,   href: '/mail/inbox', badge: inboxUnread || undefined },
        { id: 'sent',    label: 'Sent',    icon: <Send className="w-5 h-5" />,    href: '/mail/sent' },
        { id: 'starred', label: 'Starred', icon: <Star className="w-5 h-5" />,    href: '/mail/starred' },
        { id: 'archive', label: 'Archive', icon: <Archive className="w-5 h-5" />, href: '/mail/archive', badge: archiveUnread || undefined },
        { id: 'drafts',  label: 'Drafts',  icon: <FileText className="w-5 h-5" />, href: '/mail/drafts' },
        { id: 'spam',    label: 'Spam',    icon: <ShieldAlert className="w-5 h-5 text-amber-500" />, href: '/mail/spam', badge: spamUnread || undefined },
        { id: 'trash',   label: 'Trash',   icon: <Trash2 className="w-5 h-5 text-muted-foreground group-hover:text-destructive transition-colors" />, href: '/mail/trash' },
        { id: 'contacts', label: 'Contacts', icon: <Users className="w-5 h-5" />, href: '/mail/contacts' },
    ]

    return (
        <>
        <div className="flex items-center justify-between h-16 px-4 border-b border-border">
            <div className="flex items-center gap-3 overflow-hidden">
                <button
                    onClick={() => setIsCollapsed(!isCollapsed)}
                    className="p-2 rounded-lg hover:bg-accent text-muted-foreground shrink-0 hidden lg:block"
                    title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                    aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                >
                    <Menu className="w-5 h-5" />
                </button>
                {(!isCollapsed || isMobile) && (
                    <Link href="/mail/inbox" className="flex items-center gap-2" onClick={closeSidebar}>
                        <AppLogo className="h-8 w-8 shrink-0" />
                        <span className="text-lg font-bold tracking-tight text-foreground truncate">{branding.applicationName}</span>
                    </Link>
                )}
            </div>
            {isMobile && (
                <button
                    className="p-2 rounded-lg hover:bg-accent text-muted-foreground transition-colors"
                    onClick={closeSidebar}
                    aria-label="Close sidebar"
                >
                    <X className="w-5 h-5" />
                </button>
            )}
        </div>

        <MailboxSidebarSwitcher
            collapsed={isCollapsed && !isMobile}
            isMobile={isMobile}
            onNavigate={closeSidebar}
        />

        <div className={`p-4 ${isCollapsed && !isMobile ? 'px-3' : ''}`}>
            <button
                onClick={() => { closeSidebar(); openCompose(); }}
                className={`flex items-center justify-center gap-2 w-full ${isCollapsed && !isMobile ? 'p-2.5' : 'px-4 py-2.5'} bg-primary hover:bg-primary/90 rounded-xl font-medium text-primary-foreground shadow-sm-soft transition-all duration-200`}
                title={isCollapsed && !isMobile ? "Compose" : undefined}
            >
                <Plus className="w-5 h-5 shrink-0" />
                {(!isCollapsed || isMobile) && <span>Compose</span>}
            </button>
        </div>

        <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto">
            {folders.map((folder) => (
                <Link
                    key={folder.id}
                    href={folder.href}
                    className={`
                        flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200
                        ${isActiveRoute(folder.href)
                            ? 'bg-accent text-accent-foreground'
                            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                        }
                        ${isCollapsed && !isMobile ? 'justify-center px-0' : ''}
                    `}
                    title={isCollapsed && !isMobile ? folder.label : undefined}
                    aria-current={isActiveRoute(folder.href) ? 'page' : undefined}
                    onClick={closeSidebar}
                >
                    <span className="shrink-0">{folder.icon}</span>
                    {(!isCollapsed || isMobile) && (
                        <>
                            <span className="flex-1">{folder.label}</span>
                            {folder.badge ? (
                                <span
                                    className="px-2 py-0.5 text-xs font-bold bg-primary text-primary-foreground rounded-full"
                                    aria-label={`${folder.badge} unread`}
                                >
                                    {folder.badge > 99 ? '99+' : folder.badge}
                                </span>
                            ) : null}
                        </>
                    )}
                </Link>
            ))}
        </nav>

        <div className="p-4 border-t border-border">
            <Link
                href="/mail/settings"
                className={`
                    flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200
                    ${isActiveRoute('/mail/settings')
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                    }
                    ${isCollapsed && !isMobile ? 'justify-center px-0' : ''}
                `}
                title={isCollapsed && !isMobile ? "Settings" : undefined}
                onClick={closeSidebar}
            >
                <Settings className="w-5 h-5 shrink-0" />
                {(!isCollapsed || isMobile) && <span>Settings</span>}
            </Link>
            {(!isCollapsed || isMobile) && <DeployFooter />}
        </div>
        </>
    )
}

interface MobileBottomNavProps {
    location: string
    onOpenSidebar: () => void
    openCompose: () => void
}

function MobileBottomNav({ location, onOpenSidebar, openCompose }: MobileBottomNavProps) {
    const isActiveRoute = (href: string) => location.startsWith(href)

    return (
        <nav className="fixed bottom-0 left-0 right-0 z-30 bg-background border-t border-border flex items-center justify-around py-2 lg:hidden safe-area-bottom">
            <Link
                href="/mail/inbox"
                className={`flex flex-col items-center gap-1 px-4 py-1 rounded-lg transition-colors ${
                    isActiveRoute('/mail/inbox') ? 'text-primary' : 'text-muted-foreground'
                }`}
            >
                <Inbox className="w-5 h-5" />
                <span className="text-xs">Inbox</span>
            </Link>
            <Link
                href="/mail/sent"
                className={`flex flex-col items-center gap-1 px-4 py-1 rounded-lg transition-colors ${
                    isActiveRoute('/mail/sent') ? 'text-primary' : 'text-muted-foreground'
                }`}
            >
                <Send className="w-5 h-5" />
                <span className="text-xs">Sent</span>
            </Link>
            <button
                onClick={openCompose}
                className="flex items-center justify-center w-12 h-12 text-primary bg-primary/10 rounded-full shadow-lg"
                aria-label="Compose"
            >
                <Plus className="w-6 h-6" />
            </button>
            <Link
                href="/mail/starred"
                className={`flex flex-col items-center gap-1 px-4 py-1 rounded-lg transition-colors ${
                    isActiveRoute('/mail/starred') ? 'text-primary' : 'text-muted-foreground'
                }`}
            >
                <Star className="w-5 h-5" />
                <span className="text-xs">Starred</span>
            </Link>
            <button
                onClick={onOpenSidebar}
                className="flex flex-col items-center gap-1 px-4 py-1 text-muted-foreground"
            >
                <Menu className="w-5 h-5" />
                <span className="text-xs">Menu</span>
            </button>
        </nav>
    )
}

function MailLayoutFrame({ children }: MailLayoutProps) {
    const { branding } = useBranding()
    const { isAdmin } = useAuth()
    const isMobile = useIsMobile()
    const { isOpen: shortcutsOpen, openHelp: openShortcuts, closeHelp: closeShortcuts } = useKeyboardShortcutHelp()
    const [location, navigate] = useLocation()
    const [sidebarOpen, setSidebarOpen] = React.useState(false)
    const [isCollapsed, setIsCollapsedState] = React.useState(readSidebarCollapsed)
    const setIsCollapsed = React.useCallback((value: boolean) => {
        setIsCollapsedState(value)
        writeSidebarCollapsed(value)
    }, [])
    const [searchOpen, setSearchOpen] = React.useState(false)
    const [searchQuery, setSearchQuery] = React.useState('')

    const handleSignOut = async () => {
        await supabase.auth.signOut()
        window.location.href = '/login'
    }

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault()
        if (searchQuery.trim()) {
            navigate(`/mail/search?q=${encodeURIComponent(searchQuery)}`)
            setSearchOpen(false)
        }
    }

    // "g then i/s/d" jump to a folder, "g then m" jumps to the mailbox switcher.
    useGoToShortcuts({
        actions: {
            i: () => navigate('/mail/inbox'),
            s: () => navigate('/mail/sent'),
            d: () => navigate('/mail/drafts'),
            m: () => window.dispatchEvent(new Event(FOCUS_MAILBOX_SEARCH_EVENT)),
        },
    })

    const closeSidebar = React.useCallback(() => setSidebarOpen(false), [])
    const openSidebar = React.useCallback(() => setSidebarOpen(true), [])
    const { openCompose } = useCompose()

    return (
        <div className="min-h-screen bg-background">
            {sidebarOpen && (
                <div
                    className="fixed inset-0 z-40 bg-black/50 lg:hidden"
                    onClick={closeSidebar}
                />
            )}

            <div className="flex h-screen">
                {!isMobile && (
                    <aside className={`${isCollapsed ? 'w-[72px]' : 'w-72'} shrink-0 h-full bg-card border-r border-border flex flex-col transition-all duration-300 ease-in-out`}>
                        <SidebarContent isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} isMobile={isMobile} location={location} branding={branding} closeSidebar={closeSidebar} openCompose={openCompose} />
                    </aside>
                )}

                {isMobile && sidebarOpen && (
                    <aside className="fixed top-0 left-0 z-50 h-full w-72 bg-card border-r border-border shadow-lg flex flex-col animate-slide-in-left">
                        <SidebarContent isCollapsed={isCollapsed} setIsCollapsed={setIsCollapsed} isMobile={isMobile} location={location} branding={branding} closeSidebar={closeSidebar} openCompose={openCompose} />
                    </aside>
                )}

                <div className="flex-1 flex flex-col min-w-0">
                    <header className="h-16 bg-background/80 backdrop-blur-md border-b border-border flex items-center justify-between px-4 sm:px-6 sticky top-0 z-30">
                        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-4">
                            {isMobile && (
                                <button
                                    className="p-2 rounded-lg hover:bg-accent hover:text-accent-foreground text-muted-foreground shrink-0"
                                    onClick={() => setSidebarOpen(true)}
                                    aria-label="Open sidebar"
                                >
                                    <Menu className="w-5 h-5" />
                                </button>
                            )}

                            {isMobile ? (
                                searchOpen ? (
                                    <form onSubmit={handleSearch} className="flex min-w-0 flex-1 items-center gap-2" role="search">
                                        <input
                                            aria-label="Search emails"
                                            type="text"
                                            placeholder="Search emails..."
                                            value={searchQuery}
                                            onChange={(e) => setSearchQuery(e.target.value)}
                                            className="min-w-0 flex-1 px-4 py-2 bg-muted/50 border border-transparent rounded-lg text-sm focus:bg-background focus:border-border focus:ring-4 focus:ring-primary/10 transition-all outline-none"
                                            autoFocus
                                        />
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setSearchOpen(false)
                                                setSearchQuery('')
                                            }}
                                            className="p-2 rounded-lg hover:bg-accent text-muted-foreground"
                                            aria-label="Close search"
                                        >
                                            <X className="w-5 h-5" />
                                        </button>
                                    </form>
                                ) : (
                                    <Link href="/mail/inbox" className="flex min-w-0 items-center gap-2">
                                        <AppLogo className="h-8 w-8 shrink-0" />
                                        {/* Truncates instead of wrapping; dropped entirely on very narrow phones. */}
                                        <span className="hidden min-w-0 truncate whitespace-nowrap font-bold text-foreground min-[480px]:inline">{branding.applicationName}</span>
                                    </Link>
                                )
                            ) : (
                                <form onSubmit={handleSearch} className="relative w-full min-w-0 max-w-sm lg:max-w-md" role="search">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                                    <input
                                        type="text"
                                        placeholder="Search emails..."
                                        aria-label="Search emails"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        className="w-full pl-10 pr-4 py-2 bg-muted/50 border border-transparent rounded-lg text-sm focus:bg-background focus:border-border focus:ring-4 focus:ring-primary/10 transition-all outline-none shadow-sm-soft"
                                    />
                                </form>
                            )}
                        </div>

                        <div className={`${isMobile && searchOpen ? 'hidden' : 'flex'} shrink-0 items-center gap-1 xl:gap-3`}>
                            {/* Same two "switch area" actions as AdminLayout/OutreachLayout: Admin
                                only for platform admins, Outreach always, current area omitted. */}
                            {isAdmin && (
                                <Link
                                    href="/admin"
                                    aria-label="Open Admin"
                                    title="Open Admin"
                                    className="hidden shrink-0 items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:flex xl:px-3"
                                >
                                    <Shield className="w-4 h-4" />
                                    <span className="hidden whitespace-nowrap xl:inline">Open Admin</span>
                                </Link>
                            )}

                            {/* Visible to every user — the outreach gate on the other side
                                decides whether they actually have access. */}
                            <Link
                                href="/outreach"
                                aria-label="Open Outreach"
                                title="Open Outreach"
                                className="hidden shrink-0 items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:flex xl:px-3"
                            >
                                <Target className="w-4 h-4" />
                                <span className="hidden whitespace-nowrap xl:inline">Open Outreach</span>
                            </Link>

                            {isMobile && !searchOpen && (
                                <button
                                    onClick={() => setSearchOpen(true)}
                                    className="p-2 rounded-xl hover:bg-accent hover:text-accent-foreground text-muted-foreground transition-colors"
                                    aria-label="Search"
                                >
                                    <Search className="w-5 h-5" />
                                </button>
                            )}
                            
                            <NotificationBell />
                            
                            {/* Keyboard hint is only useful with a keyboard-sized screen. */}
                            <div className="hidden lg:block">
                                <KeyboardShortcutsButton onClick={openShortcuts} />
                            </div>
                            <ModeToggle />

                            <UserAccountMenu onSignOut={handleSignOut} />
                        </div>
                    </header>

                    <main className={`flex-1 overflow-hidden bg-background ${isMobile ? 'pb-20' : ''}`}>
                        {children}
                    </main>
                </div>
            </div>

            {isMobile && <MobileBottomNav location={location} onOpenSidebar={openSidebar} openCompose={openCompose} />}

            <KeyboardShortcutsHelp isOpen={shortcutsOpen} onClose={closeShortcuts} />
            <CommandPalette area="mail" isAdmin={!!isAdmin} />
        </div>
    )
}

export function MailLayout({ children }: MailLayoutProps) {
    const isNestedLayout = React.useContext(MailLayoutContext)

    if (isNestedLayout) {
        return <>{children}</>
    }

    return (
        <MailLayoutContext.Provider value={true}>
            <MailLayoutFrame>{children}</MailLayoutFrame>
        </MailLayoutContext.Provider>
    )
}
