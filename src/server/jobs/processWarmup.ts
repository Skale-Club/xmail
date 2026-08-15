/**
 * Warm-up mesh — o aquecimento real de caixas (migration 051).
 *
 * Duas fases por tick, ambas dentro de um advisory lock:
 *
 *  SEND  — cada caixa do mesh (`email_accounts.warmup_source = 'internal'`, verificada) manda um
 *          número pequeno e crescente de mensagens por dia para OUTRAS caixas do mesh, priorizando
 *          outro domínio e outro provedor (par no mesmo domínio é loop fechado e vale quase nada).
 *          Volume, espaçamento e conteúdo vêm de `lib/warmup/plan.ts` e `lib/warmup/content.ts` —
 *          determinísticos por semente, sem custo de LLM.
 *
 *  GROOM — do lado do destinatário, localiza cada mensagem pelo Message-ID (nenhum header
 *          X-Warmup: marcador próprio denunciaria o tráfego), e executa o ciclo que um humano
 *          engajado executaria: caiu em Spam → move para a Inbox (o sinal mais forte que existe);
 *          na Inbox → marca como lida, responde uma fração em thread e ARQUIVA — o inbox de quem
 *          participa não acumula ruído de aquecimento.
 *
 * O que este job NUNCA faz: tocar em cota de campanha (`current_daily_sent`), inflar métricas de
 * campanha (`total_sent`), ou enviar para quem não é do mesh. A rampa (`warmup_current_day`)
 * avança via resetDailyLimits, que conta `warmup_sent_today > 0` como dia de envio real.
 */

import { randomUUID } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
    emailAccounts,
    mailboxes,
    mailFolders,
    mailMessages,
    users,
    warmupMessages,
    type EmailAccount,
    type WarmupMessage,
} from '../../db/schema'
import { decryptSecret } from '../lib/crypto'
import { recomputeFolderCounts } from '../lib/folder-counts'
import { runWithLock } from '../lib/cron-lock'
import { createLogger } from '../lib/logger'
import { sendComposedOutreachMessage } from '../lib/outreach-provider'
import { generateWarmupContent, generateWarmupReply, replySubject } from '../lib/warmup/content'
import {
    hashFraction,
    remainingWarmupQuota,
    selectRecipients,
    shouldReply,
    type WarmupRecipient,
    type WarmupSender,
} from '../lib/warmup/plan'

const log = createLogger('outreach.warmup')

const WARMUP_LOCK_NAME = 'warmup-mesh-processor'
// Janela de envio em UTC ≈ 08:00–21:00 no Brasil. Fora dela o tick só faz GROOM.
const SEND_WINDOW_START_UTC = 11
const SEND_WINDOW_END_UTC = 23
// Espera mínima entre envio e detecção: dá tempo de o provedor entregar e classificar.
const DETECTION_DELAY_MS = 5 * 60 * 1000
// Depois disso sem aparecer em nenhuma pasta, a mensagem é dada como perdida.
const DETECTION_GIVE_UP_MS = 3 * 24 * 60 * 60 * 1000

interface MeshAccount {
    account: EmailAccount
    domain: string
    providerHint: string
}

function domainOf(address: string): string {
    return address.split('@')[1]?.toLowerCase() ?? ''
}

/**
 * Dica de provedor para diversificação de pares. Para caixas IMAP o host de IMAP identifica a
 * infra real (imap.gmail.com → Google) melhor que qualquer campo declarativo.
 */
function providerHintOf(account: EmailAccount): string {
    if (account.provider === 'native') return 'native'
    if (account.provider === 'outlook') return 'outlook'
    const host = account.imapHost?.toLowerCase() ?? ''
    if (host.includes('gmail') || host.includes('google')) return 'gmail'
    if (host.includes('outlook') || host.includes('office365')) return 'outlook'
    return host || 'smtp'
}

