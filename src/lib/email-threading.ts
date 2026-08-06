import { EmailItem } from '../components/mail/EmailList'

export interface EmailThread {
    threadId: string
    subject: string
    messages: ThreadMessage[]
    participants: { name: string; email: string }[]
    lastMessageAt: Date
    unreadCount: number
    starred: boolean
    hasAttachments: boolean
}

export interface ThreadMessage {
    id: string
    from: { name: string; email: string }
    to: { name: string; email: string }[]
    cc?: { name: string; email: string }[]
    date: Date
    subject: string
    body: string
    htmlBody?: string
    snippet: string
    read: boolean
    starred: boolean
    attachments?: { name: string; size: string; type: string }[]
    inReplyTo?: string
    messageId: string
    // Raw inbound headers (when available) — used to derive the sender-authentication
    // (SPF/DKIM/DMARC) indicator. See src/lib/mail-auth-status.ts.
    headers?: Record<string, string>
}

export function groupEmailsIntoThreads(emails: EmailItem[]): Map<string, EmailItem[]> {
    const threads = new Map<string, EmailItem[]>()
    
    for (const email of emails) {
        const threadKey = extractThreadKey(email.subject)
        
        if (!threads.has(threadKey)) {
            threads.set(threadKey, [])
        }
        threads.get(threadKey)!.push(email)
    }
    
    for (const [, messages] of threads) {
        messages.sort((a, b) => a.date.getTime() - b.date.getTime())
    }
    
    return threads
}

function extractThreadKey(subject: string): string {
    const key = subject
        .toLowerCase()
        .replace(/^re:\s*/i, '')
        .replace(/^fwd:\s*/i, '')
        .replace(/^fw:\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
    
    return key
}

export function isThread(emails: EmailItem[]): boolean {
    return emails.length > 1
}

export function getThreadParticipants(messages: ThreadMessage[]): { name: string; email: string }[] {
    const participants = new Map<string, { name: string; email: string }>()
    
    for (const msg of messages) {
        if (!participants.has(msg.from.email)) {
            participants.set(msg.from.email, msg.from)
        }
        for (const to of msg.to) {
            if (!participants.has(to.email)) {
                participants.set(to.email, to)
            }
        }
        if (msg.cc) {
            for (const cc of msg.cc) {
                if (!participants.has(cc.email)) {
                    participants.set(cc.email, cc)
                }
            }
        }
    }
    
    return Array.from(participants.values())
}

export function formatThreadDate(date: Date): string {
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    
    if (days === 0) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    } else if (days === 1) {
        return 'Yesterday'
    } else if (days < 7) {
        return date.toLocaleDateString([], { weekday: 'short' })
    } else {
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    }
}

export function convertEmailItemToThreadMessage(email: EmailItem, body?: string): ThreadMessage {
    return {
        id: email.id,
        from: email.from,
        to: email.to,
        date: email.date,
        subject: email.subject,
        body: body || email.snippet,
        snippet: email.snippet,
        read: email.read,
        starred: email.starred,
        messageId: email.id
    }
}

export function buildThreadFromEmails(emails: EmailItem[]): EmailThread {
    const messages = emails.map(e => convertEmailItemToThreadMessage(e))
    const participants = getThreadParticipants(messages)
    const unreadCount = messages.filter(m => !m.read).length
    const starred = messages.some(m => m.starred)
    const hasAttachments = emails.some(e => e.hasAttachments)
    
    return {
        threadId: emails[0].id,
        subject: emails[0].subject.replace(/^(Re:|Fwd:|Fw:)\s*/i, ''),
        messages,
        participants,
        lastMessageAt: messages[messages.length - 1].date,
        unreadCount,
        starred,
        hasAttachments
    }
}
