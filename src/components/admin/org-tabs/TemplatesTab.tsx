import { useEffect, useMemo, useState } from 'react'
import { Copy, Edit, Eye, FileText, Plus, Search, Trash2, X } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { EmailHtmlViewer } from '../../mail/EmailHtmlViewer'
import { apiFetch, apiRequest, generateSlug } from './shared'

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
    const [previewTemplate, setPreviewTemplate] = useState<Template | null>(null)
    const [previewVariables, setPreviewVariables] = useState<Record<string, string>>({})
    const [previewResult, setPreviewResult] = useState<{
        subject: string | null
        plainBody: string | null
        htmlBody: string | null
    } | null>(null)
    const [variableInput, setVariableInput] = useState('')
    const [draft, setDraft] = useState<TemplateDraft>(emptyTemplate)

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

    function openEdit(template: Template) {
        setEditingTemplate(template)
        setShowCreateModal(false)
        setVariableInput('')
        setDraft({
            name: template.name,
            slug: template.slug,
            subject: template.subject,
            plainBody: template.plainBody || '',
            htmlBody: template.htmlBody || '',
            variables: [...(template.variables || [])],
        })
    }

    function handleDuplicate(template: Template) {
        setEditingTemplate(null)
        setVariableInput('')
        setDraft({
            name: `${template.name} Copy`,
            slug: generateSlug(`${template.slug}-copy`),
            subject: template.subject,
            plainBody: template.plainBody || '',
            htmlBody: template.htmlBody || '',
            variables: [...(template.variables || [])],
        })
        setShowCreateModal(true)
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
                    plainBody: draft.plainBody || undefined,
                    htmlBody: draft.htmlBody || undefined,
                }),
            })

            setTemplates((current) => [data.template, ...current])
            resetForm()
        } catch (error) {
            console.error('Error creating template:', error)
            alert(error instanceof Error ? error.message : 'Failed to create template')
        }
    }

    async function handleUpdateTemplate() {
        if (!editingTemplate) return

        try {
            const data = await apiFetch<{ template: Template }>(`/api/templates/${editingTemplate.id}`, {
                method: 'PUT',
                body: JSON.stringify({
                    ...draft,
                    plainBody: draft.plainBody || undefined,
                    htmlBody: draft.htmlBody || undefined,
                }),
            })

            setTemplates((current) => current.map((template) => (
                template.id === editingTemplate.id ? data.template : template
            )))
            resetForm()
        } catch (error) {
            console.error('Error updating template:', error)
            alert(error instanceof Error ? error.message : 'Failed to update template')
        }
    }

    async function handleDeleteTemplate(templateId: string) {
        if (!confirm('Are you sure you want to delete this template?')) return

        try {
            await apiRequest(`/api/templates/${templateId}`, {
                method: 'DELETE',
            })

            setTemplates((current) => current.filter((template) => template.id !== templateId))
        } catch (error) {
            console.error('Error deleting template:', error)
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
            alert(error instanceof Error ? error.message : 'Failed to preview template')
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
                                            onClick={() => {
                                                setPreviewTemplate(template)
                                                setPreviewVariables({})
                                                setPreviewResult(null)
                                            }}
                                        >
                                            <Eye className="h-4 w-4" />
                                        </Button>
                                        <Button variant="ghost" size="icon" onClick={() => openEdit(template)}>
                                            <Edit className="h-4 w-4" />
                                        </Button>
                                        <Button variant="ghost" size="icon" onClick={() => handleDuplicate(template)}>
                                            <Copy className="h-4 w-4" />
                                        </Button>
                                        <Button variant="ghost" size="icon" onClick={() => void handleDeleteTemplate(template.id)}>
                                            <Trash2 className="h-4 w-4 text-gray-500 hover:text-red-500 transition-colors" />
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

            {(showCreateModal || editingTemplate) && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <Card className="max-h-[90vh] w-full max-w-3xl overflow-y-auto">
                        <CardHeader>
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <CardTitle>{editingTemplate ? 'Edit Template' : 'Create Template'}</CardTitle>
                                    <CardDescription>Use {'{{variableName}}'} placeholders for dynamic content.</CardDescription>
                                </div>
                                <Button variant="ghost" size="icon" onClick={resetForm}>
                                    <X className="h-4 w-4" />
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
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
                                                <button type="button" onClick={() => removeVariable(variable)}>
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

                            <div className="flex justify-end gap-2 pt-4">
                                <Button variant="outline" onClick={resetForm}>
                                    Cancel
                                </Button>
                                <Button
                                    onClick={editingTemplate ? handleUpdateTemplate : handleCreateTemplate}
                                    disabled={!draft.name || !draft.slug || !draft.subject}
                                >
                                    {editingTemplate ? 'Save Changes' : 'Create Template'}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}

            {previewTemplate && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <Card className="max-h-[90vh] w-full max-w-3xl overflow-y-auto">
                        <CardHeader>
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <CardTitle>Preview: {previewTemplate.name}</CardTitle>
                                    <CardDescription>Fill variables to preview the rendered template.</CardDescription>
                                </div>
                                <Button variant="ghost" size="icon" onClick={() => setPreviewTemplate(null)}>
                                    <X className="h-4 w-4" />
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            {(previewTemplate.variables || []).length > 0 && (
                                <div className="space-y-3">
                                    <Label>Preview Variables</Label>
                                    {previewTemplate.variables.map((variable) => (
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

                            <Button onClick={handlePreview}>Render Preview</Button>

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
                        </CardContent>
                    </Card>
                </div>
            )}
        </div>
    )
}