async function loadMeshAccounts(): Promise<MeshAccount[]> {
    // O mesh é global do operador de propósito: o valor está exatamente em cruzar domínios (e
    // portanto orgs) que pertencem ao mesmo dono. Cada warmup_message fica na org do remetente.
    const rows = await db.query.emailAccounts.findMany({
        where: and(eq(emailAccounts.warmupSource, 'internal'), eq(emailAccounts.status, 'verified')),
    })
    return rows.map((account) => ({
        account,
        domain: domainOf(account.email),
        providerHint: providerHintOf(account),
    }))
}

function toSender(mesh: MeshAccount): WarmupSender {
    return {
        accountId: mesh.account.id,
        address: mesh.account.email,
        domain: mesh.domain,
        providerHint: mesh.providerHint,
        warmupCurrentDay: mesh.account.warmupCurrentDay,
        warmupDays: mesh.account.warmupDays,
        warmupSentToday: mesh.account.warmupSentToday,
    }
}

function toRecipient(mesh: MeshAccount): WarmupRecipient {
    return {
        accountId: mesh.account.id,
        address: mesh.account.email,
        domain: mesh.domain,
        providerHint: mesh.providerHint,
    }
}

function withinSendWindow(now: Date): boolean {
    const hour = now.getUTCHours()
    return hour >= SEND_WINDOW_START_UTC && hour < SEND_WINDOW_END_UTC
}

/**
 * Espaçamento humano: um envio só sai se o último envio desta caixa for mais velho que a fatia
 * "janela ÷ alvo do dia", com jitter determinístico por (conta, nº já enviado). Rajada é padrão
 * de robô; isso espalha o alvo diário pela janela sem precisar de agendador persistente.
 */
/**
 * Um fragmento `sql` cru não aplica o `mapFromDriverValue` da coluna, então uma anotação como
 * `sql<Date | null>` é só uma afirmação ao compilador: em runtime o driver devolve a timestamp como
 * STRING. Foi assim que `lastSentAt.getTime is not a function` derrubou a fase SEND inteira no
 * primeiro tick em que já existiam linhas do dia (com a tabela vazia, `max()` dava NULL e o caminho
 * quente nunca era exercido — o bug ficou escondido atrás de um estado que se esgotou sozinho).
 *
 * Normalizar na fronteira é mais barato que confiar na anotação, e cobre Date e string.
 */
function toDate(value: unknown): Date | null {
    if (value == null) return null
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
    const parsed = new Date(value as string)
    return Number.isNaN(parsed.getTime()) ? null : parsed
}

function dueForNextSend(sender: WarmupSender, lastSentAtRaw: unknown, now: Date): boolean {
    const lastSentAt = toDate(lastSentAtRaw)
    if (!lastSentAt) return true
    const windowMs = (SEND_WINDOW_END_UTC - SEND_WINDOW_START_UTC) * 60 * 60 * 1000
    const target = Math.max(1, sender.warmupSentToday + remainingWarmupQuota(sender))
    const baseGap = windowMs / target
    const jitter = 0.7 + hashFraction(`${sender.accountId}:${sender.warmupSentToday}`) * 0.6
    return now.getTime() - lastSentAt.getTime() >= baseGap * jitter
}

// ============================================================
// Fase SEND
// ============================================================

