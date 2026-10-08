import React from 'react'
import { Box, Text } from 'ink'
import type { Row } from '../core/query'
import { projectName, relTime } from '../render'
import { boundedDisplayText, ellipsizedDisplayText, padColumns, scanLimit, suffixByCodeUnits, wrappedDisplayLines } from './text'

const CLIENT_COLOR: Record<string, string> = {
  claude: 'magenta',
  codex: 'cyan',
  opencode: 'green',
  kilo: 'yellow',
  codebuff: 'blue',
  agy: 'red',
  freebuff: 'blueBright',
  cursor: 'whiteBright',
}

/** The fixed hue for a known client, so the same client reads the same everywhere. */
export function clientColor(client: string): string {
  return CLIENT_COLOR[client] ?? 'white'
}

/**
 * Projects have no fixed set, so their hue is derived from the name. The same
 * project keeps the same colour across runs and machines, which is what makes
 * it scannable; the client hues are excluded so the two columns stay apart.
 */
const PROJECT_COLOR = ['cyan', 'green', 'yellow', 'blue', 'magenta', 'red'] as const

/** A stable hue derived from the project name, so the column is scannable without a fixed palette. */
export function projectColor(project: string): string | undefined {
  if (!project || project === '-') return undefined
  let hash = 0
  for (const char of project) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return PROJECT_COLOR[hash % PROJECT_COLOR.length]
}

/** Recency is the ranking signal, so the age column reads as a gradient. */
export function ageEmphasis(endedAt: number, now: number): { dim: boolean; bold: boolean } {
  const age = now - endedAt
  if (!Number.isFinite(age)) return { dim: true, bold: false }
  if (age < 24 * 3_600_000) return { dim: false, bold: true }
  if (age < 7 * 24 * 3_600_000) return { dim: false, bold: false }
  return { dim: true, bold: false }
}

/** Regex metacharacters, escaped so a typed query is matched as literal text. */
const REGEX_META = /[.*+?^${}()|[\]\\]/gu

/**
 * Splits a title around the query so the matching span can be lit. Matching is
 * case-insensitive on the first occurrence only: the point is to show the list
 * reacting to what was typed, not to mark up every letter.
 *
 * The search runs against the original title rather than a lowercased copy,
 * because toLowerCase() does not preserve code-unit offsets: 'İ' is one unit
 * and lowercases to two, so every offset after it drifts and the slices can cut
 * a surrogate pair in half. A split pair lands in two Text nodes with different
 * colours and renders as two replacement glyphs, which is a corrupted frame
 * rather than a missed highlight. The `iu` flags fold case simply, so a few
 * exotic pairs stop matching; a correct title with no highlight is the better
 * of the two outcomes.
 */
export function matchSpans(title: string, queryText: string): [string, string, string] {
  const needle = queryText.trim()
  if (!needle) return [title, '', '']
  const hit = new RegExp(needle.replace(REGEX_META, '\\$&'), 'iu').exec(title)
  if (!hit) return [title, '', '']
  return [title.slice(0, hit.index), hit[0], title.slice(hit.index + hit[0].length)]
}

/**
 * Extracts and bounds a project's directory name for display in a narrow column.
 */
function boundedProjectName(cwd: string | null): string {
  if (!cwd) return '-'
  const columns = 14
  const { sample, truncated } = suffixByCodeUnits(cwd, scanLimit(columns))
  const hasBoundary = /[\\/]/u.test(sample)
  const name = projectName(sample)
  if (truncated && !hasBoundary) {
    return `…${boundedDisplayText(name, columns - 1)}`
  }
  return boundedDisplayText(name, columns)
}

/**
 * Normalizes a number to an integer >= 0.
 */
function naturalNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/**
 * Ensures the selected index remains within the bounds of the provided total.
 */
function boundedSelection(selected: number, total: number): number {
  if (total === 0) return 0
  const normalized = Number.isFinite(selected) ? Math.floor(selected) : 0
  return Math.min(total - 1, Math.max(0, normalized))
}

