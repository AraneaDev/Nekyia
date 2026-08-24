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

export function clientColor(client: string): string {
  return CLIENT_COLOR[client] ?? 'white'
}

/**
 * Projects have no fixed set, so their hue is derived from the name. The same
 * project keeps the same colour across runs and machines, which is what makes
 * it scannable; the client hues are excluded so the two columns stay apart.
 */
const PROJECT_COLOR = ['cyan', 'green', 'yellow', 'blue', 'magenta', 'red'] as const

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

/**
 * Splits a title around the query so the matching span can be lit. Matching is
 * case-insensitive on the first occurrence only: the point is to show the list
 * reacting to what was typed, not to mark up every letter.
 */
export function matchSpans(title: string, queryText: string): [string, string, string] {
  const needle = queryText.trim().toLowerCase()
  if (!needle) return [title, '', '']
  const at = title.toLowerCase().indexOf(needle)
  if (at === -1) return [title, '', '']
  return [title.slice(0, at), title.slice(at, at + needle.length), title.slice(at + needle.length)]
}

const DISPLAY_SCAN_FACTOR = 8
const MAX_DISPLAY_COLUMNS = 512
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu
const BIDI_FORMAT = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/gu
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

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

export interface ListRowProps {
  row: Row
  index: number
  active: boolean
  now: number
  /** Columns available to this row, so the title fills the pane it is drawn in. */
  columns: number
  /** Current search text, so the matching span can be lit inside the title. */
  query: string
}

/** rail gutter, client, age and project columns, with the spaces between them. */
export const ROW_FIXED_COLUMNS = 32

/**
 * The selected row is marked in the gutter rather than inverted. Inverting the
 * whole row put the client colour on its own background and made it unreadable,
 * and it drew a heavy band across the one row meant to feel picked out.
 */
const RAIL = '▌'

/** Columns the title may use once the fixed columns are paid for. */
export function titleColumns(columns: number): number {
  return Math.max(8, naturalNumber(columns) - ROW_FIXED_COLUMNS)
}

function DefaultListRow({ row, active, now, columns, query }: ListRowProps) {
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
      <Text color={active ? hue : undefined} dimColor={!active}>{active ? RAIL : ' '}</Text>{' '}
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

  return (
    <Box flexDirection="column" width="100%">
      {rows.slice(start, end).map((row, offset) => {
        const index = start + offset
        return (
          <RowComponent
            key={row.uid} row={row} index={index}
            active={index === active} now={now} columns={columns} query={query}
          />
        )
      })}
    </Box>
  )
}
