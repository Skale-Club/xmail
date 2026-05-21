/**
 * Process Replies to Outreach Emails
 *
 * This job checks IMAP inboxes for replies to outreach emails:
 * - Connects to each email account's IMAP server
 * - Checks for new messages in INBOX
 * - Matches replies to sent outreach emails via Message-ID or In-Reply-To headers
 * - Updates outreach_emails.repliedAt
 * - Updates campaign_leads.status to 'replied' (stops sequence)
 * - Updates leads.status and leads.lastRepliedAt
 * - Increments campaign and account reply stats
 */

import { ImapFlow } from 'imapflow'
import { db } from '../../db'
import { emailAccounts, outreachEmails, campaignLeads, leads, campaigns } from '../../db/schema'
import { eq, and, isNotNull, sql, gte } from 'drizzle-orm'
import { decryptSecret } from '../lib/crypto'
import { createLogger } from '../lib/logger'

const log = createLogger('outreach.replies')

interface ProcessRepliesResult {
    processed: number
    replies: number
    errors: number
}

interface EmailAccountWithImap {
    id: string
    email: string
    imapHost: string | null
    imapPort: number | null
    imapUsername: string | null
    imapPassword: string | null
    imapSecure: boolean | null
}

interface OutreachEmailWithRelations {
    id: string
    campaignLeadId: string
    campaignId: string
    emailAccountId: string
    leadId: string
}

export async function processReplies(): Promise<ProcessRepliesResult> {
    const result: ProcessRepliesResult = {
        processed: 0,
        replies: 0,
        errors: 0,
    }

    const accounts = await db
        .select({
            id: emailAccounts.id,
            email: emailAccounts.email,
            imapHost: emailAccounts.imapHost,
            imapPort: emailAccounts.imapPort,
            imapUsername: emailAccounts.imapUsername,
            imapPassword: emailAccounts.imapPassword,
            imapSecure: emailAccounts.imapSecure,
        })
        .from(emailAccounts)
        .where(
            and(
                eq(emailAccounts.status, 'verified'),
                isNotNull(emailAccounts.imapHost),
                isNotNull(emailAccounts.imapUsername),
                isNotNull(emailAccounts.imapPassword)
            )
        )

    for (const account of accounts) {
        try {
            const replyCount = await processAccountReplies(account)
            result.processed++
            result.replies += replyCount
        } catch (error) {
            result.errors++
            const err = error instanceof Error ? error : new Error(String(error))
            log.error({
                action: 'outreach.replies.account_error',
                emailAccountId: account.id,
                email: account.email,
                error: { message: err.message, stack: err.stack },
            }, 'account processing failed')
        }
    }

    return result
}

