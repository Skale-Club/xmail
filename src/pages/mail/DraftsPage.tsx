import { FolderPage } from '../../components/mail/FolderPage'
import { FileText } from 'lucide-react'

export default function DraftsPage() {
    return (
        <FolderPage
            kind="drafts"
            title="Drafts"
            icon={<FileText className="w-5 h-5 text-muted-foreground" />}
            emptyMessage="No drafts"
            storageKey="drafts"
        />
    )
}
