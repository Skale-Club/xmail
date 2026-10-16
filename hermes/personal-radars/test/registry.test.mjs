import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RadarRegistry } from '../src/registry.mjs'

test('re-ingesting one apartment updates a single record and preserves evidence', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'personal-radars-'))
  const registry = new RadarRegistry(path.join(directory, 'apartments.db'))
  t.after(async () => {
    registry.close()
    await rm(directory, { recursive: true, force: true })
  })

  registry.ingestApartment({
    source: 'zillow-email',
    canonicalUrl: 'https://example.test/zillow/123',
    address: '100 Main Street, Orlando, FL 32801',
    unit: '4B',
    baseRent: 1_850,
    observedAt: '2026-10-14T12:00:00.000Z',
  })
  registry.ingestApartment({
    source: 'property-manager-email',
    canonicalUrl: 'https://example.test/direct/4b',
    address: '100 Main St., Orlando FL 32801',
    unit: '#4-B',
    baseRent: 1_800,
    observedAt: '2026-10-15T12:00:00.000Z',
  })

  const records = registry.list('apartment')
  assert.equal(records.length, 1)
  assert.equal(records[0].baseRent, 1_800)
  assert.deepEqual(records[0].sources.map(({ source }) => source), [
    'zillow-email',
    'property-manager-email',
  ])
  assert.deepEqual(records[0].priceHistory, [
    { amount: 1_850, observedAt: '2026-10-14T12:00:00.000Z' },
    { amount: 1_800, observedAt: '2026-10-15T12:00:00.000Z' },
  ])
})

test('re-ingesting one job from another source does not duplicate the opportunity', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'personal-radars-'))
  const registry = new RadarRegistry(path.join(directory, 'jobs.db'))
  t.after(async () => {
    registry.close()
    await rm(directory, { recursive: true, force: true })
  })

  registry.ingestJob({
    source: 'linkedin-email',
    canonicalUrl: 'https://example.test/alert/987',
    company: 'Example Health, Inc.',
    title: 'Senior Operations Manager',
    location: 'Remote - United States',
    salaryMin: 110_000,
    salaryMax: 130_000,
    observedAt: '2026-10-14T12:00:00.000Z',
  })
  registry.ingestJob({
    source: 'greenhouse',
    canonicalUrl: 'https://example.test/jobs/987',
    company: 'Example Health',
    title: 'Sr. Operations Manager',
    location: 'Remote, US',
    salaryMin: 115_000,
    salaryMax: 135_000,
    observedAt: '2026-10-15T12:00:00.000Z',
  })

  const records = registry.list('job')
  assert.equal(records.length, 1)
  assert.equal(records[0].salaryMin, 115_000)
  assert.equal(records[0].sources.length, 2)
  assert.equal(records[0].compensationHistory.length, 2)
})
