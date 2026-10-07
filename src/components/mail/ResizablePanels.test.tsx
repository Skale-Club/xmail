import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ResizablePanels, resolvePercentBounds } from './ResizablePanels'
import { DetailBackBar } from './DetailBackBar'

let width = 1200
let observers: Array<{ cb: ResizeObserverCallback }> = []

class FakeResizeObserver {
    cb: ResizeObserverCallback
    constructor(cb: ResizeObserverCallback) {
        this.cb = cb
        observers.push(this)
    }
    observe() {}
    unobserve() {}
    disconnect() {
        observers = observers.filter((o) => o !== this)
    }
}

function resizeTo(next: number) {
    width = next
    act(() => {
        for (const o of observers) {
            o.cb([{ contentRect: { width: next } } as ResizeObserverEntry], o as unknown as ResizeObserver)
        }
    })
}

beforeEach(() => {
    width = 1200
    observers = []
    window.localStorage.clear()
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    // Only the panels container (tagged with data-layout) has a measurable width in jsdom.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const w = this.hasAttribute('data-layout') ? width : 0
        return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: 0, width: w, height: 0, toJSON: () => ({}) } as DOMRect
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

function percentOf(testId: string): number {
    const el = screen.getByTestId(testId).parentElement as HTMLElement
    return parseFloat(el.style.width)
}

describe('resolvePercentBounds', () => {
    it('keeps only the percentages when the width is unknown', () => {
        expect(resolvePercentBounds(0, 20, 70, 360, 420, 480)).toEqual({ min: 20, max: 70 })
    })

    it('raises the minimum so the list keeps 360px and lowers the maximum so the reader keeps 420px', () => {
        const { min, max } = resolvePercentBounds(900, 20, 70, 360, 420, 480)
        expect(min).toBeCloseTo(40)
        expect(max).toBeCloseTo((480 / 900) * 100)
        expect(900 * (1 - max / 100)).toBeGreaterThanOrEqual(420)
    })

    it('never inverts the range on a very wide container', () => {
        const { min, max } = resolvePercentBounds(3000, 20, 70, 360, 420, 480)
        expect(max).toBeGreaterThanOrEqual(min)
    })
})

describe('ResizablePanels', () => {
    it('clamps a stored percentage to the pixel floor of the list', () => {
        window.localStorage.setItem('k', '20')
        width = 1000
        render(<ResizablePanels storageKey="k" left={<div data-testid="l" />} right={<div />} />)
        // 20% of 1000px would be 200px; the list must keep 360px.
        expect(percentOf('l')).toBeCloseTo(36)
    })

    it('clamps a stored percentage to the reader floor and the list cap', () => {
        window.localStorage.setItem('k', '70')
        width = 1000
        render(<ResizablePanels storageKey="k" left={<div data-testid="l" />} right={<div />} />)
        // 70% would be a 700px list and a 300px reader; the list is capped at 480px.
        expect(percentOf('l')).toBeCloseTo(48)
    })

    it('re-clamps when the container is resized and leaves the stored preference alone', () => {
        window.localStorage.setItem('k', '30')
        width = 1600
        render(<ResizablePanels storageKey="k" left={<div data-testid="l" />} right={<div />} />)
        expect(percentOf('l')).toBeCloseTo(30)
        resizeTo(1000)
        expect(percentOf('l')).toBeCloseTo(36)
        expect(window.localStorage.getItem('k')).toBe('30')
    })

    it('clamps keyboard resizing to the pixel bounds', () => {
        width = 1000
        render(<ResizablePanels storageKey="k" left={<div data-testid="l" />} right={<div />} />)
        const separator = screen.getByRole('separator')
        fireEvent.keyDown(separator, { key: 'Home' })
        expect(percentOf('l')).toBeCloseTo(36)
        fireEvent.keyDown(separator, { key: 'End' })
        expect(percentOf('l')).toBeCloseTo(48)
        expect(separator).toHaveAttribute('aria-valuemin', '36')
        expect(separator).toHaveAttribute('aria-valuemax', '48')
    })

    it('does not write storage while dragging, only when the drag ends', () => {
        width = 1000
        render(<ResizablePanels storageKey="k" left={<div data-testid="l" />} right={<div />} />)
        const separator = screen.getByRole('separator')
        fireEvent.pointerDown(separator, { pointerId: 1 })
        // jsdom has no PointerEvent: a MouseEvent with the pointer type carries clientX the same way.
        fireEvent(separator, new MouseEvent('pointermove', { bubbles: true, clientX: 100 }))
        expect(window.localStorage.getItem('k')).toBeNull()
        expect(percentOf('l')).toBeCloseTo(36)
        fireEvent.pointerUp(separator, { pointerId: 1 })
        expect(Number(window.localStorage.getItem('k'))).toBeCloseTo(36)
    })

    it('stays side by side at 780px and switches to overlay below it', () => {
        width = 780
        const { container } = render(<ResizablePanels left={<div />} right={<div data-testid="r" />} />)
        expect(container.firstElementChild).toHaveAttribute('data-layout', 'split')
        expect(screen.getByRole('separator')).toBeInTheDocument()

        resizeTo(779)
        expect(container.firstElementChild).toHaveAttribute('data-layout', 'overlay')
        expect(screen.queryByRole('separator')).toBeNull()
    })

    it('in overlay mode shows the list alone until an item is open, then the drawer', () => {
        width = 700
        const { rerender } = render(
            <ResizablePanels left={<div data-testid="l" />} right={<div data-testid="r" />} hasRight={false} />,
        )
        expect(screen.getByTestId('l')).toBeInTheDocument()
        expect(screen.queryByTestId('r')).toBeNull()

        rerender(<ResizablePanels left={<div data-testid="l" />} right={<div data-testid="r" />} hasRight />)
        expect(screen.getByTestId('r')).toBeInTheDocument()
        expect(screen.getByRole('region', { name: 'Message' })).toBeInTheDocument()
    })

    it('keeps the list mounted when crossing the overlay threshold', () => {
        width = 1000
        render(<ResizablePanels left={<div data-testid="l" />} right={<div />} />)
        const before = screen.getByTestId('l')
        resizeTo(600)
        expect(screen.getByTestId('l')).toBe(before)
    })
})

// Same wiring FolderPage uses: Back bar in the drawer header, selection cleared on close.
function Harness({ escapeEnabled = true }: { escapeEnabled?: boolean }) {
    const [selected, setSelected] = React.useState<string | null>('a')
    return (
        <ResizablePanels
            left={<input aria-label="search" />}
            hasRight={!!selected}
            onCloseRight={() => setSelected(null)}
            closeOnEscape={escapeEnabled}
            right={({ overlay, close }) => (
                <>
                    {overlay && <DetailBackBar label="Inbox" onBack={close} />}
                    <div data-testid="detail">{selected}</div>
                </>
            )}
        />
    )
}

describe('overlay Back and Esc', () => {
    it('shows Back only in overlay mode and Back closes the drawer', () => {
        width = 1200
        render(<Harness />)
        expect(screen.queryByRole('button', { name: 'Back to Inbox' })).toBeNull()

        resizeTo(700)
        fireEvent.click(screen.getByRole('button', { name: 'Back to Inbox' }))
        expect(screen.queryByTestId('detail')).toBeNull()
    })

    it('Esc closes the drawer', () => {
        width = 700
        render(<Harness />)
        expect(screen.getByTestId('detail')).toBeInTheDocument()
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.queryByTestId('detail')).toBeNull()
    })

    it('Esc inside a field, or with closeOnEscape off, leaves the drawer open', () => {
        width = 700
        const { unmount } = render(<Harness />)
        fireEvent.keyDown(screen.getByLabelText('search'), { key: 'Escape' })
        expect(screen.getByTestId('detail')).toBeInTheDocument()
        unmount()

        render(<Harness escapeEnabled={false} />)
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.getByTestId('detail')).toBeInTheDocument()
    })

    it('Esc does nothing in side-by-side mode', () => {
        width = 1200
        render(<Harness />)
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(screen.getByTestId('detail')).toBeInTheDocument()
    })
})
