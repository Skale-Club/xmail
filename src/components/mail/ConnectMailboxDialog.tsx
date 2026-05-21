import React from 'react'
import { Mail, Lock, Eye, EyeOff } from 'lucide-react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { toast } from '../ui/toaster'
import { apiFetch } from '../../lib/api-client'
import { useMailbox, type Mailbox } from '../../hooks/useMailbox'

interface ConnectedMailboxResponse {
    mailbox: {
        id: string
        email: string
        displayName: string | null
        isDefault: boolean
        isActive: boolean
    }
}

interface ConnectMailboxDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onConnected?: (mailbox: Mailbox) => void
}

export function ConnectMailboxDialog({ open, onOpenChange, onConnected }: ConnectMailboxDialogProps) {
    const { refreshMailboxes, setSelectedMailbox } = useMailbox()
    const [email, setEmail] = React.useState('')
    const [password, setPassword] = React.useState('')
    const [showPassword, setShowPassword] = React.useState(false)
    const [isSaving, setIsSaving] = React.useState(false)

    const reset = () => {
        setEmail('')
        setPassword('')
        setShowPassword(false)
    }

    const handleOpenChange = (nextOpen: boolean) => {
        if (!nextOpen) reset()
        onOpenChange(nextOpen)
    }

    const handleConnect = async () => {
        setIsSaving(true)
        try {
            const data = await apiFetch<ConnectedMailboxResponse>('/api/mail/mailboxes/connect', {
                method: 'POST',
                body: JSON.stringify({ email, password }),
            })
            reset()
            onOpenChange(false)
            await refreshMailboxes()
            if (data.mailbox) {
                const mailbox: Mailbox = {
                    id: data.mailbox.id,
                    email: data.mailbox.email,
                    displayName: data.mailbox.displayName,
                    isDefault: data.mailbox.isDefault,
                    isActive: data.mailbox.isActive,
                    lastSyncAt: null,
                    syncError: null,
                }
                setSelectedMailbox(mailbox)
                onConnected?.(mailbox)
            }
            toast({ title: 'Account connected successfully', variant: 'success' })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to connect account'
            toast({ title: 'Failed to connect account', description: message, variant: 'destructive' })
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Connect Email Account</DialogTitle>
                    <DialogDescription>
                        Enter the credentials for your own mailbox on this server. To open another local mailbox, sign in as that user.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 mt-2">
                    <div className="space-y-2">
                        <Label>Email Address</Label>
                        <div className="relative">
                            <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="your@email.com"
                                className="h-11 pl-10 bg-background"
                                autoComplete="email"
                            />
                        </div>
                    </div>
                    <div className="space-y-2">
                        <Label>Password</Label>
                        <div className="relative">
                            <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                type={showPassword ? 'text' : 'password'}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="••••••••"
                                className="h-11 pl-10 pr-10 bg-background"
                                autoComplete="current-password"
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
                    <div className="flex gap-3 pt-2">
                        <Button
                            variant="outline"
                            className="flex-1"
                            onClick={() => handleOpenChange(false)}
                            disabled={isSaving}
                        >
                            Cancel
                        </Button>
                        <Button
                            className="flex-1"
                            onClick={handleConnect}
                            disabled={isSaving || !email || !password}
                        >
                            {isSaving ? 'Connecting...' : 'Connect Account'}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
