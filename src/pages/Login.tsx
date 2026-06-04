import { useState } from 'react'
import { Mail, Lock, ArrowRight, Eye, EyeOff } from 'lucide-react'
import { defaultBranding, useBranding } from '../lib/branding'
import { apiFetch } from '../lib/api-client'
import { supabase } from '../lib/supabase'
import { AppLogo } from '../components/AppLogo'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'

export default function Login() {
    const { branding } = useBranding()
    const applicationName =
        branding.applicationName === defaultBranding.applicationName
            ? 'Xmail'
            : branding.applicationName
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [showPassword, setShowPassword] = useState(false)

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault()
        setError(null)
        setIsLoading(true)

        try {
            const { error } = await supabase.auth.signInWithPassword({ email, password })

            if (error) {
                setError(error.message)
            } else {
                try {
                    const profileData = await apiFetch<{ user?: { isAdmin?: boolean } }>('/api/users/profile')
                    window.location.href = profileData?.user?.isAdmin ? '/admin' : '/mail/inbox'
                } catch {
                    window.location.href = '/mail/inbox'
                }
            }
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
                            <CardDescription>Sign in to your account to continue</CardDescription>
                        </div>
                    </CardHeader>
                    <CardContent className="px-5 sm:px-6 pb-6 sm:pb-8">
                        <form onSubmit={handleLogin} className="space-y-4 sm:space-y-5">
                            <div className="space-y-2">
                                <Label htmlFor="email" className="text-sm font-medium">Email address</Label>
                                <div className="relative">
                                    <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                    <Input
                                        id="email"
                                        type="email"
                                        placeholder="you@example.com"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        required
                                        className="h-11 pl-10 bg-background"
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <Label htmlFor="password" className="text-sm font-medium">Password</Label>
                                    <button type="button" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                                        Forgot password?
                                    </button>
                                </div>
                                <div className="relative">
                                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                    <Input
                                        id="password"
                                        type={showPassword ? 'text' : 'password'}
                                        placeholder="Enter your password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault()
                                                handleLogin(e as any)
                                            }
                                        }}
                                        required
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

                            {error && (
                                <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3">
                                    <p className="text-sm font-medium text-destructive">{error}</p>
                                </div>
                            )}

                            <Button type="submit" className="h-11 w-full text-sm font-medium mt-2" disabled={isLoading}>
                                {isLoading ? (
                                    <span className="flex items-center gap-2">
                                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                        </svg>
                                        Signing in...
                                    </span>
                                ) : (
                                    <span className="flex items-center gap-2">
                                        Sign In
                                        <ArrowRight className="h-4 w-4" />
                                    </span>
                                )}
                            </Button>
                        </form>
                    </CardContent>
                </Card>

                <div className="text-center text-sm text-muted-foreground pb-2">
                    Don&apos;t have an account?{' '}
                    <span className="font-medium text-foreground">Contact your administrator</span>
                </div>
            </div>
        </div>
    )
}
