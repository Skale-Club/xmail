import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { toast } from '../../ui/toaster'
import { apiFetch, timezoneOptions } from './shared'

interface Organization {
    id: string
    name: string
    slug: string
    timezone: string
}

interface SettingsTabProps {
    org: Organization
    isAdmin: boolean
    onRefresh: () => Promise<void>
}

export default function SettingsTab({ org, isAdmin, onRefresh }: SettingsTabProps) {
    const [form, setForm] = useState({
        name: org.name,
        timezone: org.timezone,
    })
    const [isSaving, setIsSaving] = useState(false)

    useEffect(() => {
        setForm({
            name: org.name,
            timezone: org.timezone,
        })
    }, [org.id, org.name, org.timezone])

    async function handleUpdateOrg() {
        setIsSaving(true)
        try {
            await apiFetch(`/api/organizations/${org.id}`, {
                method: 'PATCH',
                body: JSON.stringify(form),
            })
            toast({ title: 'Organization settings saved', variant: 'success' })
            await onRefresh()
        } catch (error) {
            console.error('Error updating organization:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to update organization', variant: 'destructive' })
        } finally {
            setIsSaving(false)
        }
    }

    if (!isAdmin) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Settings</CardTitle>
                    <CardDescription>Only organization admins can edit these settings.</CardDescription>
                </CardHeader>
            </Card>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                    <h3 className="text-lg font-semibold">Settings</h3>
                    <p className="text-sm text-muted-foreground">Update the organization name and timezone.</p>
                </div>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Organization Settings</CardTitle>
                    <CardDescription>Update the organization name and timezone.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="grid gap-6 md:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="orgName">Name</Label>
                            <Input
                                id="orgName"
                                value={form.name}
                                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="orgTimezone">Timezone</Label>
                            <Select
                                value={form.timezone}
                                onValueChange={(value) => setForm((current) => ({ ...current, timezone: value }))}
                            >
                                <SelectTrigger id="orgTimezone">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {timezoneOptions.map((timezone) => (
                                        <SelectItem key={timezone} value={timezone}>
                                            {timezone}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <div className="flex justify-end pt-4">
                        <Button onClick={() => void handleUpdateOrg()} disabled={!form.name || isSaving}>
                            {isSaving ? 'Saving...' : 'Save Changes'}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
