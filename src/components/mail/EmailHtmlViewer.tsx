import { useRef, useEffect, useState, useMemo } from 'react'
import { Maximize2, ImageOff } from 'lucide-react'
import { Dialog, DialogContent } from '../ui/Dialog'

interface EmailHtmlViewerProps {
    html?: string | null
    plainText?: string | null
    emailDarkMode?: boolean
    expandable?: boolean
    isLoading?: boolean
    /** Sender address, used to remember a "always show images" choice per sender
     *  in localStorage. Without it the "Show images" choice is session-only. */
    senderEmail?: string | null
}

// 1x1 transparent GIF — stands in for any blocked remote image so the layout
// doesn't jump when a message is first rendered with images off.
const BLOCKED_IMAGE_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const REMOTE_URL_RE = /^https?:\/\//i
const CSS_URL_RE = /url\(\s*(['"]?)(https?:\/\/[^'")]+)\1\s*\)/gi
const STORAGE_PREFIX = 'xmail:show-images:'

function rememberSenderChoice(senderEmail: string | null | undefined) {
    if (!senderEmail) return
    try {
        window.localStorage.setItem(`${STORAGE_PREFIX}${senderEmail.toLowerCase()}`, '1')
    } catch {
        // Storage unavailable (private mode, quota, etc.) — the choice just won't persist.
    }
}

function senderAlwaysShowsImages(senderEmail: string | null | undefined): boolean {
    if (!senderEmail) return false
    try {
        return window.localStorage.getItem(`${STORAGE_PREFIX}${senderEmail.toLowerCase()}`) === '1'
    } catch {
        return false
    }
}

/**
 * Rewrites every remote (http/https) image reference in `html` — <img src>,
 * <img srcset>, inline style="...url(...)" and <style> block backgrounds — to
 * a same-origin data: placeholder. `cid:` (inline attachment) and `data:`
 * images are left untouched since they never leave the sandbox. Returns
 * whether anything was actually blocked, so the caller can show the
 * "Show images" bar only when there's something to show.
 */
function blockRemoteImages(html: string): { safeHtml: string; hadRemoteImages: boolean } {
    if (typeof DOMParser === 'undefined') {
        return { safeHtml: html, hadRemoteImages: false }
    }

    let hadRemoteImages = false
    const doc = new DOMParser().parseFromString(html, 'text/html')

    doc.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src')
        if (src && REMOTE_URL_RE.test(src.trim())) {
            hadRemoteImages = true
            img.setAttribute('src', BLOCKED_IMAGE_PLACEHOLDER)
        }

        const srcset = img.getAttribute('srcset')
        if (srcset) {
            const rewritten = srcset
                .split(',')
                .map((candidate) => {
                    const [url, descriptor] = candidate.trim().split(/\s+/, 2)
                    if (url && REMOTE_URL_RE.test(url)) {
                        hadRemoteImages = true
                        return [BLOCKED_IMAGE_PLACEHOLDER, descriptor].filter(Boolean).join(' ')
                    }
                    return candidate.trim()
                })
                .join(', ')
            img.setAttribute('srcset', rewritten)
        }
    })

    // Global regexes carry mutable lastIndex state across calls, which would
    // desync test()/replace() pairs reused across many elements — so each use
    // below just replaces and compares strings rather than test()-ing first.
    doc.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
        const style = el.getAttribute('style') || ''
        const rewritten = style.replace(CSS_URL_RE, `url($1${BLOCKED_IMAGE_PLACEHOLDER}$1)`)
        if (rewritten !== style) {
            hadRemoteImages = true
            el.setAttribute('style', rewritten)
        }
    })

    doc.querySelectorAll('style').forEach((styleTag) => {
        const css = styleTag.textContent || ''
        const rewritten = css.replace(CSS_URL_RE, `url($1${BLOCKED_IMAGE_PLACEHOLDER}$1)`)
        if (rewritten !== css) {
            hadRemoteImages = true
            styleTag.textContent = rewritten
        }
    })

    return { safeHtml: doc.body.innerHTML, hadRemoteImages }
}