async function processAccountReplies(account: EmailAccountWithImap): Promise<number> {
    let replyCount = 0
    let client: ImapFlow | null = null

    const password = decryptSecret(account.imapPassword!)

    try {
        client = new ImapFlow({
            host: account.imapHost!,
            port: account.imapPort || 993,
            secure: account.imapSecure !== false,
            auth: {
                user: account.imapUsername!,
                pass: password,
            },
            logger: false,
        })

        await client.connect()

        const lock = await client.getMailboxLock('INBOX')
        try {
            // Phase 16 — cap IMAP search to last 7 days + 500 UIDs per tick.
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
            const allUids = await client.search({ seen: false, since: sevenDaysAgo }, { uid: true })
            if (!allUids || allUids.length === 0) {
                return replyCount
            }
            const MAX_PER_TICK = 500
            let uids: number[] = allUids
            if (allUids.length > MAX_PER_TICK) {
                log.warn({
                    action: 'outreach.replies.defer_overflow',
                    emailAccountId: account.id,
                    totalUids: allUids.length,
                    processing: MAX_PER_TICK,
                }, 'IMAP search exceeded per-tick cap')
                uids = allUids.slice(0, MAX_PER_TICK)
            }

            for (const uid of uids) {
                try {
                    const msg = await client.fetchOne(uid.toString(), {
                        headers: [
                            'in-reply-to',
                            'references',
                            'from',
                            'subject',
                            'auto-submitted',
                            'precedence',
                            'x-auto-response-suppress',
                        ],
                    }, { uid: true })

                    if (!msg || !msg.headers) continue

                    const headerText = msg.headers.toString('utf8')

                    // Parse headers we care about.
                    const inReplyTo = headerText.match(/^In-Reply-To:\s*(.+)$/im)?.[1]?.trim() ?? null
                    const references = headerText.match(/^References:\s*(.+)$/im)?.[1]?.trim() ?? null
                    const fromHeader = headerText.match(/^From:\s*(.+)$/im)?.[1]?.trim() ?? null
                    // Extract bare email from `Name <email@domain>` or fall back to whole string.
                    const fromAddress = fromHeader
                        ? (fromHeader.match(/<([^>]+)>/)?.[1]?.trim() ?? fromHeader.trim())
                        : null

                    // Tier 0 — auto-reply short-circuit.
                    const auto = isAutoReply({ raw: headerText })

                    // Resolve any outreach_email this message refers to (for both the auto-reply tag
                    // path and the genuine-reply path).
                    const matched = await matchReplyToOutreach(
                        { inReplyTo, references, fromAddress },
                        account.id,
                    )

                    if (auto.auto) {
                        if (matched) {
                            await markAsAutoReply(matched.outreachEmail.id)
                            log.info({
                                action: 'outreach.replies.match',
                                decision: 'auto_reply',
                                signal: auto.signal,
                                matchStrategy: matched.strategy,
                                emailAccountId: account.id,
                                campaignId: matched.outreachEmail.campaignId,
                                leadId: matched.outreachEmail.leadId,
                                campaignLeadId: matched.outreachEmail.campaignLeadId,
                            }, 'auto-reply matched to outreach email')
                        } else {
                            log.info({
                                action: 'outreach.replies.match',
                                decision: 'auto_reply',
                                signal: auto.signal,
                                matchStrategy: 'unmatched',
                                emailAccountId: account.id,
                            }, 'auto-reply not matched')
                        }
                        try {
                            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
                        } catch { /* ignore */ }
                        continue
                    }

                    if (matched) {
                        await markAsReplied(
                            matched.outreachEmail.id,
                            matched.outreachEmail.campaignLeadId,
                            matched.outreachEmail.leadId,
                            matched.outreachEmail.campaignId,
                            matched.outreachEmail.emailAccountId,
                        )
                        replyCount++
                        log.info({
                            action: 'outreach.replies.match',
                            decision: 'replied',
                            matchStrategy: matched.strategy,
                            emailAccountId: account.id,
                            campaignId: matched.outreachEmail.campaignId,
                            leadId: matched.outreachEmail.leadId,
                            campaignLeadId: matched.outreachEmail.campaignLeadId,
                        }, 'reply matched and marked')
                        try {
                            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
                        } catch { /* ignore */ }
                    } else {
                        log.info({
                            action: 'outreach.replies.match',
                            decision: 'unmatched',
                            emailAccountId: account.id,
                            hasInReplyTo: inReplyTo !== null,
                            hasReferences: references !== null,
                            hasFrom: fromAddress !== null,
                        }, 'message did not match any outreach email')
                        // Do NOT flag unmatched messages as Seen — they may be legitimate human emails
                        // unrelated to outreach. Leaving them unread preserves user-visible state.
                    }
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error))
                    log.error({
                        action: 'outreach.replies.uid_error',
                        uid,
                        emailAccountId: account.id,
                        error: { message: err.message, stack: err.stack },
                    }, 'failed to process UID')
                }
            }
        } finally {
            lock.release()
        }
    } finally {
        if (client) {
            try {
                await client.logout()
            } catch {
                // Ignore logout errors
            }
        }
    }

    return replyCount
}

function extractFirstReference(references: string | null): string | null {
    if (!references) return null
    const refs = references.split(/\s+/).filter(Boolean)
    return refs.length > 0 ? refs[0] : null
}

// Phase 16 — AUTO-REPLY-FILTER. The OOO subject regex covers EN + PT + ES because
// SkaleClub's target users may run multi-lingual lead lists. Err on stricter side:
// false negatives (missing an OOO) are recoverable — the lead is just paused for the
// next step — whereas false positives (treating a real reply as OOO) lose conversion.
const OOO_SUBJECT_RE = /^(re:\s*)?(out of office|auto[- ]?reply|automatic reply|on vacation|out of the office|fora do escrit[oó]rio|aus[eê]ncia|ausente|fuera de la oficina)/i

export function isAutoReply(input: { raw: string }): {
    auto: boolean
    signal?: 'auto_submitted' | 'precedence' | 'x_auto_response' | 'subject_ooo'
} {
    const raw = input.raw

    const autoSubmitted = raw.match(/^Auto-Submitted:\s*(.+)$/im)?.[1]?.trim().toLowerCase()
    if (autoSubmitted === 'auto-replied' || autoSubmitted === 'auto-generated') {
        return { auto: true, signal: 'auto_submitted' }
    }

    const precedence = raw.match(/^Precedence:\s*(.+)$/im)?.[1]?.trim().toLowerCase()
    if (precedence === 'auto_reply' || precedence === 'bulk' || precedence === 'junk') {
        return { auto: true, signal: 'precedence' }
    }

    const xAutoResp = raw.match(/^X-Auto-Response-Suppress:\s*(.+)$/im)?.[1]?.trim().toLowerCase()
    if (xAutoResp === 'all') {
        return { auto: true, signal: 'x_auto_response' }
    }

    const subject = raw.match(/^Subject:\s*(.+)$/im)?.[1]?.trim()
    if (subject && OOO_SUBJECT_RE.test(subject)) {
        return { auto: true, signal: 'subject_ooo' }
    }

    return { auto: false }
}

