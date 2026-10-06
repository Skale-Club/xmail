/**
 * Remove do Unified Inbox as conversas de tráfego de warm-up (mesh).
 *
 * Medido em produção em 2026-10-06: 8.770 das 9.008 conversas (97%) eram tráfego sintético entre
 * as nossas próprias caixas, e 0 eram respostas de campanha. As 238 conversas das `info@`
 * (warmup_source='none') são trabalho real e FICAM. O código novo já não ingere esse tráfego
 * (src/server/lib/unified-inbox/warmup-traffic.ts); este script limpa o que já entrou.
 *
 * Definição de mesh (a mesma do código): `warmup_source = 'internal' OR warmup_only = true`.
 * 'vendor' e 'provider' NÃO são mesh (migration 058: só 'internal' participa).
 *
 * O que conta como warm-up (e só isso é apagado). Condição de entrada, sempre: a caixa DONA da
 * conversa é do mesh E `campaign_id IS NULL`. Uma `info@` (warmup_source='none') nunca é alvo,
 * mesmo que alguém escreva para ela de um endereço do mesh ou encaminhe uma resposta de prospect.
 * Dentro do mesh, a conversa é alvo se:
 *   - `mesh_counterpart`: há ao menos um participante que não é a própria caixa e TODOS eles são
 *     endereços do mesh (basta um de fora para a conversa ser tratada como real); OU
 *   - `warmup_message_id`: alguma mensagem tem Message-ID / In-Reply-To / References no formato
 *     `w.<uuid>@…` que o motor de warm-up gera. É isso que pega o DSN (mailer-daemon respondendo a
 *     um envio de warm-up), cujo interlocutor não é do mesh.
 *
 * Conversas de caixas `warmup_only` que NÃO se encaixam em nenhum dos dois critérios (interlocutor
 * fora do mesh e sem referência de warm-up) NÃO são apagadas: aparecem numa seção separada,
 * "preservadas para revisão manual". Essas caixas saíram da ingestão futura, mas o que já está lá
 * pode ser mail de verdade que alguém mandou por engano.
 *
 * Uso:
 *   npx tsx scripts/purge-warmup-inbox-conversations.ts            # DRY-RUN: só conta e imprime
 *   npx tsx scripts/purge-warmup-inbox-conversations.ts --apply    # apaga, em UMA transação
 *   DATABASE_URL="postgres://…" npx tsx scripts/purge-warmup-inbox-conversations.ts
 *
 * O dry-run e o --apply percorrem o mesmo caminho (mesma tabela temporária de alvos); o dry-run
 * termina em ROLLBACK. Só o --apply toma o lock descrito abaixo.
 *
 * Pré-requisito do --apply: migration 068 aplicada (o CHECK de materialization_status precisa
 * aceitar 'skipped'). O script confere e aborta antes de apagar qualquer coisa.
 *
 * Concorrência: o --apply começa com LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE em
 * outreach_conversation_messages e outreach_conversation_participants (lock_timeout de 30s). Isso
 * segura inserts concorrentes do materializador até o COMMIT, para que uma mensagem nova numa
 * conversa-alvo não derrube a transação com violação de FK (o materializador tenta de novo depois
 * e atribui a mensagem a uma conversa nova).
 *
 * Ordem do apagamento (as FKs compostas "ON DELETE SET NULL" sem lista de colunas tentariam
 * zerar também o organization_id NOT NULL, então tudo que aponta para as mensagens é
 * desvinculado ANTES de apagar as mensagens):
 *   1. outreach_provider_events -> conversation_message_id = NULL, materialization_status =
 *      'skipped' (a linha fica como registro de dedupe do provedor, não é apagada)
 *   2. outreach_conversations.last_message_id = NULL
 *   3. outreach_conversation_reads, inbox_reminders, inbox_conversation_labels,
 *      inbox_attachments (dos comandos de envio alvo), inbox_send_commands,
 *      outreach_conversation_participants, outreach_conversation_messages
 *   4. outreach_conversations
 * outreach_ai_runs.conversation_id vira NULL sozinho (SET NULL com lista de colunas): a trilha de
 * auditoria da IA sobrevive.
 *
 * Anexos: os caminhos de storage das linhas de inbox_attachments apagadas são coletados antes do
 * DELETE. No dry-run são impressos; no --apply os objetos são removidos do storage DEPOIS do
 * COMMIT, em melhor esforço (uma falha só imprime os caminhos que sobraram).
 */
