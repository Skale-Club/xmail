import { render, screen } from '@testing-library/react'
import { Button } from '@/components/ui/button'
import { describe, expect, it } from 'vitest'

describe('client test harness', () => {
    it('renders React components with jest-dom matchers', () => {
        render(<Button>Send safely</Button>)

        expect(screen.getByRole('button', { name: 'Send safely' })).toBeInTheDocument()
    })

    it('cleans up the DOM between tests', () => {
        expect(screen.queryByRole('button', { name: 'Send safely' })).not.toBeInTheDocument()
    })
})
