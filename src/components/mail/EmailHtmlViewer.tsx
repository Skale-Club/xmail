import { useRef, useEffect, useState, useMemo } from 'react'
import { Maximize2, ImageOff } from 'lucide-react'
import { Dialog, DialogContent } from '../ui/Dialog'
import { parseMailtoUrl, type MailtoTarget } from '../../lib/mailto'
import { processEmailHtml, QUOTE_ATTRIBUTE } from './email-html'
import { senderRegistrableDomain } from '../../lib/sender-domain'
import { useTrustedImageDomains } from '../../hooks/useTrustedImageDomains'
import { useIsDarkTheme } from '../../hooks/useIsDarkTheme'
import { toast } from '../ui/toaster'

interface EmailHtmlViewerProps {
    html?: string | null
    plainText?: string | null
    /** Swap to the other reading of the message (see resolveSurface). */
    invertColors?: boolean
    expandable?: boolean
    isLoading?: boolean
    /** Sender address. Its registrable domain drives the per-user "always show images from this
     *  domain" choice (stored on the server). Without it "Show images" is session-only. */
    senderEmail?: string | null
    /** Called instead of opening a new tab when a `mailto:` link is clicked. Optional so other
     *  surfaces (the outreach thread) keep the default behavior. */
    onMailto?: (target: MailtoTarget) => void
}

/**
 * How the message is painted. The iframe document does not inherit anything from the app, so
 * every surface sets its own text color; leaving it to the browser default is what made plain
 * messages black-on-dark.
 * - `theme`: no page color, text in the app foreground. Only for messages that set no colors of
 *   their own (plain replies, MSHTML/Outlook bodies), which read fine on any background.
 * - `paper`: a white sheet, as the message was designed. Messages that set colors assume one.
 * - `inverted`: the white sheet flipped dark by the iframe filter (opaque, so the flip always
 *   lands on a readable page); media is flipped back so photos keep their real colors.
 */
type EmailSurface = 'theme' | 'paper' | 'inverted'

interface SurfaceStyle {
    text: string
    background: string
    link: string
    quoteBorder: string
    quoteText: string
    padding: string
}

const PAPER: Omit<SurfaceStyle, 'padding'> = {
    text: '#111827',
    background: '#ffffff',
    link: '#2563eb',
    quoteBorder: '#d1d5db',
    quoteText: '#6b7280',
}

function appForeground(fallback: string): string {
    try {
        const value = getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim()
        return value ? `hsl(${value})` : fallback
    } catch {
        return fallback
    }
}

function surfaceStyle(surface: EmailSurface, isDarkTheme: boolean): SurfaceStyle {
    if (surface !== 'theme') return { ...PAPER, padding: '16px 20px' }
    return isDarkTheme
        ? { text: appForeground('#fafafa'), background: 'transparent', link: '#60a5fa', quoteBorder: '#3f3f46', quoteText: '#a1a1aa', padding: '0' }
        : { text: appForeground('#09090b'), background: 'transparent', link: '#2563eb', quoteBorder: '#d1d5db', quoteText: '#6b7280', padding: '0' }
}

