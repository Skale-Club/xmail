import { ImageIcon, Trash2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Button } from '../ui/button'
import { toast } from '../ui/toaster'
import { useTrustedImageDomains } from '../../hooks/useTrustedImageDomains'

/** Webmail settings section: sender domains whose images load automatically, with revocation. */
export function TrustedImageDomainsCard() {
    const { list, isLoading, isError, remove, removingDomain } = useTrustedImageDomains()

    const handleRemove = (domain: string) => {
        remove(domain).catch(() => {
            toast({ title: `Could not remove ${domain}`, variant: 'destructive' })
        })
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <ImageIcon className="w-5 h-5" />
                    Trusted image senders
                </CardTitle>
                <CardDescription>
                    Images load automatically in messages from these domains. Remove a domain to block its images again.
                </CardDescription>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <p className="text-muted-foreground">Loading trusted domains...</p>
                ) : isError ? (
                    <p className="text-destructive text-sm">Could not load trusted domains.</p>
                ) : list.length === 0 ? (
                    <div className="text-center py-8">
                        <ImageIcon className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                        <p className="text-muted-foreground">
                            No trusted domains yet. Use &apos;Always show images&apos; on an email to add one.
                        </p>
                    </div>
                ) : (
                    <ul className="divide-y divide-border">
                        {list.map(domain => (
                            <li key={domain} className="flex items-center justify-between gap-3 py-3">
                                <span className="font-medium text-sm">{domain}</span>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleRemove(domain)}
                                    disabled={removingDomain === domain}
                                    aria-label={`Remove ${domain}`}
                                >
                                    <Trash2 className="w-4 h-4 mr-1" />
                                    Remove
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    )
}
