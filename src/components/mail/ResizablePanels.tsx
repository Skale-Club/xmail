import React, { useState, useRef, useCallback } from 'react'

interface ResizablePanelsProps {
    left: React.ReactNode
    right: React.ReactNode
    defaultLeftPercent?: number
    minLeftPercent?: number
    maxLeftPercent?: number
    /** One shared key for every folder page, so the list width does not reset per folder. */
    storageKey?: string
    leftClassName?: string
    rightClassName?: string
}

const KEYBOARD_STEP = 2
const KEYBOARD_STEP_LARGE = 10

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
}

function readStoredPercent(storageKey: string | undefined, fallback: number, min: number, max: number): number {
    if (!storageKey) return fallback
    try {
        const stored = window.localStorage.getItem(storageKey)
        if (stored !== null) {
            const value = Number(stored)
            if (Number.isFinite(value)) return clamp(value, min, max)
        }
    } catch {
        // Storage unavailable: fall back to the default width.
    }
    return fallback
}

function storePercent(storageKey: string | undefined, value: number) {
    if (!storageKey) return
    try {
        window.localStorage.setItem(storageKey, String(value))
    } catch {
        // Not persisted; the width still works for this session.
    }
}

export function ResizablePanels({
    left,
    right,
    defaultLeftPercent = 40,
    minLeftPercent = 20,
    maxLeftPercent = 70,
    storageKey,
    leftClassName = 'flex flex-col bg-background',
    rightClassName = 'flex flex-col bg-muted/30',
}: ResizablePanelsProps) {
    const [leftPercent, setLeftPercent] = useState(() =>
        readStoredPercent(storageKey, defaultLeftPercent, minLeftPercent, maxLeftPercent))

    const containerRef = useRef<HTMLDivElement>(null)
    const isDragging = useRef(false)
    // Latest width while dragging, so it can be saved once when the drag ends.
    const latestPercent = useRef(leftPercent)
    latestPercent.current = leftPercent

    const updateFromClientX = useCallback((clientX: number) => {
        const container = containerRef.current
        if (!container) return
        const rect = container.getBoundingClientRect()
        if (rect.width === 0) return
        const pct = clamp(((clientX - rect.left) / rect.width) * 100, minLeftPercent, maxLeftPercent)
        latestPercent.current = pct
        setLeftPercent(pct)
    }, [minLeftPercent, maxLeftPercent])

    // Pointer events cover mouse, touch and pen with one code path; capturing the pointer
    // keeps the drag alive even when it leaves the thin divider.
    const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault()
        isDragging.current = true
        event.currentTarget.setPointerCapture?.(event.pointerId)
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
    }, [])

    const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (!isDragging.current) return
        updateFromClientX(event.clientX)
    }, [updateFromClientX])

    const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (!isDragging.current) return
        isDragging.current = false
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        storePercent(storageKey, latestPercent.current)
    }, [storageKey])

    const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP
        let next: number | null = null
        if (event.key === 'ArrowLeft') next = latestPercent.current - step
        else if (event.key === 'ArrowRight') next = latestPercent.current + step
        else if (event.key === 'Home') next = minLeftPercent
        else if (event.key === 'End') next = maxLeftPercent
        if (next === null) return

        event.preventDefault()
        const clamped = clamp(next, minLeftPercent, maxLeftPercent)
        latestPercent.current = clamped
        setLeftPercent(clamped)
        storePercent(storageKey, clamped)
    }, [minLeftPercent, maxLeftPercent, storageKey])

    return (
        <div ref={containerRef} className="flex h-full overflow-hidden">
            <div style={{ width: `${leftPercent}%` }} className={`overflow-hidden ${leftClassName}`}>
                {left}
            </div>

            {/* Draggable divider */}
            <div
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={handleKeyDown}
                className="relative z-10 w-px flex-shrink-0 cursor-col-resize bg-border group select-none touch-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize message list"
                aria-valuenow={Math.round(leftPercent)}
                aria-valuemin={minLeftPercent}
                aria-valuemax={maxLeftPercent}
                tabIndex={0}
            >
                {/* Wider invisible hit area (also the touch target) */}
                <div className="absolute inset-y-0 -left-2.5 -right-2.5" />
                {/* Highlight on hover/drag */}
                <div className="absolute inset-0 bg-primary/0 group-hover:bg-primary/40 group-focus-visible:bg-primary/40 transition-colors duration-150" />
            </div>

            <div style={{ width: `${100 - leftPercent}%` }} className={`overflow-hidden ${rightClassName}`}>
                {right}
            </div>
        </div>
    )
}
