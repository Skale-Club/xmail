import { apiFetch, ApiClientError, getAccessToken } from '../lib/api-client'

interface RecipientInput {
    address: string
    name?: string
}

interface AttachmentInput {
    filename: string
    content: string
    contentType?: string
}

async function fileToBase64(file: File): Promise<string> {
    const buffer = await file.arrayBuffer()
    let binary = ''
    const bytes = new Uint8Array(buffer)

    for (let index = 0; index < bytes.length; index += 1) {
        binary += String.fromCharCode(bytes[index])
    }

    return btoa(binary)
}

function mapRecipients(recipients?: { name?: string; email: string }[]): RecipientInput[] | undefined {
    if (!recipients?.length) {
        return undefined
    }

    return recipients.map(recipient => ({
        address: recipient.email,
        ...(recipient.name ? { name: recipient.name } : {}),
    }))
}

async function mapAttachments(files?: File[]): Promise<AttachmentInput[] | undefined> {
    if (!files?.length) {
        return undefined
    }

    const attachments = await Promise.all(files.map(async file => ({
        filename: file.name,
        content: await fileToBase64(file),
        ...(file.type ? { contentType: file.type } : {}),
    })))

    return attachments
}

export interface Mailbox {
    id: string
    email: string
    displayName: string | null
    isDefault: boolean
    isActive: boolean
    lastSyncAt: string | null
    syncError: string | null
    provider?: 'gmail' | 'outlook' | 'yahoo' | 'icloud' | 'custom'
}

export interface Message {
    id: string
    mailboxId: string
    folder: string
    messageId: string
    inReplyTo?: string
    references?: string
    from: { name: string; email: string }
    to: { name: string; email: string }[]
    cc?: { name: string; email: string }[]
    bcc?: { name: string; email: string }[]
    subject: string
    bodyText?: string
    bodyHtml?: string
    plainBody?: string
    htmlBody?: string
    snippet?: string
    headers?: Record<string, string>
    date: string
    read: boolean
    starred: boolean
    attachments?: {
        id: string
        filename: string
        mimeType: string
        size: number
    }[]
    hasAttachments: boolean
    labels?: string[]
    createdAt: string
}

export interface MessageListResponse {
    messages: Message[]
    total: number
    hasMore: boolean
}

type RawMessage = Partial<Message> & {
    isRead?: boolean
    isStarred?: boolean
    receivedAt?: string
}

type RawMessageListResponse = {
    messages?: RawMessage[]
    total?: number
    hasMore?: boolean
    pagination?: {
        total?: number
        page?: number
        limit?: number
        totalPages?: number
    }
}

function normalizeMessage(message: RawMessage): Message {
    return {
        id: message.id || '',
        mailboxId: message.mailboxId || '',
        folder: message.folder || '',
        messageId: message.messageId || '',
        inReplyTo: message.inReplyTo,
        references: message.references,
        from: message.from || { name: '', email: '' },
        to: message.to || [],
        cc: message.cc,
        bcc: message.bcc,
        subject: message.subject || '',
        bodyText: message.bodyText ?? message.plainBody,
        bodyHtml: message.bodyHtml ?? message.htmlBody,
        plainBody: message.plainBody,
        htmlBody: message.htmlBody,
        snippet: message.snippet,
        headers: message.headers,
        date: message.date || message.receivedAt || message.createdAt || new Date().toISOString(),
        read: message.read ?? message.isRead ?? false,
        starred: message.starred ?? message.isStarred ?? false,
        attachments: message.attachments,
        hasAttachments: message.hasAttachments ?? Boolean(message.attachments?.length),
        labels: message.labels,
        createdAt: message.createdAt || message.receivedAt || new Date().toISOString(),
    }
}

function normalizeMessageListResponse(payload: RawMessageListResponse): MessageListResponse {
    const messages = (payload.messages || []).map(normalizeMessage)
    const total = payload.total ?? payload.pagination?.total ?? messages.length

    return {
        messages,
        total,
        hasMore: payload.hasMore ?? messages.length < total,
    }
}

