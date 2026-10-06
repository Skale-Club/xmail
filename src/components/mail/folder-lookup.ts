export interface FolderSummary {
    id: string
    name: string
    remoteId?: string
    type?: string
    count: number
    unread: number
}

/**
 * Finds the server folder behind a folder page ('inbox', 'sent', ...). Folders created by older
 * syncs may lack a `type`, so the remote id is accepted too (same rule the message list uses).
 */
export function findFolderByKind(folders: FolderSummary[] | undefined, kind: string): FolderSummary | undefined {
    if (!folders) return undefined
    return folders.find(folder => folder.type === kind)
        ?? folders.find(folder => folder.remoteId?.toLowerCase() === kind.toLowerCase())
}
