import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { apartmentIdentityKey, normalizeApartment } from './apartments.mjs'
import { jobIdentityKey, normalizeJob } from './jobs.mjs'

export class RadarRegistry {
  constructor(databasePath) {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true })
    this.database = new DatabaseSync(databasePath)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS radar_records (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(domain, identity_key)
      );
    `)
  }

  close() {
    this.database.close()
  }

  ingestApartment(input) {
    const normalizedInput = normalizeApartment(input)
    const identityKey = apartmentIdentityKey(normalizedInput)
    const existingRow = this.database.prepare(`
      SELECT id, data_json FROM radar_records
      WHERE domain = ? AND identity_key = ?
    `).get('apartment', identityKey)
    const observedAt = input.observedAt ?? new Date().toISOString()
    const sourceEvidence = {
      source: input.source,
      canonicalUrl: input.canonicalUrl,
      observedAt,
    }
    const existing = existingRow ? JSON.parse(existingRow.data_json) : null
    const sources = [...(existing?.sources ?? [])]
    if (!sources.some((source) => source.source === input.source && source.canonicalUrl === input.canonicalUrl)) {
      sources.push(sourceEvidence)
    }
    const priceHistory = [...(existing?.priceHistory ?? [])]
    if (input.baseRent != null && priceHistory.at(-1)?.amount !== input.baseRent) {
      priceHistory.push({ amount: input.baseRent, observedAt })
    }
    const record = {
      ...existing,
      ...normalizedInput,
      id: existingRow?.id ?? randomUUID(),
      identityKey,
      domain: 'apartment',
      sources,
      priceHistory,
      firstSeen: existing?.firstSeen ?? observedAt,
      lastSeen: observedAt,
      status: existing?.status ?? 'new',
    }
    const now = new Date().toISOString()

    this.database.prepare(`
      INSERT INTO radar_records (id, domain, identity_key, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain, identity_key) DO UPDATE SET
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.domain,
      record.identityKey,
      JSON.stringify(record),
      existing?.firstSeen ?? now,
      now,
    )
    return record
  }

  ingestJob(input) {
    const normalizedInput = normalizeJob(input)
    const identityKey = jobIdentityKey(normalizedInput)
    const existingRow = this.database.prepare(`
      SELECT id, data_json FROM radar_records
      WHERE domain = ? AND identity_key = ?
    `).get('job', identityKey)
    const observedAt = input.observedAt ?? new Date().toISOString()
    const existing = existingRow ? JSON.parse(existingRow.data_json) : null
    const sourceEvidence = {
      source: input.source,
      canonicalUrl: input.canonicalUrl,
      observedAt,
    }
    const sources = [...(existing?.sources ?? [])]
    if (!sources.some((source) => source.source === input.source && source.canonicalUrl === input.canonicalUrl)) {
      sources.push(sourceEvidence)
    }
    const compensationHistory = [...(existing?.compensationHistory ?? [])]
    const latestCompensation = compensationHistory.at(-1)
    if (input.salaryMin != null && (
      latestCompensation?.salaryMin !== input.salaryMin
      || latestCompensation?.salaryMax !== input.salaryMax
    )) {
      compensationHistory.push({
        salaryMin: input.salaryMin,
        salaryMax: input.salaryMax ?? null,
        observedAt,
      })
    }
    const record = {
      ...existing,
      ...normalizedInput,
      id: existingRow?.id ?? randomUUID(),
      identityKey,
      domain: 'job',
      sources,
      compensationHistory,
      firstSeen: existing?.firstSeen ?? observedAt,
      lastSeen: observedAt,
      status: existing?.status ?? 'new',
    }
    const now = new Date().toISOString()

    this.database.prepare(`
      INSERT INTO radar_records (id, domain, identity_key, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain, identity_key) DO UPDATE SET
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.domain,
      record.identityKey,
      JSON.stringify(record),
      existing?.firstSeen ?? now,
      now,
    )
    return record
  }

  list(domain) {
    return this.database.prepare(`
      SELECT data_json FROM radar_records
      WHERE domain = ?
      ORDER BY created_at ASC
    `).all(domain).map((row) => JSON.parse(row.data_json))
  }
}
