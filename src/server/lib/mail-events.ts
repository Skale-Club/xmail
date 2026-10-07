import { EventEmitter } from 'events'
import { publishMailboxEvent } from './mailbox-events'

export type MailEventPayload = {
    folderId: string
    mailboxId: string
    kind: 'new' | 'flags' | 'expunge'
}

class MailEventBus extends EventEmitter {}

export const mailEvents = new MailEventBus()
mailEvents.setMaxListeners(0)

/**
 * Every place that finishes a mail write calls this (MX/SMTP arrival, IMAP APPEND/STORE/EXPUNGE,
 * folder moves, permanent deletes) — always after the write committed. It feeds the IMAP IDLE
 * listeners AND the webmail's SSE push (mailbox-events.ts), so a new message reaches an open
 * browser tab as fast as it reaches Thunderbird. The push is best-effort and never throws.
 */
export function emitFolderChange(payload: MailEventPayload) {
    // Publish first: it never throws, so a faulty IDLE listener cannot swallow the browser push.
    publishMailboxEvent({
        mailboxId: payload.mailboxId,
        folderId: payload.folderId,
        kind: payload.kind === 'new' ? 'message.new' : 'message.updated',
    })
    mailEvents.emit('folder-change', payload)
}
