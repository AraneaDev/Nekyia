/** Session activity window, with an inclusive lower and exclusive upper bound. */
export interface TimeRange {
  since?: number
  until?: number
}

/** Stable picker choices, interpreted against its captured invocation time. */
export type TimePreset = 'all' | 'today' | 'yesterday' | '7d' | '30d'

const DATE_LIMIT = 8_640_000_000_000_000
const DAY = 86_400_000
const SPANS: Record<string, number> = { m: 60_000, h: 3_600_000, d: DAY, w: 7 * DAY }

/** Bounds must survive both numeric arithmetic and JavaScript Date conversion exactly. */
function validBound(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= DATE_LIMIT
}

/** Checks bounds without throwing, so malformed internal requests can fail closed. */
function validRange(range: TimeRange): boolean {
  return (range.since === undefined || validBound(range.since))
    && (range.until === undefined || validBound(range.until))
    && (range.since === undefined || range.until === undefined || range.since < range.until)
}

/** Reject calendar rollover before handing a timezone-bearing string to Date.parse. */
function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]!
}

/** Preserve the existing parser diagnostic while identifying either offending flag. */
function invalidTimeBound(flag: '--since' | '--until'): Error {
  return new Error(`${flag} takes a span such as 30m, 12h, 2d, 3w, or a date such as 2026-08-01`)
}

/** Parse strict CLI spans, UTC calendar dates, or ISO times with an explicit timezone. */
export function parseTimeBound(value: string, now: number, flag: '--since' | '--until'): number {
  const span = /^(\d+)([mhdw])$/u.exec(value)
  if (span) {
    const amount = Number(span[1])
    const duration = amount * SPANS[span[2]!]!
    const result = now - duration
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(duration)
      || !validBound(now) || !validBound(result)) throw invalidTimeBound(flag)
    return result
  }

  const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):?(\d{2}))$/u.exec(value)
  const fields = date ?? iso
  if (!fields || !validDate(Number(fields[1]), Number(fields[2]), Number(fields[3]))) throw invalidTimeBound(flag)
  if (iso && (Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6] ?? 0) > 59
    || Number(iso[10] ?? 0) > 23 || Number(iso[11] ?? 0) > 59)) throw invalidTimeBound(flag)
  const result = Date.parse(date ? `${value}T00:00:00Z` : value)
  if (!validBound(result)) throw invalidTimeBound(flag)
  return result
}

/** Report bad CLI windows before the caller opens an index. */
export function validateTimeRange(range: TimeRange): void {
  for (const flag of ['since', 'until'] as const) {
    if (range[flag] !== undefined && !validBound(range[flag])) {
      throw new Error(`--${flag} must be a safe integer timestamp within the JavaScript Date range`)
    }
  }
  if (range.since !== undefined && range.until !== undefined && range.since >= range.until) {
    throw new Error('--since must precede --until')
  }
}

/** Match normalized session activity, treating a single known endpoint as a point. */
export function matchesTimeRange(startedAt: number, endedAt: number, range: TimeRange): boolean {
  if (!validRange(range)) return false
  if (range.since === undefined && range.until === undefined) return true
  const knownStart = Number.isFinite(startedAt) && startedAt > 0
  const knownEnd = Number.isFinite(endedAt) && endedAt > 0
  if (!knownStart && !knownEnd) return false
  const start = knownStart ? startedAt : endedAt
  const end = knownEnd ? endedAt : startedAt
  return (range.since === undefined || Math.max(start, end) >= range.since)
    && (range.until === undefined || Math.min(start, end) < range.until)
}

/** Calendar presets use local midnight; rolling presets use fixed 24-hour days. */
export function presetTimeRange(preset: TimePreset, now: number): TimeRange {
  if (preset === 'all') return {}
  if (preset === '7d' || preset === '30d') {
    return { since: now - (preset === '7d' ? 7 : 30) * DAY, until: now + 1 }
  }
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  if (preset === 'today') return { since: midnight.getTime(), until: now + 1 }
  const until = midnight.getTime()
  midnight.setDate(midnight.getDate() - 1)
  return { since: midnight.getTime(), until }
}
