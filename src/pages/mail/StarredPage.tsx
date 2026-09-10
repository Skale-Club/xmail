import { FolderPage } from '../../components/mail/FolderPage'
import { Star } from 'lucide-react'

export default function StarredPage() {
    return (
        <FolderPage
            kind="starred"
            title="Starred"
            icon={<Star className="w-5 h-5 text-yellow-500 fill-current" />}
            emptyStateIcon={<Star className="w-16 h-16 text-yellow-500" />}
            emptyMessage="No starred emails"
            storageKey="starred"
        />
    )
}
