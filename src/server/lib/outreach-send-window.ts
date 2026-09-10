/**
 * The single implementation of "is this instant inside the org/campaign's allowed send
 * window" — timezone + business-hours + weekend rules.
 *
 * Before this module existed, `outreach-sequence-state.ts` and `outreach-delivery-policy.ts`
 * each carried their own copy of `getZonedDateParts`/`isWithinSchedule`/the search-forward loop,
 * with two different search horizons (14 days vs 8 days) and — worse — two different fallbacks
 * when no valid minute could be found: the sequence-state copy (`scheduleAfterDelay`) silently
 * returned the out-of-window candidate anyway (a send-window violation nobody would notice),
 * while the delivery-policy copy (`nextCampaignWindow`) deferred a flat 7 days out. Two
 * implementations of the same rule drifting apart is exactly how the violable one went
 * unnoticed. This module is now the only place the rule is written down; both call sites import
 * it and decide their own fallback behaviour on top of a shared `null` ("no slot exists in the
 * search horizon") rather than inventing their own silent success case.
 */

export interface SendWindow {
    timezone: string
    sendStartTime: string // "HH:mm"
    sendEndTime: string // "HH:mm"
    sendOnWeekends: boolean
}

interface ZonedDateParts {
    weekday: number
    hour: number
    minute: number
}

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS

// Real-world DST shifts are at most a couple of hours (most are exactly one). This is the
// radius, in minutes, that `findWindowStartNear` scans around a day's naively-computed target
// instant to correct for the local clock having jumped — comfortably wider than any shift we
// expect to see, while staying a small bounded scan rather than the whole day.
const DST_CORRECTION_WINDOW_MINUTES = 180

const WEEKDAY_BY_SHORT_NAME: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
}

/** Read weekday/hour/minute for `date` as they appear on a wall clock in `timeZone`. */
export function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
    let parts: Intl.DateTimeFormatPart[]
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timeZone || 'UTC',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(date)
    } catch {
        // An unknown/invalid IANA zone must not crash a scheduling decision — fall back to UTC
        // rather than throwing partway through a job tick.
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'UTC',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(date)
    }

    const value = (type: string) => parts.find((part) => part.type === type)?.value

    return {
        weekday: WEEKDAY_BY_SHORT_NAME[value('weekday') || 'Sun'] ?? 0,
        hour: Number(value('hour') || 0),
        minute: Number(value('minute') || 0),
    }
}

function parseTimeToMinutes(value: string): number {
    const [hours, minutes] = value.split(':').map(Number)
    return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0)
}

/** True when `date` falls on a day and time-of-day the window allows sending. */
export function isWithinWindow(date: Date, window: SendWindow): boolean {
    const zoned = getZonedDateParts(date, window.timezone)
    const isWeekend = zoned.weekday === 0 || zoned.weekday === 6
    if (isWeekend && !window.sendOnWeekends) return false

    const currentMinutes = zoned.hour * 60 + zoned.minute
    return currentMinutes >= parseTimeToMinutes(window.sendStartTime)
        && currentMinutes <= parseTimeToMinutes(window.sendEndTime)
}

/**
 * Scan forward, minute by minute, in a small window around `approx` for the first instant
 * (not before `notBefore`) that satisfies the window. Bounded to
 * `2 * DST_CORRECTION_WINDOW_MINUTES` checks — this exists only to correct the naive "same
 * wall-clock time, N days later" arithmetic in `nextWindowStart` for a DST shift landing between
 * `notBefore` and the target day; it is never asked to search a whole day, let alone the whole
 * horizon.
 */
function findWindowStartNear(approx: Date, window: SendWindow, notBefore: Date): Date | null {
    const searchStartMs = Math.max(notBefore.getTime(), approx.getTime() - DST_CORRECTION_WINDOW_MINUTES * MINUTE_MS)
    const searchEndMs = approx.getTime() + DST_CORRECTION_WINDOW_MINUTES * MINUTE_MS
    for (let t = searchStartMs; t <= searchEndMs; t += MINUTE_MS) {
        const candidate = new Date(t)
        if (isWithinWindow(candidate, window)) return candidate
    }
    return null
}

/**
 * The first instant at or after `from` that satisfies `window`, or `null` when none exists
 * within `horizonDays` (default 14) — including the degenerate case of an impossible window
 * (`sendStartTime >= sendEndTime`, which is never satisfiable by any minute of any day).
 *
 * Deliberately does NOT walk minute-by-minute across the whole horizon: closed days are
 * skipped a day at a time (weekend, or `from`'s day already past its end time), and only the
 * day that actually opens gets a bounded local scan (see `findWindowStartNear`) to land on the
 * exact minute despite any DST shift between `from` and that day.
 */
export function nextWindowStart(
    from: Date,
    window: SendWindow,
    options: { horizonDays?: number } = {},
): Date | null {
    const startMinutes = parseTimeToMinutes(window.sendStartTime)
    const endMinutes = parseTimeToMinutes(window.sendEndTime)
    if (!(startMinutes < endMinutes)) return null // impossible window: no minute of any day qualifies

    const horizonDays = Math.max(1, options.horizonDays ?? 14)

    const fromRounded = new Date(from.getTime())
    fromRounded.setSeconds(0, 0)

    if (isWithinWindow(fromRounded, window)) return fromRounded

    for (let dayOffset = 0; dayOffset <= horizonDays; dayOffset++) {
        // A rough anchor for "this calendar day" — same wall-clock reading as `from` shifted by
        // whole days of real time. DST can leave its local time a little off; that is corrected
        // below, not here.
        const dayAnchor = new Date(fromRounded.getTime() + dayOffset * DAY_MS)
        const zoned = getZonedDateParts(dayAnchor, window.timezone)
        const isWeekend = zoned.weekday === 0 || zoned.weekday === 6
        if (isWeekend && !window.sendOnWeekends) continue

        const currentMinutes = zoned.hour * 60 + zoned.minute
        // Only relevant for `from`'s own day: if its window already closed today, there is
        // nothing left to find today — move on to the next day instead of aiming for a target
        // time that has already passed.
        if (dayOffset === 0 && currentMinutes > endMinutes) continue

        const targetMinutes = startMinutes
        const approxCandidate = new Date(dayAnchor.getTime() + (targetMinutes - currentMinutes) * MINUTE_MS)

        const found = findWindowStartNear(approxCandidate, window, fromRounded)
        if (found) return found
    }

    return null
}
