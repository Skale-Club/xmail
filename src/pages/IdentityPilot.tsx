import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, LogOut } from 'lucide-react'
import { AppLogo } from '../components/AppLogo'
import { CountryPhoneField } from '../components/auth/CountryPhoneField'
import { VerificationCodeField } from '../components/auth/VerificationCodeField'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { loadFirebaseIdentityConfig, ownedIdentityAction, ownedIdentityActive, probeOwnedIdentitySession, leaveOwnedIdentity, storedLegacyFirstLinkToken, linkExistingIdentityAccount, type OwnedIdentityUser } from '../lib/owned-identity'
import { currentBrowserAuthAuthority, legacyBrowserAuthConfirmed, resolveBrowserAuthAuthority } from '../lib/browser-auth-authority'
import { DEFAULT_PHONE_COUNTRY, phoneToE164, type PhoneValue } from '../lib/phone-input'
import { holdAppUpdates } from '../lib/app-update'

function GoogleMark() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="mr-2 h-[18px] w-[18px]">
            <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z" />
            <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.02c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24Z" />
            <path fill="#FBBC05" d="M5.28 14.28a7.2 7.2 0 0 1 0-4.56V6.61H1.27a12 12 0 0 0 0 10.78l4.01-3.11Z" />
            <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.27 6.61l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77Z" />
        </svg>
    )
}

