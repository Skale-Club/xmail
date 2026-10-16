import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cliPath = path.join(projectRoot, 'src', 'cli.mjs')

test('CLI ingests an apartment file and returns structured JSON', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'personal-radars-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const inputPath = path.join(directory, 'apartment.json')
  const databasePath = path.join(directory, 'data', 'apartments', 'radar.db')
  await writeFile(inputPath, JSON.stringify({
    source: 'rentals-email',
    canonicalUrl: 'https://example.test/apartment/1',
    address: '500 Orange Ave, Orlando, FL 32801',
    unit: '12',
    baseRent: 1_900,
    mandatoryMonthlyFees: 75,
  }))

  const result = spawnSync(process.execPath, [
    cliPath,
    '--db', databasePath,
    'apartment', 'ingest', '--file', inputPath,
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, true)
  assert.equal(output.record.domain, 'apartment')
  assert.equal(output.record.totalMonthlyKnown, 1_975)
})
