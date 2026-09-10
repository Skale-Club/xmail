import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useLocation, useRoute, useSearch } from 'wouter'
import {
    AlertCircle,
    ArrowLeft,
    BarChart2,
    Building2,
    FileText,
    Globe,
    KeyRound,
    Mail,
    Settings,
    Users,
    Webhook,
    Workflow,
} from 'lucide-react'
import { Button } from '../../components/ui/button'
import { apiFetch } from '../../components/admin/org-tabs/shared'
import DomainsTab from '../../components/admin/org-tabs/DomainsTab'
import TemplatesTab from '../../components/admin/org-tabs/TemplatesTab'
import MessagesTab from '../../components/admin/org-tabs/MessagesTab'
import AnalyticsTab from '../../components/admin/org-tabs/AnalyticsTab'
import MembersTab from '../../components/admin/org-tabs/MembersTab'
import SettingsTab from '../../components/admin/org-tabs/SettingsTab'
import RoutesTab from '../../components/admin/org-tabs/RoutesTab'
import WebhooksTab from '../../components/admin/org-tabs/WebhooksTab'
import CredentialsTab from '../../components/admin/org-tabs/CredentialsTab'

interface Member {
    id: string
    userId: string
    role: string
    user: {
        id: string
        email: string
        firstName: string | null
        lastName: string | null
    }
}

interface Organization {
    id: string
    name: string
    slug: string
    timezone: string
    ownerId: string
    createdAt: string
    members: Member[]
}

type TabKey = 'domains' | 'templates' | 'messages' | 'analytics' | 'routes' | 'webhooks' | 'credentials' | 'members' | 'settings'

const tabs: Array<{ key: TabKey, label: string, icon: ReactNode }> = [
    { key: 'domains', label: 'Domains', icon: <Globe className="h-4 w-4" /> },
    { key: 'templates', label: 'Templates', icon: <FileText className="h-4 w-4" /> },
    { key: 'messages', label: 'Messages', icon: <Mail className="h-4 w-4" /> },
    { key: 'analytics', label: 'Analytics', icon: <BarChart2 className="h-4 w-4" /> },
    { key: 'routes', label: 'Routes', icon: <Workflow className="h-4 w-4" /> },
    { key: 'webhooks', label: 'Webhooks', icon: <Webhook className="h-4 w-4" /> },
    { key: 'credentials', label: 'Credentials', icon: <KeyRound className="h-4 w-4" /> },
    { key: 'members', label: 'Members', icon: <Users className="h-4 w-4" /> },
    { key: 'settings', label: 'Settings', icon: <Settings className="h-4 w-4" /> },
]

const tabKeys = new Set<TabKey>(tabs.map((tab) => tab.key))

function isTabKey(value: string | null): value is TabKey {
    return value !== null && tabKeys.has(value as TabKey)
}

export default function OrganizationDetailPage() {
    const [, params] = useRoute('/admin/organizations/:id')
    const orgId = params?.id
    const search = useSearch()
    const [, navigate] = useLocation()

    const activeTab = useMemo<TabKey>(() => {
        const requested = new URLSearchParams(search).get('tab')
        return isTabKey(requested) ? requested : 'domains'
    }, [search])

    const [org, setOrg] = useState<Organization | null>(null)
    const [role, setRole] = useState('')
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (orgId) {
            void fetchOrganization()
        }
    }, [orgId])

    async function fetchOrganization() {
        setIsLoading(true)
        setError(null)
        try {
            const data = await apiFetch<{ organization: Organization; role: string }>(`/api/organizations/${orgId}`)
            setOrg(data.organization)
            setRole(data.role)
        } catch (err) {
            console.error('Error fetching organization:', err)
            setError(err instanceof Error ? err.message : 'Failed to load organization')
        } finally {
            setIsLoading(false)
        }
    }

    function setActiveTab(tab: TabKey) {
        const params = new URLSearchParams(search)
        params.set('tab', tab)
        navigate(`/admin/organizations/${orgId}?${params.toString()}`)
    }

    const isAdmin = role === 'admin'

    function renderActiveTab() {
        if (!org) return null

        if (activeTab === 'domains') {
            return <DomainsTab organizationId={org.id} />
        }

        if (activeTab === 'templates') {
            return <TemplatesTab organizationId={org.id} />
        }

        if (activeTab === 'messages') {
            return <MessagesTab organizationId={org.id} />
        }

        if (activeTab === 'analytics') {
            return <AnalyticsTab organizationId={org.id} />
        }

        if (activeTab === 'routes') {
            return <RoutesTab organizationId={org.id} />
        }

        if (activeTab === 'webhooks') {
            return <WebhooksTab organizationId={org.id} />
        }

        if (activeTab === 'credentials') {
            return <CredentialsTab organizationId={org.id} />
        }

        if (activeTab === 'members') {
            return (
                <MembersTab
                    orgId={org.id}
                    members={org.members}
                    isAdmin={isAdmin}
                    ownerId={org.ownerId}
                    onRefresh={fetchOrganization}
                    onNavigateToDomains={() => setActiveTab('domains')}
                />
            )
        }

        return (
            <SettingsTab
                org={{
                    id: org.id,
                    name: org.name,
                    slug: org.slug,
                    timezone: org.timezone,
                }}
                isAdmin={isAdmin}
                onRefresh={fetchOrganization}
            />
        )
    }

    if (isLoading) {
        return (
            <div className="flex items-center justify-center p-8">
                <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            </div>
        )
    }

    if (error) {
        return (
            <div className="space-y-4">
                <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center">
                    <AlertCircle className="h-8 w-8 text-destructive" />
                    <p className="text-sm text-destructive">{error}</p>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => void fetchOrganization()}>
                            Try again
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => navigate('/admin/organizations')}>
                            <ArrowLeft className="mr-2 h-4 w-4" />
                            Back to Organizations
                        </Button>
                    </div>
                </div>
            </div>
        )
    }

    if (!org) {
        return (
            <div className="space-y-4">
                <p className="text-muted-foreground">Organization not found.</p>
                <Button variant="outline" onClick={() => navigate('/admin/organizations')}>
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    Back to Organizations
                </Button>
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-4">
                    <Button variant="ghost" size="icon" aria-label="Back to organizations" onClick={() => navigate('/admin/organizations')}>
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                            <Building2 className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold tracking-tight">{org.name}</h1>
                            <p className="text-sm text-muted-foreground">{org.slug} - {org.timezone}</p>
                        </div>
                    </div>
                </div>
            </div>

            <div className="overflow-x-auto overflow-y-hidden border-b">
                <div className="flex min-w-max gap-1">
                    {tabs.map((tab) => (
                        <button
                            key={tab.key}
                            onClick={() => setActiveTab(tab.key)}
                            className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                                activeTab === tab.key
                                    ? 'border-primary text-primary'
                                    : 'border-transparent text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            {tab.icon}
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {renderActiveTab()}
        </div>
    )
}
