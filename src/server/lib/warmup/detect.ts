/**
 * Warm-up detection — pure functions, no I/O.
 *
 * O groom precisa achar, na caixa do DESTINATÁRIO, a cópia entregue de cada mensagem do mesh.
 * A chave natural é o Message-ID que nós mesmos geramos (`w.<uuid>@<domínio>`), e ela funciona
 * quando o provedor de saída preserva o header. Mas nem todo caminho preserva: o relay Brevo
 * usado pelas caixas nativas **reescreve** o Message-ID para `<uuid@smtp-relay.sendinblue.com>`,
 * e a busca por header passa a devolver vazio para sempre — foi assim que 100% do tráfego
 * native→Gmail ficou preso em `sent` (e o que caiu em Spam ficou lá, sem resgate).
 *
 * Por isso a detecção tem duas chaves, nesta ordem:
 *   1. Message-ID exato (barato, inequívoco).
 *   2. Envelope: mesmo remetente + mesmo assunto + Date dentro de uma janela em torno do envio.
 *      É segura porque o SEND nunca manda duas mensagens do mesmo par no mesmo dia (o seletor
 *      exclui endereços já usados hoje) e a janela cobre só o dia do envio; e o assunto é comparado
 *      por igualdade exata depois de normalizar, então uma resposta "Re: agenda" não casa com
 *      "agenda".
 */

export interface DeliveredCandidate {
    /** Endereço do remetente conforme visto pelo destinatário. */
    fromAddress: string | null | undefined
    subject: string | null | undefined
    /** Header Date da mensagem (ou received_at, quando é o que existe). */
    date: Date | null | undefined
    /** Message-ID como chegou (com ou sem colchetes). */
    messageId?: string | null
}

export interface ExpectedDelivery {
    fromAddress: string
    subject: string
    /** Quando o mesh registrou o envio. */
    sentAt: Date
    /** Message-ID que nós geramos, sem colchetes. */
    messageId: string
}

/** O Date do destinatário pode ser um pouco anterior ao nosso `sentAt` (relógio do compositor). */
export const DETECTION_WINDOW_BEFORE_MS = 30 * 60 * 1000
/** E bem posterior, para greylisting/retentativas do relay. */
export const DETECTION_WINDOW_AFTER_MS = 24 * 60 * 60 * 1000

export function normalizeMessageId(value: string | null | undefined): string {
    return (value ?? '').trim().replace(/^<|>$/g, '').toLowerCase()
}

export function normalizeSubject(value: string | null | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function normalizeAddress(value: string | null | undefined): string {
    const raw = (value ?? '').trim()
    // "Nome <a@b>" → a@b
    const angled = raw.match(/<([^>]+)>/)
    return (angled ? angled[1] : raw).trim().toLowerCase()
}

/** Chave 1: o Message-ID que geramos sobreviveu ao caminho de entrega. */
export function matchesByMessageId(candidate: DeliveredCandidate, expected: ExpectedDelivery): boolean {
    const got = normalizeMessageId(candidate.messageId)
    return got.length > 0 && got === normalizeMessageId(expected.messageId)
}

/** Chave 2: envelope (remetente + assunto + janela de tempo). */
export function matchesByEnvelope(candidate: DeliveredCandidate, expected: ExpectedDelivery): boolean {
    if (normalizeAddress(candidate.fromAddress) !== normalizeAddress(expected.fromAddress)) return false
    if (normalizeSubject(candidate.subject) !== normalizeSubject(expected.subject)) return false
    const when = candidate.date instanceof Date && !Number.isNaN(candidate.date.getTime()) ? candidate.date : null
    if (!when) return false
    const delta = when.getTime() - expected.sentAt.getTime()
    return delta >= -DETECTION_WINDOW_BEFORE_MS && delta <= DETECTION_WINDOW_AFTER_MS
}

/**
 * Escolhe, entre candidatos, a cópia entregue de `expected`. Message-ID exato ganha sempre; sem
 * ele, o candidato de envelope com Date mais próximo do envio. Devolve null se nada casa.
 */
export function pickDeliveredCopy<T extends DeliveredCandidate>(candidates: T[], expected: ExpectedDelivery): T | null {
    const byId = candidates.find((candidate) => matchesByMessageId(candidate, expected))
    if (byId) return byId
    let best: T | null = null
    let bestDelta = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
        if (!matchesByEnvelope(candidate, expected)) continue
        const delta = Math.abs((candidate.date as Date).getTime() - expected.sentAt.getTime())
        if (delta < bestDelta) {
            best = candidate
            bestDelta = delta
        }
    }
    return best
}
