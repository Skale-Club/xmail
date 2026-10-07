import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'
import { isInsideDialog, isTypingTarget } from '../../hooks/useKeyboardShortcuts'

export interface PanelRenderContext {
    /** True when the panels are too narrow to sit side by side and the right one is a drawer. */
    overlay: boolean
    /** Closes the drawer (calls onCloseRight). Only meaningful in overlay mode. */
    close: () => void
}

interface ResizablePanelsProps {
    left: React.ReactNode
    right: React.ReactNode | ((context: PanelRenderContext) => React.ReactNode)
    defaultLeftPercent?: number
    minLeftPercent?: number
    maxLeftPercent?: number
    /** Pixel floors/ceiling applied on top of the percentages, given the container width. */
    minLeftPx?: number
    minRightPx?: number
    maxLeftPx?: number
    /** One shared key for every folder page, so the list width does not reset per folder. */
    storageKey?: string
    leftClassName?: string
    rightClassName?: string
    /** Overlay mode only: whether the drawer is open (an item is selected). Defaults to true. */
    hasRight?: boolean
    /** Overlay mode only: called when the drawer asks to close (Esc, or the render-prop `close`). */
    onCloseRight?: () => void
    /** Disable the Esc-closes-drawer behaviour (e.g. while a compose window owns the keyboard). */
    closeOnEscape?: boolean
}

const KEYBOARD_STEP = 2
const KEYBOARD_STEP_LARGE = 10

export const DEFAULT_MIN_LEFT_PX = 360
export const DEFAULT_MIN_RIGHT_PX = 420
export const DEFAULT_MAX_LEFT_PX = 480

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
}

/**
 * Percent bounds for the left panel once the pixel floors are applied. With an unknown
 * width (first paint, jsdom) only the percentages apply.
 */
