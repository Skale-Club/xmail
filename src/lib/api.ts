/**
 * @deprecated Use `src/lib/api-client.ts` instead. This client signs the user out
 * globally on ANY 401 (see handleUnauthorized() below), whereas api-client.ts
 * retries once with a refreshed Supabase session before giving up — the mail,
 * outreach and admin areas have all migrated to it. As of 2026-09, nothing in
 * the app imports this module anymore (grep `from '.*lib/api'` outside this
 * file and its own tests to confirm before deleting it); it is kept only so a
 * stray import doesn't hard-fail while the migration is verified.
 */
import { supabase } from './supabase'

export class ApiError extends Error {
    status: number
    code?: string
    details?: unknown

    constructor(message: string, status: number, code?: string, details?: unknown) {
        super(message)
        this.name = 'ApiError'
        this.status = status
        this.code = code
        this.details = details
    }
}

const REQUEST_TIMEOUT_MS = 30_000

async function getAccessToken(): Promise<string> {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
        throw new ApiError('Not authenticated', 401, 'NOT_AUTHENTICATED')
    }
    return session.access_token
}

function handleUnauthorized() {
    supabase.auth.signOut().catch(() => {})
    window.location.href = '/login'
}

interface ApiFetchOptions extends RequestInit {
    timeout?: number
}

export async function apiFetch<T = unknown>(path: string, init: ApiFetchOptions = {}): Promise<T> {
    const token = await getAccessToken()
    const { timeout = REQUEST_TIMEOUT_MS, ...fetchInit } = init

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
        const isFormData = fetchInit.body instanceof FormData
        const headers: Record<string, string> = {
            Authorization: `Bearer ${token}`,
            ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
            ...(fetchInit.headers as Record<string, string> || {}),
        }

        const response = await fetch(path, {
            cache: 'no-store',
            ...fetchInit,
            headers,
            signal: controller.signal,
        })

        if (response.status === 401) {
            handleUnauthorized()
            throw new ApiError('Unauthorized', 401, 'UNAUTHORIZED')
        }

        const contentType = response.headers.get('content-type') || ''
        const payload = contentType.includes('application/json')
            ? await response.json()
            : await response.text()

        if (!response.ok) {
            const message =
                typeof payload === 'object' && payload && 'error' in payload
                    ? String(payload.error)
                    : response.statusText || 'Request failed'
            throw new ApiError(message, response.status, String(response.status), payload)
        }

        return payload as T
    } catch (err) {
        if (err instanceof ApiError) throw err
        if (err instanceof DOMException && err.name === 'AbortError') {
            throw new ApiError('Request timed out', 408, 'TIMEOUT')
        }
        if (err instanceof TypeError && err.message === 'Failed to fetch') {
            throw new ApiError('Network error', 0, 'NETWORK_ERROR')
        }
        throw err
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Raw fetch with auth header. Returns the full Response for callers
 * that need to inspect headers or handle streaming.
 */
export async function fetchWithAuth(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await getAccessToken()
    const isFormData = init.body instanceof FormData

    return fetch(url, {
        cache: 'no-store',
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
            ...(init.headers || {}),
        },
    })
}

export function isNetworkError(error: unknown): boolean {
    return error instanceof ApiError && error.code === 'NETWORK_ERROR'
}

export function isAuthError(error: unknown): boolean {
    return error instanceof ApiError && (error.status === 401 || error.status === 403)
}

export function isTimeoutError(error: unknown): boolean {
    return error instanceof ApiError && error.code === 'TIMEOUT'
}