/** Returns [start, end) so only the visible rows are ever rendered. */
export function visibleWindow(selected: number, total: number, height: number): [number, number] {
  const rowCount = naturalNumber(total)
  const windowHeight = naturalNumber(height)
  if (rowCount === 0 || windowHeight === 0) return [0, 0]
  if (rowCount <= windowHeight) return [0, rowCount]

  const active = boundedSelection(selected, rowCount)
  const start = Math.min(Math.max(0, active - windowHeight + 1), rowCount - windowHeight)
  return [start, start + windowHeight]
}

/** One rendered session row, given the width it must fill and the query to light inside it. */
export interface ListRowProps {
  bookmarked?: boolean
  row: Row
  index: number
  active: boolean
  now: number
  /** Columns available to this row, so the title fills the pane it is drawn in. */
  columns: number
  /** Current search text, so the matching span can be lit inside the title. */
  query: string
  /** Whether this row falls inside the part of the list currently on screen. */
  onThumb: boolean
  /** Selected rows may use one continuation line; other rows remain compact. */
  titleLines?: number
}

/** rail gutter, client, age and project columns, with the spaces between them. */
export const ROW_FIXED_COLUMNS = 32

/**
 * The selected row is marked in the gutter rather than inverted. Inverting the
 * whole row put the client colour on its own background and made it unreadable,
 * and it drew a heavy band across the one row meant to feel picked out.
 */
const RAIL = '▌'
/** The track the rail runs in, marking how far the list reaches past the screen. */
const TRACK = '│'

/**
 * Which rendered rows the visible slice occupies within the whole list, so the
 * gutter can show position the way a scrollbar does. Returns [from, to) over
 * the rows actually drawn. A list that fits gets the full height, which reads
 * as nothing to scroll rather than as a thumb that happens to fill the track.
 */
export function railThumb(start: number, visible: number, total: number): [number, number] {
  const height = naturalNumber(visible)
  const count = naturalNumber(total)
  if (height === 0) return [0, 0]
  if (count <= height) return [0, height]
  // A single row is arithmetically right on a very long list but reads as a
  // stray mark, so the thumb keeps enough body to be seen as a segment.
  const size = Math.max(Math.min(2, height), Math.min(height, Math.floor((height * height) / count)))
  const furthest = count - height
  const at = Math.min(Math.max(0, naturalNumber(start)), furthest)
  const from = Math.round((at / furthest) * (height - size))
  return [from, from + size]
}

/** Columns the title may use once the fixed columns are paid for. */
export function titleColumns(columns: number): number {
  return Math.max(8, naturalNumber(columns) - ROW_FIXED_COLUMNS)
}

/** Bounds selected-title wrapping before scanning untrusted transcript text. */
function rowTitleLines(row: Row, columns: number, maximum: number, bookmarked?: boolean): string[] {
  const suffix = `${bookmarked ? ' ★' : ''}${row.collapsed ? `  +${row.collapsed}` : ''}`
  const width = Math.max(1, titleColumns(columns) - Bun.stringWidth(suffix))
  if (maximum <= 1) return [ellipsizedDisplayText(row.title ?? '(no title)', width)]
  // Read a little past two rows, so a break that falls back to an earlier space
  // still has the words to fill the second row.
  const lines = wrappedDisplayLines(boundedDisplayText(row.title ?? '(no title)', width * 3), width)
  const shown = lines.slice(0, 2)
  if (lines.length > 2) shown[1] = ellipsizedDisplayText(`${shown[1]!} ${lines[2]!}`, width)
  return shown.length ? shown : ['']
}

/** Reserves the selected continuation row before computing the virtual window. */
export function listWindow(rows: readonly Row[], selected: number, height: number, columns: number,
  wrapSelected: boolean, bookmarks?: ReadonlySet<string>): [number, number] {
  const row = rows[boundedSelection(selected, rows.length)]
  const extra = wrapSelected && height > 1 && row ? rowTitleLines(row, columns, 2, bookmarks?.has(row.uid)).length - 1 : 0
  return visibleWindow(selected, rows.length, Math.max(0, height - extra))
}

