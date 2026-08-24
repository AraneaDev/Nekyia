import React from 'react'
import { Box, Text } from 'ink'
import type { Row } from '../core/query'
import { projectName, relTime, tierGlyph } from '../render'

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
}

function DefaultListRow({ row, active, now }: ListRowProps) {
  const client = boundedDisplayText(row.client, 9) || '?'
  const project = boundedProjectName(row.cwd)
  const title = boundedDisplayText(row.title ?? '(no title)', 60)
  return (
    <Text inverse={active} wrap="truncate-end">
      {tierGlyph(row.tier)}{' '}
      <Text color={clientColor(client)}>{padColumns(client, 9)}</Text>{' '}
      <Text dimColor>{relTime(row.endedAt, now).padStart(4)}</Text>{' '}
      <Text dimColor>{padColumns(project, 14)}</Text>{' '}
      {title}
      {row.collapsed ? <Text dimColor>{`  +${row.collapsed}`}</Text> : null}
    </Text>
  )
}

export function List({ rows, selected, height, now, rowComponent: RowComponent = DefaultListRow }: {
  rows: Row[]
  selected: number
  height: number
  now: number
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
        return <RowComponent key={row.uid} row={row} index={index} active={index === active} now={now} />
      })}
    </Box>
  )
}
