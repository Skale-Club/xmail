import * as React from 'react'
import { useLocation } from 'wouter'
import {
    Inbox,
    Send,
    Star,
    Archive,
    FileText,
    ShieldAlert,
    Trash2,
    Users,
    Settings,
    Search as SearchIcon,
    Target,
    Shield,
    LayoutDashboard,
    Mail,
    BarChart3,
    Bot,
    Building2,
    UserCog,
    Palette,
    Zap,
} from 'lucide-react'
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
} from './command'

export type CommandPaletteArea = 'admin' | 'mail' | 'outreach'

interface CommandPaletteProps {
    /** Which layout is currently mounting the palette. */
    area: CommandPaletteArea
    /** Whether the signed-in user is a platform admin — gates the "Open Admin" switch. */
    isAdmin: boolean
}

interface PaletteItem {
    label: string
    href: string
    icon: React.ReactNode
}

const areaSwitches: Record<CommandPaletteArea, PaletteItem> = {
    mail: { label: 'Open Inbox', href: '/mail/inbox', icon: <Inbox className="h-4 w-4" /> },
    outreach: { label: 'Open Outreach', href: '/outreach', icon: <Target className="h-4 w-4" /> },
    admin: { label: 'Open Admin', href: '/admin', icon: <Shield className="h-4 w-4" /> },
}

const areaPages: Record<CommandPaletteArea, PaletteItem[]> = {
    mail: [
        { label: 'Inbox', href: '/mail/inbox', icon: <Inbox className="h-4 w-4" /> },
        { label: 'Sent', href: '/mail/sent', icon: <Send className="h-4 w-4" /> },
        { label: 'Starred', href: '/mail/starred', icon: <Star className="h-4 w-4" /> },
        { label: 'Archive', href: '/mail/archive', icon: <Archive className="h-4 w-4" /> },
        { label: 'Drafts', href: '/mail/drafts', icon: <FileText className="h-4 w-4" /> },
        { label: 'Spam', href: '/mail/spam', icon: <ShieldAlert className="h-4 w-4" /> },
        { label: 'Trash', href: '/mail/trash', icon: <Trash2 className="h-4 w-4" /> },
        { label: 'Contacts', href: '/mail/contacts', icon: <Users className="h-4 w-4" /> },
        { label: 'Search', href: '/mail/search', icon: <SearchIcon className="h-4 w-4" /> },
        { label: 'Mail Settings', href: '/mail/settings', icon: <Settings className="h-4 w-4" /> },
    ],
    outreach: [
        { label: 'Dashboard', href: '/outreach', icon: <LayoutDashboard className="h-4 w-4" /> },
        { label: 'Unified Inbox', href: '/outreach/unified-inbox', icon: <Inbox className="h-4 w-4" /> },
        { label: 'Campaigns', href: '/outreach/campaigns', icon: <Target className="h-4 w-4" /> },
        { label: 'Leads', href: '/outreach/leads', icon: <Users className="h-4 w-4" /> },
        { label: 'Agent ops', href: '/outreach/agent-ops', icon: <Bot className="h-4 w-4" /> },
        { label: 'Sending accounts', href: '/outreach/inboxes', icon: <Mail className="h-4 w-4" /> },
        { label: 'Sequences', href: '/outreach/sequences', icon: <Send className="h-4 w-4" /> },
        { label: 'Analytics', href: '/outreach/analytics', icon: <BarChart3 className="h-4 w-4" /> },
        { label: 'Outreach Settings', href: '/outreach/settings', icon: <Settings className="h-4 w-4" /> },
    ],
    admin: [
        { label: 'Dashboard', href: '/admin', icon: <LayoutDashboard className="h-4 w-4" /> },
        { label: 'Organizations', href: '/admin/organizations', icon: <Building2 className="h-4 w-4" /> },
        { label: 'Users', href: '/admin/users', icon: <Users className="h-4 w-4" /> },
        { label: 'Admins', href: '/admin/admins', icon: <UserCog className="h-4 w-4" /> },
        { label: 'Branding', href: '/admin/branding', icon: <Palette className="h-4 w-4" /> },
        { label: 'Integrations', href: '/admin/integrations', icon: <Zap className="h-4 w-4" /> },
    ],
}

const areaLabels: Record<CommandPaletteArea, string> = {
    mail: 'Inbox',
    outreach: 'Outreach',
    admin: 'Admin',
}

/**
 * Small, shared Ctrl/Cmd+K command palette. Mounted once per layout (Admin/Mail/Outreach) —
 * lists the two cross-area "switch area" actions (the current area omitted, Admin only for
 * platform admins) plus the current area's main pages. Intentionally minimal: no fuzzy
 * indexing beyond cmdk's built-in filter, no recent-items memory.
 */
export function CommandPalette({ area, isAdmin }: CommandPaletteProps) {
    const [open, setOpen] = React.useState(false)
    const [, navigate] = useLocation()

    React.useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                setOpen((current) => !current)
            }
        }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [])

    const go = React.useCallback((href: string) => {
        setOpen(false)
        navigate(href)
    }, [navigate])

    const switches = (Object.keys(areaSwitches) as CommandPaletteArea[])
        .filter((key) => key !== area)
        .filter((key) => key !== 'admin' || isAdmin)

    return (
        <CommandDialog open={open} onOpenChange={setOpen}>
            <CommandInput placeholder="Jump to a page or switch area..." />
            <CommandList>
                <CommandEmpty>No results found.</CommandEmpty>
                {switches.length > 0 && (
                    <>
                        <CommandGroup heading="Switch area">
                            {switches.map((key) => (
                                <CommandItem key={key} value={areaSwitches[key].label} onSelect={() => go(areaSwitches[key].href)}>
                                    {areaSwitches[key].icon}
                                    {areaSwitches[key].label}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                        <CommandSeparator />
                    </>
                )}
                <CommandGroup heading={areaLabels[area]}>
                    {areaPages[area].map((item) => (
                        <CommandItem key={item.href} value={item.label} onSelect={() => go(item.href)}>
                            {item.icon}
                            {item.label}
                        </CommandItem>
                    ))}
                </CommandGroup>
            </CommandList>
        </CommandDialog>
    )
}
