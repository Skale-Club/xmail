/**
 * Zera os dias de warm-up "fantasma".
 *
 * Até 2026-08-14 o resetDailyLimits avançava `warmup_current_day` por CALENDÁRIO — inclusive em
 * caixas que nunca enviaram nada. A correção (mesmo commit) passou a exigir envio real, mas os dias
 * já gravados continuam lá, inflando o limite efetivo de caixas frias. Este script devolve ao dia 0
 * as caixas cujo contador avançou sem nenhum envio registrado em `outreach_emails`.
 *
 * Conservador por construção: só toca em caixa com ZERO envios. Caixa com histórico parcial não é
 * adivinhada — aparece no relatório para decisão humana.
 *
 * Uso:
 *   npx tsx scripts/warmup-reset-phantom-days.ts            # dry-run (padrão)
 *   npx tsx scripts/warmup-reset-phantom-days.ts --apply    # grava
 */

import 'dotenv/config'
import postgres from 'postgres'

interface PhantomRow {
    id: string
    email: string
    warmup_current_day: number
    warmup_days: number
    sends_total: number
}

async function main(): Promise<void> {
    const apply = process.argv.includes('--apply')
    const url = process.env.DATABASE_URL
    if (!url) {
        console.error('DATABASE_URL não está setada.')
        process.exit(1)
    }
    const sql = postgres(url, { ssl: 'require', prepare: false, onnotice: () => { } })

    try {
        const candidates = await sql<PhantomRow[]>`
            SELECT a.id, a.email, a.warmup_current_day, a.warmup_days,
                   COALESCE(s.sends_total, 0)::int AS sends_total
            FROM email_accounts a
            LEFT JOIN (
                SELECT email_account_id, count(*) AS sends_total
                FROM outreach_emails WHERE sent_at IS NOT NULL GROUP BY email_account_id
            ) s ON s.email_account_id = a.id
            WHERE a.warmup_current_day > 0
            ORDER BY a.email
        `

        const phantom = candidates.filter((row) => row.sends_total === 0)
        const partial = candidates.filter((row) => row.sends_total > 0 && row.sends_total < row.warmup_current_day)

        if (candidates.length === 0) {
            console.log('Nenhuma caixa com warmup_current_day > 0. Nada a fazer.')
            return
        }

        console.log(`\nCaixas com contador > 0: ${candidates.length}`)
        for (const row of phantom) {
            console.log(`  FANTASMA  ${row.email}: dia ${row.warmup_current_day}/${row.warmup_days}, 0 envios → vai para 0`)
        }
        for (const row of partial) {
            console.log(`  REVISAR   ${row.email}: dia ${row.warmup_current_day}/${row.warmup_days}, ${row.sends_total} envio(s) — não tocado`)
        }

        if (phantom.length === 0) {
            console.log('\nNenhum dia fantasma para zerar.')
            return
        }
        if (!apply) {
            console.log(`\nDRY-RUN. Rode com --apply para zerar ${phantom.length} caixa(s).`)
            return
        }

        const updated = await sql<{ id: string }[]>`
            UPDATE email_accounts
            SET warmup_current_day = 0, updated_at = now()
            WHERE id = ANY(${phantom.map((row) => row.id)}::uuid[])
            RETURNING id
        `
        console.log(`\n✅ ${updated.length} caixa(s) devolvida(s) ao dia 0 do warm-up.`)
    } finally {
        await sql.end({ timeout: 5 })
    }
}

main().catch((error) => {
    console.error('warmup-reset-phantom-days falhou:', error instanceof Error ? error.message : error)
    process.exit(1)
})
