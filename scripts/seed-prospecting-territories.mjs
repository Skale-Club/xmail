#!/usr/bin/env node
/**
 * Fase 36 (docs/prospecting-engine-plan.md "Fase 36") — seed the daily engine's territory
 * queue for one organization.
 *
 * NOT run automatically anywhere: tenant data (which organization prospects which cities)
 * does not belong in a schema migration (see CLAUDE.md "Seed rows are NOT part of the
 * migration"). Run it by hand, once, per organization that wants this seed list.
 *
 * List: 32 Massachusetts cities around Hudson (the pilot's base), ordered by distance from
 * Hudson weighted by population, EXCLUDING the six locations already scraped as of
 * 2026-09-08 (Framingham, Worcester, Boston, Marlborough, Cape Cod, Buffalo NY) — see
 * territories-seed.md, the source this list was transcribed from. Query is fixed to
 * "barbershops" / template "enriched" for every row, matching the three real runs this
 * engine replaces.
 *
 * Idempotent via prospecting_territories' own UNIQUE (organization_id, query, location)
 * constraint: `ON CONFLICT DO NOTHING` makes a re-run a no-op rather than erroring or
 * duplicating rows.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/seed-prospecting-territories.mjs --organizationId <uuid>
 */
import postgres from 'postgres'
import dotenv from 'dotenv'

dotenv.config()

const QUERY = 'barbershops'
const TEMPLATE = 'enriched'

// priority: lower number = higher priority (runs first) — see migration 065.
const TERRITORIES = [
    { priority: 1, location: 'Hudson, MA, USA', maxResults: 40, notes: 'cidade do piloto; pequena' },
    { priority: 2, location: 'Maynard, MA, USA', maxResults: 30, notes: 'vizinha de Hudson' },
    { priority: 3, location: 'Sudbury, MA, USA', maxResults: 30, notes: null },
    { priority: 4, location: 'Westborough, MA, USA', maxResults: 40, notes: null },
    { priority: 5, location: 'Northborough, MA, USA', maxResults: 30, notes: null },
    { priority: 6, location: 'Shrewsbury, MA, USA', maxResults: 60, notes: null },
    { priority: 7, location: 'Natick, MA, USA', maxResults: 60, notes: null },
    { priority: 8, location: 'Acton, MA, USA', maxResults: 30, notes: null },
    { priority: 9, location: 'Concord, MA, USA', maxResults: 30, notes: null },
    { priority: 10, location: 'Waltham, MA, USA', maxResults: 100, notes: null },
    { priority: 11, location: 'Leominster, MA, USA', maxResults: 60, notes: null },
    { priority: 12, location: 'Fitchburg, MA, USA', maxResults: 60, notes: null },
    { priority: 13, location: 'Milford, MA, USA', maxResults: 40, notes: null },
    { priority: 14, location: 'Newton, MA, USA', maxResults: 100, notes: null },
    { priority: 15, location: 'Lowell, MA, USA', maxResults: 150, notes: null },
    { priority: 16, location: 'Cambridge, MA, USA', maxResults: 150, notes: null },
    { priority: 17, location: 'Somerville, MA, USA', maxResults: 100, notes: null },
    { priority: 18, location: 'Quincy, MA, USA', maxResults: 120, notes: null },
    { priority: 19, location: 'Lynn, MA, USA', maxResults: 120, notes: null },
    { priority: 20, location: 'Brockton, MA, USA', maxResults: 120, notes: null },
    { priority: 21, location: 'Lawrence, MA, USA', maxResults: 100, notes: null },
    { priority: 22, location: 'Haverhill, MA, USA', maxResults: 80, notes: null },
    { priority: 23, location: 'Malden, MA, USA', maxResults: 80, notes: null },
    { priority: 24, location: 'Medford, MA, USA', maxResults: 80, notes: null },
    { priority: 25, location: 'Revere, MA, USA', maxResults: 80, notes: null },
    { priority: 26, location: 'Taunton, MA, USA', maxResults: 80, notes: null },
    { priority: 27, location: 'New Bedford, MA, USA', maxResults: 150, notes: null },
    { priority: 28, location: 'Fall River, MA, USA', maxResults: 150, notes: null },
    { priority: 29, location: 'Springfield, MA, USA', maxResults: 200, notes: 'longe; ultimo bloco' },
    { priority: 30, location: 'Chicopee, MA, USA', maxResults: 80, notes: null },
    { priority: 31, location: 'Holyoke, MA, USA', maxResults: 60, notes: null },
    { priority: 32, location: 'Pittsfield, MA, USA', maxResults: 60, notes: null },
]

function parseArgs() {
    const argv = process.argv.slice(2)
    const get = (flag) => {
        const i = argv.indexOf(`--${flag}`)
        return i >= 0 ? argv[i + 1] : undefined
    }
    const organizationId = get('organizationId')
    if (!organizationId) {
        console.error('Usage: node scripts/seed-prospecting-territories.mjs --organizationId <uuid>')
        process.exit(1)
    }
    return { organizationId }
}

async function main() {
    const { organizationId } = parseArgs()

    const url = process.env.DATABASE_URL
    if (!url) {
        console.error('DATABASE_URL not set')
        process.exit(1)
    }

    // prepare: false — same PgBouncer transaction-mode reasoning as apply-pending-migrations.mjs.
    const sql = postgres(url, { prepare: false, ssl: 'require', max: 1 })

    try {
        const [org] = await sql`SELECT id FROM organizations WHERE id = ${organizationId}`
        if (!org) {
            console.error(`No organization found for id ${organizationId}`)
            process.exit(1)
        }

        let inserted = 0
        let skipped = 0
        for (const territory of TERRITORIES) {
            const rows = await sql`
                INSERT INTO prospecting_territories
                    (organization_id, query, location, template, priority, max_results, notes)
                VALUES
                    (${organizationId}, ${QUERY}, ${territory.location}, ${TEMPLATE}, ${territory.priority}, ${territory.maxResults}, ${territory.notes})
                ON CONFLICT (organization_id, query, location) DO NOTHING
                RETURNING id
            `
            if (rows.length > 0) {
                inserted += 1
                console.log(`  + ${territory.location} (priority ${territory.priority}, max ${territory.maxResults})`)
            } else {
                skipped += 1
                console.log(`  = ${territory.location} already queued, skipped`)
            }
        }

        console.log(`\nDone: ${inserted} inserted, ${skipped} already present (of ${TERRITORIES.length} total).`)
    } finally {
        await sql.end()
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
