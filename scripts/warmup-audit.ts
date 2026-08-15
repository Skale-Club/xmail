/**
 * Read-only audit: "o warm-up está realmente aquecendo alguma caixa?"
 *
 * O sistema atual só tem uma RAMPA DE LIMITE (effectiveDailyLimit em
 * src/server/lib/outreach-delivery-policy.ts). Não existe warm-up real (troca de mensagens
 * entre caixas, seed pool, resgate de spam). Este script mostra, com dados, a diferença
 * entre o que a rampa acha que aconteceu e o que de fato foi enviado.
 *
 * Uso:
 *   npx tsx scripts/warmup-audit.ts            # DATABASE_URL vem do .env
 *   DATABASE_URL="postgres://…" npx tsx scripts/warmup-audit.ts
 *
 * Não escreve nada. Nenhuma query fora de SELECT.
 */

import 'dotenv/config'
import postgres from 'postgres'

interface AccountRow {
    id: string
    email: string
    provider: string
    status: string
    warmup_enabled: boolean
    warmup_current_day: number
    warmup_days: number
    daily_send_limit: number
    current_daily_sent: number
    last_sent_at: Date | null
    created_at: Date
    age_days: number
    sends_total: number
    sends_30d: number
    active_send_days: number
    first_send_at: Date | null
}

/** Mesma fórmula de outreach-delivery-policy.ts — replicada aqui só para exibir o limite efetivo. */
function effectiveDailyLimit(account: Pick<AccountRow, 'daily_send_limit' | 'warmup_enabled' | 'warmup_days' | 'warmup_current_day'>): number {
    const fullLimit = Math.max(1, account.daily_send_limit)
    if (!account.warmup_enabled) return fullLimit
    const warmupDays = Math.max(1, account.warmup_days)
    const currentDay = Math.max(0, Math.min(account.warmup_current_day, warmupDays))
    if (currentDay >= warmupDays) return fullLimit
    const startLimit = Math.min(5, fullLimit)
    return Math.max(1, Math.min(fullLimit, Math.ceil(startLimit + (fullLimit - startLimit) * (currentDay / warmupDays))))
}

function pad(value: string | number, width: number): string {
    const text = String(value)
    return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length)
}

