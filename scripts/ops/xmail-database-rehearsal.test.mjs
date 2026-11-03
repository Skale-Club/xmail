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
test('remote helpers parse; holder preserves snapshot until release and reconciliation fails closed', async () => {
    assert.doesNotThrow(() => new Script(inventoryProgram))
    const shell = readFileSync('scripts/ops/xmail-database-rehearsal.sh', 'utf8')
    const blocks = [...shell.matchAll(/(ca_program|environment_program|holder_program|compare_program)=\$\(cat <<'NODE'\r?\n([\s\S]*?)\r?\nNODE\r?\n\)/g)]
    assert.equal(blocks.length, 4)
    for (const block of blocks) assert.doesNotThrow(() => new Script(block[2]))
    const programs = Object.fromEntries(blocks.map(block => [block[1], block[2]]))
    const counts = { ...Object.fromEntries(Array.from({ length: 68 }, (_, index) => [`fixture_${index}`, index])), users: 39, organization_users: 38 }
    const source = { version: 1, publicTableCount: 70, counts,
        digests: Object.fromEntries(['users', 'users_authority', 'organization_users', 'native_smtp_password_hashes'].map(name => [name, 'a'.repeat(64)])),
        nativePasswordHashCount: 37, platformAdminCount: 1, ledgerCount: 78, ledgerLatest: '078' }
    const compare = target => spawnSync(process.execPath, ['-e', programs.compare_program], {
        input: JSON.stringify(source) + '\n' + JSON.stringify(target) + '\n', encoding: 'utf8', timeout: 3000,
    })
    const matched = compare(structuredClone(source))
    assert.equal(matched.status, 0)
    assert.equal(JSON.parse(matched.stdout).table_counts_matched, 70)
    assert.equal(JSON.parse(matched.stdout).digest_groups_matched, 4)
    assert.ok(!matched.stdout.includes('a'.repeat(64)))
    const variants = [
        target => { target.counts.fixture_0++ }, target => { delete target.counts.fixture_0 },
        target => { target.digests.users = 'b'.repeat(64) },
        target => { target.digests.users_authority = 'b'.repeat(64) },
        target => { target.digests.organization_users = 'b'.repeat(64) },
        target => { target.digests.native_smtp_password_hashes = 'b'.repeat(64) },
        target => { target.nativePasswordHashCount-- }, target => { target.platformAdminCount++ },
        target => { target.ledgerLatest = '079' },
    ]
    for (const change of variants) {
        const target = structuredClone(source); change(target)
        const result = compare(target)
        assert.equal(result.status, 1)
        assert.equal(result.stdout, '')
        assert.equal(result.stderr, 'Snapshot reconciliation failed; values omitted.')
    }
    for (const releaseKind of ['DUMP_COMPLETE', 'EOF']) {
        let active = false, rolledBack = false, ended = false, command
        let release
        const output = [], errors = [], timeouts = []
        const ca = Buffer.from('offline-ca').toString('base64'), query = Buffer.from('offline-manifest-query').toString('base64')
        const incoming = [ca, query]
        const interfaceMock = { close() {}, [Symbol.asyncIterator]() { return { next: async () => {
            if (incoming.length) return { done: false, value: incoming.shift() }
            command = new Promise(resolve => { release = resolve }); return command
        } } } }
        const tx = { unsafe: async sql => {
            if (sql.includes('AS readable')) return [{ tables: 70, readable: 70, filtered: 0 }]
            if (sql.includes('pg_export_snapshot')) return [{ ro: 'on', snapshot: '00000001-00000002-1' }]
            if (sql === 'offline-manifest-query') return [{ manifest: source }]
            return []
        } }
        const database = { begin: async (mode, run) => {
            assert.equal(mode, 'isolation level repeatable read read only'); active = true
            try { return await run(tx) } catch (error) { rolledBack = true; throw error } finally { active = false }
        }, end: async () => { ended = true } }
        const pg = (_url, options) => { assert.equal(options.ssl.rejectUnauthorized, true); return database }
        const context = createContext({ URL, Buffer, process: { env: { NODE_ENV: 'production',
            DATABASE_URL: `postgres://postgres.zzbudkfkcmqkavgwselc:${randomUUID()}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
            SUPABASE_URL: 'https://zzbudkfkcmqkavgwselc.supabase.co' }, stdin: {}, stdout: { write: text => output.push(text) }, stderr: { write: text => errors.push(text) } },
        require: name => name === 'postgres' ? pg : name === 'node:readline' ? { createInterface: () => interfaceMock } : {
            X509Certificate: class { ca = true; fingerprint256 = '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'; validFrom = '2020-01-01'; validTo = '2100-01-01' },
        }, setTimeout: (_fn, ms) => { timeouts.push(ms); return { unref() {} } }, clearTimeout() {} })
        const completion = new Script(programs.holder_program).runInContext(context)
        await new Promise(resolve => setImmediate(resolve))
        assert.equal(active, true)
        assert.equal(ended, false)
        assert.equal(output.length, 2)
        assert.equal(typeof release, 'function')
        assert.deepEqual(timeouts, [210000])
        release(releaseKind === 'EOF' ? { done: true } : { done: false, value: 'DUMP_COMPLETE' })
        await completion
        assert.equal(active, false)
        assert.equal(rolledBack, true)
        assert.equal(ended, true)
        if (releaseKind === 'DUMP_COMPLETE') assert.equal(output.at(-1), 'SOURCE_CLOSED\n')
        else { assert.equal(output.length, 2); assert.equal(errors.join(''), 'Snapshot holder failed; details omitted.') }
    }
    const descriptors = shell.slice(shell.indexOf('holder_pid=$SNAPSHOT_HOLDER_PID'), shell.indexOf('base64 -w 0 "$work/source-ca.crt"'))
    assert.ok(descriptors.includes('holder_original_input'))
    for (const complete of [true, false]) {
        // Exercise the real Bash descriptor setup with a local fake holder only.
        // No Docker, SSH, environment file or database participates.
        const flow = spawnSync(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash', ['-c', `
set -Eeuo pipefail
coproc SNAPSHOT_HOLDER {
 IFS= read -r first; IFS= read -r second
 printf 'SNAPSHOT\\nMANIFEST\\n'
 if IFS= read -r command; then [[ $command == DUMP_COMPLETE ]]; printf 'SOURCE_CLOSED\\n'; else exit 9; fi
}
${descriptors}
printf 'CA\\nSQL\\n' >&"$holder_input"
IFS= read -r -t 1 snapshot <&"$holder_output"
IFS= read -r -t 1 manifest <&"$holder_output"
[[ $snapshot == SNAPSHOT && $manifest == MANIFEST ]]
${complete ? 'printf "DUMP_COMPLETE\\n" >&"$holder_input"' : ':'}
exec {holder_input}>&-
${complete ? 'IFS= read -r -t 1 status <&"$holder_output"; [[ $status == SOURCE_CLOSED ]]; wait "$holder_pid"' : 'if wait "$holder_pid"; then exit 2; fi'}
exec {holder_output}<&-
printf 'PIPE_CLOSED\\n'
`], { encoding: 'utf8', timeout: 3000 })
        assert.equal(flow.status, 0, flow.stderr)
        assert.equal(flow.stdout, 'PIPE_CLOSED\n')
    }
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
