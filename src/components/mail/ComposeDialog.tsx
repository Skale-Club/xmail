import React, { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from '../ui/toaster'
import { useMailbox } from '../../hooks/useMailbox'
import { useSendEmail, useSaveDraft, useMessage } from '../../hooks/useMail'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { RichTextEditor, htmlToPlainText } from './RichTextEditor'
import { ContactAutocomplete } from './ContactAutocomplete'
import { mailApi, type Message, type Signature } from '../../lib/mail-api'
import { useCompose } from '../../hooks/useCompose'
import {
    buildForwardQuote,
    buildInitialBody,
    buildReplyQuote,
    buildReplyRecipients,
    insertSignature as insertSignatureIntoBody,
    plainTextToHtml,
    prefixSubject,
    recipientsToString,
} from './compose-body'
import { sendableMailboxes, mailboxOptionLabel } from './compose-sender'
import {
    Send,
    X,
    Paperclip,
    Image as ImageIcon,
    Trash2,
    AlertCircle,
    PenTool,
    Minus,
    Maximize2,
    Minimize2
} from 'lucide-react'

interface ComposeEmail {
    to: string
    cc: string
    bcc: string
    subject: string
    body: string
}

const EMPTY_EMAIL: ComposeEmail = { to: '', cc: '', bcc: '', subject: '', body: '' }

/** Draft autosave fires after this much inactivity. */
const AUTOSAVE_DELAY_MS = 5000

function collapseWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

function parseEmailList(str: string): { name?: string; email: string }[] {
    return str
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(s => {
            const match = s.match(/(?:"?([^"]*)"?\s)?(?:<)?([^>]+@[^>]+)(?:>)?/)
            if (match) {
                return { name: match[1]?.trim(), email: match[2].trim() }
            }
            return { email: s }
        })
}

function formatBytes(bytes: number) {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function messageBodyHtml(message: Message): string {
    const html = message.bodyHtml || message.htmlBody
    if (html && html.trim()) return html
    return plainTextToHtml(message.bodyText || message.plainBody || '')
}

export function ComposeDialog() {
    const { isOpen, options, sessionId, closeCompose, registerGuard } = useCompose()
    const { replyToId, replyAll, forwardId, draftId } = options
    const sourceMessageId = replyToId || forwardId || draftId || null

    const { selectedMailbox, mailboxes } = useMailbox()
    const sendEmail = useSendEmail()
    const saveDraft = useSaveDraft()

    // The mailbox that owns the message being replied to / forwarded / edited. Fixed for the
    // whole compose session: switching the sidebar mailbox afterwards must not change it.
    const originMailboxId = options.mailboxId ?? selectedMailbox?.id ?? null
    const { data: originalMessage, isError: originalFailed } = useMessage(sourceMessageId, originMailboxId)

    const [fromMailboxId, setFromMailboxId] = React.useState<string | null>(originMailboxId)
    const [email, setEmail] = React.useState<ComposeEmail>(EMPTY_EMAIL)
    const [showCc, setShowCc] = React.useState(false)
    const [showBcc, setShowBcc] = React.useState(false)
    const [isSaved, setIsSaved] = React.useState(false)
    const [attachments, setAttachments] = React.useState<File[]>([])
    const [showSignatureMenu, setShowSignatureMenu] = React.useState(false)
    const [initialized, setInitialized] = React.useState(false)
    const [isDirty, setIsDirty] = React.useState(false)
    const [isMinimized, setIsMinimized] = React.useState(false)
    const [isMaximized, setIsMaximized] = React.useState(false)
    const [activeDraftId, setActiveDraftId] = React.useState<string | undefined>(draftId || undefined)
    // Mailbox that actually holds `activeDraftId` (drafts live in the mailbox they were saved to).
    const [draftMailboxId, setDraftMailboxId] = React.useState<string | null>(draftId ? originMailboxId : null)
    const [discardConfirmOpen, setDiscardConfirmOpen] = React.useState(false)

    const initialBodyTextRef = React.useRef('')
    const editVersionRef = React.useRef(0)
    const savePromiseRef = React.useRef<Promise<boolean> | null>(null)
    const attachmentsLoadedForSession = React.useRef<number | null>(null)

    const signaturesQuery = useQuery({
        queryKey: ['mail-signatures', fromMailboxId],
        queryFn: () => mailApi.getSignatures(fromMailboxId as string),
        enabled: isOpen && !!fromMailboxId,
        staleTime: 60_000,
    })
    const signatures: Signature[] = React.useMemo(
        () => signaturesQuery.data?.signatures ?? [],
        [signaturesQuery.data],
    )

    const senders = React.useMemo(
        () => sendableMailboxes(mailboxes, fromMailboxId),
        [mailboxes, fromMailboxId],
    )
    const fromMailbox = React.useMemo(
        () => mailboxes.find(mailbox => mailbox.id === fromMailboxId) ?? null,
        [mailboxes, fromMailboxId],
    )

    const markDirty = React.useCallback(() => {
        editVersionRef.current += 1
        setIsDirty(true)
    }, [])

    // Fresh compose session (also fires when a second compose replaces the first).
    useEffect(() => {
        if (!isOpen) return
        setEmail(EMPTY_EMAIL)
        setShowCc(false)
        setShowBcc(false)
        setAttachments([])
        setInitialized(false)
        setIsDirty(false)
        setIsSaved(false)
        setIsMinimized(false)
        setIsMaximized(false)
        setShowSignatureMenu(false)
        setDiscardConfirmOpen(false)
        setFromMailboxId(originMailboxId)
        setActiveDraftId(draftId || undefined)
        setDraftMailboxId(draftId ? originMailboxId : null)
        editVersionRef.current = 0
        savePromiseRef.current = null
    }, [sessionId])

    // Builds the initial fields once everything they depend on has loaded, in ONE update:
    // recipients/subject, the default signature and the quoted original together. Doing this in
    // separate effects (as before) let one overwrite the other with a stale body.
    useEffect(() => {
        if (!isOpen || initialized) return
        if (sourceMessageId && !originalMessage && !originalFailed) return
        const needsSignature = !draftId && !!fromMailboxId
        if (needsSignature && signaturesQuery.isLoading) return

        const msg = originalMessage?.message
        const next: ComposeEmail = { ...EMPTY_EMAIL }
        const defaultSignature = signatures.find(signature => signature.isDefault)?.content ?? null

        if (draftId && msg) {
            next.to = recipientsToString(msg.to ?? [])
            next.cc = recipientsToString(msg.cc ?? [])
            next.bcc = recipientsToString(msg.bcc ?? [])
            next.subject = msg.subject || ''
            next.body = messageBodyHtml(msg)
            setShowCc(!!next.cc)
            setShowBcc(!!next.bcc)
        } else if (replyToId && msg) {
            const recipients = buildReplyRecipients({
                from: msg.from,
                to: msg.to,
                cc: msg.cc,
                selfEmails: fromMailbox ? [fromMailbox.email] : [],
                replyAll: !!replyAll,
            })
            next.to = recipientsToString(recipients.to)
            next.cc = recipientsToString(recipients.cc)
            next.subject = prefixSubject(msg.subject || '', 'reply')
            next.body = buildInitialBody({
                signatureHtml: defaultSignature,
                quoteHtml: buildReplyQuote({
                    from: msg.from,
                    date: msg.date,
                    source: { html: msg.bodyHtml || msg.htmlBody, plain: msg.bodyText || msg.plainBody },
                }),
            })
            setShowCc(!!next.cc)
        } else if (forwardId && msg) {
            next.subject = prefixSubject(msg.subject || '', 'forward')
            next.body = buildInitialBody({
                signatureHtml: defaultSignature,
                quoteHtml: buildForwardQuote({
                    from: msg.from,
                    date: msg.date,
                    subject: msg.subject || '',
                    to: msg.to ?? [],
                    source: { html: msg.bodyHtml || msg.htmlBody, plain: msg.bodyText || msg.plainBody },
                }),
            })
        } else {
            const prefill = options.prefill
            next.to = prefill?.to ?? ''
            next.cc = prefill?.cc ?? ''
            next.subject = prefill?.subject ?? ''
            const prefillBody = prefill?.body ? `<p>${plainTextToHtml(prefill.body)}</p>` : ''
            next.body = prefillBody + buildInitialBody({ signatureHtml: defaultSignature })
            if (next.cc) setShowCc(true)
        }

        initialBodyTextRef.current = collapseWhitespace(htmlToPlainText(next.body))
        setEmail(next)
        setInitialized(true)
    }, [
        isOpen, initialized, sourceMessageId, originalMessage, originalFailed, draftId, replyToId,
        forwardId, replyAll, fromMailboxId, fromMailbox, signaturesQuery.isLoading, signatures, options.prefill,
    ])

    // Drafts and forwards carry their stored attachments over: save-draft and send take the
    // attachment bytes, so without this a draft that is edited and re-saved (or sent) would
    // silently lose its files.
    useEffect(() => {
        if (!isOpen || !initialized || !originalMessage?.message || !originMailboxId) return
        if (!draftId && !forwardId) return
        if (attachmentsLoadedForSession.current === sessionId) return
        attachmentsLoadedForSession.current = sessionId

        const message = originalMessage.message
        const stored = message.attachments ?? []
        if (stored.length === 0) return

        let cancelled = false
        void Promise.allSettled(
            stored.map((attachment, index) =>
                mailApi.fetchAttachmentFile(
                    originMailboxId,
                    message.id,
                    index,
                    attachment.filename,
                    attachment.contentType || attachment.mimeType,
                ),
            ),
        ).then(results => {
            if (cancelled) return
            const files = results
                .filter((result): result is PromiseFulfilledResult<File> => result.status === 'fulfilled')
                .map(result => result.value)
            if (files.length > 0) setAttachments(prev => [...files, ...prev])
            if (files.length < stored.length) {
                toast({
                    title: 'Some attachments could not be loaded',
                    description: 'Re-attach them before sending.',
                    variant: 'destructive',
                })
            }
        })
        return () => { cancelled = true }
    }, [isOpen, initialized, originalMessage, originMailboxId, draftId, forwardId, sessionId])

    const hasMeaningfulContent = (current: ComposeEmail, files: File[]) => {
        if (current.to.trim() || current.cc.trim() || current.bcc.trim() || current.subject.trim()) return true
        if (files.length > 0) return true
        return collapseWhitespace(htmlToPlainText(current.body)) !== initialBodyTextRef.current
    }

    // Always points at the latest state so async callers (autosave, guard, discard) never act
    // on a stale closure.
    const latestRef = React.useRef({ email, attachments, fromMailboxId, activeDraftId, draftMailboxId, isDirty })
    latestRef.current = { email, attachments, fromMailboxId, activeDraftId, draftMailboxId, isDirty }

    const persistDraft = async (opts: { silent?: boolean } = {}): Promise<boolean> => {
        // Overlapping saves would create two drafts; wait for the one in flight first.
        if (savePromiseRef.current) {
            await savePromiseRef.current.catch(() => false)
        }

        const run = async (): Promise<boolean> => {
            const current = latestRef.current
            if (!current.fromMailboxId) return false
            const versionAtStart = editVersionRef.current
            const mailboxId = current.fromMailboxId
            const existingDraftId = current.draftMailboxId === mailboxId ? current.activeDraftId : undefined

            try {
                const result = await saveDraft.mutateAsync({
                    mailboxId,
                    payload: {
                        to: current.email.to ? parseEmailList(current.email.to) : undefined,
                        cc: current.email.cc ? parseEmailList(current.email.cc) : undefined,
                        bcc: current.email.bcc ? parseEmailList(current.email.bcc) : undefined,
                        subject: current.email.subject,
                        bodyText: htmlToPlainText(current.email.body),
                        bodyHtml: current.email.body,
                        draftId: existingDraftId,
                        attachments: current.attachments,
                    },
                })

                // The sender changed after a draft was saved: the old copy lives in the old
                // mailbox, so remove it (twice: Drafts -> Trash -> gone) to avoid a stray draft.
                if (current.activeDraftId && current.draftMailboxId && current.draftMailboxId !== mailboxId) {
                    const oldMailbox = current.draftMailboxId
                    const oldDraft = current.activeDraftId
                    void mailApi.deleteMessage(oldMailbox, oldDraft)
                        .then(() => mailApi.deleteMessage(oldMailbox, oldDraft))
                        .catch(() => undefined)
                }

                setActiveDraftId(result.draftId)
                setDraftMailboxId(mailboxId)
                if (editVersionRef.current === versionAtStart) setIsDirty(false)
                setIsSaved(true)
                window.setTimeout(() => setIsSaved(false), 2000)
                if (!opts.silent) toast({ title: 'Draft saved', variant: 'success' })
                return true
            } catch (error) {
                if (!opts.silent) {
                    toast({
                        title: 'Failed to save draft',
                        description: error instanceof Error ? error.message : 'Unknown error',
                        variant: 'destructive'
                    })
                }
                return false
            }
        }

        const promise = run()
        savePromiseRef.current = promise
        try {
            return await promise
        } finally {
            if (savePromiseRef.current === promise) savePromiseRef.current = null
        }
    }
    const persistDraftRef = React.useRef(persistDraft)
    persistDraftRef.current = persistDraft

    // Autosave: a few seconds after the last edit, quietly.
    useEffect(() => {
        if (!isOpen || !initialized || !isDirty || sendEmail.isPending) return
        if (!hasMeaningfulContent(email, attachments)) return
        const timer = window.setTimeout(() => { void persistDraftRef.current({ silent: true }) }, AUTOSAVE_DELAY_MS)
        return () => window.clearTimeout(timer)
    }, [isOpen, initialized, isDirty, email, attachments, fromMailboxId, sendEmail.isPending])

    // Warn before the tab closes with edits that autosave has not stored yet.
    useEffect(() => {
        if (!isOpen || !isDirty) return
        const handler = (event: BeforeUnloadEvent) => {
            if (!hasMeaningfulContent(latestRef.current.email, latestRef.current.attachments)) return
            event.preventDefault()
            event.returnValue = ''
        }
        window.addEventListener('beforeunload', handler)
        return () => window.removeEventListener('beforeunload', handler)
    }, [isOpen, isDirty])

    // Lets useCompose ask this window what to do before another compose replaces it: never
    // drop unsaved text silently.
    useEffect(() => {
        if (!isOpen) return
        registerGuard(async () => {
            if (sendEmail.isPending) return false
            const current = latestRef.current
            if (!current.isDirty || !hasMeaningfulContent(current.email, current.attachments)) return true
            if (await persistDraftRef.current({ silent: true })) {
                toast({ title: 'Previous draft saved', variant: 'success' })
                return true
            }
            return window.confirm('The current message could not be saved as a draft. Discard it and continue?')
        })
        return () => registerGuard(null)
    }, [isOpen, registerGuard, sendEmail.isPending])

    const handleFromChange = (mailboxId: string) => {
        setFromMailboxId(mailboxId)
        if (isDirty) {
            // Keep what the user wrote; the new sender's signature can be inserted by hand.
            markDirty()
        } else {
            // Nothing typed yet: rebuild so the new sender's default signature is used.
            setInitialized(false)
        }
    }

    const handleInsertSignature = (signature: Signature) => {
        setEmail(prev => ({ ...prev, body: insertSignatureIntoBody(prev.body, signature.content) }))
        markDirty()
        setShowSignatureMenu(false)
    }

    const updateField = (patch: Partial<ComposeEmail>) => {
        setEmail(prev => ({ ...prev, ...patch }))
        markDirty()
    }

    const handleSend = async () => {
        if (sendEmail.isPending) return
        if (!email.to.trim()) {
            toast({ title: 'Please enter a recipient', variant: 'destructive' })
            return
        }
        if (!email.subject.trim()) {
            toast({ title: 'Please enter a subject', variant: 'destructive' })
            return
        }
        if (!fromMailboxId) {
            toast({ title: 'No email account selected', description: 'Please choose which account to send from', variant: 'destructive' })
            return
        }

        // An autosave still in flight would otherwise create a draft after the send.
        if (savePromiseRef.current) {
            await savePromiseRef.current.catch(() => false)
        }
        const current = latestRef.current
        const original = originalMessage?.message

        try {
            await sendEmail.mutateAsync({
                mailboxId: fromMailboxId,
                payload: {
                    to: parseEmailList(email.to),
                    cc: email.cc ? parseEmailList(email.cc) : undefined,
                    bcc: email.bcc ? parseEmailList(email.bcc) : undefined,
                    subject: email.subject,
                    bodyText: htmlToPlainText(email.body),
                    bodyHtml: email.body,
                    attachments,
                    inReplyTo: replyToId ? original?.messageId : undefined,
                    references: replyToId ? original?.references : undefined,
                    draftId: current.draftMailboxId === fromMailboxId ? current.activeDraftId : undefined,
                },
            })
            closeCompose()
            toast({ title: 'Email sent successfully!', variant: 'success' })
        } catch (error) {
            toast({
                title: 'Failed to send email',
                description: error instanceof Error ? error.message : 'Unknown error',
                variant: 'destructive'
            })
        }
    }

    const handleSaveDraftClick = async () => {
        await persistDraft({ silent: false })
    }

    const handleClose = async () => {
        const current = latestRef.current
        if (current.isDirty && hasMeaningfulContent(current.email, current.attachments)) {
            const saved = await persistDraft({ silent: true })
            if (!saved && !window.confirm('The message could not be saved as a draft. Close and discard it?')) {
                return
            }
            if (saved) toast({ title: 'Draft saved', variant: 'success' })
        }
        closeCompose()
    }

    const discardNow = async () => {
        setDiscardConfirmOpen(false)
        // Let an in-flight autosave finish first so the draft it creates is the one we delete.
        if (savePromiseRef.current) {
            await savePromiseRef.current.catch(() => false)
        }
        const current = latestRef.current
        if (current.activeDraftId && current.draftMailboxId) {
            try {
                await mailApi.deleteMessage(current.draftMailboxId, current.activeDraftId)
                toast({ title: 'Draft deleted', variant: 'success' })
            } catch (error) {
                toast({
                    title: 'Failed to delete draft',
                    description: error instanceof Error ? error.message : 'Unknown error',
                    variant: 'destructive',
                })
                return
            }
        }
        closeCompose()
    }

    const handleDiscard = () => {
        if (latestRef.current.activeDraftId) {
            setDiscardConfirmOpen(true)
            return
        }
        closeCompose()
    }

    const handleAttachment = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || [])
        setAttachments(prev => [...prev, ...files])
        markDirty()
        e.target.value = ''
    }

    const removeAttachment = (index: number) => {
        setAttachments(prev => prev.filter((_, i) => i !== index))
        markDirty()
    }

    useKeyboardShortcuts({
        enabled: isOpen,
        onSend: handleSend,
        onSaveDraft: handleSaveDraftClick,
        onEscape: () => { if (!discardConfirmOpen) void handleClose() }
    })

    if (!isOpen) return null

    const title = replyToId ? 'Reply' : forwardId ? 'Forward' : draftId ? 'Edit Draft' : 'New Message'
    const locked = !initialized

    // No mailboxes state
    if (mailboxes.length === 0) {
        return (
            <>
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[59] animate-in fade-in duration-200" onClick={closeCompose} />
                <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-8 w-[calc(100%-2rem)] sm:w-[520px] z-[60] bg-background border border-border shadow-2xl rounded-2xl overflow-hidden">
                    <div className="flex items-center justify-between px-5 py-3 bg-muted/50">
                        <span className="font-semibold text-sm text-foreground">{title}</span>
                        <button onClick={closeCompose} className="p-1.5 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground transition-colors" aria-label="Close">
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                    <div className="flex items-center justify-center py-16 px-6">
                        <div className="text-center">
                            <AlertCircle className="w-12 h-12 mx-auto mb-3 text-yellow-500" />
                            <h2 className="text-base font-bold text-foreground mb-1">No Email Accounts</h2>
                            <p className="text-sm text-muted-foreground">Add an email account to compose emails.</p>
                        </div>
                    </div>
                </div>
            </>
        )
    }

    // Minimized state
    if (isMinimized) {
        return (
            <div
                className="fixed bottom-4 right-4 sm:bottom-6 sm:right-8 z-[60] bg-background border border-border shadow-2xl rounded-xl cursor-pointer hover:shadow-3xl transition-all duration-200 group"
                onClick={() => setIsMinimized(false)}
            >
                <div className="flex items-center gap-3 px-4 py-3 min-w-[280px]">
                    <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                    <span className="min-w-0 flex-1">
                        <span className="block font-medium text-sm text-foreground truncate">
                            {email.subject || title}
                        </span>
                        {fromMailbox && (
                            <span className="block text-xs text-muted-foreground truncate">from {fromMailbox.email}</span>
                        )}
                    </span>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={(e) => { e.stopPropagation(); setIsMinimized(false) }}
                            className="p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition-colors"
                            aria-label="Restore"
                        >
                            <Maximize2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); void handleClose() }}
                            className="p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition-colors"
                            aria-label="Close"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
            </div>
        )
    }

    // Maximized dimensions
    const containerClass = isMaximized
        ? 'fixed inset-4 sm:inset-8 z-[60]'
        : 'fixed bottom-0 right-0 w-full h-full sm:bottom-6 sm:right-8 sm:w-[620px] sm:h-[min(640px,calc(100vh-4rem))] z-[60]'

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/12 backdrop-blur-[1px] z-[59] animate-in fade-in duration-150 sm:bg-black/12 sm:backdrop-blur-[1px]"
                onClick={() => {
                    if (window.innerWidth < 640) void handleClose()
                }}
            />

            {/* Compose Window */}
            <div className={`${containerClass} bg-background border border-border/80 shadow-2xl sm:rounded-2xl overflow-hidden flex flex-col animate-in slide-in-from-bottom-4 fade-in duration-300`}>

                {/* Header Bar */}
                <div className="flex items-center justify-between px-4 py-2.5 bg-muted/40 border-b border-border/50 shrink-0">
                    <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                        <span className="font-semibold text-sm text-foreground">{title}</span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        <button
                            onClick={() => setIsMinimized(true)}
                            className="p-1.5 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                            title="Minimize"
                            aria-label="Minimize"
                        >
                            <Minus className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => setIsMaximized(!isMaximized)}
                            className="hidden sm:flex p-1.5 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                            title={isMaximized ? 'Restore' : 'Maximize'}
                            aria-label={isMaximized ? 'Restore' : 'Maximize'}
                        >
                            {isMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                        </button>
                        <button
                            onClick={() => void handleClose()}
                            className="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded-lg text-muted-foreground transition-colors"
                            title="Close"
                            aria-label="Close"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {/* Fields */}
                <div className={`shrink-0 ${locked ? 'pointer-events-none opacity-60' : ''}`} aria-busy={locked}>
                    {/* From */}
                    <div className="flex items-center px-4 py-1.5 border-b border-border/30">
                        <label htmlFor="compose-from" className="w-12 text-xs font-medium text-muted-foreground uppercase tracking-wide shrink-0">From</label>
                        <div className="flex-1 min-w-0">
                            {senders.length > 1 ? (
                                <select
                                    id="compose-from"
                                    value={fromMailboxId ?? ''}
                                    onChange={(event) => handleFromChange(event.target.value)}
                                    className="w-full px-2 py-1.5 bg-transparent border-0 focus:ring-0 text-sm text-foreground outline-none cursor-pointer"
                                >
                                    {senders.map(mailbox => (
                                        <option key={mailbox.id} value={mailbox.id}>{mailboxOptionLabel(mailbox)}</option>
                                    ))}
                                </select>
                            ) : (
                                <span id="compose-from" className="block px-2 py-1.5 text-sm text-foreground truncate">
                                    {fromMailbox ? mailboxOptionLabel(fromMailbox) : ''}
                                </span>
                            )}
                        </div>
                    </div>

                    {/* To */}
                    <div className="flex items-center px-4 py-1.5 border-b border-border/30 group">
                        <span className="w-12 text-xs font-medium text-muted-foreground uppercase tracking-wide shrink-0">To</span>
                        <div className="flex-1 min-w-0">
                            <ContactAutocomplete
                                value={email.to}
                                onChange={(value) => updateField({ to: value })}
                                placeholder="Recipients"
                                className="w-full px-2 py-1.5 bg-transparent border-0 focus:ring-0 text-sm text-foreground placeholder-muted-foreground/50 outline-none"
                            />
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                            {!showCc && (
                                <button onClick={() => setShowCc(true)} className="text-xs font-medium text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent transition-colors">
                                    Cc
                                </button>
                            )}
                            {!showBcc && (
                                <button onClick={() => setShowBcc(true)} className="text-xs font-medium text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent transition-colors">
                                    Bcc
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Cc */}
                    {showCc && (
                        <div className="flex items-center px-4 py-1.5 border-b border-border/30">
                            <span className="w-12 text-xs font-medium text-muted-foreground uppercase tracking-wide shrink-0">Cc</span>
                            <div className="flex-1 min-w-0">
                                <ContactAutocomplete
                                    value={email.cc}
                                    onChange={(value) => updateField({ cc: value })}
                                    placeholder=""
                                    className="w-full px-2 py-1.5 bg-transparent border-0 focus:ring-0 text-sm text-foreground placeholder-muted-foreground/50 outline-none"
                                />
                            </div>
                        </div>
                    )}

                    {/* Bcc */}
                    {showBcc && (
                        <div className="flex items-center px-4 py-1.5 border-b border-border/30">
                            <span className="w-12 text-xs font-medium text-muted-foreground uppercase tracking-wide shrink-0">Bcc</span>
                            <div className="flex-1 min-w-0">
                                <ContactAutocomplete
                                    value={email.bcc}
                                    onChange={(value) => updateField({ bcc: value })}
                                    placeholder=""
                                    className="w-full px-2 py-1.5 bg-transparent border-0 focus:ring-0 text-sm text-foreground placeholder-muted-foreground/50 outline-none"
                                />
                            </div>
                        </div>
                    )}

                    {/* Subject */}
                    <div className="flex items-center px-4 py-1.5 border-b border-border/30">
                        <input
                            type="text"
                            value={email.subject}
                            onChange={(e) => updateField({ subject: e.target.value })}
                            placeholder="Subject"
                            aria-label="Subject"
                            className="w-full bg-transparent border-0 focus:ring-0 text-sm font-medium placeholder-muted-foreground/50 px-2 py-1.5 outline-none text-foreground"
                        />
                    </div>
                </div>

                {/* Editor */}
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                    <div className="flex-1 overflow-y-auto px-4">
                        {locked ? (
                            <div className="space-y-3 py-4 animate-pulse" aria-label="Loading message">
                                <div className="h-3.5 w-10/12 rounded-full bg-muted" />
                                <div className="h-3.5 w-8/12 rounded-full bg-muted" />
                                <div className="h-3.5 w-9/12 rounded-full bg-muted" />
                            </div>
                        ) : (
                            <RichTextEditor
                                value={email.body}
                                onChange={(value, source) => {
                                    setEmail(prev => ({ ...prev, body: value }))
                                    if (source === 'user') markDirty()
                                }}
                                placeholder="Write your message..."
                                minHeight={isMaximized ? 400 : 200}
                                className="flex-1 border-0 compose-editor-borderless"
                            />
                        )}
                    </div>
                </div>

                {/* Attachments */}
                {attachments.length > 0 && (
                    <div className="px-4 py-2 border-t border-border/30 shrink-0">
                        <div className="flex flex-wrap gap-1.5">
                            {attachments.map((file, index) => (
                                <div key={`${file.name}-${index}`} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/60 rounded-lg text-xs group/att">
                                    <Paperclip className="w-3 h-3 text-muted-foreground" />
                                    <span className="font-medium max-w-[120px] truncate">{file.name}</span>
                                    <span className="text-muted-foreground">({formatBytes(file.size)})</span>
                                    <button
                                        onClick={() => removeAttachment(index)}
                                        className="p-0.5 hover:bg-background rounded text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover/att:opacity-100 focus:opacity-100"
                                        aria-label={`Remove ${file.name}`}
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Footer / Actions */}
                <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/50 bg-muted/20 shrink-0">
                    <div className="flex items-center gap-2">
                        {/* Send Button */}
                        <button
                            onClick={() => void handleSend()}
                            disabled={sendEmail.isPending || locked}
                            className="flex items-center gap-2 pl-4 pr-3 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-sm font-medium transition-all active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none"
                        >
                            {sendEmail.isPending ? 'Sending...' : 'Send'}
                            <Send className="w-3.5 h-3.5" />
                        </button>

                        <div className="w-px h-5 bg-border/50" />

                        {/* Toolbar icons */}
                        <label className="p-2 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground cursor-pointer transition-colors" title="Attach files">
                            <Paperclip className="w-4 h-4" />
                            <span className="sr-only">Attach files</span>
                            <input type="file" multiple onChange={handleAttachment} className="hidden" />
                        </label>
                        <label className="p-2 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground cursor-pointer transition-colors" title="Insert image">
                            <ImageIcon className="w-4 h-4" />
                            <span className="sr-only">Insert image</span>
                            <input type="file" accept="image/*" className="hidden" />
                        </label>

                        {/* Signatures */}
                        {signatures.length > 0 && (
                            <div className="relative">
                                <button
                                    onClick={() => setShowSignatureMenu(!showSignatureMenu)}
                                    className="p-2 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                                    title="Insert signature"
                                    aria-label="Insert signature"
                                    aria-expanded={showSignatureMenu}
                                >
                                    <PenTool className="w-4 h-4" />
                                </button>
                                {showSignatureMenu && (
                                    <>
                                        <div className="fixed inset-0 z-40" onClick={() => setShowSignatureMenu(false)} />
                                        <div className="absolute bottom-full left-0 mb-2 w-52 bg-popover border border-border rounded-xl shadow-xl z-50 py-1">
                                            {signatures.map(sig => (
                                                <button
                                                    key={sig.id}
                                                    onClick={() => handleInsertSignature(sig)}
                                                    className="w-full px-3 py-2 text-left text-sm hover:bg-accent text-foreground transition-colors flex items-center justify-between"
                                                >
                                                    <span className="font-medium">{sig.name}</span>
                                                    {sig.isDefault && (
                                                        <span className="text-xs uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                                                            Default
                                                        </span>
                                                    )}
                                                </button>
                                            ))}
                                        </div>
                                    </>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-1.5">
                        {isSaved && (
                            <span className="text-xs font-medium text-green-600 dark:text-green-400 bg-green-500/10 px-2 py-1 rounded-md animate-in fade-in duration-200" role="status">
                                Saved
                            </span>
                        )}
                        <button
                            onClick={handleDiscard}
                            className="p-2 hover:bg-destructive/10 text-muted-foreground hover:text-destructive rounded-lg transition-colors"
                            title="Discard"
                            aria-label="Discard"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Own confirm layer: the shared Dialog sits at z-50, below this window (z-60). */}
            {discardConfirmOpen && (
                <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div
                        role="alertdialog"
                        aria-modal="true"
                        aria-labelledby="compose-discard-title"
                        aria-describedby="compose-discard-description"
                        className="w-[calc(100%-2rem)] max-w-sm rounded-lg border bg-background p-6 shadow-lg"
                    >
                        <h2 id="compose-discard-title" className="text-lg font-semibold text-foreground">Discard this draft?</h2>
                        <p id="compose-discard-description" className="mt-2 text-sm text-muted-foreground">
                            The saved draft will be deleted. This message will not be sent.
                        </p>
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                autoFocus
                                onClick={() => setDiscardConfirmOpen(false)}
                                className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => { void discardNow() }}
                                className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                            >
                                Discard draft
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}
