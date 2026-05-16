import { useState, useRef, useEffect, memo } from 'react'
import { useBranding } from '../lib/branding'

interface AppLogoProps {
    className?: string
    alt?: string
}

const loadedLogoSources = new Set<string>()

export const AppLogo = memo(function AppLogo({ className = '', alt }: AppLogoProps) {
    const { branding } = useBranding()
    const src = branding.logoUrl
    const [loaded, setLoaded] = useState(() => loadedLogoSources.has(src))
    const prevSrc = useRef<string | null>(src)

    useEffect(() => {
        if (prevSrc.current !== src) {
            setLoaded(loadedLogoSources.has(src))
        }
        prevSrc.current = src
    }, [src])

    return (
        <img
            src={src}
            alt={alt || `${branding.applicationName} logo`}
            className={`${className} transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
            onLoad={() => {
                loadedLogoSources.add(src)
                setLoaded(true)
            }}
            onError={() => setLoaded(true)}
        />
    )
})
