/**
 * Backfills smtp_endpoints.password_encrypted for any rows that still have a
 * plaintext password stored in the legacy `password` column.
 *
 * Run AFTER applying migration 030_encrypt_smtp_endpoint_passwords.sql:
 *   npx tsx scripts/backfill-smtp-passwords.ts
 *
 * The script is idempotent — it skips rows that already have password_encrypted set.
 * Once every row has been backfilled you can drop the `password` column in a future
 * migration (031_drop_smtp_plaintext_password.sql).
 */
import 'dotenv/config'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { eq, isNull, isNotNull, and } from 'drizzle-orm'
import * as schema from '../src/db/schema'
import { encryptSecret } from '../src/server/lib/crypto'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
    console.error('DATABASE_URL is not set')
    process.exit(1)
}

const sql = postgres(connectionString, { max: 1 })
const db = drizzle(sql, { schema })

async function main() {
    const rows = await db.query.smtpEndpoints.findMany({
        where: and(
            isNotNull(schema.smtpEndpoints.password),
            isNull(schema.smtpEndpoints.passwordEncrypted)
        ),
    })

    if (rows.length === 0) {
        console.log('No rows to backfill — all smtp_endpoints passwords are already encrypted.')
        return
    }

    console.log(`Backfilling ${rows.length} smtp_endpoint row(s)...`)

    for (const row of rows) {
        if (!row.password) continue
        const encrypted = encryptSecret(row.password)
        await db
            .update(schema.smtpEndpoints)
            .set({ passwordEncrypted: encrypted, updatedAt: new Date() })
            .where(eq(schema.smtpEndpoints.id, row.id))
        console.log(`  ✓ Encrypted password for smtp_endpoint ${row.id} (${row.name})`)
    }

    console.log('Done.')
}

main()
    .catch((err) => {
        console.error('Backfill failed:', err)
        process.exit(1)
    })
    .finally(() => sql.end())
