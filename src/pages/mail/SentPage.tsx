import { FolderPage } from '../../components/mail/FolderPage'
import { Send, AlertCircle } from 'lucide-react'

export default function SentPage() {
    return (
        <FolderPage
            kind="sent"
            title="Sent"
            icon={<Send className="w-5 h-5 text-muted-foreground" />}
            emptyStateIcon={<AlertCircle className="w-16 h-16 text-yellow-500" />}
            emptyMessage="No sent emails"
            storageKey="sent"
        />
    )
}
