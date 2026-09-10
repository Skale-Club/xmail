import { useQuery, useMutation, useQueryClient, useInfiniteQuery, InfiniteData } from '@tanstack/react-query'
import React from 'react'
import { mailApi, Message, SendEmailPayload, SaveDraftPayload, MessageListResponse } from '../lib/mail-api'
import { useMailbox } from './useMailbox'
import { useAuth } from './useAuth'

type MessageQuerySnapshot = Array<[readonly unknown[], unknown]>

function isMailboxMessagesQuery(queryKey: readonly unknown[], mailboxId: string | undefined) {
    if (!mailboxId || queryKey[0] !== 'messages') return false
    return queryKey.includes(mailboxId)
}

function updateMessageList(
    data: MessageListResponse | InfiniteData<MessageListResponse, unknown> | undefined,
    updater: (message: Message) => Message | null
) {
    if (!data) return data

    if ('pages' in data) {
        return {
            ...data,
            pages: data.pages.map((page) => {
                const messages = page.messages
                    .map(updater)
                    .filter((message): message is Message => message !== null)

                return {
                    ...page,
                    messages,
                    total: Math.max(messages.length, page.total - (page.messages.length - messages.length)),
                }
            }),
        }
    }

    const messages = data.messages
        .map(updater)
        .filter((message): message is Message => message !== null)

    return {
        ...data,
        messages,
        total: Math.max(messages.length, data.total - (data.messages.length - messages.length)),
    }
}

function snapshotMailboxMessageQueries(queryClient: ReturnType<typeof useQueryClient>, mailboxId: string | undefined): MessageQuerySnapshot {
    return queryClient.getQueriesData({
        predicate: (query) => isMailboxMessagesQuery(query.queryKey, mailboxId),
    })
}

function restoreMessageQuerySnapshots(queryClient: ReturnType<typeof useQueryClient>, snapshots: MessageQuerySnapshot) {
    for (const [queryKey, data] of snapshots) {
        queryClient.setQueryData(queryKey, data)
    }
}

function patchMailboxMessageQueries(
    queryClient: ReturnType<typeof useQueryClient>,
    mailboxId: string | undefined,
    updater: (message: Message) => Message | null
) {
    queryClient.setQueriesData(
        {
            predicate: (query) => isMailboxMessagesQuery(query.queryKey, mailboxId),
        },
        (data) => updateMessageList(data as MessageListResponse | InfiniteData<MessageListResponse, unknown> | undefined, updater)
    )
}

export function useFolders() {
    const { selectedMailbox } = useMailbox()

    return useQuery({
        queryKey: ['folders', selectedMailbox?.id],
        queryFn: () => {
            if (!selectedMailbox) throw new Error('No mailbox selected')
            return mailApi.getFolders(selectedMailbox.id)
        },
        enabled: !!selectedMailbox,
    })
}

export interface MessageFilters {
    unread?: boolean
    starred?: boolean
    hasAttachments?: boolean
    search?: string
}

/**
 * Infinite, server-filtered message list for a folder page. Pass `folderType`
 * undefined for a mailbox-wide listing across every folder except Trash/Spam
 * (used by the cross-folder "Starred" view) — see mailApi.getMessages().
 */
export function useInfiniteMessages(folderType: string | undefined, limit = 30, filters: MessageFilters = {}) {
    const { selectedMailbox } = useMailbox()
    const foldersQuery = useFolders()
    const { unread, starred, hasAttachments, search } = filters

    const folderId = React.useMemo(() => {
        if (!folderType || !foldersQuery.data?.folders) return undefined
        const folder = foldersQuery.data.folders.find(
            (f: { remoteId?: string; type?: string; id: string }) =>
                f.type === folderType || f.remoteId?.toLowerCase() === folderType.toLowerCase()
        )
        return folder?.id
    }, [foldersQuery.data, folderType])

    const messagesQuery = useInfiniteQuery({
        queryKey: ['messages', 'infinite', selectedMailbox?.id, folderType ?? null, folderId, { unread, starred, hasAttachments, search }],
        queryFn: async ({ pageParam = 1 }) => {
            if (!selectedMailbox) throw new Error('No mailbox selected')
            const params = { page: pageParam, limit, unread, starred, hasAttachments, search }
            if (!folderType) {
                return mailApi.getMessages(selectedMailbox.id, undefined, params)
            }
            if (folderId) {
                return mailApi.getMessages(selectedMailbox.id, folderId, params)
            }
            return mailApi.getMessages(selectedMailbox.id, folderType, { ...params, isType: true })
        },
        getNextPageParam: (lastPage, allPages) => {
            if (!lastPage.hasMore) return undefined
            return allPages.length + 1
        },
        initialPageParam: 1,
        enabled: !!selectedMailbox,
        staleTime: 30000,
    })

    return {
        ...messagesQuery,
        isLoading: messagesQuery.isLoading || (!!folderType && foldersQuery.isLoading),
    }
}