import 'dotenv/config'
import postgres from 'postgres'

export interface PurgeOptions {
    apply: boolean
}

export function parsePurgeArgs(argv: string[]): PurgeOptions {
    return { apply: argv.includes('--apply') }
}

class DryRunComplete extends Error {
    constructor() {
        super('dry-run complete (rolled back)')
    }
}

// postgres.js types a transaction handle as TransactionSql, whose tagged-template call signature
// is lost in the Omit<> it is built from; at runtime it is callable exactly like the root client.
type Sql = postgres.Sql

interface AccountBreakdownRow {
    account_email: string
    warmup_only: boolean
    warmup_source: string
    category: string
    conversations: number
}

interface PreservedRow {
    account_email: string
    warmup_source: string
    conversations: number
}

interface ReviewRow {
    account_email: string
    conversations: number
}

interface AttachmentRef {
    bucket: string
    path: string
}

function pad(value: string | number, width: number): string {
    const text = String(value)
    return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length)
}

/**
 * Materializa os alvos (e a lista de revisão manual) em tabelas temporárias da transação. Fica em
 * um único lugar para que o dry-run e o --apply não possam divergir na definição de "warm-up".
 */
async function createTargets(tx: Sql): Promise<void> {
    await tx`
        CREATE TEMP TABLE warmup_purge_classified ON COMMIT DROP AS
        WITH mesh AS (
            SELECT LOWER(email) AS email
            FROM email_accounts
            WHERE warmup_source = 'internal' OR warmup_only = true
        )
        SELECT c.id, c.organization_id, c.email_account_id,
               ea.email AS account_email, ea.warmup_only, ea.warmup_source,
               -- ao menos um participante que não é a própria caixa, e nenhum fora do mesh
               (
                   EXISTS (
                       SELECT 1 FROM outreach_conversation_participants p
                       WHERE p.organization_id = c.organization_id
                         AND p.conversation_id = c.id
                         AND LOWER(p.address) <> LOWER(ea.email)
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM outreach_conversation_participants p
                       WHERE p.organization_id = c.organization_id
                         AND p.conversation_id = c.id
                         AND LOWER(p.address) <> LOWER(ea.email)
                         AND LOWER(p.address) NOT IN (SELECT email FROM mesh)
                   )
               ) AS counterparts_in_mesh,
               -- Message-ID / In-Reply-To / References no formato w.<uuid>@ do motor de warm-up
               EXISTS (
                   SELECT 1 FROM outreach_conversation_messages m
                   WHERE m.organization_id = c.organization_id
                     AND m.conversation_id = c.id
                     AND (
                         COALESCE(m.internet_message_id, '') || ' ' ||
                         COALESCE(m.in_reply_to, '') || ' ' ||
                         COALESCE(m.message_references, '')
                     ) ~* '(^|[<[:space:]])w[.][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@'
               ) AS has_warmup_message_id
        FROM outreach_conversations c
        JOIN email_accounts ea ON ea.id = c.email_account_id
        WHERE c.campaign_id IS NULL
          -- Condição de entrada: a caixa dona é do mesh. info@ (warmup_source='none') nunca entra.
          AND (ea.warmup_source = 'internal' OR ea.warmup_only = true)
    `
    await tx`
        CREATE TEMP TABLE warmup_purge_targets ON COMMIT DROP AS
        SELECT id, organization_id, email_account_id, account_email, warmup_only, warmup_source,
               CASE WHEN counterparts_in_mesh THEN 'mesh_counterpart' ELSE 'warmup_message_id' END AS category
        FROM warmup_purge_classified
        WHERE counterparts_in_mesh OR has_warmup_message_id
    `
    await tx`CREATE INDEX ON warmup_purge_targets (id)`
    // Caixas warmup_only com interlocutor fora do mesh e sem referência de warm-up: não apagar.
    await tx`
        CREATE TEMP TABLE warmup_purge_review ON COMMIT DROP AS
        SELECT id, organization_id, account_email
        FROM warmup_purge_classified
        WHERE warmup_only = true AND NOT counterparts_in_mesh AND NOT has_warmup_message_id
    `
}

