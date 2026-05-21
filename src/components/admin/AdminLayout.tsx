import { ReactNode, useState } from 'react'
import { useLocation } from 'wouter'
import { useAuth } from '../../hooks/useAuth'
import { useBranding } from '../../lib/branding'
import { supabase } from '../../lib/supabase'
import { AppLogo } from '../AppLogo'
import { Button } from '../ui/button'
import { ModeToggle } from '../mode-toggle'
import { DeployFooter } from '../DeployFooter'
import {
    ArrowRight,
    Building2,
    Shield,
    LogOut,
    Menu,
    X,
    Home,
    Palette,
    Target,
    Inbox,
    Zap,
} from 'lucide-react'

interface NavItem {
    label: string
    href: string
    icon: ReactNode
}

const navItems: NavItem[] = [
    { label: 'Dashboard', href: '/admin', icon: <Home className="w-5 h-5" /> },
    { label: 'Organizations', href: '/admin/organizations', icon: <Building2 className="w-5 h-5" /> },
    { label: 'Admins', href: '/admin/admins', icon: <Shield className="w-5 h-5" /> },
    { label: 'Branding', href: '/admin/branding', icon: <Palette className="w-5 h-5" /> },
    { label: 'Integrations', href: '/admin/integrations', icon: <Zap className="w-5 h-5" /> },
]

interface AdminLayoutProps {
    children: ReactNode
}

export default function AdminLayout({ children }: AdminLayoutProps) {
    const [location, navigate] = useLocation()
    const { user } = useAuth()
    const { branding } = useBranding()
    const [sidebarOpen, setSidebarOpen] = useState(false)

    const isActive = (href: string) => {
        if (href === '/admin') {
            return location === '/admin'
        }
        return location.startsWith(href)
    }

    const handleLogout = async () => {
        await supabase.auth.signOut()
        navigate('/login')
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
            <aside
                className={`fixed top-0 left-0 z-50 h-full w-64 transform bg-card border-r transition-transform duration-200 ease-in-out lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
                    }`}
            >
                <div className="flex h-full flex-col">
                    {/* Logo */}
                    <div className="flex h-16 items-center justify-between px-4 border-b">
                        <div className="flex items-center gap-3">
                            <AppLogo className="h-9 w-9 shrink-0" />
                            <div className="min-w-0">
                                <span className="block text-base font-bold leading-tight text-foreground">{branding.applicationName}</span>
                                <span className="block text-xs text-muted-foreground">Admin Panel</span>
                            </div>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="lg:hidden"
                            onClick={() => setSidebarOpen(false)}
                        >
                            <X className="w-5 h-5" />
                        </Button>
                    </div>

                    {/* Navigation */}
                    <nav className="flex-1 overflow-y-auto p-4">
                        <ul className="space-y-1">
                            {navItems.map((item) => (
                                <li key={item.href}>
                                    <button
                                        onClick={() => {
                                            navigate(item.href)
                                            setSidebarOpen(false)
                                        }}
                                        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${isActive(item.href)
                                                ? 'bg-accent text-accent-foreground'
                                                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                                            }`}
                                    >
                                        {item.icon}
                                        {item.label}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </nav>

                    {/* User section */}
                    <div className="border-t p-4">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground font-semibold">
                                {user?.email?.charAt(0).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{user?.email}</p>
                                <p className="text-xs text-muted-foreground">Administrator</p>
                            </div>
                        </div>
                        <Button
                            variant="ghost"
                            className="w-full justify-start text-muted-foreground border border-border/50"
                            onClick={handleLogout}
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
                <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-border bg-background/80 backdrop-blur-md px-4 lg:px-6">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="lg:hidden"
                        onClick={() => setSidebarOpen(true)}
                    >
                        <Menu className="w-5 h-5" />
                    </Button>
                    <div className="flex-1">
                        <h1 className="text-lg font-semibold">
                            {navItems.find((item) => isActive(item.href))?.label || 'Admin Panel'}
                        </h1>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-2"
                            onClick={() => navigate('/mail/inbox')}
                        >
                            <Inbox className="w-4 h-4" />
                            <span className="hidden sm:inline">Open Inbox</span>
                            <ArrowRight className="w-4 h-4 hidden sm:inline" />
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-2"
                            onClick={() => navigate('/outreach')}
                        >
                            <Target className="w-4 h-4" />
                            <span className="hidden sm:inline">Open Outreach</span>
                            <ArrowRight className="w-4 h-4 hidden sm:inline" />
                        </Button>
                        <ModeToggle />
                    </div>
                </header>

                {/* Page content */}
                <main className="p-4 lg:p-6">{children}</main>
            </div>
        </div>
    )
}
