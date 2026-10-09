import { useEffect, useState } from 'react'

function rootIsDark(): boolean {
    return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

/**
 * Whether the app is currently rendered dark. Reads the `dark` class ThemeProvider puts on
 * <html> (the resolved theme, so 'system' is already decided) and follows it when it changes.
 */
export function useIsDarkTheme(): boolean {
    const [isDark, setIsDark] = useState(rootIsDark)

    useEffect(() => {
        const root = document.documentElement
        const observer = new MutationObserver(() => setIsDark(rootIsDark()))
        observer.observe(root, { attributes: true, attributeFilter: ['class'] })
        setIsDark(rootIsDark())
        return () => observer.disconnect()
    }, [])

    return isDark
}
