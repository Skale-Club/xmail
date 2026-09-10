import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { mailApi } from '../lib/mail-api'
import { useAuth } from './useAuth'

export interface UserNotification {
    id: string
    userId: string
    type: string
    title: string
    message: string
    metadata: Record<string, unknown>
    read: boolean
    createdAt: string
}

export function useNotifications(page = 1, limit = 20) {
    const { user } = useAuth()

    return useQuery({
        // Scoped by user id so switching accounts can't briefly render (or act on)
        // notifications fetched for the previous session — see useMultiSession.
        queryKey: ['notifications', user?.id, page, limit],
        queryFn: () => mailApi.getNotifications({ page, limit }),
        enabled: !!user,
        staleTime: 30000,
    })
}

export function useUnreadCount() {
    const { user } = useAuth()

    return useQuery({
        queryKey: ['notifications', user?.id, 'unread-count'],
        queryFn: () => mailApi.getUnreadCount(),
        enabled: !!user,
        staleTime: 60000,
        refetchInterval: 120000,
    })
}

export function useMarkAsRead() {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: (id: string) => mailApi.markAsRead(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['notifications'] })
        },
    })
}

export function useMarkAllAsRead() {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: () => mailApi.markAllAsRead(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['notifications'] })
        },
    })
}

export function useDeleteNotification() {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: (id: string) => mailApi.deleteNotification(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['notifications'] })
        },
    })
}