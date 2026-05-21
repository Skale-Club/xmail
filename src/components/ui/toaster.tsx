import * as React from 'react'
import * as ToastPrimitives from '@radix-ui/react-toast'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'

type ToastVariant = 'default' | 'success' | 'destructive'

type ToastItem = {
    id: string
    title?: string
    description?: string
    variant?: ToastVariant
}

type ToastInput = Omit<ToastItem, 'id'>

const listeners = new Set<(toasts: ToastItem[]) => void>()
let toastState: ToastItem[] = []
let toastCounter = 0

function createToastId() {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID()
    }

    toastCounter += 1
    return `toast-${Date.now()}-${toastCounter}`
}

function emit() {
    for (const listener of listeners) {
        listener(toastState)
    }
}

function removeToast(id: string) {
    toastState = toastState.filter((toastItem) => toastItem.id !== id)
    emit()
}

export function toast(input: ToastInput | string) {
    const nextToast: ToastItem =
        typeof input === 'string'
            ? { id: createToastId(), title: input, variant: 'default' }
            : { id: createToastId(), variant: 'default', ...input }

    toastState = [...toastState, nextToast]
    emit()

    window.setTimeout(() => removeToast(nextToast.id), 5000)

    return nextToast.id
}

export function useToast() {
    return {
        toast,
        dismiss: removeToast,
    }
}

export function Toaster() {
    const [toasts, setToasts] = React.useState<ToastItem[]>(toastState)

    React.useEffect(() => {
        listeners.add(setToasts)
        return () => {
            listeners.delete(setToasts)
        }
    }, [])

    return (
        <ToastPrimitives.Provider swipeDirection="right">
            {toasts.map((toastItem) => (
                <ToastPrimitives.Root
                    key={toastItem.id}
                    open
                    onOpenChange={(open) => {
                        if (!open) {
                            removeToast(toastItem.id)
                        }
                    }}
                    className={cn(
                        'pointer-events-auto relative flex w-full max-w-sm items-start gap-3 overflow-hidden rounded-lg border p-4 shadow-lg',
                        toastItem.variant === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-950',
                        toastItem.variant === 'destructive' && 'border-red-200 bg-red-50 text-red-950',
                        (!toastItem.variant || toastItem.variant === 'default') && 'bg-background'
                    )}
                >
                    <div className="grid gap-1">
                        {toastItem.title && (
                            <ToastPrimitives.Title className="font-medium">
                                {toastItem.title}
                            </ToastPrimitives.Title>
                        )}
                        {toastItem.description && (
                            <ToastPrimitives.Description className="text-sm text-muted-foreground">
                                {toastItem.description}
                            </ToastPrimitives.Description>
                        )}
                    </div>
                    <ToastPrimitives.Close className="absolute right-3 top-3 rounded text-muted-foreground transition hover:text-foreground">
                        <X className="h-4 w-4" />
                    </ToastPrimitives.Close>
                </ToastPrimitives.Root>
            ))}
            <ToastPrimitives.Viewport className="fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col gap-2 p-4 sm:max-w-sm" />
        </ToastPrimitives.Provider>
    )
}
