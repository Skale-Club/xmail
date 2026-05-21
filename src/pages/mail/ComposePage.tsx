import React from 'react'
import { Link, useLocation, useSearch } from 'wouter'
import { MailLayout } from '../../components/mail/MailLayout'
import { toast } from '../../components/ui/toaster'
import { useMailbox } from '../../hooks/useMailbox'
import { useSendEmail, useSaveDraft, useMessage } from '../../hooks/useMail'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { RichTextEditor, htmlToPlainText } from '../../components/mail/RichTextEditor'
import { ContactAutocomplete } from '../../components/mail/ContactAutocomplete'
import { apiFetch } from '../../lib/api-client'
import {
    ArrowLeft,
    Send,
    X,
    Paperclip,
    Image,
    Save,
    Trash2,
    AlertCircle,
    PenTool
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

export default function ComposePage() {
    const [, setLocation] = useLocation()
    const search = useSearch()
    const params = new URLSearchParams(search)
    const replyToId = params.get('reply')
    const replyAll = params.get('replyAll') === 'true'
    const forwardId = params.get('forward')
    const draftId = params.get('draft')

    const { selectedMailbox, mailboxes } = useMailbox()
    const sendEmail = useSendEmail()
    const saveDraft = useSaveDraft()
    const { data: originalMessage } = useMessage(replyToId || forwardId || draftId)

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
    const [discardConfirm, setDiscardConfirm] = React.useState(false)
    const [signatures, setSignatures] = React.useState<Signature[]>([])
    const [showSignatureMenu, setShowSignatureMenu] = React.useState(false)
    const [prefilled, setPrefilled] = React.useState(false)
    const [activeDraftId, setActiveDraftId] = React.useState<string | undefined>(draftId || undefined)

    React.useEffect(() => {
        setActiveDraftId(draftId || undefined)
    }, [draftId])

    React.useEffect(() => {
        if (selectedMailbox) {
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
    }, [selectedMailbox])

    React.useEffect(() => {
        if (prefilled || !originalMessage?.message) return
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
    }, [originalMessage, replyToId, replyAll, forwardId, draftId, prefilled, selectedMailbox])

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
            setLocation('/mail/sent')
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
        if (!selectedMailbox) {
            toast({ title: 'No email account selected', variant: 'destructive' })
            return
        }

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

    const handleDiscard = () => {
        setDiscardConfirm(true)
    }

    const confirmDiscard = () => {
        setLocation('/mail/inbox')
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
        enabled: true,
        onSend: handleSend,
        onSaveDraft: handleSaveDraft,
        onEscape: () => {
            if (email.to || email.subject || email.body) {
                setDiscardConfirm(true)
            } else {
                setLocation('/mail/inbox')
            }
        }
    })

    if (mailboxes.length === 0) {
        return (
            <MailLayout>
                <div className="flex items-center justify-center h-full">
                    <div className="text-center max-w-md px-6">
                        <AlertCircle className="w-16 h-16 mx-auto mb-4 text-yellow-500" />
                        <h2 className="text-xl font-bold text-foreground mb-2">
                            No Email Accounts Connected
                        </h2>
                        <p className="text-muted-foreground mb-6">
                            Add an email account to start composing emails.
                        </p>
                        <Link
                            href="/mail/settings"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg font-medium transition-colors"
                        >
                            Add Email Account
                        </Link>
                    </div>
                </div>
            </MailLayout>
        )
    }

    return (
        <MailLayout>
            <div className="h-full flex flex-col bg-background">
                <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-border">
                    <div className="flex items-center gap-4">
                        <Link
                            href="/mail/inbox"
                            className="p-2 rounded-lg hover:bg-muted transition-colors"
                        >
                            <ArrowLeft className="w-5 h-5 text-muted-foreground" />
                        </Link>
                        <h1 className="text-lg font-semibold text-foreground">
                            {replyToId ? 'Reply' : forwardId ? 'Forward' : draftId ? 'Edit Draft' : 'New Message'}
                        </h1>
                        {selectedMailbox && (
                            <span className="text-sm text-muted-foreground hidden sm:inline">
                                from {selectedMailbox.email}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleSaveDraft}
                            disabled={saveDraft.isPending}
                            className="p-2 rounded-lg hover:bg-muted text-muted-foreground transition-colors"
                            title="Save draft (Ctrl+S)"
                        >
                            <Save className={`w-5 h-5 ${saveDraft.isPending ? 'animate-pulse' : ''}`} />
                        </button>
                        <button
                            onClick={handleDiscard}
                            className="p-2 rounded-lg hover:bg-red-500/10 text-gray-500 hover:text-red-500 transition-colors"
                            title="Discard (Esc)"
                        >
                            <Trash2 className="w-5 h-5" />
                        </button>
                        <button
                            onClick={handleSend}
                            disabled={sendEmail.isPending}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground rounded-lg font-medium transition-colors"
                            title="Send (Ctrl+Enter)"
                        >
                            {sendEmail.isPending ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                    Sending...
                                </>
                            ) : (
                                <>
                                    <Send className="w-4 h-4" />
                                    Send
                                </>
                            )}
                        </button>
                    </div>
                </div>

                {isSaved && (
                    <div className="flex items-center gap-2 px-6 py-2 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-sm">
                        <Save className="w-4 h-4" />
                        Draft saved
                    </div>
                )}

                <div className="flex-1 overflow-y-auto">
                    <div className="max-w-4xl mx-auto p-4 sm:p-6">
                        <div className="space-y-4">
                            <div className="flex items-center gap-4">
                                <label className="w-12 sm:w-16 text-sm font-medium text-muted-foreground flex-shrink-0">
                                    To
                                </label>
                                <ContactAutocomplete
                                    value={email.to}
                                    onChange={(value) => setEmail({ ...email, to: value })}
                                    placeholder="recipient@example.com"
                                />
                                <button
                                    onClick={() => setShowCc(!showCc)}
                                    className="text-sm text-muted-foreground hover:text-foreground"
                                >
                                    Cc
                                </button>
                                <button
                                    onClick={() => setShowBcc(!showBcc)}
                                    className="text-sm text-muted-foreground hover:text-foreground"
                                >
                                    Bcc
                                </button>
                            </div>

                            {showCc && (
                                <div className="flex items-center gap-4">
                                    <label className="w-12 sm:w-16 text-sm font-medium text-muted-foreground flex-shrink-0">
                                        Cc
                                    </label>
                                    <ContactAutocomplete
                                        value={email.cc}
                                        onChange={(value) => setEmail({ ...email, cc: value })}
                                        placeholder="cc@example.com"
                                    />
                                </div>
                            )}

                            {showBcc && (
                                <div className="flex items-center gap-4">
                                    <label className="w-12 sm:w-16 text-sm font-medium text-muted-foreground flex-shrink-0">
                                        Bcc
                                    </label>
                                    <ContactAutocomplete
                                        value={email.bcc}
                                        onChange={(value) => setEmail({ ...email, bcc: value })}
                                        placeholder="bcc@example.com"
                                    />
                                </div>
                            )}

                            <div className="flex items-center gap-4">
                                <label className="w-12 sm:w-16 text-sm font-medium text-muted-foreground flex-shrink-0">
                                    Subject
                                </label>
                                <input
                                    type="text"
                                    value={email.subject}
                                    onChange={(e) => setEmail({ ...email, subject: e.target.value })}
                                    placeholder="Enter subject"
                                    className="flex-1 px-3 py-2 bg-transparent border-0 border-b border-border focus:border-primary focus:ring-0 text-foreground placeholder-muted-foreground text-base sm:text-lg"
                                />
                            </div>
                        </div>

                        <div className="mt-4 flex items-center gap-2 border-b border-border pb-3">
                            <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-muted text-muted-foreground cursor-pointer transition-colors text-sm">
                                <Paperclip className="w-4 h-4" />
                                <span className="hidden sm:inline">Attach file</span>
                                <input
                                    type="file"
                                    multiple
                                    onChange={handleAttachment}
                                    className="hidden"
                                />
                            </label>
                            <label className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-muted text-muted-foreground cursor-pointer transition-colors text-sm">
                                <Image className="w-4 h-4" />
                                <span className="hidden sm:inline">Insert image</span>
                                <input
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                />
                            </label>
                            {signatures.length > 0 && (
                                <div className="relative">
                                    <button
                                        onClick={() => setShowSignatureMenu(!showSignatureMenu)}
                                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-muted text-muted-foreground transition-colors text-sm"
                                    >
                                        <PenTool className="w-4 h-4" />
                                        <span className="hidden sm:inline">Signature</span>
                                    </button>
                                    {showSignatureMenu && (
                                        <div className="absolute top-full left-0 mt-1 w-48 bg-popover border border-border rounded-lg shadow-lg z-10">
                                            {signatures.map(sig => (
                                                <button
                                                    key={sig.id}
                                                    onClick={() => insertSignature(sig)}
                                                    className="w-full px-4 py-2 text-left text-sm hover:bg-muted text-foreground"
                                                >
                                                    {sig.name} {sig.isDefault && '(Default)'}
                                                </button>
                                            ))}
                                            <Link
                                                href="/mail/settings?tab=signatures"
                                                className="block px-4 py-2 text-left text-sm text-primary hover:bg-muted"
                                            >
                                                Manage Signatures
                                            </Link>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {attachments.length > 0 && (
                            <div className="mt-4 flex flex-wrap gap-2">
                                {attachments.map((file, index) => (
                                    <div
                                        key={index}
                                        className="flex items-center gap-2 px-3 py-2 bg-muted rounded-lg"
                                    >
                                        <Paperclip className="w-4 h-4 text-muted-foreground" />
                                        <div className="text-sm">
                                            <span className="text-foreground">{file.name}</span>
                                            <span className="text-muted-foreground ml-2">({formatBytes(file.size)})</span>
                                        </div>
                                        <button
                                            onClick={() => removeAttachment(index)}
                                            className="p-1 hover:bg-muted rounded"
                                        >
                                            <X className="w-3 h-3 text-muted-foreground" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="mt-4 rounded-xl border border-border/50 bg-card shadow-sm overflow-hidden">
                            <RichTextEditor
                                value={email.body}
                                onChange={(value) => setEmail({ ...email, body: value })}
                                placeholder="Write your message..."
                                minHeight={300}
                            />
                        </div>
                    </div>
                </div>
            </div>

            {discardConfirm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                    <div className="bg-background rounded-2xl shadow-2xl p-6 max-w-md w-full mx-4">
                        <h2 className="text-xl font-bold text-foreground mb-4">
                            Discard this message?
                        </h2>
                        <p className="text-muted-foreground mb-6">
                            This will permanently delete this message. This action cannot be undone.
                        </p>
                        <div className="flex items-center justify-end gap-3">
                            <button
                                onClick={() => setDiscardConfirm(false)}
                                className="px-4 py-2 text-foreground hover:bg-muted rounded-lg font-medium transition-colors"
                            >
                                Keep
                            </button>
                            <button
                                onClick={confirmDiscard}
                                className="px-4 py-2 bg-destructive hover:bg-destructive/90 text-destructive-foreground rounded-lg font-medium transition-colors"
                            >
                                Discard
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </MailLayout>
    )
}
