import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { SIDEBAR_COLLAPSED_STORAGE_KEY, useSidebarCollapsed } from './sidebar-collapse'

function stubViewport(width: number) {
    vi.stubGlobal('matchMedia', (query: string) => {
        const min = /min-width:\s*(\d+)px/.exec(query)
        const matches = min ? width >= Number(min[1]) : false
        return {
            matches,
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        }
    })
}

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('useSidebarCollapsed', () => {
    it('starts collapsed below xl when nothing is saved, on the very first render', () => {
        stubViewport(1100)
        const { result } = renderHook(() => useSidebarCollapsed())
        expect(result.current[0]).toBe(true)
    })

    it('starts open from xl up when nothing is saved', () => {
        stubViewport(1280)
        const { result } = renderHook(() => useSidebarCollapsed())
        expect(result.current[0]).toBe(false)
    })

    it('respects a saved "open" even on a narrow screen', () => {
        stubViewport(1100)
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '0')
        const { result } = renderHook(() => useSidebarCollapsed())
        expect(result.current[0]).toBe(false)
    })

    it('respects a saved "collapsed" even on a wide screen', () => {
        stubViewport(1920)
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '1')
        const { result } = renderHook(() => useSidebarCollapsed())
        expect(result.current[0]).toBe(true)
    })

    it('saves the user choice, which then wins over the viewport', () => {
        stubViewport(1100)
        const { result } = renderHook(() => useSidebarCollapsed())
        act(() => result.current[1](false))
        expect(result.current[0]).toBe(false)
        expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('0')
    })

    it('still works when storage throws', () => {
        stubViewport(1100)
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked')
        })
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked')
        })
        const { result } = renderHook(() => useSidebarCollapsed())
        expect(result.current[0]).toBe(true)
        act(() => result.current[1](false))
        expect(result.current[0]).toBe(false)
    })
})
