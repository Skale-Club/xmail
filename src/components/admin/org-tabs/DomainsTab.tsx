import { useEffect, useMemo, useState } from 'react'
import { Globe, Plus, Search, CheckCircle, XCircle, Trash2, Copy, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/Dialog'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { toast } from '../../ui/toaster'
import { useBranding } from '../../../lib/branding'
import { apiFetch, apiRequest } from './shared'

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

interface Domain {
    id: string
    organizationId: string
    name: string
    verificationToken: string
    verificationStatus: 'pending' | 'verified' | 'failed'
    verificationMethod: string | null
    spfStatus: string | null
    spfError: string | null
    dkimStatus: string | null
    dkimError: string | null
    dmarcStatus: string | null
    dmarcError: string | null
    mxStatus: string | null
    mxError: string | null
    returnPathStatus: string | null
    returnPathError: string | null
    dkimSelector: string | null
    dkimPublicKey: string | null
    dnsRecords?: DomainDnsRecords
    verifiedAt: string | null
    createdAt: string
}

interface DnsRecord {
    label: string
    type: string
    name: string
    value: string
    status: 'success' | 'error' | 'pending'
}

interface DnsResults {
    verification: { found: boolean }
    spf: { found: boolean; error: string | null }
    dkim: { found: boolean; error: string | null }
    dmarc: { found: boolean; error: string | null }
    mx: { found: boolean; error: string | null }
    returnPath: { found: boolean; error: string | null }
}

interface DomainsTabProps {
    organizationId: string
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

function DnsRecordCard({ record }: { record: DnsRecord }) {
    return (
        <div className="rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">{record.label}</h4>
                <StatusBadge status={record.status} />
            </div>

            <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Type</span>
                    <div>
                        <code className="rounded bg-muted px-2.5 py-1.5 text-xs font-mono">{record.type}</code>
                    </div>
                </div>
                <div className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</span>
                    <div className="flex items-center gap-1.5">
                        <code className="flex-1 truncate rounded bg-muted px-2.5 py-1.5 text-xs font-mono">{record.name}</code>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => copyToClipboard(record.name)} title="Copy name" aria-label="Copy name">
                            <Copy className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                </div>
                <div className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Value</span>
                    <div className="flex items-center gap-1.5">
                        <code className="flex-1 truncate rounded bg-muted px-2.5 py-1.5 text-xs font-mono">{record.value}</code>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => copyToClipboard(record.value)} title="Copy value" aria-label="Copy value">
                            <Copy className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                </div>
            </div>

            {record.status === 'error' && (
                <div className="rounded-md bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-300">
                    The {record.label} values here and in your domain provider account mismatch. Add this value to your domain provider account to authenticate this domain.
                </div>
            )}
            {record.status === 'success' && (
                <div className="rounded-md bg-emerald-50 p-3 text-xs text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                    The {record.label} values here and in your domain provider account match.
                </div>
            )}
        </div>
    )
}

