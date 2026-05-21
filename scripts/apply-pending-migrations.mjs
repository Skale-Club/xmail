#!/usr/bin/env node
/**
 * One-shot: apply pending Supabase migrations bypassing `supabase db push`
 * (which fails against PgBouncer transaction mode due to prepared statements).
 *
 * Connects via `postgres` (already used by Drizzle), applies each pending
 * migration file inside a transaction, and registers the version in
 * supabase_migrations.schema_migrations so `supabase migration list` reflects
 * reality.
 *
 * Usage: DATABASE_URL=... node scripts/apply-pending-migrations.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import dotenv from 'dotenv'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations')
const url = process.env.DATABASE_URL
if (!url) {
    console.error('DATABASE_URL not set')
    process.exit(1)
}

// prepare: false disables prepared statements so we work with PgBouncer transaction mode
const sql = postgres(url, { prepare: false, ssl: 'require', max: 1 })

function versionOf(filename) {
    const m = filename.match(/^(\d{3,14})_/)
    return m ? m[1] : null
}

async function main() {
    const files = (await fs.readdir(MIGRATIONS_DIR))
        .filter((f) => f.endsWith('.sql'))
        .sort()

    const applied = await sql`
        SELECT version FROM supabase_migrations.schema_migrations ORDER BY version
    `.then((rows) => new Set(rows.map((r) => r.version)))

    const pending = files
        .map((f) => ({ file: f, version: versionOf(f) }))
        .filter((x) => x.version && !applied.has(x.version))

    if (pending.length === 0) {
        console.log('Nothing to apply. Remote is up to date.')
        await sql.end()
        return
    }

    console.log(`Pending migrations (${pending.length}):`)
    for (const p of pending) console.log(`  - ${p.file} [${p.version}]`)
    console.log('')

    for (const { file, version } of pending) {
        const fullPath = path.join(MIGRATIONS_DIR, file)
        const body = await fs.readFile(fullPath, 'utf8')
        console.log(`Applying ${file} (${body.length} bytes)...`)
        try {
            await sql.begin(async (tx) => {
                await tx.unsafe(body)
                await tx`
                    INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
                    VALUES (${version}, ${file.replace(/^\d+_/, '').replace(/\.sql$/, '')}, ${[body]})
                    ON CONFLICT (version) DO NOTHING
                `
            })
            console.log(`  ✓ ${file} applied`)
        } catch (err) {
            console.error(`  ✗ ${file} FAILED:`, err.message)
            await sql.end()
            process.exit(2)
        }
    }

    console.log('\nAll pending migrations applied successfully.')
    await sql.end()
}

main().catch((e) => {
    console.error('Fatal:', e)
    process.exit(1)
})