function buildEmailDoc(html: string, showQuoted: boolean, surface: EmailSurface, isDarkTheme: boolean) {
    const style = surfaceStyle(surface, isDarkTheme)
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
    * { box-sizing: border-box; }
    html { background: ${style.background}; }
    body {
        margin: 0;
        padding: ${style.padding};
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        line-height: 1.6;
        word-wrap: break-word;
        overflow-wrap: break-word;
        color: ${style.text};
        background: transparent;
    }
    img { max-width: 100%; height: auto; }
    a { color: ${style.link}; }
    pre, code { white-space: pre-wrap; word-wrap: break-word; }
    table { max-width: 100%; border-collapse: collapse; }
    blockquote {
        margin: 8px 0;
        padding: 4px 12px;
        border-left: 3px solid ${style.quoteBorder};
        color: ${style.quoteText};
    }
    ${surface === 'inverted' ? 'img, video, picture, svg { filter: invert(1) hue-rotate(180deg); }' : ''}
    ${showQuoted ? '' : `[${QUOTE_ATTRIBUTE}] { display: none !important; }`}
</style>
</head>
<body>${html}</body>
</html>`
}

/**
 * The default follows the message: plain HTML takes the app theme, designed HTML gets its white
 * sheet. "Invert colors" swaps to the other reading: a themed message in a dark app goes to the
 * white sheet, anything else goes to the inverted (dark) sheet.
 */
function resolveSurface(hasOwnColors: boolean, isDarkTheme: boolean, invert: boolean): EmailSurface {
    const base: EmailSurface = hasOwnColors ? 'paper' : 'theme'
    if (!invert) return base
    return base === 'theme' && isDarkTheme ? 'paper' : 'inverted'
}

/**
 * Renders email HTML content in a sandboxed iframe.
 * Falls back to plain text if no HTML is available.
 * The iframe auto-resizes to fit its content.
 */
export function EmailHtmlViewer({ html, plainText, invertColors, expandable = true, isLoading = false, senderEmail, onMailto }: EmailHtmlViewerProps) {
    const iframeRef = useRef<HTMLIFrameElement>(null)
    const [height, setHeight] = useState(200)
    const [isExpanded, setIsExpanded] = useState(false)
    const [srcdoc, setSrcdoc] = useState<string | undefined>(undefined)
    const senderDomain = useMemo(() => senderRegistrableDomain(senderEmail), [senderEmail])
    const trusted = useTrustedImageDomains()
    const isTrustedDomain = senderDomain !== null && trusted.domains.has(senderDomain)
    // "Show once": images for this message only (never persisted).
    const [showOnce, setShowOnce] = useState(false)
    const allowImages = showOnce || isTrustedDomain

    // A message from a different sender starts blocked again, rather than carrying over
    // whatever the previous message used.
    useEffect(() => {
        setShowOnce(false)
    }, [senderEmail])

    const [showQuoted, setShowQuoted] = useState(false)

    // Reset the quoted-text toggle for each new message.
    useEffect(() => {
        setShowQuoted(false)
    }, [html])

    const processed = useMemo(
        () => (html ? processEmailHtml(html, { blockRemote: !allowImages }) : null),
        [html, allowImages]
    )
    const hasRemoteImages = processed?.hadRemoteContent ?? false
    const hasQuotedText = processed?.hasQuotedText ?? false
    const isDarkTheme = useIsDarkTheme()
    const surface = resolveSurface(processed?.hasOwnColors ?? true, isDarkTheme, Boolean(invertColors))

    useEffect(() => {
        if (!processed) return
        setSrcdoc(buildEmailDoc(processed.html, showQuoted, surface, isDarkTheme))
    }, [processed, showQuoted, surface, isDarkTheme])

    const handleShowOnce = () => setShowOnce(true)

    const handleAlwaysShow = () => {
        if (!senderDomain) return
        // Show right away; the domain is added optimistically and persisted in the background.
        setShowOnce(true)
        trusted.add(senderDomain).catch(() => {
            toast({
                title: `Could not save the images preference for ${senderDomain}`,
                description: 'Images are shown for this message only.',
                variant: 'destructive',
            })
        })
    }

    // Do not flash the "blocked" banner while the saved list is still loading.
    const showBanner = hasRemoteImages && !allowImages && !(senderDomain && trusted.isLoading)

    useEffect(() => {
        const iframe = iframeRef.current
        if (!iframe || !srcdoc) return

        const handleLoad = () => {
            const doc = iframe.contentDocument || iframe.contentWindow?.document
            if (!doc) return

            const resize = () => {
                if (doc.body) {
                    const newHeight = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, 100)
                    setHeight(newHeight + 20)
                }
            }

            // Resize after images load
            const images = doc.querySelectorAll('img')
            let loadedCount = 0
            const totalImages = images.length

            if (totalImages === 0) {
                setTimeout(resize, 50)
            } else {
                images.forEach(img => {
                    if (img.complete) {
                        loadedCount++
                        if (loadedCount >= totalImages) resize()
                    } else {
                        img.addEventListener('load', () => {
                            loadedCount++
                            if (loadedCount >= totalImages) resize()
                        })
                        img.addEventListener('error', () => {
                            loadedCount++
                            if (loadedCount >= totalImages) resize()
                        })
                    }
                })
                setTimeout(resize, 500)
            }

            setTimeout(resize, 100)

            // Open links in a new tab; mailto: links open the compose window when the host asks for it.
            doc.addEventListener('click', (e: MouseEvent) => {
                const target = e.target as HTMLElement
                const anchor = target.closest('a')
                if (anchor) {
                    e.preventDefault()
                    const href = anchor.getAttribute('href')
                    if (!href || href.trim().toLowerCase().startsWith('javascript:')) return
                    const mailto = onMailto ? parseMailtoUrl(href) : null
                    if (mailto && onMailto) {
                        onMailto(mailto)
                        return
                    }
                    window.open(href, '_blank', 'noopener,noreferrer')
                }
            })
        }

        iframe.addEventListener('load', handleLoad)
        return () => iframe.removeEventListener('load', handleLoad)
    }, [srcdoc, onMailto])

    if (isLoading) {
        return (
            <div className="rounded-2xl border border-border/70 bg-muted/20 px-5 py-6">
                <div className="mb-5 flex items-center gap-3 text-sm text-muted-foreground">
                    <div className="h-4 w-4 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
                    <span>Loading message content...</span>
                </div>
                <div className="space-y-3 animate-pulse">
                    <div className="h-3.5 w-11/12 rounded-full bg-muted" />
                    <div className="h-3.5 w-10/12 rounded-full bg-muted" />
                    <div className="h-3.5 w-9/12 rounded-full bg-muted" />
                    <div className="h-3.5 w-7/12 rounded-full bg-muted" />
                    <div className="h-20 w-full rounded-2xl bg-muted/80" />
                </div>
            </div>
        )
    }

    // Plain text fallback
    if (!html) {
        return (
            <div className="text-foreground whitespace-pre-wrap text-sm leading-relaxed">
                {plainText || '(No content)'}
            </div>
        )
    }

    return (
        <>
            {showBanner && (
                <div className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-2">
                        <ImageOff className="h-3.5 w-3.5 flex-shrink-0" />
                        Images in this message have been blocked to protect your privacy.
                    </span>
                    <span className="flex flex-shrink-0 items-center gap-2">
                        {senderDomain ? (
                            <>
                                <button
                                    type="button"
                                    onClick={handleShowOnce}
                                    className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                                >
                                    Show once
                                </button>
                                <button
                                    type="button"
                                    onClick={handleAlwaysShow}
                                    className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                                >
                                    Always show images from {senderDomain}
                                </button>
                            </>
                        ) : (
                            <button
                                type="button"
                                onClick={handleShowOnce}
                                className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                            >
                                Show images
                            </button>
                        )}
                    </span>
                </div>
            )}
            <div className="relative group">
                {expandable && (
                    <button
                        onClick={() => setIsExpanded(true)}
                        className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 inline-flex h-7 w-7 items-center justify-center rounded-md bg-background/80 backdrop-blur-sm border border-border text-muted-foreground transition-all hover:text-foreground hover:bg-accent"
                        title="Expand email"
                        aria-label="Expand email"
                    >
                        <Maximize2 className="h-3.5 w-3.5" />
                    </button>
                )}
                <iframe
                    ref={iframeRef}
                    srcDoc={srcdoc}
                    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                    title="Email content"
                    style={{
                        width: '100%',
                        height: `${height}px`,
                        border: 'none',
                        overflow: 'hidden',
                        display: 'block',
                        borderRadius: surface === 'theme' ? undefined : '8px',
                        filter: surface === 'inverted' ? 'invert(1) hue-rotate(180deg)' : undefined,
                        transition: 'filter 0.2s ease',
                    }}
                />
            </div>

            {hasQuotedText && (
                <button
                    type="button"
                    onClick={() => setShowQuoted(value => !value)}
                    aria-expanded={showQuoted}
                    className="mt-2 inline-flex items-center rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                    {showQuoted ? 'Hide quoted text' : 'Show quoted text'}
                </button>
            )}

            {expandable && (
                <Dialog open={isExpanded} onOpenChange={setIsExpanded}>
                    <DialogContent className="max-w-[95vw] w-[95vw] h-[92vh] flex flex-col p-0 gap-0 overflow-hidden">
                        <div className="flex-1 overflow-y-auto p-6">
                            <EmailHtmlViewer
                                html={html}
                                plainText={plainText}
                                invertColors={invertColors}
                                expandable={false}
                                senderEmail={senderEmail}
                                onMailto={onMailto}
                            />
                        </div>
                    </DialogContent>
                </Dialog>
            )}
        </>
    )
}
