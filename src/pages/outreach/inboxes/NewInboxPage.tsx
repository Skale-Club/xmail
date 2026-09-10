import React from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useLocation, useParams } from 'wouter'
import {
    ArrowLeft,
    Mail,
    Loader2,
    CheckCircle,
    AlertCircle,
    Eye,
    EyeOff,
} from 'lucide-react'
import { apiFetch } from '../../../lib/api-client'
import { useAuth } from '../../../hooks/useAuth'
import { useOrganization } from '../../../hooks/useOrganization'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select'
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

// All-organizations lookup — used ONLY as a fallback for a platform admin who has no
// organization membership (and therefore no `currentOrganization` from useOrganization) but
// still passes the OutreachAccessGate via isAdmin. Every other caller uses their own org.
async function fetchAllOrganizations(): Promise<Organization[]> {
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

interface ExistingEmailAccount {
    id: string
    email: string
    displayName: string | null
    provider: 'smtp' | 'outlook' | 'native'
    smtpHost: string | null
    smtpPort: number | null
    smtpUsername: string | null
    smtpSecure: boolean | null
    imapHost: string | null
    imapPort: number | null
    imapUsername: string | null
    imapSecure: boolean | null
    dailyLimit: number
    warmupEnabled: boolean
    warmupDays: number
    warmupSource?: 'none' | 'internal' | 'vendor' | 'provider'
    warmupOnly?: boolean
}

async function fetchEmailAccount(organizationId: string, id: string): Promise<ExistingEmailAccount> {
    const data = await apiFetch<{ emailAccount: ExistingEmailAccount }>(
        `/api/outreach/email-accounts/${id}?organizationId=${organizationId}`
    )
    return data.emailAccount
}

interface EditableFields {
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

async function updateEmailAccount(organizationId: string, id: string, form: EditableFields, isSmtp: boolean): Promise<void> {
    const body: Record<string, unknown> = {
        displayName: form.displayName || undefined,
        dailySendLimit: form.dailySendLimit,
        warmupEnabled: form.warmupEnabled,
        warmupDays: form.warmupDays,
        warmupSource: form.joinWarmupMesh ? 'internal' : 'none',
        warmupOnly: form.joinWarmupMesh ? form.warmupOnly : false,
    }
    if (isSmtp) {
        body.smtpHost = form.smtpHost
        body.smtpPort = form.smtpPort
        body.smtpUsername = form.smtpUsername
        // Blank means "leave unchanged" — the server-side schema treats the field as optional.
        if (form.smtpPassword) body.smtpPassword = form.smtpPassword
        body.smtpSecure = form.smtpSecure
        body.imapHost = form.imapHost || undefined
        body.imapPort = form.imapPort
        body.imapUsername = form.imapUsername || undefined
        if (form.imapPassword) body.imapPassword = form.imapPassword
        body.imapSecure = form.imapSecure
    }
    await apiFetch(`/api/outreach/email-accounts/${id}?organizationId=${organizationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
}

export function NewInboxPage() {
    const [, setLocation] = useLocation()
    const params = useParams<{ id?: string }>()
    const accountId = params?.id
    const isEdit = !!accountId

    const { isAdmin } = useAuth()
    const { currentOrganization } = useOrganization()

    const [method, setMethod] = React.useState<'outlook' | 'smtp'>('outlook')
    const [form, setForm] = React.useState<SmtpForm>(defaultForm)
    const [selectedOrgId, setSelectedOrgId] = React.useState('')
    const [showSmtpPassword, setShowSmtpPassword] = React.useState(false)
    const [showImapPassword, setShowImapPassword] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)

    // The organization is always the caller's current one. The only case that still needs a
    // picker is a platform admin with no organization membership (currentOrganization is null
    // but OutreachAccessGate still let them in) — that fallback reuses the all-organizations
    // lookup instead of assuming membership.
    React.useEffect(() => {
        if (currentOrganization) setSelectedOrgId(currentOrganization.id)
    }, [currentOrganization])

    const needsOrgPicker = !currentOrganization && isAdmin === true
    const { isLoading: loadingOrgs, data: orgsData } = useQuery({
        queryKey: ['organizations'],
        queryFn: fetchAllOrganizations,
        enabled: needsOrgPicker,
    })

    // Edit mode: load the existing account and prefill the form. Only 'smtp' accounts expose
    // editable connection settings here — 'outlook'/'native' accounts have no SMTP/IMAP
    // credentials to edit, so only sending/warmup settings apply to them.
    const { data: existingAccount, isLoading: loadingAccount, isError: loadAccountError } = useQuery({
        queryKey: ['email-account', accountId],
        queryFn: () => fetchEmailAccount(selectedOrgId, accountId as string),
        enabled: isEdit && !!selectedOrgId,
    })

    React.useEffect(() => {
        if (!existingAccount) return
        setForm(prev => ({
            ...prev,
            email: existingAccount.email,
            displayName: existingAccount.displayName ?? '',
            smtpHost: existingAccount.smtpHost ?? '',
            smtpPort: existingAccount.smtpPort ?? 587,
            smtpUsername: existingAccount.smtpUsername ?? '',
            smtpSecure: existingAccount.smtpSecure ?? resolveSmtpSecurity({ port: existingAccount.smtpPort ?? 587 }).secure,
            imapHost: existingAccount.imapHost ?? '',
            imapPort: existingAccount.imapPort ?? 993,
            imapUsername: existingAccount.imapUsername ?? '',
            imapSecure: existingAccount.imapSecure ?? true,
            dailySendLimit: existingAccount.dailyLimit,
            warmupEnabled: existingAccount.warmupEnabled,
            warmupDays: existingAccount.warmupDays,
            joinWarmupMesh: existingAccount.warmupSource === 'internal',
            warmupOnly: existingAccount.warmupOnly ?? false,
        }))
    }, [existingAccount])

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

    const updateMutation = useMutation({
        mutationFn: () => updateEmailAccount(selectedOrgId, accountId as string, form, existingAccount?.provider === 'smtp'),
        onSuccess: () => {
            setLocation('/outreach/inboxes')
        },
        onError: (err: Error) => {
            setError(err.message || 'Failed to update inbox')
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

        if (isEdit) {
            if (existingAccount?.provider === 'smtp' && (!form.smtpHost || !form.smtpUsername)) {
                setError('Please fill in all required SMTP fields')
                return
            }
            updateMutation.mutate()
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

    const isLoading = outlookMutation.isPending || smtpMutation.isPending || updateMutation.isPending
    const smtpSecurity = resolveSmtpSecurity({ port: form.smtpPort, secure: form.smtpSecure })
    // In edit mode the connection method is fixed by the account's existing provider — there is
    // no method picker, and the SMTP/IMAP section only renders for 'smtp' accounts.
    const showSmtpSection = isEdit ? existingAccount?.provider === 'smtp' : method === 'smtp'
    const showOutlookNotice = isEdit ? existingAccount?.provider === 'outlook' : method === 'outlook'

    if (isEdit && loadingAccount) {
        return (
            <div className="flex items-center justify-center py-24">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
        )
    }

    if (isEdit && loadAccountError) {
        return (
            <div className="mx-auto max-w-2xl space-y-4 py-12 text-center">
                <p className="text-foreground">Could not load this inbox.</p>
                <Link href="/outreach/inboxes" className="text-primary hover:underline">Back to inboxes</Link>
            </div>
        )
    }

    return (
            <div className="max-w-2xl mx-auto space-y-6">
                <div className="flex items-center gap-4">
                    <Link
                        href="/outreach/inboxes"
                        className="p-2 rounded-lg hover:bg-accent"
                    >
                        <ArrowLeft className="w-5 h-5" />
                    </Link>
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">{isEdit ? 'Edit Inbox' : 'Add Inbox'}</h1>
                        <p className="text-muted-foreground">
                            {isEdit ? 'Update this sending account\'s settings' : 'Connect an email account for sending outreach emails'}
                        </p>
                    </div>
                </div>

                {error && (
                    <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 flex items-center gap-3">
                        <AlertCircle className="w-5 h-5 text-destructive" />
                        <p className="text-destructive">{error}</p>
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-6">
                    {needsOrgPicker && (
                        <div className="bg-card rounded-lg border border-border p-6 space-y-4">
                            <h2 className="text-lg font-semibold text-foreground">Organization</h2>

                            {loadingOrgs ? (
                                <div className="flex items-center gap-2 text-muted-foreground">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Loading organizations...
                                </div>
                            ) : !orgsData || orgsData.length === 0 ? (
                                <p className="text-muted-foreground">
                                    No organizations found. Please create an organization first.
                                </p>
                            ) : (
                                <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Select an organization" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {orgsData.map((org) => (
                                            <SelectItem key={org.id} value={org.id}>
                                                {org.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </div>
                    )}

                    <div className="bg-card rounded-lg border border-border p-6 space-y-4">
                        <h2 className="text-lg font-semibold text-foreground">Email Address</h2>

                        <div>
                            <label className="block text-sm font-medium text-foreground mb-1">
                                Email Address
                            </label>
                            <input
                                type="email"
                                value={form.email}
                                onChange={(e) => handleEmailChange(e.target.value)}
                                placeholder="your@email.com"
                                disabled={isEdit}
                                className="w-full px-3 py-2 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-60"
                                required
                            />
                            {!isEdit && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                    We'll auto-detect your email provider settings
                                </p>
                            )}
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-foreground mb-1">
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

                    {!isEdit && (
                        <div className="bg-card rounded-lg border border-border p-6 space-y-4">
                            <h2 className="text-lg font-semibold text-foreground">Connection Method</h2>

                            <div className="grid grid-cols-2 gap-4">
                                <button
                                    type="button"
                                    onClick={() => setMethod('outlook')}
                                    className={`p-4 rounded-lg border-2 transition-all ${method === 'outlook'
                                            ? 'border-primary bg-primary/10'
                                            : 'border-border hover:border-muted-foreground/40'
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
                                            : 'border-border hover:border-muted-foreground/40'
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
                    )}

                    {showOutlookNotice && (
                        <div className="bg-primary/10 rounded-lg border border-primary/20 p-6">
                            <h3 className="font-medium text-foreground mb-2">
                                {isEdit ? 'Connected via Microsoft' : 'Connect via Microsoft'}
                            </h3>
                            <p className="text-sm text-primary mb-4">
                                {isEdit
                                    ? 'This inbox authenticates via Microsoft OAuth. Only its sending settings below can be changed here — reconnect from Sending accounts if the Microsoft grant itself needs to change.'
                                    : 'Click the button below to authorize access to your Outlook or Microsoft 365 account. This includes accounts from GoDaddy, Office 365, and Outlook.com.'}
                            </p>
                            {!isEdit && (
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
                            )}
                        </div>
                    )}

                    {isEdit && existingAccount?.provider === 'native' && (
                        <div className="bg-primary/10 rounded-lg border border-primary/20 p-6">
                            <h3 className="font-medium text-foreground mb-2">Native platform mailbox</h3>
                            <p className="text-sm text-primary">
                                This inbox sends through the platform's own mailbox model — there are no SMTP/IMAP
                                credentials to edit. Only its sending settings below can be changed here.
                            </p>
                        </div>
                    )}

                    {showSmtpSection && (
                        <div className="space-y-6">
                            <div className="bg-card rounded-lg border border-border p-6 space-y-4">
                                <h3 className="text-lg font-semibold text-foreground">SMTP Settings</h3>

                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-medium text-foreground mb-1">
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
                                        <label className="block text-sm font-medium text-foreground mb-1">
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
                                        <label className="block text-sm font-medium text-foreground mb-1">
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
                                        <label className="block text-sm font-medium text-foreground mb-1">
                                            Password {isEdit ? '' : '*'}
                                        </label>
                                        <div className="relative">
                                            <input
                                                type={showSmtpPassword ? 'text' : 'password'}
                                                value={form.smtpPassword}
                                                onChange={(e) => setForm(prev => ({ ...prev, smtpPassword: e.target.value }))}
                                                placeholder={isEdit ? 'Leave blank to keep unchanged' : '••••••••'}
                                                className="w-full px-3 py-2 pr-10 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                                                required={!isEdit}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setShowSmtpPassword(!showSmtpPassword)}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
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
                                            <label htmlFor="smtpSecure" className="text-sm text-foreground">
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
                                        <label className="block text-sm font-medium text-foreground mb-1">
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
                                        <label className="block text-sm font-medium text-foreground mb-1">
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
                                        <label className="block text-sm font-medium text-foreground mb-1">
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
                                        <label className="block text-sm font-medium text-foreground mb-1">
                                            Password
                                        </label>
                                        <div className="relative">
                                            <input
                                                type={showImapPassword ? 'text' : 'password'}
                                                value={form.imapPassword}
                                                onChange={(e) => setForm(prev => ({ ...prev, imapPassword: e.target.value }))}
                                                placeholder={isEdit ? 'Leave blank to keep unchanged' : '••••••••'}
                                                className="w-full px-3 py-2 pr-10 border border-input rounded-lg bg-background text-foreground focus:ring-2 focus:ring-primary focus:border-transparent"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setShowImapPassword(!showImapPassword)}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
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
                                    <label htmlFor="imapSecure" className="text-sm text-foreground">
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
                                <label className="block text-sm font-medium text-foreground mb-1">
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
                                <label className="block text-sm font-medium text-foreground mb-1">
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
                            <label htmlFor="warmupEnabled" className="text-sm text-foreground">
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
                            <label htmlFor="joinWarmupMesh" className="text-sm text-foreground">
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
                                <label htmlFor="warmupOnly" className="text-sm text-foreground">
                                    Warm-up only (this inbox can never be assigned to campaigns)
                                </label>
                            </div>
                        )}
                    </div>

                    <div className="flex items-center justify-end gap-4">
                        <Link
                            href="/outreach/inboxes"
                            className="px-4 py-2 text-foreground hover:text-foreground/80"
                        >
                            Cancel
                        </Link>
                        <button
                            type="submit"
                            disabled={isLoading || !selectedOrgId || (!isEdit && !form.email)}
                            className="flex items-center gap-2 px-6 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                            {isEdit ? 'Save Changes' : method === 'outlook' ? 'Connect with Microsoft' : 'Add Inbox'}
                        </button>
                    </div>
                </form>
            </div>
    )
}

export default NewInboxPage
