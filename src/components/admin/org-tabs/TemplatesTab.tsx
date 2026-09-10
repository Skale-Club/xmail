import { useEffect, useMemo, useState } from 'react'
import { Copy, Edit, Eye, FileText, Plus, Search, Trash2, X } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/Dialog'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { toast } from '../../ui/toaster'
import { EmailHtmlViewer } from '../../mail/EmailHtmlViewer'
import { apiFetch, generateSlug } from './shared'

interface Template {
    id: string
    organizationId: string
    name: string
    slug: string
    subject: string
    plainBody: string | null
    htmlBody: string | null
    variables: string[]
    createdAt: string
    updatedAt: string
}

interface TemplatesTabProps {
    organizationId: string
}

type TemplateDraft = {
    name: string
    slug: string
    subject: string
    plainBody: string
    htmlBody: string
    variables: string[]
}

const emptyTemplate: TemplateDraft = {
    name: '',
    slug: '',
    subject: '',
    plainBody: '',
    htmlBody: '',
    variables: [],
}

export default function TemplatesTab({ organizationId }: TemplatesTabProps) {
    const [templates, setTemplates] = useState<Template[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState('')
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [editingTemplate, setEditingTemplate] = useState<Template | null>(null)
    const [isLoadingTemplate, setIsLoadingTemplate] = useState(false)
    const [previewTemplate, setPreviewTemplate] = useState<Template | null>(null)
    const [previewVariables, setPreviewVariables] = useState<Record<string, string>>({})
    const [previewResult, setPreviewResult] = useState<{
        subject: string | null
        plainBody: string | null
        htmlBody: string | null
    } | null>(null)
    const [variableInput, setVariableInput] = useState('')
    const [draft, setDraft] = useState<TemplateDraft>(emptyTemplate)
    const [templateToDelete, setTemplateToDelete] = useState<Template | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)

    useEffect(() => {
        void fetchTemplates()
    }, [organizationId])

    async function fetchTemplates() {
        setIsLoading(true)
        try {
            const params = new URLSearchParams({ organizationId })
            const data = await apiFetch<{ templates: Template[] }>(`/api/templates?${params.toString()}`)
            setTemplates(data.templates || [])
        } catch (error) {
            console.error('Error fetching templates:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to load templates', variant: 'destructive' })
        } finally {
            setIsLoading(false)
        }
    }

    const filteredTemplates = useMemo(() => (
        templates.filter((template) => (
            template.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            template.slug.toLowerCase().includes(searchQuery.toLowerCase()) ||
            template.subject.toLowerCase().includes(searchQuery.toLowerCase())
        ))
    ), [templates, searchQuery])

    function resetForm() {
        setDraft(emptyTemplate)
        setVariableInput('')
        setEditingTemplate(null)
        setShowCreateModal(false)
    }

    function openCreate() {
        setDraft(emptyTemplate)
        setVariableInput('')
        setEditingTemplate(null)
        setShowCreateModal(true)
    }

    // The templates list omits htmlBody/plainBody (GET /api/templates), so editing or
    // duplicating a template must fetch the full record from GET /api/templates/:id first
    // — populating the editor straight from the list row would silently blank both bodies.
    async function openEdit(template: Template) {
        setShowCreateModal(false)
        setVariableInput('')
        setIsLoadingTemplate(true)
        setEditingTemplate(template)
        try {
            const data = await apiFetch<{ template: Template }>(`/api/templates/${template.id}`)
            setEditingTemplate(data.template)
            setDraft({
                name: data.template.name,
                slug: data.template.slug,
                subject: data.template.subject,
                plainBody: data.template.plainBody || '',
                htmlBody: data.template.htmlBody || '',
                variables: [...(data.template.variables || [])],
            })
        } catch (error) {
            console.error('Error fetching template:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to load template', variant: 'destructive' })
            setEditingTemplate(null)
        } finally {
            setIsLoadingTemplate(false)
        }
    }

    async function handleDuplicate(template: Template) {
        setEditingTemplate(null)
        setVariableInput('')
        setIsLoadingTemplate(true)
        setShowCreateModal(true)
        try {
            const data = await apiFetch<{ template: Template }>(`/api/templates/${template.id}`)
            setDraft({
                name: `${data.template.name} Copy`,
                slug: generateSlug(`${data.template.slug}-copy`),
                subject: data.template.subject,
                plainBody: data.template.plainBody || '',
                htmlBody: data.template.htmlBody || '',
                variables: [...(data.template.variables || [])],
            })
        } catch (error) {
            console.error('Error fetching template:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to load template', variant: 'destructive' })
            setShowCreateModal(false)
        } finally {
            setIsLoadingTemplate(false)
        }
    }

    function addVariable() {
        const value = variableInput.trim()
        if (!value || draft.variables.includes(value)) return

        setDraft((current) => ({
            ...current,
            variables: [...current.variables, value],
        }))
        setVariableInput('')
    }

    function removeVariable(variable: string) {
        setDraft((current) => ({
            ...current,
            variables: current.variables.filter((v) => v !== variable),
        }))
    }

    async function handleCreateTemplate() {
        try {
            const data = await apiFetch<{ template: Template }>('/api/templates', {
                method: 'POST',
                body: JSON.stringify({
                    ...draft,
                    organizationId,
                }),
            })

            setTemplates((current) => [data.template, ...current])
            resetForm()
            toast({ title: 'Template created', variant: 'success' })
        } catch (error) {
            console.error('Error creating template:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to create template', variant: 'destructive' })
        }
    }

    async function handleUpdateTemplate() {
        if (!editingTemplate) return

        try {
            // Send plainBody/htmlBody as-is (including '') so clearing a body in the
            // editor actually clears it server-side instead of being dropped as undefined.
            const data = await apiFetch<{ template: Template }>(`/api/templates/${editingTemplate.id}`, {
                method: 'PUT',
                body: JSON.stringify(draft),
            })

            setTemplates((current) => current.map((template) => (
                template.id === editingTemplate.id ? data.template : template
            )))
            resetForm()
            toast({ title: 'Template updated', variant: 'success' })
        } catch (error) {
            console.error('Error updating template:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to update template', variant: 'destructive' })
        }
    }

    async function handleDeleteTemplate() {
        if (!templateToDelete) return
        setIsDeleting(true)
        try {
            await apiFetch(`/api/templates/${templateToDelete.id}`, {
                method: 'DELETE',
            })

            setTemplates((current) => current.filter((template) => template.id !== templateToDelete.id))
            toast({ title: 'Template deleted', variant: 'success' })
            setTemplateToDelete(null)
        } catch (error) {
            console.error('Error deleting template:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to delete template', variant: 'destructive' })
        } finally {
            setIsDeleting(false)
        }
    }

    async function handlePreview() {
        if (!previewTemplate) return

        try {
            const data = await apiFetch<{
                subject: string | null
                plainBody: string | null
                htmlBody: string | null
            }>(`/api/templates/${previewTemplate.id}/render`, {
                method: 'POST',
                body: JSON.stringify({ variables: previewVariables }),
            })

            setPreviewResult(data)
        } catch (error) {
            console.error('Error previewing template:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to preview template', variant: 'destructive' })
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                    <h3 className="text-lg font-semibold">Templates</h3>
                    <p className="text-sm text-muted-foreground">Create reusable email templates with preview support.</p>
                </div>
                <Button onClick={openCreate}>
                    <Plus className="mr-2 h-4 w-4" />
                    New Template
                </Button>
            </div>

            <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    className="pl-10"
                    placeholder="Search templates..."
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                />
            </div>

            {isLoading ? (
                <div className="flex justify-center p-8">
                    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                </div>
            ) : filteredTemplates.length === 0 ? (
                <Card>
                    <CardContent className="flex flex-col items-center justify-center py-12">
                        <FileText className="mb-4 h-12 w-12 text-muted-foreground" />
                        <p className="text-muted-foreground">No templates yet. Create your first template.</p>
                    </CardContent>
                </Card>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {filteredTemplates.map((template) => (
                        <Card key={template.id} className="flex flex-col">
                            <CardHeader className="space-y-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <CardTitle className="truncate text-lg">{template.name}</CardTitle>
                                        <CardDescription className="truncate font-mono text-xs">{template.slug}</CardDescription>
                                    </div>
                                    <div className="flex shrink-0 gap-1">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label={`Preview ${template.name}`}
                                            onClick={() => {
                                                setPreviewTemplate(template)
                                                setPreviewVariables({})
                                                setPreviewResult(null)
                                            }}
                                        >
                                            <Eye className="h-4 w-4" />
                                        </Button>
                                        <Button variant="ghost" size="icon" aria-label={`Edit ${template.name}`} onClick={() => void openEdit(template)}>
                                            <Edit className="h-4 w-4" />
                                        </Button>
                                        <Button variant="ghost" size="icon" aria-label={`Duplicate ${template.name}`} onClick={() => void handleDuplicate(template)}>
                                            <Copy className="h-4 w-4" />
                                        </Button>
                                        <Button variant="ghost" size="icon" aria-label={`Delete ${template.name}`} onClick={() => setTemplateToDelete(template)}>
                                            <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
                                        </Button>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="space-y-1">
                                    <Label className="text-xs text-muted-foreground">Subject</Label>
                                    <p className="line-clamp-2 text-sm">{template.subject}</p>
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-xs text-muted-foreground">Variables</Label>
                                    {template.variables?.length ? (
                                        <div className="flex flex-wrap gap-2">
                                            {template.variables.map((variable) => (
                                                <span
                                                    key={variable}
                                                    className="inline-flex items-center rounded-full bg-secondary px-2 py-1 text-xs font-mono"
                                                >
                                                    {`{{${variable}}}`}
                                                </span>
                                            ))}
                                        </div>
                                    ) : (
                                        <p className="text-sm text-muted-foreground">No variables</p>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            <ConfirmDialog
                open={templateToDelete !== null}
                onOpenChange={(open) => { if (!open) setTemplateToDelete(null) }}
                title="Delete template"
                description={templateToDelete ? `"${templateToDelete.name}" will be permanently deleted.` : ''}
                confirmLabel="Delete"
                variant="danger"
                loading={isDeleting}
                onConfirm={() => void handleDeleteTemplate()}
            />

            <Dialog open={showCreateModal || editingTemplate !== null} onOpenChange={(open) => { if (!open) resetForm() }}>
                <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>{editingTemplate ? 'Edit Template' : 'Create Template'}</DialogTitle>
                        <DialogDescription>Use {'{{variableName}}'} placeholders for dynamic content.</DialogDescription>
                    </DialogHeader>

                    {isLoadingTemplate ? (
                        <div className="flex justify-center py-12">
                            <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="templateName">Name</Label>
                                    <Input
                                        id="templateName"
                                        value={draft.name}
                                        onChange={(event) => {
                                            const name = event.target.value
                                            setDraft((current) => ({
                                                ...current,
                                                name,
                                                slug: current.slug === generateSlug(current.name) || !current.slug
                                                    ? generateSlug(name)
                                                    : current.slug,
                                            }))
                                        }}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="templateSlug">Slug</Label>
                                    <Input
                                        id="templateSlug"
                                        value={draft.slug}
                                        onChange={(event) => setDraft((current) => ({ ...current, slug: generateSlug(event.target.value) }))}
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="templateSubject">Subject</Label>
                                <Input
                                    id="templateSubject"
                                    value={draft.subject}
                                    onChange={(event) => setDraft((current) => ({ ...current, subject: event.target.value }))}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label>Variables</Label>
                                <div className="flex gap-2">
                                    <Input
                                        placeholder="firstName"
                                        value={variableInput}
                                        onChange={(event) => setVariableInput(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                                event.preventDefault()
                                                addVariable()
                                            }
                                        }}
                                    />
                                    <Button type="button" variant="outline" onClick={addVariable}>
                                        Add
                                    </Button>
                                </div>
                                {draft.variables.length > 0 && (
                                    <div className="flex flex-wrap gap-2">
                                        {draft.variables.map((variable) => (
                                            <span
                                                key={variable}
                                                className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-1 text-xs font-mono"
                                            >
                                                {`{{${variable}}}`}
                                                <button type="button" aria-label={`Remove variable ${variable}`} onClick={() => removeVariable(variable)}>
                                                    <X className="h-3 w-3" />
                                                </button>
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="templateHtmlBody">HTML Body</Label>
                                <textarea
                                    id="templateHtmlBody"
                                    className="flex min-h-[220px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                    value={draft.htmlBody}
                                    onChange={(event) => setDraft((current) => ({ ...current, htmlBody: event.target.value }))}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="templatePlainBody">Plain Text Body</Label>
                                <textarea
                                    id="templatePlainBody"
                                    className="flex min-h-[140px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                    value={draft.plainBody}
                                    onChange={(event) => setDraft((current) => ({ ...current, plainBody: event.target.value }))}
                                />
                            </div>
                        </div>
                    )}

                    <DialogFooter>
                        <Button variant="outline" onClick={resetForm}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() => void (editingTemplate ? handleUpdateTemplate() : handleCreateTemplate())}
                            disabled={isLoadingTemplate || !draft.name || !draft.slug || !draft.subject}
                        >
                            {editingTemplate ? 'Save Changes' : 'Create Template'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={previewTemplate !== null} onOpenChange={(open) => { if (!open) setPreviewTemplate(null) }}>
                <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>Preview: {previewTemplate?.name}</DialogTitle>
                        <DialogDescription>Fill variables to preview the rendered template.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-6">
                        {(previewTemplate?.variables || []).length > 0 && (
                            <div className="space-y-3">
                                <Label>Preview Variables</Label>
                                {previewTemplate?.variables.map((variable) => (
                                    <div key={variable} className="flex items-center gap-3">
                                        <span className="w-32 shrink-0 text-sm font-mono text-muted-foreground">
                                            {`{{${variable}}}`}
                                        </span>
                                        <Input
                                            value={previewVariables[variable] || ''}
                                            onChange={(event) => setPreviewVariables((current) => ({
                                                ...current,
                                                [variable]: event.target.value,
                                            }))}
                                        />
                                    </div>
                                ))}
                            </div>
                        )}

                        <Button onClick={() => void handlePreview()}>Render Preview</Button>

                        {previewResult && (
                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <Label>Rendered Subject</Label>
                                    <div className="rounded-md bg-muted px-3 py-2 text-sm">
                                        {previewResult.subject || '(empty)'}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label>Rendered HTML</Label>
                                    <div className="rounded-md border bg-background p-4">
                                        {previewResult.htmlBody ? (
                                            // SEC — render the server-rendered template HTML inside the
                                            // sandboxed iframe viewer (no allow-scripts) rather than via
                                            // dangerouslySetInnerHTML. A template is authored by an org
                                            // member and previewed by an admin; inlining its HTML into the
                                            // admin's DOM is stored XSS. The iframe neutralizes scripts.
                                            <EmailHtmlViewer html={previewResult.htmlBody} expandable={false} />
                                        ) : (
                                            <p className="text-sm text-muted-foreground">(empty)</p>
                                        )}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label>Rendered Plain Text</Label>
                                    <pre className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-sm">
                                        {previewResult.plainBody || '(empty)'}
                                    </pre>
                                </div>
                            </div>
                        )}
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
