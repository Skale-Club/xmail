import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
    Mail,
    Globe,
    Bell,
    Save,
    RefreshCw,
    ShieldAlert
} from 'lucide-react'
import { OutreachLayout } from '../../components/outreach/OutreachLayout'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { OrgAiAutomationControl } from '../../components/outreach/inbox/AiAutonomyControls'
import { apiFetch, apiRequest } from '../../lib/api-client'
import {
    getOrgAiAutomationSettings,
    pauseOrgAiAutomation,
    resumeOrgAiAutomation,
    updateOrgAiAutomationSettings,
    type OrgAiAutomationSettings,
} from '../../lib/unified-inbox-api'
import { useOrganization } from '../../hooks/useOrganization'

interface OutreachSettings {
    general: {
        defaultTimezone: string
        defaultSendStartTime: string
        defaultSendEndTime: string
        sendOnWeekends: boolean
        trackOpens: boolean
        trackClicks: boolean
    }
    sending: {
        defaultDailyLimit: number
        defaultMinMinutesBetweenEmails: number
        warmupEnabled: boolean
        warmupDays: number
    }
    notifications: {
        notifyOnReply: boolean
        notifyOnBounce: boolean
        notifyOnUnsubscribe: boolean
    }
    deliverability: {
        guardEnabled: boolean
        bounceRateLimitPercent: number
        bounceRateMinSample: number
        unsubscribeRateLimitPercent: number
        unsubscribeRateMinSample: number
    }
}

async function fetchSettings(organizationId: string): Promise<OutreachSettings> {
    return apiFetch<OutreachSettings>(`/api/outreach/settings?organizationId=${organizationId}`)
}

