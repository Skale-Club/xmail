import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
    getOrgAiAutomationSettings,
    pauseOrgAiAutomation,
    resumeOrgAiAutomation,
    type OrgAiAutomationSettings,
} from '../../../lib/unified-inbox-api'

// ============================================================
// Organization AI automation state, for the inbox chip
// ============================================================
// Reuses the same API functions and the SAME cache key as the Settings page
// (`['outreach-ai-automation-settings', orgId]`), so pausing here is reflected there and vice
// versa. No new backend: pause is the existing immediate kill switch (no confirmation, as in
// Settings) and resume is its inverse.

export const orgAiAutomationKey = (organizationId: string | undefined) =>
    ['outreach-ai-automation-settings', organizationId] as const

export function useOrgAiAutomation(organizationId: string | undefined) {
    const queryClient = useQueryClient()
    const key = orgAiAutomationKey(organizationId)

    const query = useQuery<OrgAiAutomationSettings, Error>({
        queryKey: key,
        enabled: !!organizationId,
        queryFn: () => getOrgAiAutomationSettings(organizationId as string),
        staleTime: 60_000,
    })

    const onSuccess = (data: OrgAiAutomationSettings) => {
        queryClient.setQueryData(key, data)
    }
    const onError = () => {
        // Conflict or denied write: fall back to server truth.
        void query.refetch()
    }

    const pause = useMutation<OrgAiAutomationSettings, Error, string | undefined>({
        mutationFn: (reason) => pauseOrgAiAutomation(organizationId as string, reason?.trim() || null),
        onSuccess,
        onError,
    })
    const resume = useMutation<OrgAiAutomationSettings, Error, void>({
        mutationFn: () => resumeOrgAiAutomation(organizationId as string),
        onSuccess,
        onError,
    })

    return {
        settings: query.data,
        isLoading: query.isLoading,
        isError: query.isError,
        pause: (reason?: string) => pause.mutate(reason),
        resume: () => resume.mutate(),
        pending: pause.isPending || resume.isPending,
        error: pause.error?.message ?? resume.error?.message ?? null,
    }
}
