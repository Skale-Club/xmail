import { describe, expect, it } from 'vitest'
import { recipientLabel, selectRange } from './email-list-utils'

describe('selectRange', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']

    it('selects everything between the anchor and the target, in either direction', () => {
        expect([...selectRange(ids, 'b', 'd', new Set())]).toEqual(['b', 'c', 'd'])
        expect([...selectRange(ids, 'd', 'b', new Set())]).toEqual(['b', 'c', 'd'])
    })

    it('keeps rows that were already selected', () => {
        expect([...selectRange(ids, 'b', 'c', new Set(['e']))].sort()).toEqual(['b', 'c', 'e'])
    })

    it('toggles the target when there is no anchor', () => {
        expect([...selectRange(ids, null, 'c', new Set())]).toEqual(['c'])
        expect([...selectRange(ids, null, 'c', new Set(['c']))]).toEqual([])
    })

    it('ignores a target that is not in the list', () => {
        expect([...selectRange(ids, 'a', 'zzz', new Set(['b']))]).toEqual(['b'])
    })
})

describe('recipientLabel', () => {
    it('shows the first recipient and how many more', () => {
        expect(recipientLabel([{ name: 'Ana', email: 'a@x.com' }])).toBe('Ana')
        expect(recipientLabel([{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }])).toBe('a@x.com +2')
        expect(recipientLabel([])).toBe('')
        expect(recipientLabel(undefined)).toBe('')
    })
})
