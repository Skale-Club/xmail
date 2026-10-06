/**
 * Adds every id between `anchorId` and `targetId` (inclusive, in list order) to the selection.
 * Without a usable anchor it falls back to toggling `targetId` alone.
 */
export function selectRange(
    orderedIds: string[],
    anchorId: string | null,
    targetId: string,
    current: ReadonlySet<string>,
): Set<string> {
    const targetIndex = orderedIds.indexOf(targetId)
    const anchorIndex = anchorId ? orderedIds.indexOf(anchorId) : -1
    const next = new Set(current)

    if (targetIndex < 0) return next
    if (anchorIndex < 0) {
        if (next.has(targetId)) next.delete(targetId)
        else next.add(targetId)
        return next
    }

    const [from, to] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex]
    for (let index = from; index <= to; index += 1) next.add(orderedIds[index])
    return next
}

export interface ListRecipient {
    name?: string | null
    email?: string | null
}

/** "Name" for one recipient, "Name +2" for several; empty when there is none. */
export function recipientLabel(recipients: ListRecipient[] | undefined): string {
    const list = (recipients ?? []).filter(recipient => recipient.name || recipient.email)
    if (list.length === 0) return ''
    const first = list[0].name || list[0].email || ''
    return list.length > 1 ? `${first} +${list.length - 1}` : first
}
