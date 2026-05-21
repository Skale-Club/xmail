import { useEffect, useState } from 'react'
import { CheckCircle, ExternalLink, FlaskConical, Save, Send, XCircle, Zap } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Switch } from '../../components/ui/switch'
import { Badge } from '../../components/ui/Badge'
import { apiFetch } from './helpers'

interface IntegrationsData {
    telegramBotToken: string | null
    telegramChatId: string | null
    telegramEnabled: boolean
    updatedAt: string | null
}

interface FormState {
    telegramBotToken: string
    telegramChatId: string
    telegramEnabled: boolean
}

export default function IntegrationsPage() {
    const [form, setForm] = useState<FormState>({
        telegramBotToken: '',
        telegramChatId: '',
        telegramEnabled: false,
    })
    const [maskedToken, setMaskedToken] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [isSaving, setIsSaving] = useState(false)
    const [isTesting, setIsTesting] = useState(false)
    const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)
    const [isConfigured, setIsConfigured] = useState(false)

    useEffect(() => {
        void loadIntegrations()
    }, [])

    async function loadIntegrations() {
        setIsLoading(true)
        try {
            const data = await apiFetch<IntegrationsData>('/api/admin/integrations')
            setMaskedToken(data.telegramBotToken)
            setIsConfigured(!!data.telegramBotToken && !!data.telegramChatId)
            setForm({
                telegramBotToken: '',  // never pre-fill the token field
                telegramChatId: data.telegramChatId ?? '',
                telegramEnabled: data.telegramEnabled,
            })
        } catch (error) {
            window.alert(error instanceof Error ? error.message : 'Failed to load integrations')
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
            setForm((f) => ({ ...f, telegramBotToken: '' }))
            window.alert('Integrations saved successfully.')
        } catch (error) {
            window.alert(error instanceof Error ? error.message : 'Failed to save integrations')
        } finally {
            setIsSaving(false)
        }
    }

    async function handleTest() {
        setIsTesting(true)
        setTestResult(null)
        try {
            const result = await apiFetch<{ success: boolean; error?: string }>(
                '/api/admin/integrations/test',
                { method: 'POST' }
            )
            setTestResult(result)
        } catch (error) {
            setTestResult({ success: false, error: error instanceof Error ? error.message : 'Unknown error' })
        } finally {
            setIsTesting(false)
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
                            <Label htmlFor="telegramChatId">Chat ID</Label>
                            <Input
                                id="telegramChatId"
                                type="text"
                                placeholder="-1001234567890"
                                value={form.telegramChatId}
                                onChange={(e) => setForm((f) => ({ ...f, telegramChatId: e.target.value }))}
                                disabled={isLoading || isSaving}
                            />
                            <p className="text-xs text-muted-foreground">
                                The numeric ID of the chat or group that will receive alerts.
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

                    {/* Test section */}
                    <div className="flex flex-col gap-3 rounded-lg border border-dashed p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <p className="text-sm font-medium">Test connection</p>
                            <p className="text-xs text-muted-foreground">
                                Sends a test message to verify the Bot Token and Chat ID are correct.
                            </p>
                        </div>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={handleTest}
                            disabled={isLoading || isSaving || isTesting || !isConfigured}
                        >
                            {isTesting ? (
                                <>
                                    <FlaskConical className="mr-2 h-4 w-4 animate-pulse" />
                                    Testing...
                                </>
                            ) : (
                                <>
                                    <Zap className="mr-2 h-4 w-4" />
                                    Test Telegram
                                </>
                            )}
                        </Button>
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
        </div>
    )
}
