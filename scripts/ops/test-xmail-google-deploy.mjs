#!/usr/bin/env node
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const workflowPath = new URL('../../.github/workflows/build-deploy.yml', import.meta.url)
const workflow = readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n')
const start = workflow.indexOf('            GOOGLE_RUNTIME_PARENT_DIR="/opt"')
const end = workflow.indexOf('            run_app_container() {', start)
assert.notEqual(start, -1, 'fixed runtime binding block must exist')
assert.notEqual(end, -1, 'run_app_container boundary must exist')
const originalBlock = workflow.slice(start, end)

function shellForFixture(parentPath) {
  const runtimeRoot = path.posix.join(parentPath, 'xmail')
  const block = originalBlock
    .replace('GOOGLE_RUNTIME_PARENT_DIR="/opt"', `GOOGLE_RUNTIME_PARENT_DIR="${parentPath}"`)
    .replace('GOOGLE_RUNTIME_ROOT="/opt/xmail"', `GOOGLE_RUNTIME_ROOT="${runtimeRoot}"`)
    .split('\n').map(line => line.startsWith('            ') ? line.slice(12) : line).join('\n')
  return `${block}
set +e
prepare_google_runtime_binding
status=$?
printf 'STATUS=%s\\n' "$status"
printf 'ARGS=%s\\n' "$GOOGLE_RUNTIME_ARGS"
`
}

function fixture() {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'xmail-google-deploy-'))
  const parent = path.join(temporary, 'opt')
  const root = path.join(parent, 'xmail')
  const ops = path.join(root, 'google-identity-ops')
  const runtime = path.join(root, 'google-identity-runtime')
  const envFile = path.join(ops, 'google-auth.env')
  const bin = path.join(temporary, 'bin')
  mkdirSync(ops, { recursive: true, mode: 0o700 })
  mkdirSync(runtime, { recursive: true, mode: 0o750 })
  mkdirSync(bin)
  chmodSync(parent, 0o755)
  chmodSync(root, 0o755)
  chmodSync(ops, 0o700)
  chmodSync(runtime, 0o750)

  const statShim = `#!/bin/bash
if [[ "$1" == "-c" ]]; then
  format="$2"
  shift 2
  [[ "$1" == "--" ]] && shift
  path="$1"
  if [[ "$format" == *"%s"* ]]; then
    actual=$( /usr/bin/stat -c '%a:%h:%s' -- "$path" ) || exit 1
  else
    actual=$( /usr/bin/stat -c '%a:%h' -- "$path" ) || exit 1
  fi
  if [[ "$TEST_STAT_OWNER" == "untrusted" ]]; then owner="1000:1000"; else owner="0:0"; fi
  printf '%s:%s\\n' "$owner" "$actual"
else
  exec /usr/bin/stat "$@"
fi
`
  const shimPath = path.join(bin, 'stat')
  writeFileSync(shimPath, statShim, { mode: 0o700 })
  chmodSync(shimPath, 0o700)

  const writeValidState = () => {
    writeFileSync(envFile, [
      'XMAIL_GOOGLE_AUTH_ENABLED=true',
      'XMAIL_GOOGLE_AUTH_ADC_FILE=/run/secrets/xmail-google-identity/adc.json',
      '',
    ].join('\n'), { mode: 0o600 })
    chmodSync(envFile, 0o600)
    for (const name of ['adc.json', 'certificate-config.json', 'client.crt', 'client.key', 'trust-chain.pem']) {
      const file = path.join(runtime, name)
      writeFileSync(file, 'offline fixture only\\n', { mode: 0o600 })
      chmodSync(file, 0o600)
    }
  }

  const run = (owner = 'root') => {
    const shell = shellForFixture(parent)
    const result = spawnSync('bash', ['-c', shell], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TEST_STAT_OWNER: owner },
    })
    if (result.error) throw result.error
    assert.equal(result.status, 0, result.stderr)
    const status = /^STATUS=(\d+)$/m.exec(result.stdout)?.[1]
    const args = /^ARGS=(.*)$/m.exec(result.stdout)?.[1]
    assert.notEqual(status, undefined, 'helper status must be reported')
    assert.notEqual(args, undefined, 'helper arguments must be reported')
    return { status: Number(status), args, output: result.stdout + result.stderr }
  }

  return { temporary, parent, root, ops, runtime, envFile, writeValidState, run }
}