/**
 * The standard renderer for a single session row in the picker list, displaying client, project, title, and age.
 */
function DefaultListRow({ row, active, now, columns, query, onThumb, bookmarked, titleLines = 1 }: ListRowProps) {
  const client = boundedDisplayText(row.clientLabel ?? row.client, 9) || '?'
  const project = boundedProjectName(row.cwd)
  const titles = rowTitleLines(row, columns, active ? titleLines : 1, bookmarked)
  const title = titles[0] ?? ''
  const hue = clientColor(client)
  // A client that cannot resume is dimmed rather than given its own glyph: the
  // question the mark answered was how live the session is, and dimming says
  // that without another symbol to learn.
  const live = row.tier === 'resume'
  const age = ageEmphasis(row.endedAt, now)
  const [before, hit, after] = matchSpans(title, query)
  return (
    <Box flexDirection="column">
    <Text wrap="truncate-end">
      <Text color={active ? hue : undefined} dimColor={!active && !onThumb}>
        {active ? RAIL : TRACK}
      </Text>{' '}
      <Text color={hue} dimColor={!live}>{padColumns(client, 9)}</Text>{' '}
      <Text dimColor={age.dim} bold={age.bold}>{relTime(row.endedAt, now).padStart(4)}</Text>{' '}
      <Text color={projectColor(project.trim())} dimColor={!projectColor(project.trim())}>
        {padColumns(project, 14)}
      </Text>{' '}
      <Text bold={active}>{before}</Text>
      {hit ? <Text color="black" backgroundColor="yellow">{hit}</Text> : null}
      <Text bold={active}>{after}</Text>
      {bookmarked ? <Text> ★</Text> : null}
      {row.collapsed ? <Text dimColor>{`  +${row.collapsed}`}</Text> : null}
    </Text>
    {titles.slice(1).map((line, index) => {
      const [before, hit, after] = matchSpans(line, query)
      return <Text key={index} wrap="truncate-end">
        <Text color={hue}>{RAIL}</Text>{' '.repeat(ROW_FIXED_COLUMNS - 1)}
        <Text bold>{before}</Text>{hit ? <Text color="black" backgroundColor="yellow">{hit}</Text> : null}<Text bold>{after}</Text>
      </Text>
    })}
    </Box>
  )
}

/**
 * Draws the visible window of sessions, virtualized so a large index costs no
 * more to render than a small one.
 *
 * Memoized because scrolling the history moves an offset the list knows nothing
 * about: every prop here is a primitive or a memoized identity, so a detail step
 * that leaves them alone should not rebuild a screen of rows.
 */
export const List = React.memo(function List({
  rows, selected, height, now, columns = 92, query = '',
  rowComponent: RowComponent = DefaultListRow, bookmarks, wrapSelected = false,
}: {
  bookmarks?: ReadonlySet<string>
  wrapSelected?: boolean
  rows: Row[]
  selected: number
  height: number
  now: number
  /** Current search text, passed to rows so a match can be lit. */
  query?: string
  /** Width of the pane holding the list; the title claims whatever the fixed columns leave. */
  columns?: number
  /** Injectable row component for structural virtualization tests. */
  rowComponent?: React.ComponentType<ListRowProps>
}) {
  const total = rows.length
  const active = boundedSelection(selected, total)
  const [start, end] = listWindow(rows, active, height, columns, wrapSelected, bookmarks)
  const [thumbFrom, thumbTo] = railThumb(start, end - start, total)

  return (
    <Box flexDirection="column" width="100%">
      {rows.slice(start, end).map((row, offset) => {
        const index = start + offset
        return (
          <RowComponent
            key={row.uid} bookmarked={bookmarks?.has(row.uid)} row={row} index={index}
            active={index === active} now={now} columns={columns} query={query}
            onThumb={offset >= thumbFrom && offset < thumbTo}
            titleLines={wrapSelected && height > 1 ? 2 : 1}
          />
        )
      })}
    </Box>
  )
})
