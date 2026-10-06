import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useGoToShortcuts, useKeyboardShortcuts } from './useKeyboardShortcuts'

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

describe('useKeyboardShortcuts', () => {
    afterEach(() => cleanup())

    it('deletes exactly once for "#" (with or without Shift)', () => {
        const onDelete = vi.fn()
        renderHook(() => useKeyboardShortcuts({ onDelete }))
        press('#', { shiftKey: true })
        expect(onDelete).toHaveBeenCalledTimes(1)
        press('#')
        expect(onDelete).toHaveBeenCalledTimes(2)
    })

    it('does not delete on Backspace', () => {
        const onDelete = vi.fn()
        renderHook(() => useKeyboardShortcuts({ onDelete }))
        press('Backspace')
        expect(onDelete).not.toHaveBeenCalled()
    })

    it('stars on "s" but not on Shift+S', () => {
        const onStar = vi.fn()
        renderHook(() => useKeyboardShortcuts({ onStar }))
        press('S', { shiftKey: true })
        expect(onStar).not.toHaveBeenCalled()
        press('s')
        expect(onStar).toHaveBeenCalledTimes(1)
    })

    it('"m" toggles read state through onToggleRead', () => {
        const onToggleRead = vi.fn()
        renderHook(() => useKeyboardShortcuts({ onToggleRead }))
        press('m')
        expect(onToggleRead).toHaveBeenCalledTimes(1)
    })

    it('ignores list shortcuts while typing or inside a dialog, and when disabled', () => {
        const onArchive = vi.fn()
        const { rerender } = renderHook(({ enabled }) => useKeyboardShortcuts({ enabled, onArchive }), {
            initialProps: { enabled: true },
        })

        const input = document.createElement('input')
        document.body.appendChild(input)
        press('e', {}, input)

        const dialog = document.createElement('div')
        dialog.setAttribute('role', 'dialog')
        const button = document.createElement('button')
        dialog.appendChild(button)
        document.body.appendChild(dialog)
        press('e', {}, button)

        expect(onArchive).not.toHaveBeenCalled()

        rerender({ enabled: false })
        press('e')
        expect(onArchive).not.toHaveBeenCalled()
    })

    it('keeps Ctrl+Enter and Ctrl+S working inside the compose editor', () => {
        const onSend = vi.fn()
        const onSaveDraft = vi.fn()
        renderHook(() => useKeyboardShortcuts({ onSend, onSaveDraft }))
        const textarea = document.createElement('textarea')
        document.body.appendChild(textarea)
        press('Enter', { ctrlKey: true }, textarea)
        press('s', { ctrlKey: true }, textarea)
        expect(onSend).toHaveBeenCalledTimes(1)
        expect(onSaveDraft).toHaveBeenCalledTimes(1)
    })
})

describe('useGoToShortcuts', () => {
    afterEach(() => cleanup())

    it('runs the action of the key pressed after "g"', () => {
        const goInbox = vi.fn()
        const goSent = vi.fn()
        renderHook(() => useGoToShortcuts({ actions: { i: goInbox, s: goSent } }))
        press('g')
        press('i')
        expect(goInbox).toHaveBeenCalledTimes(1)
        expect(goSent).not.toHaveBeenCalled()
    })

    it('needs "g" first and ignores unknown follow-up keys', () => {
        const goInbox = vi.fn()
        renderHook(() => useGoToShortcuts({ actions: { i: goInbox } }))
        press('i')
        press('g')
        press('x')
        press('i')
        expect(goInbox).not.toHaveBeenCalled()
    })
})
