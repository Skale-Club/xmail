import { useEffect, useMemo, useState } from 'react'
import { CheckCircle, XCircle, Copy, Globe, Plus, Search, Trash2, X, RefreshCw, Loader2, Building2 } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { useBranding } from '../../lib/branding'
import {
    apiFetch,
    loadOrganizations,
    matchesSearch,
    type OrganizationOption,
} from './helpers'

interface DnsRecordSpec {
    type: string
    name: string
    value: string | null
    priority?: number
}

interface DomainDnsRecords {
    verification: DnsRecordSpec
    spf: DnsRecordSpec
    dkim: DnsRecordSpec
    dmarc: DnsRecordSpec
    mx: DnsRecordSpec
    returnPath: DnsRecordSpec
}

type DomainRecord = {
    id: string
    organizationId: string
    name: string
    verificationToken: string | null
    verificationStatus: 'pending' | 'verified' | 'failed'
    dkimSelector?: string | null
    dkimPublicKey?: string | null
    spfStatus?: string | null
    dkimStatus?: string | null
    dmarcStatus?: string | null
    mxStatus?: string | null
    returnPathStatus?: string | null
    dnsRecords?: DomainDnsRecords
    createdAt: string
}

interface DnsResults {
    verification: { found: boolean }
    spf: { found: boolean; error: string | null }
    dkim: { found: boolean; error: string | null }
    dmarc: { found: boolean; error: string | null }
    mx: { found: boolean; error: string | null }
    returnPath: { found: boolean; error: string | null }
}

function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text)
}

function StatusBadge({ status }: { status: 'success' | 'error' | 'pending' }) {
    if (status === 'success') {
        return (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
                <CheckCircle className="h-3.5 w-3.5" />
                Verified
            </span>
        )
    }
    if (status === 'error') {
        return (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-400">
                <XCircle className="h-3.5 w-3.5" />
                Error
            </span>
        )
    }
    return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
            Pending
        </span>
    )
}

function DnsRecordCard({ label, type, name, value, priority, status, onCheck, isChecking, disabled }: { label: string; type: string; name: string; value: string; priority?: string; status: 'success' | 'error' | 'pending'; onCheck: () => void; isChecking: boolean; disabled?: boolean }) {
    return (
        <div className="rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">{label}</h4>
                <div className="flex items-center gap-2">
                    <StatusBadge status={status} />
                    <Button variant="ghost" size="icon" className="h-7 w-7 focus-visible:ring-0 focus-visible:ring-offset-0" onClick={onCheck} disabled={disabled || isChecking} title="Check this record">
                        <RefreshCw className={`h-3.5 w-3.5 ${isChecking ? 'animate-spin' : ''}`} />
                    </Button>
                </div>
            </div>

            <div className={`grid gap-4 ${priority ? 'md:grid-cols-4' : 'md:grid-cols-3'}`}>
                <div className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Type</span>
                    <div>
                        <code className="rounded bg-muted px-2.5 py-1.5 text-xs font-mono">{type}</code>
                    </div>
                </div>
                <div className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</span>
                    <div className="flex items-center gap-1.5">
                        <code className="flex-1 truncate rounded bg-muted px-2.5 py-1.5 text-xs font-mono">{name}</code>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => copyToClipboard(name)} title="Copy name">
                            <Copy className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                </div>
                {priority && (
                    <div className="space-y-1">
                        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Priority</span>
                        <div className="flex items-center gap-1.5">
                            <code className="flex-1 truncate rounded bg-muted px-2.5 py-1.5 text-xs font-mono">{priority}</code>
                            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => copyToClipboard(priority)} title="Copy priority">
                                <Copy className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    </div>
                )}
                <div className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Value</span>
                    <div className="flex items-center gap-1.5">
                        <code className="flex-1 truncate rounded bg-muted px-2.5 py-1.5 text-xs font-mono">{value}</code>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => copyToClipboard(value)} title="Copy value">
                            <Copy className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                </div>
            </div>

            {status === 'error' && (
                <div className="rounded-md bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-300">
                    The {label} values in your platform and in your domain provider account mismatch. Add this value to your domain provider account to authenticate this domain.
                </div>
            )}
            {status === 'success' && (
                <div className="rounded-md bg-emerald-50 p-3 text-xs text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                    The {label} values in your platform and your domain provider account match.
                </div>
            )}
        </div>
    )
}