async function main(): Promise<void> {
    const url = process.env.DATABASE_URL
    if (!url) {
        console.error('DATABASE_URL não está setada. Rode com o .env montado ou passe a variável inline.')
        process.exit(1)
    }
    const sql = postgres(url, { ssl: 'require', prepare: false, onnotice: () => { } })

    try {
        const accounts = await sql<AccountRow[]>`
            SELECT a.id, a.email, a.provider, a.status,
                   a.warmup_enabled, a.warmup_current_day, a.warmup_days,
                   a.daily_send_limit, a.current_daily_sent, a.last_sent_at, a.created_at,
                   EXTRACT(DAY FROM now() - a.created_at)::int AS age_days,
                   COALESCE(s.sends_total, 0)::int      AS sends_total,
                   COALESCE(s.sends_30d, 0)::int        AS sends_30d,
                   COALESCE(s.active_send_days, 0)::int AS active_send_days,
                   s.first_send_at
            FROM email_accounts a
            LEFT JOIN (
                SELECT email_account_id,
                       count(*)                                                        AS sends_total,
                       count(*) FILTER (WHERE sent_at > now() - interval '30 days')     AS sends_30d,
                       count(DISTINCT date_trunc('day', sent_at))                       AS active_send_days,
                       min(sent_at)                                                     AS first_send_at
                FROM outreach_emails
                WHERE sent_at IS NOT NULL
                GROUP BY email_account_id
            ) s ON s.email_account_id = a.id
            ORDER BY a.created_at
        `

        const [orgs] = await sql`
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE outreach_enabled)::int AS enabled
            FROM organizations
        `
        const campaignRows = await sql<{ status: string; total: number }[]>`
            SELECT status, count(*)::int AS total FROM campaigns GROUP BY status ORDER BY status
        `
        const [volume] = await sql`
            SELECT count(*) FILTER (WHERE sent_at > now() - interval '7 days')::int  AS last_7d,
                   count(*) FILTER (WHERE sent_at > now() - interval '30 days')::int AS last_30d,
                   count(*) FILTER (WHERE sent_at IS NOT NULL)::int                  AS total,
                   max(sent_at)                                                      AS last_send
            FROM outreach_emails
        `

        console.log('\n=== CAIXAS DE ENVIO ===')
        console.log(pad('email', 34), pad('prov', 8), pad('status', 10), pad('warmup', 9), pad('limite', 12), pad('idade', 7), 'envios(dias ativos)')
        console.log('-'.repeat(120))
        const phantom: AccountRow[] = []
        for (const account of accounts) {
            const limit = effectiveDailyLimit(account)
            const warmup = account.warmup_enabled ? `${account.warmup_current_day}/${account.warmup_days}` : 'off'
            const graduated = account.warmup_enabled && account.warmup_current_day >= account.warmup_days
            if (graduated && account.active_send_days < account.warmup_days) phantom.push(account)
            console.log(
                pad(account.email, 34),
                pad(account.provider, 8),
                pad(account.status, 10),
                pad(warmup, 9),
                pad(`${limit}/${account.daily_send_limit}`, 12),
                pad(`${account.age_days}d`, 7),
                `${account.sends_total} (${account.active_send_days} dias)`,
            )
        }

        console.log('\n=== VOLUME REAL ===')
        console.log(`enviados 7d: ${volume.last_7d} | 30d: ${volume.last_30d} | total: ${volume.total} | último envio: ${volume.last_send ?? 'nunca'}`)
        console.log(`organizações: ${orgs.total} (outreach habilitado: ${orgs.enabled})`)
        console.log(`campanhas: ${campaignRows.map((row) => `${row.status}=${row.total}`).join(', ') || 'nenhuma'}`)

        console.log('\n=== VEREDITO ===')
        const warmupOn = accounts.filter((a) => a.warmup_enabled).length
        console.log(`Rampa de limite ativa em ${warmupOn}/${accounts.length} caixas.`)
        if (phantom.length > 0) {
            console.log(`\n⚠️  ${phantom.length} caixa(s) "graduaram" do warm-up sem ter aquecido de verdade`)
            console.log('   (warmup_current_day chegou ao fim, mas o número de dias com envio real é menor —')
            console.log('    o contador avança por calendário em resetDailyLimits, mesmo sem enviar nada):')
            for (const account of phantom) {
                console.log(`   - ${account.email}: dia ${account.warmup_current_day}/${account.warmup_days}, mas só ${account.active_send_days} dia(s) com envio`)
            }
        }
        // Mesh (migration 051): existe quando a tabela warmup_messages está presente.
        const [meshTable] = await sql`SELECT to_regclass('public.warmup_messages') AS t`
        if (!meshTable.t) {
            console.log('\nMesh de warm-up (migration 051) ainda NÃO aplicado neste banco — só a rampa de teto existe.')
        } else {
            const [mesh] = await sql`
                SELECT count(*) FILTER (WHERE sent_at > now() - interval '24 hours')::int AS sent_24h,
                       count(*) FILTER (WHERE detected_folder = 'spam')::int              AS landed_spam,
                       count(*) FILTER (WHERE detected_folder = 'inbox')::int             AS landed_inbox,
                       count(*) FILTER (WHERE replied_at IS NOT NULL)::int                AS replied,
                       count(*) FILTER (WHERE archived_at IS NOT NULL)::int               AS archived,
                       count(*) FILTER (WHERE status = 'failed')::int                     AS failed
                FROM warmup_messages`
            const participants = await sql<{ email: string; warmup_only: boolean }[]>`
                SELECT email, warmup_only FROM email_accounts
                WHERE warmup_source = 'internal' AND status = 'verified' ORDER BY email`
            console.log('\n=== WARM-UP MESH (migration 051) ===')
            console.log(`participantes: ${participants.length}${participants.length ? ' — ' + participants.map((p) => p.email + (p.warmup_only ? ' (only)' : '')).join(', ') : ''}`)
            const delivered = mesh.landed_inbox + mesh.landed_spam
            const spamRate = delivered > 0 ? ((mesh.landed_spam / delivered) * 100).toFixed(1) : '—'
            console.log(`24h: ${mesh.sent_24h} enviados | inbox ${mesh.landed_inbox} | spam ${mesh.landed_spam} (${spamRate}%) | respondidos ${mesh.replied} | arquivados ${mesh.archived} | falhas ${mesh.failed}`)
            if (participants.length < 2) {
                console.log('⚠️  Mesh precisa de pelo menos 2 caixas habilitadas (scripts/warmup-mesh.ts --enable …).')
            }
        }
    } finally {
        await sql.end({ timeout: 5 })
    }
}

main().catch((error) => {
    console.error('warmup-audit falhou:', error instanceof Error ? error.message : error)
    process.exit(1)
})
