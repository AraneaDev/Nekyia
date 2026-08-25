import React from 'react'
import { Box, Text } from 'ink'
import type { IndexDb } from '../core/db'
import type { Row } from '../core/query'
import { relTime } from '../render'
import { boundedDisplayText, boundedPathTail } from './List'

const FIELD_COLUMNS = 120
/** Width of the hanging label column in the preview. */
const LABEL_COLUMNS = 9
const TITLE_COLUMNS = 512
const PROMPT_DB_CHARS = 65_536
const PROSE_DB_CHARS = 65_536
const FILE_DB_CHARS = 2_048
const BROWSE_DB_CHARS = 8_192

function safe(value: string | null | undefined, columns = FIELD_COLUMNS): string {
  return boundedDisplayText(typeof value === 'string' ? value : '', columns)
}

function textLines(value: string | null | undefined): string[] {
  return (typeof value === 'string' ? value : '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
}

interface PreviewData { files: string[]; prompts: string[]; prose: string[] }

function previewData(db: IndexDb, uid: string, full: boolean, maxLines: number): PreviewData {
  try {
    const textChars = full ? PROMPT_DB_CHARS : BROWSE_DB_CHARS
    const fileLimit = full ? 500 : Math.max(1, Math.min(500, Math.floor(maxLines)))
    const files = (db.raw().query(`
      SELECT substr(path, 1, ?) AS path
      FROM session_file
      WHERE uid = ?
      ORDER BY path COLLATE BINARY ASC
      LIMIT ?
    `).all(FILE_DB_CHARS, uid, fileLimit) as { path: string }[])
      .map((item) => safe(item.path))
      .filter(Boolean)
    const text = db.raw().query(`
      SELECT substr(prompts, 1, ?) AS prompts, substr(prose, 1, ?) AS prose
      FROM session_text WHERE uid = ?
    `).get(textChars, full ? PROSE_DB_CHARS : BROWSE_DB_CHARS, uid) as
      { prompts: string | null; prose: string | null } | null
    return { files, prompts: textLines(text?.prompts), prose: textLines(text?.prose) }
  } catch {
    return { files: [], prompts: [], prose: [] }
  }
}

/**
 * Hands each block a share of the space one line at a time, so a session with a
 * long reply cannot push what was asked or which files moved off the pane.
 * Whatever a short block does not want falls to the others.
 */
export function shareLines(room: number, wanted: number[]): number[] {
  const given = wanted.map(() => 0)
  let left = Math.max(0, room)
  let moved = true
  while (left > 0 && moved) {
    moved = false
    for (let index = 0; index < wanted.length && left > 0; index++) {
      if (given[index]! >= wanted[index]!) continue
      given[index]!++
      left--
      moved = true
    }
  }
  return given
}

export interface PreviewLine {
  text: string
  /** Hanging label, drawn only on a block's first line. */
  label?: string
  dim?: boolean
  bold?: boolean
  color?: string
}

/**
 * The whole detail view as flat lines, so the caller can count them, scroll
 * them and render a window without knowing how a session is laid out.
 *
 * Browsing fits the blocks into the space available. Inspecting keeps every
 * line and lets the reader scroll, which is the only way to read a reply that
 * runs to hundreds of lines.
 */
export function buildPreviewLines(
  db: IndexDb,
  row: Row | undefined,
  { columns = 80, maxLines = 12, full = false, now = Date.now() }: {
    columns?: number
    maxLines?: number
    full?: boolean
    /** Injectable clock, so the metadata line is deterministic in tests. */
    now?: number
  } = {},
): PreviewLine[] {
  if (!row) return []
  const width = Math.max(12, columns - LABEL_COLUMNS)
  const { files, prompts, prose } = previewData(db, row.uid, full, maxLines)
  const title = safe(row.title, TITLE_COLUMNS) || '(no title)'
  // The opening prompt usually is the title, so showing both spends a line
  // restating what is already on screen. Compare raw: the two are bounded to
  // different widths, and comparing the bounded forms calls a shared prefix a
  // difference.
  const rawTitle = typeof row.title === 'string' ? row.title : ''
  const asked = prompts.filter((line, index) => !(index === 0 && line === rawTitle))
  const client = safe(row.client, 32) || 'unknown client'
  const cwd = safe(row.cwd, width) || '(unknown directory)'
  const branch = safe(row.gitBranch, 64)
  const turns = typeof row.turns === 'number' && Number.isFinite(row.turns) && row.turns > 0
    ? Math.floor(row.turns)
    : 0

  // The session's directory is already on the line above, so repeating it on
  // every path spends width on something the reader has just been told.
  const base = typeof row.cwd === 'string' && row.cwd ? `${row.cwd.replace(/\/+$/u, '')}/` : ''
  const touched = files.map((file) => (
    base && file.startsWith(base) ? file.slice(base.length) : file
  ))

  const head: PreviewLine[] = [
    { text: safe(title, width), bold: true },
    {
      text: safe(
        `${cwd}${branch ? ` · ${branch}` : ''} · ${relTime(row.endedAt, now)} ago`
        + `${turns ? ` · ${turns} turns` : ''}`,
        width,
      ),
      dim: true,
    },
  ]
  if (row.tier !== 'resume') {
    head.push({
      text: safe(`${client} cannot resume by id · enter starts a new briefed session`, width),
      color: 'yellow',
    })
  }
  if (row.missing) {
    head.push({ text: 'source transcript no longer on disk', color: 'red' })
  }

  const blocks = [
    { label: 'asked', body: asked, dim: false, render: (line: string) => safe(line, width) },
    { label: 'replied', body: prose, dim: true, render: (line: string) => safe(line, width) },
    {
      label: 'touched', body: touched, dim: false,
      render: (line: string) => boundedPathTail(line, width),
    },
  ].filter((block) => block.body.length)

  // Each block that appears costs the blank line above it.
  const share = full
    ? blocks.map((block) => block.body.length)
    : shareLines(Math.max(0, maxLines - head.length - blocks.length), blocks.map((b) => b.body.length))

  const out = [...head]
  blocks.forEach((block, index) => {
    const count = share[index] ?? 0
    if (!count) return
    out.push({ text: '' })
    block.body.slice(0, count).forEach((line, offset) => {
      out.push({ text: block.render(line), label: offset === 0 ? block.label : '', dim: block.dim })
    })
  })
  return out
}


export function Preview({ lines, offset = 0, maxLines = 12 }: {
  lines: PreviewLine[]
  /** First line to draw, so the caller can scroll a long history. */
  offset?: number
  maxLines?: number
}) {
  if (!lines.length) return <Box><Text dimColor>nothing selected</Text></Box>
  const start = Math.max(0, Math.min(offset, Math.max(0, lines.length - 1)))
  const shown = lines.slice(start, start + Math.max(1, maxLines))
  return (
    <Box flexDirection="column">
      {shown.map((line, index) => (
        <Box key={`${start + index}:${line.label ?? ''}:${line.text}`} flexDirection="row">
          {line.label !== undefined
            ? <Box width={LABEL_COLUMNS} flexShrink={0}><Text dimColor>{line.label}</Text></Box>
            : null}
          <Text
            wrap="truncate-end"
            dimColor={line.dim}
            bold={line.bold}
            color={line.color}
          >
            {line.text}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