async function count(query: PromiseLike<Array<{ n: string | number }>>): Promise<number> {
    const rows = await query
    return Number(rows[0]?.n ?? 0)
}

async function collectAttachments(tx: Sql): Promise<AttachmentRef[]> {
    const rows = await tx<{ storage_bucket: string; storage_path: string }[]>`
        SELECT a.storage_bucket, a.storage_path
        FROM inbox_attachments a
        WHERE a.send_command_id IN (
            SELECT sc.id FROM inbox_send_commands sc
            WHERE sc.conversation_id IN (SELECT id FROM warmup_purge_targets)
        )
        ORDER BY a.storage_bucket, a.storage_path
    `
    return rows.map((row) => ({ bucket: row.storage_bucket, path: row.storage_path }))
}

async function report(tx: Sql): Promise<{ total: number; attachments: AttachmentRef[] }> {
    const [{ total_conversations }] = await tx<{ total_conversations: string }[]>`
        SELECT count(*)::text AS total_conversations FROM outreach_conversations
    `
    const total = await count(tx`SELECT count(*)::int AS n FROM warmup_purge_targets`)

    const byAccount = await tx<AccountBreakdownRow[]>`
        SELECT account_email, warmup_only, warmup_source, category, count(*)::int AS conversations
        FROM warmup_purge_targets
        GROUP BY account_email, warmup_only, warmup_source, category
        ORDER BY conversations DESC, account_email
    `
    const byCategory = await tx<{ category: string; conversations: number }[]>`
        SELECT category, count(*)::int AS conversations
        FROM warmup_purge_targets GROUP BY category ORDER BY category
    `
    const preserved = await tx<PreservedRow[]>`
        SELECT ea.email AS account_email, ea.warmup_source, count(*)::int AS conversations
        FROM outreach_conversations c
        JOIN email_accounts ea ON ea.id = c.email_account_id
        WHERE c.id NOT IN (SELECT id FROM warmup_purge_targets)
          AND c.id NOT IN (SELECT id FROM warmup_purge_review)
        GROUP BY ea.email, ea.warmup_source
        ORDER BY conversations DESC, ea.email
    `
    const preservedCampaign = await count(tx`
        SELECT count(*)::int AS n FROM outreach_conversations c
        WHERE c.campaign_id IS NOT NULL AND c.id NOT IN (SELECT id FROM warmup_purge_targets)
    `)
    const review = await tx<ReviewRow[]>`
        SELECT account_email, count(*)::int AS conversations
        FROM warmup_purge_review GROUP BY account_email ORDER BY conversations DESC, account_email
    `

    const messages = await count(tx`
        SELECT count(*)::int AS n FROM outreach_conversation_messages
        WHERE conversation_id IN (SELECT id FROM warmup_purge_targets)
    `)
    const events = await count(tx`
        SELECT count(*)::int AS n FROM outreach_provider_events
        WHERE conversation_message_id IN (
            SELECT m.id FROM outreach_conversation_messages m
            WHERE m.conversation_id IN (SELECT id FROM warmup_purge_targets)
        )
    `)
    const reads = await count(tx`SELECT count(*)::int AS n FROM outreach_conversation_reads WHERE conversation_id IN (SELECT id FROM warmup_purge_targets)`)
    const reminders = await count(tx`SELECT count(*)::int AS n FROM inbox_reminders WHERE conversation_id IN (SELECT id FROM warmup_purge_targets)`)
    const labels = await count(tx`SELECT count(*)::int AS n FROM inbox_conversation_labels WHERE conversation_id IN (SELECT id FROM warmup_purge_targets)`)
    const commands = await count(tx`SELECT count(*)::int AS n FROM inbox_send_commands WHERE conversation_id IN (SELECT id FROM warmup_purge_targets)`)
    const aiRuns = await count(tx`SELECT count(*)::int AS n FROM outreach_ai_runs WHERE conversation_id IN (SELECT id FROM warmup_purge_targets)`)
    const attachments = await collectAttachments(tx)

    console.log(`\nConversas no Unified Inbox: ${total_conversations}`)
    console.log(`Conversas de warm-up (alvos):  ${total}`)

    console.log('\n=== POR CATEGORIA ===')
    for (const row of byCategory) console.log(`  ${pad(row.category, 24)} ${row.conversations}`)

    console.log('\n=== POR CAIXA (alvos) ===')
    console.log(`  ${pad('caixa', 40)} ${pad('warmup_only', 12)} ${pad('source', 10)} ${pad('categoria', 22)} conversas`)
    for (const row of byAccount) {
        console.log(`  ${pad(row.account_email, 40)} ${pad(String(row.warmup_only), 12)} ${pad(row.warmup_source, 10)} ${pad(row.category, 22)} ${row.conversations}`)
    }

    console.log('\n=== PRESERVADAS PARA REVISÃO MANUAL (warmup_only, interlocutor fora do mesh) - NÃO apagadas ===')
    if (review.length === 0) console.log('  (nenhuma)')
    for (const row of review) console.log(`  ${pad(row.account_email, 40)} ${row.conversations}`)

    console.log('\n=== PRESERVADAS (não tocadas) ===')
    for (const row of preserved) console.log(`  ${pad(row.account_email, 40)} source=${pad(row.warmup_source, 10)} ${row.conversations}`)
    console.log(`  (das preservadas, ${preservedCampaign} pertencem a campanha)`)

    console.log('\n=== DEPENDENTES DOS ALVOS ===')
    console.log(`  mensagens apagadas:                        ${messages}`)
    console.log(`  eventos de provedor desvinculados:         ${events}  (viram 'skipped', linha mantida)`)
    console.log(`  read-states / lembretes / labels / comandos: ${reads} / ${reminders} / ${labels} / ${commands}`)
    console.log(`  execuções de IA com conversation_id nulo:  ${aiRuns}  (auditoria preservada)`)
    console.log(`  anexos (objetos de storage):               ${attachments.length}`)
    for (const attachment of attachments) console.log(`    ${attachment.bucket}/${attachment.path}`)

    // Alerta de sanidade: qualquer alvo com intervenção humana merece um olhar antes do --apply.
    if (reminders + labels + commands > 0) {
        console.log('\nATENÇÃO: há lembretes/labels/comandos de envio em conversas de warm-up. Confira antes de --apply.')
    }
    return { total, attachments }
}

