import React from 'react'
import { Check, Loader2, LogOut, Trash2, UserRound } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useMultiSession } from '../../hooks/useMultiSession'
import { toast } from '../ui/toaster'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu'

interface UserAccountMenuProps {
    onSignOut: () => void
}

export function UserAccountMenu({ onSignOut }: UserAccountMenuProps) {
    const { user } = useAuth()
    const { sessions, activeSessionId, switchSession, removeAccount } = useMultiSession()
    const [switchingId, setSwitchingId] = React.useState<string | null>(null)
    const email = user?.email || ''
    const name = user?.user_metadata?.firstName || email.split('@')[0] || 'Account'
    const initial = name[0]?.toLocaleUpperCase() || 'U'

    const handleSwitch = async (userId: string) => {
        if (userId === activeSessionId) return
        setSwitchingId(userId)
        try {
            await switchSession(userId)
        } catch (error) {
            toast({
                title: 'Failed to switch account',
                description: error instanceof Error ? error.message : 'Unknown error',
                variant: 'destructive',
            })
        } finally {
            setSwitchingId(null)
        }
    }

    const handleRemove = async (userId: string) => {
        try {
            await removeAccount(userId)
            toast({ title: 'Account removed', variant: 'success' })
        } catch {
            toast({ title: 'Failed to remove account', variant: 'destructive' })
        }
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="flex shrink-0 items-center gap-2 rounded-xl px-2 py-2 transition-colors hover:bg-accent xl:px-3"
                    aria-label="Open user account menu"
                >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground">
                        {initial}
                    </span>
                    {/* Name and address only where there is room (xl). The column has a fixed
                        max width and clips its children, so `truncate` really applies. */}
                    <span className="hidden w-40 min-w-0 flex-col items-stretch overflow-hidden text-left xl:flex">
                        <span className="truncate text-sm font-medium text-foreground">{name}</span>
                        <span className="truncate text-xs text-muted-foreground">{email}</span>
                    </span>
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72 overflow-x-hidden p-0 pb-2">
                <div className="border-b border-border px-3 py-3">
                    <div className="flex items-center gap-2">
                        <UserRound className="h-4 w-4 text-muted-foreground" />
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">{name}</p>
                            <p className="truncate text-xs text-muted-foreground">{email}</p>
                        </div>
                    </div>
                </div>

                {sessions.length > 1 ? (
                    <div className="max-h-52 overflow-y-auto overflow-x-hidden px-2 py-2">
                        <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Signed-in users</p>
                        {sessions.map((session) => {
                            const isActive = session.userId === activeSessionId
                            const sessionName = session.userMetadata?.firstName || session.email.split('@')[0]
                            return (
                                <div key={session.userId} className="group flex min-w-0 items-center gap-1 rounded-lg hover:bg-accent">
                                    <button
                                        type="button"
                                        onClick={() => handleSwitch(session.userId)}
                                        disabled={switchingId === session.userId}
                                        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left disabled:opacity-60"
                                    >
                                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold text-muted-foreground">
                                            {sessionName[0]?.toLocaleUpperCase() || 'U'}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-xs font-medium text-foreground">{sessionName}</span>
                                            <span className="block truncate text-[11px] text-muted-foreground">{session.email}</span>
                                        </span>
                                        {switchingId === session.userId ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                        ) : isActive ? (
                                            <Check className="h-3.5 w-3.5 text-primary" />
                                        ) : null}
                                    </button>
                                    {!isActive ? (
                                        <button
                                            type="button"
                                            onClick={() => handleRemove(session.userId)}
                                            className="mr-1 rounded p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus:opacity-100"
                                            aria-label={`Remove ${session.email}`}
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                    ) : null}
                                </div>
                            )
                        })}
                    </div>
                ) : null}

                <div className="border-t border-border px-2 pt-2">
                    <button
                        type="button"
                        onClick={onSignOut}
                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
                    >
                        <LogOut className="h-4 w-4" />
                        Sign out
                    </button>
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