// Phase 16 — REPLY-DETECT-V2. 3-tier matcher; tries in priority order.
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export async function matchReplyToOutreach(
    headers: { inReplyTo: string | null; references: string | null; fromAddress: string | null },
    accountId: string,
    now: Date = new Date(),
): Promise<{ outreachEmail: OutreachEmailWithRelations; strategy: 'in_reply_to' | 'references' | 'from_address' } | null> {
    // Tier 1: In-Reply-To exact match.
    if (headers.inReplyTo) {
        const hit = await findOutreachEmailByMessageId(headers.inReplyTo)
        if (hit) return { outreachEmail: hit, strategy: 'in_reply_to' }
    }

    // Tier 2: References chain — split on whitespace, try each token.
    if (headers.references) {
        const tokens = headers.references.split(/\s+/).filter(Boolean)
        for (const tok of tokens) {
            const hit = await findOutreachEmailByMessageId(tok)
            if (hit) return { outreachEmail: hit, strategy: 'references' }
        }
    }

    // Tier 3: from-address heuristic. Co-conditions:
    //   - leads.email matches headers.fromAddress (case-insensitive via LOWER())
    //   - outreach_email exists for that lead on this emailAccountId
    //   - outreach_email.sentAt within the last 30 days
    // Returns the most-recent matching outreach_email so the right step is stamped.
    if (headers.fromAddress) {
        const cutoff = new Date(now.getTime() - THIRTY_DAYS_MS)
        const fromLower = headers.fromAddress.toLowerCase().trim()

        const rows = await db
            .select({
                id: outreachEmails.id,
                campaignLeadId: outreachEmails.campaignLeadId,
                campaignId: outreachEmails.campaignId,
                emailAccountId: outreachEmails.emailAccountId,
                leadId: campaignLeads.leadId,
            })
            .from(outreachEmails)
            .innerJoin(campaignLeads, eq(outreachEmails.campaignLeadId, campaignLeads.id))
            .innerJoin(leads, eq(campaignLeads.leadId, leads.id))
            .where(
                and(
                    eq(outreachEmails.emailAccountId, accountId),
                    sql`LOWER(${leads.email}) = ${fromLower}`,
                    gte(outreachEmails.sentAt, cutoff),
                )
            )
            .orderBy(sql`${outreachEmails.sentAt} DESC NULLS LAST`)
            .limit(1)

        if (rows[0]) {
            return { outreachEmail: rows[0], strategy: 'from_address' }
        }
    }

    return null
}

// Phase 16 — auto-reply marker. Does NOT change campaign_leads.status (sequence keeps going).
async function markAsAutoReply(outreachEmailId: string): Promise<void> {
    await db.update(outreachEmails)
        .set({
            bounceReason: 'auto_reply',
            updatedAt: new Date(),
        })
        .where(eq(outreachEmails.id, outreachEmailId))
}

export async function findOutreachEmailByMessageId(messageId: string): Promise<OutreachEmailWithRelations | null> {
    const cleanMessageId = messageId.replace(/[<>]/g, '').trim()

    const result = await db
        .select({
            id: outreachEmails.id,
            campaignLeadId: outreachEmails.campaignLeadId,
            campaignId: outreachEmails.campaignId,
            emailAccountId: outreachEmails.emailAccountId,
            leadId: campaignLeads.leadId,
        })
        .from(outreachEmails)
        .innerJoin(campaignLeads, eq(outreachEmails.campaignLeadId, campaignLeads.id))
        .where(eq(outreachEmails.messageId, cleanMessageId))
        .limit(1)

    return result[0] || null
}

export async function markAsReplied(
    outreachEmailId: string,
    campaignLeadId: string,
    leadId: string,
    campaignId: string,
    accountId: string
): Promise<void> {
    const now = new Date()

    await Promise.all([
        db.update(outreachEmails).set({ repliedAt: now }).where(eq(outreachEmails.id, outreachEmailId)),

        db
            .update(campaignLeads)
            .set({
                status: 'replied',
                lastRepliedAt: now,
                totalReplies: sql`${campaignLeads.totalReplies} + 1`,
            })
            .where(eq(campaignLeads.id, campaignLeadId)),

        db
            .update(leads)
            .set({
                status: sql`CASE WHEN ${leads.status} IN ('replied', 'interested', 'not_interested') THEN ${leads.status} ELSE 'replied' END`,
                lastRepliedAt: now,
                totalReplies: sql`${leads.totalReplies} + 1`,
            })
            .where(eq(leads.id, leadId)),

        db
            .update(campaigns)
            .set({
                totalReplies: sql`${campaigns.totalReplies} + 1`,
            })
            .where(eq(campaigns.id, campaignId)),

        db
            .update(emailAccounts)
            .set({
                totalReplies: sql`${emailAccounts.totalReplies} + 1`,
            })
            .where(eq(emailAccounts.id, accountId)),
    ])
}
