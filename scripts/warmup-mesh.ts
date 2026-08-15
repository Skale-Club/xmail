/**
 * Administra o warm-up mesh sem UI: lista participantes, liga e desliga caixas.
 *
 * Uso:
 *   npx tsx scripts/warmup-mesh.ts --list
 *   npx tsx scripts/warmup-mesh.ts --enable vanildo@tryskaleclub.com [--only]
 *   npx tsx scripts/warmup-mesh.ts --enable-provider icemail [--only]   # todas as caixas do vendor
 *   npx tsx scripts/warmup-mesh.ts --add-native info@skale.club [--only] # cria a conta nativa no mesh
 *   npx tsx scripts/warmup-mesh.ts --disable vanildo@tryskaleclub.com
 *
 * `--only` marca a caixa como warm-up-only (nunca pode ser atribuída a campanha).
 * O motor (src/server/jobs/processWarmup.ts) só considera caixas `verified` com
 * warmup_source='internal'; este script não altera status de verificação.
 */

import 'dotenv/config'
import postgres from 'postgres'

function argValue(flag: string): string | undefined {
    const index = process.argv.indexOf(flag)
    return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
    const url = process.env.DATABASE_URL
    if (!url) {
        console.error('DATABASE_URL não está setada.')
        process.exit(1)
    }
    const sql = postgres(url, { ssl: 'require', prepare: false, onnotice: () => { } })
    const only = process.argv.includes('--only')

    try {
        if (process.argv.includes('--list')) {
            const rows = await sql`
                SELECT email, provider, mailbox_provider, status, warmup_source, warmup_only,
                       warmup_current_day, warmup_days, warmup_sent_today, warmup_started_at
                FROM email_accounts ORDER BY email`
            for (const row of rows) {
                const mesh = row.warmup_source === 'internal' ? (row.warmup_only ? 'MESH(only)' : 'MESH') : row.warmup_source
                console.log(` ${row.email}  [${row.provider}/${row.mailbox_provider}]  ${row.status}  ${mesh}  dia ${row.warmup_current_day}/${row.warmup_days}  hoje ${row.warmup_sent_today}`)
            }
            return
        }

        const enableEmail = argValue('--enable')
        const enableProvider = argValue('--enable-provider')
        const disableEmail = argValue('--disable')
        const addNativeEmail = argValue('--add-native')

        if (addNativeEmail) {
            // Mesmas pré-condições da rota de criação (provider 'native'): usuário da plataforma
            // com mailbox nativa, membro de alguma org. A conta nasce 'verified' — para nativas a
            // verificação é exatamente a existência da mailbox, checada aqui.
            const email = addNativeEmail.toLowerCase()
            const [owner] = await sql`SELECT id FROM users WHERE lower(email) = ${email}`
            if (!owner) { console.error(`Não existe usuário da plataforma com o email ${email}.`); process.exit(1) }
            const [mailbox] = await sql`SELECT id FROM mailboxes WHERE user_id = ${owner.id} AND lower(email) = ${email}`
            if (!mailbox) { console.error(`${email} não tem mailbox nativa.`); process.exit(1) }
            const [membership] = await sql`SELECT organization_id FROM organization_users WHERE user_id = ${owner.id} LIMIT 1`
            if (!membership) { console.error(`${email} não pertence a nenhuma organização.`); process.exit(1) }
            const [account] = await sql`
                INSERT INTO email_accounts (
                    organization_id, email, provider, mailbox_provider, status, verified_at,
                    daily_send_limit, warmup_enabled, warmup_days,
                    warmup_source, warmup_only, warmup_started_at
                ) VALUES (
                    ${membership.organization_id}, ${email}, 'native', 'manual', 'verified', now(),
                    50, true, 14,
                    'internal', ${only}, now()
                )
                ON CONFLICT (organization_id, lower(email)) DO UPDATE SET
                    warmup_source = 'internal', warmup_only = ${only},
                    warmup_started_at = coalesce(email_accounts.warmup_started_at, now()),
                    updated_at = now()
                RETURNING email, status`
            console.log(`✅ nativa no mesh${only ? ' (warm-up only)' : ''}: ${account.email} [${account.status}]`)
            return
        }

        if (enableEmail || enableProvider) {
            const updated = enableEmail
                ? await sql`
                    UPDATE email_accounts
                    SET warmup_source = 'internal', warmup_only = ${only},
                        warmup_started_at = coalesce(warmup_started_at, now()), updated_at = now()
                    WHERE lower(email) = ${enableEmail.toLowerCase()}
                    RETURNING email`
                : await sql`
                    UPDATE email_accounts
                    SET warmup_source = 'internal', warmup_only = ${only},
                        warmup_started_at = coalesce(warmup_started_at, now()), updated_at = now()
                    WHERE mailbox_provider = ${enableProvider!}
                    RETURNING email`
            if (updated.length === 0) {
                console.error('Nenhuma caixa encontrada para habilitar.')
                process.exit(1)
            }
            for (const row of updated) console.log(`✅ mesh ON${only ? ' (warm-up only)' : ''}: ${row.email}`)
            return
        }

        if (disableEmail) {
            const updated = await sql`
                UPDATE email_accounts
                SET warmup_source = 'none', warmup_only = false, updated_at = now()
                WHERE lower(email) = ${disableEmail.toLowerCase()}
                RETURNING email`
            if (updated.length === 0) {
                console.error('Caixa não encontrada.')
                process.exit(1)
            }
            for (const row of updated) console.log(`✅ mesh OFF: ${row.email}`)
            return
        }

        console.log('Uso: --list | --enable <email> [--only] | --enable-provider <vendor> [--only] | --disable <email>')
    } finally {
        await sql.end({ timeout: 5 })
    }
}

main().catch((error) => {
    console.error('warmup-mesh falhou:', error instanceof Error ? error.message : error)
    process.exit(1)
})
