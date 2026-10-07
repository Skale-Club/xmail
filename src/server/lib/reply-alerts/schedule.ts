/**
 * Relógio dos alertas de resposta: janela de lembretes e intervalo, em America/New_York.
 *
 * Tudo aqui é puro (recebe `Date`, devolve `Date`/boolean) e usa só Intl, então o horário de
 * verão é decidido pela base de fusos do Node e não por uma conta de offset fixo. O Vanildo
 * trabalha no horário de Nova York; um offset de -5h fixo erraria uma hora durante metade do ano.
 */

export const REPLY_ALERT_TIMEZONE = 'America/New_York'

/** Primeira hora local em que lembretes e resumo podem sair (inclusive). */
export const WINDOW_START_HOUR = 8
/** Primeira hora local em que o silêncio começa (exclusive: às 20:00 em ponto já é silêncio). */
export const WINDOW_END_HOUR = 20

/** Intervalo entre lembretes de uma mesma conversa pendente. */
export const REMINDER_INTERVAL_MS = 2 * 60 * 60 * 1000

export interface LocalParts {
    year: number
    month: number // 1-12
    day: number
    hour: number // 0-23
    minute: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
    let formatter = formatters.get(timeZone)
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        })
        formatters.set(timeZone, formatter)
    }
    return formatter
}

/** Relógio de parede de `instant` no fuso dado. */
export function localParts(instant: Date, timeZone: string = REPLY_ALERT_TIMEZONE): LocalParts {
    const parts = formatterFor(timeZone).formatToParts(instant)
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        // hourCycle h23 já evita o "24" de meia-noite; o % é cinto e suspensório.
        hour: get('hour') % 24,
        minute: get('minute'),
    }
}

/** Diferença (ms) entre o relógio de parede do fuso e UTC naquele instante. */
function offsetMs(instant: Date, timeZone: string): number {
    const p = localParts(instant, timeZone)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    // Trunca os segundos do instante para comparar minuto com minuto.
    const truncated = Math.floor(instant.getTime() / 60_000) * 60_000
    return asUtc - truncated
}

/**
 * O instante UTC em que o relógio de parede do fuso marca exatamente a data/hora pedida.
 * Só é chamado com 08:00, que nunca cai no buraco de 02:00-03:00 do horário de verão.
 */
export function zonedWallTimeToUtc(
    wall: { year: number; month: number; day: number; hour: number; minute?: number },
    timeZone: string = REPLY_ALERT_TIMEZONE,
): Date {
    const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute ?? 0)
    // Duas passadas: a primeira usa o offset do chute; se o offset mudou entre o chute e o
    // resultado (dia de troca de horário), a segunda corrige.
    let result = naive - offsetMs(new Date(naive), timeZone)
    result = naive - offsetMs(new Date(result), timeZone)
    return new Date(result)
}

/** Fora de 08:00-20:00 no horário de Nova York: nada de lembrete nem de resumo. */
export function isQuietHours(instant: Date, timeZone: string = REPLY_ALERT_TIMEZONE): boolean {
    const { hour } = localParts(instant, timeZone)
    return hour < WINDOW_START_HOUR || hour >= WINDOW_END_HOUR
}

/** 08:00 do dia local de `instant`, como instante UTC. */
export function morningAnchor(instant: Date, timeZone: string = REPLY_ALERT_TIMEZONE): Date {
    const p = localParts(instant, timeZone)
    return zonedWallTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: WINDOW_START_HOUR }, timeZone)
}

/** Primeiro 08:00 local que não é anterior a `instant`. */
export function nextWindowOpening(instant: Date, timeZone: string = REPLY_ALERT_TIMEZONE): Date {
    const today = morningAnchor(instant, timeZone)
    if (today.getTime() >= instant.getTime()) return today
    const p = localParts(instant, timeZone)
    // Date.UTC normaliza o estouro de dia/mês, então "dia + 1" funciona no fim do mês.
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1))
    return zonedWallTimeToUtc(
        { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: WINDOW_START_HOUR },
        timeZone,
    )
}

/**
 * Quando o próximo lembrete de uma conversa fica devido: 2h depois do último aviso, e se isso
 * cair na janela de silêncio, às 08:00 seguintes.
 */
export function nextReminderAt(lastAlertedAt: Date, timeZone: string = REPLY_ALERT_TIMEZONE): Date {
    const candidate = new Date(lastAlertedAt.getTime() + REMINDER_INTERVAL_MS)
    return isQuietHours(candidate, timeZone) ? nextWindowOpening(candidate, timeZone) : candidate
}

/** Há lembrete a enviar agora? Dentro da janela e já passado o `nextReminderAt`. */
export function isReminderDue(lastAlertedAt: Date, now: Date, timeZone: string = REPLY_ALERT_TIMEZONE): boolean {
    if (isQuietHours(now, timeZone)) return false
    return now.getTime() >= nextReminderAt(lastAlertedAt, timeZone).getTime()
}