async function assertSkippedStatusAllowed(tx: Sql): Promise<void> {
    const rows = await tx<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conname = 'outreach_provider_events_materialization_status_check'
          AND conrelid = 'public.outreach_provider_events'::regclass
    `
    if (!rows[0]?.def.includes("'skipped'")) {
        throw new Error(
            "A migration 068 ainda não foi aplicada: o CHECK de outreach_provider_events.materialization_status não aceita 'skipped'. " +
            'Aplique-a antes de rodar com --apply. Nada foi apagado.',
        )
    }
}

async function purge(tx: Sql): Promise<void> {
    // 1. Desvincula os eventos de provedor (a FK composta SET NULL tentaria zerar organization_id).
    await tx`
        UPDATE outreach_provider_events SET
            conversation_message_id = NULL,
            materialization_status = 'skipped',
            updated_at = now()
        WHERE conversation_message_id IN (
            SELECT m.id FROM outreach_conversation_messages m
            WHERE m.conversation_id IN (SELECT id FROM warmup_purge_targets)
        )
    `
    // 2. A conversa aponta para a própria última mensagem (mesma FK composta).
    await tx`UPDATE outreach_conversations SET last_message_id = NULL WHERE id IN (SELECT id FROM warmup_purge_targets)`
    // 3. Dependentes, das folhas para cima.
    await tx`DELETE FROM outreach_conversation_reads WHERE conversation_id IN (SELECT id FROM warmup_purge_targets)`
    await tx`DELETE FROM inbox_reminders WHERE conversation_id IN (SELECT id FROM warmup_purge_targets)`
    await tx`DELETE FROM inbox_conversation_labels WHERE conversation_id IN (SELECT id FROM warmup_purge_targets)`
    await tx`
        DELETE FROM inbox_attachments WHERE send_command_id IN (
            SELECT sc.id FROM inbox_send_commands sc
            WHERE sc.conversation_id IN (SELECT id FROM warmup_purge_targets)
        )
    `
    await tx`DELETE FROM inbox_send_commands WHERE conversation_id IN (SELECT id FROM warmup_purge_targets)`
    await tx`DELETE FROM outreach_conversation_participants WHERE conversation_id IN (SELECT id FROM warmup_purge_targets)`
    await tx`DELETE FROM outreach_conversation_messages WHERE conversation_id IN (SELECT id FROM warmup_purge_targets)`
    // 4. As conversas.
    const deleted = await tx`DELETE FROM outreach_conversations WHERE id IN (SELECT id FROM warmup_purge_targets)`
    console.log(`\nApagadas ${deleted.count} conversas.`)
}

/** Remove os objetos de storage dos anexos apagados. Melhor esforço: uma falha só lista o que sobrou. */
async function removeStorageObjects(attachments: AttachmentRef[]): Promise<void> {
    if (attachments.length === 0) return
    const byBucket = new Map<string, string[]>()
    for (const attachment of attachments) {
        const paths = byBucket.get(attachment.bucket) ?? []
        paths.push(attachment.path)
        byBucket.set(attachment.bucket, paths)
    }
    try {
        const { createObjectStorage } = await import('../src/server/lib/object-storage')
        const storage = createObjectStorage()
        for (const [bucket, paths] of byBucket) {
            await storage.remove(bucket, paths)
            console.log(`Storage: ${paths.length} objeto(s) removido(s) de ${bucket}.`)
        }
    } catch (error) {
        console.error('Storage: falha ao remover objetos (as linhas do banco já foram apagadas). Remova manualmente:')
        for (const attachment of attachments) console.error(`  ${attachment.bucket}/${attachment.path}`)
        console.error(error instanceof Error ? error.message : error)
    }
}

async function main(): Promise<void> {
    const options = parsePurgeArgs(process.argv.slice(2))
    const url = process.env.DATABASE_URL
    if (!url) {
        console.error('DATABASE_URL não está setada. Rode com o .env montado ou passe a variável inline.')
        process.exit(1)
    }
    const sql = postgres(url, { ssl: 'require', prepare: false, onnotice: () => { } })
    let committedAttachments: AttachmentRef[] = []

    try {
        console.log(options.apply
            ? 'MODO --apply: as conversas de warm-up serão APAGADAS (uma transação).'
            : 'DRY-RUN: nada será apagado. Use --apply para executar.')
        console.log(`Banco: ${new URL(url).host}`)

        await sql.begin(async (txHandle) => {
            const tx = txHandle as unknown as Sql
            if (options.apply) {
                await assertSkippedStatusAllowed(tx)
                // Segura inserts concorrentes do materializador até o COMMIT (ver cabeçalho).
                await tx`SET LOCAL lock_timeout = '30s'`
                await tx`LOCK TABLE outreach_conversation_messages, outreach_conversation_participants IN SHARE ROW EXCLUSIVE MODE`
            }
            await createTargets(tx)
            const { total, attachments } = await report(tx)
            if (!options.apply) throw new DryRunComplete()
            if (total === 0) {
                console.log('\nNada a apagar.')
                return
            }
            await purge(tx)
            const [{ remaining }] = await tx<{ remaining: number }[]>`
                SELECT count(*)::int AS remaining FROM outreach_conversations WHERE id IN (SELECT id FROM warmup_purge_targets)
            `
            if (remaining !== 0) throw new Error(`Verificação falhou: ${remaining} alvos ainda existem. ROLLBACK.`)
            committedAttachments = attachments
        })
        console.log('\nConcluído (COMMIT).')
        await removeStorageObjects(committedAttachments)
    } catch (error) {
        if (error instanceof DryRunComplete) {
            console.log('\nDRY-RUN concluído: nenhuma alteração gravada.')
        } else {
            console.error('\nFalhou:', error instanceof Error ? error.message : error)
            process.exitCode = 1
        }
    } finally {
        await sql.end()
    }
}

// Só executa quando chamado diretamente (o parser de argumentos é importável em testes).
const invokedDirectly = process.argv[1] && /purge-warmup-inbox-conversations\.[cm]?[tj]s$/.test(process.argv[1].replace(/\\/g, '/'))
if (invokedDirectly) {
    void main()
}
