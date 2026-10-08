/**
 * Threading for sequence follow-ups (step 2 and later).
 *
 * A follow-up that goes out without In-Reply-To / References arrives as a brand new
 * conversation, so the prospect sees "email 2 of a stranger" instead of the thread they
 * already ignored once. This module turns "the lead's previous campaign email" into the
 * headers and the subject of the next one. It is pure on purpose: the lookup of the previous
 * email lives in the processor, next to the rest of the per-lead state.
 *
 * Ids are stored in outreach_emails unbracketed (the dispatcher strips the angle brackets), and
 * go onto the wire bracketed (RFC 5322 msg-id); the composer in outreach-provider.ts brackets
 * and de-duplicates again, so this stays correct even if one of the two layers changes.
 */

/**
 * Longest References chain a follow-up carries. RFC 5322 says to keep the root and drop the
 * middle of a long chain; a campaign sequence is a handful of steps, so this is a safety bound
 * against a runaway header, not something a real sequence reaches.
 */
export const MAX_REFERENCE_IDS = 10

export interface PreviousSentEmail {
    /** Message-ID of the lead's most recent sent campaign email, unbracketed as stored. */
    messageId: string
    /** That email's own References chain (null for the first email of the thread). */
    messageReferences: string | null
    /** Subject as stored for that email (the template, interpolated again at send time). */
    subject: string
}

export interface StepThreading {
    subject: string
    inReplyTo: string | null
    references: string | null
}

function bracket(messageId: string): string {
    const inner = messageId.replace(/[<>\s]/g, '')
    return inner ? `<${inner}>` : ''
}

/**
 * `Re: <previous subject>`, never `Re: Re: ...`. Only the English prefix is collapsed: the
 * subjects of this product are English (UI and copy), and guessing at other languages' reply
 * prefixes would only ever eat part of a real subject.
 */
export function replySubjectFor(previousSubject: string): string {
    const base = previousSubject.trim().replace(/^(?:re\s*:\s*)+/i, '').trim()
    return base ? `Re: ${base}` : ''
}

/**
 * The References chain for the next email in a thread: everything the previous email already
 * referenced, then the previous email itself, de-duplicated, oldest first, bounded to the last
 * MAX_REFERENCE_IDS.
 */
export function buildReferencesChain(
    previousReferences: string | null | undefined,
    previousMessageId: string,
): string {
    const chain: string[] = []
    const push = (id: string) => {
        const wrapped = bracket(id)
        if (wrapped && !chain.includes(wrapped)) chain.push(wrapped)
    }
    for (const part of (previousReferences ?? '').split(/\s+/)) push(part)
    push(previousMessageId)
    return chain.slice(-MAX_REFERENCE_IDS).join(' ')
}

/**
 * What a follow-up step sends, given the subject its step chose (A/B already applied) and the
 * lead's previous sent email in this campaign.
 *
 * - No previous email: a first send. Subject untouched, no threading headers.
 * - Previous email: In-Reply-To = its Message-ID, References = its chain plus its id.
 * - A blank subject means "send as a reply": `Re: <previous subject>`. A subject the step
 *   spells out is kept exactly as written, because the approved copy uses distinct subjects on
 *   purpose; the headers alone keep it in the thread for the clients that thread by header.
 *
 * A blank result subject is returned as-is (the caller must refuse to send it).
 */
export function planStepThreading(input: {
    subject: string
    previous: PreviousSentEmail | null
}): StepThreading {
    const { previous } = input
    if (!previous) return { subject: input.subject, inReplyTo: null, references: null }

    const inReplyTo = bracket(previous.messageId)
    if (!inReplyTo) return { subject: input.subject, inReplyTo: null, references: null }

    return {
        subject: input.subject.trim() ? input.subject : replySubjectFor(previous.subject),
        inReplyTo,
        references: buildReferencesChain(previous.messageReferences, previous.messageId),
    }
}
