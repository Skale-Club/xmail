import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PRODUCTION_PROJECT_REFS } from '../../../db/production-project-refs'
import {
    EXCLUDED_TABLES,
    SCRUBBED_COLUMNS,
    assertPullDestination,
    compareSchemas,
    foreignKeyOrder,
    isExcludedTable,
    isScrubbedColumn,
    truncationSet,
} from '../dev-db-pull'
import { readOnlyObjectStorage, type ObjectStorage } from '../object-storage'

const ref = 'abcdefghijklmnopqrst'
// Offline-only credentials are generated rather than committed as scanner findings.
const secret = randomUUID()
const good = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    NODE_ENV: 'development',
    XMAIL_DEV_SUPABASE_PROJECT_REF: ref,
    XMAIL_DEV_DATABASE_URL: `postgresql://postgres.${ref}:${secret}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
    ...extra,
})

describe('db:pull destination (pure)', () => {
    it('accepts only the declared Supabase development project', () => {
        expect(assertPullDestination(good()).projectRef).toBe(ref)
    })

    it('refuses a destination that resolves to production', () => {
        for (const productionRef of PRODUCTION_PROJECT_REFS) {
            expect(() => assertPullDestination(good({
                XMAIL_DEV_SUPABASE_PROJECT_REF: productionRef,
                XMAIL_DEV_DATABASE_URL: `postgresql://postgres.${productionRef}:${secret}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
            }))).toThrow(/production/i)
        }
    })

    it('refuses a production URL smuggled under a development ref, other hosts, production aliases and NODE_ENV=production', () => {
        expect(() => assertPullDestination(good({
            XMAIL_DEV_DATABASE_URL: `postgresql://postgres.${PRODUCTION_PROJECT_REFS[0]}:${secret}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
        }))).toThrow()
        expect(() => assertPullDestination(good({ XMAIL_DEV_DATABASE_URL: `postgres://u:${secret}@127.0.0.1:5432/postgres` }))).toThrow()
        expect(() => assertPullDestination(good({ XMAIL_DEV_DATABASE_URL: `postgres://u:${secret}@10.0.0.2:5432/xmail` }))).toThrow()
        expect(() => assertPullDestination(good({ NODE_ENV: 'production' }))).toThrow(/production/)
        // Only the production aliases: never a fallback.
        expect(() => assertPullDestination({ NODE_ENV: 'development', DATABASE_URL: `postgres://u:${secret}@db:5432/x`, DIRECT_URL: `postgres://u:${secret}@db:5432/x` })).toThrow()
    })
})

describe('db:pull table and secret rules (pure)', () => {
    it('keeps sign-in state local and copies mail data', () => {
        expect([...EXCLUDED_TABLES].sort()).toEqual(['xmail_identity_browser_challenges', 'xmail_identity_owned_sessions'])
        for (const table of EXCLUDED_TABLES) expect(isExcludedTable(table)).toBe(true)
        for (const table of ['users', 'mailboxes', 'mail_messages', 'inbox_attachments', 'domains']) expect(isExcludedTable(table)).toBe(false)
    })

    it('never copies native mailbox passwords, Outlook tokens or the Telegram token', () => {
        expect(SCRUBBED_COLUMNS).toEqual({
            mailboxes: ['smtp_password_encrypted', 'imap_password_encrypted'],
            email_accounts: ['smtp_password', 'imap_password'],
            smtp_endpoints: ['password', 'password_encrypted'],
            outlook_mailboxes: ['access_token_encrypted', 'refresh_token_encrypted'],
            system_integrations: ['telegram_bot_token'],
            webhooks: ['secret'],
            users: ['password_hash', 'two_factor_secret'],
        })
        expect(isScrubbedColumn('mailboxes', 'imap_password_encrypted')).toBe(true)
        expect(isScrubbedColumn('mailboxes', 'email')).toBe(false)
    })

    it('orders foreign keys parents first and rejects cycles', () => {
        const keys = [{ child: 'b', parent: 'a' }, { child: 'c', parent: 'b' }, { child: 'c', parent: 'c' }]
        expect(foreignKeyOrder(['c', 'b', 'a'], keys)).toEqual(['a', 'b', 'c'])
        expect(() => foreignKeyOrder(['a', 'b'], [{ child: 'a', parent: 'b' }, { child: 'b', parent: 'a' }])).toThrow(/cycle/)
    })

    it('empties tables that depend on copied ones, transitively', () => {
        const keys = [{ child: 'kept_session', parent: 'users' }, { child: 'kept_child', parent: 'kept_session' }]
        expect(truncationSet(['users'], ['users', 'kept_session', 'kept_child', 'other'], keys).sort()).toEqual(['kept_child', 'kept_session', 'users'])
    })

    it('reports schema drift in both directions', () => {
        const col = (column_name: string, udt_name = 'text', extra: object = {}) => ({
            column_name, data_type: udt_name, udt_name, is_generated: 'NEVER', identity_generation: null, is_nullable: 'YES', column_default: null, ...extra,
        })
        const diff = compareSchemas(
            new Map([['t', [col('id', 'int4'), col('new_col'), col('kind', 'int4')]], ['only_prod', [col('id')]], ['xmail_identity_owned_sessions', [col('token_hash')]]]),
            new Map([['t', [col('id', 'int4'), col('kind', 'text'), col('local_only', 'text', { is_nullable: 'NO' })]]]),
        )
        expect(diff.missingTables).toEqual(['only_prod']) // an excluded table is not required
        expect(diff.missingColumns).toEqual(['t.new_col'])
        expect(diff.changedColumns).toEqual(['t.kind (int4 -> text)'])
        expect(diff.requiredDestinationColumns).toEqual(['t.local_only'])
    })
})

describe('attachment storage is read-only in development', () => {
    it('reads through but refuses uploads and deletes', async () => {
        const calls: string[] = []
        const inner: ObjectStorage = {
            upload: async () => { calls.push('upload') },
            download: async () => { calls.push('download'); return Buffer.from('x') },
            createSignedUrl: async () => { calls.push('sign'); return 'https://signed.example/x' },
            remove: async () => { calls.push('remove') },
        }
        const storage = readOnlyObjectStorage(inner)
        await expect(storage.download('xmail-inbox-attachments', 'a')).resolves.toEqual(Buffer.from('x'))
        await expect(storage.createSignedUrl('xmail-inbox-attachments', 'a', 60)).resolves.toContain('signed')
        await expect(storage.upload('xmail-inbox-attachments', 'a', Buffer.from('x'), 'text/plain')).rejects.toThrow(/read-only/)
        await expect(storage.remove('xmail-inbox-attachments', ['a'])).rejects.toThrow(/read-only/)
        expect(calls).toEqual(['download', 'sign'])
    })
})