export interface SendEmailPayload {
    to: { name?: string; email: string }[]
    cc?: { name?: string; email: string }[]
    bcc?: { name?: string; email: string }[]
    subject: string
    bodyText?: string
    bodyHtml?: string
    replyTo?: string
    inReplyTo?: string
    references?: string
    attachments?: File[]
}

export interface SaveDraftPayload {
    to?: { name?: string; email: string }[]
    cc?: { name?: string; email: string }[]
    bcc?: { name?: string; email: string }[]
    subject?: string
    bodyText?: string
    bodyHtml?: string
    draftId?: string
    attachments?: File[]
}

export interface SendEmailResponse {
    success: boolean
    messageId: string
    message: string
}

export interface SaveDraftResponse {
    success: boolean
    messageId: string
    draftId: string
    message: string
}

export interface Signature {
    id: string
    mailboxId: string
    name: string
    content: string
    isDefault: boolean
    createdAt: string
    updatedAt: string
}

export interface ContactItem {
    id: string
    email: string
    firstName: string | null
    lastName: string | null
    company: string | null
    emailedCount: number
    lastEmailedAt: string | null
    createdAt: string
    updatedAt: string
}

export const mailApi = {
    getMailboxes(): Promise<{ mailboxes: Mailbox[] }> {
        return apiFetch('/api/mail/mailboxes')
    },

    getMailbox(id: string): Promise<{ mailbox: Mailbox }> {
        return apiFetch(`/api/mail/mailboxes/${id}`)
    },

    getFolders(mailboxId: string): Promise<{ folders: { id: string; name: string; remoteId?: string; type?: string; count: number; unread: number }[] }> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/folders`)
    },

    getMessages(
        mailboxId: string,
        // Omit folderIdOrType (undefined) for a mailbox-wide listing (used by the
        // cross-folder "Starred" view) — the server then lists across every folder
        // except Trash/Spam instead of resolving a single one.
        folderIdOrType: string | undefined,
        params?: {
            page?: number
            limit?: number
            search?: string
            isType?: boolean
            unread?: boolean
            starred?: boolean
            hasAttachments?: boolean
        }
    ): Promise<MessageListResponse> {
        const searchParams = new URLSearchParams()
        if (folderIdOrType) {
            if (params?.isType) {
                searchParams.set('folderType', folderIdOrType)
            } else {
                searchParams.set('folderId', folderIdOrType)
            }
        }
        if (params?.page !== undefined) searchParams.set('page', String(params.page))
        if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
        if (params?.search) searchParams.set('q', params.search)
        if (params?.unread) searchParams.set('unread', '1')
        if (params?.starred) searchParams.set('starred', '1')
        if (params?.hasAttachments) searchParams.set('hasAttachments', '1')

        return apiFetch<RawMessageListResponse>(`/api/mail/mailboxes/${mailboxId}/messages?${searchParams}`)
            .then(normalizeMessageListResponse)
    },

    getMessage(mailboxId: string, messageId: string): Promise<{ message: Message }> {
        return apiFetch<{ message: RawMessage }>(`/api/mail/mailboxes/${mailboxId}/messages/${messageId}`)
            .then((payload) => ({
                message: normalizeMessage(payload.message),
            }))
    },

    updateMessage(
        mailboxId: string,
        messageId: string,
        data: { read?: boolean; starred?: boolean; labels?: string[] }
    ): Promise<{ message: Message }> {
        return apiFetch<{ message: RawMessage }>(`/api/mail/mailboxes/${mailboxId}/messages/${messageId}`, {
            method: 'PUT',
            body: JSON.stringify({
                isRead: data.read,
                isStarred: data.starred,
            }),
        }).then((payload) => ({
            message: normalizeMessage(payload.message),
        }))
    },

    deleteMessage(mailboxId: string, messageId: string): Promise<void> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/messages/${messageId}`, {
            method: 'DELETE',
        })
    },

    archiveMessage(mailboxId: string, messageId: string): Promise<void> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/messages/${messageId}/archive`, {
            method: 'POST',
        })
    },

    spamMessage(mailboxId: string, messageId: string, isSpam: boolean): Promise<void> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/messages/${messageId}/spam`, {
            method: 'POST',
            body: JSON.stringify({ isSpam }),
        })
    },

    moveMessage(mailboxId: string, messageId: string, folderId: string): Promise<void> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/messages/${messageId}/move`, {
            method: 'POST',
            body: JSON.stringify({ folderId }),
        })
    },

    restoreMessage(mailboxId: string, messageId: string): Promise<void> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/messages/${messageId}/restore`, {
            method: 'POST',
        })
    },

    batchUpdate(
        mailboxId: string,
        messageIds: string[],
        action: 'read' | 'unread' | 'star' | 'unstar' | 'delete' | 'archive' | 'move' | 'spam' | 'unspam' | 'restore',
        folderId?: string
    ): Promise<void> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/messages/batch`, {
            method: 'POST',
            body: JSON.stringify({ messageIds, action, folderId }),
        })
    },

    async sendEmail(mailboxId: string, payload: SendEmailPayload): Promise<SendEmailResponse> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/send`, {
            method: 'POST',
            body: JSON.stringify({
                to: mapRecipients(payload.to),
                cc: mapRecipients(payload.cc),
                bcc: mapRecipients(payload.bcc),
                subject: payload.subject,
                plainBody: payload.bodyText,
                htmlBody: payload.bodyHtml,
                inReplyTo: payload.inReplyTo,
                references: payload.references,
                attachments: await mapAttachments(payload.attachments),
                saveToSent: true,
            }),
        })
    },

    async saveDraft(mailboxId: string, payload: SaveDraftPayload): Promise<SaveDraftResponse> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/save-draft`, {
            method: 'POST',
            body: JSON.stringify({
                to: mapRecipients(payload.to),
                cc: mapRecipients(payload.cc),
                bcc: mapRecipients(payload.bcc),
                subject: payload.subject,
                plainBody: payload.bodyText,
                htmlBody: payload.bodyHtml,
                draftId: payload.draftId,
                attachments: await mapAttachments(payload.attachments),
            }),
        })
    },

    // Attachment bytes are not JSON — apiFetch() only knows how to parse JSON/text
    // responses, so this bypasses it and drives fetch() directly, same auth header
    // included, then hands the browser a blob to save.
    async downloadAttachment(mailboxId: string, messageId: string, index: number, filename: string): Promise<void> {
        const token = await getAccessToken()
        if (!token) {
            throw new ApiClientError('Not authenticated', { status: 401, path: 'session', code: 'NOT_AUTHENTICATED' })
        }

        const response = await fetch(`/api/mail/mailboxes/${mailboxId}/messages/${messageId}/attachments/${index}`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
        })

        if (!response.ok) {
            let message = response.statusText || 'Failed to download attachment'
            try {
                const payload = await response.json()
                if (payload && typeof payload === 'object' && 'error' in payload) {
                    message = String(payload.error)
                }
            } catch {
                // Non-JSON error body — keep the statusText fallback above.
            }
            throw new ApiClientError(message, { status: response.status, path: `/api/mail/mailboxes/${mailboxId}/messages/${messageId}/attachments/${index}` })
        }

        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        try {
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = filename
            document.body.appendChild(anchor)
            anchor.click()
            document.body.removeChild(anchor)
        } finally {
            URL.revokeObjectURL(url)
        }
    },

    syncMailbox(mailboxId: string): Promise<void> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/sync`, {
            method: 'POST',
        })
    },

    searchMessages(
        mailboxId: string,
        query: string,
        params?: { folderId?: string; page?: number; limit?: number }
    ): Promise<MessageListResponse> {
        const searchParams = new URLSearchParams()
        searchParams.set('q', query)
        if (params?.folderId) searchParams.set('folderId', params.folderId)
        if (params?.page !== undefined) searchParams.set('page', String(params.page))
        if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))

        return apiFetch<RawMessageListResponse>(`/api/mail/mailboxes/${mailboxId}/search?${searchParams}`)
            .then(normalizeMessageListResponse)
    },

    getSignatures(mailboxId: string): Promise<{ signatures: Signature[] }> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/signatures`)
    },

    getDefaultSignature(mailboxId: string): Promise<{ signature: Signature | null }> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/signatures/default`)
    },

    createSignature(
        mailboxId: string,
        data: { name: string; content: string; isDefault?: boolean }
    ): Promise<{ signature: Signature }> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/signatures`, {
            method: 'POST',
            body: JSON.stringify(data),
        })
    },

    updateSignature(
        mailboxId: string,
        signatureId: string,
        data: { name?: string; content?: string; isDefault?: boolean }
    ): Promise<{ signature: Signature }> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/signatures/${signatureId}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        })
    },

    deleteSignature(mailboxId: string, signatureId: string): Promise<void> {
        return apiFetch(`/api/mail/mailboxes/${mailboxId}/signatures/${signatureId}`, {
            method: 'DELETE',
        })
    },

    // Contacts API (user-scoped, not mailbox-scoped)
    getContacts(params?: { page?: number; limit?: number; search?: string }): Promise<{
        contacts: ContactItem[]
        total: number
        page: number
        limit: number
        hasMore: boolean
    }> {
        const searchParams = new URLSearchParams()
        if (params?.page !== undefined) searchParams.set('page', String(params.page))
        if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
        if (params?.search) searchParams.set('search', params.search)
        const qs = searchParams.toString()
        return apiFetch(`/api/mail/contacts${qs ? `?${qs}` : ''}`)
    },

    searchContacts(query: string): Promise<{ contacts: ContactItem[] }> {
        return apiFetch(`/api/mail/contacts/search?q=${encodeURIComponent(query)}`)
    },

    createContact(data: { email: string; firstName?: string; lastName?: string; company?: string }): Promise<{ contact: ContactItem }> {
        return apiFetch('/api/mail/contacts', {
            method: 'POST',
            body: JSON.stringify(data),
        })
    },

    updateContact(id: string, data: { email?: string; firstName?: string; lastName?: string; company?: string }): Promise<{ contact: ContactItem }> {
        return apiFetch(`/api/mail/contacts/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        })
    },

    deleteContact(id: string): Promise<void> {
        return apiFetch(`/api/mail/contacts/${id}`, {
            method: 'DELETE',
        })
    },

    importContactsCsv(csvContent: string): Promise<{ imported: number; skipped: number; errors: string[]; total: number }> {
        return apiFetch('/api/mail/contacts/import-csv', {
            method: 'POST',
            body: JSON.stringify({ csvContent }),
        })
    },

    // Notifications API
    getNotifications(params?: { page?: number; limit?: number }): Promise<{
        data: Array<{
            id: string
            userId: string
            type: string
            title: string
            message: string
            metadata: Record<string, unknown>
            read: boolean
            createdAt: string
        }>
        pagination: {
            page: number
            limit: number
            total: number
            totalPages: number
        }
    }> {
        const searchParams = new URLSearchParams()
        if (params?.page !== undefined) searchParams.set('page', String(params.page))
        if (params?.limit !== undefined) searchParams.set('limit', String(params.limit))
        const qs = searchParams.toString()
        return apiFetch(`/api/notifications${qs ? `?${qs}` : ''}`)
    },

    getUnreadCount(): Promise<{ unreadCount: number }> {
        return apiFetch('/api/notifications/unread-count')
    },

    markAsRead(id: string): Promise<{ success: boolean }> {
        return apiFetch(`/api/notifications/${id}/read`, {
            method: 'PUT',
        })
    },

    markAllAsRead(): Promise<{ success: boolean }> {
        return apiFetch('/api/notifications/read-all', {
            method: 'PUT',
        })
    },

    deleteNotification(id: string): Promise<{ success: boolean }> {
        return apiFetch(`/api/notifications/${id}`, {
            method: 'DELETE',
        })
    },
}
