import { FolderPage } from '../../components/mail/FolderPage'
import { Archive as ArchiveIcon } from 'lucide-react'

export default function ArchivePage() {
    return (
        <FolderPage
            kind="archive"
            title="Archive"
            icon={<ArchiveIcon className="w-5 h-5 text-muted-foreground" />}
            emptyMessage="No archived messages"
            storageKey="archive"
        />
    )
}
