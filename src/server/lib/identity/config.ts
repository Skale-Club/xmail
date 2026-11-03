import { resolveDevelopmentServerAuth } from '../../../lib/development-auth'
import { resolveDatabaseTarget } from '../../../db/database-target'
import { ownedIdentityEnabled } from './owned-session'

export interface IdentityConfig {
    projectId: string; projectNumber: string; apiKey: string; authDomain: string; origin: string; secure: boolean
    sessionCookie: string; browserCookie: string; adcMode: string; adcFile?: string
}
type Env = Record<string, string | undefined>

export function resolveIdentityConfig(env: Env): IdentityConfig | null {
    if (!ownedIdentityEnabled(env)) return null
    const dev = env.NODE_ENV === 'development'
    const prefix = dev ? 'XMAIL_DEV_GOOGLE_AUTH_' : 'XMAIL_GOOGLE_AUTH_'
    const projectId = env[`${prefix}PROJECT_ID`]?.trim() || (!dev ? 'skaleclub' : '')
    const productionProject = env.XMAIL_GOOGLE_AUTH_PROJECT_ID?.trim() || 'skaleclub'
    const projectNumber = env[`${prefix}PROJECT_NUMBER`]?.trim() || ''
    const productionNumber = env.XMAIL_GOOGLE_AUTH_PROJECT_NUMBER?.trim() || '937861185231'
    const apiKey = env[`${prefix}WEB_API_KEY`]?.trim() || ''
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || !/^\d{6,20}$/.test(projectNumber) || !apiKey
        || (dev && (projectId === productionProject || projectId === 'skaleclub' || projectNumber === productionNumber || projectNumber === '937861185231'))) {
        throw new Error('An isolated Google identity configuration is required.')
    }
    if (dev) {
        resolveDatabaseTarget(env)
        resolveDevelopmentServerAuth(env)
        const productionRef = env.XMAIL_PRODUCTION_SUPABASE_PROJECT_REF
            || /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(env.SUPABASE_URL || '')?.[1]
        if (!productionRef || productionRef === env.XMAIL_DEV_SUPABASE_PROJECT_REF) {
            throw new Error('A distinct, declared Supabase development Auth project is required.')
        }
    }
    let origin: URL
    try { origin = new URL(env[`${prefix}ORIGIN`] || '') } catch { throw new Error('The identity origin is not configured.') }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/'
        || (origin.protocol !== 'https:' && !(dev && loopback && origin.protocol === 'http:'))) {
        throw new Error('The identity origin must be an exact secure web origin.')
    }
    return {
        projectId, projectNumber, apiKey, authDomain: `${projectId}.firebaseapp.com`, origin: origin.origin,
        secure: !dev || origin.protocol === 'https:',
        sessionCookie: dev ? 'xmail_identity_dev' : '__Host-xmail_identity',
        browserCookie: dev ? 'xmail_identity_browser_dev' : '__Host-xmail_identity_browser',
        adcMode: env[`${prefix}ADC_MODE`] || '', adcFile: env[`${prefix}ADC_FILE`],
    }
}

export function identityBrowserSources(env: Env) {
    try {
        const config = resolveIdentityConfig(env)
        return config ? {
            connect: ['https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com', 'https://www.googleapis.com', `https://${config.authDomain}`],
            script: ['https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/'],
            frame: [`https://${config.authDomain}`, 'https://www.google.com/recaptcha/', 'https://www.recaptcha.net/recaptcha/'],
        } : null
    } catch { return null }
}