function DnsModal({ domain, onClose, onDomainUpdate }: { domain: DomainRecord; onClose: () => void; onDomainUpdate: (d: DomainRecord) => void }) {
    const { branding } = useBranding()
    const verificationLabel = branding.companyName ? `${branding.companyName} Verification` : 'Domain Verification'
    const [dnsResults, setDnsResults] = useState<DnsResults | null>(null)
    const [checkingRecord, setCheckingRecord] = useState<string | null>(null)
    const [verifyingAll, setVerifyingAll] = useState(false)

    function statusFor(
        dbStatus: string | null | undefined,
        resultsKey: keyof DnsResults,
    ): 'success' | 'error' | 'pending' {
        if (dnsResults) {
            return dnsResults[resultsKey].found ? 'success' : 'error'
        }
        if (dbStatus === 'verified') return 'success'
        if (dbStatus === 'failed') return 'error'
        return 'pending'
    }

    async function handleVerify(recordKey: string) {
        setCheckingRecord(recordKey)
        try {
            const data = await apiFetch<{ domain: DomainRecord; dnsResults: DnsResults }>(`/api/domains/${domain.id}/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ record: recordKey }),
            })
            onDomainUpdate(data.domain)
            setDnsResults(data.dnsResults || null)
        } catch (error) {
            window.alert(error instanceof Error ? error.message : 'Verification failed')
        } finally {
            setCheckingRecord(null)
        }
    }

    async function handleVerifyAll() {
        setVerifyingAll(true)
        try {
            const data = await apiFetch<{ domain: DomainRecord; dnsResults: DnsResults }>(`/api/domains/${domain.id}/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            })
            onDomainUpdate(data.domain)
            setDnsResults(data.dnsResults || null)
        } catch (error) {
            window.alert(error instanceof Error ? error.message : 'Verification failed')
        } finally {
            setVerifyingAll(false)
        }
    }

    const isBusy = verifyingAll || checkingRecord !== null

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
            <Card className="w-full max-w-3xl max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
                <CardHeader>
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <CardTitle>DNS records for domain authentication</CardTitle>
                            <CardDescription className="mt-1.5">
                                Add these DNS records to your domain provider to authenticate <strong>{domain.name}</strong>
                            </CardDescription>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleVerifyAll}
                                disabled={isBusy}
                                className="gap-2 focus-visible:ring-0 focus-visible:ring-offset-0"
                            >
                                {verifyingAll
                                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Verifying…</>
                                    : <><RefreshCw className="h-3.5 w-3.5" /> Verify all</>
                                }
                            </Button>
                            <Button variant="ghost" size="icon" onClick={onClose} className="focus-visible:ring-0 focus-visible:ring-offset-0">
                                <X className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    {!domain.dnsRecords ? (
                        <p className="py-4 text-center text-sm text-muted-foreground">Loading DNS records…</p>
                    ) : (
                        <>
                            <DnsRecordCard label={verificationLabel} type={domain.dnsRecords.verification.type} name={domain.dnsRecords.verification.name}
                                value={domain.dnsRecords.verification.value || 'Token unavailable'}
                                status={statusFor(domain.verificationStatus, 'verification')}
                                onCheck={() => handleVerify('verification')} isChecking={checkingRecord === 'verification'} disabled={isBusy} />
                            <DnsRecordCard label="SPF Record" type={domain.dnsRecords.spf.type} name={domain.dnsRecords.spf.name}
                                value={domain.dnsRecords.spf.value || ''}
                                status={statusFor(domain.spfStatus, 'spf')}
                                onCheck={() => handleVerify('spf')} isChecking={checkingRecord === 'spf'} disabled={isBusy} />
                            <DnsRecordCard label="DKIM Record" type={domain.dnsRecords.dkim.type}
                                name={domain.dnsRecords.dkim.name}
                                value={domain.dnsRecords.dkim.value || '(key not generated yet)'}
                                status={statusFor(domain.dkimStatus, 'dkim')}
                                onCheck={() => handleVerify('dkim')} isChecking={checkingRecord === 'dkim'} disabled={isBusy} />
                            <DnsRecordCard label="DMARC Record" type={domain.dnsRecords.dmarc.type} name={domain.dnsRecords.dmarc.name}
                                value={domain.dnsRecords.dmarc.value || ''}
                                status={statusFor(domain.dmarcStatus, 'dmarc')}
                                onCheck={() => handleVerify('dmarc')} isChecking={checkingRecord === 'dmarc'} disabled={isBusy} />
                            <DnsRecordCard label="MX Record" type={domain.dnsRecords.mx.type} name={domain.dnsRecords.mx.name}
                                value={domain.dnsRecords.mx.value || ''}
                                priority={domain.dnsRecords.mx.priority != null ? String(domain.dnsRecords.mx.priority) : undefined}
                                status={statusFor(domain.mxStatus, 'mx')}
                                onCheck={() => handleVerify('mx')} isChecking={checkingRecord === 'mx'} disabled={isBusy} />
                            <DnsRecordCard label="Return-Path" type={domain.dnsRecords.returnPath.type} name={domain.dnsRecords.returnPath.name}
                                value={domain.dnsRecords.returnPath.value || ''}
                                status={statusFor(domain.returnPathStatus, 'returnPath')}
                                onCheck={() => handleVerify('returnPath')} isChecking={checkingRecord === 'returnPath'} disabled={isBusy} />
                        </>
                    )}

                    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/50">
                        <p className="text-sm text-blue-800 dark:text-blue-200">
                            Need help? After adding these DNS records at your domain provider, click the refresh icon on each record to verify. DNS changes can take up to 48 hours to propagate.
                        </p>
                    </div>

                    <div className="flex justify-end">
                        <Button variant="outline" onClick={onClose}>Close</Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}

