import net from 'node:net'
import type { AddressInfo } from 'node:net'
import bcrypt from 'bcrypt'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../test/postgres-harness'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const IDS = {
    user: 'e1000000-0000-4000-8000-000000000001',
    mailbox: 'e1000000-0000-4000-8000-000000000002',
    inbox: 'e1000000-0000-4000-8000-000000000003',
    trash: 'e1000000-0000-4000-8000-000000000004',
}

const EMAIL = 'imap-delete@example.test'
const PASSWORD = 'imap-test-password'

class RawImapClient {
    private readonly socket: net.Socket
    private buffer = ''
    private lines: string[] = []
    private waiters: Array<(line: string) => void> = []

    private constructor(socket: net.Socket) {
        this.socket = socket
        socket.on('data', (chunk) => {
            this.buffer += chunk.toString('utf8')
            while (this.buffer.includes('\r\n')) {
                const index = this.buffer.indexOf('\r\n')
                const line = this.buffer.slice(0, index)
                this.buffer = this.buffer.slice(index + 2)
                const waiter = this.waiters.shift()
                if (waiter) waiter(line)
                else this.lines.push(line)
            }
        })
    }

    static async connect(port: number): Promise<RawImapClient> {
        const socket = net.createConnection({ host: '127.0.0.1', port })
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve)
            socket.once('error', reject)
        })
        const client = new RawImapClient(socket)
        expect(await client.nextLine()).toMatch(/^\* OK /)
        return client
    }

    nextLine(timeoutMs = 5_000): Promise<string> {
        const existing = this.lines.shift()
        if (existing !== undefined) return Promise.resolve(existing)

        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timed out waiting for IMAP response')), timeoutMs)
            this.waiters.push((line) => {
                clearTimeout(timer)
                resolve(line)
            })
        })
    }

    async command(tag: string, command: string): Promise<string[]> {
        this.socket.write(`${tag} ${command}\r\n`)
        const response: string[] = []
        while (true) { // eslint-disable-line no-constant-condition
            const line = await this.nextLine()
            response.push(line)
            if (line.startsWith(`${tag} `)) return response
        }
    }

    send(line: string) {
        this.socket.write(`${line}\r\n`)
    }

    close() {
        this.socket.destroy()
    }
}

let sql: ReturnType<typeof postgres>
let imapServer: ReturnType<typeof import('../imap-server')['createIMAPServer']>
let closeApplicationDatabase: (() => Promise<void>) | undefined
let port: number

async function reservePort(): Promise<number> {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const selected = (server.address() as AddressInfo).port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return selected
}

async function seedMessage(uid: number, subject: string) {
    await sql`
        INSERT INTO mail_messages (
            mailbox_id, folder_id, message_id, subject, from_address,
            to_addresses, remote_uid, received_at, is_read, is_deleted
        ) VALUES (
            ${IDS.mailbox}::uuid, ${IDS.inbox}::uuid, ${`<message-${uid}@example.test>`},
            ${subject}, 'sender@example.test', '[{"address":"imap-delete@example.test"}]'::jsonb,
            ${uid}, NOW() + (${uid} * INTERVAL '1 second'), false, false
        )
    `
}

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    process.env.DATABASE_URL = testDatabaseUrl
    process.env.NODE_ENV = 'test'
    port = await reservePort()
    process.env.IMAP_PORT = String(port)

    sql = postgres(testDatabaseUrl, { max: 4, prepare: false })
    const passwordHash = await bcrypt.hash(PASSWORD, 4)
    await sql`
        INSERT INTO users (id, email, password_hash)
        VALUES (${IDS.user}::uuid, ${EMAIL}, ${passwordHash})
        ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash
    `
    await sql`
        INSERT INTO mailboxes (
            id, user_id, email,
            smtp_host, smtp_port, smtp_username, smtp_password_encrypted, smtp_secure,
            imap_host, imap_port, imap_username, imap_password_encrypted, imap_secure,
            is_native, is_default, is_active
        ) VALUES (
            ${IDS.mailbox}::uuid, ${IDS.user}::uuid, ${EMAIL},
            'localhost', 2587, ${EMAIL}, 'test', false,
            'localhost', ${port}, ${EMAIL}, 'test', false,
            true, true, true
        ) ON CONFLICT (id) DO NOTHING
    `
    await sql`
        INSERT INTO mail_folders (id, mailbox_id, remote_id, name, type, uid_validity, uid_next)
        VALUES
            (${IDS.inbox}::uuid, ${IDS.mailbox}::uuid, 'INBOX', 'Inbox', 'inbox', 1001, 4),
            (${IDS.trash}::uuid, ${IDS.mailbox}::uuid, 'Trash', 'Trash', 'trash', 1002, 1)
        ON CONFLICT (id) DO NOTHING
    `

    const module = await import('../imap-server')
    closeApplicationDatabase = (await import('../../db')).closeDatabaseConnection
    imapServer = module.createIMAPServer()
    imapServer.start()
})

