/** Preserve caller cancellation and impose an independent absolute lookup deadline. */
export const identityLookupSignal = (caller?: AbortSignal) => caller
    ? AbortSignal.any([caller, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000)

export function identityFetch(input: string | URL | Request, init: RequestInit = {}) {
    return fetch(input, { ...init, redirect: 'error', signal: identityLookupSignal(init.signal ?? undefined) })
}