async function runSendPhase(mesh: MeshAccount[], now: Date): Promise<number> {
    if (!withinSendWindow(now) || mesh.length < 2) return 0

    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    let sent = 0

    for (const senderMesh of mesh) {
        const sender = toSender(senderMesh)
        if (remainingWarmupQuota(sender) <= 0) continue

        const [today] = await db.select({
            // Tipado como unknown de propósito: o driver devolve string aqui, não Date. Ver toDate().
            lastSentAt: sql<unknown>`max(${warmupMessages.sentAt})`,
            addresses: sql<string[]>`coalesce(array_agg(distinct ${warmupMessages.toAddress}), '{}')`,
        }).from(warmupMessages).where(and(
            eq(warmupMessages.fromAccountId, sender.accountId),
            // Operador tipado, não template `sql` cru: só o operador aplica o mapToDriverValue da
            // coluna. Com `sql\`... >= ${date}\`` o Date chega puro ao postgres-js, que tenta
            // serializá-lo como string e estoura ERR_INVALID_ARG_TYPE no Bind — a fase SEND inteira
            // morria no primeiro remetente e o mesh nunca enviava nada.
            gte(warmupMessages.sentAt, startOfDay),
        ))
        if (!dueForNextSend(sender, today?.lastSentAt ?? null, now)) continue

        const [recipient] = selectRecipients(
            sender,
            mesh.filter((m) => m.account.id !== sender.accountId).map(toRecipient),
            1,
            today?.addresses ?? [],
        )
        if (!recipient) continue

        // Message-ID sem colchetes no banco; o compositor MIME adiciona os colchetes no header.
        const messageId = `w.${randomUUID()}@${sender.domain}`
        const content = generateWarmupContent(messageId)

        const [row] = await db.insert(warmupMessages).values({
            organizationId: senderMesh.account.organizationId,
            fromAccountId: sender.accountId,
            toAccountId: recipient.accountId,
            toAddress: recipient.address,
            subject: content.subject,
            messageId,
            threadRootMessageId: messageId,
        }).onConflictDoNothing({ target: [warmupMessages.messageId] }).returning()
        if (!row) continue

        const result = await sendComposedOutreachMessage(senderMesh.account, {
            from: { address: sender.address, name: senderMesh.account.displayName ?? null },
            to: [recipient.address],
            subject: content.subject,
            text: content.text,
            messageId,
        })

        if (result.accepted) {
            await db.update(warmupMessages)
                .set({ status: 'sent', sentAt: new Date(), updatedAt: new Date() })
                .where(eq(warmupMessages.id, row.id))
            await db.update(emailAccounts)
                .set({
                    warmupSentToday: sql`${emailAccounts.warmupSentToday} + 1`,
                    warmupStartedAt: sql`coalesce(${emailAccounts.warmupStartedAt}, now())`,
                    updatedAt: new Date(),
                })
                .where(eq(emailAccounts.id, sender.accountId))
            sent += 1
        } else {
            await db.update(warmupMessages)
                .set({
                    status: 'failed',
                    lastError: (result.failure?.message ?? 'provider rejected').slice(0, 1000),
                    updatedAt: new Date(),
                })
                .where(eq(warmupMessages.id, row.id))
            log.warn({
                action: 'outreach.warmup.send_failed',
                fromAccountId: sender.accountId,
                error: result.failure?.message,
            }, 'warm-up send rejected by provider')
        }
    }
    return sent
}

// ============================================================
// Fase GROOM — detecção, resgate, resposta, arquivamento
// ============================================================

interface GroomContext {
    recipientMesh: MeshAccount
    senderByAccountId: Map<string, MeshAccount>
    now: Date
}

async function maybeReply(message: WarmupMessage, context: GroomContext): Promise<boolean> {
    if (message.repliedAt || !shouldReply(message.messageId)) return false
    const sender = context.senderByAccountId.get(message.fromAccountId)
    if (!sender) return false
    const reply = generateWarmupReply(message.messageId)
    const replyMessageId = `w.${randomUUID()}@${context.recipientMesh.domain}`
    const result = await sendComposedOutreachMessage(context.recipientMesh.account, {
        from: { address: context.recipientMesh.account.email, name: context.recipientMesh.account.displayName ?? null },
        to: [sender.account.email],
        subject: replySubject(message.subject),
        text: reply.text,
        messageId: replyMessageId,
        inReplyTo: message.messageId,
        references: [message.messageId],
    })
    return result.accepted
}

async function finalizeMessage(
    message: WarmupMessage,
    context: GroomContext,
    fields: Partial<typeof warmupMessages.$inferInsert>,
): Promise<void> {
    await db.update(warmupMessages)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(warmupMessages.id, message.id))
}

/** Localiza pastas de interesse por atributo special-use, com fallback por nome. */
function classifyImapFolders(folders: Array<{ path: string; specialUse?: string; flags?: Set<string> }>): {
    junkPath: string | null
    archivePath: string | null
} {
    let junkPath: string | null = null
    let archivePath: string | null = null
    for (const folder of folders) {
        const special = folder.specialUse ?? ''
        if (!junkPath && (special === '\\Junk' || /spam|junk/i.test(folder.path))) junkPath = folder.path
        if (!archivePath && (special === '\\Archive' || /all mail|archive/i.test(folder.path))) archivePath = folder.path
    }
    return { junkPath, archivePath }
}