test('absent staged file preserves the existing deploy arguments and defaults', t => {
  if (process.platform !== 'linux') return t.skip('The policy execution fixture uses Linux filesystem metadata.')
  const state = fixture()
  try {
    const result = state.run()
    assert.equal(result.status, 0)
    assert.equal(result.args, '')
  } finally { rmSync(state.temporary, { recursive: true, force: true }) }
})

test('valid dedicated config adds only its env file and read-only cert bind', t => {
  if (process.platform !== 'linux') return t.skip('The policy execution fixture uses Linux filesystem metadata.')
  const state = fixture()
  try {
    state.writeValidState()
    const result = state.run()
    assert.equal(result.status, 0)
    assert.equal(result.args,
      `--env-file ${state.envFile} --mount type=bind,source=${state.runtime},target=/run/secrets/xmail-google-identity,readonly`)
    assert.doesNotMatch(result.output, /XMAIL_GOOGLE_AUTH_ENABLED=true/)
  } finally { rmSync(state.temporary, { recursive: true, force: true }) }
})

test('bad owner, permissive mode, missing certificate and generic env keys fail closed', t => {
  if (process.platform !== 'linux') return t.skip('The policy execution fixture uses Linux filesystem metadata.')

  const wrongOwner = fixture()
  try {
    wrongOwner.writeValidState()
    const result = wrongOwner.run('untrusted')
    assert.equal(result.status, 1)
    assert.equal(result.args, '')
    assert.doesNotMatch(result.output, /XMAIL_GOOGLE_AUTH_ENABLED=true/)
  } finally { rmSync(wrongOwner.temporary, { recursive: true, force: true }) }

  const weakMode = fixture()
  try {
    weakMode.writeValidState()
    chmodSync(weakMode.envFile, 0o644)
    const result = weakMode.run()
    assert.equal(result.status, 1)
    assert.equal(result.args, '')
  } finally { rmSync(weakMode.temporary, { recursive: true, force: true }) }

  const missingCertificate = fixture()
  try {
    missingCertificate.writeValidState()
    rmSync(path.join(missingCertificate.runtime, 'client.key'))
    const result = missingCertificate.run()
    assert.equal(result.status, 1)
    assert.equal(result.args, '')
  } finally { rmSync(missingCertificate.temporary, { recursive: true, force: true }) }

  const genericKey = fixture()
  try {
    genericKey.writeValidState()
    writeFileSync(genericKey.envFile, 'DATABASE_URL=never-log-this-value\n', { mode: 0o600 })
    chmodSync(genericKey.envFile, 0o600)
    const result = genericKey.run()
    assert.equal(result.status, 1)
    assert.equal(result.args, '')
    assert.doesNotMatch(result.output, /never-log-this-value/)
  } finally { rmSync(genericKey.temporary, { recursive: true, force: true }) }

  const linkedKey = fixture()
  try {
    linkedKey.writeValidState()
    const keyPath = path.join(linkedKey.runtime, 'client.key')
    rmSync(keyPath)
    const target = path.join(linkedKey.temporary, 'outside-key-fixture')
    writeFileSync(target, 'offline only', { mode: 0o600 })
    chmodSync(target, 0o600)
    symlinkSync(target, keyPath)
    const result = linkedKey.run()
    assert.equal(result.status, 1)
    assert.equal(result.args, '')
  } finally { rmSync(linkedKey.temporary, { recursive: true, force: true }) }
})

test('workflow validates before docker run and preserves mail service flags', () => {
  const runApp = workflow.slice(end)
  assert.match(runApp, /prepare_google_runtime_binding \|\| return 1/)
  assert.match(runApp, /docker run -d \\\n[\s\S]*?\$GOOGLE_RUNTIME_ARGS \\\n[\s\S]*?-e SMTP_PASS=/)
  for (const line of [
    '-e SMTP_PASS="$SMTP_PASS"', '-e SMTP_FROM="$SMTP_FROM"',
    '-e SMTP_SUBMISSION_PORT=587', '-e MX_PORT=25', '-e IMAP_PORT=993', '-e ENABLE_MAIL_SERVER=true',
  ]) assert.ok(runApp.includes(line), `existing mail flag must remain: ${line}`)
  assert.doesNotMatch(runApp, /source .*google-auth\.env|--env-file \$[A-Z_]+/)
})