async function updateSettings(organizationId: string, settings: Partial<OutreachSettings>): Promise<void> {
    await apiRequest(`/api/outreach/settings?organizationId=${organizationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
    })
}

export function SettingsPage() {
    const { currentOrganization } = useOrganization()
    const queryClient = useQueryClient()
    const { data: settings, isLoading } = useQuery({
        queryKey: ['outreach-settings', currentOrganization?.id],
        queryFn: () => fetchSettings(currentOrganization!.id),
        enabled: !!currentOrganization,
    })

    const updateMutation = useMutation({
        mutationFn: (settings: Partial<OutreachSettings>) => updateSettings(currentOrganization!.id, settings),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['outreach-settings'] })
        }
    })

    // --- AI Assistant & Automation controls (Phase 23 AI-03/AI-06) ---
    const canManage = currentOrganization?.role === 'admin' || currentOrganization?.role === 'member'
    const aiSettingsKey = ['outreach-ai-automation-settings', currentOrganization?.id]
    const aiSettingsQuery = useQuery({
        queryKey: aiSettingsKey,
        queryFn: () => getOrgAiAutomationSettings(currentOrganization!.id),
        enabled: !!currentOrganization,
    })
    const [aiError, setAiError] = React.useState<string | null>(null)
    const onAiSuccess = (data: OrgAiAutomationSettings) => {
        setAiError(null)
        queryClient.setQueryData(aiSettingsKey, data)
    }
    const onAiError = (err: unknown) => {
        // Optimistic-concurrency conflict or a denied write: refetch server truth and surface the reason.
        setAiError(err instanceof Error ? err.message : 'Could not update AI automation controls.')
        aiSettingsQuery.refetch()
    }
    const aiFlagsMutation = useMutation({
        mutationFn: (input: { draftAssistanceEnabled?: boolean; autonomousEnabled?: boolean }) =>
            updateOrgAiAutomationSettings(currentOrganization!.id, { ...input, expectedUpdatedAt: aiSettingsQuery.data?.updatedAt ?? null }),
        onSuccess: onAiSuccess,
        onError: onAiError,
    })
    const aiPauseMutation = useMutation({
        mutationFn: (reason: string) => pauseOrgAiAutomation(currentOrganization!.id, reason || null),
        onSuccess: onAiSuccess,
        onError: onAiError,
    })
    const aiResumeMutation = useMutation({
        mutationFn: () => resumeOrgAiAutomation(currentOrganization!.id),
        onSuccess: onAiSuccess,
        onError: onAiError,
    })
    const aiPending = aiFlagsMutation.isPending || aiPauseMutation.isPending || aiResumeMutation.isPending

    const [formData, setFormData] = React.useState<Partial<OutreachSettings>>({})

    React.useEffect(() => {
        if (settings) {
            setFormData(settings)
        }
    }, [settings])

    const handleSave = () => {
        updateMutation.mutate(formData)
    }

    const updateGeneral = (key: keyof OutreachSettings['general'], value: string | boolean) => {
        setFormData(prev => ({
            ...prev,
            general: { ...prev.general!, [key]: value }
        }))
    }

    const updateSending = (key: keyof OutreachSettings['sending'], value: number | boolean) => {
        setFormData(prev => ({
            ...prev,
            sending: { ...prev.sending!, [key]: value }
        }))
    }

    const updateNotifications = (key: keyof OutreachSettings['notifications'], value: boolean) => {
        setFormData(prev => ({
            ...prev,
            notifications: { ...prev.notifications!, [key]: value }
        }))
    }

    const updateDeliverability = (key: keyof OutreachSettings['deliverability'], value: number | boolean) => {
        setFormData(prev => ({
            ...prev,
            deliverability: { ...prev.deliverability!, [key]: value }
        }))
    }

    if (isLoading) {
        return (
            <OutreachLayout>
                <div className="flex items-center justify-center min-h-[60vh]">
                    <RefreshCw className="w-8 h-8 animate-spin text-gray-400" />
                </div>
            </OutreachLayout>
        )
    }

    return (
        <OutreachLayout>
            {!currentOrganization ? (
                <div className="flex items-center justify-center h-64">
                    <p className="text-muted-foreground">Select an organization to view settings</p>
                </div>
            ) : (
            <div className="space-y-6">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
                        <p className="text-muted-foreground mt-1">
                            Configure your cold email outreach preferences
                        </p>
                    </div>
                    <Button onClick={handleSave} disabled={updateMutation.isPending}>
                        <Save className="w-4 h-4 mr-2" />
                        {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
                    </Button>
                </div>

                {/* General Settings */}
                <div className="bg-card rounded-lg border border-border">
                    <div className="p-4 border-b border-border">
                        <div className="flex items-center gap-2">
                            <Globe className="w-5 h-5 text-gray-500" />
                            <h3 className="font-semibold text-foreground">General Settings</h3>
                        </div>
                    </div>
                    <div className="p-4 space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <Label htmlFor="timezone">Default Timezone</Label>
                                <select
                                    id="timezone"
                                    className="w-full mt-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-sm"
                                    value={formData.general?.defaultTimezone || 'UTC'}
                                    onChange={(e) => updateGeneral('defaultTimezone', e.target.value)}
                                >
                                    <option value="UTC">UTC</option>
                                    <option value="America/New_York">Eastern Time (ET)</option>
                                    <option value="America/Chicago">Central Time (CT)</option>
                                    <option value="America/Denver">Mountain Time (MT)</option>
                                    <option value="America/Los_Angeles">Pacific Time (PT)</option>
                                    <option value="Europe/London">London (GMT)</option>
                                    <option value="Europe/Paris">Paris (CET)</option>
                                </select>
                            </div>
                            <div className="flex items-center gap-4">
                                <div className="flex-1">
                                    <Label htmlFor="startTime">Send Start Time</Label>
                                    <Input
                                        id="startTime"
                                        type="time"
                                        className="mt-1"
                                        value={formData.general?.defaultSendStartTime || '09:00'}
                                        onChange={(e) => updateGeneral('defaultSendStartTime', e.target.value)}
                                    />
                                </div>
                                <div className="flex-1">
                                    <Label htmlFor="endTime">Send End Time</Label>
                                    <Input
                                        id="endTime"
                                        type="time"
                                        className="mt-1"
                                        value={formData.general?.defaultSendEndTime || '17:00'}
                                        onChange={(e) => updateGeneral('defaultSendEndTime', e.target.value)}
                                    />
                                </div>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-4">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="rounded border-gray-300"
                                    checked={formData.general?.sendOnWeekends || false}
                                    onChange={(e) => updateGeneral('sendOnWeekends', e.target.checked)}
                                />
                                <span className="text-sm text-gray-700 dark:text-gray-300">Send on weekends</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="rounded border-gray-300"
                                    checked={formData.general?.trackOpens ?? true}
                                    onChange={(e) => updateGeneral('trackOpens', e.target.checked)}
                                />
                                <span className="text-sm text-gray-700 dark:text-gray-300">Track opens</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="rounded border-gray-300"
                                    checked={formData.general?.trackClicks ?? true}
                                    onChange={(e) => updateGeneral('trackClicks', e.target.checked)}
                                />
                                <span className="text-sm text-gray-700 dark:text-gray-300">Track clicks</span>
                            </label>
                        </div>
                    </div>
                </div>

                {/* Sending Settings */}
                <div className="bg-card rounded-lg border border-border">
                    <div className="p-4 border-b border-border">
                        <div className="flex items-center gap-2">
                            <Mail className="w-5 h-5 text-gray-500" />
                            <h3 className="font-semibold text-foreground">Sending Settings</h3>
                        </div>
                    </div>
                    <div className="p-4 space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <Label htmlFor="dailyLimit">Default Daily Send Limit</Label>
                                <Input
                                    id="dailyLimit"
                                    type="number"
                                    className="mt-1"
                                    min={1}
                                    max={1000}
                                    value={formData.sending?.defaultDailyLimit || 50}
                                    onChange={(e) => updateSending('defaultDailyLimit', parseInt(e.target.value))}
                                />
                                <p className="text-xs text-gray-500 mt-1">Maximum emails per inbox per day</p>
                            </div>
                            <div>
                                <Label htmlFor="minMinutes">Min Minutes Between Emails</Label>
                                <Input
                                    id="minMinutes"
                                    type="number"
                                    className="mt-1"
                                    min={1}
                                    max={60}
                                    value={formData.sending?.defaultMinMinutesBetweenEmails || 5}
                                    onChange={(e) => updateSending('defaultMinMinutesBetweenEmails', parseInt(e.target.value))}
                                />
                                <p className="text-xs text-gray-500 mt-1">Minimum wait time between sends</p>
                            </div>
                        </div>
                        <div className="border-t border-border pt-4">
                            <h4 className="font-medium text-foreground mb-3">Warmup Settings</h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="rounded border-gray-300"
                                        checked={formData.sending?.warmupEnabled ?? true}
                                        onChange={(e) => updateSending('warmupEnabled', e.target.checked)}
                                    />
                                    <span className="text-sm text-gray-700 dark:text-gray-300">Enable automatic warmup</span>
                                </label>
                                <div>
                                    <Label htmlFor="warmupDays">Warmup Period (Days)</Label>
                                    <Input
                                        id="warmupDays"
                                        type="number"
                                        className="mt-1"
                                        min={7}
                                        max={60}
                                        value={formData.sending?.warmupDays || 21}
                                        onChange={(e) => updateSending('warmupDays', parseInt(e.target.value))}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Notification Settings */}
                <div className="bg-card rounded-lg border border-border">
                    <div className="p-4 border-b border-border">
                        <div className="flex items-center gap-2">
                            <ShieldAlert className="w-5 h-5 text-amber-500" />
                            <h3 className="font-semibold text-foreground">Deliverability circuit breaker</h3>
                        </div>
                    </div>
                    <div className="p-4 space-y-4">
                        <label className="flex items-start gap-3 cursor-pointer">
                            <input
                                type="checkbox"
                                className="mt-1 rounded border-gray-300"
                                checked={formData.deliverability?.guardEnabled ?? true}
                                onChange={(e) => updateDeliverability('guardEnabled', e.target.checked)}
                            />
                            <span><span className="block text-sm font-medium text-foreground">Pause unhealthy active campaigns automatically</span><span className="block text-xs text-muted-foreground">A paused campaign requires human review before it can resume.</span></span>
                        </label>
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <div className="rounded-lg border border-border/70 bg-muted/25 p-4">
                                <p className="mb-3 text-sm font-medium text-foreground">Bounce guard</p>
                                <div className="grid grid-cols-2 gap-3">
                                    <div><Label htmlFor="bounceLimit">Rate limit (%)</Label><Input id="bounceLimit" type="number" min={1} max={100} className="mt-1" value={formData.deliverability?.bounceRateLimitPercent ?? 5} onChange={(e) => updateDeliverability('bounceRateLimitPercent', Number(e.target.value))} /></div>
                                    <div><Label htmlFor="bounceSample">Minimum sends</Label><Input id="bounceSample" type="number" min={10} max={10000} className="mt-1" value={formData.deliverability?.bounceRateMinSample ?? 20} onChange={(e) => updateDeliverability('bounceRateMinSample', Number(e.target.value))} /></div>
                                </div>
                            </div>
                            <div className="rounded-lg border border-border/70 bg-muted/25 p-4">
                                <p className="mb-3 text-sm font-medium text-foreground">Unsubscribe guard</p>
                                <div className="grid grid-cols-2 gap-3">
                                    <div><Label htmlFor="unsubscribeLimit">Rate limit (%)</Label><Input id="unsubscribeLimit" type="number" min={1} max={100} className="mt-1" value={formData.deliverability?.unsubscribeRateLimitPercent ?? 2} onChange={(e) => updateDeliverability('unsubscribeRateLimitPercent', Number(e.target.value))} /></div>
                                    <div><Label htmlFor="unsubscribeSample">Minimum sends</Label><Input id="unsubscribeSample" type="number" min={10} max={10000} className="mt-1" value={formData.deliverability?.unsubscribeRateMinSample ?? 50} onChange={(e) => updateDeliverability('unsubscribeRateMinSample', Number(e.target.value))} /></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Notification Settings */}
                <div className="bg-card rounded-lg border border-border">
                    <div className="p-4 border-b border-border">
                        <div className="flex items-center gap-2">
                            <Bell className="w-5 h-5 text-gray-500" />
                            <h3 className="font-semibold text-foreground">Notifications</h3>
                        </div>
                    </div>
                    <div className="p-4 space-y-3">
                        <p className="text-xs text-muted-foreground">
                            When enabled, the matching reply, bounce, or unsubscribe emits an
                            outreach event to connected integrations (e.g. Xphere). Each toggle
                            gates only that event notification — inbound processing always runs.
                        </p>
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                className="rounded border-gray-300"
                                checked={formData.notifications?.notifyOnReply ?? true}
                                onChange={(e) => updateNotifications('notifyOnReply', e.target.checked)}
                            />
                            <span className="text-sm text-gray-700 dark:text-gray-300">Notify on replies</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                className="rounded border-gray-300"
                                checked={formData.notifications?.notifyOnBounce ?? true}
                                onChange={(e) => updateNotifications('notifyOnBounce', e.target.checked)}
                            />
                            <span className="text-sm text-gray-700 dark:text-gray-300">Notify on bounces</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                className="rounded border-gray-300"
                                checked={formData.notifications?.notifyOnUnsubscribe || false}
                                onChange={(e) => updateNotifications('notifyOnUnsubscribe', e.target.checked)}
                            />
                            <span className="text-sm text-gray-700 dark:text-gray-300">Notify on unsubscribes</span>
                        </label>
                    </div>
                </div>

                {/* AI Assistant & Automation (default-off, confirmed, immediately pausable, effective scope) */}
                <OrgAiAutomationControl
                    settings={aiSettingsQuery.data}
                    isLoading={aiSettingsQuery.isLoading}
                    canManage={canManage}
                    pending={aiPending}
                    error={aiError}
                    onSetDraftAssistance={(enabled) => aiFlagsMutation.mutate({ draftAssistanceEnabled: enabled })}
                    onSetAutonomous={(enabled) => aiFlagsMutation.mutate({ autonomousEnabled: enabled })}
                    onPause={(reason) => aiPauseMutation.mutate(reason)}
                    onResume={() => aiResumeMutation.mutate()}
                />

                {/*
                  * No "API Access" card: this product has no self-serve API-key credential
                  * (machine access is the single server-bound Xphere service principal, see
                  * Phase 20 CONS-06). A hardcoded sk_test_**** key with inert buttons read as a
                  * shipped feature, so it was removed rather than left as a counterfeit.
                  */}
            </div>
            )}
        </OutreachLayout>
    )
}

export default SettingsPage
