import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, renderHook } from '@testing-library/react'
import { act } from 'react'
import { folderKindFromPath, useUnreadTitlePrefix } from './useUnreadTitle'
import { LiveIndicator } from '../components/mail/LiveIndicator'

beforeEach(() => {
    document.title = 'Xmail'
})
afterEach(() => {
    document.title = ''
})

describe('useUnreadTitlePrefix', () => {
    it('prefixes the branding title with the unread count and restores it at zero', () => {
        const { rerender } = renderHook(({ n }) => useUnreadTitlePrefix(n), { initialProps: { n: 3 } })
        expect(document.title).toBe('(3) Xmail')

        rerender({ n: 4 })
        expect(document.title).toBe('(4) Xmail')

        rerender({ n: 0 })
        expect(document.title).toBe('Xmail')
    })

    it('removes the prefix when the webmail unmounts', () => {
        const { unmount } = renderHook(() => useUnreadTitlePrefix(2))
        expect(document.title).toBe('(2) Xmail')
        unmount()
        expect(document.title).toBe('Xmail')
    })

    it('re-applies the prefix when the branding title is rewritten underneath it', async () => {
        const titleEl = document.createElement('title')
        document.head.appendChild(titleEl)
        document.title = 'Xmail'
        renderHook(() => useUnreadTitlePrefix(5))
        expect(document.title).toBe('(5) Xmail')

        await act(async () => {
            document.title = 'Skale Mail' // what BrandingHead does when branding loads
            await new Promise((resolve) => setTimeout(resolve, 0))
        })
        expect(document.title).toBe('(5) Skale Mail')
        titleEl.remove()
    })
})

describe('folderKindFromPath', () => {
    it('maps folder routes to their kind and everything else to the inbox', () => {
        expect(folderKindFromPath('/mail/inbox')).toBe('inbox')
        expect(folderKindFromPath('/mail/spam')).toBe('spam')
        expect(folderKindFromPath('/mail/archive/abc123')).toBe('archive')
        expect(folderKindFromPath('/mail/sent?x=1')).toBe('sent')
        expect(folderKindFromPath('/mail/starred')).toBe('inbox')
        expect(folderKindFromPath('/mail/settings')).toBe('inbox')
    })
})

describe('LiveIndicator', () => {
    it('says Live when connected and Reconnecting when not, with an explanatory title', () => {
        const live = render(<LiveIndicator status="live" />)
        expect(live.getAllByText('Live').length).toBeGreaterThan(0)
        expect(live.getByTestId('mailbox-live-indicator').getAttribute('title')).toMatch(/as soon as it arrives/)
        live.unmount()

        const offline = render(<LiveIndicator status="offline" />)
        expect(offline.getAllByText('Reconnecting…').length).toBeGreaterThan(0)
        expect(offline.getByTestId('mailbox-live-indicator').getAttribute('title')).toMatch(/every 30 seconds/)
    })
})