function buildEmailDoc(html: string) {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
    * { box-sizing: border-box; }
    body {
        margin: 0;
        padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        line-height: 1.6;
        word-wrap: break-word;
        overflow-wrap: break-word;
        color: inherit;
        background: transparent;
    }
    img { max-width: 100%; height: auto; }
    a { color: #3b82f6; }
    pre, code { white-space: pre-wrap; word-wrap: break-word; }
    table { max-width: 100%; border-collapse: collapse; }
    blockquote {
        margin: 8px 0;
        padding: 4px 12px;
        border-left: 3px solid #d1d5db;
        color: #6b7280;
    }
</style>
</head>
<body>${html}</body>
</html>`
}

/**
 * Renders email HTML content in a sandboxed iframe.
 * Falls back to plain text if no HTML is available.
 * The iframe auto-resizes to fit its content.
 */
export function EmailHtmlViewer({ html, plainText, emailDarkMode, expandable = true, isLoading = false, senderEmail }: EmailHtmlViewerProps) {
    const iframeRef = useRef<HTMLIFrameElement>(null)
    const [height, setHeight] = useState(200)
    const [isExpanded, setIsExpanded] = useState(false)
    const [srcdoc, setSrcdoc] = useState<string | undefined>(undefined)
    const [allowImages, setAllowImages] = useState(() => senderAlwaysShowsImages(senderEmail))

    // A new message from a different sender starts from that sender's remembered
    // choice again, rather than carrying over whatever the previous message used.
    useEffect(() => {
        setAllowImages(senderAlwaysShowsImages(senderEmail))
    }, [senderEmail])

    const { safeHtml, hadRemoteImages: hasRemoteImages } = useMemo(
        () => (html ? blockRemoteImages(html) : { safeHtml: '', hadRemoteImages: false }),
        [html]
    )

    useEffect(() => {
        if (!html) return
        setSrcdoc(buildEmailDoc(allowImages ? html : safeHtml))
    }, [html, safeHtml, allowImages])

    const handleShowImages = () => {
        setAllowImages(true)
        rememberSenderChoice(senderEmail)
    }

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

            // Open links in new tab
            doc.addEventListener('click', (e: MouseEvent) => {
                const target = e.target as HTMLElement
                const anchor = target.closest('a')
                if (anchor) {
                    e.preventDefault()
                    const href = anchor.getAttribute('href')
                    if (href && !href.startsWith('javascript:')) {
                        window.open(href, '_blank', 'noopener,noreferrer')
                    }
                }
            })
        }

        iframe.addEventListener('load', handleLoad)
        return () => iframe.removeEventListener('load', handleLoad)
    }, [srcdoc])

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
            {hasRemoteImages && !allowImages && (
                <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-2">
                        <ImageOff className="h-3.5 w-3.5 flex-shrink-0" />
                        Images in this message have been blocked to protect your privacy.
                    </span>
                    <button
                        type="button"
                        onClick={handleShowImages}
                        className="flex-shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                        Show images
                    </button>
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
                        filter: emailDarkMode ? 'invert(1) hue-rotate(180deg)' : undefined,
                        transition: 'filter 0.2s ease',
                    }}
                />
            </div>

            {expandable && (
                <Dialog open={isExpanded} onOpenChange={setIsExpanded}>
                    <DialogContent className="max-w-[95vw] w-[95vw] h-[92vh] flex flex-col p-0 gap-0 overflow-hidden">
                        <div className="flex-1 overflow-y-auto p-6">
                            <EmailHtmlViewer
                                html={html}
                                plainText={plainText}
                                emailDarkMode={emailDarkMode}
                                expandable={false}
                                senderEmail={senderEmail}
                            />
                        </div>
                    </DialogContent>
                </Dialog>
            )}
        </>
    )
}
