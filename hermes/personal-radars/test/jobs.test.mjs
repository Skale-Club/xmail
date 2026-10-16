import assert from 'node:assert/strict'
import test from 'node:test'

import { jobIdentityKey, normalizeJob, transitionJob } from '../src/jobs.mjs'

test('deduplicates the same role across an alert email and a direct ATS page', () => {
  const emailKey = jobIdentityKey({
    company: 'Example Health, Inc.',
    title: 'Senior Operations Manager',
    location: 'Remote - United States',
  })
  const atsKey = jobIdentityKey({
    company: 'Example Health',
    title: 'Sr. Operations Manager',
    location: 'Remote, US',
  })

  assert.equal(emailKey, atsKey)
})

test('automation cannot apply for a job', () => {
  assert.throws(
    () => transitionJob({ status: 'shortlisted' }, 'applied', { actor: 'automation' }),
    /human confirmation/i,
  )
  assert.equal(
    transitionJob({ status: 'shortlisted' }, 'applied', { actor: 'human' }).status,
    'applied',
  )
})

test('rejects an inverted salary range', () => {
  assert.throws(
    () => normalizeJob({
      company: 'Example Health',
      title: 'Operations Manager',
      location: 'Remote, US',
      salaryMin: 130_000,
      salaryMax: 110_000,
    }),
    /salaryMax must be greater than or equal to salaryMin/,
  )
})
