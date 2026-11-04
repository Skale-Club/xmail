import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Script } from 'node:vm'

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const script = resolve('scripts/ops/import-private-postgres-candidate.sh')
const loader = resolve('scripts/ops/xmail-database-protocol.sh')
const directory = mkdtempSync(join(tmpdir(), 'xmail-candidate-policy-'))
const protocol = join(directory, 'protocol.sh')
const source = readFileSync('scripts/ops/xmail-database-rehearsal.sh', 'utf8').replace(/\r\n/g, '\n')
writeFileSync(protocol, source)
after(() => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '/xmail-candidate-policy-') || resolve(directory).startsWith(resolve(tmpdir()) + '\\xmail-candidate-policy-'))
    rmSync(directory, { recursive: true })
})
const run = (text, args = [], options = {}) => spawnSync(bash, ['-c', text, '--', ...args], { encoding: 'utf8', timeout: 4000, ...options })

test('candidate defaults to an offline plan and rejects target/owner overrides before operations', () => {
    const plan = spawnSync(bash, [script], { encoding: 'utf8', timeout: 3000 })
    assert.equal(plan.status, 0)
    assert.match(plan.stdout, /PLAN ONLY/)
    assert.match(plan.stdout, /e12scyfsrp822dag7m9wwd4x/)
    assert.match(plan.stdout, /Never remove\/reset the persistent candidate/)
    for (const args of [['--apply'], ['--execute-reviewed-import', '--target', 'other'], ['--execute-reviewed-import', '--owner', 'other']]) {
        const response = spawnSync(bash, [script, ...args], { encoding: 'utf8', timeout: 3000 })
        assert.equal(response.status, 2)
        assert.equal(response.stdout, '')
    }
})

test('shared loader extracts byte-identical reviewed blocks and rejects a changed source protocol', () => {
    for (const name of ['ca_program', 'environment_program', 'manifest_sql', 'holder_program', 'compare_program']) {
        const result = run('source "$1"; load_xmail_v2_protocol "$2" || exit $?; printf "%s" "${!3}"', [loader, protocol, name])
        assert.equal(result.status, 0, result.stderr)
        const marker = name === 'manifest_sql' ? 'SQL' : 'NODE'
        const expected = source.match(new RegExp(`${name}=\\$\\(cat <<'${marker}'\\n([\\s\\S]*?)\\n${marker}\\n\\)`))?.[1]
        assert.equal(result.stdout, expected)
        if (name !== 'manifest_sql') assert.doesNotThrow(() => new Script(result.stdout))
    }
    const changed = join(directory, 'changed.sh'); writeFileSync(changed, source + '\n# changed\n')
    const result = run('source "$1"; load_xmail_v2_protocol "$2"', [loader, changed])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
})

test('capacity admission checks both host filesystems and rejects memory-backed work storage', () => {
    const text = readFileSync(script, 'utf8').replace(/\r\n/g, '\n')
    const capacity = text.slice(text.indexOf('check_capacity() {'), text.indexOf('\ncheck_capacity\n'))
    assert.ok(capacity.includes('work_disk'))
    for (const [opt, tmp, filesystem, expected] of [
        [3145728, 3145728, 'ext2/ext3', 0], [3145728, 3145727, 'ext2/ext3', 2],
        [3145727, 3145728, 'ext2/ext3', 2], [9999999, 9999999, 'tmpfs', 2], [9999999, 9999999, 'ramfs', 2],
    ]) {
        const result = run(`
set -Eeuo pipefail
opt=$1; tmp=$2; filesystem=$3
awk() { if [[ $1 == *MemAvailable* ]]; then printf '1048576'; elif [[ $1 == *SwapTotal* ]]; then printf '0'; else command awk "$@"; fi; }
df() { if [[ $2 == /opt ]]; then printf 'filesystem 9999999 0 %s 0%% /opt\\n' "$opt"; else printf 'filesystem 9999999 0 %s 0%% /tmp\\n' "$tmp"; fi; }
stat() { printf '%s' "$filesystem"; }
${capacity}
check_capacity
`, [String(opt), String(tmp), filesystem])
        assert.equal(result.status, expected, result.stderr)
    }
    const targetCapacity = text.slice(text.indexOf('check_target_capacity() {'), text.indexOf('\ncheck_target_capacity\n'))
    for (const [free, filesystem, expected] of [[2097152, 'ext2/ext3', 0], [2097151, 'ext2/ext3', 2], [9999999, 'tmpfs', 2]]) {
        const result = run(`
set -Eeuo pipefail
work=$1; free=$2; filesystem=$3; target=offline-candidate
docker() { if [[ $3 == df ]]; then printf 'filesystem 9999999 0 %s 0%% /data\\n' "$free"; elif [[ $3 == stat ]]; then printf '%s' "$filesystem"; else return 2; fi; }
${targetCapacity}
check_target_capacity
`, [directory, String(free), filesystem])
        assert.equal(result.status, expected, result.stderr)
    }
})

