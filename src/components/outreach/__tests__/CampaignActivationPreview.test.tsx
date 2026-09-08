import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CampaignActivationPreviewCard, type CampaignActivationPreview } from '../CampaignActivationPreview'

function preview(overrides: Partial<CampaignActivationPreview> = {}): CampaignActivationPreview {
    return {
        campaign: { id: 'campaign-1', name: 'Pilot campaign', status: 'draft' },
        sendingInboxes: [{ email: 'info@tryskaleclub.com', dailySendLimit: 50, currentDailySent: 3 }],
        sequence: [{
            stepOrder: 1,
            delayHours: 0,
            abTestEnabled: false,
            variantA: { subject: 'Hi Jane', bodyPlain: 'Hello Jane, unsubscribe: https://x/o/u/tok', bodyHtml: null },
            variantB: null,
        }],
        sampleLead: { id: 'lead-1', email: 'jane@acme.com' },
        leadCounts: { total: 10, verified: 6, catchAll: 2, unknown: 2 },
        compliance: { hasPhysicalAddress: true, unsubscribePresentInEveryStep: true, blockers: [] },
        ...overrides,
    }
}

describe('CampaignActivationPreviewCard', () => {
    it('shows a loading state while the preview query is pending', () => {
        render(<CampaignActivationPreviewCard preview={undefined} />)
        expect(screen.getByText('Loading campaign preview…')).toBeInTheDocument()
    })

    it('shows an explicit failure state rather than hiding a failed preview', () => {
        render(<CampaignActivationPreviewCard preview={null} />)
        expect(screen.getByRole('alert')).toHaveTextContent('Could not load the campaign preview. Do not approve without seeing what will be sent.')
    })

    it('renders campaign identity, sending inbox usage, and lead verification split', () => {
        const { container } = render(<CampaignActivationPreviewCard preview={preview()} />)

        expect(screen.getByText('Pilot campaign')).toBeInTheDocument()
        expect(container.textContent).toContain('campaign-1')
        expect(container.textContent).toContain('status: draft')
        expect(container.textContent).toContain('info@tryskaleclub.com')
        expect(container.textContent).toContain('3/50 sent today')
        expect(container.textContent).toContain('10')
        expect(container.textContent).toContain('6 verified')
        expect(container.textContent).toContain('2 catch-all')
        expect(container.textContent).toContain('2 unknown')
    })

    it('renders the sequence with the real enrolled lead noted', () => {
        const { container } = render(<CampaignActivationPreviewCard preview={preview()} />)

        expect(container.textContent).toContain('jane@acme.com')
        expect(screen.getByText('Hi Jane')).toBeInTheDocument()
        expect(container.textContent).toContain('Hello Jane, unsubscribe')
    })

    it('labels A/B variants when the step has A/B testing enabled', () => {
        render(<CampaignActivationPreviewCard preview={preview({
            sequence: [{
                stepOrder: 1,
                delayHours: 0,
                abTestEnabled: true,
                variantA: { subject: 'Subject A', bodyPlain: 'Body A', bodyHtml: null },
                variantB: { subject: 'Subject B', bodyPlain: 'Body B', bodyHtml: null },
            }],
        })} />)

        expect(screen.getByText('Variant A')).toBeInTheDocument()
        expect(screen.getByText('Variant B')).toBeInTheDocument()
        expect(screen.getByText('Subject A')).toBeInTheDocument()
        expect(screen.getByText('Subject B')).toBeInTheDocument()
    })

    it('shows a green compliance state when there are no blockers', () => {
        const { container } = render(<CampaignActivationPreviewCard preview={preview()} />)
        expect(container.textContent).toContain('Postal address and unsubscribe link present in every step.')
        expect(screen.queryByText('Compliance blocker')).not.toBeInTheDocument()
    })

    it('surfaces the missing-postal-address blocker instead of hiding or weakening it', () => {
        const { container } = render(<CampaignActivationPreviewCard preview={preview({
            compliance: {
                hasPhysicalAddress: false,
                unsubscribePresentInEveryStep: true,
                blockers: [{
                    code: 'missing_physical_address',
                    message: 'No step in this sequence includes a physical postal address (CAN-SPAM requirement).',
                }],
            },
        })} />)

        expect(screen.getByText('Compliance blocker')).toBeInTheDocument()
        expect(container.textContent).toContain('physical postal address')
    })

    it('shows a raw-template notice when no lead is enrolled yet', () => {
        const { container } = render(<CampaignActivationPreviewCard preview={preview({ sampleLead: null })} />)
        expect(container.textContent).toContain('no lead enrolled yet')
    })
})
