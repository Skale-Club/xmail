import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Script, createContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { inventoryProgram, readSshHost } from './xmail-database-rehearsal.mjs'

const directory = mkdtempSync(join(tmpdir(), 'xmail-ops-policy-'))
after(() => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\xmail-ops-policy-') || resolve(directory).startsWith(resolve(tmpdir()) + '/xmail-ops-policy-'))
    rmSync(directory, { recursive: true })
})
test('default plan works offline with no configured env, SSH or Docker executable', () => {
    const result = spawnSync(process.execPath, ['scripts/ops/xmail-database-rehearsal.mjs'], { encoding: 'utf8', env: { PATH: '' } })
    assert.equal(result.status, 0)
    assert.match(JSON.parse(result.stdout).status, /offline plan/)
})
test('no write flag or inherited configuration can activate the launcher', () => {
    const result = spawnSync(process.execPath, ['scripts/ops/xmail-database-rehearsal.mjs', '--apply'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
})
test('SSH host reader extracts only the explicitly declared IPv4, refusing duplicates or shell syntax', () => {
    const file = join(directory, 'explicit-source.fixture')
    writeFileSync(file, 'HETZNER_IP="192.0.2.10"\nHETZNER_SSH_KEY=unused-placeholder\nDATABASE_URL=never-consumed\n')
    assert.equal(readSshHost(file), '192.0.2.10')
    for (const body of ['HETZNER_IP=192.0.2.10\nHETZNER_IP=192.0.2.11', 'HETZNER_IP=192.0.2.10;command', 'HETZNER_IP=999.1.1.1']) {
        writeFileSync(file, body)
        assert.throws(() => readSshHost(file))
    }
})
test('remote inventory and both embedded shell Node helpers parse without executing anything', () => {
    assert.doesNotThrow(() => new Script(inventoryProgram))
    const shell = readFileSync('scripts/ops/xmail-database-rehearsal.sh', 'utf8')
    const blocks = [...shell.matchAll(/(?:ca_program|environment_program)=\$\(cat <<'NODE'\r?\n([\s\S]*?)\r?\nNODE\r?\n\)/g)]
    assert.equal(blocks.length, 2)
    for (const block of blocks) assert.doesNotThrow(() => new Script(block[1]))
})
test('source validation rejects wrong project/user/db/port/query and global TLS weakening before any fetch/connect', async () => {
    const expected = 'zzbudkfkcmqkavgwselc'
    const base = new URL(`postgres://postgres.${expected}:${randomUUID()}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`)
    const cases = [
        ['SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co'],
        ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
        ...[
            url => { url.username = 'postgres.wrongproject' }, url => { url.pathname = '/other' },
            url => { url.port = '5433' }, url => { url.hash = 'fragment' },
            url => { url.search = 'options=-c%20row_security=off' },
            url => { url.search = 'sslmode=require&sslmode=verify-full' },
            url => { url.search = 'sslmode=disable' },
        ].map(change => { const url = new URL(base); change(url); return ['DATABASE_URL', url.href] }),
    ]
    for (const [key, value] of cases) {
        let connected = false, fetched = false
        const stderr = []
        const processMock = { env: { NODE_ENV: 'production', DATABASE_URL: base.href, SUPABASE_URL: `https://${expected}.supabase.co`, [key]: value }, stderr: { write: text => stderr.push(text) } }
        const context = createContext({ URL, process: processMock, require: name => name === 'postgres' ? () => { connected = true } : {},
            fetch: () => { fetched = true; throw Error('Unexpected network') }, setTimeout: () => ({ unref() {} }), clearTimeout: () => {} })
        new Script(inventoryProgram).runInContext(context)
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(processMock.exitCode, 1)
        assert.equal(connected, false)
        assert.equal(fetched, false)
        assert.doesNotMatch(stderr.join(''), /postgres:\/\/|wrongproject|row_security|sslmode/)
    }
})