export function useMessage(messageId: string | null) {
    const queryClient = useQueryClient()
    const { selectedMailbox } = useMailbox()

    const query = useQuery({
        queryKey: ['message', selectedMailbox?.id, messageId],
        queryFn: () => {
            if (!selectedMailbox || !messageId) throw new Error('Missing required params')
            return mailApi.getMessage(selectedMailbox.id, messageId)
        },
        enabled: !!selectedMailbox && !!messageId,
    })

    React.useEffect(() => {
        if (!query.data?.message?.id) return

        patchMailboxMessageQueries(queryClient, selectedMailbox?.id, (message) => {
            if (message.id !== query.data.message.id) return message
            return {
                ...message,
                read: true,
            }
        })
    }, [query.data?.message?.id, queryClient, selectedMailbox?.id])

    return query
}

export function useUpdateMessage() {
    const queryClient = useQueryClient()
    const { selectedMailbox } = useMailbox()

    return useMutation({
        mutationFn: ({
            messageId,
            data
        }: {
            messageId: string
            data: { read?: boolean; starred?: boolean; labels?: string[] }
        }) => {
            if (!selectedMailbox) throw new Error('No mailbox selected')
            return mailApi.updateMessage(selectedMailbox.id, messageId, data)
        },
        onMutate: async ({ messageId, data }) => {
            await queryClient.cancelQueries({
                predicate: (query) => isMailboxMessagesQuery(query.queryKey, selectedMailbox?.id),
            })

            const snapshots = snapshotMailboxMessageQueries(queryClient, selectedMailbox?.id)

            patchMailboxMessageQueries(queryClient, selectedMailbox?.id, (message) => {
                if (message.id !== messageId) return message

                return {
                    ...message,
                    read: data.read ?? message.read,
                    starred: data.starred ?? message.starred,
                    labels: data.labels ?? message.labels,
                }
            })

            return { snapshots }
        },
        onError: (_error, _variables, context) => {
            if (context?.snapshots) {
                restoreMessageQuerySnapshots(queryClient, context.snapshots)
            }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['messages'] })
            queryClient.invalidateQueries({ queryKey: ['folders'] })
        },
    })
}

export function useDeleteMessage() {
    const queryClient = useQueryClient()
    const { selectedMailbox } = useMailbox()

    return useMutation({
        mutationFn: (messageId: string) => {
            if (!selectedMailbox) throw new Error('No mailbox selected')
            return mailApi.deleteMessage(selectedMailbox.id, messageId)
        },
        onMutate: async (messageId: string) => {
            await queryClient.cancelQueries({
                predicate: (query) => isMailboxMessagesQuery(query.queryKey, selectedMailbox?.id),
            })

            const snapshots = snapshotMailboxMessageQueries(queryClient, selectedMailbox?.id)

            patchMailboxMessageQueries(queryClient, selectedMailbox?.id, (message) =>
                message.id === messageId ? null : message
            )

            return { snapshots }
        },
        onError: (_error, _variables, context) => {
            if (context?.snapshots) {
                restoreMessageQuerySnapshots(queryClient, context.snapshots)
            }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['messages'] })
            queryClient.invalidateQueries({ queryKey: ['folders'] })
        },
    })
}

export function useArchiveMessage() {
    const queryClient = useQueryClient()
    const { selectedMailbox } = useMailbox()

    return useMutation({
        mutationFn: (messageId: string) => {
            if (!selectedMailbox) throw new Error('No mailbox selected')
            return mailApi.archiveMessage(selectedMailbox.id, messageId)
        },
        onMutate: async (messageId: string) => {
            await queryClient.cancelQueries({
                predicate: (query) => isMailboxMessagesQuery(query.queryKey, selectedMailbox?.id),
            })

            const snapshots = snapshotMailboxMessageQueries(queryClient, selectedMailbox?.id)

            patchMailboxMessageQueries(queryClient, selectedMailbox?.id, (message) =>
                message.id === messageId ? null : message
            )

            return { snapshots }
        },
        onError: (_error, _variables, context) => {
            if (context?.snapshots) {
                restoreMessageQuerySnapshots(queryClient, context.snapshots)
            }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['messages'] })
            queryClient.invalidateQueries({ queryKey: ['folders'] })
        },
    })
}

