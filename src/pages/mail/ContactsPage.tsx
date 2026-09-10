import React from 'react'
import { MailLayout } from '../../components/mail/MailLayout'
import { toast } from '../../components/ui/toaster'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/Dialog'
import { useContacts, useCreateContact, useUpdateContact, useDeleteContact, useImportContactsCsv } from '../../hooks/useMail'
import {
    Plus,
    Search,
    Upload,
    Trash2,
    Edit2,
    X,
    Users,
    Mail,
    Building,
    ChevronLeft,
    ChevronRight,
    FileText
} from 'lucide-react'

interface ContactForm {
    email: string
    firstName: string
    lastName: string
    company: string
}

const emptyForm: ContactForm = { email: '', firstName: '', lastName: '', company: '' }

export default function ContactsPage() {
    const [search, setSearch] = React.useState('')
    const [page, setPage] = React.useState(1)
    const [showForm, setShowForm] = React.useState(false)
    const [editingId, setEditingId] = React.useState<string | null>(null)
    const [form, setForm] = React.useState<ContactForm>(emptyForm)
    const [deleteConfirm, setDeleteConfirm] = React.useState<string | null>(null)
    const [showImport, setShowImport] = React.useState(false)
    const [csvFile, setCsvFile] = React.useState<File | null>(null)
    const [importing, setImporting] = React.useState(false)
    const [dragOver, setDragOver] = React.useState(false)
    const fileInputRef = React.useRef<HTMLInputElement>(null)

    const { data, isLoading } = useContacts(search || undefined, page, 20)
    const createContact = useCreateContact()
    const updateContact = useUpdateContact()
    const deleteContact = useDeleteContact()
    const importCsv = useImportContactsCsv()

    const contacts = data?.contacts || []
    const total = data?.total || 0
    const hasMore = data?.hasMore || false

    const handleOpenCreate = () => {
        setForm(emptyForm)
        setEditingId(null)
        setShowForm(true)
    }

    const handleOpenEdit = (contact: typeof contacts[0]) => {
        setForm({
            email: contact.email,
            firstName: contact.firstName || '',
            lastName: contact.lastName || '',
            company: contact.company || '',
        })
        setEditingId(contact.id)
        setShowForm(true)
    }

    const handleSave = async () => {
        if (!form.email.trim()) {
            toast({ title: 'Email is required', variant: 'destructive' })
            return
        }

        try {
            if (editingId) {
                await updateContact.mutateAsync({
                    id: editingId,
                    data: {
                        email: form.email,
                        firstName: form.firstName || undefined,
                        lastName: form.lastName || undefined,
                        company: form.company || undefined,
                    },
                })
                toast({ title: 'Contact updated', variant: 'success' })
            } else {
                await createContact.mutateAsync({
                    email: form.email,
                    firstName: form.firstName || undefined,
                    lastName: form.lastName || undefined,
                    company: form.company || undefined,
                })
                toast({ title: 'Contact created', variant: 'success' })
            }
            setShowForm(false)
            setEditingId(null)
            setForm(emptyForm)
        } catch (error) {
            toast({
                title: editingId ? 'Failed to update contact' : 'Failed to create contact',
                description: error instanceof Error ? error.message : 'Unknown error',
                variant: 'destructive',
            })
        }
    }

    const handleDelete = async (id: string) => {
        try {
            await deleteContact.mutateAsync(id)
            toast({ title: 'Contact deleted', variant: 'success' })
            setDeleteConfirm(null)
        } catch (error) {
            toast({
                title: 'Failed to delete contact',
                description: error instanceof Error ? error.message : 'Unknown error',
                variant: 'destructive',
            })
        }
    }

    const processCsvFile = async (file: File) => {
        setCsvFile(file)
        setImporting(true)

        try {
            const content = await file.text()
            const result = await importCsv.mutateAsync(content)
            toast({
                title: `Import complete: ${result.imported} contacts imported`,
                description: result.skipped > 0 ? `${result.skipped} skipped (duplicates or invalid)` : undefined,
                variant: result.imported > 0 ? 'success' : 'destructive',
            })
            setShowImport(false)
            setCsvFile(null)
        } catch (error) {
            toast({
                title: 'Failed to import CSV',
                description: error instanceof Error ? error.message : 'Unknown error',
                variant: 'destructive',
            })
        } finally {
            setImporting(false)
        }
    }

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (file) processCsvFile(file)
    }

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault()
        setDragOver(false)
        const file = e.dataTransfer.files[0]
        if (file && (file.name.endsWith('.csv') || file.name.endsWith('.txt') || file.type === 'text/csv' || file.type === 'text/plain')) {
            processCsvFile(file)
        } else {
            toast({ title: 'Please drop a CSV file', variant: 'destructive' })
        }
    }

    const getDisplayName = (contact: typeof contacts[0]): string => {
        const parts = [contact.firstName, contact.lastName].filter(Boolean)
        return parts.join(' ') || '—'
    }

    const formatDate = (dateStr: string | null): string => {
        if (!dateStr) return '—'
        return new Date(dateStr).toLocaleDateString()
    }

    return (
        <MailLayout>
            <div className="h-full flex flex-col bg-background">
                <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-border">
                    <div className="flex items-center gap-3">
                        <Users className="w-6 h-6 text-muted-foreground" />
                        <h1 className="text-lg font-semibold text-foreground">Contacts</h1>
                        <span className="text-sm text-muted-foreground">{total} total</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setShowImport(true)}
                            className="inline-flex items-center gap-2 px-3 py-2 border border-border rounded-lg text-sm font-medium text-foreground hover:bg-muted transition-colors"
                        >
                            <Upload className="w-4 h-4" />
                            <span className="hidden sm:inline">Import CSV</span>
                        </button>
                        <button
                            onClick={handleOpenCreate}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-sm font-medium transition-colors"
                        >
                            <Plus className="w-4 h-4" />
                            <span className="hidden sm:inline">Add Contact</span>
                        </button>
                    </div>
                </div>

                <div className="px-4 sm:px-6 py-3 border-b border-border">
                    <div className="relative max-w-md">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <input
                            type="text"
                            placeholder="Search contacts..."
                            value={search}
                            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
                            className="w-full pl-10 pr-4 py-2 bg-muted/50 border border-transparent rounded-lg text-sm focus:bg-background focus:border-border focus:ring-4 focus:ring-primary/10 transition-all outline-none"
                        />
                        {search && (
                            <button
                                onClick={() => setSearch('')}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        )}
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto">
                    {isLoading ? (
                        <div className="flex items-center justify-center h-64">
                            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                        </div>
                    ) : contacts.length === 0 ? (
                        <div className="flex items-center justify-center h-64">
                            <div className="text-center max-w-md px-6">
                                <Users className="w-12 h-12 mx-auto mb-4 text-muted-foreground/50" />
                                <h2 className="text-lg font-semibold text-foreground mb-2">
                                    {search ? 'No contacts found' : 'No contacts yet'}
                                </h2>
                                <p className="text-sm text-muted-foreground mb-4">
                                    {search
                                        ? 'Try a different search term.'
                                        : 'Contacts are automatically added when you send emails. You can also add them manually or import from CSV.'}
                                </p>
                                {!search && (
                                    <button
                                        onClick={handleOpenCreate}
                                        className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-sm font-medium transition-colors"
                                    >
                                        <Plus className="w-4 h-4" />
                                        Add First Contact
                                    </button>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full">
                                <thead>
                                    <tr className="border-b border-border">
                                        <th className="text-left px-4 sm:px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Contact</th>
                                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell">Company</th>
                                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden sm:table-cell">Times Emailed</th>
                                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden lg:table-cell">Last Emailed</th>
                                        <th className="text-right px-4 sm:px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                    {contacts.map((contact) => (
                                        <tr key={contact.id} className="hover:bg-muted/50 transition-colors">
                                            <td className="px-4 sm:px-6 py-3">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                                                        <span className="text-sm font-medium text-primary">
                                                            {(contact.firstName?.[0] || contact.email[0]).toUpperCase()}
                                                        </span>
                                                    </div>
                                                    <div className="min-w-0">
                                                        <div className="text-sm font-medium text-foreground truncate">
                                                            {getDisplayName(contact)}
                                                        </div>
                                                        <div className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                                                            <Mail className="w-3 h-3 shrink-0" />
                                                            {contact.email}
                                                        </div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 hidden md:table-cell">
                                                {contact.company ? (
                                                    <span className="inline-flex items-center gap-1 text-sm text-foreground">
                                                        <Building className="w-3.5 h-3.5 text-muted-foreground" />
                                                        {contact.company}
                                                    </span>
                                                ) : (
                                                    <span className="text-sm text-muted-foreground">—</span>
                                                )}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-foreground hidden sm:table-cell">
                                                {contact.emailedCount}
                                            </td>
                                            <td className="px-4 py-3 text-sm text-muted-foreground hidden lg:table-cell">
                                                {formatDate(contact.lastEmailedAt)}
                                            </td>
                                            <td className="px-4 sm:px-6 py-3 text-right">
                                                <div className="flex items-center justify-end gap-1">
                                                    <button
                                                        onClick={() => handleOpenEdit(contact)}
                                                        className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                                        title="Edit"
                                                    >
                                                        <Edit2 className="w-4 h-4" />
                                                    </button>
                                                    {deleteConfirm === contact.id ? (
                                                        <div className="flex items-center gap-1">
                                                            <button
                                                                onClick={() => handleDelete(contact.id)}
                                                                className="px-2 py-1 text-xs bg-destructive text-destructive-foreground rounded"
                                                            >
                                                                Confirm
                                                            </button>
                                                            <button
                                                                onClick={() => setDeleteConfirm(null)}
                                                                className="px-2 py-1 text-xs bg-muted text-foreground rounded"
                                                            >
                                                                Cancel
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <button
                                                            onClick={() => setDeleteConfirm(contact.id)}
                                                            className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors"
                                                            title="Delete"
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {total > 20 && (
                    <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-t border-border">
                        <span className="text-sm text-muted-foreground">
                            Showing {(page - 1) * 20 + 1}–{Math.min(page * 20, total)} of {total}
                        </span>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setPage(p => Math.max(1, p - 1))}
                                disabled={page === 1}
                                className="p-2 rounded-lg hover:bg-muted text-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-sm text-foreground">Page {page}</span>
                            <button
                                onClick={() => setPage(p => p + 1)}
                                disabled={!hasMore}
                                className="p-2 rounded-lg hover:bg-muted text-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                <ChevronRight className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <Dialog
                open={showForm}
                onOpenChange={(open) => { setShowForm(open); if (!open) setEditingId(null) }}
            >
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{editingId ? 'Edit Contact' : 'New Contact'}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-foreground mb-1.5">Email *</label>
                                <input
                                    type="email"
                                    value={form.email}
                                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                                    placeholder="contact@example.com"
                                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-foreground mb-1.5">First Name</label>
                                    <input
                                        type="text"
                                        value={form.firstName}
                                        onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                                        placeholder="John"
                                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-foreground mb-1.5">Last Name</label>
                                    <input
                                        type="text"
                                        value={form.lastName}
                                        onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                                        placeholder="Doe"
                                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-foreground mb-1.5">Company</label>
                                <input
                                    type="text"
                                    value={form.company}
                                    onChange={(e) => setForm({ ...form, company: e.target.value })}
                                    placeholder="Acme Corp"
                                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all"
                                />
                            </div>
                        </div>
                        <div className="flex items-center justify-end gap-3 mt-6">
                            <button
                                onClick={() => { setShowForm(false); setEditingId(null) }}
                                className="px-4 py-2 text-foreground hover:bg-muted rounded-lg font-medium transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={createContact.isPending || updateContact.isPending}
                                className="px-4 py-2 bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground rounded-lg font-medium transition-colors"
                            >
                                {createContact.isPending || updateContact.isPending ? 'Saving...' : editingId ? 'Update' : 'Create'}
                            </button>
                        </div>
                </DialogContent>
            </Dialog>

            <Dialog
                open={showImport}
                onOpenChange={(open) => { setShowImport(open); if (!open) setCsvFile(null) }}
            >
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Import Contacts from CSV</DialogTitle>
                    </DialogHeader>

                        <div
                            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                            onDragLeave={() => setDragOver(false)}
                            onDrop={handleDrop}
                            className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
                                dragOver
                                    ? 'border-primary bg-primary/5'
                                    : 'border-border hover:border-muted-foreground/50'
                            }`}
                        >
                            <FileText className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
                            <p className="text-sm text-foreground font-medium mb-1">
                                {importing ? 'Importing...' : 'Drop your CSV file here'}
                            </p>
                            <p className="text-xs text-muted-foreground mb-4">
                                or click to browse
                            </p>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".csv,.txt"
                                onChange={handleFileSelect}
                                className="hidden"
                            />
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={importing}
                                className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground rounded-lg text-sm font-medium transition-colors"
                            >
                                <Upload className="w-4 h-4" />
                                {importing ? 'Importing...' : 'Choose File'}
                            </button>
                            {csvFile && (
                                <p className="mt-3 text-sm text-foreground">
                                    Selected: {csvFile.name}
                                </p>
                            )}
                        </div>

                        <div className="mt-4 p-3 bg-muted/50 rounded-lg">
                            <p className="text-xs text-muted-foreground">
                                <strong>CSV format:</strong> The first row should contain headers.
                                Supported columns: <code className="bg-muted px-1 rounded">email</code>,{' '}
                                <code className="bg-muted px-1 rounded">firstName</code>,{' '}
                                <code className="bg-muted px-1 rounded">lastName</code>,{' '}
                                <code className="bg-muted px-1 rounded">company</code>
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                                Supports comma and semicolon delimiters. Duplicate emails are skipped.
                            </p>
                        </div>
                </DialogContent>
            </Dialog>
        </MailLayout>
    )
}
