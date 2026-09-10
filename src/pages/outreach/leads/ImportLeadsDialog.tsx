import React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Upload, AlertCircle, CheckCircle2 } from 'lucide-react'
import { apiFetch } from '../../../lib/api-client'
import { parseLeadCsv, type ParsedLead } from './parse-lead-csv'
import { toast } from '../../../components/ui/toaster'

interface LeadList {
    id: string
    name: string
}

interface ImportResult {
    imported: number
    duplicates: number
}

interface ImportLeadsDialogProps {
    organizationId: string
    leadLists: LeadList[]
    onClose: () => void
}

export function ImportLeadsDialog({ organizationId, leadLists, onClose }: ImportLeadsDialogProps) {
    const queryClient = useQueryClient()
    const [leadListId, setLeadListId] = React.useState('')
    const [raw, setRaw] = React.useState('')

    const parsed = React.useMemo(() => (raw.trim() ? parseLeadCsv(raw) : null), [raw])

    const importMutation = useMutation({
        mutationFn: (parsedLeads: ParsedLead[]) =>
            apiFetch<ImportResult>(`/api/outreach/leads/bulk-import?organizationId=${organizationId}`, {
                method: 'POST',
                body: JSON.stringify({ leadListId: leadListId || undefined, leads: parsedLeads }),
            }),
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: ['leads'] })
            queryClient.invalidateQueries({ queryKey: ['lead-lists'] })
            const dupNote = result.duplicates > 0 ? ` ${result.duplicates} already existed and were updated.` : ''
            toast({
                title: `Imported ${result.imported} lead${result.imported === 1 ? '' : 's'}`,
                description: dupNote.trim() || undefined,
                variant: 'success',
            })
            onClose()
        },
        onError: (err) => {
            toast({ title: 'Import failed', description: (err as Error).message, variant: 'destructive' })
        },
    })

    const importable = parsed?.leads.length ?? 0

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Import leads">
            <div className="bg-card border border-border rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 className="text-lg font-semibold text-foreground">Import Leads</h2>
                    <button onClick={onClose} className="p-1 rounded hover:bg-muted" aria-label="Close">
                        <X className="w-5 h-5 text-muted-foreground" />
                    </button>
                </div>

                <div className="p-4 space-y-4">
                    <div>
                        <label htmlFor="import-lead-list" className="block text-sm font-medium text-foreground mb-1">
                            Add to list (optional)
                        </label>
                        <select
                            id="import-lead-list"
                            value={leadListId}
                            onChange={(e) => setLeadListId(e.target.value)}
                            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground"
                        >
                            <option value="">No list</option>
                            {leadLists.map((list) => (
                                <option key={list.id} value={list.id}>{list.name}</option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label htmlFor="import-lead-csv" className="block text-sm font-medium text-foreground mb-1">
                            Paste your lead CSV
                        </label>
                        <textarea
                            id="import-lead-csv"
                            value={raw}
                            onChange={(e) => setRaw(e.target.value)}
                            rows={10}
                            spellCheck={false}
                            placeholder={'Email,First Name,Last Name,Company,Title\njane@acme.example,Jane,Doe,Acme Inc,VP Sales'}
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
                                        <p className="font-medium">{importable} lead{importable === 1 ? '' : 's'} ready to import</p>
                                        <p className="text-muted-foreground text-xs mt-0.5">
                                            {parsed.leads.slice(0, 3).map((l) => l.email).join(', ')}
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
                </div>

                <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-foreground rounded-lg hover:bg-muted transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => parsed && importMutation.mutate(parsed.leads)}
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