export default function DomainsTab({ organizationId }: DomainsTabProps) {
    const { branding } = useBranding()
    const verificationLabel = branding.companyName ? `${branding.companyName} Verification` : 'Domain Verification'
    const [domains, setDomains] = useState<Domain[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState('')
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [selectedDomain, setSelectedDomain] = useState<Domain | null>(null)
    const [dnsResults, setDnsResults] = useState<DnsResults | null>(null)
    const [isVerifying, setIsVerifying] = useState(false)
    const [newDomain, setNewDomain] = useState({
        name: '',
        verificationMethod: 'dns',
    })
    const [domainToDelete, setDomainToDelete] = useState<Domain | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)

    useEffect(() => {
        void fetchDomains()
    }, [organizationId])

    async function fetchDomains() {
        setIsLoading(true)
        try {
            const data = await apiFetch<{ domains: Domain[] }>(`/api/domains?organizationId=${organizationId}`)
            setDomains(data.domains || [])
        } catch (error) {
            console.error('Error fetching domains:', error)
        } finally {
            setIsLoading(false)
        }
    }

    const filteredDomains = useMemo(() => (
        domains.filter((domain) =>
            domain.name.toLowerCase().includes(searchQuery.toLowerCase())
        )
    ), [domains, searchQuery])

    async function handleCreateDomain() {
        if (!newDomain.name.trim()) return

        try {
            const data = await apiFetch<{ domain: Domain }>('/api/domains', {
                method: 'POST',
                body: JSON.stringify({
                    organizationId,
                    name: newDomain.name.trim(),
                    verificationMethod: newDomain.verificationMethod,
                }),
            })

            setDomains((current) => [data.domain, ...current])
            setNewDomain({ name: '', verificationMethod: 'dns' })
            setShowCreateModal(false)
            setSelectedDomain(data.domain)
            toast({ title: 'Domain added', variant: 'success' })
        } catch (error) {
            console.error('Error creating domain:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to create domain', variant: 'destructive' })
        }
    }

    async function handleVerifyDomain(domainId: string) {
        setIsVerifying(true)
        try {
            const data = await apiFetch<{ domain: Domain; dnsResults?: DnsResults }>(`/api/domains/${domainId}/verify`, {
                method: 'POST',
            })

            setDomains((current) =>
                current.map((domain) => domain.id === domainId ? data.domain : domain)
            )
            if (selectedDomain?.id === domainId) {
                setSelectedDomain(data.domain)
            }
            setDnsResults(data.dnsResults || null)
        } catch (error) {
            console.error('Error verifying domain:', error)
            toast({ title: error instanceof Error ? error.message : 'Verification failed', variant: 'destructive' })
        } finally {
            setIsVerifying(false)
        }
    }

    async function handleDeleteDomain() {
        if (!domainToDelete) return
        setIsDeleting(true)
        try {
            await apiRequest(`/api/domains/${domainToDelete.id}`, {
                method: 'DELETE',
            })

            setDomains((current) => current.filter((domain) => domain.id !== domainToDelete.id))
            if (selectedDomain?.id === domainToDelete.id) {
                setSelectedDomain(null)
            }
            toast({ title: 'Domain deleted', variant: 'success' })
            setDomainToDelete(null)
        } catch (error) {
            console.error('Error deleting domain:', error)
            toast({ title: error instanceof Error ? error.message : 'Failed to delete domain', variant: 'destructive' })
        } finally {
            setIsDeleting(false)
        }
    }

    function getDnsRecords(domain: Domain): DnsRecord[] {
        // Use live dnsResults when available (after clicking "Check records"),
        // otherwise fall back to persisted DB status
        function statusFor(
            dbStatus: string | null | undefined,
            resultsKey: keyof NonNullable<typeof dnsResults>,
        ): DnsRecord['status'] {
            if (dnsResults) {
                return dnsResults[resultsKey].found ? 'success' : 'error'
            }
            if (dbStatus === 'verified') return 'success'
            if (dbStatus === 'failed') return 'error'
            return 'pending'
        }

        const records = domain.dnsRecords
        if (!records) return []

        return [
            {
                label: verificationLabel,
                type: records.verification.type,
                name: records.verification.name,
                value: records.verification.value || 'Token unavailable',
                status: statusFor(domain.verificationStatus, 'verification'),
            },
            {
                label: 'SPF Record',
                type: records.spf.type,
                name: records.spf.name,
                value: records.spf.value || '',
                status: statusFor(domain.spfStatus, 'spf'),
            },
            {
                label: 'DKIM Record',
                type: records.dkim.type,
                name: records.dkim.name,
                value: records.dkim.value || '(key not generated yet)',
                status: statusFor(domain.dkimStatus, 'dkim'),
            },
            {
                label: 'DMARC Record',
                type: records.dmarc.type,
                name: records.dmarc.name,
                value: records.dmarc.value || '',
                status: statusFor(domain.dmarcStatus, 'dmarc'),
            },
            {
                label: 'MX Record',
                type: records.mx.type,
                name: records.mx.name,
                value: records.mx.priority != null ? `${records.mx.priority} ${records.mx.value}` : (records.mx.value || ''),
                status: statusFor(domain.mxStatus, 'mx'),
            },
            {
                label: 'Return-Path',
                type: records.returnPath.type,
                name: records.returnPath.name,
                value: records.returnPath.value || '',
                status: statusFor(domain.returnPathStatus, 'returnPath'),
            },
        ]
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                    <h3 className="text-lg font-semibold">Domains</h3>
                    <p className="text-sm text-muted-foreground">Manage sending domains and DNS authentication.</p>
                </div>
                <Button onClick={() => setShowCreateModal(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Domain
                </Button>
            </div>

            <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    className="pl-10"
                    placeholder="Search domains..."
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                />
            </div>

            {isLoading ? (
                <div className="flex justify-center p-8">
                    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                </div>
            ) : filteredDomains.length === 0 ? (
                <Card>
                    <CardContent className="flex flex-col items-center justify-center py-12">
                        <Globe className="mb-4 h-12 w-12 text-muted-foreground" />
                        <p className="text-muted-foreground">No domains found. Add a domain to get started.</p>
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-3">
                    {filteredDomains.map((domain) => {
                        const isAuthenticated = domain.verificationStatus === 'verified'
                        const isFailed = domain.verificationStatus === 'failed'
                        const isSelected = selectedDomain?.id === domain.id

                        return (
                            <Card
                                key={domain.id}
                                className={`cursor-pointer transition-all hover:shadow-md ${isSelected ? 'ring-2 ring-primary shadow-md' : ''}`}
                                onClick={() => { setSelectedDomain(isSelected ? null : domain); setDnsResults(null) }}
                            >
                                <CardContent className="grid gap-4 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                                    <div className="flex min-w-0 items-center gap-4">
                                        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${isAuthenticated
                                                ? 'bg-emerald-100 dark:bg-emerald-900/30'
                                                : isFailed
                                                    ? 'bg-red-100 dark:bg-red-900/30'
                                                    : 'bg-amber-100 dark:bg-amber-900/30'
                                            }`}>
                                            <Globe className={`h-5 w-5 ${isAuthenticated
                                                    ? 'text-emerald-600 dark:text-emerald-400'
                                                    : isFailed
                                                        ? 'text-red-600 dark:text-red-400'
                                                        : 'text-amber-600 dark:text-amber-400'
                                                }`} />
                                        </div>
                                        <div className="min-w-0 space-y-1">
                                            <p className="font-medium">{domain.name}</p>
                                            <p className="text-xs text-muted-foreground">
                                                Added {new Date(domain.createdAt).toLocaleDateString()}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-end gap-3">
                                        <span className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-medium ${isAuthenticated
                                                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400'
                                                : isFailed
                                                    ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                                                    : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
                                            }`}>
                                            {isAuthenticated ? 'Authenticated' : isFailed ? 'Failed' : 'Pending'}
                                        </span>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8"
                                            aria-label={`Delete ${domain.name}`}
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                setDomainToDelete(domain)
                                            }}
                                        >
                                            <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        )
                    })}
                </div>
            )}

            {/* DNS Records Panel */}
            {selectedDomain && (
                <Card>
                    <CardHeader>
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <CardTitle>DNS records for domain authentication</CardTitle>
                                <CardDescription className="mt-1.5">
                                    Add these DNS records to your domain provider to authenticate <strong>{selectedDomain.name}</strong>
                                </CardDescription>
                            </div>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleVerifyDomain(selectedDomain.id)}
                                disabled={isVerifying}
                            >
                                <RefreshCw className={`mr-2 h-4 w-4 ${isVerifying ? 'animate-spin' : ''}`} />
                                {isVerifying ? 'Verifying...' : 'Check records'}
                            </Button>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {getDnsRecords(selectedDomain).map((record) => (
                            <DnsRecordCard key={record.label} record={record} />
                        ))}

                        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/50">
                            <p className="text-sm text-blue-800 dark:text-blue-200">
                                Need help? After adding these DNS records at your domain provider, click "Check records" to verify. DNS changes can take up to 48 hours to propagate.
                            </p>
                        </div>

                        <div className="flex justify-end">
                            <Button variant="outline" onClick={() => setSelectedDomain(null)}>
                                Close
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            <ConfirmDialog
                open={domainToDelete !== null}
                onOpenChange={(open) => { if (!open) setDomainToDelete(null) }}
                title="Delete domain"
                description={domainToDelete ? `"${domainToDelete.name}" will no longer be able to send or receive mail through this organization.` : ''}
                confirmLabel="Delete"
                variant="danger"
                loading={isDeleting}
                onConfirm={() => void handleDeleteDomain()}
            />

            <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Add Domain</DialogTitle>
                        <DialogDescription>Add a new sending domain to this organization.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                        <Label htmlFor="domainName">Domain Name</Label>
                        <Input
                            id="domainName"
                            placeholder="example.com"
                            value={newDomain.name}
                            onChange={(event) => setNewDomain((current) => ({ ...current, name: event.target.value }))}
                        />
                        <p className="text-xs text-muted-foreground">
                            Enter the domain you want to send emails from (e.g., yourdomain.com)
                        </p>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowCreateModal(false)}>
                            Cancel
                        </Button>
                        <Button onClick={() => void handleCreateDomain()} disabled={!newDomain.name.trim()}>
                            Add Domain
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
