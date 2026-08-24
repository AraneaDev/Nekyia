import type { Row } from './core/query'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const WEEK = 7 * DAY
const YEAR = 365 * DAY

export function relTime(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return 'now'
  const delta = Math.max(0, now - ms)
  if (delta < MIN) return 'now'
  if (delta < HOUR) return `${Math.floor(delta / MIN)}m`
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d`
  if (delta < YEAR) return `${Math.floor(delta / WEEK)}w`
  return `${Math.floor(delta / YEAR)}y`
}

export function projectName(cwd: string | null): string {
  if (!cwd) return '-'
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? '/'
}

export function tierGlyph(tier: string): string {
  return tier === 'resume' ? '*' : 'o'
}

export function formatRow(row: Row, now: number = Date.now()): string {
  const suffix = row.collapsed ? `  +${row.collapsed}` : ''
  return [
    tierGlyph(row.tier),
    row.client.padEnd(9),
    relTime(row.endedAt, now).padStart(4),
    projectName(row.cwd).padEnd(16).slice(0, 16),
    (row.title ?? '(no title)') + suffix,
  ].join('  ')
}
