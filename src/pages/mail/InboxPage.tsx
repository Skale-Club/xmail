import { FolderPage } from '../../components/mail/FolderPage'
import { Inbox as InboxIcon, AlertCircle } from 'lucide-react'

export default function InboxPage() {
    return (
        <FolderPage
            kind="inbox"
            title="Inbox"
            icon={<InboxIcon className="w-5 h-5 text-muted-foreground" />}
            emptyStateIcon={<AlertCircle className="w-16 h-16 text-yellow-500" />}
            emptyMessage="No emails in inbox"
            storageKey="inbox"
        />
    )
}
