import { and, eq, sql, type SQL } from 'drizzle-orm'
import { mailMessages } from '../../../db/schema'
import {
    containsPattern,
    normalizeFolderAlias,
    type ParsedMailSearch,
} from '../../lib/mail-search-query'

/**
 * Text of every recipient in a message's `to_addresses` jsonb array
 * ("Name address" per element). Matching on the extracted values rather than on
 * `to_addresses::text` keeps the JSON keys ("name", "address") from matching a
 * user's search term. Rows whose column is not an array (legacy double-encoded
 * values) simply have no recipients instead of aborting the whole query.
 */
function recipientMatches(pattern: string): SQL {
    return sql`exists (
        select 1
        from jsonb_array_elements(
            case when jsonb_typeof(${mailMessages.toAddresses}) = 'array'
                 then ${mailMessages.toAddresses}
                 else '[]'::jsonb end
        ) as recipient
        where (coalesce(recipient->>'name', '') || ' ' || coalesce(recipient->>'address', '')) ilike ${pattern}
    )`
}

function senderMatches(pattern: string): SQL {
    return sql`(${mailMessages.fromName} ilike ${pattern} or ${mailMessages.fromAddress} ilike ${pattern})`
}

function textMatches(pattern: string): SQL {
    return sql`(
        ${mailMessages.subject} ilike ${pattern}
        or ${mailMessages.fromName} ilike ${pattern}
        or ${mailMessages.fromAddress} ilike ${pattern}
        or ${mailMessages.plainBody} ilike ${pattern}
        or ${recipientMatches(pattern)}
    )`
}

const messageDate = sql`coalesce(${mailMessages.receivedAt}, ${mailMessages.remoteDate}, ${mailMessages.createdAt})`

export interface SearchConditionOptions {
    mailboxId: string
    /** Explicit folder (from `folderId`); wins over `in:` and the Trash/Spam exclusion. */
    folderId?: string
    /** Honour `in:<folder>` operators. The in-folder list search turns this off. */
    allowFolderOperator?: boolean
    /** Hide Trash and Spam unless `in:` or `folderId` asks for them. */
    excludeTrashSpamByDefault?: boolean
    /** Set to false when the caller already scopes to the mailbox and drops deleted rows. */
    includeBase?: boolean
}

/**
 * Turns a parsed search into SQL conditions for `mail_messages`. Always scoped
 * to `mailboxId` and never returns IMAP `\Deleted`-flagged rows.
 */
export function buildMailSearchConditions(parsed: ParsedMailSearch, options: SearchConditionOptions): SQL[] {
    const { mailboxId, folderId } = options
    const conditions: SQL[] = options.includeBase === false
        ? []
        : [
            eq(mailMessages.mailboxId, mailboxId),
            eq(mailMessages.isDeleted, false),
        ]

    for (const term of parsed.terms) conditions.push(textMatches(containsPattern(term)))
    for (const value of parsed.from) conditions.push(senderMatches(containsPattern(value)))
    for (const value of parsed.to) conditions.push(recipientMatches(containsPattern(value)))
    for (const value of parsed.subject) {
        conditions.push(sql`${mailMessages.subject} ilike ${containsPattern(value)}`)
    }

    if (parsed.hasAttachment !== null) conditions.push(eq(mailMessages.hasAttachments, parsed.hasAttachment))
    if (parsed.unread !== null) conditions.push(eq(mailMessages.isRead, !parsed.unread))
    if (parsed.starred) conditions.push(eq(mailMessages.isStarred, true))
    // `timestamp` columns hold UTC wall-clock time, so the bound is cast the same way.
    if (parsed.after) conditions.push(sql`${messageDate} >= ${parsed.after.toISOString()}::timestamp`)
    if (parsed.before) conditions.push(sql`${messageDate} < ${parsed.before.toISOString()}::timestamp`)

    // The folder subqueries name mail_folders with a literal alias on purpose: these conditions also
    // run inside db.query.mailMessages.findMany, and Drizzle's relational builder rewrites every
    // column reference in a raw sql`` template to the outer "mailMessages" alias, which turned
    // ${mailFolders.type} into "mailMessages"."type" (column does not exist -> 500 on every search).
    const folderOperators = options.allowFolderOperator === false ? [] : parsed.folders

    if (folderId) {
        conditions.push(eq(mailMessages.folderId, folderId))
    } else if (folderOperators.length > 0) {
        const wanted = folderOperators.map(normalizeFolderAlias)
        const folderChecks = wanted.map(value => sql`(
            lower(search_mf.type) = ${value}
            or lower(search_mf.name) = ${value}
            or lower(search_mf.remote_id) = ${value}
        )`)
        conditions.push(sql`${mailMessages.folderId} in (
            select search_mf.id from mail_folders search_mf
            where search_mf.mailbox_id = ${mailboxId}
            and (${sql.join(folderChecks, sql` or `)})
        )`)
    } else if (options.excludeTrashSpamByDefault) {
        conditions.push(sql`${mailMessages.folderId} not in (
            select search_mf.id from mail_folders search_mf
            where search_mf.mailbox_id = ${mailboxId}
            and search_mf.type in ('trash', 'spam')
        )`)
    }

    return conditions
}

export function combineConditions(conditions: SQL[]): SQL | undefined {
    return and(...conditions)
}
