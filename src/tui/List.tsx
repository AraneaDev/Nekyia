import React from 'react'
import { Box, Text } from 'ink'
import type { Row } from '../core/query'
import { projectName, relTime } from '../render'

const CLIENT_COLOR: Record<string, string> = {
  claude: 'magenta',
  codex: 'cyan',
  opencode: 'green',
  kilo: 'yellow',
  codebuff: 'blue',
  agy: 'red',
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

const DISPLAY_SCAN_FACTOR = 8
/** Ceiling on every width-derived allocation, so a nonsense terminal width cannot ask for an unbounded string. */
export const MAX_DISPLAY_COLUMNS = 512
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu
const BIDI_FORMAT = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/gu
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Records how much text bounding inspected, so the caps stay observable in tests. */
export interface DisplayWork {
  sampledCodeUnits: number
  graphemes: number
}

function displayColumns(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(MAX_DISPLAY_COLUMNS, Math.max(0, Math.floor(value)))
}

function scanLimit(columns: number): number {
  return columns * DISPLAY_SCAN_FACTOR + DISPLAY_SCAN_FACTOR
}

function prefixByCodeUnits(value: string, limit: number): { sample: string; truncated: boolean } {
  const truncated = value.length > limit
  let sample = value.slice(0, limit)
  const last = sample.charCodeAt(sample.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) sample = sample.slice(0, -1)
  return { sample, truncated }
}

function suffixByCodeUnits(value: string, limit: number): { sample: string; truncated: boolean } {
  const truncated = value.length > limit
  let sample = value.slice(-limit)
  const first = sample.charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) sample = sample.slice(1)
  return { sample, truncated }
}

function sanitizeDisplaySample(value: string): string {
  return value.replace(CONTROL, ' ').replace(BIDI_FORMAT, '')
}

/**
 * Returns a safe prefix no wider than `maxColumns`. The input slice is bounded
 * before regex, grapheme segmentation, or terminal-width measurement, keeping
 * display work proportional to the requested terminal width.
 */
export function boundedDisplayText(
  value: string,
  maxColumns: number,
  work?: DisplayWork,
): string {
  const columns = displayColumns(maxColumns)
  if (columns === 0) return ''

  const { sample, truncated } = prefixByCodeUnits(value, scanLimit(columns))
  if (work) work.sampledCodeUnits += sample.length
  const safe = sanitizeDisplaySample(sample)
  let result = ''
  let width = 0

  for (const part of GRAPHEMES.segment(safe)) {
    if (work) work.graphemes++
    const isPossiblySplitTail = truncated && part.index + part.segment.length === safe.length
    if (isPossiblySplitTail) break
    const partWidth = Bun.stringWidth(part.segment)
    if (width + partWidth > columns) break
    result += part.segment
    width += partWidth
    if (width === columns) break
  }
  return result
}

function padColumns(value: string, columns: number): string {
  return value + ' '.repeat(Math.max(0, columns - Bun.stringWidth(value)))
}

/**
 * Keeps the end of a path when it will not fit. Trimming the far end drops the
 * file name, which is the part worth reading; the directories above it are not.
 */
export function boundedPathTail(value: string, columns: number): string {
  const limit = displayColumns(columns)
  if (limit === 0) return ''
  if (Bun.stringWidth(value) <= limit) return value
  const { sample } = suffixByCodeUnits(value, scanLimit(limit))
  let kept = ''
  for (const part of [...GRAPHEMES.segment(sample)].reverse()) {
    const next = part.segment + kept
    if (Bun.stringWidth(next) > limit - 1) break
    kept = next
  }
  return `…${kept}`
}

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

function naturalNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

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

function DefaultListRow({ row, active, now, columns, query, onThumb }: ListRowProps) {
  const client = boundedDisplayText(row.client, 9) || '?'
  const project = boundedProjectName(row.cwd)
  const title = boundedDisplayText(row.title ?? '(no title)', titleColumns(columns))
  const hue = clientColor(client)
  // A client that cannot resume is dimmed rather than given its own glyph: the
  // question the mark answered was how live the session is, and dimming says
  // that without another symbol to learn.
  const live = row.tier === 'resume'
  const age = ageEmphasis(row.endedAt, now)
  const [before, hit, after] = matchSpans(title, query)
  return (
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
      {row.collapsed ? <Text dimColor>{`  +${row.collapsed}`}</Text> : null}
    </Text>
  )
}

/** Draws the visible window of sessions, virtualized so a large index costs no more to render than a small one. */
export function List({
  rows, selected, height, now, columns = 92, query = '',
  rowComponent: RowComponent = DefaultListRow,
}: {
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
  const [start, end] = visibleWindow(active, total, height)
  const [thumbFrom, thumbTo] = railThumb(start, end - start, total)

  return (
    <Box flexDirection="column" width="100%">
      {rows.slice(start, end).map((row, offset) => {
        const index = start + offset
        return (
          <RowComponent
            key={row.uid} row={row} index={index}
            active={index === active} now={now} columns={columns} query={query}
            onThumb={offset >= thumbFrom && offset < thumbTo}
          />
        )
      })}
    </Box>
  )
}