beforeEach(async () => {
    await sql`DELETE FROM mail_messages WHERE mailbox_id = ${IDS.mailbox}::uuid`
    await sql`UPDATE mail_folders SET uid_next = CASE WHEN id = ${IDS.inbox}::uuid THEN 4 ELSE 1 END WHERE mailbox_id = ${IDS.mailbox}::uuid`
    await seedMessage(1, 'First')
    await seedMessage(2, 'Delete me')
    await seedMessage(3, 'Third')
})

afterAll(async () => {
    await imapServer?.close()
    await sql`DELETE FROM mail_messages WHERE mailbox_id = ${IDS.mailbox}::uuid`
    await sql`DELETE FROM mail_folders WHERE mailbox_id = ${IDS.mailbox}::uuid`
    await sql`DELETE FROM mailboxes WHERE id = ${IDS.mailbox}::uuid`
    await sql`DELETE FROM users WHERE id = ${IDS.user}::uuid`
    await closeApplicationDatabase?.()
    await sql?.end({ timeout: 1 })
})

describe('native IMAP deletion semantics', () => {
    it('moves a UID to Trash atomically and it stays gone after reconnecting', async () => {
        const client = await RawImapClient.connect(port)
        try {
            const capability = await client.command('A1', 'CAPABILITY')
            expect(capability.join('\n')).toMatch(/\bMOVE\b/)
            expect((await client.command('A2', `LOGIN "${EMAIL}" "${PASSWORD}"`)).at(-1)).toMatch(/^A2 OK/)
            expect((await client.command('A3', 'SELECT "INBOX"')).join('\n')).toContain('* 3 EXISTS')

            const moved = await client.command('A4', 'UID MOVE 2 "Trash"')
            expect(moved).toContain('* 2 EXPUNGE')
            expect(moved.at(-1)).toMatch(/^A4 OK \[COPYUID 1002 2 1\] UID MOVE completed$/)
            expect(await client.command('A5', 'NOOP')).toEqual(['A5 OK NOOP completed'])
        } finally {
            client.close()
        }

        const reconnected = await RawImapClient.connect(port)
        try {
            await reconnected.command('B1', `LOGIN "${EMAIL}" "${PASSWORD}"`)
            expect((await reconnected.command('B2', 'SELECT "INBOX"')).join('\n')).toContain('* 2 EXISTS')
            expect((await reconnected.command('B3', 'UID SEARCH ALL')).join('\n')).toContain('* SEARCH 1 3')
            expect((await reconnected.command('B4', 'SELECT "Trash"')).join('\n')).toContain('* 1 EXISTS')
            expect((await reconnected.command('B5', 'UID SEARCH ALL')).join('\n')).toContain('* SEARCH 1')
        } finally {
            reconnected.close()
        }

        const [source] = await sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM mail_messages
            WHERE folder_id = ${IDS.inbox}::uuid AND remote_uid = 2
        `
        const [destination] = await sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM mail_messages
            WHERE folder_id = ${IDS.trash}::uuid
        `
        expect(source.count).toBe(0)
        expect(destination.count).toBe(1)
    })

    it('keeps a deleted message in the selected view until CLOSE expunges it', async () => {
        const client = await RawImapClient.connect(port)
        try {
            await client.command('C1', `LOGIN "${EMAIL}" "${PASSWORD}"`)
            expect((await client.command('C2', 'SELECT "INBOX"')).join('\n')).toContain('* 3 EXISTS')

            expect((await client.command('C3', 'UID STORE 2 +FLAGS.SILENT (\\Deleted)')).at(-1)).toMatch(/^C3 OK/)
            expect(await client.command('C4', 'NOOP')).toEqual(['C4 OK NOOP completed'])
            expect((await client.command('C5', 'UID SEARCH ALL')).join('\n')).toContain('* SEARCH 1 2 3')
            expect((await client.command('C6', 'UID FETCH 2 (FLAGS)')).join('\n')).toMatch(/FLAGS \(\\Deleted\) UID 2/)

            const closed = await client.command('C7', 'CLOSE')
            expect(closed).toEqual(['C7 OK CLOSE completed'])
        } finally {
            client.close()
        }

        const reconnected = await RawImapClient.connect(port)
        try {
            await reconnected.command('D1', `LOGIN "${EMAIL}" "${PASSWORD}"`)
            expect((await reconnected.command('D2', 'SELECT "INBOX"')).join('\n')).toContain('* 2 EXISTS')
            expect((await reconnected.command('D3', 'UID SEARCH ALL')).join('\n')).toContain('* SEARCH 1 3')
        } finally {
            reconnected.close()
        }
    })

    it('reports stable sequence numbers for plain and UID EXPUNGE', async () => {
        const client = await RawImapClient.connect(port)
        try {
            await client.command('E1', `LOGIN "${EMAIL}" "${PASSWORD}"`)
            await client.command('E2', 'SELECT "INBOX"')
            await client.command('E3', 'UID STORE 1,3 +FLAGS.SILENT (\\Deleted)')
            const plain = await client.command('E4', 'EXPUNGE')
            expect(plain).toEqual(['* 3 EXPUNGE', '* 1 EXPUNGE', 'E4 OK EXPUNGE completed'])

            await seedMessage(4, 'Fourth')
            await client.command('E5', 'NOOP')
            await client.command('E6', 'UID STORE 4 +FLAGS.SILENT (\\Deleted)')
            const uid = await client.command('E7', 'UID EXPUNGE 4')
            expect(uid).toEqual(['* 2 EXPUNGE', 'E7 OK UID EXPUNGE completed'])
        } finally {
            client.close()
        }
    })

    it('notifies an IDLE session with EXPUNGE instead of decreasing EXISTS', async () => {
        const idle = await RawImapClient.connect(port)
        const actor = await RawImapClient.connect(port)
        try {
            await idle.command('I1', `LOGIN "${EMAIL}" "${PASSWORD}"`)
            await idle.command('I2', 'SELECT "INBOX"')
            await actor.command('J1', `LOGIN "${EMAIL}" "${PASSWORD}"`)
            await actor.command('J2', 'SELECT "INBOX"')

            idle.send('I3 IDLE')
            expect(await idle.nextLine()).toBe('+ idling')
            await actor.command('J3', 'UID MOVE 2 "Trash"')

            expect(await idle.nextLine()).toBe('* 2 EXPUNGE')
            idle.send('DONE')
            expect(await idle.nextLine()).toBe('I3 OK IDLE terminated')
        } finally {
            idle.close()
            actor.close()
        }
    })

    it('notifies an IDLE session when another connection changes flags', async () => {
        const idle = await RawImapClient.connect(port)
        const actor = await RawImapClient.connect(port)
        try {
            await idle.command('K1', `LOGIN "${EMAIL}" "${PASSWORD}"`)
            await idle.command('K2', 'SELECT "INBOX"')
            await actor.command('L1', `LOGIN "${EMAIL}" "${PASSWORD}"`)
            await actor.command('L2', 'SELECT "INBOX"')
            idle.send('K3 IDLE')
            expect(await idle.nextLine()).toBe('+ idling')

            await actor.command('L3', 'UID STORE 1 +FLAGS.SILENT (\\Seen \\Deleted)')
            expect(await idle.nextLine()).toBe('* 1 FETCH (FLAGS (\\Seen \\Deleted))')
            idle.send('DONE')
            expect(await idle.nextLine()).toBe('K3 OK IDLE terminated')
        } finally {
            idle.close()
            actor.close()
        }
    })

    it('supports sequence-number MOVE as advertised', async () => {
        const client = await RawImapClient.connect(port)
        try {
            await client.command('M1', `LOGIN "${EMAIL}" "${PASSWORD}"`)
            await client.command('M2', 'SELECT "INBOX"')
            const moved = await client.command('M3', 'MOVE 2 "Trash"')
            expect(moved).toContain('* 2 EXPUNGE')
            expect(moved.at(-1)).toMatch(/^M3 OK \[COPYUID 1002 2 1\] MOVE completed$/)
        } finally {
            client.close()
        }
    })

    it('copies into a folder with an independent UID namespace', async () => {
        const client = await RawImapClient.connect(port)
        try {
            await client.command('N1', `LOGIN "${EMAIL}" "${PASSWORD}"`)
            await client.command('N2', 'SELECT "INBOX"')
            const copied = await client.command('N3', 'UID COPY 2 "Trash"')
            expect(copied.at(-1)).toBe('N3 OK [COPYUID 1002 2 1] UID COPY completed')
            expect((await client.command('N4', 'UID SEARCH ALL')).join('\n')).toContain('* SEARCH 1 2 3')
        } finally {
            client.close()
        }

        const [destination] = await sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM mail_messages
            WHERE folder_id = ${IDS.trash}::uuid AND remote_uid = 1
        `
        expect(destination.count).toBe(1)
    })
})
