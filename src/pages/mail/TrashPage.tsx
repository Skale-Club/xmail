import { FolderPage } from '../../components/mail/FolderPage'
import { Trash2 } from 'lucide-react'

export default function TrashPage() {
    return (
        <FolderPage
            kind="trash"
            title="Trash"
            icon={<Trash2 className="w-5 h-5 text-muted-foreground" />}
            emptyMessage="No items in trash"
            storageKey="trash"
        />
    )
}
