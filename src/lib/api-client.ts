import { supabase } from './supabase'

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'

export interface ApiRequestOptions extends RequestInit {
    auth?: boolean
    retry?: boolean
}

export class ApiClientError extends Error {
    status: number
    path: string
    details?: unknown
    code?: string

    constructor(message: string, options: { status: number; path: string; details?: unknown; code?: string }) {
        super(message)
        this.name = 'ApiClientError'
        this.status = options.status
        this.path = options.path
        this.details = options.details
        this.code = options.code
    }
}

function sleep(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function isRetryableMethod(method: string | undefined) {
    const normalized = (method || 'GET').toUpperCase() as ApiMethod
    return normalized === 'GET' || normalized === 'HEAD'
}

function shouldSetJsonContentType(body: BodyInit | null | undefined) {
    return typeof body === 'string'
}

interface ZodIssueLike {
    path?: Array<string | number>
    message?: string
}

function isZodIssueArray(value: unknown): value is ZodIssueLike[] {
    return Array.isArray(value) && value.every(
        (item) => typeof item === 'object' && item !== null && 'message' in item
    )
}

// Zod's error.errors (or error.issues) is an array of { path, message } — the server forwards
// it verbatim as `{ error: [...] }` on a 400. Left unhandled, callers only ever saw the
// Response's statusText ("Bad Request"), which tells the user nothing about which field failed.
function formatZodIssues(issues: ZodIssueLike[]): string {
    return issues
        .map((issue) => {
            const path = Array.isArray(issue.path) ? issue.path.join('.') : ''
            const message = issue.message || 'Invalid value'
            return path ? `${path}: ${message}` : message
        })
        .join('; ')
}

function getErrorMessage(payload: unknown, fallback: string) {
    if (typeof payload === 'object' && payload) {
        if ('error' in payload) {
            const error = payload.error
            if (typeof error === 'string') {
                return error
            }
            if (isZodIssueArray(error)) {
                return formatZodIssues(error)
            }
            if (typeof error === 'object' && error && 'message' in error && typeof error.message === 'string') {
                return error.message
            }
        }
        if ('message' in payload && typeof payload.message === 'string') {
            return payload.message
        }
    }

    if (typeof payload === 'string' && payload.trim()) {
        return payload
    }

    return fallback
}

async function parseResponsePayload(response: Response): Promise<unknown> {
    if (response.status === 204) {
        return null
    }

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
        return response.json()
    }

    return response.text()
}

let cachedToken: string | null = null
let tokenExpiresAt = 0

async function getValidSession() {
    const now = Date.now()

    if (cachedToken && tokenExpiresAt > now + 60_000) {
        return { access_token: cachedToken, expires_at: tokenExpiresAt }
    }

    const { data, error } = await supabase.auth.getSession()

    if (error) {
        cachedToken = null
        tokenExpiresAt = 0
        throw new ApiClientError(error.message, {
            status: 401,
            path: 'session',
            code: 'session_error',
        })
    }

    let session = data.session
    const expiresSoon = session?.expires_at ? (session.expires_at * 1000) - Date.now() < 60_000 : false

    if (expiresSoon) {
        const refreshed = await supabase.auth.refreshSession()
        if (refreshed.error) {
            cachedToken = null
            tokenExpiresAt = 0
            throw new ApiClientError(refreshed.error.message, {
                status: 401,
                path: 'session',
                code: 'session_refresh_failed',
            })
        }
        session = refreshed.data.session
    }

    if (session) {
        cachedToken = session.access_token
        tokenExpiresAt = session.expires_at ? session.expires_at * 1000 : 0
    }

    return session
}

export async function getAccessToken() {
    const session = await getValidSession()
    return session?.access_token
}

export function clearTokenCache() {
    cachedToken = null
    tokenExpiresAt = 0
}

async function executeRequest(path: string, init: RequestInit, token?: string | null) {
    const headers = new Headers(init.headers || {})

    if (token) {
        headers.set('Authorization', `Bearer ${token}`)
    }

    if (shouldSetJsonContentType(init.body) && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json')
    }

    return fetch(path, {
        cache: 'no-store',
        ...init,
        headers,
    })
}

export async function apiRequest(path: string, options: ApiRequestOptions = {}): Promise<Response> {
    const { auth = true, retry = true, ...init } = options
    const method = (init.method || 'GET').toUpperCase()
    let token = auth ? await getAccessToken() : null

    try {
        let response = await executeRequest(path, init, token)

        if (response.status === 401 && auth) {
            clearTokenCache()
            const refreshed = await supabase.auth.refreshSession()
            if (refreshed.error || !refreshed.data.session?.access_token) {
                throw new ApiClientError(refreshed.error?.message || 'Unauthorized', {
                    status: 401,
                    path,
                    code: 'unauthorized',
                })
            }

            token = refreshed.data.session.access_token
            response = await executeRequest(path, init, token)
        }

        if (!response.ok) {
            const payload = await parseResponsePayload(response)
            throw new ApiClientError(getErrorMessage(payload, response.statusText || 'Request failed'), {
                status: response.status,
                path,
                details: payload,
            })
        }

        return response
    } catch (error) {
        if (error instanceof ApiClientError) {
            throw error
        }

        if (retry && isRetryableMethod(method)) {
            await sleep(250)
            return apiRequest(path, { ...options, retry: false })
        }

        throw new ApiClientError(error instanceof Error ? error.message : 'Network request failed', {
            status: 0,
            path,
            code: 'network_error',
        })
    }
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const response = await apiRequest(path, options)
    const payload = await parseResponsePayload(response)
    return payload as T
}