async function groomImapAccount(context: GroomContext, pending: WarmupMessage[]): Promise<void> {
    const { account } = context.recipientMesh
    if (!account.imapHost || !account.imapUsername || !account.imapPassword) return

    const client = new ImapFlow({
        host: account.imapHost,
        port: account.imapPort || 993,
        secure: account.imapSecure !== false,
        auth: { user: account.imapUsername, pass: decryptSecret(account.imapPassword) },
        logger: false,
    })
    await client.connect()
    try {
        const folders = await client.list()
        const { junkPath, archivePath } = classifyImapFolders(folders as never)

        for (const message of pending) {
            const inInbox = await searchImapFolder(client, 'INBOX', message.messageId)
            if (inInbox !== null) {
                // Na Inbox: lê, talvez responde, arquiva. A ordem importa — é a sequência humana.
                const lock = await client.getMailboxLock('INBOX')
                try {
                    await client.messageFlagsAdd(String(inInbox), ['\\Seen'], { uid: true })
                    const replied = await maybeReply(message, context)
                    if (archivePath) await client.messageMove(String(inInbox), archivePath, { uid: true })
                    await finalizeMessage(message, context, {
                        status: 'archived',
                        detectedAt: message.detectedAt ?? context.now,
                        detectedFolder: message.detectedFolder ?? 'inbox',
                        repliedAt: replied ? context.now : message.repliedAt,
                        archivedAt: archivePath ? context.now : null,
                    })
                } finally {
                    lock.release()
                }
                continue
            }

            if (junkPath) {
                const inJunk = await searchImapFolder(client, junkPath, message.messageId)
                if (inJunk !== null) {
                    // Spam → Inbox: o resgate fica visível para o provedor. Arquivar só no
                    // próximo tick, para a mensagem "viver" um pouco na Inbox depois do resgate.
                    const lock = await client.getMailboxLock(junkPath)
                    try {
                        await client.messageMove(String(inJunk), 'INBOX', { uid: true })
                    } finally {
                        lock.release()
                    }
                    await finalizeMessage(message, context, {
                        status: 'rescued',
                        detectedAt: context.now,
                        detectedFolder: 'spam',
                        rescuedAt: context.now,
                    })
                    log.warn({
                        action: 'outreach.warmup.rescued_from_spam',
                        toAccountId: account.id,
                        fromAccountId: message.fromAccountId,
                    }, 'warm-up message landed in spam and was rescued')
                    continue
                }
            }

            if (context.now.getTime() - (message.sentAt?.getTime() ?? 0) > DETECTION_GIVE_UP_MS) {
                await finalizeMessage(message, context, {
                    status: 'failed',
                    detectedFolder: 'missing',
                    lastError: 'not found in inbox or spam within the detection window',
                })
            }
        }
    } finally {
        try { await client.logout() } catch { /* ignore */ }
    }
}

async function searchImapFolder(client: ImapFlow, path: string, messageId: string): Promise<number | null> {
    const lock = await client.getMailboxLock(path)
    try {
        const found = await client.search({ header: { 'message-id': `<${messageId}>` } }, { uid: true })
        if (found && found.length > 0) return found[found.length - 1]
        // Alguns servidores indexam o header sem os colchetes.
        const bare = await client.search({ header: { 'message-id': messageId } }, { uid: true })
        return bare && bare.length > 0 ? bare[bare.length - 1] : null
    } finally {
        lock.release()
    }
}