export function useSpamMessage() {
    const queryClient = useQueryClient()
    const { selectedMailbox } = useMailbox()

    return useMutation({
        mutationFn: ({
            messageId,
            isSpam
        }: {
            messageId: string
            isSpam: boolean
        }) => {
            if (!selectedMailbox) throw new Error('No mailbox selected')
            return mailApi.spamMessage(selectedMailbox.id, messageId, isSpam)
        },
        onMutate: async ({ messageId, isSpam }) => {
            await queryClient.cancelQueries({
                predicate: (query) => isMailboxMessagesQuery(query.queryKey, selectedMailbox?.id),
            })

            const snapshots = snapshotMailboxMessageQueries(queryClient, selectedMailbox?.id)

            patchMailboxMessageQueries(queryClient, selectedMailbox?.id, (message) => {
                if (message.id !== messageId) return message
                return isSpam ? null : message
            })

            return { snapshots }
        },
        onError: (_error, _variables, context) => {
            if (context?.snapshots) {
                restoreMessageQuerySnapshots(queryClient, context.snapshots)
            }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['messages'] })
            queryClient.invalidateQueries({ queryKey: ['folders'] })
        },
    })
}

export function useRestoreMessage() {
    const queryClient = useQueryClient()
    const { selectedMailbox } = useMailbox()

    return useMutation({
        mutationFn: (messageId: string) => {
            if (!selectedMailbox) throw new Error('No mailbox selected')
            return mailApi.restoreMessage(selectedMailbox.id, messageId)
        },
        onMutate: async (messageId: string) => {
            await queryClient.cancelQueries({
                predicate: (query) => isMailboxMessagesQuery(query.queryKey, selectedMailbox?.id),
            })

            const snapshots = snapshotMailboxMessageQueries(queryClient, selectedMailbox?.id)

            patchMailboxMessageQueries(queryClient, selectedMailbox?.id, (message) =>
                message.id === messageId ? null : message
            )

            return { snapshots }
        },
        onError: (_error, _variables, context) => {
            if (context?.snapshots) {
                restoreMessageQuerySnapshots(queryClient, context.snapshots)
            }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['messages'] })
            queryClient.invalidateQueries({ queryKey: ['folders'] })
        },
    })
}

export function useMoveMessage() {
    const queryClient = useQueryClient()
    const { selectedMailbox } = useMailbox()

    return useMutation({
        mutationFn: ({
            messageId,
            folderId
        }: {
            messageId: string
            folderId: string
        }) => {
            if (!selectedMailbox) throw new Error('No mailbox selected')
            return mailApi.moveMessage(selectedMailbox.id, messageId, folderId)
        },
        onMutate: async ({ messageId }) => {
            await queryClient.cancelQueries({
                predicate: (query) => isMailboxMessagesQuery(query.queryKey, selectedMailbox?.id),
            })

            const snapshots = snapshotMailboxMessageQueries(queryClient, selectedMailbox?.id)

            patchMailboxMessageQueries(queryClient, selectedMailbox?.id, (message) =>
                message.id === messageId ? null : message
            )

            return { snapshots }
        },
        onError: (_error, _variables, context) => {
            if (context?.snapshots) {
                restoreMessageQuerySnapshots(queryClient, context.snapshots)
            }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['messages'] })
            queryClient.invalidateQueries({ queryKey: ['folders'] })
        },
    })
}

export function useBatchUpdate() {
    const queryClient = useQueryClient()
    const { selectedMailbox } = useMailbox()

    return useMutation({
        mutationFn: ({
            messageIds,
            action,
            folderId
        }: {
            messageIds: string[]
            action: 'read' | 'unread' | 'star' | 'unstar' | 'delete' | 'archive' | 'move' | 'spam' | 'unspam' | 'restore'
            folderId?: string
        }) => {
            if (!selectedMailbox) throw new Error('No mailbox selected')
            return mailApi.batchUpdate(selectedMailbox.id, messageIds, action, folderId)
        },
        onMutate: async ({ messageIds, action }) => {
            await queryClient.cancelQueries({
                predicate: (query) => isMailboxMessagesQuery(query.queryKey, selectedMailbox?.id),
            })

            const snapshots = snapshotMailboxMessageQueries(queryClient, selectedMailbox?.id)
            const messageIdSet = new Set(messageIds)

            patchMailboxMessageQueries(queryClient, selectedMailbox?.id, (message) => {
                if (!messageIdSet.has(message.id)) return message

                switch (action) {
                    case 'read':
                        return { ...message, read: true }
                    case 'unread':
                        return { ...message, read: false }
                    case 'star':
                        return { ...message, starred: true }
                    case 'unstar':
                        return { ...message, starred: false }
                    case 'delete':
                    case 'archive':
                    case 'move':
                    case 'spam':
                    case 'unspam':
                    case 'restore':
                        return null
                    default:
                        return message
                }
            })

            return { snapshots }
        },
        onError: (_error, _variables, context) => {
            if (context?.snapshots) {
                restoreMessageQuerySnapshots(queryClient, context.snapshots)
            }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ['messages'] })
            queryClient.invalidateQueries({ queryKey: ['folders'] })
        },
    })
}

