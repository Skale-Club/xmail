import React, { useEffect } from 'react'
import { toast } from '../ui/toaster'
import { useMailbox } from '../../hooks/useMailbox'
import { useSendEmail, useSaveDraft, useMessage } from '../../hooks/useMail'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { RichTextEditor, htmlToPlainText } from './RichTextEditor'
import { ContactAutocomplete } from './ContactAutocomplete'
import { apiFetch } from '../../lib/api-client'
import { useCompose } from '../../hooks/useCompose'
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

interface Signature {
    id: string
    name: string
    content: string
    isDefault: boolean
}

interface ComposeEmail {
    to: string
    cc: string
    bcc: string
    subject: string
    body: string
}

export function ComposeDialog() {
    const { isOpen, options, closeCompose } = useCompose()
    const { replyToId, replyAll, forwardId, draftId } = options

    const { selectedMailbox, mailboxes } = useMailbox()
    const sendEmail = useSendEmail()
    const saveDraft = useSaveDraft()
    const { data: originalMessage } = useMessage(replyToId || forwardId || draftId || null)

    const [email, setEmail] = React.useState<ComposeEmail>({
        to: '',
        cc: '',
        bcc: '',
        subject: '',
        body: ''
    })
    const [showCc, setShowCc] = React.useState(false)
    const [showBcc, setShowBcc] = React.useState(false)
    const [isSaved, setIsSaved] = React.useState(false)
    const [attachments, setAttachments] = React.useState<File[]>([])
    const [signatures, setSignatures] = React.useState<Signature[]>([])
    const [showSignatureMenu, setShowSignatureMenu] = React.useState(false)
    const [prefilled, setPrefilled] = React.useState(false)
    const [isMinimized, setIsMinimized] = React.useState(false)
    const [isMaximized, setIsMaximized] = React.useState(false)
    const [activeDraftId, setActiveDraftId] = React.useState<string | undefined>(draftId || undefined)

    useEffect(() => {
        if (isOpen) {
            setEmail({ to: '', cc: '', bcc: '', subject: '', body: '' })
            setShowCc(false)
            setShowBcc(false)
            setAttachments([])
            setPrefilled(false)
            setIsMinimized(false)
            setIsMaximized(false)
            setActiveDraftId(draftId || undefined)
        }
    }, [isOpen, replyToId, forwardId, draftId])

    useEffect(() => {
        if (isOpen && selectedMailbox) {
            apiFetch<{ signatures: Signature[] }>(`/api/mail/mailboxes/${selectedMailbox.id}/signatures`)
                .then(data => {
                    setSignatures(data.signatures || [])
                    const def = (data.signatures || []).find((s: Signature) => s.isDefault)
                    if (def && !email.body) {
                        setEmail(prev => ({ ...prev, body: `<br/><br/>${def.content}` }))
                    }
                })
                .catch(console.error)
        }
    }, [isOpen, selectedMailbox])

    useEffect(() => {
        if (!isOpen || prefilled || !originalMessage?.message) return
        const msg = originalMessage.message
        const updates: Partial<ComposeEmail> = {}

        if (replyToId) {
            updates.to = msg.from?.email || ''
            updates.subject = msg.subject?.startsWith('Re:') ? msg.subject : `Re: ${msg.subject || ''}`
            const bodyText = msg.bodyHtml || msg.plainBody || ''
            updates.body = `<br/><br/><blockquote style="border-left:2px solid #ccc;padding-left:12px;color:#666;">${bodyText}</blockquote>`
            if (replyAll && msg.to) {
                const allRecipients = [...msg.to]
                if (msg.cc) allRecipients.push(...msg.cc)
                updates.cc = allRecipients.map((r: { email: string }) => r.email).filter((e: string) => e !== selectedMailbox?.email).join(', ')
            }
            if (msg.cc?.length) setShowCc(true)
        } else if (forwardId) {
            updates.subject = msg.subject?.startsWith('Fwd:') ? msg.subject : `Fwd: ${msg.subject || ''}`
            const bodyText = msg.bodyHtml || msg.plainBody || ''
            updates.body = `<br/><br/><p>---------- Forwarded message ----------<br>From: ${msg.from?.name || ''} &lt;${msg.from?.email}&gt;<br>Date: ${msg.date || ''}<br>Subject: ${msg.subject || ''}</p><blockquote style="border-left:2px solid #ccc;padding-left:12px;color:#666;">${bodyText}</blockquote>`
        } else if (draftId) {
            updates.to = msg.to?.map((r: { email: string }) => r.email).join(', ') || ''
            updates.cc = msg.cc?.map((r: { email: string }) => r.email).join(', ') || ''
            updates.subject = msg.subject || ''
            updates.body = msg.bodyHtml || msg.plainBody || ''
            if (msg.cc?.length) setShowCc(true)
        }

        if (Object.keys(updates).length > 0) {
            setEmail(prev => ({ ...prev, ...updates }))
            setPrefilled(true)
        }
    }, [isOpen, originalMessage, replyToId, replyAll, forwardId, draftId, prefilled, selectedMailbox])

    const insertSignature = (signature: Signature) => {
        setEmail(prev => ({
            ...prev,
            body: prev.body.replace(/<br\s*\/?>\s*<br\s*\/?>.*$/i, '') + `<br/><br/>${signature.content}`
        }))
        setShowSignatureMenu(false)
    }

    const parseEmailList = (str: string): { name?: string; email: string }[] => {
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

    const handleSend = async () => {
        if (!email.to.trim()) {
            toast({ title: 'Please enter a recipient', variant: 'destructive' })
            return
        }
        if (!email.subject.trim()) {
            toast({ title: 'Please enter a subject', variant: 'destructive' })
            return
        }
        if (!selectedMailbox) {
            toast({ title: 'No email account selected', description: 'Please select an email account first', variant: 'destructive' })
            return
        }

        try {
            await sendEmail.mutateAsync({
                to: parseEmailList(email.to),
                cc: email.cc ? parseEmailList(email.cc) : undefined,
                bcc: email.bcc ? parseEmailList(email.bcc) : undefined,
                subject: email.subject,
                bodyText: htmlToPlainText(email.body),
                bodyHtml: email.body,
                attachments,
                inReplyTo: originalMessage?.message?.messageId,
                references: originalMessage?.message?.references,
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

    const handleSaveDraft = async () => {
        if (!selectedMailbox) return

        try {
            const result = await saveDraft.mutateAsync({
                to: email.to ? parseEmailList(email.to) : undefined,
                cc: email.cc ? parseEmailList(email.cc) : undefined,
                bcc: email.bcc ? parseEmailList(email.bcc) : undefined,
                subject: email.subject,
                bodyText: htmlToPlainText(email.body),
                bodyHtml: email.body,
                draftId: activeDraftId,
                attachments,
            })
            setActiveDraftId(result.draftId)
            setIsSaved(true)
            toast({ title: 'Draft saved', variant: 'success' })
            setTimeout(() => setIsSaved(false), 2000)
        } catch (error) {
            toast({
                title: 'Failed to save draft',
                description: error instanceof Error ? error.message : 'Unknown error',
                variant: 'destructive'
            })
        }
    }

    const handleClose = async () => {
        if (email.to || email.subject || email.body.trim().replace(/<br\/?>/g, '') !== '') {
            await handleSaveDraft()
        }
        closeCompose()
    }

    const handleDiscard = () => {
        closeCompose()
    }

    const handleAttachment = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || [])
        setAttachments(prev => [...prev, ...files])
    }

    const removeAttachment = (index: number) => {
        setAttachments(prev => prev.filter((_, i) => i !== index))
    }

    const formatBytes = (bytes: number) => {
        if (bytes === 0) return '0 Bytes'
        const k = 1024
        const sizes = ['Bytes', 'KB', 'MB', 'GB']
        const i = Math.floor(Math.log(bytes) / Math.log(k))
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
    }

    useKeyboardShortcuts({
        enabled: isOpen,
        onSend: handleSend,
        onSaveDraft: handleSaveDraft,
        onEscape: handleClose
    })

    if (!isOpen) return null

    const title = replyToId ? 'Reply' : forwardId ? 'Forward' : draftId ? 'Edit Draft' : 'New Message'

    // No mailboxes state
    if (mailboxes.length === 0) {
        return (
            <>
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[59] animate-in fade-in duration-200" onClick={closeCompose} />
                <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-8 w-[calc(100%-2rem)] sm:w-[520px] z-[60] bg-background border border-border shadow-2xl rounded-2xl overflow-hidden">
                    <div className="flex items-center justify-between px-5 py-3 bg-muted/50">
                        <span className="font-semibold text-sm text-foreground">{title}</span>
                        <button onClick={closeCompose} className="p-1.5 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground transition-colors">
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
                    <span className="font-medium text-sm text-foreground truncate flex-1">
                        {email.subject || title}
                    </span>
                    <div className="flex items-center gap-1">
                        <button
                            onClick={(e) => { e.stopPropagation(); setIsMinimized(false) }}
                            className="p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition-colors"
                        >
                            <Maximize2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); handleClose() }}
                            className="p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground transition-colors"
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
                    if (window.innerWidth < 640) handleClose()
                }}
            />

            {/* Compose Window */}
            <div className={`${containerClass} bg-background border border-border/80 shadow-2xl sm:rounded-2xl overflow-hidden flex flex-col animate-in slide-in-from-bottom-4 fade-in duration-300`}>

                {/* Header Bar */}
                <div className="flex items-center justify-between px-4 py-2.5 bg-muted/40 border-b border-border/50 shrink-0">
                    <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                        <span className="font-semibold text-sm text-foreground">{title}</span>
                        {selectedMailbox && (
                            <span className="text-xs text-muted-foreground hidden sm:inline">
                                from {selectedMailbox.email}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-0.5">
                        <button
                            onClick={() => setIsMinimized(true)}
                            className="p-1.5 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                            title="Minimize"
                        >
                            <Minus className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => setIsMaximized(!isMaximized)}
                            className="hidden sm:flex p-1.5 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                            title={isMaximized ? 'Restore' : 'Maximize'}
                        >
                            {isMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                        </button>
                        <button
                            onClick={handleClose}
                            className="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded-lg text-muted-foreground transition-colors"
                            title="Close"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {/* Fields */}
                <div className="shrink-0">
                    {/* To */}
                    <div className="flex items-center px-4 py-1.5 border-b border-border/30 group">
                        <span className="w-10 text-xs font-medium text-muted-foreground uppercase tracking-wide">To</span>
                        <div className="flex-1 min-w-0">
                            <ContactAutocomplete
                                value={email.to}
                                onChange={(value) => setEmail({ ...email, to: value })}
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
                            <span className="w-10 text-xs font-medium text-muted-foreground uppercase tracking-wide">Cc</span>
                            <div className="flex-1 min-w-0">
                                <ContactAutocomplete
                                    value={email.cc}
                                    onChange={(value) => setEmail({ ...email, cc: value })}
                                    placeholder=""
                                    className="w-full px-2 py-1.5 bg-transparent border-0 focus:ring-0 text-sm text-foreground placeholder-muted-foreground/50 outline-none"
                                />
                            </div>
                        </div>
                    )}

                    {/* Bcc */}
                    {showBcc && (
                        <div className="flex items-center px-4 py-1.5 border-b border-border/30">
                            <span className="w-10 text-xs font-medium text-muted-foreground uppercase tracking-wide">Bcc</span>
                            <div className="flex-1 min-w-0">
                                <ContactAutocomplete
                                    value={email.bcc}
                                    onChange={(value) => setEmail({ ...email, bcc: value })}
                                    placeholder=""
                                    className="w-full px-2 py-1.5 bg-transparent border-0 focus:ring-0 text-sm text-foreground placeholder-muted-foreground/50 outline-none"
                                />
                            </div>
                        </div>
                    )}

                    {/* Subject */}
                    <div className="flex items-center px-4 py-1.5 border-b border-border/30">
                        <span className="w-10 text-xs font-medium text-muted-foreground uppercase tracking-wide sr-only">Sub</span>
                        <input
                            type="text"
                            value={email.subject}
                            onChange={(e) => setEmail({ ...email, subject: e.target.value })}
                            placeholder="Subject"
                            className="w-full bg-transparent border-0 focus:ring-0 text-sm font-medium placeholder-muted-foreground/50 px-2 py-1.5 outline-none text-foreground"
                        />
                    </div>
                </div>

                {/* Editor */}
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                    <div className="flex-1 overflow-y-auto px-4">
                        <RichTextEditor
                            value={email.body}
                            onChange={(value) => setEmail({ ...email, body: value })}
                            placeholder="Write your message..."
                            minHeight={isMaximized ? 400 : 200}
                            className="flex-1 border-0 compose-editor-borderless"
                        />
                    </div>
                </div>

                {/* Attachments */}
                {attachments.length > 0 && (
                    <div className="px-4 py-2 border-t border-border/30 shrink-0">
                        <div className="flex flex-wrap gap-1.5">
                            {attachments.map((file, index) => (
                                <div key={index} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/60 rounded-lg text-xs group/att">
                                    <Paperclip className="w-3 h-3 text-muted-foreground" />
                                    <span className="font-medium max-w-[120px] truncate">{file.name}</span>
                                    <span className="text-muted-foreground">({formatBytes(file.size)})</span>
                                    <button
                                        onClick={() => removeAttachment(index)}
                                        className="p-0.5 hover:bg-background rounded text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover/att:opacity-100"
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
                            onClick={handleSend}
                            disabled={sendEmail.isPending}
                            className="flex items-center gap-2 pl-4 pr-3 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-sm font-medium transition-all active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none"
                        >
                            {sendEmail.isPending ? 'Sending...' : 'Send'}
                            <Send className="w-3.5 h-3.5" />
                        </button>

                        <div className="w-px h-5 bg-border/50" />

                        {/* Toolbar icons */}
                        <label className="p-2 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground cursor-pointer transition-colors" title="Attach files">
                            <Paperclip className="w-4 h-4" />
                            <input type="file" multiple onChange={handleAttachment} className="hidden" />
                        </label>
                        <label className="p-2 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground cursor-pointer transition-colors" title="Insert image">
                            <ImageIcon className="w-4 h-4" />
                            <input type="file" accept="image/*" className="hidden" />
                        </label>

                        {/* Signatures */}
                        {signatures.length > 0 && (
                            <div className="relative">
                                <button
                                    onClick={() => setShowSignatureMenu(!showSignatureMenu)}
                                    className="p-2 hover:bg-accent rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                                    title="Insert signature"
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
                                                    onClick={() => insertSignature(sig)}
                                                    className="w-full px-3 py-2 text-left text-sm hover:bg-accent text-foreground transition-colors flex items-center justify-between"
                                                >
                                                    <span className="font-medium">{sig.name}</span>
                                                    {sig.isDefault && (
                                                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
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
                            <span className="text-xs font-medium text-green-600 dark:text-green-400 bg-green-500/10 px-2 py-1 rounded-md animate-in fade-in duration-200">
                                Saved
                            </span>
                        )}
                        <button
                            onClick={handleDiscard}
                            className="p-2 hover:bg-destructive/10 text-muted-foreground hover:text-destructive rounded-lg transition-colors"
                            title="Discard"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>
        </>
    )
}
