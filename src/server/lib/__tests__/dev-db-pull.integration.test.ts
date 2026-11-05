import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { backupDestination, postgresJsDb, pullDatabase, readSchema, type Db } from '../dev-db-pull'

/**
 * Rehearsal on a disposable PostgreSQL: two throwaway databases stand in for production
 * and the development project. Needs XMAIL_PULL_TEST_DATABASE_URL (any database of a
 * disposable server) and XMAIL_PULL_TEST_SENTINEL=xmail-dev-db-pull-ci. Skipped without
 * them unless XMAIL_REQUIRE_PG=1 (CI), where a missing database must fail the run.
 */
const adminUrl = process.env.XMAIL_PULL_TEST_DATABASE_URL
const enabled = Boolean(adminUrl) && process.env.XMAIL_PULL_TEST_SENTINEL === 'xmail-dev-db-pull-ci'
if (process.env.XMAIL_REQUIRE_PG === '1' && !enabled) throw new Error('XMAIL_REQUIRE_PG=1 but the disposable pull-test database is not configured')

const suffix = randomBytes(4).toString('hex')
const names = { src: `xm_pull_src_${suffix}`, dst: `xm_pull_dst_${suffix}` }
const urlFor = (database: string) => {
    const url = new URL(adminUrl!)
    url.pathname = `/${database}`
    return url.toString()
}

const MAILBOX_SECRET = `mailbox-secret-${randomUUID()}`
const IMAP_SECRET = `imap-secret-${randomUUID()}`
const OUTLOOK_SECRET = `outlook-secret-${randomUUID()}`
const TELEGRAM_SECRET = `telegram-secret-${randomUUID()}`

const SCHEMA = (dest: boolean) => `
    create table users (
        id serial primary key, email text not null, password_hash text, two_factor_secret text, meta jsonb, tags text[], big bigint
        ${dest ? ', note text' : ''}
    );
    create table mailboxes (
        id serial primary key, user_id int not null references users(id), email text not null,
        smtp_password_encrypted text not null, imap_password_encrypted text not null
    );
    create table mail_messages (
        id serial primary key, mailbox_id int not null references mailboxes(id), parent_id int references mail_messages(id),
        body text not null ${dest ? "check (body <> 'poison')" : ''}
    );
    create table inbox_attachments (id serial primary key, message_id int references mail_messages(id), storage_path text not null);
    create table outlook_mailboxes (id serial primary key, access_token_encrypted text not null, refresh_token_encrypted text not null, token_expires_at timestamp not null);
    create table system_integrations (id text primary key, telegram_bot_token text, telegram_chat_id text);
    create table xmail_identity_owned_sessions (token_hash text primary key, user_id int not null references users(id));
    create table settings (id int generated always as identity primary key, data jsonb);
    ${dest ? 'create table dest_only (id serial primary key, user_id int references users(id));' : ''}
`

async function open(database: string): Promise<{ sql: postgres.Sql; db: Db }> {
    const sql = postgres(urlFor(database), { max: 1, prepare: false, onnotice: () => undefined })
    return { sql, db: postgresJsDb(sql) }
}

async function seedSource(db: Db, { poison = false } = {}) {
    await db.query(SCHEMA(false))
    await db.query(`insert into users (email, password_hash, two_factor_secret, meta, tags, big) values
        ('a@example.test', 'hash-a', 'totp-a', '{"k":[1,2]}', '{x,y}', 9007199254740993), ('b@example.test', 'hash-b', null, null, null, null)`)
    await db.query(`insert into mailboxes (user_id, email, smtp_password_encrypted, imap_password_encrypted) values (1, 'a@example.test', $1, $2)`, [MAILBOX_SECRET, IMAP_SECRET])
    await db.query(`insert into mail_messages (mailbox_id, parent_id, body) values (1, null, 'hello'), (1, 1, 'reply')${poison ? ", (1, 2, 'poison')" : ''}`)
    await db.query(`insert into inbox_attachments (message_id, storage_path) values (1, 'org/file.pdf')`)
    await db.query(`insert into outlook_mailboxes (access_token_encrypted, refresh_token_encrypted, token_expires_at) values ($1, $1, now())`, [OUTLOOK_SECRET])
    await db.query(`insert into system_integrations (id, telegram_bot_token, telegram_chat_id) values ('default', $1, 'chat-1')`, [TELEGRAM_SECRET])
    await db.query(`insert into xmail_identity_owned_sessions (token_hash, user_id) values ('prod-session', 1)`)
    await db.query(`insert into settings (data) values ('{"a":1}'), ('{"b":2}')`)
}

async function seedDestination(db: Db) {
    await db.query(SCHEMA(true))
    await db.query(`insert into users (email, note) values ('old@dev.test', 'dev-only')`)
    await db.query(`insert into xmail_identity_owned_sessions (token_hash, user_id) values ('dev-session', 1)`)
    await db.query(`insert into dest_only (user_id) values (1)`)
}

const count = async (db: Db, table: string) => Number((await db.query<{ n: string }>(`select count(*)::text n from ${table}`)).rows[0].n)

