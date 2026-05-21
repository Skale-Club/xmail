import React from 'react'
import { Link } from 'wouter'
import { useMailbox, getProviderColor, getProviderIcon, type Mailbox } from '../../hooks/useMailbox'
import { useMultiSession } from '../../hooks/useMultiSession'
import { useAuth } from '../../hooks/useAuth'
import { ConnectMailboxDialog } from './ConnectMailboxDialog'
import { Plus, Check, AlertCircle, ChevronDown, Mail, RefreshCw, Settings, LogOut, Copy, Trash2 } from 'lucide-react'
import { toast } from '../../components/ui/toaster'

interface AccountSwitcherProps {
    compact?: boolean
    showSignOut?: boolean
    onSignOut?: () => void
}

export function AccountSwitcher({ compact = false, showSignOut = false, onSignOut }: AccountSwitcherProps) {
    const { user } = useAuth()
    const { mailboxes, selectedMailbox, setSelectedMailbox, isLoading, refreshMailboxes } = useMailbox()
    const { sessions, activeSessionId, switchSession, removeAccount } = useMultiSession()
    const [isOpen, setIsOpen] = React.useState(false)
    const [showConnectDialog, setShowConnectDialog] = React.useState(false)
    const [switchingId, setSwitchingId] = React.useState<string | null>(null)

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-lg animate-pulse">
                <div className="w-8 h-8 rounded-full bg-muted" />
                {!compact && <div className="w-24 h-4 bg-muted rounded" />}
            </div>
        )
    }

    if (mailboxes.length === 0 && !showSignOut) {
        return (
            <>
                <button
                    onClick={() => setShowConnectDialog(true)}
                    className="flex items-center gap-2 px-3 py-2 bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors"
                >
                    <Plus className="w-5 h-5" />
                    <span className="text-sm font-medium">Add Account</span>
                </button>
                <ConnectMailboxDialog
                    open={showConnectDialog}
                    onOpenChange={setShowConnectDialog}
                />
            </>
        )
    }

    const userInitial = user?.user_metadata?.firstName?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || 'U'
    const userName = user?.user_metadata?.firstName || user?.email?.split('@')[0] || 'User'
    const mailboxContextLabel = selectedMailbox
        ? selectedMailbox.email.toLowerCase() === user?.email?.toLowerCase()
            ? `Mailbox: ${selectedMailbox.email}`
            : `Viewing: ${selectedMailbox.email}`
        : 'No mailbox selected'

    const hasMultipleSessions = sessions.length > 1

    const handleSwitchSession = async (userId: string) => {
        if (userId === activeSessionId) {
            setIsOpen(false)
            return
        }
        setSwitchingId(userId)
        try {
            await switchSession(userId)
            setIsOpen(false)
        } catch (err) {
            toast({
                title: 'Failed to switch account',
                description: err instanceof Error ? err.message : 'Unknown error',
                variant: 'destructive',
            })
        } finally {
            setSwitchingId(null)
        }
    }

    const handleRemoveSession = async (userId: string) => {
        try {
            await removeAccount(userId)
            toast({ title: 'Account removed', variant: 'success' })
        } catch {
            toast({ title: 'Failed to remove account', variant: 'destructive' })
        }
    }

    return (
        <>
            <div className="relative">
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    className={`
                        flex items-center gap-2 rounded-xl transition-colors
                        ${showSignOut
                            ? 'px-2 sm:px-3 py-2 hover:bg-accent'
                            : compact
                                ? 'p-2 hover:bg-accent w-full'
                                : 'px-3 py-2 bg-accent/50 hover:bg-accent w-full'
                        }
                    `}
                >
                    {showSignOut ? (
                        <>
                            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-primary flex items-center justify-center text-primary-foreground font-semibold text-sm">
                                {userInitial}
                            </div>
                            <div className="hidden sm:flex flex-col items-start min-w-0">
                                <span className="text-sm font-medium text-foreground truncate max-w-[180px]">
                                    {userName}
                                </span>
                                <span className="text-xs text-muted-foreground truncate max-w-[180px]">
                                    {mailboxContextLabel}
                                </span>
                            </div>
                        </>
                    ) : selectedMailbox ? (
                        <>
                            <div className={`w-8 h-8 rounded-full ${getProviderColor(selectedMailbox.provider)} flex items-center justify-center text-white text-sm font-bold`}>
                                {getProviderIcon(selectedMailbox.provider)}
                            </div>
                            {!compact && (
                                <>
                                    <div className="flex flex-col items-start min-w-0">
                                        <span className="text-sm font-medium text-foreground truncate max-w-[120px] sm:max-w-[180px]">
                                            {selectedMailbox.displayName || selectedMailbox.email?.split('@')[0]}
                                        </span>
                                        <span className="text-xs text-muted-foreground truncate max-w-[120px] sm:max-w-[180px]">
                                            {selectedMailbox.email}
                                        </span>
                                    </div>
                                    {selectedMailbox.unreadCount && selectedMailbox.unreadCount > 0 && (
                                        <span className="px-2 py-0.5 text-xs font-bold bg-primary text-primary-foreground rounded-full">
                                            {selectedMailbox.unreadCount > 99 ? '99+' : selectedMailbox.unreadCount}
                                        </span>
                                    )}
                                </>
                            )}
                        </>
                    ) : (
                        <div className="w-8 h-8 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
                            <Mail className="w-4 h-4 text-gray-600 dark:text-gray-300" />
                        </div>
                    )}
                    <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''} hidden sm:block`} />
                </button>

                {isOpen && (
                    <>
                        <div
                            className="fixed inset-0 z-40"
                            onClick={() => setIsOpen(false)}
                        />
                        <div className="absolute right-0 z-50 bg-popover border border-border rounded-xl shadow-xl pb-2 mt-2 w-80 overflow-hidden flex flex-col">
                            {hasMultipleSessions && (
                                <>
                                    <div className="px-3 pt-3 pb-1">
                                        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Sessions</span>
                                    </div>
                                    <div className="max-h-32 overflow-y-auto">
                                        {sessions.map((session) => (
                                            <SessionItem
                                                key={session.userId}
                                                session={session}
                                                isActive={session.userId === activeSessionId}
                                                isSwitching={session.userId === switchingId}
                                                onSwitch={() => handleSwitchSession(session.userId)}
                                                onRemove={() => handleRemoveSession(session.userId)}
                                                canRemove={sessions.length > 1}
                                            />
                                        ))}
                                    </div>
                                    <div className="border-t border-border mx-2" />
                                </>
                            )}

                            <div className="px-3 pt-2 pb-1">
                                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Accounts</span>
                            </div>
                            <div className="max-h-48 overflow-y-auto">
                                {mailboxes.map((mailbox) => (
                                    <AccountItem
                                        key={mailbox.id}
                                        mailbox={mailbox}
                                        isSelected={selectedMailbox?.id === mailbox.id}
                                        onSelect={() => {
                                            setSelectedMailbox(mailbox)
                                            setIsOpen(false)
                                        }}
                                    />
                                ))}
                            </div>

                            <div className="border-t border-border pt-2 px-2 space-y-1">
                                <button
                                    onClick={() => {
                                        refreshMailboxes()
                                        setIsOpen(false)
                                    }}
                                    className="flex items-center gap-3 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-accent rounded-lg transition-colors"
                                >
                                    <RefreshCw className="w-4 h-4" />
                                    Refresh Accounts
                                </button>
                                <Link
                                    href="/mail/settings"
                                    className="flex items-center gap-3 w-full px-3 py-2 text-sm text-muted-foreground hover:bg-accent rounded-lg transition-colors"
                                    onClick={() => setIsOpen(false)}
                                >
                                    <Settings className="w-4 h-4" />
                                    Manage Accounts
                                </Link>
                                <button
                                    onClick={() => {
                                        setIsOpen(false)
                                        setShowConnectDialog(true)
                                    }}
                                    className="flex items-center gap-3 w-full px-3 py-2 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors font-medium"
                                >
                                    <Plus className="w-4 h-4" />
                                    Add Another Account
                                </button>
                            </div>

                            {showSignOut && onSignOut && (
                                <div className="border-t border-border mt-2 pt-2 px-2">
                                    <button
                                        onClick={() => {
                                            setIsOpen(false)
                                            onSignOut()
                                        }}
                                        className="flex items-center gap-3 w-full px-3 py-2 text-sm text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                                    >
                                        <LogOut className="w-4 h-4" />
                                        Sign Out
                                    </button>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>

            <ConnectMailboxDialog
                open={showConnectDialog}
                onOpenChange={setShowConnectDialog}
            />
        </>
    )
}

function SessionItem({
    session,
    isActive,
    isSwitching,
    onSwitch,
    onRemove,
    canRemove,
}: {
    session: { userId: string; email: string; userMetadata: { firstName?: string; lastName?: string } }
    isActive: boolean
    isSwitching: boolean
    onSwitch: () => void
    onRemove: () => void
    canRemove: boolean
}) {
    const initial = session.userMetadata?.firstName?.[0]?.toUpperCase() || session.email?.[0]?.toUpperCase() || 'U'
    const name = session.userMetadata?.firstName || session.email?.split('@')[0] || 'User'

    return (
        <div className="flex items-center gap-2 px-3 py-2 group">
            <button
                onClick={onSwitch}
                disabled={isSwitching}
                className="flex items-center gap-3 flex-1 min-w-0 text-left transition-colors hover:bg-accent/50 rounded-lg px-1 py-1"
            >
                <div className={`w-8 h-8 rounded-full ${isActive ? 'bg-primary' : 'bg-muted'} flex items-center justify-center text-sm font-bold flex-shrink-0 ${isActive ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
                    {isSwitching ? (
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                    ) : initial}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground truncate">{name}</span>
                        {isActive && (
                            <span className="px-1.5 py-0.5 text-xs bg-primary/10 text-primary rounded font-medium">
                                Active
                            </span>
                        )}
                    </div>
                    <span className="text-xs text-muted-foreground truncate block">{session.email}</span>
                </div>
            </button>
            {canRemove && !isActive && (
                <button
                    onClick={(e) => {
                        e.stopPropagation()
                        onRemove()
                    }}
                    className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                    title="Remove account"
                >
                    <Trash2 className="w-3.5 h-3.5" />
                </button>
            )}
        </div>
    )
}

