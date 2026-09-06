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
 *  GROOM — do lado do destinatário, localiza cada mensagem pelo Message-ID e, quando o caminho de
 *          entrega o reescreveu (o relay Brevo das caixas nativas faz isso), pelo envelope
 *          remetente+assunto+janela — ver `lib/warmup/detect.ts`; nenhum header X-Warmup:
 *          marcador próprio denunciaria o tráfego. Depois executa o ciclo que um humano
 *          engajado executaria: caiu em Spam → move para a Inbox (o sinal mais forte que existe);
 *          na Inbox → marca como lida, responde uma fração em thread e ARQUIVA — o inbox de quem
 *          participa não acumula ruído de aquecimento.
 *
 * O que este job NUNCA faz: tocar em cota de campanha (`current_daily_sent`), inflar métricas de
 * campanha (`total_sent`), ou enviar para quem não é do mesh. A rampa (`warmup_current_day`)
 * avança via resetDailyLimits, que conta `warmup_sent_today > 0` como dia de envio real.
 */

import { randomUUID } from 'node:crypto'
import type { ImapFlow } from 'imapflow'
import { createImapClient } from '../lib/imap-client'
import { and, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
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
import { JOB_TIMEOUT_BUDGETS_MS, runWithLock } from '../lib/cron-lock'
import { createLogger } from '../lib/logger'
import { sendComposedOutreachMessage } from '../lib/outreach-provider'
import { generateWarmupContent, generateWarmupReply, replySubject } from '../lib/warmup/content'
import {
    DETECTION_WINDOW_BEFORE_MS,
    normalizeMessageId,
    pickDeliveredCopy,
    type ExpectedDelivery,
} from '../lib/warmup/detect'
import {
    hashFraction,
    remainingWarmupQuota,
    selectRecipients,
    shouldReply,
    type WarmupRecipient,
    type WarmupSender,
} from '../lib/warmup/plan'
import { decideWarmupSendOutcome } from '../lib/warmup/retry'
import { OutboundCircuit } from '../lib/outbound-circuit'

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

/**
 * Writes back the outcome of one send attempt (fresh or retry) and reports whether it landed.
 *
 * Success always resolves to `status: 'sent'` and bumps the sender's daily count, exactly as
 * before. Failure now goes through `decideWarmupSendOutcome` (lib/warmup/retry.ts) instead of an
 * unconditional `status: 'failed'`: a 4xx (or an unclassifiable failure) stays `pending` with a
 * scheduled `nextAttemptAt` and only becomes `failed` once it is a real 5xx or the attempt cap is
 * hit. `attemptsSoFar` is the row's `attempts` value BEFORE this call — always 0 for a brand-new
 * message, whatever the row already has for a retry.
 */
async function recordSendOutcome(
    rowId: string,
    senderAccountId: string,
    result: Awaited<ReturnType<typeof sendComposedOutreachMessage>>,
    attemptsSoFar: number,
    now: Date,
): Promise<boolean> {
    if (result.accepted) {
        await db.update(warmupMessages)
            .set({ status: 'sent', sentAt: now, attempts: attemptsSoFar + 1, nextAttemptAt: null, updatedAt: now })
            .where(eq(warmupMessages.id, rowId))
        await db.update(emailAccounts)
            .set({
                warmupSentToday: sql`${emailAccounts.warmupSentToday} + 1`,
                warmupStartedAt: sql`coalesce(${emailAccounts.warmupStartedAt}, now())`,
                updatedAt: now,
            })
            .where(eq(emailAccounts.id, senderAccountId))
        return true
    }

    const outcome = decideWarmupSendOutcome({ failure: result.failure, attemptsSoFar, now })
    await db.update(warmupMessages)
        .set({
            status: outcome.status,
            attempts: outcome.attempts,
            nextAttemptAt: outcome.nextAttemptAt,
            lastError: outcome.lastError.slice(0, 1000),
            updatedAt: now,
        })
        .where(eq(warmupMessages.id, rowId))

    if (outcome.status === 'failed') {
        log.warn({
            action: 'outreach.warmup.send_failed',
            fromAccountId: senderAccountId,
            attempts: outcome.attempts,
            error: outcome.lastError,
        }, 'warm-up send rejected by provider (terminal or attempt cap reached)')
    } else {
        log.info({
            action: 'outreach.warmup.send_retry_scheduled',
            fromAccountId: senderAccountId,
            attempts: outcome.attempts,
            nextAttemptAt: outcome.nextAttemptAt,
            error: outcome.lastError,
        }, 'warm-up send failed temporarily, retry scheduled')
    }
    return false
}

/**
 * Resends every `pending` message whose backoff has elapsed. Reuses the ORIGINAL `messageId` (an
 * MTA retry is the same message, not a new one) and regenerates the same body from it —
 * `generateWarmupContent` is deterministic by seed (content.ts), so this reproduces byte-identical
 * text without needing to have stored the body anywhere.
 */
async function runRetryPhase(mesh: MeshAccount[], now: Date, circuit: OutboundCircuit): Promise<number> {
    const meshById = new Map(mesh.map((m) => [m.account.id, m]))

    const due = await db.query.warmupMessages.findMany({
        where: and(
            eq(warmupMessages.status, 'pending'),
            gt(warmupMessages.attempts, 0),
            // Typed operators, not a raw `sql` template with a Date bound in — see the comment on
            // dueForNextSend's caller below for why a raw template with a Date breaks the driver.
            or(isNull(warmupMessages.nextAttemptAt), lte(warmupMessages.nextAttemptAt, now)),
        ),
        limit: 50,
    })
    if (due.length === 0) return 0

    let retried = 0
    for (const row of due) {
        if (circuit.open) {
            logCircuitOpen(circuit, 'retry')
            break
        }
        const senderMesh = meshById.get(row.fromAccountId)
        if (!senderMesh) {
            // Sender left the mesh (removed, un-verified) since this message was queued —
            // nothing left to retry with.
            await db.update(warmupMessages)
                .set({ status: 'failed', lastError: 'sender account no longer in warm-up mesh', updatedAt: now })
                .where(eq(warmupMessages.id, row.id))
            continue
        }

        const content = generateWarmupContent(row.messageId)
        const result = await sendComposedOutreachMessage(senderMesh.account, {
            from: { address: senderMesh.account.email, name: senderMesh.account.displayName ?? null },
            to: [row.toAddress],
            subject: content.subject,
            text: content.text,
            messageId: row.messageId,
        })
        circuit.record(result.accepted ? null : result.failure?.code)
        if (await recordSendOutcome(row.id, senderMesh.account.id, result, row.attempts, now)) retried += 1
    }
    return retried
}

function logCircuitOpen(circuit: OutboundCircuit, phase: 'retry' | 'send'): void {
    log.error({
        action: 'outreach.warmup.outbound_circuit_open',
        phase,
        consecutiveTransportFailures: circuit.consecutiveTransportFailures,
    }, 'outbound transport is failing for every warm-up send; ending this tick early')
}

async function runSendPhase(mesh: MeshAccount[], now: Date): Promise<number> {
    if (!withinSendWindow(now) || mesh.length < 2) return 0

    // One breaker for the whole send phase (retries + fresh sends): a host that cannot reach any
    // MX fails every pair the same way, and the tick should stop instead of marking each one.
    const circuit = new OutboundCircuit()

    // Retries first: a due message gets another attempt before this sender is considered for a
    // brand-new one, so a backing-off pair doesn't also accumulate fresh sends on top.
    let sent = await runRetryPhase(mesh, now, circuit)

    const retryingAccountIds = new Set((await db.query.warmupMessages.findMany({
        where: and(eq(warmupMessages.status, 'pending'), gt(warmupMessages.attempts, 0)),
        columns: { fromAccountId: true },
    })).map((row) => row.fromAccountId))

    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

    for (const senderMesh of mesh) {
        if (circuit.open) {
            logCircuitOpen(circuit, 'send')
            break
        }
        const sender = toSender(senderMesh)
        if (remainingWarmupQuota(sender) <= 0) continue
        // A retry is already scheduled (not yet due, or this tick's retry attempt just failed
        // again) — let it resolve before piling on a fresh send to a possibly-different recipient.
        if (retryingAccountIds.has(sender.accountId)) continue

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
        circuit.record(result.accepted ? null : result.failure?.code)

        if (await recordSendOutcome(row.id, sender.accountId, result, row.attempts, now)) sent += 1
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

/**
 * `deliveredMessageId` é o Message-ID como a cópia chegou ao destinatário — igual ao nosso quando
 * o caminho preservou, o do relay quando reescreveu. `In-Reply-To` aponta para o NOSSO id (é o que
 * a caixa do remetente tem na pasta Enviados, e é ela quem vai ler a resposta); `References` lista
 * os dois, para que o lado que só conhece o id reescrito também encadeie.
 */
async function maybeReply(
    message: WarmupMessage,
    context: GroomContext,
    deliveredMessageId: string | null,
): Promise<boolean> {
    if (message.repliedAt || !shouldReply(message.messageId)) return false
    const sender = context.senderByAccountId.get(message.fromAccountId)
    if (!sender) return false
    const reply = generateWarmupReply(message.messageId)
    const replyMessageId = `w.${randomUUID()}@${context.recipientMesh.domain}`
    const references = [message.messageId]
    const delivered = normalizeMessageId(deliveredMessageId)
    if (delivered && delivered !== normalizeMessageId(message.messageId)) references.push(delivered)
    const result = await sendComposedOutreachMessage(context.recipientMesh.account, {
        from: { address: context.recipientMesh.account.email, name: context.recipientMesh.account.displayName ?? null },
        to: [sender.account.email],
        subject: replySubject(message.subject),
        text: reply.text,
        messageId: replyMessageId,
        inReplyTo: message.messageId,
        references,
    })
    return result.accepted
}

function expectedDeliveryOf(message: WarmupMessage, context: GroomContext): ExpectedDelivery | null {
    const sender = context.senderByAccountId.get(message.fromAccountId)
    if (!sender || !message.sentAt) return null
    return {
        fromAddress: sender.account.email,
        subject: message.subject,
        sentAt: message.sentAt,
        messageId: message.messageId,
    }
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

/** Cópia entregue localizada numa pasta IMAP. */
interface ImapHit {
    uid: number
    /** Message-ID como chegou (sem colchetes), para o `References` da resposta. */
    deliveredMessageId: string | null
}

async function giveUpIfExpired(message: WarmupMessage, context: GroomContext, where: string): Promise<void> {
    if (context.now.getTime() - (message.sentAt?.getTime() ?? 0) > DETECTION_GIVE_UP_MS) {
        await finalizeMessage(message, context, {
            status: 'failed',
            detectedFolder: 'missing',
            lastError: `not found in ${where} within the detection window`,
        })
    }
}

/** Devolve quantas mensagens de `pending` foram localizadas (e tratadas) na caixa. */
async function groomImapAccount(context: GroomContext, pending: WarmupMessage[]): Promise<number> {
    const { account } = context.recipientMesh
    if (!account.imapHost || !account.imapUsername || !account.imapPassword) return 0

    // createImapClient: crash guard + bounded timeouts — see lib/imap-client.ts.
    const client = createImapClient({
        host: account.imapHost,
        port: account.imapPort,
        secure: account.imapSecure,
        auth: { user: account.imapUsername, pass: decryptSecret(account.imapPassword) },
    }, { emailAccountId: account.id, purpose: 'warmup-groom' })
    await client.connect()
    let detected = 0
    try {
        const folders = await client.list()
        const { junkPath, archivePath } = classifyImapFolders(folders as never)

        for (const message of pending) {
            const expected = expectedDeliveryOf(message, context)
            if (!expected) {
                await giveUpIfExpired(message, context, 'inbox or spam')
                continue
            }

            const inInbox = await locateInImapFolder(client, 'INBOX', expected)
            if (inInbox) {
                detected += 1
                // Na Inbox: lê, talvez responde, arquiva. A ordem importa — é a sequência humana.
                const lock = await client.getMailboxLock('INBOX')
                try {
                    await client.messageFlagsAdd(String(inInbox.uid), ['\\Seen'], { uid: true })
                    const replied = await maybeReply(message, context, inInbox.deliveredMessageId)
                    if (archivePath) await client.messageMove(String(inInbox.uid), archivePath, { uid: true })
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
                const inJunk = await locateInImapFolder(client, junkPath, expected)
                if (inJunk) {
                    detected += 1
                    // Spam → Inbox: o resgate fica visível para o provedor. Arquivar só no
                    // próximo tick, para a mensagem "viver" um pouco na Inbox depois do resgate.
                    const lock = await client.getMailboxLock(junkPath)
                    try {
                        await client.messageMove(String(inJunk.uid), 'INBOX', { uid: true })
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

            await giveUpIfExpired(message, context, 'inbox or spam')
        }
    } finally {
        try { await client.logout() } catch { /* ignore */ }
    }
    return detected
}

/**
 * Localiza a cópia entregue de `expected` numa pasta: primeiro por Message-ID (com e sem
 * colchetes — alguns servidores indexam sem), depois por envelope, para o caso em que o relay
 * reescreveu o id. A busca por envelope pede FROM + SUBJECT + SINCE ao servidor (barato, e o
 * SUBJECT do IMAP é substring: "agenda" também traz "Re: agenda") e refina no cliente com
 * igualdade exata e janela de tempo — ver `pickDeliveredCopy`.
 */
async function locateInImapFolder(client: ImapFlow, path: string, expected: ExpectedDelivery): Promise<ImapHit | null> {
    const lock = await client.getMailboxLock(path)
    try {
        for (const form of [`<${expected.messageId}>`, expected.messageId]) {
            const found = await client.search({ header: { 'message-id': form } }, { uid: true })
            if (found && found.length > 0) {
                return { uid: found[found.length - 1], deliveredMessageId: expected.messageId }
            }
        }

        const since = new Date(expected.sentAt.getTime() - DETECTION_WINDOW_BEFORE_MS)
        since.setUTCHours(0, 0, 0, 0)
        const candidatesUids = await client.search(
            { from: expected.fromAddress, subject: expected.subject, since },
            { uid: true },
        )
        if (!candidatesUids || candidatesUids.length === 0) return null

        const candidates: Array<{ uid: number; fromAddress: string | null; subject: string | null; date: Date | null; messageId: string | null }> = []
        // Só as mais recentes: o par manda no máximo uma por dia, então poucas bastam.
        for (const uid of candidatesUids.slice(-10)) {
            const fetched = await client.fetchOne(String(uid), { envelope: true }, { uid: true })
            if (!fetched || !fetched.envelope) continue
            const envelope = fetched.envelope
            candidates.push({
                uid,
                fromAddress: envelope.from?.[0]?.address ?? null,
                subject: envelope.subject ?? null,
                date: envelope.date ? new Date(envelope.date) : null,
                messageId: envelope.messageId ?? null,
            })
        }
        const hit = pickDeliveredCopy(candidates, expected)
        return hit ? { uid: hit.uid, deliveredMessageId: normalizeMessageId(hit.messageId) || null } : null
    } finally {
        lock.release()
    }
}

/** Devolve quantas mensagens de `pending` foram localizadas (e tratadas) na caixa nativa. */
async function groomNativeAccount(context: GroomContext, pending: WarmupMessage[]): Promise<number> {
    const { account } = context.recipientMesh
    // Caixa nativa: o dono é um usuário da plataforma; a correspondência vive em mail_messages.
    const owner = await db.query.users.findFirst({ where: eq(users.email, account.email), columns: { id: true } })
    if (!owner) return 0
    const mailbox = await db.query.mailboxes.findFirst({
        where: and(eq(mailboxes.userId, owner.id), eq(mailboxes.email, account.email)),
        columns: { id: true },
    })
    if (!mailbox) return 0
    const folders = await db.query.mailFolders.findMany({
        where: eq(mailFolders.mailboxId, mailbox.id),
        columns: { id: true, type: true },
    })
    const folderByType = new Map(folders.map((folder) => [folder.type, folder.id]))
    const inboxId = folderByType.get('inbox')
    const archiveId = folderByType.get('archive')
    if (!inboxId) return 0

    let detected = 0
    for (const message of pending) {
        const expected = expectedDeliveryOf(message, context)
        if (!expected) {
            await giveUpIfExpired(message, context, 'native mailbox')
            continue
        }

        let stored = await db.query.mailMessages.findFirst({
            where: and(
                eq(mailMessages.mailboxId, mailbox.id),
                inArray(mailMessages.messageId, [`<${message.messageId}>`, message.messageId]),
            ),
        })
        if (!stored) {
            // Mesmo fallback do IMAP: remetente + assunto + janela, para o caso de o id ter sido
            // reescrito no caminho (hoje só o relay das nativas faz isso, mas o custo é uma query).
            const candidates = await db.query.mailMessages.findMany({
                where: and(
                    eq(mailMessages.mailboxId, mailbox.id),
                    eq(mailMessages.fromAddress, expected.fromAddress),
                    gte(mailMessages.receivedAt, new Date(expected.sentAt.getTime() - DETECTION_WINDOW_BEFORE_MS)),
                ),
                limit: 20,
            })
            stored = pickDeliveredCopy(
                candidates.map((row) => ({ row, fromAddress: row.fromAddress, subject: row.subject, date: row.receivedAt, messageId: row.messageId })),
                expected,
            )?.row
        }
        if (!stored) {
            await giveUpIfExpired(message, context, 'native mailbox')
            continue
        }

        detected += 1
        // O MX nativo não reclassifica para spam (greylist é pré-aceitação), então o caminho aqui
        // é o feliz: ler, talvez responder, arquivar.
        const replied = await maybeReply(message, context, normalizeMessageId(stored.messageId) || null)
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
    return detected
}

/**
 * Devolve `groomed` = mensagens LOCALIZADAS e tratadas neste tick (antes contava as pendentes
 * examinadas, o que fazia um groom cego parecer produtivo) e `undetected` = as que seguem sem
 * aparecer em nenhuma pasta.
 */
async function runGroomPhase(mesh: MeshAccount[], now: Date): Promise<{ groomed: number; undetected: number }> {
    const meshById = new Map(mesh.map((entry) => [entry.account.id, entry]))
    const awaiting = await db.query.warmupMessages.findMany({
        where: and(
            inArray(warmupMessages.status, ['sent', 'rescued']),
            lt(warmupMessages.sentAt, new Date(now.getTime() - DETECTION_DELAY_MS)),
        ),
        limit: 200,
    })
    if (awaiting.length === 0) return { groomed: 0, undetected: 0 }

    const byRecipient = new Map<string, WarmupMessage[]>()
    for (const message of awaiting) {
        const list = byRecipient.get(message.toAccountId) ?? []
        list.push(message)
        byRecipient.set(message.toAccountId, list)
    }

    let groomed = 0
    let undetected = 0
    for (const [toAccountId, pending] of byRecipient) {
        const recipientMesh = meshById.get(toAccountId)
        if (!recipientMesh) continue
        const context: GroomContext = { recipientMesh, senderByAccountId: meshById, now }
        try {
            let detected = 0
            if (recipientMesh.account.provider === 'native') {
                detected = await groomNativeAccount(context, pending)
            } else if (recipientMesh.account.provider === 'smtp') {
                detected = await groomImapAccount(context, pending)
            } else {
                // Outlook entra no mesh numa fase futura (arquivar exige Graph API, não IMAP).
                continue
            }
            groomed += detected
            undetected += pending.length - detected
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error))
            log.error({
                action: 'outreach.warmup.groom_failed',
                toAccountId,
                error: { message: err.message },
            }, 'warm-up groom failed for account')
        }
    }
    return { groomed, undetected }
}

// ============================================================
// Entry point
// ============================================================

export async function processWarmupMesh(now = new Date()): Promise<{ sent: number; groomed: number; undetected: number }> {
    const mesh = await loadMeshAccounts()
    if (mesh.length < 2) return { sent: 0, groomed: 0, undetected: 0 }
    const sent = await runSendPhase(mesh, now)
    const { groomed, undetected } = await runGroomPhase(mesh, now)
    if (sent > 0 || groomed > 0 || undetected > 0) {
        log.info({ action: 'outreach.warmup.tick', meshSize: mesh.length, sent, groomed, undetected }, 'warm-up tick')
    }
    return { sent, groomed, undetected }
}

export async function runWarmupMeshWithLock(): Promise<void> {
    // jobs/index.ts schedules this every 10 minutes. 2026-09-04 (Fase 1 TASK 2): retuned from the
    // earlier 8-minute guess to 375s — 5x the 75s normal latency measured in production over a
    // 35-minute/130-run window (see JOB_TIMEOUT_BUDGETS_MS in cron-lock.ts for the rule and the
    // full table) — leaving a 225s margin before the next scheduled tick.
    await runWithLock(WARMUP_LOCK_NAME, async () => {
        await processWarmupMesh()
    }, { timeoutMs: JOB_TIMEOUT_BUDGETS_MS.warmupMeshProcessor })
}