export function useSendEmail() {
    const queryClient = useQueryClient()
    const { selectedMailbox } = useMailbox()

    return useMutation({
        mutationFn: (payload: SendEmailPayload) => {
            if (!selectedMailbox) throw new Error('No mailbox selected')
            return mailApi.sendEmail(selectedMailbox.id, payload)
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['messages'] })
            queryClient.invalidateQueries({ queryKey: ['folders'] })
        },
    })
}

export function useSaveDraft() {
    const queryClient = useQueryClient()
    const { selectedMailbox } = useMailbox()

    return useMutation({
        mutationFn: (payload: SaveDraftPayload) => {
            if (!selectedMailbox) throw new Error('No mailbox selected')
            return mailApi.saveDraft(selectedMailbox.id, payload)
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['messages'] })
        },
    })
}

export function useSyncMailbox() {
    const queryClient = useQueryClient()
    const { selectedMailbox } = useMailbox()

    return useMutation({
        mutationFn: () => {
            if (!selectedMailbox) throw new Error('No mailbox selected')
            return mailApi.syncMailbox(selectedMailbox.id)
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['messages'] })
            queryClient.invalidateQueries({ queryKey: ['folders'] })
        },
    })
}

export function useSearchMessages(query: string, folderId?: string) {
    const { selectedMailbox } = useMailbox()

    return useQuery({
        queryKey: ['search', selectedMailbox?.id, query, folderId],
        queryFn: () => {
            if (!selectedMailbox) throw new Error('No mailbox selected')
            return mailApi.searchMessages(selectedMailbox.id, query, { folderId })
        },
        enabled: !!selectedMailbox && query.length >= 2,
    })
}

export function mapMessageToEmailItem(message: Message): import('../components/mail/EmailList').EmailItem {
    return {
        id: message.id,
        subject: message.subject || '(No subject)',
        snippet: message.snippet || message.bodyText?.slice(0, 150) || '',
        from: message.from,
        to: message.to,
        date: new Date(message.date),
        read: message.read,
        starred: message.starred,
        hasAttachments: !!(message.attachments && message.attachments.length > 0),
        labels: message.labels,
    }
}

// Contacts hooks (user-scoped, not mailbox-scoped — see mailApi.getContacts).
// Query keys carry the user id so switching accounts can't briefly render (or
// act on) another user's contacts — see useMultiSession's queryClient.clear().
export function useContacts(search?: string, page = 1, limit = 50) {
    const { user } = useAuth()

    return useQuery({
        queryKey: ['contacts', user?.id, search, page, limit],
        queryFn: () => mailApi.getContacts({ search, page, limit }),
        enabled: !!user,
        staleTime: 30000,
    })
}

export function useSearchContacts(query: string) {
    const { user } = useAuth()

    return useQuery({
        queryKey: ['contacts', user?.id, 'search', query],
        queryFn: () => mailApi.searchContacts(query),
        enabled: !!user && query.length >= 1,
        staleTime: 10000,
    })
}

export function useCreateContact() {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: (data: { email: string; firstName?: string; lastName?: string; company?: string }) =>
            mailApi.createContact(data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['contacts'] })
        },
    })
}

export function useUpdateContact() {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: ({ id, data }: { id: string; data: { email?: string; firstName?: string; lastName?: string; company?: string } }) =>
            mailApi.updateContact(id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['contacts'] })
        },
    })
}

export function useDeleteContact() {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: (id: string) => mailApi.deleteContact(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['contacts'] })
        },
    })
}

export function useImportContactsCsv() {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: (csvContent: string) => mailApi.importContactsCsv(csvContent),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['contacts'] })
        },
    })
}
