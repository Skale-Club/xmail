import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Input } from '../ui/input'

const CODE_LENGTH = 6
const splitCode = (value: string) => Array.from({ length: CODE_LENGTH }, (_, index) => value[index] || '')

export function VerificationCodeField({ value, onChange, disabled = false }: {
    value: string
    onChange: (value: string) => void
    disabled?: boolean
}) {
    const [digits, setDigits] = useState(() => splitCode(value))
    const inputs = useRef<Array<HTMLInputElement | null>>([])

    useEffect(() => {
        setDigits(current => current.join('') === value ? current : splitCode(value))
    }, [value])

    function update(next: string[]) {
        setDigits(next)
        onChange(next.join(''))
    }

    function enter(index: number, text: string) {
        const incoming = text.replace(/\D/g, '').slice(0, CODE_LENGTH)
        if (!incoming) return
        const start = incoming.length === CODE_LENGTH ? 0 : index
        const next = [...digits]
        for (let offset = 0; offset < incoming.length && start + offset < CODE_LENGTH; offset++) {
            next[start + offset] = incoming[offset]
        }
        update(next)
        inputs.current[Math.min(start + incoming.length, CODE_LENGTH - 1)]?.focus()
    }

    function handleKey(index: number, event: KeyboardEvent<HTMLInputElement>) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            inputs.current[Math.max(0, Math.min(CODE_LENGTH - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)))]?.focus()
        } else if (event.key === 'Backspace') {
            event.preventDefault()
            const target = digits[index] ? index : Math.max(0, index - 1)
            update(digits.map((digit, position) => position === target ? '' : digit))
            inputs.current[target]?.focus()
        } else if (event.key === 'Delete') {
            event.preventDefault()
            update(digits.map((digit, position) => position === index ? '' : digit))
        }
    }

    return (
        <div role="group" aria-label="Verification code" className="flex justify-between gap-2">
            {digits.map((digit, index) => <Input
                key={index}
                ref={element => { inputs.current[index] = element }}
                aria-label={`Digit ${index + 1} of ${CODE_LENGTH}`}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete={index === 0 ? 'one-time-code' : 'off'}
                autoFocus={index === 0}
                maxLength={CODE_LENGTH}
                value={digit}
                disabled={disabled}
                className="h-12 min-w-0 flex-1 px-0 text-center text-xl tabular-nums"
                onFocus={event => event.target.select()}
                onKeyDown={event => handleKey(index, event)}
                onChange={event => {
                    if (!event.target.value) update(digits.map((current, position) => position === index ? '' : current))
                    else enter(index, event.target.value)
                }}
                onPaste={event => {
                    event.preventDefault()
                    enter(index, event.clipboardData.getData('text'))
                }}
            />)}
        </div>
    )
}
