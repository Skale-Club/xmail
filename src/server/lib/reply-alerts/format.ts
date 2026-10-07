/**
 * Texto das mensagens de Telegram (em português, para o Vanildo).
 *
 * Tudo que vem de fora (nome do lead, endereços, corpo da resposta) passa por escapeHtml: o
 * Telegram roda em parse_mode HTML e um `<` solto numa resposta faria a API recusar a mensagem
 * inteira, justamente a que avisa de um cliente. O corpo da resposta e os endereços só viajam
 * na mensagem; nunca vão para o log.
 */
import { escapeHtml } from '../html-escape'
import type { PendingReply } from './plan'
import { waitingState } from './plan'

export const SNIPPET_MAX_CHARS = 300

/** Quantas linhas um resumo lista antes de dizer "e mais N" (a mensagem cabe em 4096 caracteres). */
export const SUMMARY_MAX_LINES = 15

const NAME_MAX_CHARS = 80

// ---------------------------------------------------------------------------------------------
// Nome da barbearia
// ---------------------------------------------------------------------------------------------

/**
 * `custom_fields.shortName` quando existir (o nome curto que a campanha já usa na saudação),
 * senão o nome da empresa, senão o domínio do e-mail, senão um texto neutro.
 */
export function leadDisplayName(lead: {
    customFields?: unknown
    companyName?: string | null
    email?: string | null
}): string {
    let custom = lead.customFields
    // jsonb que chegou duplamente codificado (já houve disso em produção) vem como string.
    if (typeof custom === 'string') {
        try { custom = JSON.parse(custom) } catch { custom = null }
    }
    if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
        const short = (custom as Record<string, unknown>).shortName
        if (typeof short === 'string' && short.trim()) return short.trim().slice(0, NAME_MAX_CHARS)
    }
    if (lead.companyName?.trim()) return lead.companyName.trim().slice(0, NAME_MAX_CHARS)
    const domain = lead.email?.split('@')[1]?.trim()
    if (domain) return domain.slice(0, NAME_MAX_CHARS)
    return 'um lead'
}

// ---------------------------------------------------------------------------------------------
// Trecho da resposta
// ---------------------------------------------------------------------------------------------

function decodeBasicEntities(value: string): string {
    return value
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&amp;/gi, '&')
}

function htmlToText(html: string): string {
    return decodeBasicEntities(
        html
            .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
            // Citação de Gmail/Apple Mail: tudo dentro do bloco é texto antigo.
            .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '\n')
            .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, '\n')
            .replace(/<[^>]+>/g, ' '),
    )
}

const ATTRIBUTION_RE = /^(on|em|el|le)\s.{0,300}?(wrote|escreveu|escribi[oó]|a [eé]crit)\s*:?\s*$/i
const ORIGINAL_MESSAGE_RE = /^[-_=\s]*(original message|mensagem original|mensaje original|forwarded message|mensagem encaminhada)[-_=\s]*$/i
const HEADER_BLOCK_START_RE = /^(from|de|von)\s*:\s*\S/i
const HEADER_BLOCK_FOLLOW_RE = /^(sent|date|data|enviad[oa]|subject|assunto|to|para)\s*:/i
const SIGNATURE_DEVICE_RE = /^(sent from my|enviado do meu|get outlook for)/i

/** Corta o texto no primeiro sinal de mensagem citada e devolve só o que a pessoa escreveu. */
function stripQuotedText(text: string): string {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    const kept: string[] = []

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()

        if (line.startsWith('>')) continue
        if (ORIGINAL_MESSAGE_RE.test(line)) break
        if (/^_{5,}$/.test(line) || /^-{5,}$/.test(line)) break
        if (SIGNATURE_DEVICE_RE.test(line)) break

        // A atribuição "On Tue, Oct 6 ... wrote:" quebra em duas linhas em vários clientes.
        const joined = `${line} ${lines[i + 1]?.trim() ?? ''}`.trim()
        if (ATTRIBUTION_RE.test(line) || ATTRIBUTION_RE.test(joined)) break

        if (HEADER_BLOCK_START_RE.test(line)) {
            const following = lines.slice(i + 1, i + 5).map((l) => l.trim())
            if (following.some((l) => HEADER_BLOCK_FOLLOW_RE.test(l))) break
        }

        kept.push(line)
    }

    return kept.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * Primeiros `max` caracteres do que a pessoa escreveu, sem citação. O normalizador do Unified
 * Inbox só gera um preview de 200 caracteres SEM remover citação, então isto é separado.
 * Devolve '' se não sobrou texto (resposta só com imagem, por exemplo).
 */
