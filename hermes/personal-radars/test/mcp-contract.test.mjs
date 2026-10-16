import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('MCP exposes radar operations but no application, contact, payment, or signing tool', () => {
  const result = spawnSync(process.execPath, [
    path.join(projectRoot, 'mcp', 'server.mjs'),
    '--list-tools',
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  const names = JSON.parse(result.stdout).map(({ name }) => name)
  assert.deepEqual(names, [
    'personal_radars_health',
    'apartment_radar_ingest',
    'apartment_radar_list',
    'job_radar_ingest',
    'job_radar_list',
  ])
  assert.equal(names.some((name) => /(apply|contact|message|pay|sign|submit)/i.test(name)), false)
})

test('MCP requires evidence for every mandatory apartment eligibility rule', () => {
  const result = spawnSync(process.execPath, [
    path.join(projectRoot, 'mcp', 'server.mjs'),
    '--list-tools',
  ], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  const apartmentTool = JSON.parse(result.stdout).find(({ name }) => name === 'apartment_radar_ingest')
  const required = apartmentTool.inputSchema.required
  for (const field of [
    'bedrooms',
    'laundryInUnit',
    'dishwasher',
    'parkingSpacesIncluded',
    'additionalPaidParkingSpaces',
    'parkingArrangement',
    'parkingWalkMeters',
    'parkingAvailabilityConfirmed',
  ]) {
    assert.ok(required.includes(field), `${field} must be required`)
  }
})
