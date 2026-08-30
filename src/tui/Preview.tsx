import React from 'react'
import { Box, Text } from 'ink'
import { FILE_EVENT_SCHEMA_VERSION, TURN_SCHEMA_VERSION } from '../core/db'
import type { IndexDb } from '../core/db'
import type { Row } from '../core/query'
import { relTime } from '../render'
import { boundedDisplayText, boundedPathTail, wrappedDisplayLines } from './text'

const FIELD_COLUMNS = 120
/** Width of the hanging label column in the preview. */
const LABEL_COLUMNS = 9
const TITLE_COLUMNS = 512
const PROMPT_DB_CHARS = 65_536
const PROSE_DB_CHARS = 65_536
const FILE_DB_CHARS = 2_048
/**
 * What browsing reads per text column. Moving the cursor rebuilds the preview
 * for every row it passes, and browsing only ever shows a pane's worth of
 * lines, so reading a full 64 KiB of prompts and prose per step pays for text
 * that is discarded before it is drawn.
 */
const BROWSE_DB_CHARS = 8_192
/** Most files a preview will ever list, so a session that touched thousands cannot be read whole. */
const FILE_ROW_LIMIT = 500
/**
 * What the opened history reads of a session's ordered dialogue.
 *
 * Deliberately far wider than the browsing budgets: this view exists to be read
 * in full, is built once when ctrl+o opens it rather than on every cursor move,
 * and wrapping means a long reply continues instead of being cut. The ceiling
 * is there so one runaway session cannot pull an unbounded string into memory,
 * and the reader is told when it is reached rather than left to assume the
 * transcript simply ended.
 */
const HISTORY_DB_CHARS = 1_048_576
/** Companion ceiling on turn count, so a session of many tiny turns is bounded too. */
const HISTORY_TURN_LIMIT = 4_096

function safe(value: string | null | undefined, columns = FIELD_COLUMNS): string {
  return boundedDisplayText(typeof value === 'string' ? value : '', columns)
}

