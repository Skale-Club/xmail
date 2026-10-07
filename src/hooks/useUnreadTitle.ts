import React from 'react'

const COUNT_PREFIX = /^\(\d+\)\s/

/** The folder a /mail/* path belongs to; pages that are not a folder (starred, settings...) report the Inbox. */
export function folderKindFromPath(pathname: string): string {
    const segment = pathname.split('?')[0].split('/').filter(Boolean)[1]
    switch (segment) {
        case 'sent':
        case 'drafts':
        case 'spam':
        case 'trash':
        case 'archive':
            return segment
        default:
            return 'inbox'
    }
}

/**
 * Gmail-style tab title: "(3) Xmail" while the open folder has unread mail, the plain branding
 * title otherwise. The branding title is owned elsewhere (BrandingHead rewrites document.title
 * whenever branding loads), so the prefix is applied on top of whatever the title currently is,
 * re-applied if someone rewrites the title, and removed again on unmount (leaving the webmail).
 */
export function useUnreadTitlePrefix(unreadCount: number): void {
    React.useEffect(() => {
        const expected = (title: string) => {
            const base = title.replace(COUNT_PREFIX, '')
            return unreadCount > 0 ? `(${unreadCount}) ${base}` : base
        }
        const apply = () => {
            const next = expected(document.title)
            if (document.title !== next) document.title = next
        }
        apply()

        // A title rewrite (branding loading late) must not silently drop the prefix. Setting the
        // title to its own expected value is a no-op, so this cannot loop.
        const titleEl = document.querySelector('title')
        const observer = typeof MutationObserver !== 'undefined' && titleEl
            ? new MutationObserver(apply)
            : null
        observer?.observe(titleEl as Node, { childList: true, characterData: true, subtree: true })

        return () => {
            observer?.disconnect()
            document.title = document.title.replace(COUNT_PREFIX, '')
        }
    }, [unreadCount])
}
