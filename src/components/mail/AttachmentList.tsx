import { Download, Paperclip } from 'lucide-react'

export interface AttachmentListItem {
    filename: string
    size?: number
}

export function formatFileSize(bytes: number | undefined): string {
    if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface AttachmentListProps {
    attachments: AttachmentListItem[]
    onDownload: (index: number, filename: string) => void
    className?: string
}

/** Clickable attachment chips (name, size, download), shared by the reading pane and the mobile page. */
export function AttachmentList({ attachments, onDownload, className = '' }: AttachmentListProps) {
    if (attachments.length === 0) return null

    return (
        <div className={className}>
            <h3 className="text-sm font-medium text-foreground mb-3 flex items-center gap-2">
                <Paperclip className="w-4 h-4" />
                Attachments ({attachments.length})
            </h3>
            <div className="flex flex-wrap gap-2">
                {attachments.map((attachment, index) => (
                    <button
                        key={`${attachment.filename}-${index}`}
                        type="button"
                        onClick={() => onDownload(index, attachment.filename)}
                        title={`Download ${attachment.filename}`}
                        className="flex items-center gap-2 px-3 py-2 bg-muted rounded-lg hover:bg-muted/80 transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <Paperclip className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="min-w-0">
                            <span className="block max-w-[220px] truncate text-sm font-medium text-foreground">
                                {attachment.filename}
                            </span>
                            <span className="block text-xs text-muted-foreground">{formatFileSize(attachment.size)}</span>
                        </span>
                        <Download className="w-4 h-4 text-muted-foreground ml-2 shrink-0" aria-hidden="true" />
                    </button>
                ))}
            </div>
        </div>
    )
}
