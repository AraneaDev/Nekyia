import type { Row } from './core/query'
import type { TrackedFiles } from './core/git'
import type { TimelineSession } from './core/timeline'
import { boundedDisplayText, padColumns } from './tui/text'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const WEEK = 7 * DAY
const YEAR = 365 * DAY

/** Formats an age as a short, column-friendly span. Anything undateable reads as `now` rather than a misleading number. */
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

/** Reduces a working directory to the project name a person would recognise it by. */
export function projectName(cwd: string | null): string {
  if (!cwd) return '-'
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? '/'
}

/** Marks whether a row resumes the exact session or starts a fresh briefed one. */
export function tierGlyph(tier: string): string {
  return tier === 'resume' ? '*' : 'o'
}

/** Width of the project column, in terminal columns rather than code units. */
const PROJECT_COLUMNS = 16
/**
 * Width the title may claim. The columns before it cost 38, so 120 keeps a full
 * row inside a wide terminal while leaving room for a title worth reading, and
 * it bounds a transcript that opens with a whole pasted file.
 */
const TITLE_COLUMNS = 120

/**
 * Renders one search result as a fixed-width terminal line.
 *
 * Titles and project names come from indexed transcripts, so they reach the
 * terminal only through `boundedDisplayText`: an escape sequence or a bidi
 * override in a pasted prompt would otherwise clear the screen or reverse the
 * line. Bounding by display width rather than code units is also what keeps
 * the project column aligned when the name is CJK or carries an emoji.
 */
export function formatRow(row: Row, now: number = Date.now()): string {
  const suffix = row.collapsed ? `  +${row.collapsed}` : ''
  const project = boundedDisplayText(projectName(row.cwd), PROJECT_COLUMNS)
  const title = boundedDisplayText(row.title ?? '(no title)', TITLE_COLUMNS)
  return [
    tierGlyph(row.tier),
    row.client.padEnd(9),
    relTime(row.endedAt, now).padStart(4),
    padColumns(project, PROJECT_COLUMNS),
    title + suffix,
  ].join('  ')
}

/** Blocks the harness writes into the transcript as if the user had typed them. */
const HARNESS_BLOCKS = [
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gu,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gu,
  /<system-reminder>[\s\S]*?<\/system-reminder>/gu,
  /<command-message>[\s\S]*?<\/command-message>/gu,
]
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/u
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/u
/** A skill's body is injected whole; it is instructions, not a request. */
const INJECTED_SKILL = /^Base directory for this skill:/u

/**
 * Reduces one transcript message to what the user actually asked.
 *
 * Slash commands arrive wrapped in tags and keep their intent in the arguments,
 * so they come back as the command and what was passed to it. Caveats, command
 * output and injected skill bodies are written by the harness rather than typed,
 * so they come back empty and the caller skips them.
 */
export function userPromptText(text: string): string {
  if (typeof text !== 'string') return ''
  const name = COMMAND_NAME.exec(text)?.[1]?.trim()
  if (name) {
    const args = COMMAND_ARGS.exec(text)?.[1]?.trim()
    return args ? `${name} ${args}` : name
  }
  let rest = text
  for (const block of HARNESS_BLOCKS) rest = rest.replace(block, ' ')
  rest = rest.trim()
  return INJECTED_SKILL.test(rest) ? '' : rest
}

const KIND_COLUMNS = 8

/**
 * Renders a directory's history, grouped by the session that made it.
 *
 * The grouping carries the honesty: everything inside a group is in the order
 * it happened, and only the groups are placed by end time, which the index
 * knows coarsely. A flat stream would present one ordering that is accurate
 * only in parts.
 *
 * The header names a session count that predates file events only when one
 * exists, and absence of an `untracked` marker means tracked only when git was
 * actually consulted, which is why the git line is never omitted.
 */
export function formatTimeline(
  sessions: TimelineSession[],
  { dir, git, now = Date.now() }: { dir: string; git: TrackedFiles; now?: number },
): string[] {
  const base = `${dir.replace(/\/+$/u, '')}/`
  const entries = sessions.reduce((total, session) => total + session.entries.length, 0)
  const stale = sessions.filter((session) => session.detail === 'unknown').length
  const tracked = sessions
    .flatMap((session) => session.entries)
    .filter((entry) => git.tracked.has(entry.resolved)).length

  const lines: string[] = [
    `${dir} · ${sessions.length} sessions · ${entries} events · `
    + (git.consulted ? `git: ${tracked} of ${entries} tracked` : 'git was not consulted'),
    'exact order inside a session, end-time order between them',
  ]
  if (stale > 0) {
    lines.push(`${stale} sessions indexed before file events; run "nekyia index"`)
  }

  for (const session of sessions) {
    lines.push('')
    lines.push(formatRow({ ...session.ref, score: 0, collapsed: 0 }, now))
    if (session.detail === 'paths') {
      lines.push('     this client records file names only; no operations, no order')
    }
    if (session.detail === 'unknown') {
      lines.push('     indexed before file events; re-index to fill this in')
    }
    if (session.eventsTruncated) {
      lines.push('     event log capped for this session')
    }
    for (const entry of session.entries) {
      const position = entry.turn === null ? '' : String(entry.turn)
      const kind = entry.kind === 'unknown' ? '?' : entry.kind
      const path = entry.resolved.startsWith(base)
        ? entry.resolved.slice(base.length)
        : entry.resolved
      const marker = git.consulted && !git.tracked.has(entry.resolved) ? '  untracked' : ''
      lines.push(`  ${position.padStart(5)}  ${kind.padEnd(KIND_COLUMNS)}${path}${marker}`)
    }
  }
  return lines
}
