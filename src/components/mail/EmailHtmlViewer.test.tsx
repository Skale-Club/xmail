import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { EmailHtmlViewer } from './EmailHtmlViewer'
import { TrustedImageDomainsCard } from './TrustedImageDomainsCard'

const mocks = vi.hoisted(() => ({
    apiFetch: vi.fn(),
    trusted: [] as string[],
}))

vi.mock('../../lib/api-client', () => ({
    apiFetch: mocks.apiFetch,
}))

const IMAGE_URL = 'https://tracker.example/pixel.gif'
const HTML = `<p>Hello</p><img src="${IMAGE_URL}">`

function renderViewer(props: Partial<React.ComponentProps<typeof EmailHtmlViewer>> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return render(
        <QueryClientProvider client={client}>
            <EmailHtmlViewer html={HTML} expandable={false} {...props} />
        </QueryClientProvider>
    )
}

const iframeDoc = () => (screen.getByTitle('Email content') as HTMLIFrameElement).getAttribute('srcdoc') ?? ''
const postCalls = () => mocks.apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')

beforeEach(() => {
    window.localStorage.clear()
    mocks.trusted = []
    mocks.apiFetch.mockReset()
    mocks.apiFetch.mockImplementation(async (path: string, options?: { method?: string }) => {
        if (options?.method === 'POST') return { domains: [] }
        if (options?.method === 'DELETE') {
            mocks.trusted = mocks.trusted.filter(domain => !path.endsWith(`/${domain}`))
            return { success: true }
        }
        return { domains: mocks.trusted }
    })
})

describe('EmailHtmlViewer trusted image domains', () => {
    it('loads images automatically for a trusted sender domain, including subdomains', async () => {
        mocks.trusted = ['dataforseo.com']
        renderViewer({ senderEmail: 'hello@account.dataforseo.com' })

        await waitFor(() => expect(iframeDoc()).toContain(IMAGE_URL))
        expect(screen.queryByText(/have been blocked/)).toBeNull()
    })

    it('blocks images and offers both choices for an untrusted domain', async () => {
        renderViewer({ senderEmail: 'info@dataforseo.com' })

        expect(await screen.findByRole('button', { name: 'Always show images from dataforseo.com' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Show once' })).toBeTruthy()
        expect(iframeDoc()).not.toContain(IMAGE_URL)
    })

    it('"Always show" persists the registrable domain and shows the images', async () => {
        renderViewer({ senderEmail: 'hello@account.dataforseo.com' })

        fireEvent.click(await screen.findByRole('button', { name: 'Always show images from dataforseo.com' }))

        await waitFor(() => expect(iframeDoc()).toContain(IMAGE_URL))
        await waitFor(() => expect(postCalls()).toHaveLength(1))
        expect(postCalls()[0][0]).toBe('/api/mail/trusted-image-domains')
        expect(JSON.parse(postCalls()[0][1].body)).toEqual({ domain: 'dataforseo.com' })
    })

    it('"Show once" shows the images without saving anything', async () => {
        renderViewer({ senderEmail: 'info@dataforseo.com' })

        fireEvent.click(await screen.findByRole('button', { name: 'Show once' }))

        await waitFor(() => expect(iframeDoc()).toContain(IMAGE_URL))
        expect(postCalls()).toHaveLength(0)
    })

    it('keeps a plain "Show images" button when there is no sender address', async () => {
        renderViewer({ senderEmail: null })

        const button = await screen.findByRole('button', { name: 'Show images' })
        expect(screen.queryByRole('button', { name: /Always show/ })).toBeNull()
        fireEvent.click(button)

        await waitFor(() => expect(iframeDoc()).toContain(IMAGE_URL))
        expect(postCalls()).toHaveLength(0)
    })

    it('imports legacy per-sender localStorage choices once and clears them', async () => {
        window.localStorage.setItem('xmail:show-images:a@news.legacy.com', '1')
        window.localStorage.setItem('xmail:show-images:b@legacy.com', '1')
        window.localStorage.setItem('xmail:show-images:c@legacy.org', '1')
        window.localStorage.setItem('unrelated', 'keep')
        renderViewer({ senderEmail: 'x@other.com' })

        await waitFor(() => expect(postCalls()).toHaveLength(1))
        expect(JSON.parse(postCalls()[0][1].body).domains.sort()).toEqual(['legacy.com', 'legacy.org'])
        await waitFor(() => expect(window.localStorage.getItem('xmail:show-images:a@news.legacy.com')).toBeNull())
        expect(window.localStorage.getItem('xmail:show-images:b@legacy.com')).toBeNull()
        expect(window.localStorage.getItem('unrelated')).toBe('keep')
    })
})

describe('TrustedImageDomainsCard', () => {
    function renderCard() {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        return render(
            <QueryClientProvider client={client}>
                <TrustedImageDomainsCard />
            </QueryClientProvider>
        )
    }

    it('shows the empty state', async () => {
        renderCard()
        expect(await screen.findByText(/No trusted domains yet/)).toBeTruthy()
    })

    it('lists domains and removes one', async () => {
        mocks.trusted = ['a.com', 'b.com']
        renderCard()

        fireEvent.click(await screen.findByRole('button', { name: 'Remove a.com' }))

        await waitFor(() => {
            const deletes = mocks.apiFetch.mock.calls.filter(([, options]) => options?.method === 'DELETE')
            expect(deletes).toHaveLength(1)
            expect(deletes[0][0]).toBe('/api/mail/trusted-image-domains/a.com')
        })
        await waitFor(() => expect(screen.queryByText('a.com')).toBeNull())
        expect(screen.getByText('b.com')).toBeTruthy()
    })
})
