import { htmlToText } from 'html-to-text'

export function htmlToPlainText(html: string): string {
    return htmlToText(html, {
        wordwrap: 130,
        selectors: [
            { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
            { selector: 'img', format: 'skip' },
        ],
    })
}

export interface MultipartAttachment {
    filename: string
    contentType: string
    content: Buffer
    /** When set, the part is emitted `Content-Disposition: inline` for CID-referenced images. */
    contentId?: string
}

/** RFC 2045 §6.8: base64 body lines must not exceed 76 characters. */
function base64Wrap(buffer: Buffer): string {
    const base64 = buffer.toString('base64')
    const lines: string[] = []
    for (let i = 0; i < base64.length; i += 76) {
        lines.push(base64.slice(i, i + 76))
    }
    return lines.join('\r\n')
}

export function createMultipartEmail(
    plainBody: string | undefined,
    htmlBody: string | undefined,
    attachments: MultipartAttachment[] = [],
): {
    headers: string[]
    body: string
} {
    const boundary = `----=_Part_${Math.random().toString(36).substring(2)}_${Date.now()}`

    // Build the text/html-or-plain part exactly as before. When there are no
    // attachments this IS the whole message (unchanged from before attachments
    // existed); when there are, it becomes the first part of an outer
    // multipart/mixed envelope below.
    let bodyHeaders: string[]
    let bodyLines: string[]

    if (htmlBody && plainBody) {
        bodyHeaders = [`Content-Type: multipart/alternative; boundary="${boundary}"`]
        bodyLines = [
            '',
            `--${boundary}`,
            'Content-Type: text/plain; charset=UTF-8',
            '',
            plainBody,
            '',
            `--${boundary}`,
            'Content-Type: text/html; charset=UTF-8',
            '',
            htmlBody,
            '',
            `--${boundary}--`,
        ]
    } else if (htmlBody && !plainBody) {
        const generatedPlain = htmlToPlainText(htmlBody)
        bodyHeaders = [`Content-Type: multipart/alternative; boundary="${boundary}"`]
        bodyLines = [
            '',
            `--${boundary}`,
            'Content-Type: text/plain; charset=UTF-8',
            '',
            generatedPlain,
            '',
            `--${boundary}`,
            'Content-Type: text/html; charset=UTF-8',
            '',
            htmlBody,
            '',
            `--${boundary}--`,
        ]
    } else {
        bodyHeaders = ['Content-Type: text/plain; charset=UTF-8']
        bodyLines = ['', plainBody || '']
    }

    if (attachments.length === 0) {
        return {
            headers: ['MIME-Version: 1.0', ...bodyHeaders],
            body: bodyLines.join('\r\n'),
        }
    }

    // Attachments present: wrap the alternative/plain part built above as the
    // first part of an outer multipart/mixed envelope, then append one part per
    // attachment, base64-encoded with 76-char lines (RFC 2045 §6.8).
    const mixedBoundary = `----=_Mixed_${Math.random().toString(36).substring(2)}_${Date.now()}`

    const parts: string[] = [
        '',
        `--${mixedBoundary}`,
        ...bodyHeaders,
        ...bodyLines,
        '',
    ]

    for (const attachment of attachments) {
        parts.push(`--${mixedBoundary}`)
        parts.push(`Content-Type: ${attachment.contentType}; name="${attachment.filename}"`)
        parts.push('Content-Transfer-Encoding: base64')
        parts.push(
            attachment.contentId
                ? `Content-Disposition: inline; filename="${attachment.filename}"`
                : `Content-Disposition: attachment; filename="${attachment.filename}"`,
        )
        if (attachment.contentId) {
            parts.push(`Content-ID: <${attachment.contentId}>`)
        }
        parts.push('')
        parts.push(base64Wrap(attachment.content))
        parts.push('')
    }
    parts.push(`--${mixedBoundary}--`)

    return {
        headers: ['MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`],
        body: parts.join('\r\n'),
    }
}
