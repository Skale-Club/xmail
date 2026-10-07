import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EmailList, type EmailItem } from './EmailList'

vi.mock('../../hooks/useCompose', () => ({ useCompose: () => ({ openCompose: vi.fn() }) }))

const email: EmailItem = {
    id: '1',
    subject: 'A very long subject line that cannot possibly fit in a narrow column of the list',
    snippet: 'snippet',
    from: { name: 'noreply-notifications-service', email: 'noreply@example.com' },
    to: [{ name: 'Me', email: 'me@example.com' }],
    date: new Date('2024-03-05T10:00:00Z'),
    read: false,
    starred: false,
    hasAttachments: true,
}

describe('EmailList row layout', () => {
    it('lets sender and subject truncate instead of using a fixed width', () => {
        render(<EmailList emails={[email]} onSelect={() => undefined} />)
        const sender = screen.getByText('noreply-notifications-service')
        const subject = screen.getByText(email.subject)
        for (const el of [sender, subject]) {
            expect(el).toHaveClass('min-w-0', 'flex-1', 'truncate')
            expect(el.className).not.toMatch(/(^|\s)w-(\d|\[)/)
        }
    })

    it('keeps the date from shrinking and on one line', () => {
        render(<EmailList emails={[email]} onSelect={() => undefined} />)
        const date = screen.getByText(/\d{2}\/\d{2}\/\d{2}|[A-Z][a-z]{2} \d{1,2}|\d{1,2}:\d{2} [AP]M|Yesterday/)
        expect(date).toHaveClass('shrink-0', 'whitespace-nowrap')
    })

    it('keeps the attachment marker from squeezing the subject', () => {
        render(<EmailList emails={[email]} onSelect={() => undefined} />)
        expect(screen.getByLabelText('Has attachments')).toHaveClass('shrink-0')
    })
})
