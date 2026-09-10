import { useState, useCallback } from 'react'
import { toast } from '../components/ui/toaster'
import { ApiClientError } from '../lib/api-client'

export { ApiClientError }

// api-client.ts's ApiClientError doesn't carry the isNetworkError/isAuthError
// helpers api.ts had — reconstructed here from status/code so callers keep the
// same checks after the switch off the sign-out-on-any-401 client.
export function isNetworkError(error: unknown): boolean {
    return error instanceof ApiClientError && (error.code === 'network_error' || error.status === 0)
}

export function isAuthError(error: unknown): boolean {
    return error instanceof ApiClientError && (error.status === 401 || error.status === 403)
}

interface ApiErrorState {
    message: string
    code?: string
    status?: number
    details?: unknown
}

export function useApiError() {
    const [error, setError] = useState<ApiErrorState | null>(null)
    const [isError, setIsError] = useState(false)

    const handleError = useCallback((err: unknown, fallbackMessage = 'An error occurred') => {
        const apiError: ApiErrorState = {
            message: fallbackMessage,
            details: err
        }

        if (err instanceof ApiClientError) {
            apiError.message = err.message
            apiError.code = err.code
            apiError.status = err.status
        } else if (err instanceof Error) {
            apiError.message = err.message
        }

        setError(apiError)
        setIsError(true)

        if (!isAuthError(err)) {
            toast({
                title: 'Error',
                description: apiError.message,
                variant: 'destructive'
            })
        }

        return apiError
    }, [])

    const clearError = useCallback(() => {
        setError(null)
        setIsError(false)
    }, [])

    const withErrorHandling = useCallback(<T,>(
        asyncFn: () => Promise<T>,
        fallbackMessage?: string
    ): Promise<T | null> => {
        return asyncFn().catch((err) => {
            handleError(err, fallbackMessage)
            return null
        })
    }, [handleError])

    return {
        error,
        isError,
        handleError,
        clearError,
        withErrorHandling
    }
}

export function parseApiError(error: unknown): ApiErrorState {
    if (error instanceof ApiClientError) {
        return { message: error.message, code: error.code, status: error.status, details: error }
    }

    if (error instanceof Error) {
        return { message: error.message, details: error }
    }

    if (typeof error === 'object' && error !== null) {
        const anyErr = error as Record<string, unknown>
        return {
            message: String(anyErr.message || 'Unknown error'),
            code: anyErr.code ? String(anyErr.code) : undefined,
            status: anyErr.status ? Number(anyErr.status) : undefined,
            details: error
        }
    }

    return { message: 'An unexpected error occurred', details: error }
}

export function getErrorMessage(error: unknown): string {
    return parseApiError(error).message
}

export function isNotFoundError(error: unknown): boolean {
    return error instanceof ApiClientError && error.status === 404
}
