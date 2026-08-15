import React from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useLocation } from 'wouter'
import {
    ArrowLeft,
    Mail,
    Loader2,
    CheckCircle,
    AlertCircle,
    Eye,
    EyeOff,
} from 'lucide-react'
import { OutreachLayout } from '../../../components/outreach/OutreachLayout'
import { apiFetch } from '../../../lib/api-client'
import {
    describeSmtpSecurityMode,
    isStandardSmtpPort,
    resolveSmtpSecurity,
} from '../../../server/lib/smtp-security'

interface Organization {
    id: string
    name: string
    slug: string
}

interface SmtpForm {
    email: string
    displayName: string
    smtpHost: string
    smtpPort: number
    smtpUsername: string
    smtpPassword: string
    smtpSecure: boolean
    imapHost: string
    imapPort: number
    imapUsername: string
    imapPassword: string
    imapSecure: boolean
    dailySendLimit: number
    warmupEnabled: boolean
    warmupDays: number
    joinWarmupMesh: boolean
    warmupOnly: boolean
}

const defaultForm: SmtpForm = {
    email: '',
    displayName: '',
    smtpHost: '',
    smtpPort: 587,
    smtpUsername: '',
    smtpPassword: '',
    // Derived, never hardcoded (PROV-01): 587 is STARTTLS, which nodemailer expects as
    // secure:false. This used to be `true`, which is what made every SMTP inbox created
    // here claim implicit TLS on a STARTTLS port.
    smtpSecure: resolveSmtpSecurity({ port: 587 }).secure,
    imapHost: '',
    imapPort: 993,
    imapUsername: '',
    imapPassword: '',
    imapSecure: true,
    dailySendLimit: 50,
    warmupEnabled: true,
    warmupDays: 14,
    joinWarmupMesh: false,
    warmupOnly: false,
}

// Presets deliberately carry no smtpSecure: the port implies it, and withCanonicalSmtpSecurity
// derives it on apply. A preset that stated its own flag is exactly how these three drifted
// into 587 + implicit TLS.
const providerPresets: Record<string, Partial<SmtpForm>> = {
    outlook: {
        smtpHost: 'smtp-mail.outlook.com',
        smtpPort: 587,
        imapHost: 'outlook.office365.com',
        imapPort: 993,
        imapSecure: true,
    },
    gmail: {
        smtpHost: 'smtp.gmail.com',
        smtpPort: 587,
        imapHost: 'imap.gmail.com',
        imapPort: 993,
        imapSecure: true,
    },
    yahoo: {
        smtpHost: 'smtp.mail.yahoo.com',
        smtpPort: 587,
        imapHost: 'imap.mail.yahoo.com',
        imapPort: 993,
        imapSecure: true,
    },
}

/**
 * Keep the form's TLS flag consistent with its port using the same resolver the API validates
 * against, so the form cannot submit a pair the server would reject with 422.
 */
function withCanonicalSmtpSecurity(form: SmtpForm): SmtpForm {
    return { ...form, smtpSecure: resolveSmtpSecurity({ port: form.smtpPort, secure: form.smtpSecure }).secure }
}

function detectProvider(email: string): string | null {
    const domain = email.split('@')[1]?.toLowerCase()
    if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com' || domain?.endsWith('.office365.com') || domain?.endsWith('.onmicrosoft.com')) {
        return 'outlook'
    }
    if (domain === 'gmail.com' || domain === 'googlemail.com') {
        return 'gmail'
    }
    if (domain === 'yahoo.com' || domain === 'yahoo.fr' || domain === 'yahoo.co.uk') {
        return 'yahoo'
    }
    return null
}

async function fetchOrganizations(): Promise<Organization[]> {
    const data = await apiFetch<{ organizations: Organization[] }>('/api/organizations')
    return data.organizations || []
}

async function startOutlookConnect(organizationId: string, loginHint?: string): Promise<{ authUrl: string }> {
    const data = await apiFetch<{ authUrl: string }>('/api/outlook/connect/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId, loginHint }),
    })
    return data
}

