import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SidebarToggleButton } from './MailLayout'

describe('SidebarToggleButton', () => {
    it('opens a collapsed sidebar and exposes its state to assistive technology', () => {
        const onToggle = vi.fn()
        render(<SidebarToggleButton isCollapsed onToggle={onToggle} />)

        const button = screen.getByRole('button', { name: 'Expand sidebar' })
        expect(button).toHaveAttribute('aria-expanded', 'false')
        expect(button).toHaveAttribute('aria-controls', 'mail-sidebar-navigation')
        fireEvent.click(button)
        expect(onToggle).toHaveBeenCalledOnce()
    })

    it('collapses an open sidebar', () => {
        const onToggle = vi.fn()
        render(<SidebarToggleButton isCollapsed={false} onToggle={onToggle} />)

        const button = screen.getByRole('button', { name: 'Collapse sidebar' })
        expect(button).toHaveAttribute('aria-expanded', 'true')
        fireEvent.click(button)
        expect(onToggle).toHaveBeenCalledOnce()
    })
})