export function resolvePercentBounds(
    width: number,
    minPercent: number,
    maxPercent: number,
    minLeftPx: number,
    minRightPx: number,
    maxLeftPx: number,
): { min: number; max: number } {
    if (!(width > 0)) return { min: minPercent, max: maxPercent }
    const min = Math.max(minPercent, (minLeftPx / width) * 100)
    const max = Math.min(maxPercent, (maxLeftPx / width) * 100, 100 - (minRightPx / width) * 100)
    // A cap below the floor (very wide container) must not invert the range: the floor wins.
    return { min, max: Math.max(min, max) }
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
    minLeftPx = DEFAULT_MIN_LEFT_PX,
    minRightPx = DEFAULT_MIN_RIGHT_PX,
    maxLeftPx = DEFAULT_MAX_LEFT_PX,
    storageKey,
    leftClassName = 'flex flex-col bg-background',
    rightClassName = 'flex flex-col bg-muted/30',
    hasRight = true,
    onCloseRight,
    closeOnEscape = true,
}: ResizablePanelsProps) {
    // The stored percent is the user's preference; the px floors are applied at render time so a
    // narrow window never rewrites it.
    const [leftPercent, setLeftPercent] = useState(() =>
        readStoredPercent(storageKey, defaultLeftPercent, minLeftPercent, maxLeftPercent))

    const containerRef = useRef<HTMLDivElement>(null)
    const isDragging = useRef(false)
    // Latest width while dragging, so it can be saved once when the drag ends.
    const latestPercent = useRef(leftPercent)
    latestPercent.current = leftPercent

    const [containerWidth, setContainerWidth] = useState(0)

    // Measure before paint so the first frame already has the right mode (no flash from
    // side-by-side to drawer), then follow resizes.
    useLayoutEffect(() => {
        const container = containerRef.current
        if (!container) return
        setContainerWidth(container.getBoundingClientRect().width)
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect?.width ?? container.getBoundingClientRect().width
            setContainerWidth(width)
        })
        observer.observe(container)
        return () => observer.disconnect()
    }, [])

    const overlay = containerWidth > 0 && containerWidth < minLeftPx + minRightPx
    const bounds = resolvePercentBounds(containerWidth, minLeftPercent, maxLeftPercent, minLeftPx, minRightPx, maxLeftPx)
    const effectivePercent = clamp(leftPercent, bounds.min, bounds.max)
    const boundsRef = useRef(bounds)
    boundsRef.current = bounds

    const updateFromClientX = useCallback((clientX: number) => {
        const container = containerRef.current
        if (!container) return
        const rect = container.getBoundingClientRect()
        if (rect.width === 0) return
        const { min, max } = boundsRef.current
        const pct = clamp(((clientX - rect.left) / rect.width) * 100, min, max)
        latestPercent.current = pct
        setLeftPercent(pct)
    }, [])

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
        const { min, max } = boundsRef.current
        const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP
        // Start from what is on screen, not from a stored value the px floors may be overriding.
        const current = clamp(latestPercent.current, min, max)
        let next: number | null = null
        if (event.key === 'ArrowLeft') next = current - step
        else if (event.key === 'ArrowRight') next = current + step
        else if (event.key === 'Home') next = min
        else if (event.key === 'End') next = max
        if (next === null) return

        event.preventDefault()
        const clamped = clamp(next, min, max)
        latestPercent.current = clamped
        setLeftPercent(clamped)
        storePercent(storageKey, clamped)
    }, [storageKey])

    const close = useCallback(() => onCloseRight?.(), [onCloseRight])

    // Esc closes the drawer, but never steals the key from a field, an open dialog/menu or a
    // handler that already used it.
    const drawerOpen = overlay && hasRight
    useEffect(() => {
        if (!drawerOpen || !closeOnEscape) return
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return
            if (isTypingTarget(event.target) || isInsideDialog(event.target)) return
            onCloseRight?.()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [drawerOpen, closeOnEscape, onCloseRight])

    // Drawer focus management. While the drawer covers the list, the list must be unreachable
    // (inert: no Tab, no screen-reader browsing of rows hidden behind it); focus moves into the
    // drawer (its Back button) and, when it closes, returns to the control that opened it.
    const drawerRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!drawerOpen) return
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const drawer = drawerRef.current
        const target = drawer?.querySelector<HTMLElement>('[data-drawer-back]') ?? drawer
        target?.focus({ preventScroll: true })
        return () => {
            if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true })
        }
    }, [drawerOpen])

    const rightNode = typeof right === 'function' ? right({ overlay, close }) : right

    // One tree for both modes, so crossing the threshold keeps the list mounted (scroll position,
    // loaded pages) instead of rebuilding it.
    return (
        <div
            ref={containerRef}
            className={`flex h-full overflow-hidden ${overlay ? 'relative' : ''}`}
            data-layout={overlay ? 'overlay' : 'split'}
        >
            <div
                style={overlay ? undefined : { width: `${effectivePercent}%` }}
                className={`overflow-hidden ${overlay ? 'w-full' : ''} ${leftClassName}`}
                {...(drawerOpen ? { inert: '' } : {})}
            >
                {left}
            </div>

            {/* Draggable divider (side-by-side mode only) */}
            {overlay ? null : (
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
                    aria-valuenow={Math.round(effectivePercent)}
                    aria-valuemin={Math.round(bounds.min)}
                    aria-valuemax={Math.round(bounds.max)}
                    tabIndex={0}
                >
                    {/* Wider invisible hit area (also the touch target) */}
                    <div className="absolute inset-y-0 -left-2.5 -right-2.5" />
                    {/* Highlight on hover/drag */}
                    <div className="absolute inset-0 bg-primary/0 group-hover:bg-primary/40 group-focus-visible:bg-primary/40 transition-colors duration-150" />
                </div>
            )}

            {overlay && !hasRight ? null : overlay ? (
                <div
                    ref={drawerRef}
                    role="region"
                    aria-label="Message"
                    tabIndex={-1}
                    className="absolute inset-0 z-20 flex flex-col overflow-hidden bg-background focus:outline-none animate-in slide-in-from-right duration-200 motion-reduce:animate-none"
                >
                    {rightNode}
                </div>
            ) : (
                <div style={{ width: `${100 - effectivePercent}%` }} className={`overflow-hidden ${rightClassName}`}>
                    {rightNode}
                </div>
            )}
        </div>
    )
}
