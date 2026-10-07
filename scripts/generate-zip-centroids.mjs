#!/usr/bin/env node
/**
 * Regenerates src/server/data/us-zip-centroids.json, the ZIP -> [lat, lng] table behind the
 * `nearby` template flag (src/server/lib/template-variables.ts, src/server/lib/zip-distance.ts).
 *
 * Source: US Census Bureau, 2024 Gazetteer Files, "ZIP Code Tabulation Areas" (ZCTA), national file.
 *   https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip
 * The point used is the file's INTPTLAT / INTPTLONG (internal point of the ZCTA). A ZCTA is the
 * Census approximation of a ZIP code area, not the USPS ZIP itself; for a "within N miles" test
 * the difference is far below the 3-decimal (~110 m) rounding this script applies.
 *
 * Usage:
 *   1. Download and unzip the file above (it contains 2024_Gaz_zcta_national.txt, tab-separated).
 *   2. node scripts/generate-zip-centroids.mjs path/to/2024_Gaz_zcta_national.txt
 *
 * Output keeps the keys sorted so regenerating from the same source yields a byte-identical file.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const input = process.argv[2]
if (!input) {
    console.error('Usage: node scripts/generate-zip-centroids.mjs <2024_Gaz_zcta_national.txt>')
    process.exit(1)
}

const rows = readFileSync(input, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '')
const header = rows[0].split('\t').map((h) => h.trim())
const iZip = header.indexOf('GEOID')
const iLat = header.indexOf('INTPTLAT')
const iLng = header.indexOf('INTPTLONG')
if (iZip < 0 || iLat < 0 || iLng < 0) {
    console.error(`Unexpected header: ${header.join(', ')}`)
    process.exit(1)
}

const out = {}
for (const line of rows.slice(1)) {
    const cols = line.split('\t').map((c) => c.trim())
    const zip = cols[iZip]
    const lat = Number(cols[iLat])
    const lng = Number(cols[iLng])
    if (!/^\d{5}$/.test(zip) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue
    out[zip] = [Math.round(lat * 1000) / 1000, Math.round(lng * 1000) / 1000]
}

const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../src/server/data/us-zip-centroids.json')
writeFileSync(target, JSON.stringify(sorted) + '\n')
console.log(`Wrote ${Object.keys(sorted).length} ZIP centroids to ${target}`)