export default function IdentityPilot() {
    const [available, setAvailable] = useState(false)
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [phone, setPhone] = useState<PhoneValue>({ country: DEFAULT_PHONE_COUNTRY, text: '' })
    const [code, setCode] = useState('')
    const [awaitingCode, setAwaitingCode] = useState(false)
    const [sentTo, setSentTo] = useState('')
    const [user, setUser] = useState<OwnedIdentityUser | null>(null)
    const [existingEmail, setExistingEmail] = useState('')
    const [existingPassword, setExistingPassword] = useState('')
    const captcha = useRef<HTMLDivElement>(null)
    const submitting = useRef(false)
    const lifecycle = useRef(0)
    const pending = useRef<Awaited<ReturnType<typeof import('../lib/firebase-identity').beginPhoneIdentity>>>()
    const action = new URLSearchParams(window.location.search).get('action')
    const passwordLinking = action === 'existing-account-link'
    const linking = action === 'link' || passwordLinking

    useEffect(() => holdAppUpdates(), [])

    useEffect(() => {
        const generation = ++lifecycle.current
        let mounted = true
        void Promise.all([loadFirebaseIdentityConfig(), probeOwnedIdentitySession()]).then(([, session]) => {
            if (mounted) { setAvailable(true); setUser(session.user || null) }
        }).catch(() => { if (mounted) setError('Verified sign-in is not available yet. Contact support for reviewed recovery.') })
            .finally(() => { if (mounted) setLoading(false) })
        return () => {
            mounted = false
            if (lifecycle.current === generation) lifecycle.current++
            pending.current?.dispose()
            pending.current = undefined
        }
    }, [])

    async function finish(token: string) {
        if (passwordLinking) {
            try {
                await linkExistingIdentityAccount(token, existingEmail.trim(), existingPassword)
                await ownedIdentityAction('session', token)
                await requireSavedSession()
                window.location.href = '/mail/inbox'
                return
            } finally { setExistingPassword('') }
        }
        let legacyToken: string | undefined
        if (linking && (await probeOwnedIdentitySession()).kind !== 'active') {
            await resolveBrowserAuthAuthority({ force: true })
            if (!legacyBrowserAuthConfirmed()) legacyToken = storedLegacyFirstLinkToken()
            else {
                const { supabase } = await import('../lib/supabase')
                legacyToken = (await supabase.auth.getSession()).data.session?.access_token
            }
            if (!legacyToken) throw new Error('Use Link an existing account to prove ownership with your previous password.')
        }
        await ownedIdentityAction(linking ? 'link' : 'session', token, legacyToken)
        await requireSavedSession()
        window.location.href = '/mail/inbox'
    }
    async function requireSavedSession() {
        const session = await probeOwnedIdentitySession()
        if (session.kind !== 'active' || !session.user) {
            throw new Error('Your sign-in session could not be confirmed. Check your connection and allow cookies for Xmail, then try again.')
        }
    }
    async function perform(action: () => Promise<void>) {
        if (submitting.current) return
        submitting.current = true
        const generation = lifecycle.current
        setBusy(true); setError('')
        try { await action() } catch (failure) {
            if (lifecycle.current === generation) setError(failure instanceof Error ? failure.message : 'Sign-in could not be confirmed.')
        } finally {
            submitting.current = false
            if (lifecycle.current === generation) setBusy(false)
        }
    }
    function submitPhone(event: FormEvent) {
        event.preventDefault()
        const generation = lifecycle.current
        void perform(async () => {
            requireExistingCredentials()
            const config = await loadFirebaseIdentityConfig() // Recheck the server kill switch and API-key provenance before every provider action.
            if (lifecycle.current !== generation) return
            if (awaitingCode) {
                if (!pending.current) throw new Error('Request a new verification code.')
                if (!/^\d{6}$/.test(code)) throw new Error('Enter the six-digit verification code.')
                const token = await pending.current.confirm(code, config)
                if (lifecycle.current === generation) await finish(token)
                return
            }
            const number = phoneToE164(phone)
            if (!number || !captcha.current) throw new Error('Enter a valid phone number for the selected country.')
            const { beginPhoneIdentity } = await import('../lib/firebase-identity')
            if (lifecycle.current !== generation) return
            pending.current?.dispose()
            const confirmation = await beginPhoneIdentity(config, number, captcha.current)
            if (lifecycle.current !== generation) { confirmation.dispose(); return }
            pending.current = confirmation
            setSentTo(number)
            setAwaitingCode(true)
        })
    }
    function requireExistingCredentials() {
        if (passwordLinking && (!existingEmail.trim() || !existingPassword)) throw new Error('Enter your previous account email and password first.')
    }
    return (
        <main className="relative isolate flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">
            <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-secondary via-background to-background" />
            <Card className="w-full max-w-[26rem] border-border/60 shadow-lg-soft">
                <CardHeader className="items-center space-y-3 px-6 pb-5 pt-8 text-center">
                    <AppLogo className="h-12 w-12" alt="Xmail" />
                    <div className="space-y-1.5">
                        <CardTitle className="text-2xl tracking-tight">{passwordLinking ? 'Link your existing Xmail account' : linking ? 'Link your verified sign-in' : 'Sign in to Xmail'}</CardTitle>
                        <CardDescription>{passwordLinking ? 'Prove your previous account, then confirm a phone number or Google account. Your mail password stays unchanged.' : linking ? 'Confirm a phone number or Google account for the Xmail account you already signed in to.' : 'Use your verified phone number or Google account.'}</CardDescription>
                    </div>
                </CardHeader>
                <CardContent className="space-y-5 px-6 pb-8">
                    {loading ? <p role="status" className="text-sm text-muted-foreground">Checking sign-in availability…</p> : null}
                    {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">{error}</p> : null}
                    {available && (!user || linking) ? <>
                        {linking && user ? <p className="text-sm text-muted-foreground">Linking to {user.email}</p> : null}
                        {passwordLinking ? <div className="space-y-4">
                            <div className="space-y-2"><Label htmlFor="existing-account-email">Previous account email</Label>
                                <Input id="existing-account-email" type="email" autoComplete="username" maxLength={320} value={existingEmail}
                                    onChange={event => setExistingEmail(event.target.value)} disabled={busy} className="h-11" /></div>
                            <div className="space-y-2"><Label htmlFor="existing-account-password">Previous account password</Label>
                                <Input id="existing-account-password" type="password" autoComplete="current-password" maxLength={4096} value={existingPassword}
                                    onChange={event => setExistingPassword(event.target.value)} disabled={busy} className="h-11" /></div>
                            <p className="text-xs text-muted-foreground">These details prove the existing account only. This does not reset your SMTP or IMAP password.</p>
                        </div> : null}
                        <form onSubmit={submitPhone} className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="identity-phone">Phone number</Label>
                                <CountryPhoneField id="identity-phone" value={phone} onChange={setPhone} disabled={busy || awaitingCode} />
                                <p className="text-xs text-muted-foreground">Standard SMS rates may apply.</p>
                            </div>
                            <div ref={captcha} data-testid="identity-captcha" className="empty:hidden" />
                            {awaitingCode ? <div className="space-y-3">
                                <p className="text-sm text-muted-foreground">Enter the six-digit code sent to <span className="font-medium text-foreground">{sentTo}</span>.</p>
                                <VerificationCodeField value={code} onChange={setCode} disabled={busy} />
                            </div> : null}
                            <Button type="submit" disabled={busy || (awaitingCode ? code.length !== 6 : !phone.text.trim())} className="h-11 w-full">{busy ? 'Please wait…' : awaitingCode ? 'Verify and continue' : <>Send code<ArrowRight className="ml-2 h-4 w-4" /></>}</Button>
                            {awaitingCode ? <Button type="button" variant="ghost" className="w-full" disabled={busy} onClick={() => {
                                pending.current?.dispose(); pending.current = undefined; setAwaitingCode(false); setCode(''); setSentTo(''); setError('')
                            }}>Use another number or request a new code</Button> : null}
                        </form>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
                        <Button variant="outline" className="h-11 w-full" disabled={busy || awaitingCode} onClick={() => void perform(async () => {
                            const generation = lifecycle.current
                            requireExistingCredentials()
                            const config = await loadFirebaseIdentityConfig()
                            if (lifecycle.current !== generation) return
                            const { googleIdentityToken } = await import('../lib/firebase-identity')
                            if (lifecycle.current !== generation) return
                            const token = await googleIdentityToken(config)
                            if (lifecycle.current === generation) await finish(token)
                        })}><GoogleMark />Continue with Google</Button>
                        {passwordLinking ? <p className="text-center text-xs leading-relaxed text-muted-foreground">Confirm the previous password and your verified sign-in to link this account. If you cannot prove ownership, contact support for reviewed recovery.</p> : null}
                    </> : null}
                    {available && user && !linking ? <div className="space-y-3">
                        <p className="text-sm">Signed in as <span className="font-medium">{user.email}</span></p>
                        <Button className="w-full" onClick={() => { window.location.href = user.isAdmin ? '/admin' : '/mail/inbox' }}>Open Xmail<ArrowRight className="ml-2 h-4 w-4" /></Button>
                        <Button variant="outline" className="w-full" disabled={busy} onClick={() => void perform(async () => { await ownedIdentityAction('revoke-all'); window.location.reload() })}>Sign out all verified sessions</Button>
                    </div> : null}
                    {user && ownedIdentityActive() ? <Button variant="ghost" className="w-full" disabled={busy} onClick={() => void perform(async () => {
                        await ownedIdentityAction('logout'); window.location.href = '/auth/identity'
                    })}><LogOut className="mr-2 h-4 w-4" />Sign out</Button> : null}
                    {currentBrowserAuthAuthority() === 'legacy' ? <button className="w-full text-center text-sm text-muted-foreground underline underline-offset-4" disabled={busy} onClick={() => {
                        if (ownedIdentityActive()) void perform(leaveOwnedIdentity)
                        else window.location.href = '/login'
                    }}>Use the current sign-in page</button> : null}
                </CardContent>
            </Card>
        </main>
    )
}
