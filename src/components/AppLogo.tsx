import { useState, useRef, useEffect, memo } from 'react'
import { useBranding } from '../lib/branding'

interface AppLogoProps {
    className?: string
    alt?: string
}

const loadedLogoSources = new Set<string>()
const FALLBACK_LOGO_SOURCE = '/brand-mark.png'

export const AppLogo = memo(function AppLogo({ className = '', alt }: AppLogoProps) {
    const { branding } = useBranding()
    const src = branding.logoUrl
    const [displayedSrc, setDisplayedSrc] = useState(src)
    const [loaded, setLoaded] = useState(() => loadedLogoSources.has(src))
    const prevSrc = useRef<string | null>(src)

    useEffect(() => {
        if (prevSrc.current !== src) {
            setDisplayedSrc(src)
            setLoaded(loadedLogoSources.has(src))
        }
        prevSrc.current = src
    }, [src])

    return (
        <img
            src={displayedSrc}
            alt={alt || `${branding.applicationName} logo`}
            className={`${className} transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
            onLoad={() => {
                loadedLogoSources.add(displayedSrc)
                setLoaded(true)
            }}
            onError={() => {
                if (displayedSrc !== FALLBACK_LOGO_SOURCE) {
                    setDisplayedSrc(FALLBACK_LOGO_SOURCE)
                    setLoaded(loadedLogoSources.has(FALLBACK_LOGO_SOURCE))
                    return
                }
                setLoaded(true)
            }}
        />
    )
})