async function groomNativeAccount(context: GroomContext, pending: WarmupMessage[]): Promise<void> {
    const { account } = context.recipientMesh
    // Caixa nativa: o dono é um usuário da plataforma; a correspondência vive em mail_messages.
    const owner = await db.query.users.findFirst({ where: eq(users.email, account.email), columns: { id: true } })
    if (!owner) return
    const mailbox = await db.query.mailboxes.findFirst({
        where: and(eq(mailboxes.userId, owner.id), eq(mailboxes.email, account.email)),
        columns: { id: true },
    })
    if (!mailbox) return
    const folders = await db.query.mailFolders.findMany({
        where: eq(mailFolders.mailboxId, mailbox.id),
        columns: { id: true, type: true },
    })
    const folderByType = new Map(folders.map((folder) => [folder.type, folder.id]))
    const inboxId = folderByType.get('inbox')
    const archiveId = folderByType.get('archive')
    if (!inboxId) return

    for (const message of pending) {
        const stored = await db.query.mailMessages.findFirst({
            where: and(
                eq(mailMessages.mailboxId, mailbox.id),
                inArray(mailMessages.messageId, [`<${message.messageId}>`, message.messageId]),
            ),
        })
        if (!stored) {
            if (context.now.getTime() - (message.sentAt?.getTime() ?? 0) > DETECTION_GIVE_UP_MS) {
                await finalizeMessage(message, context, {
                    status: 'failed',
                    detectedFolder: 'missing',
                    lastError: 'not found in native mailbox within the detection window',
                })
            }
            continue
        }

        // O MX nativo não reclassifica para spam (greylist é pré-aceitação), então o caminho aqui
        // é o feliz: ler, talvez responder, arquivar.
        const replied = await maybeReply(message, context)
        await db.update(mailMessages)
            .set({ isRead: true, ...(archiveId ? { folderId: archiveId } : {}) })
            .where(eq(mailMessages.id, stored.id))
        await recomputeFolderCounts(stored.folderId)
        if (archiveId && archiveId !== stored.folderId) await recomputeFolderCounts(archiveId)
        await finalizeMessage(message, context, {
            status: 'archived',
            detectedAt: context.now,
            detectedFolder: 'inbox',
            repliedAt: replied ? context.now : null,
            archivedAt: archiveId ? context.now : null,
        })
    }
}

async function runGroomPhase(mesh: MeshAccount[], now: Date): Promise<number> {
    const meshById = new Map(mesh.map((entry) => [entry.account.id, entry]))
    const awaiting = await db.query.warmupMessages.findMany({
        where: and(
            inArray(warmupMessages.status, ['sent', 'rescued']),
            lt(warmupMessages.sentAt, new Date(now.getTime() - DETECTION_DELAY_MS)),
        ),
        limit: 200,
    })
    if (awaiting.length === 0) return 0

    const byRecipient = new Map<string, WarmupMessage[]>()
    for (const message of awaiting) {
        const list = byRecipient.get(message.toAccountId) ?? []
        list.push(message)
        byRecipient.set(message.toAccountId, list)
    }

    let groomed = 0
    for (const [toAccountId, pending] of byRecipient) {
        const recipientMesh = meshById.get(toAccountId)
        if (!recipientMesh) continue
        const context: GroomContext = { recipientMesh, senderByAccountId: meshById, now }
        try {
            if (recipientMesh.account.provider === 'native') {
                await groomNativeAccount(context, pending)
            } else if (recipientMesh.account.provider === 'smtp') {
                await groomImapAccount(context, pending)
            } else {
                // Outlook entra no mesh numa fase futura (arquivar exige Graph API, não IMAP).
                continue
            }
            groomed += pending.length
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            log.error({
                action: 'outreach.warmup.groom_failed',
                toAccountId,
                error: { message: err.message },
            }, 'warm-up groom failed for account')
        }
    }
    return groomed
}

// ============================================================
// Entry point
// ============================================================

export async function processWarmupMesh(now = new Date()): Promise<{ sent: number; groomed: number }> {
    const mesh = await loadMeshAccounts()
    if (mesh.length < 2) return { sent: 0, groomed: 0 }
    const sent = await runSendPhase(mesh, now)
    const groomed = await runGroomPhase(mesh, now)
    if (sent > 0 || groomed > 0) {
        log.info({ action: 'outreach.warmup.tick', meshSize: mesh.length, sent, groomed }, 'warm-up tick')
    }
    return { sent, groomed }
}

export async function runWarmupMeshWithLock(): Promise<void> {
    await runWithLock(WARMUP_LOCK_NAME, async () => {
        await processWarmupMesh()
    })
}
