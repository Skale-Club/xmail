import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Phone, ArrowRight, LogOut } from 'lucide-react'
import { AppLogo } from '../components/AppLogo'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { loadFirebaseIdentityConfig, ownedIdentityAction, ownedIdentityActive, probeOwnedIdentitySession, leaveOwnedIdentity, type OwnedIdentityUser } from '../lib/owned-identity'

export default function IdentityPilot() {
    const [available, setAvailable] = useState(false)
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [phone, setPhone] = useState('')
    const [code, setCode] = useState('')
    const [awaitingCode, setAwaitingCode] = useState(false)
    const [user, setUser] = useState<OwnedIdentityUser | null>(null)
    const captcha = useRef<HTMLDivElement>(null)
    const pending = useRef<Awaited<ReturnType<typeof import('../lib/firebase-identity').beginPhoneIdentity>>>()
    const linking = new URLSearchParams(window.location.search).get('action') === 'link'

    useEffect(() => {
        let mounted = true
        void Promise.all([loadFirebaseIdentityConfig(), probeOwnedIdentitySession()]).then(([, session]) => {
            if (mounted) { setAvailable(true); setUser(session.user || null) }
        }).catch(() => { if (mounted) setError('Verified sign-in is not available yet. You can continue with the current sign-in page.') })
            .finally(() => { if (mounted) setLoading(false) })
        return () => { mounted = false; pending.current?.dispose() }
    }, [])

    async function finish(token: string) {
        let legacyToken: string | undefined
        if (linking && !ownedIdentityActive()) {
            const { supabase } = await import('../lib/supabase')
            legacyToken = (await supabase.auth.getSession()).data.session?.access_token
            if (!legacyToken) throw new Error('Sign in to your existing account first, then return to link a verified sign-in.')
        }
        await ownedIdentityAction(linking ? 'link' : 'session', token, legacyToken)
        window.location.href = '/mail/inbox'
    }
    async function perform(action: () => Promise<void>) {
        setBusy(true); setError('')
        try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : 'Sign-in could not be confirmed.') }
        finally { setBusy(false) }
    }
    function submitPhone(event: FormEvent) {
        event.preventDefault()
        void perform(async () => {
            const config = await loadFirebaseIdentityConfig() // Recheck the server kill switch and API-key provenance before every provider action.
            if (awaitingCode) {
                if (!pending.current) throw new Error('Request a new verification code.')
                await finish(await pending.current.confirm(code, config))
                return
            }
            if (!/^\+[1-9]\d{7,14}$/.test(phone) || !captcha.current) throw new Error('Use an international number beginning with + and the country code.')
            const { beginPhoneIdentity } = await import('../lib/firebase-identity')
            pending.current?.dispose()
            pending.current = await beginPhoneIdentity(config, phone, captcha.current)
            setAwaitingCode(true)
        })
    }
    return (
        <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-10">
            <Card className="w-full max-w-md border-border/60 shadow-lg-soft">
                <CardHeader className="space-y-3 px-6 pb-5 pt-8">
                    <AppLogo className="h-12 w-12" alt="Xmail" />
                    <div className="space-y-2">
                        <CardTitle className="text-2xl tracking-tight">{linking ? 'Link your verified sign-in' : 'Your mail. Your number.'}</CardTitle>
                        <CardDescription>{linking ? 'Confirm a phone number or Google account for the Xmail account you already signed in to.' : 'Use a verified phone number to sign in to your existing Xmail account.'}</CardDescription>
                    </div>
                </CardHeader>
                <CardContent className="space-y-5 px-6 pb-8">
                    {loading ? <p role="status" className="text-sm text-muted-foreground">Checking sign-in availability…</p> : null}
                    {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">{error}</p> : null}
                    {available && (!user || linking) ? <>
                        {linking && user ? <p className="text-sm text-muted-foreground">Linking to {user.email}</p> : null}
                        <form onSubmit={submitPhone} className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="identity-phone">Phone number</Label>
                                <Input id="identity-phone" type="tel" autoComplete="tel" placeholder="+1 202 555 0123" value={phone}
                                    onChange={event => setPhone(event.target.value.replace(/[\s()-]/g, ''))} disabled={busy || awaitingCode} required className="h-11" />
                                <p className="text-xs text-muted-foreground">Include the country code. Standard SMS rates may apply.</p>
                            </div>
                            <div ref={captcha} data-testid="identity-captcha" />
                            {awaitingCode ? <div className="space-y-2"><Label htmlFor="identity-code">Verification code</Label>
                                <Input id="identity-code" inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={8}
                                    onChange={event => setCode(event.target.value)} required disabled={busy} className="h-11 tracking-[0.3em]" /></div> : null}
                            <Button type="submit" disabled={busy} className="h-11 w-full"><Phone className="mr-2 h-4 w-4" />{busy ? 'Please wait…' : awaitingCode ? 'Verify and continue' : 'Send verification code'}</Button>
                            {awaitingCode ? <Button type="button" variant="ghost" className="w-full" disabled={busy} onClick={() => {
                                pending.current?.dispose(); pending.current = undefined; setAwaitingCode(false); setCode(''); setError('')
                            }}>Use another number or request a new code</Button> : null}
                        </form>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
                        <Button variant="outline" className="h-11 w-full" disabled={busy || awaitingCode} onClick={() => void perform(async () => {
                            const config = await loadFirebaseIdentityConfig()
                            const { googleIdentityToken } = await import('../lib/firebase-identity')
                            await finish(await googleIdentityToken(config))
                        })}>Continue with Google<ArrowRight className="ml-2 h-4 w-4" /></Button>
                        <p className="text-xs leading-relaxed text-muted-foreground">Existing accounts must be linked from a signed-in session. If ownership cannot be confirmed, contact support for reviewed recovery.</p>
                    </> : null}
                    {available && user && !linking ? <div className="space-y-3">
                        <p className="text-sm">Signed in as <span className="font-medium">{user.email}</span></p>
                        <Button className="w-full" onClick={() => { window.location.href = user.isAdmin ? '/admin' : '/mail/inbox' }}>Open Xmail<ArrowRight className="ml-2 h-4 w-4" /></Button>
                        <Button variant="outline" className="w-full" disabled={busy} onClick={() => void perform(async () => { await ownedIdentityAction('revoke-all'); window.location.reload() })}>Sign out all verified sessions</Button>
                    </div> : null}
                    {ownedIdentityActive() ? <Button variant="ghost" className="w-full" disabled={busy} onClick={() => void perform(async () => {
                        await ownedIdentityAction('logout'); window.location.href = '/auth/identity'
                    })}><LogOut className="mr-2 h-4 w-4" />Sign out</Button> : null}
                    <button className="w-full text-center text-sm text-muted-foreground underline underline-offset-4" disabled={busy} onClick={() => {
                        if (ownedIdentityActive()) void perform(leaveOwnedIdentity)
                        else window.location.href = '/login'
                    }}>Use the current sign-in page</button>
                </CardContent>
            </Card>
        </main>
    )
}