function AccountItem({
    mailbox,
    isSelected,
    onSelect,
}: {
    mailbox: Mailbox
    isSelected: boolean
    onSelect: () => void
}) {
    const [copied, setCopied] = React.useState(false)

    return (
        <button
            onClick={onSelect}
            className={`
                flex items-center gap-3 w-full px-3 py-2.5 first:pt-3 last:pb-3 text-left transition-colors hover:bg-accent/50
            `}
        >
            <div className={`w-9 h-9 rounded-full ${getProviderColor(mailbox.provider)} flex items-center justify-center text-white text-sm font-bold flex-shrink-0`}>
                {getProviderIcon(mailbox.provider)}
            </div>

            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate">
                        {mailbox.displayName || mailbox.email?.split('@')[0]}
                    </span>
                    {mailbox.isDefault && (
                        <span className="px-1.5 py-0.5 text-xs bg-primary/10 text-primary rounded">
                            Default
                        </span>
                    )}
                    {mailbox.syncError && (
                        <AlertCircle className="w-3 h-3 text-red-500 flex-shrink-0" />
                    )}
                </div>
                <div
                    onClick={(e) => {
                        e.stopPropagation()
                        if (mailbox.email) {
                            navigator.clipboard.writeText(mailbox.email)
                            setCopied(true)
                            setTimeout(() => setCopied(false), 2000)
                        }
                    }}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-copy group w-max"
                    title="Copy email"
                >
                    <span className="truncate">{mailbox.email}</span>
                    {copied ? (
                        <Check className="w-3 h-3 text-green-500 animate-in zoom-in" />
                    ) : (
                        <Copy className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                    )}
                </div>
            </div>

            <div className="flex items-center gap-2">
                {mailbox.unreadCount && mailbox.unreadCount > 0 && (
                    <span className="px-2 py-0.5 text-xs font-bold bg-primary text-primary-foreground rounded-full">
                        {mailbox.unreadCount > 99 ? '99+' : mailbox.unreadCount}
                    </span>
                )}
                {isSelected && (
                    <Check className="w-4 h-4 text-primary" />
                )}
            </div>
        </button>
    )
}

export function CompactAccountSwitcher() {
    return <AccountSwitcher compact />
}