test('cleanup never stops/removes the persistent UUID, its volume or any backup directory', () => {
    const body = readFileSync(script, 'utf8').replace(/\r\n/g, '\n')
    const cleanup = body.slice(body.indexOf('cleanup() {'), body.indexOf('\ntrap cleanup EXIT'))
    const marker = join(directory, 'cleanup-record')
    const check = run(`
set -Eeuo pipefail
record=$1; client=xmail-candidate-import-offline-client; nonce=offline; label_key=com.skale.xmail-candidate-import
holder_input=''; holder_output=''; target_input=''; target_output=''
work=/invalid-offline-fixture-path; backup_dir=/opt/xmail/backups/existing
docker() { if [[ $1 == inspect ]]; then printf 'offline'; elif [[ $1 == rm ]]; then printf '%s\\n' "$*" >>"$record"; else return 2; fi; }
${cleanup}
cleanup
`, [marker])
    assert.equal(check.status, 0, check.stderr)
    assert.equal(readFileSync(marker, 'utf8'), 'rm -f xmail-candidate-import-offline-client\n')
    assert.ok(!readFileSync(marker, 'utf8').includes('e12scyfsrp822dag7m9wwd4x'))
})

test('timeout filter preserves object/COPY contents and fails if the reviewed preamble changes', () => {
    const text = readFileSync(script, 'utf8').replace(/\r\n/g, '\n')
    const awk = text.match(/# COPY data[\s\S]*?awk '([\s\S]*?)' "\$work\/restore.sql"/)?.[1]
    assert.ok(awk)
    const preamble = ['statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'transaction_timeout'].map(name => `SET ${name} = 0;`).join('\n')
    const fixture = join(directory, 'restore.fixture')
    writeFileSync(fixture, preamble + '\n-- Name: retained\nCOPY fixture FROM stdin;\nSET statement_timeout = 0;\n\\.\n')
    const result = run('awk "$1" "$2"', [awk, fixture])
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '-- Name: retained\nCOPY fixture FROM stdin;\nSET statement_timeout = 0;\n\\.\n')
    writeFileSync(fixture, 'SET statement_timeout = 0;\n-- Name: retained\n')
    assert.equal(run('awk "$1" "$2"', [awk, fixture]).status, 2)
})

test('candidate report refuses changed security baselines and contains no credentials/digests', () => {
    const text = readFileSync(script, 'utf8').replace(/\r\n/g, '\n')
    const program = text.match(/candidate_report_program=\$\(cat <<'NODE'\n([\s\S]*?)\nNODE\n\)/)?.[1]
    assert.ok(program); assert.doesNotThrow(() => new Script(program))
    const base = { restore: 'passed', users: 39, organization_users: 38, public_tables: 70, native_password_hashes: 37,
        platform_admins: 1, table_counts_matched: 70, digest_groups_matched: 4, source_snapshot_comparison: 'matched_exported_repeatable_read_snapshot' }
    const call = report => spawnSync(process.execPath, ['-e', program], { input: JSON.stringify(report), encoding: 'utf8', timeout: 2000 })
    const result = call(base); assert.equal(result.status, 0)
    const report = JSON.parse(result.stdout)
    assert.equal(report.applicationCutover, false); assert.equal(report.persistentTargetPreserved, true)
    assert.equal(report.offHostBackup, 'not_verified')
    for (const change of [{ native_password_hashes: 36 }, { platform_admins: 2 }, { digest_groups_matched: 3 }, { users: 40 }]) {
        const failed = call({ ...base, ...change }); assert.equal(failed.status, 1); assert.equal(failed.stdout, '')
        assert.equal(failed.stderr, 'Candidate baseline reconciliation failed; values omitted.')
    }
})