function textLines(value: string | null | undefined): string[] {
  return (typeof value === 'string' ? value : '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** One stored turn, as the history reads it back out of the index. */
interface PreviewTurn { role: 'user' | 'assistant'; text: string }

/** One stored file event, as the history reads it back out of the index. */
interface PreviewFileEvent { kind: string; path: string }

interface PreviewData {
  files: string[]
  prompts: string[]
  prose: string[]
  /** Empty while browsing, and for a session indexed before ordered turns existed. */
  dialogue: PreviewTurn[]
  /** The stored dialogue ran past a budget, so what is shown stops short of it. */
  dialogueTruncated: boolean
  /** Empty while browsing, and for a session indexed before file events existed. */
  fileEvents: PreviewFileEvent[]
}

/**
 * How many file rows are worth reading for a pane of `maxLines`. Browsing can
 * never draw more paths than the pane has lines, so anything past that is read
 * and thrown away.
 */
function fileLimit(full: boolean, maxLines: number): number {
  if (full || !Number.isFinite(maxLines)) return FILE_ROW_LIMIT
  return Math.max(1, Math.min(FILE_ROW_LIMIT, Math.floor(maxLines)))
}

/**
 * Strips the session's own directory off the front of a path, so a file inside
 * it reads as a relative path instead of repeating a directory already shown
 * on the line above.
 */
function relativeTo(base: string, file: string): string {
  return base && file.startsWith(base) ? file.slice(base.length) : file
}

/**
 * Reads a session's turns in order, stopping at whichever budget runs out first.
 *
 * The window function carries a running total of the characters in every turn
 * before this one, so each row knows how much of the budget was already spent
 * when it starts. Rows that begin past the budget are dropped, and the one row
 * that straddles the boundary is cut to exactly what is left, which keeps the
 * whole read bounded without a second round trip to find out where to stop.
 * `LIMIT` bounds the turn count independently, for a session whose turns are
 * many and short.
 */
function dialogueTurns(db: IndexDb, uid: string): PreviewTurn[] {
  const rows = db.raw().query(`
    WITH ordered AS (
      SELECT role, text, ordinal,
        COALESCE(SUM(length(text)) OVER (
          ORDER BY ordinal ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0) AS before_chars
      FROM session_turn WHERE uid = ?
    )
    SELECT role, substr(text, 1, max(0, ? - before_chars)) AS text
    FROM ordered
    WHERE before_chars < ?
    ORDER BY ordinal
    LIMIT ?
  `).all(uid, HISTORY_DB_CHARS, HISTORY_DB_CHARS, HISTORY_TURN_LIMIT) as PreviewTurn[]
  return rows.filter((turn): turn is PreviewTurn => (
    (turn.role === 'user' || turn.role === 'assistant') && typeof turn.text === 'string'
  ))
}

function previewData(db: IndexDb, uid: string, full: boolean, maxLines: number): PreviewData {
  try {
    const textChars = full ? PROMPT_DB_CHARS : BROWSE_DB_CHARS
    const proseChars = full ? PROSE_DB_CHARS : BROWSE_DB_CHARS
    const files = (db.raw().query(`
      SELECT substr(path, 1, ?) AS path
      FROM session_file
      WHERE uid = ?
      ORDER BY path COLLATE BINARY ASC
      LIMIT ?
    `).all(FILE_DB_CHARS, uid, fileLimit(full, maxLines)) as { path: string }[])
      .map((item) => safe(item.path))
      .filter(Boolean)
    const text = db.raw().query(`
      SELECT substr(prompts, 1, ?) AS prompts, substr(prose, 1, ?) AS prose
      FROM session_text WHERE uid = ?
    `).get(textChars, proseChars, uid) as
      { prompts: string | null; prose: string | null } | null
    // Browsing never draws a transcript, so it never pays for one. An index
    // stamped below schema version 3 has no table to read either.
    const stats = full && db.schemaVersion() >= TURN_SCHEMA_VERSION
      ? db.raw().query(`
        SELECT COUNT(*) AS turns, COALESCE(SUM(length(text)), 0) AS chars
        FROM session_turn WHERE uid = ?
      `).get(uid) as { turns: number; chars: number }
      : { turns: 0, chars: 0 }
    // Browsing never draws an ordered file list, so it never pays for one. An
    // index stamped below the file-event version has no table to read either.
    const fileEvents = full && db.schemaVersion() >= FILE_EVENT_SCHEMA_VERSION
      ? (db.raw().query(`
        SELECT kind, substr(path, 1, ?) AS path
        FROM session_file_event WHERE uid = ? ORDER BY ordinal LIMIT ?
      `).all(FILE_DB_CHARS, uid, fileLimit(full, maxLines)) as { kind: string; path: string }[])
        .map((item) => ({ kind: safe(item.kind, 8), path: safe(item.path) }))
        .filter((item) => item.path)
      : []
    return {
      files,
      prompts: textLines(text?.prompts),
      prose: textLines(text?.prose),
      dialogue: stats.turns > 0 ? dialogueTurns(db, uid) : [],
      dialogueTruncated: stats.turns > HISTORY_TURN_LIMIT || stats.chars > HISTORY_DB_CHARS,
      fileEvents,
    }
  } catch {
    return { files: [], prompts: [], prose: [], dialogue: [], dialogueTruncated: false, fileEvents: [] }
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

/** One line of the session preview, with the styling it should be drawn in. */
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
  // Block bodies hang off a label gutter and pay for it. Head lines carry no
  // label, so nothing draws that gutter for them and charging them for it left
  // the metadata line cut short with the width sitting empty beside it.
  const headWidth = Math.max(12, columns)
  const width = Math.max(12, columns - LABEL_COLUMNS)
  const { files, prompts, prose, dialogue, dialogueTruncated, fileEvents } = previewData(
    db, row.uid, full, maxLines,
  )
  const title = safe(row.title, TITLE_COLUMNS) || '(no title)'
  // The opening prompt usually is the title, so showing both spends a line
  // restating what is already on screen. Compare raw: the two are bounded to
  // different widths, and comparing the bounded forms calls a shared prefix a
  // difference.
  const rawTitle = typeof row.title === 'string' ? row.title : ''
  const asked = prompts.filter((line, index) => !(index === 0 && line === rawTitle))
  const client = safe(row.client, 32) || 'unknown client'
  const cwd = safe(row.cwd, headWidth) || '(unknown directory)'
  const branch = safe(row.gitBranch, 64)
  const turns = typeof row.turns === 'number' && Number.isFinite(row.turns) && row.turns > 0
    ? Math.floor(row.turns)
    : 0

  // The session's directory is already on the line above, so repeating it on
  // every path spends width on something the reader has just been told.
  const base = typeof row.cwd === 'string' && row.cwd ? `${row.cwd.replace(/\/+$/u, '')}/` : ''
  const touched = files.map((file) => relativeTo(base, file))

  const head: PreviewLine[] = [
    { text: safe(title, headWidth), bold: true },
    {
      text: safe(
        `${cwd}${branch ? ` · ${branch}` : ''} · ${relTime(row.endedAt, now)} ago`
        + `${turns ? ` · ${turns} turns` : ''}`,
        headWidth,
      ),
      dim: true,
    },
  ]
  if (row.tier !== 'resume') {
    head.push({
      text: safe(`${client} cannot resume by id · enter starts a new briefed session`, headWidth),
      color: 'yellow',
    })
  }
  if (row.missing) {
    head.push({ text: 'source transcript no longer on disk', color: 'red' })
  }
  if (full && dialogueTruncated) {
    head.push({ text: 'history display capped; indexed dialogue continues', color: 'yellow' })
  }

  // The opened history is a transcript: who said what, in the order they said
  // it, opening prompt included even though the title repeats it. A session
  // indexed before ordered turns existed has none, and falls through to the
  // grouped blocks below until it is hydrated again.
  if (full && dialogue.length > 0) {
    const out = [...head]
    for (const turn of dialogue) {
      const lines = textLines(turn.text).flatMap((line) => wrappedDisplayLines(line, width))
      if (lines.length === 0) continue
      out.push({ text: '' })
      lines.forEach((line, index) => out.push({
        text: line,
        label: index === 0 ? (turn.role === 'user' ? 'asked' : 'replied') : '',
        dim: turn.role === 'assistant',
      }))
    }
    // Inspecting shows the operations in the order they happened, the same way
    // it shows the dialogue in the order it was said. A session indexed before
    // file events, or a client that records names only, has none and falls back
    // to the list it always showed.
    const ordered = fileEvents.length > 0
      ? fileEvents.map((event) => `${event.kind.padEnd(8)}${relativeTo(base, event.path)}`)
      : touched
    if (ordered.length > 0) {
      out.push({ text: '' })
      ordered.forEach((line, index) => out.push({
        text: boundedPathTail(line, width),
        label: index === 0 ? 'touched' : '',
      }))
    }
    return out
  }

  // Sanitizing is deferred to `render`. Browsing hands a block a few lines out
  // of the hundreds it offers, and bounding the rest only to drop them spends
  // the most expensive work in the preview on text nobody sees.
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


/** Draws a scrollable window over the selected session's prompts, replies, and touched files. */
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
