import { createHash } from 'node:crypto'

const humanOnlyStatuses = new Set([
  'shortlisted',
  'apply_ready',
  'applied',
  'interview',
  'offer',
  'accepted',
  'withdrawn',
])

function normalizeIdentityText(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\bsenior\b/g, 'sr')
    .replace(/\bunited states(?: of america)?\b/g, 'us')
    .replace(/\b(incorporated|inc|llc|corp|corporation)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function jobIdentityKey({ company, title, location }) {
  const identity = [company, title, location]
    .map((value) => normalizeIdentityText(value))
    .join('|')
  return createHash('sha256').update(identity).digest('hex')
}

export function normalizeJob(input) {
  for (const field of ['company', 'title', 'location']) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') {
      throw new Error(`${field} is required`)
    }
  }
  for (const field of ['salaryMin', 'salaryMax']) {
    const value = input[field]
    if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`${field} must be a non-negative number`)
    }
  }
  if (input.salaryMin != null && input.salaryMax != null && input.salaryMax < input.salaryMin) {
    throw new Error('salaryMax must be greater than or equal to salaryMin')
  }
  return { ...input }
}

export function transitionJob(job, nextStatus, { actor }) {
  if (actor !== 'human' && humanOnlyStatuses.has(nextStatus)) {
    throw new Error(`Status ${nextStatus} requires human confirmation`)
  }
  return { ...job, status: nextStatus }
}
