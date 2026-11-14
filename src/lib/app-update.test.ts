import { expect, it, vi } from 'vitest'
import { createAppUpdateCoordinator } from './app-update'

it('defers deployment and chunk recovery through SMS entry and StrictMode remount', async () => {
    const reload = vi.fn(), reset = vi.fn().mockResolvedValue(undefined)
    const updates = createAppUpdateCoordinator(reload, () => false)
    const release = updates.hold()
    updates.request(reset)
    release()
    const releaseAgain = updates.hold()
    await Promise.resolve()
    expect(reset).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    releaseAgain()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
    expect(reset).toHaveBeenCalledOnce()
})

it('protects auth routes before the lazy login component mounts', async () => {
    const reload = vi.fn()
    const updates = createAppUpdateCoordinator(reload, () => true)
    updates.request()
    await Promise.resolve()
    expect(reload).not.toHaveBeenCalled()
})

it('rechecks navigation after asynchronous cache recovery', async () => {
    let authPage = false
    let finish!: () => void
    const reload = vi.fn()
    const updates = createAppUpdateCoordinator(reload, () => authPage)
    updates.request(() => new Promise<void>(resolve => { finish = resolve }))
    authPage = true
    finish()
    await Promise.resolve()
    expect(reload).not.toHaveBeenCalled()
})

it('reloads ordinary app pages for deployments and releases each hold only once', async () => {
    const reload = vi.fn()
    const updates = createAppUpdateCoordinator(reload, () => false)
    const release = updates.hold()
    release(); release()
    updates.request()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce())
})