async function createEmailAccount(organizationId: string, form: SmtpForm): Promise<{ emailAccount: { id: string } }> {
    const data = await apiFetch<{ emailAccount: { id: string } }>(`/api/outreach/email-accounts?organizationId=${organizationId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: form.email,
            displayName: form.displayName || undefined,
            smtpHost: form.smtpHost,
            smtpPort: form.smtpPort,
            smtpUsername: form.smtpUsername,
            smtpPassword: form.smtpPassword,
            smtpSecure: form.smtpSecure,
            imapHost: form.imapHost || undefined,
            imapPort: form.imapPort,
            imapUsername: form.imapUsername || undefined,
            imapPassword: form.imapPassword || undefined,
            imapSecure: form.imapSecure,
            dailySendLimit: form.dailySendLimit,
            warmupEnabled: form.warmupEnabled,
            warmupDays: form.warmupDays,
            warmupSource: form.joinWarmupMesh ? 'internal' : 'none',
            warmupOnly: form.joinWarmupMesh ? form.warmupOnly : false,
        }),
    })
    return data
}

export function NewInboxPage() {
    const [, setLocation] = useLocation()
    const [method, setMethod] = React.useState<'outlook' | 'smtp'>('outlook')
    const [form, setForm] = React.useState<SmtpForm>(defaultForm)
    const [organizations, setOrganizations] = React.useState<Organization[]>([])
    const [selectedOrgId, setSelectedOrgId] = React.useState('')
    const [showSmtpPassword, setShowSmtpPassword] = React.useState(false)
    const [showImapPassword, setShowImapPassword] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)

    const { isLoading: loadingOrgs, data: orgsData } = useQuery({
        queryKey: ['organizations'],
        queryFn: fetchOrganizations,
    })

    React.useEffect(() => {
        if (orgsData) {
            setOrganizations(orgsData)
            if (orgsData.length === 1) {
                setSelectedOrgId(orgsData[0].id)
            }
        }
    }, [orgsData])

    const outlookMutation = useMutation({
        mutationFn: () => startOutlookConnect(selectedOrgId, form.email || undefined),
        onSuccess: (data) => {
            window.location.href = data.authUrl
        },
        onError: (err: Error) => {
            setError(err.message || 'Failed to start Outlook connection')
        },
    })

    const smtpMutation = useMutation({
        mutationFn: () => createEmailAccount(selectedOrgId, form),
        onSuccess: () => {
            setLocation('/outreach/inboxes')
        },
        onError: (err: Error) => {
            setError(err.message || 'Failed to create email account')
        },
    })

    const handleEmailChange = (email: string) => {
        setForm(prev => ({ ...prev, email }))
        const provider = detectProvider(email)
        if (provider && providerPresets[provider]) {
            setForm(prev => withCanonicalSmtpSecurity({
                ...prev,
                email,
                ...providerPresets[provider],
                smtpUsername: email,
                imapUsername: email,
            }))
            if (provider === 'outlook') {
                setMethod('outlook')
            }
        }
    }

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        setError(null)

        if (!selectedOrgId) {
            setError('Please select an organization')
            return
        }

        if (method === 'outlook') {
            outlookMutation.mutate()
        } else {
            if (!form.smtpHost || !form.smtpUsername || !form.smtpPassword) {
                setError('Please fill in all required SMTP fields')
                return
            }
            smtpMutation.mutate()
        }
    }

    const isLoading = outlookMutation.isPending || smtpMutation.isPending
    const smtpSecurity = resolveSmtpSecurity({ port: form.smtpPort, secure: form.smtpSecure })

    return (
        <OutreachLayout>
            <div className="max-w-2xl mx-auto space-y-6">
                <div className="flex items-center gap-4">
                    <Link
                        href="/outreach/inboxes"
                        className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
                    >
                        <ArrowLeft className="w-5 h-5" />
                    </Link>
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">Add Inbox</h1>
                        <p className="text-muted-foreground">
                            Connect an email account for sending outreach emails
                        </p>
                    </div>
                </div>

                {error && (
                    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 flex items-center gap-3">
                        <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
                        <p className="text-red-800 dark:text-red-200">{error}</p>
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-6">
                    <div className="bg-card rounded-lg border border-border p-6 space-y-4">
                        <h2 className="text-lg font-semibold text-foreground">Organization</h2>

                        {loadingOrgs ? (
                            <div className="flex items-center gap-2 text-muted-foreground">
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Loading organizations...
                            </div>
                        ) : organizations.length === 0 ? (
                            <p className="text-muted-foreground">
                                No organizations found. Please create an organization first.
                            </p>
                        ) : (
                            <select
                                value={selectedOrgId}
                                onChange={(e) => setSelectedOrgId(e.target.value)}
                                className="w-full px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                            >
                                <option value="">Select an organization</option>
                                {organizations.map((org) => (
                                    <option key={org.id} value={org.id}>
                                        {org.name}
                                    </option>
                                ))}
                            </select>
                        )}
                    </div>

                    <div className="bg-card rounded-lg border border-border p-6 space-y-4">
                        <h2 className="text-lg font-semibold text-foreground">Email Address</h2>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                Email Address
                            </label>
                            <input
                                type="email"
                                value={form.email}
                                onChange={(e) => handleEmailChange(e.target.value)}
                                placeholder="your@email.com"
                                className="w-full px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                                required
                            />
                            <p className="mt-1 text-xs text-muted-foreground">
                                We'll auto-detect your email provider settings
                            </p>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                Display Name (optional)
                            </label>
                            <input
                                type="text"
                                value={form.displayName}
                                onChange={(e) => setForm(prev => ({ ...prev, displayName: e.target.value }))}
                                placeholder="John Doe"
                                className="w-full px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                            />
                        </div>
                    </div>

                    <div className="bg-card rounded-lg border border-border p-6 space-y-4">
                        <h2 className="text-lg font-semibold text-foreground">Connection Method</h2>

                        <div className="grid grid-cols-2 gap-4">
                            <button
                                type="button"
                                onClick={() => setMethod('outlook')}
                                className={`p-4 rounded-lg border-2 transition-all ${method === 'outlook'
                                        ? 'border-primary bg-primary/10'
                                        : 'border-border hover:border-gray-300 dark:hover:border-gray-600'
                                    }`}
                            >
                                <div className="flex items-center gap-3 mb-2">
                                    <svg className="w-6 h-6" viewBox="0 0 23 23">
                                        <path fill="#f35325" d="M0 0h11v11H0z"/>
                                        <path fill="#81bc06" d="M12 0h11v11H12z"/>
                                        <path fill="#05a6f0" d="M0 12h11v11H0z"/>
                                        <path fill="#ffba08" d="M12 12h11v11H12z"/>
                                    </svg>
                                    <span className="font-medium text-foreground">Outlook / Microsoft 365</span>
                                </div>
                                <p className="text-xs text-muted-foreground text-left">
                                    Connect via OAuth (recommended for Outlook, Office 365, GoDaddy)
                                </p>
                            </button>

                            <button
                                type="button"
                                onClick={() => setMethod('smtp')}
                                className={`p-4 rounded-lg border-2 transition-all ${method === 'smtp'
                                        ? 'border-primary bg-primary/10'
                                        : 'border-border hover:border-gray-300 dark:hover:border-gray-600'
                                    }`}
                            >
                                <div className="flex items-center gap-3 mb-2">
                                    <Mail className="w-6 h-6 text-muted-foreground" />
                                    <span className="font-medium text-foreground">SMTP / IMAP</span>
                                </div>
                                <p className="text-xs text-muted-foreground text-left">
                                    Manual configuration for any email provider
                                </p>
                            </button>
                        </div>
                    </div>

                    {method === 'outlook' && (
                        <div className="bg-primary/10 rounded-lg border border-primary/20 p-6">
                            <h3 className="font-medium text-blue-900 dark:text-blue-100 mb-2">
                                Connect via Microsoft
                            </h3>
                            <p className="text-sm text-primary mb-4">
                                Click the button below to authorize access to your Outlook or Microsoft 365 account.
                                This includes accounts from GoDaddy, Office 365, and Outlook.com.
                            </p>
                            <ul className="text-sm text-primary space-y-1 mb-4">
                                <li className="flex items-center gap-2">
                                    <CheckCircle className="w-4 h-4" />
                                    Secure OAuth 2.0 authentication
                                </li>
                                <li className="flex items-center gap-2">
                                    <CheckCircle className="w-4 h-4" />
                                    No password stored - uses tokens
                                </li>
                                <li className="flex items-center gap-2">
                                    <CheckCircle className="w-4 h-4" />
                                    Automatic token refresh
                                </li>
                            </ul>
                        </div>
                    )}

                    {method === 'smtp' && (
                        <div className="space-y-6">
                            <div className="bg-card rounded-lg border border-border p-6 space-y-4">
                                <h3 className="text-lg font-semibold text-foreground">SMTP Settings</h3>

                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                            SMTP Host *
                                        </label>
                                        <input
                                            type="text"
                                            value={form.smtpHost}
                                            onChange={(e) => setForm(prev => ({ ...prev, smtpHost: e.target.value }))}
                                            placeholder="smtp.example.com"
                                            className="w-full px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                                            required
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                            Port
                                        </label>
                                        <input
                                            type="number"
                                            value={form.smtpPort}
                                            onChange={(e) => setForm(prev => withCanonicalSmtpSecurity({ ...prev, smtpPort: parseInt(e.target.value) || 587 }))}
                                            className="w-full px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                            Username *
                                        </label>
                                        <input
                                            type="text"
                                            value={form.smtpUsername}
                                            onChange={(e) => setForm(prev => ({ ...prev, smtpUsername: e.target.value }))}
                                            placeholder="your@email.com"
                                            className="w-full px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                                            required
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                            Password *
                                        </label>
                                        <div className="relative">
                                            <input
                                                type={showSmtpPassword ? 'text' : 'password'}
                                                value={form.smtpPassword}
                                                onChange={(e) => setForm(prev => ({ ...prev, smtpPassword: e.target.value }))}
                                                placeholder="••••••••"
                                                className="w-full px-3 py-2 pr-10 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                                required
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setShowSmtpPassword(!showSmtpPassword)}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                                            >
                                                {showSmtpPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/*
                                  * PROV-01: on a standard port the encryption mode is implied, so we
                                  * report it rather than offer a "Use TLS/SSL" checkbox that could only
                                  * ever contradict the port (and now earns a 422). The choice is only
                                  * real on a nonstandard port, where nothing implies the mode.
                                  */}
                                {isStandardSmtpPort(form.smtpPort) ? (
                                    <p className="text-sm text-muted-foreground">
                                        Encryption:{' '}
                                        <span className="font-medium text-foreground">
                                            {describeSmtpSecurityMode(smtpSecurity.mode)}
                                        </span>
                                        {' — '}determined by port {form.smtpPort}.
                                    </p>
                                ) : (
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="checkbox"
                                                id="smtpSecure"
                                                checked={form.smtpSecure}
                                                onChange={(e) => setForm(prev => withCanonicalSmtpSecurity({ ...prev, smtpSecure: e.target.checked }))}
                                                className="rounded border-input text-primary focus:ring-primary"
                                            />
                                            <label htmlFor="smtpSecure" className="text-sm text-gray-700 dark:text-gray-300">
                                                Port {form.smtpPort} uses implicit TLS (SSL) from connection start
                                            </label>
                                        </div>
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            Leave unchecked if this port expects STARTTLS on a cleartext connection.
                                        </p>
                                    </div>
                                )}
                            </div>

                            <div className="bg-card rounded-lg border border-border p-6 space-y-4">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-lg font-semibold text-foreground">IMAP Settings (Optional)</h3>
                                    <span className="text-xs text-muted-foreground">For reply tracking</span>
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                            IMAP Host
                                        </label>
                                        <input
                                            type="text"
                                            value={form.imapHost}
                                            onChange={(e) => setForm(prev => ({ ...prev, imapHost: e.target.value }))}
                                            placeholder="imap.example.com"
                                            className="w-full px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                            Port
                                        </label>
                                        <input
                                            type="number"
                                            value={form.imapPort}
                                            onChange={(e) => setForm(prev => ({ ...prev, imapPort: parseInt(e.target.value) || 993 }))}
                                            className="w-full px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                            Username
                                        </label>
                                        <input
                                            type="text"
                                            value={form.imapUsername}
                                            onChange={(e) => setForm(prev => ({ ...prev, imapUsername: e.target.value }))}
                                            placeholder="your@email.com"
                                            className="w-full px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                            Password
                                        </label>
                                        <div className="relative">
                                            <input
                                                type={showImapPassword ? 'text' : 'password'}
                                                value={form.imapPassword}
                                                onChange={(e) => setForm(prev => ({ ...prev, imapPassword: e.target.value }))}
                                                placeholder="••••••••"
                                                className="w-full px-3 py-2 pr-10 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setShowImapPassword(!showImapPassword)}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                                            >
                                                {showImapPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        id="imapSecure"
                                        checked={form.imapSecure}
                                        onChange={(e) => setForm(prev => ({ ...prev, imapSecure: e.target.checked }))}
                                        className="rounded border-input text-primary focus:ring-primary"
                                    />
                                    <label htmlFor="imapSecure" className="text-sm text-gray-700 dark:text-gray-300">
                                        Use TLS/SSL
                                    </label>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="bg-card rounded-lg border border-border p-6 space-y-4">
                        <h3 className="text-lg font-semibold text-foreground">Sending Settings</h3>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                    Daily Send Limit
                                </label>
                                <input
                                    type="number"
                                    value={form.dailySendLimit}
                                    onChange={(e) => setForm(prev => ({ ...prev, dailySendLimit: parseInt(e.target.value) || 50 }))}
                                    min={1}
                                    max={10000}
                                    className="w-full px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                                />
                                <p className="mt-1 text-xs text-muted-foreground">
                                    Recommended: 50-100 for new accounts
                                </p>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                    Warmup Period (days)
                                </label>
                                <input
                                    type="number"
                                    value={form.warmupDays}
                                    onChange={(e) => setForm(prev => ({ ...prev, warmupDays: parseInt(e.target.value) || 14 }))}
                                    min={1}
                                    max={60}
                                    className="w-full px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                                />
                            </div>
                        </div>

                        <div className="flex items-center gap-2">
                            <input
                                type="checkbox"
                                id="warmupEnabled"
                                checked={form.warmupEnabled}
                                onChange={(e) => setForm(prev => ({ ...prev, warmupEnabled: e.target.checked }))}
                                className="rounded border-input text-primary focus:ring-primary"
                            />
                            <label htmlFor="warmupEnabled" className="text-sm text-gray-700 dark:text-gray-300">
                                Enable warmup mode (gradually increase sending volume)
                            </label>
                        </div>

                        <div className="flex items-center gap-2">
                            <input
                                type="checkbox"
                                id="joinWarmupMesh"
                                checked={form.joinWarmupMesh}
                                onChange={(e) => setForm(prev => ({ ...prev, joinWarmupMesh: e.target.checked }))}
                                className="rounded border-input text-primary focus:ring-primary"
                            />
                            <label htmlFor="joinWarmupMesh" className="text-sm text-gray-700 dark:text-gray-300">
                                Join the internal warm-up mesh (exchange real warm-up mail with our other inboxes; conversations are auto-archived)
                            </label>
                        </div>

                        {form.joinWarmupMesh && (
                            <div className="ml-6 flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id="warmupOnly"
                                    checked={form.warmupOnly}
                                    onChange={(e) => setForm(prev => ({ ...prev, warmupOnly: e.target.checked }))}
                                    className="rounded border-input text-primary focus:ring-primary"
                                />
                                <label htmlFor="warmupOnly" className="text-sm text-gray-700 dark:text-gray-300">
                                    Warm-up only (this inbox can never be assigned to campaigns)
                                </label>
                            </div>
                        )}
                    </div>

                    <div className="flex items-center justify-end gap-4">
                        <Link
                            href="/outreach/inboxes"
                            className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
                        >
                            Cancel
                        </Link>
                        <button
                            type="submit"
                            disabled={isLoading || !selectedOrgId || !form.email}
                            className="flex items-center gap-2 px-6 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                            {method === 'outlook' ? 'Connect with Microsoft' : 'Add Inbox'}
                        </button>
                    </div>
                </form>
            </div>
        </OutreachLayout>
    )
}

export default NewInboxPage
