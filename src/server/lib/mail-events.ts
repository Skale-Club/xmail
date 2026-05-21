import { EventEmitter } from 'events'

export type MailEventPayload = {
    folderId: string
    mailboxId: string
    kind: 'new' | 'flags' | 'expunge'
}

class MailEventBus extends EventEmitter {}

export const mailEvents = new MailEventBus()
mailEvents.setMaxListeners(0)

export function emitFolderChange(payload: MailEventPayload) {
    mailEvents.emit('folder-change', payload)
}
