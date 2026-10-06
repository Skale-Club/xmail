import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './api-client'

export interface BrandingSettings {
    companyName: string
    applicationName: string
    logoUrl: string
    faviconUrl: string
    mailHost: string
}

// The built-in identity must always ship with the application. Custom branding can
// still live in R2, but a missing bucket/object must never make the login screen,
// sidebar, favicon, or installed PWA lose its icon.
const defaultLogoUrl = '/brand-mark.svg'
const defaultFaviconUrl = '/favicon.svg'

export const defaultBranding: BrandingSettings = {
    companyName: '',
    applicationName: 'Xmail',
    logoUrl: defaultLogoUrl,
    faviconUrl: defaultFaviconUrl,
    mailHost: 'mx.skaleclub.com',
}

function normalizeBranding(payload: Partial<BrandingSettings> | null | undefined): BrandingSettings {
    const logoUrl = payload?.logoUrl || defaultBranding.logoUrl
    return {
        companyName: payload?.companyName || defaultBranding.companyName,
        applicationName: payload?.applicationName || defaultBranding.applicationName,
        logoUrl,
        faviconUrl: payload?.faviconUrl || logoUrl,
        mailHost: payload?.mailHost || defaultBranding.mailHost,
    }
}

export async function fetchBranding(): Promise<BrandingSettings> {
    const payload = await apiFetch<Partial<BrandingSettings>>('/api/system/branding', { auth: false })
    return normalizeBranding(payload)
}

export function useBranding() {
    const query = useQuery({
        queryKey: ['system-branding'],
        queryFn: fetchBranding,
        staleTime: 5 * 60 * 1000,
    })

    return {
        ...query,
        branding: query.data || defaultBranding,
    }
}
