import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VerificationCodeField } from './VerificationCodeField'

function Harness({ changed = () => undefined }: { changed?: (value: string) => void }) {
    const [value, setValue] = useState('')
    return <VerificationCodeField value={value} onChange={next => { setValue(next); changed(next) }} />
}

it('focuses the first digit, accepts digits only and advances between six accessible boxes', async () => {
    const changed = vi.fn()
    render(<Harness changed={changed} />)
    expect(screen.getByRole('group', { name: 'Verification code' })).toBeVisible()
    expect(screen.getAllByRole('textbox')).toHaveLength(6)
    expect(screen.getByLabelText('Digit 1 of 6')).toHaveFocus()
    expect(screen.getByLabelText('Digit 1 of 6')).toHaveAttribute('autocomplete', 'one-time-code')
    expect(screen.getByLabelText('Digit 1 of 6')).toHaveAttribute('inputmode', 'numeric')
    await userEvent.keyboard('a1b23456')
    expect(changed).toHaveBeenLastCalledWith('123456')
    expect(screen.getByLabelText('Digit 6 of 6')).toHaveFocus()
    expect(screen.getAllByRole('textbox').map(input => (input as HTMLInputElement).value)).toEqual(['1', '2', '3', '4', '5', '6'])
})

it('supports full-code paste and mobile autofill without requiring six separate edits', async () => {
    const changed = vi.fn()
    render(<Harness changed={changed} />)
    await userEvent.paste('123 456')
    expect(changed).toHaveBeenLastCalledWith('123456')
    fireEvent.change(screen.getByLabelText('Digit 1 of 6'), { target: { value: '654321' } })
    expect(changed).toHaveBeenLastCalledWith('654321')
    expect(screen.getAllByRole('textbox').map(input => (input as HTMLInputElement).value)).toEqual(['6', '5', '4', '3', '2', '1'])
})

it('supports arrows, backspace and replacement without shifting other digits', async () => {
    const changed = vi.fn()
    render(<Harness changed={changed} />)
    await userEvent.keyboard('123456{ArrowLeft}{Backspace}')
    expect(screen.getByLabelText('Digit 5 of 6')).toHaveValue('')
    expect(screen.getByLabelText('Digit 6 of 6')).toHaveValue('6')
    await userEvent.keyboard('{Backspace}')
    expect(screen.getByLabelText('Digit 4 of 6')).toHaveFocus()
    expect(screen.getByLabelText('Digit 4 of 6')).toHaveValue('')
    await userEvent.keyboard('78')
    expect(changed).toHaveBeenLastCalledWith('123786')
    await userEvent.keyboard('{ArrowLeft}')
    expect(screen.getByLabelText('Digit 5 of 6')).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByLabelText('Digit 6 of 6')).toHaveFocus()
})
