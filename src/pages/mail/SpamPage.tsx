import { FolderPage } from '../../components/mail/FolderPage'
import { ShieldAlert } from 'lucide-react'

export default function SpamPage() {
    return (
        <FolderPage
            kind="spam"
            title="Spam"
            icon={<ShieldAlert className="w-5 h-5 text-amber-500" />}
            emptyStateIcon={<ShieldAlert className="w-16 h-16 text-amber-500" />}
            emptyMessage="No spam messages"
            storageKey="spam"
        />
    )
}
