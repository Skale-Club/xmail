import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { apiFetch } from '../lib/api-client'
import { useMultiSession } from './useMultiSession'

interface Organization {
    id: string
    name: string
    role: string
}

interface OrganizationContextValue {
    organizations: Organization[]
    currentOrganization: Organization | null
    setCurrentOrganization: (org: Organization | null) => void
    isLoading: boolean
}

const OrganizationContext = createContext<OrganizationContextValue>({
    organizations: [],
    currentOrganization: null,
    setCurrentOrganization: () => {},
    isLoading: true,
})

const STORAGE_KEY = 'skale_outreach_org'

export function OrganizationProvider({ children }: { children: ReactNode }) {
    const { activeSessionId } = useMultiSession()
    const [organizations, setOrganizations] = useState<Organization[]>([])
    const [currentOrganization, setCurrentOrganizationState] = useState<Organization | null>(null)
    const [isLoading, setIsLoading] = useState(true)

    // Re-fetch whenever the active account changes (AccountSwitcher / multi-session)
    // — otherwise switching accounts kept showing the previous user's organizations
    // and outreach-access decision until an unrelated remount happened to refire this.
    useEffect(() => {
        setIsLoading(true)
        void loadOrganizations()
    }, [activeSessionId])

    async function loadOrganizations() {
        try {
            const data = await apiFetch<{ organizations: Organization[] }>('/api/users/organizations')
            const orgs = data.organizations || []
            setOrganizations(orgs)

            // Restore from localStorage
            const stored = localStorage.getItem(STORAGE_KEY)
            if (stored) {
                try {
                    const storedOrg = JSON.parse(stored) as Organization
                    // Re-resolve from the freshly-fetched list rather than trusting the
                    // stored snapshot verbatim — the stored `role` can be stale (e.g. an
                    // admin downgraded the user since it was cached), which would let
                    // JS-side role checks elsewhere act on a permission the user no
                    // longer has.
                    const resolved = orgs.find(o => o.id === storedOrg.id)
                    if (resolved) {
                        setCurrentOrganizationState(resolved)
                    } else {
                        // Clear invalid stored org
                        localStorage.removeItem(STORAGE_KEY)
                        setCurrentOrganizationState(orgs[0] ?? null)
                    }
                } catch {
                    localStorage.removeItem(STORAGE_KEY)
                    setCurrentOrganizationState(orgs[0] ?? null)
                }
            } else if (orgs.length > 0) {
                // Default to first organization
                setCurrentOrganizationState(orgs[0])
            } else {
                setCurrentOrganizationState(null)
            }
        } catch (error) {
            console.error('Error loading organizations:', error)
        } finally {
            setIsLoading(false)
        }
    }

    function setCurrentOrganization(org: Organization | null) {
        setCurrentOrganizationState(org)
        if (org) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(org))
        } else {
            localStorage.removeItem(STORAGE_KEY)
        }
    }

    return (
        <OrganizationContext.Provider
            value={{
                organizations,
                currentOrganization,
                setCurrentOrganization,
                isLoading,
            }}
        >
            {children}
        </OrganizationContext.Provider>
    )
}

export function useOrganization() {
    return useContext(OrganizationContext)
}