describe.skipIf(!enabled)('db:pull rehearsal on disposable PostgreSQL', () => {
    let admin: postgres.Sql
    let src: Awaited<ReturnType<typeof open>>
    let dst: Awaited<ReturnType<typeof open>>
    const dirs: string[] = []

    async function recreate(options: { poison?: boolean } = {}) {
        await src?.sql.end({ timeout: 2 }).catch(() => undefined)
        await dst?.sql.end({ timeout: 2 }).catch(() => undefined)
        for (const name of Object.values(names)) {
            await admin.unsafe(`drop database if exists ${name} with (force)`)
            await admin.unsafe(`create database ${name}`)
        }
        src = await open(names.src)
        dst = await open(names.dst)
        await seedSource(src.db, options)
        await seedDestination(dst.db)
    }

    beforeAll(async () => {
        admin = postgres(adminUrl!, { max: 1, prepare: false, onnotice: () => undefined })
    })

    afterAll(async () => {
        await src?.sql.end({ timeout: 2 }).catch(() => undefined)
        await dst?.sql.end({ timeout: 2 }).catch(() => undefined)
        for (const name of Object.values(names)) await admin.unsafe(`drop database if exists ${name} with (force)`).catch(() => undefined)
        await admin.end({ timeout: 2 })
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    })

    it('copies production data exactly, without any mailbox secret', async () => {
        await recreate()
        const result = await pullDatabase({ prod: src.db, dest: dst.db, destUrl: urlFor(names.dst) })
        expect(result.copied).toMatchObject({ users: 2, mailboxes: 1, mail_messages: 2, inbox_attachments: 1, settings: 2, outlook_mailboxes: 1 })
        expect(result.triggersDisabled).toBe(true)
        expect(result.scrubbed).toEqual(expect.arrayContaining([
            'mailboxes.smtp_password_encrypted', 'mailboxes.imap_password_encrypted',
            'outlook_mailboxes.access_token_encrypted', 'system_integrations.telegram_bot_token', 'users.password_hash',
        ]))

        const users = (await dst.db.query<{ email: string; meta: unknown; tags: string[]; big: string; note?: string }>('select email, meta, tags, big::text, note from users order by id')).rows
        expect(users.map(u => u.email)).toEqual(['a@example.test', 'b@example.test'])
        expect(users[0].meta).toEqual({ k: [1, 2] })
        expect(users[0].tags).toEqual(['x', 'y'])
        expect(users[0].big).toBe('9007199254740993') // beyond 2^53: must not round
        expect((await dst.db.query<{ id: number }>('select id from settings order by id')).rows.map(r => r.id)).toEqual([1, 2])

        // Secrets never reach the development database, in any column.
        const dump = JSON.stringify(await Promise.all(['users', 'mailboxes', 'outlook_mailboxes', 'system_integrations'].map(async t =>
            (await dst.db.query(`select * from ${t}`)).rows)))
        for (const leaked of [MAILBOX_SECRET, IMAP_SECRET, OUTLOOK_SECRET, TELEGRAM_SECRET, 'hash-a', 'totp-a']) expect(dump).not.toContain(leaked)
        expect((await dst.db.query<{ p: string; i: string }>('select smtp_password_encrypted p, imap_password_encrypted i from mailboxes')).rows[0]).toEqual({ p: '', i: '' })
        expect((await dst.db.query<{ t: string | null; c: string }>("select telegram_bot_token t, telegram_chat_id c from system_integrations")).rows[0]).toEqual({ t: null, c: 'chat-1' })
        expect((await dst.db.query<{ h: string | null }>('select password_hash h from users order by id')).rows.map(r => r.h)).toEqual([null, null])
    })

    it('keeps excluded sign-in state, empties its dependents, and never touches production data', async () => {
        await recreate()
        const before = await count(src.db, 'users')
        const result = await pullDatabase({ prod: src.db, dest: dst.db, destUrl: urlFor(names.dst) })
        // The excluded table references users, so it cannot survive replaced users: emptied, never refilled.
        expect(result.truncated).toEqual(expect.arrayContaining(['xmail_identity_owned_sessions', 'dest_only']))
        expect(await count(dst.db, 'xmail_identity_owned_sessions')).toBe(0)
        expect(await count(src.db, 'xmail_identity_owned_sessions')).toBe(1) // production untouched
        expect(await count(src.db, 'users')).toBe(before)
        // The production snapshot transaction is read-only.
        await src.db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        await expect(src.db.query("insert into settings (data) values ('{}')")).rejects.toThrow()
        await src.db.query('ROLLBACK')
    })

    it('rolls back everything when the destination rejects a row, leaving it as it was', async () => {
        await recreate({ poison: true })
        await expect(pullDatabase({ prod: src.db, dest: dst.db, destUrl: urlFor(names.dst) })).rejects.toThrow(/destination unchanged/)
        expect((await dst.db.query<{ email: string }>('select email from users')).rows.map(r => r.email)).toEqual(['old@dev.test'])
        expect(await count(dst.db, 'xmail_identity_owned_sessions')).toBe(1)
        expect(await count(dst.db, 'mail_messages')).toBe(0)
    })

    it('aborts on schema drift before changing the destination', async () => {
        await recreate()
        await src.db.query('alter table users add column extra text')
        await expect(pullDatabase({ prod: src.db, dest: dst.db, destUrl: urlFor(names.dst) })).rejects.toThrow(/schema mismatch.*users\.extra/)
        expect(await count(dst.db, 'users')).toBe(1)
    })

    it('refuses a production destination before connecting to anything', async () => {
        await expect(pullDatabase({
            prod: src.db, dest: dst.db,
            destUrl: 'postgresql://postgres.zzbudkfkcmqkavgwselc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
        })).rejects.toThrow(/production/)
    })

    it('writes a restorable JSON backup of the destination with owner-only permissions', async () => {
        await recreate()
        const dir = mkdtempSync(join(tmpdir(), 'xmail-pull-backup-'))
        dirs.push(dir)
        const file = await backupDestination(dst.db, dir, new Date('2026-01-02T03:04:05Z'))
        expect(existsSync(file)).toBe(true)
        const backup = JSON.parse(readFileSync(file, 'utf8')) as { tables: Record<string, Array<Record<string, unknown>>> }
        expect(backup.tables.users[0]).toMatchObject({ email: 'old@dev.test', note: 'dev-only' })
        expect([...(await readSchema(dst.db)).keys()]).toContain('dest_only')
    })
})