export function replySnippet(
    plainBody: string | null | undefined,
    htmlBody: string | null | undefined,
    max: number = SNIPPET_MAX_CHARS,
): string {
    const source = plainBody?.trim() ? plainBody : htmlBody?.trim() ? htmlToText(htmlBody) : ''
    if (!source) return ''
    const text = stripQuotedText(source)
    const chars = Array.from(text)
    if (chars.length <= max) return text
    return `${chars.slice(0, max).join('').trimEnd()}…`
}

// ---------------------------------------------------------------------------------------------
// Espera e link
// ---------------------------------------------------------------------------------------------

/** "45 min", "4h", "3 dias". Arredonda para baixo: "há 4h" nunca é mais do que a verdade. */
export function formatWaiting(ms: number): string {
    const minutes = Math.max(0, Math.floor(ms / 60_000))
    if (minutes < 1) return 'menos de 1 min'
    if (minutes < 60) return `${minutes} min`
    const hours = Math.floor(minutes / 60)
    if (hours < 48) return `${hours}h`
    return `${Math.floor(hours / 24)} dias`
}

/**
 * Abre a conversa direto no Unified Inbox. O parâmetro é `conversation` (parseInboxUrl em
 * src/lib/unified-inbox-url.ts); a organização vem do seletor da própria tela.
 */
export function conversationLink(baseUrl: string, conversationId: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/outreach/unified-inbox?conversation=${encodeURIComponent(conversationId)}`
}

function anchor(url: string, label: string): string {
    return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`
}

// ---------------------------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------------------------

export interface FormattedAlert {
    title: string
    body: string
}

function replyBlock(row: PendingReply, baseUrl: string): string {
    const snippet = replySnippet(row.plainBody, row.htmlBody)
    const lines = [
        `De: ${escapeHtml(row.fromAddress)}, para ${escapeHtml(row.inboxAddress)}`,
        '',
        snippet ? escapeHtml(snippet) : '(sem texto na resposta)',
        '',
        anchor(conversationLink(baseUrl, row.conversationId), 'Abrir a conversa no Unified Inbox'),
    ]
    return lines.join('\n')
}

export function formatFirstAlert(row: PendingReply, baseUrl: string): FormattedAlert {
    return {
        title: `<b>Resposta nova da ${escapeHtml(row.leadName)}</b>`,
        body: replyBlock(row, baseUrl),
    }
}

export function formatReminder(row: PendingReply, baseUrl: string, now: Date): FormattedAlert {
    const waited = formatWaiting(now.getTime() - row.repliedAt.getTime())
    const state = waitingState(row) === 'unread'
        ? `está sem leitura há ${waited}`
        : `foi lida, mas está sem resposta há ${waited}`
    return {
        title: `<b>Lembrete: a resposta da ${escapeHtml(row.leadName)} ${state}</b>`,
        body: replyBlock(row, baseUrl),
    }
}

/**
 * Uma mensagem com todas as pendentes. As linhas são limitadas em número e em tamanho total: o
 * sendTelegram corta em 4096 caracteres, e um corte no meio de uma tag <a> faria o Telegram
 * recusar a mensagem toda.
 */
export function formatSummary(
    rows: readonly PendingReply[],
    reason: 'morning' | 'digest',
    baseUrl: string,
    now: Date,
): FormattedAlert {
    const count = rows.length
    const noun = count === 1 ? 'resposta esperando' : 'respostas esperando'
    const title = reason === 'morning'
        ? `<b>Bom dia: ${count} ${noun} você</b>`
        : `<b>Lembrete: ${count} ${noun} você</b>`

    // Mais antigas primeiro: é a que está há mais tempo sem atenção.
    const sorted = [...rows].sort((a, b) => a.repliedAt.getTime() - b.repliedAt.getTime())
    const lines: string[] = []
    let used = 0
    for (const row of sorted) {
        if (lines.length >= SUMMARY_MAX_LINES) break
        const waited = formatWaiting(now.getTime() - row.repliedAt.getTime())
        const state = waitingState(row) === 'unread' ? 'sem leitura' : 'lida, sem resposta'
        const line = `• ${escapeHtml(row.leadName)} (${state}, há ${waited}) ${anchor(conversationLink(baseUrl, row.conversationId), 'abrir')}`
        if (used + line.length > 3300) break
        lines.push(line)
        used += line.length + 1
    }
    const hidden = count - lines.length
    if (hidden > 0) lines.push(`… e mais ${hidden}. Abra o Unified Inbox, fila "Needs reply".`)

    return { title, body: lines.join('\n') }
}
