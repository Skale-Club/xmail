import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle, ExternalLink, FlaskConical, Save, Send, XCircle, Zap } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Switch } from '../../components/ui/switch'
import { Badge } from '../../components/ui/Badge'
import { toast } from '../../components/ui/toaster'
import { apiFetch } from './helpers'

interface IntegrationsData {
    telegramBotToken: string | null
    telegramChatId: string | null
    telegramOutreachChatId: string | null
    telegramOutreachThreadId: string | null
    telegramEnabled: boolean
    updatedAt: string | null
}

interface FormState {
    telegramBotToken: string
    telegramChatId: string
    telegramOutreachChatId: string
    telegramOutreachThreadId: string
    telegramEnabled: boolean
}

export default function IntegrationsPage() {
    const [form, setForm] = useState<FormState>({
        telegramBotToken: '',
        telegramChatId: '',
        telegramOutreachChatId: '',
        telegramOutreachThreadId: '',
        telegramEnabled: false,
    })
    const [maskedToken, setMaskedToken] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [isSaving, setIsSaving] = useState(false)
    const [isTesting, setIsTesting] = useState<'ops' | 'outreach' | null>(null)
    const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)
    const [isConfigured, setIsConfigured] = useState(false)
    // Saved state, not the field: the test endpoint uses what is stored.
    const [hasOutreachChat, setHasOutreachChat] = useState(false)

    useEffect(() => {
        void loadIntegrations()
    }, [])

    async function loadIntegrations() {
        setIsLoading(true)
        setError(null)
        try {
            const data = await apiFetch<IntegrationsData>('/api/admin/integrations')
            setMaskedToken(data.telegramBotToken)
            setIsConfigured(!!data.telegramBotToken && !!data.telegramChatId)
            setHasOutreachChat(!!data.telegramOutreachChatId)
            setForm({
                telegramBotToken: '',  // never pre-fill the token field
                telegramChatId: data.telegramChatId ?? '',
                telegramOutreachChatId: data.telegramOutreachChatId ?? '',
                telegramOutreachThreadId: data.telegramOutreachThreadId ?? '',
                telegramEnabled: data.telegramEnabled,
            })
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load integrations')
        } finally {
            setIsLoading(false)
        }
    }

    async function handleSave() {
        setIsSaving(true)
        setTestResult(null)
        try {
            const payload: Partial<FormState> = {
                telegramChatId: form.telegramChatId,
                // Empty clears the field: outreach alerts then go to the ops chat.
                telegramOutreachChatId: form.telegramOutreachChatId.trim(),
                telegramOutreachThreadId: form.telegramOutreachThreadId.trim(),
                telegramEnabled: form.telegramEnabled,
            }
            // Only include token if the user typed something new
            if (form.telegramBotToken.trim() !== '') {
                payload.telegramBotToken = form.telegramBotToken.trim()
            }

            const data = await apiFetch<IntegrationsData>('/api/admin/integrations', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })

            setMaskedToken(data.telegramBotToken)
            setIsConfigured(!!data.telegramBotToken && !!data.telegramChatId)
            setHasOutreachChat(!!data.telegramOutreachChatId)
            setForm((f) => ({ ...f, telegramBotToken: '' }))
            toast({ title: 'Integrations saved successfully', variant: 'success' })
        } catch (error) {
            toast({ title: error instanceof Error ? error.message : 'Failed to save integrations', variant: 'destructive' })
        } finally {
            setIsSaving(false)
        }
    }

    async function handleTest(channel: 'ops' | 'outreach') {
        setIsTesting(channel)
        setTestResult(null)
        try {
            const result = await apiFetch<{ success: boolean; error?: string }>(
                `/api/admin/integrations/test${channel === 'outreach' ? '?channel=outreach' : ''}`,
                { method: 'POST' }
            )
            setTestResult(result)
        } catch (error) {
            setTestResult({ success: false, error: error instanceof Error ? error.message : 'Unknown error' })
        } finally {
            setIsTesting(null)
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h1 className="text-3xl font-semibold tracking-tight">Integrations</h1>
                    <p className="text-sm text-muted-foreground">
                        Configure external service integrations used by the platform, such as Telegram monitoring alerts.
                    </p>
                </div>
                <Button
                    type="button"
                    onClick={handleSave}
                    disabled={isLoading || isSaving}
                >
                    <Save className="mr-2 h-4 w-4" />
                    {isSaving ? 'Saving...' : 'Save changes'}
                </Button>
            </div>

            {error && (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
                    <AlertCircle className="h-8 w-8 text-destructive" />
                    <p className="text-sm text-destructive">{error}</p>
                    <Button variant="outline" size="sm" onClick={() => void loadIntegrations()}>
                        Try again
                    </Button>
                </div>
            )}

            {!error && (
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500">
                                <Send className="h-5 w-5" />
                            </div>
                            <div>
                                <CardTitle className="flex items-center gap-2">
                                    Telegram
                                    {isConfigured ? (
                                        <Badge variant="default" className="bg-green-600 text-white hover:bg-green-700">
                                            <CheckCircle className="mr-1 h-3 w-3" />
                                            Configured
                                        </Badge>
                                    ) : (
                                        <Badge variant="secondary">
                                            <XCircle className="mr-1 h-3 w-3" />
                                            Not configured
                                        </Badge>
                                    )}
                                </CardTitle>
                                <CardDescription>
                                    Send monitoring alerts to a Telegram chat via a Bot.
                                </CardDescription>
                            </div>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="space-y-6">
                    {/* Enable toggle */}
                    <div className="flex items-center justify-between rounded-lg border p-4">
                        <div className="space-y-0.5">
                            <Label htmlFor="telegramEnabled" className="text-base">
                                Enable Telegram alerts
                            </Label>
                            <p className="text-sm text-muted-foreground">
                                When enabled, the server monitor will send alerts to the configured Telegram chat.
                            </p>
                        </div>
                        <Switch
                            id="telegramEnabled"
                            checked={form.telegramEnabled}
                            onCheckedChange={(checked) => setForm((f) => ({ ...f, telegramEnabled: checked }))}
                            disabled={isLoading || isSaving}
                        />
                    </div>

                    <div className="grid gap-5 sm:grid-cols-2">
                        {/* Bot Token */}
                        <div className="space-y-2">
                            <Label htmlFor="telegramBotToken">Bot Token</Label>
                            <Input
                                id="telegramBotToken"
                                type="password"
                                placeholder={maskedToken ?? '••••••••'}
                                value={form.telegramBotToken}
                                onChange={(e) => setForm((f) => ({ ...f, telegramBotToken: e.target.value }))}
                                disabled={isLoading || isSaving}
                                autoComplete="off"
                            />
                            <p className="text-xs text-muted-foreground">
                                Obtained from{' '}
                                <a
                                    href="https://t.me/BotFather"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-0.5 text-primary hover:underline"
                                >
                                    @BotFather
                                    <ExternalLink className="h-3 w-3" />
                                </a>{' '}
                                on Telegram. Format: <code className="font-mono text-xs">123456:ABC-DEF...</code>
                            </p>
                            {maskedToken && form.telegramBotToken === '' && (
                                <p className="text-xs text-muted-foreground">
                                    Current token: <code className="font-mono">{maskedToken}</code> — leave blank to keep unchanged
                                </p>
                            )}
                        </div>

                        {/* Chat ID */}
                        <div className="space-y-2">
                            <Label htmlFor="telegramChatId">Ops alerts chat ID</Label>
                            <Input
                                id="telegramChatId"
                                type="text"
                                placeholder="-1001234567890"
                                value={form.telegramChatId}
                                onChange={(e) => setForm((f) => ({ ...f, telegramChatId: e.target.value }))}
                                disabled={isLoading || isSaving}
                            />
                            <p className="text-xs text-muted-foreground">
                                The numeric ID of the private chat that receives server, deploy and error alerts. Keep it a private chat: its ID is also how the owner is recognised when approving from Telegram.
                                Add{' '}
                                <a
                                    href="https://t.me/userinfobot"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-0.5 text-primary hover:underline"
                                >
                                    @userinfobot
                                    <ExternalLink className="h-3 w-3" />
                                </a>{' '}
                                to a group to get the group ID, or message it directly for your personal ID.
                            </p>
                        </div>
                    </div>

                    {/* Outreach chat */}
                    <div className="grid gap-5 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="telegramOutreachChatId">Outreach alerts chat ID (optional, falls back to the ops chat)</Label>
                            <Input
                                id="telegramOutreachChatId"
                                type="text"
                                placeholder="-1001234567890"
                                value={form.telegramOutreachChatId}
                                onChange={(e) => setForm((f) => ({ ...f, telegramOutreachChatId: e.target.value }))}
                                disabled={isLoading || isSaving}
                            />
                            <p className="text-xs text-muted-foreground">
                                Prospect replies and campaign approval cards go here. Easiest setup: add the bot to a group and tap
                                &quot;Usar para outreach&quot; on the card it sends to the ops chat. Leave empty to keep everything in the ops chat.
                            </p>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="telegramOutreachThreadId">Outreach topic ID (optional)</Label>
                            <Input
                                id="telegramOutreachThreadId"
                                type="text"
                                placeholder="Only for groups with Topics"
                                value={form.telegramOutreachThreadId}
                                onChange={(e) => setForm((f) => ({ ...f, telegramOutreachThreadId: e.target.value }))}
                                disabled={isLoading || isSaving}
                            />
                            <p className="text-xs text-muted-foreground">
                                Message thread ID inside the outreach group. Choosing a different group through the Telegram button resets it.
                            </p>
                        </div>
                    </div>

                    {/* Test section */}
                    <div className="flex flex-col gap-3 rounded-lg border border-dashed p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <p className="text-sm font-medium">Test connection</p>
                            <p className="text-xs text-muted-foreground">
                                Sends a test message to verify the Bot Token and the chat IDs are correct. Save first: the test uses the saved values.
                            </p>
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => void handleTest('ops')}
                            disabled={isLoading || isSaving || isTesting !== null || !isConfigured}
                        >
                            {isTesting === 'ops' ? (
                                <>
                                    <FlaskConical className="mr-2 h-4 w-4 animate-pulse" />
                                    Testing...
                                </>
                            ) : (
                                <>
                                    <Zap className="mr-2 h-4 w-4" />
                                    Test ops chat
                                </>
                            )}
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => void handleTest('outreach')}
                            disabled={isLoading || isSaving || isTesting !== null || !isConfigured || !hasOutreachChat}
                        >
                            {isTesting === 'outreach' ? (
                                <>
                                    <FlaskConical className="mr-2 h-4 w-4 animate-pulse" />
                                    Testing...
                                </>
                            ) : (
                                <>
                                    <Zap className="mr-2 h-4 w-4" />
                                    Test outreach chat
                                </>
                            )}
                        </Button>
                        </div>
                    </div>

                    {testResult && (
                        <div
                            className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm ${
                                testResult.success
                                    ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                                    : 'bg-red-500/10 text-red-700 dark:text-red-400'
                            }`}
                        >
                            {testResult.success ? (
                                <CheckCircle className="h-4 w-4 shrink-0" />
                            ) : (
                                <XCircle className="h-4 w-4 shrink-0" />
                            )}
                            <span>
                                {testResult.success
                                    ? 'Test message sent successfully! Check your Telegram chat.'
                                    : `Test failed: ${testResult.error ?? 'Unknown error'}`}
                            </span>
                        </div>
                    )}

                    {/* How it works */}
                    <div className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground space-y-1">
                        <p className="font-medium text-foreground">How it works</p>
                        <p>
                            The server monitor script calls{' '}
                            <code className="font-mono text-xs">GET /api/admin/integrations/monitor-config</code>{' '}
                            (authenticated with <code className="font-mono text-xs">x-monitor-token</code>) to fetch these credentials at runtime. The Bot Token is encrypted at rest and only decrypted when needed.
                        </p>
                    </div>
                </CardContent>
            </Card>
            )}
        </div>
    )
}
