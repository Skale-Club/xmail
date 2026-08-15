/**
 * Regressão: a agregação "o que esta caixa já mandou hoje" da fase SEND precisa passar o corte de
 * data por OPERADOR TIPADO, nunca por template `sql` cru.
 *
 * O bug original (produção, 2026-08-15): a cláusula era
 *
 *     sql`${warmupMessages.sentAt} >= ${startOfDay}`
 *
 * Um template `sql` cru não aplica o `mapToDriverValue` da coluna, então o `Date` chegava intacto ao
 * postgres-js, que tentava serializá-lo como string e estourava
 * `ERR_INVALID_ARG_TYPE: The "string" argument must be of type string ... Received an instance of
 * Date` já no Bind. Como isso acontecia no PRIMEIRO remetente do laço, a fase SEND inteira morria
 * antes de inserir qualquer linha — o mesh ficava com `warmup_messages` vazia, nenhuma caixa
 * registrava dia de envio real, `warmup_current_day` travava em 0 e TODA ativação de campanha caía
 * em `sending_inbox_not_warmed`. Um job que falha silenciosamente parecia "ainda não rodou".
 *
 * O teste é `.db.test.ts` de propósito: o defeito só existe na fronteira com o driver. Teste puro
 * sobre `plan.ts` passava com o bug em produção — e passou.
 */
import path from 'node:path'
import { and, eq, gte, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    applyMigrationFile,
    assertSafeTestDatabaseUrl,
    TEST_DATABASE_GUARD_ENV,
    TEST_DATABASE_URL_ENV,
} from '../../../test/postgres-harness'

const runGuard = process.env[TEST_DATABASE_GUARD_ENV]
const testDatabaseUrl = process.env[TEST_DATABASE_URL_ENV]

const warmupMigration = path.join(process.cwd(), 'supabase', 'migrations', '058_warmup_engine.sql')

// Conta inexistente: a agregação devolve uma linha com zeros. O que se prova aqui é que a query
// EXECUTA — o bug era um throw no Bind, não um resultado errado.
const ABSENT_ACCOUNT = '2102cc00-0000-4000-8000-0000000000b7'

let db: typeof import('../../../db')['db']
let warmupMessages: typeof import('../../../db/schema')['warmupMessages']
let closeApplicationDatabase: (() => Promise<void>) | undefined

beforeAll(async () => {
    assertSafeTestDatabaseUrl(testDatabaseUrl, { runGuard })
    await applyMigrationFile({ databaseUrl: testDatabaseUrl, runGuard }, warmupMigration)

    process.env.DATABASE_URL = testDatabaseUrl
    process.env.JWT_SECRET ||= 'test'
    db = (await import('../../../db')).db
    warmupMessages = (await import('../../../db/schema')).warmupMessages
    closeApplicationDatabase = (await import('../../../db')).closeDatabaseConnection
})

afterAll(async () => {
    await closeApplicationDatabase?.()
})

describe('fase SEND do mesh de warm-up — corte de data por operador tipado', () => {
    const startOfDay = new Date(Date.UTC(2026, 7, 15))

    it('executa a agregação diária com um Date sem estourar no driver', async () => {
        const rows = await db.select({
            lastSentAt: sql<Date | null>`max(${warmupMessages.sentAt})`,
            addresses: sql<string[]>`coalesce(array_agg(distinct ${warmupMessages.toAddress}), '{}')`,
        }).from(warmupMessages).where(and(
            eq(warmupMessages.fromAccountId, ABSENT_ACCOUNT),
            gte(warmupMessages.sentAt, startOfDay),
        ))

        expect(rows).toHaveLength(1)
        expect(rows[0]?.lastSentAt ?? null).toBeNull()
        expect(rows[0]?.addresses).toEqual([])
    })

    it('rejeita o template `sql` cru que causou a falha em produção', async () => {
        // Guarda de regressão explícita: se um dia o driver passar a aceitar isso, este teste falha e
        // avisa que a proteção virou redundante — em vez de a proteção sumir sem ninguém perceber.
        await expect(db.select({ n: sql<number>`count(*)` })
            .from(warmupMessages)
            .where(and(
                eq(warmupMessages.fromAccountId, ABSENT_ACCOUNT),
                sql`${warmupMessages.sentAt} >= ${startOfDay}`,
            ))).rejects.toThrow(/string|Date/)
    })
})
