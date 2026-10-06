import { describe, expect, it } from 'vitest'
import { SHORTCUTS, formatShortcut } from './keyboard-shortcuts'

describe('formatShortcut', () => {
    it('formats modifier combos and sequences', () => {
        expect(formatShortcut({ key: 'Enter', ctrl: true, description: '', category: 'compose' })).toBe('Ctrl + ENTER')
        expect(formatShortcut({ key: 'g', then: 'i', description: '', category: 'navigation' })).toBe('G then I')
        expect(formatShortcut({ key: '#', shift: true, description: '', category: 'actions' })).toBe('#')
    })

    it('does not advertise Shift+G/S/D chords that are not wired', () => {
        const chords = SHORTCUTS.filter(shortcut => shortcut.shift && ['g', 's', 'd'].includes(shortcut.key))
        expect(chords).toEqual([])
    })

    it('lists the go-to sequences that useGoToShortcuts handles', () => {
        const sequences = SHORTCUTS.filter(shortcut => shortcut.then).map(shortcut => shortcut.then)
        expect(sequences).toEqual(['i', 's', 'd', 'm'])
    })
})