function AddDomainModal({ organizations, onClose, onCreate }: { organizations: OrganizationOption[]; onClose: () => void; onCreate: (organizationId: string, name: string) => void }) {
    const [selectedOrgId, setSelectedOrgId] = useState(organizations.length === 1 ? organizations[0].id : '')
    const [domainName, setDomainName] = useState('')

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
            <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
                <CardHeader>
                    <div className="flex items-start justify-between">
                        <div>
                            <CardTitle>Add Domain</CardTitle>
                            <CardDescription>Add a new sending domain to an organization.</CardDescription>
                        </div>
                        <Button variant="ghost" size="icon" onClick={onClose}>
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label>Organization</Label>
                        <select
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            value={selectedOrgId}
                            onChange={(e) => setSelectedOrgId(e.target.value)}
                        >
                            <option value="">Select organization...</option>
                            {organizations.map((org) => (
                                <option key={org.id} value={org.id}>
                                    {org.name}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="space-y-2">
                        <Label>Domain Name</Label>
                        <Input
                            placeholder="example.com"
                            value={domainName}
                            onChange={(e) => setDomainName(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                            Enter the domain you want to send emails from.
                        </p>
                    </div>
                    <div className="flex justify-end gap-3">
                        <Button variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button onClick={() => onCreate(selectedOrgId, domainName.trim())} disabled={!selectedOrgId || !domainName.trim()}>
                            Add Domain
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}

export default function DomainsPage() {
    const [domains, setDomains] = useState<DomainRecord[]>([])
    const [organizations, setOrganizations] = useState<OrganizationOption[]>([])
    const [searchQuery, setSearchQuery] = useState('')
    const [isLoading, setIsLoading] = useState(true)
    const [selectedDomain, setSelectedDomain] = useState<DomainRecord | null>(null)
    const [showAddModal, setShowAddModal] = useState(false)

    useEffect(() => {
        void bootstrap()
    }, [])

    async function bootstrap() {
        setIsLoading(true)
        try {
            const [orgs, domainsData] = await Promise.all([
                loadOrganizations(),
                apiFetch<{ domains: DomainRecord[] }>('/api/domains'),
            ])
            setOrganizations(orgs)
            setDomains(domainsData.domains || [])
        } catch (error) {
            console.error('Error loading data:', error)
            setDomains([])
        } finally {
            setIsLoading(false)
        }
    }

    function getOrgName(orgId: string): string {
        const org = organizations.find((o) => o.id === orgId)
        return org?.name || 'Unknown'
    }

    function handleDomainUpdate(updated: DomainRecord) {
        setDomains((current) => current.map((d) => d.id === updated.id ? updated : d))
        if (selectedDomain?.id === updated.id) {
            setSelectedDomain(updated)
        }
    }

    async function handleCreateDomain(organizationId: string, name: string) {
        try {
            const data = await apiFetch<{ domain: DomainRecord }>('/api/domains', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    organizationId,
                    name,
                    verificationMethod: 'dns',
                }),
            })
            setDomains((current) => [data.domain, ...current])
            setShowAddModal(false)
            setSelectedDomain(data.domain)
        } catch (error) {
            window.alert(error instanceof Error ? error.message : 'Failed to create domain')
        }
    }

    async function handleDeleteDomain(domainId: string) {
        if (!window.confirm('Delete this domain?')) {
            return
        }

        try {
            await apiFetch(`/api/domains/${domainId}`, { method: 'DELETE' })
            setDomains((current) => current.filter((item) => item.id !== domainId))
            if (selectedDomain?.id === domainId) {
                setSelectedDomain(null)
            }
        } catch (error) {
            window.alert(error instanceof Error ? error.message : 'Failed to delete domain')
        }
    }

    const filteredDomains = useMemo(
        () => domains.filter((domain) => matchesSearch(domain.name, searchQuery)),
        [domains, searchQuery]
    )

    return (
        <div className="space-y-6">
            <Card className="shadow-sm-soft">
                <CardContent className="grid gap-4 pt-6 lg:grid-cols-[minmax(0,1fr)_360px]">
                    <div className="space-y-2">
                        <Label>Search</Label>
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                className="pl-10"
                                placeholder="Search domains"
                                value={searchQuery}
                                onChange={(event) => setSearchQuery(event.target.value)}
                            />
                        </div>
                    </div>
                    <div className="space-y-2">
                        <Label>&nbsp;</Label>
                        <Button className="w-full" onClick={() => setShowAddModal(true)}>
                            <Plus className="mr-2 h-4 w-4" />
                            Add Domain
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Configured domains</CardTitle>
                    <CardDescription>
                        {domains.length} domain{domains.length !== 1 ? 's' : ''} configured
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    {isLoading ? (
                        <p className="py-8 text-center text-muted-foreground">Loading domains...</p>
                    ) : filteredDomains.length === 0 ? (
                        <p className="py-8 text-center text-muted-foreground">No domains configured yet.</p>
                    ) : (
                        filteredDomains.map((domain) => (
                            <div
                                key={domain.id}
                                className="flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-center md:justify-between cursor-pointer hover:bg-muted/50 transition-colors"
                                onClick={() => setSelectedDomain(domain)}
                            >
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                        <Globe className="h-4 w-4 text-primary" />
                                        <span className="font-medium">{domain.name}</span>
                                        <StatusPill domain={domain} />
                                    </div>
                                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                                        <span className="inline-flex items-center gap-1">
                                            <Building2 className="h-3 w-3" />
                                            {getOrgName(domain.organizationId)}
                                        </span>
                                        <span>SPF: {domain.spfStatus || 'pending'}</span>
                                        <span>MX: {domain.mxStatus || 'pending'}</span>
                                        <span>Created: {new Date(domain.createdAt).toLocaleDateString()}</span>
                                    </div>
                                </div>
                                <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                                    <Button variant="outline" size="sm" onClick={() => handleDeleteDomain(domain.id)}>
                                        <Trash2 className="h-4 w-4 text-gray-500 hover:text-red-500 transition-colors" />
                                    </Button>
                                </div>
                            </div>
                        ))
                    )}
                </CardContent>
            </Card>

            {showAddModal && (
                <AddDomainModal
                    organizations={organizations}
                    onClose={() => setShowAddModal(false)}
                    onCreate={handleCreateDomain}
                />
            )}

            {selectedDomain && (
                <DnsModal
                    domain={selectedDomain}
                    onClose={() => setSelectedDomain(null)}
                    onDomainUpdate={handleDomainUpdate}
                />
            )}
        </div>
    )
}

function getOverallStatus(domain: DomainRecord): 'verified' | 'failed' | 'pending' {
    const allVerified =
        domain.verificationStatus === 'verified' &&
        domain.spfStatus === 'verified' &&
        domain.dkimStatus === 'verified' &&
        domain.dmarcStatus === 'verified' &&
        domain.mxStatus === 'verified' &&
        domain.returnPathStatus === 'verified'
    if (allVerified) return 'verified'

    const anyFailed =
        domain.verificationStatus === 'failed' ||
        domain.spfStatus === 'failed' ||
        domain.dkimStatus === 'failed' ||
        domain.dmarcStatus === 'failed' ||
        domain.mxStatus === 'failed' ||
        domain.returnPathStatus === 'failed'
    if (anyFailed) return 'failed'

    return 'pending'
}

function StatusPill({ domain }: { domain: DomainRecord }) {
    const status = getOverallStatus(domain)
    const label = status === 'verified' ? 'Authenticated' : status === 'failed' ? 'Failed' : 'Pending'
    const className =
        status === 'verified'
            ? 'bg-primary/10 text-primary'
            : status === 'failed'
            ? 'bg-destructive/10 text-destructive'
            : 'bg-secondary text-secondary-foreground'

    return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>
}
