import { createContext, useCallback, useContext, useMemo, useRef, useState, ReactNode } from 'react'
import { useMailbox } from './useMailbox'
import type { MailtoTarget } from '../lib/mailto'

export interface ComposeOptions {
    replyToId?: string
    forwardId?: string
    draftId?: string
    replyAll?: boolean
    /** Pre-filled fields for a brand-new message (used by mailto: links). */
    prefill?: { to?: string; cc?: string; subject?: string; body?: string }
    /**
     * Mailbox that owns the message being replied to / forwarded / edited. Defaults to the
     * mailbox selected in the sidebar AT THE MOMENT the compose window opens, and never
     * changes afterwards.
     */
    mailboxId?: string
}

/**
 * Registered by the open compose window. Called before another compose replaces it:
 * resolve `true` to let the replacement go ahead (the draft was saved or the user chose
 * to drop it), `false` to keep the current compose open.
 */
export type ComposeGuard = () => Promise<boolean>

interface ComposeContextType {
    isOpen: boolean
    options: ComposeOptions
    /** Bumps on every open so the compose window re-initializes even for identical options. */
    sessionId: number
    openCompose: (opts?: ComposeOptions) => void
    closeCompose: () => void
    registerGuard: (guard: ComposeGuard | null) => void
}

const ComposeContext = createContext<ComposeContextType | undefined>(undefined)

export function ComposeProvider({ children }: { children: ReactNode }) {
    const { selectedMailbox } = useMailbox()
    const [isOpen, setIsOpen] = useState(false)
    const [options, setOptions] = useState<ComposeOptions>({})
    const [sessionId, setSessionId] = useState(0)

    // Refs keep openCompose referentially stable (routes call it from effects) while
    // still reading the latest sidebar selection and open state.
    const selectedMailboxIdRef = useRef<string | undefined>(selectedMailbox?.id)
    selectedMailboxIdRef.current = selectedMailbox?.id
    const isOpenRef = useRef(false)
    isOpenRef.current = isOpen
    const guardRef = useRef<ComposeGuard | null>(null)

    const registerGuard = useCallback((guard: ComposeGuard | null) => {
        guardRef.current = guard
    }, [])

    const openCompose = useCallback((opts: ComposeOptions = {}) => {
        const next: ComposeOptions = { ...opts, mailboxId: opts.mailboxId ?? selectedMailboxIdRef.current }

        const open = () => {
            setOptions(next)
            setSessionId(value => value + 1)
            setIsOpen(true)
        }

        const guard = guardRef.current
        if (isOpenRef.current && guard) {
            // Never silently discard the compose that is already open.
            void guard().then(proceed => {
                if (proceed) open()
            })
            return
        }
        open()
    }, [])

    const closeCompose = useCallback(() => {
        setIsOpen(false)
        setOptions({})
    }, [])

    const value = useMemo(
        () => ({ isOpen, options, sessionId, openCompose, closeCompose, registerGuard }),
        [isOpen, options, sessionId, openCompose, closeCompose, registerGuard],
    )

    return <ComposeContext.Provider value={value}>{children}</ComposeContext.Provider>
}

export function useCompose() {
    const context = useContext(ComposeContext)
    if (context === undefined) {
        throw new Error('useCompose must be used within a ComposeProvider')
    }
    return context
}

/** Returns a handler that opens the compose window for a clicked mailto: link. */
export function useMailtoHandler() {
    const { openCompose } = useCompose()
    return useCallback((target: MailtoTarget) => {
        openCompose({
            prefill: { to: target.address, cc: target.cc, subject: target.subject, body: target.body },
        })
    }, [openCompose])
}
