import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { Lock, Eye, EyeOff } from 'lucide-react'
import { defaultBranding, useBranding } from '../lib/branding'
import { apiFetch } from '../lib/api-client'
import { supabase } from '../lib/supabase'
import { AppLogo } from '../components/AppLogo'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { toast } from '../components/ui/toaster'

// Handles the Supabase recovery redirect for both the admin "invite" flow
// (users.ts inviteUserByEmail / resend-invite) and the self-service "forgot
// password" flow (auth.ts /reset-password). supabase-js parses the recovery
// tokens out of the URL hash on load and establishes a session automatically
// (detectSessionInUrl), firing a PASSWORD_RECOVERY auth event. We listen for
// that event and also check getSession() directly in case the event already
// fired before this component mounted.
export default function ResetPassword() {
    const { branding } = useBranding()
    const applicationName =
        branding.applicationName === defaultBranding.applicationName
            ? 'Xmail'
            : branding.applicationName
    const [, navigate] = useLocation()

    const [password, setPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [isReady, setIsReady] = useState(false)
    const [hasSession, setHasSession] = useState(false)

    useEffect(() => {
        let mounted = true

        const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
            if (!mounted) return
            if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session)) {
                setHasSession(true)
                setIsReady(true)
            }
        })

        void supabase.auth.getSession().then(({ data }) => {
            if (!mounted) return
            if (data.session) setHasSession(true)
            setIsReady(true)
        })

        return () => {
            mounted = false
            listener.subscription.unsubscribe()
        }
    }, [])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setError(null)

        if (password.length < 8) {
            setError('Password must be at least 8 characters')
            return
        }
        if (password !== confirmPassword) {
            setError('Passwords do not match')
            return
        }

        setIsLoading(true)
        try {
            // Goes through the server route (not supabase.auth.updateUser directly)
            // so users.passwordHash gets synced and a native mailbox is created on
            // first password set for invited users — see auth.ts /update-password.
            await apiFetch('/api/auth/update-password', {
                method: 'POST',
                body: JSON.stringify({ password }),
            })
            toast({ title: 'Password updated successfully', variant: 'success' })
            navigate('/login')
        } catch (err) {
            setError(err instanceof Error ? err.message : 'An unexpected error occurred')
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="flex min-h-[100dvh] items-center justify-center bg-background p-4 sm:p-6">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-secondary via-background to-background -z-10" />
            <div className="w-full max-w-md z-10 flex flex-col gap-6 sm:gap-8">
                <Card className="shadow-lg-soft border-border/40">
                    <CardHeader className="space-y-0 text-center pb-4 sm:pb-6 pt-6 sm:pt-8 px-5 sm:px-6">
                        <div className="flex flex-col items-center justify-center gap-1">
                            <AppLogo className="h-14 w-14 sm:h-16 sm:w-16 shadow-sm-soft" alt={`${applicationName} logo`} />
                            <CardTitle className="text-xl sm:text-2xl font-semibold tracking-tight">{applicationName}</CardTitle>
                            <CardDescription>Set a new password for your account</CardDescription>
                        </div>
                    </CardHeader>
                    <CardContent className="px-5 sm:px-6 pb-6 sm:pb-8">
                        {!isReady ? (
                            <p className="py-8 text-center text-sm text-muted-foreground">Verifying your reset link...</p>
                        ) : !hasSession ? (
                            <div className="space-y-4 text-center">
                                <p className="text-sm text-destructive">
                                    This reset link is invalid or has expired. Please request a new one.
                                </p>
                                <Button variant="outline" className="w-full" onClick={() => navigate('/login')}>
                                    Back to login
                                </Button>
                            </div>
                        ) : (
                            <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-5">
                                <div className="space-y-2">
                                    <Label htmlFor="password" className="text-sm font-medium">New password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                        <Input
                                            id="password"
                                            type={showPassword ? 'text' : 'password'}
                                            placeholder="Minimum 8 characters"
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            required
                                            minLength={8}
                                            className="h-11 pl-10 pr-10 bg-background"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowPassword(!showPassword)}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                                        >
                                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                        </button>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="confirmPassword" className="text-sm font-medium">Confirm password</Label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                        <Input
                                            id="confirmPassword"
                                            type={showPassword ? 'text' : 'password'}
                                            placeholder="Re-enter your password"
                                            value={confirmPassword}
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            required
                                            minLength={8}
                                            className="h-11 pl-10 bg-background"
                                        />
                                    </div>
                                </div>

                                {error && (
                                    <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3">
                                        <p className="text-sm font-medium text-destructive">{error}</p>
                                    </div>
                                )}

                                <Button type="submit" className="h-11 w-full text-sm font-medium mt-2" disabled={isLoading}>
                                    {isLoading ? 'Updating...' : 'Update password'}
                                </Button>
                            </form>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    )
}
