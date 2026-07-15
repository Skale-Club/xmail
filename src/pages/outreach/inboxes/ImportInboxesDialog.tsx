import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Upload, AlertCircle, CheckCircle2 } from 'lucide-react'
import { apiFetch } from '../../../lib/api-client'
import { parseMailboxCsv, type ParsedMailbox } from './parse-mailbox-csv'
import { toast } from '../../../components/ui/toaster'

interface InboxProvider {
    id: string
    label: string
    description: string
    supportsProvisioning: boolean
    supportsCredentialImport: boolean
}

interface ImportResult {
    imported: number
    duplicates: number
    provider: string
}

interface ImportInboxesDialogProps {
    organizationId: string
    onClose: () => void
}

export function ImportInboxesDialog({ organizationId, onClose }: ImportInboxesDialogProps) {
    const queryClient = useQueryClient()
    const [provider, setProvider] = React.useState('manual')
    const [raw, setRaw] = React.useState('')

    const { data: providersData } = useQuery({
        queryKey: ['inbox-providers'],
        queryFn: () => apiFetch<{ providers: InboxProvider[] }>('/api/outreach/email-accounts/providers'),
    })

    const parsed = React.useMemo(() => (raw.trim() ? parseMailboxCsv(raw) : null), [raw])

    const importMutation = useMutation({
        // apiFetch, not apiRequest: apiRequest resolves to the raw Response, so reading
        // result.imported off it yields undefined rather than the count.
        mutationFn: (mailboxes: ParsedMailbox[]) =>
            apiFetch<ImportResult>(`/api/outreach/email-accounts/bulk-import?organizationId=${organizationId}`, {
                method: 'POST',
                body: JSON.stringify({ provider, mailboxes }),
            }),
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: ['email-accounts'] })
            const dupNote = result.duplicates > 0 ? ` ${result.duplicates} already existed and were skipped.` : ''
            toast({
                title: `Imported ${result.imported} inbox${result.imported === 1 ? '' : 'es'}`,
                description: `${dupNote} Verify each one before sending — verification is what checks the credentials actually work.`.trim(),
                variant: 'success',
            })
            onClose()
        },
        onError: (err) => {
            toast({ title: 'Import failed', description: (err as Error).message, variant: 'destructive' })
        },
    })

    const importable = parsed?.mailboxes.length ?? 0
    const providers = providersData?.providers ?? []

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Import inboxes">
            <div className="bg-card border border-border rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 className="text-lg font-semibold text-foreground">Import Inboxes</h2>
                    <button onClick={onClose} className="p-1 rounded hover:bg-muted" aria-label="Close">
                        <X className="w-5 h-5 text-muted-foreground" />
                    </button>
                </div>

                <div className="p-4 space-y-4">
                    <div>
                        <label htmlFor="import-provider" className="block text-sm font-medium text-foreground mb-1">
                            Where did these come from?
                        </label>
                        <select
                            id="import-provider"
                            value={provider}
                            onChange={(e) => setProvider(e.target.value)}
                            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground"
                        >
                            {providers.map((p) => (
                                <option key={p.id} value={p.id}>{p.label}</option>
                            ))}
                        </select>
                        <p className="text-xs text-muted-foreground mt-1">
                            Recorded against each inbox so warmup state can be synced back later. It does not change how mail is sent.
                        </p>
                    </div>

                    <div>
                        <label htmlFor="import-csv" className="block text-sm font-medium text-foreground mb-1">
                            Paste the CSV your provider exported
                        </label>
                        <textarea
                            id="import-csv"
                            value={raw}
                            onChange={(e) => setRaw(e.target.value)}
                            rows={10}
                            spellCheck={false}
                            placeholder={'Email,SMTP Host,SMTP Port,SMTP Password,IMAP Host,IMAP Port\njane@acme-outbound.com,smtp.provider.com,587,s3cret,imap.provider.com,993'}
                            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground font-mono text-xs"
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                            Include the header row — columns are matched by name, so the order does not matter.
                            Comma, semicolon and tab separated all work.
                        </p>
                    </div>

                    {parsed && (
                        <div className="space-y-2">
                            {importable > 0 && (
                                <div className="flex items-start gap-2 text-sm text-foreground bg-primary/5 border border-primary/20 rounded-lg p-3">
                                    <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                                    <div>
                                        <p className="font-medium">{importable} inbox{importable === 1 ? '' : 'es'} ready to import</p>
                                        <p className="text-muted-foreground text-xs mt-0.5">
                                            {parsed.mailboxes.slice(0, 3).map((m) => m.email).join(', ')}
                                            {importable > 3 ? ` and ${importable - 3} more` : ''}
                                        </p>
                                    </div>
                                </div>
                            )}
                            {parsed.errors.length > 0 && (
                                <div className="flex items-start gap-2 text-sm bg-destructive/5 border border-destructive/20 rounded-lg p-3">
                                    <AlertCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                                    <div className="min-w-0">
                                        <p className="font-medium text-foreground">
                                            {parsed.errors.length} row{parsed.errors.length === 1 ? '' : 's'} could not be read
                                        </p>
                                        <ul className="text-muted-foreground text-xs mt-0.5 space-y-0.5">
                                            {parsed.errors.slice(0, 4).map((e, i) => <li key={i}>{e}</li>)}
                                            {parsed.errors.length > 4 && <li>and {parsed.errors.length - 4} more…</li>}
                                        </ul>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    <p className="text-xs text-muted-foreground">
                        Credentials are encrypted before they are stored and are never sent back to the browser.
                        Imported inboxes land as <span className="font-medium text-foreground">pending</span> — hit Verify on each
                        to confirm the credentials work. IMAP is required for reply and bounce detection.
                    </p>
                </div>

                <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-foreground rounded-lg hover:bg-muted transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => parsed && importMutation.mutate(parsed.mailboxes)}
                        disabled={importable === 0 || importMutation.isPending}
                        className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Upload className="w-4 h-4" />
                        {importMutation.isPending ? 'Importing…' : `Import ${importable || ''}`.trim()}
                    </button>
                </div>
            </div>
        </div>
    )
}
