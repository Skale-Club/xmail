import { useCallback, useEffect, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../lib/api-client'
import { normalizeTrustedDomain } from '../lib/sender-domain'

export const TRUSTED_IMAGE_DOMAINS_KEY = ['mail', 'trusted-image-domains'] as const

/** Per-sender keys written by the old localStorage-only implementation of EmailHtmlViewer. */
export const LEGACY_IMAGE_TRUST_PREFIX = 'xmail:show-images:'

const ENDPOINT = '/api/mail/trusted-image-domains'

interface TrustedDomainsResponse {
    domains: string[]
}

function sortedUnique(domains: string[]): string[] {
    return [...new Set(domains)].sort()
}

/** Reads the legacy per-sender keys and the domains they map to. Never throws. */
function readLegacyEntries(): { keys: string[]; domains: string[] } {
    const keys: string[] = []
    const domains = new Set<string>()
    try {
        const storage = window.localStorage
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index)
            if (!key || !key.startsWith(LEGACY_IMAGE_TRUST_PREFIX)) continue
            keys.push(key)
            const address = key.slice(LEGACY_IMAGE_TRUST_PREFIX.length)
            const domain = normalizeTrustedDomain(address.slice(address.lastIndexOf('@') + 1))
            if (domain) domains.add(domain)
        }
    } catch {
        // Storage unavailable: nothing to migrate.
    }
    return { keys, domains: [...domains] }
}

function removeLegacyKeys(keys: string[]) {
    try {
        for (const key of keys) window.localStorage.removeItem(key)
    } catch {
        // Ignore: worst case the import runs again next load (the server add is idempotent).
    }
}

let legacyMigrationInFlight = false

/**
 * Sender domains whose remote images load automatically, stored per user on the server.
 * The first load after the upgrade also imports the old per-sender localStorage choices and
 * clears them.
 */
export function useTrustedImageDomains() {
    const queryClient = useQueryClient()

    const query = useQuery({
        queryKey: TRUSTED_IMAGE_DOMAINS_KEY,
        queryFn: async () => {
            const data = await apiFetch<TrustedDomainsResponse | undefined>(ENDPOINT)
            return sortedUnique(data?.domains ?? [])
        },
        staleTime: 60 * 60 * 1000,
    })

    const addMutation = useMutation({
        mutationFn: (domains: string[]) =>
            apiFetch<TrustedDomainsResponse>(ENDPOINT, {
                method: 'POST',
                body: JSON.stringify(domains.length === 1 ? { domain: domains[0] } : { domains }),
            }),
        onMutate: async (domains) => {
            await queryClient.cancelQueries({ queryKey: TRUSTED_IMAGE_DOMAINS_KEY })
            const previous = queryClient.getQueryData<string[]>(TRUSTED_IMAGE_DOMAINS_KEY)
            queryClient.setQueryData<string[]>(TRUSTED_IMAGE_DOMAINS_KEY, sortedUnique([...(previous ?? []), ...domains]))
            return { previous }
        },
        onError: (_error, _domains, context) => {
            queryClient.setQueryData(TRUSTED_IMAGE_DOMAINS_KEY, context?.previous)
        },
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: TRUSTED_IMAGE_DOMAINS_KEY })
        },
    })

    const removeMutation = useMutation({
        mutationFn: (domain: string) =>
            apiFetch<{ success: boolean }>(`${ENDPOINT}/${encodeURIComponent(domain)}`, { method: 'DELETE' }),
        onMutate: async (domain) => {
            await queryClient.cancelQueries({ queryKey: TRUSTED_IMAGE_DOMAINS_KEY })
            const previous = queryClient.getQueryData<string[]>(TRUSTED_IMAGE_DOMAINS_KEY)
            queryClient.setQueryData<string[]>(TRUSTED_IMAGE_DOMAINS_KEY, (previous ?? []).filter(item => item !== domain))
            return { previous }
        },
        onError: (_error, _domain, context) => {
            queryClient.setQueryData(TRUSTED_IMAGE_DOMAINS_KEY, context?.previous)
        },
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: TRUSTED_IMAGE_DOMAINS_KEY })
        },
    })

    const { mutateAsync: addAsync } = addMutation
    const isLoaded = query.isSuccess

    // One-time import of the old per-sender localStorage choices, once the server list is known.
    useEffect(() => {
        if (!isLoaded || legacyMigrationInFlight) return
        const legacy = readLegacyEntries()
        if (legacy.keys.length === 0) return
        if (legacy.domains.length === 0) {
            removeLegacyKeys(legacy.keys)
            return
        }
        legacyMigrationInFlight = true
        addAsync(legacy.domains)
            .then(() => removeLegacyKeys(legacy.keys))
            .catch(() => {
                // Keep the keys so the import retries on the next load.
            })
            .finally(() => {
                legacyMigrationInFlight = false
            })
    }, [isLoaded, addAsync])

    const domains = useMemo(() => new Set(query.data ?? []), [query.data])

    const add = useCallback((domain: string) => addAsync([domain]), [addAsync])

    return {
        domains,
        list: query.data ?? [],
        isLoading: query.isPending,
        isError: query.isError,
        add,
        remove: removeMutation.mutateAsync,
        removingDomain: removeMutation.isPending ? removeMutation.variables : undefined,
    }
}
