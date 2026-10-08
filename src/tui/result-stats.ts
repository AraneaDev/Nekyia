import type { Row } from '../core/query'

/** One local calendar day, including an empty bucket, in the activity chart. */
export interface ActivityDay { start: number; label: string; count: number }
/** Client counts describe displayed collapsed results, not their hidden ancestors. */
export interface ClientCount { id: string; label: string; count: number }
/** Metadata-only aggregates over the policy-filtered displayed result window. */
export interface ResultStats { total: number; projects: number; days: ActivityDay[]; clients: ClientCount[] }

/**
 * Builds seven local-day buckets and client counts from displayed results only.
 * No transcript/database reads or policy widening occur here. Calendar starts
 * use Date construction so daylight-saving days are not assumed to be 24 hours.
 */
export function resultStats(rows: readonly Row[], now: number): ResultStats {
  const today = new Date(now)
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6 + index)
    return { start: date.getTime(), label: ['S', 'M', 'T', 'W', 'T', 'F', 'S'][date.getDay()]!, count: 0 }
  })
  const clients = new Map<string, ClientCount>()
  const projects = new Set<string>()
  for (const row of rows) {
    if (row.cwd) projects.add(row.cwd)
    const client = clients.get(row.client)
    if (client) client.count++
    else clients.set(row.client, { id: row.client, label: row.clientLabel ?? row.client, count: 1 })
    if (!Number.isFinite(row.endedAt) || row.endedAt > now || row.endedAt < days[0]!.start) continue
    const index = days.findLastIndex(day => row.endedAt >= day.start)
    if (index >= 0) days[index]!.count++
  }
  return { total: rows.length, projects: projects.size, days,
    clients: [...clients.values()].sort((left, right) => right.count - left.count || left.id.localeCompare(right.id)) }
}

/** Zero activity is a dot; positive values scale relative to this seven-day window. */
export function activitySparkline(days: readonly ActivityDay[]): string {
  const peak = Math.max(0, ...days.map(day => day.count))
  const levels = '▁▂▃▄▅▆▇█'
  return days.map(day => day.count <= 0 ? '·' : levels[Math.max(0, Math.ceil(day.count / peak * 8) - 1)]!).join(' ')
}
