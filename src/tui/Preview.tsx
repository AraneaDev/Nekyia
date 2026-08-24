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
const PROMPT_DB_CHARS = 8_192
const PROSE_DB_CHARS = 16_384
const FILE_DB_CHARS = 2_048

function safe(value: string | null | undefined, columns = FIELD_COLUMNS): string {
  return boundedDisplayText(typeof value === 'string' ? value : '', columns)
}

function lines(value: string | null | undefined): string[] {
  return (typeof value === 'string' ? value : '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
}

interface PreviewData { files: string[]; prompts: string[]; prose: string[] }

function previewData(db: IndexDb, uid: string): PreviewData {
  try {
    const files = (db.raw().query(`
      SELECT substr(path, 1, ?) AS path
      FROM session_file
      WHERE uid = ?
      ORDER BY path COLLATE BINARY ASC
      LIMIT 60
    `).all(FILE_DB_CHARS, uid) as { path: string }[])
      .map((item) => safe(item.path))
      .filter(Boolean)
    const text = db.raw().query(`
      SELECT substr(prompts, 1, ?) AS prompts, substr(prose, 1, ?) AS prose
      FROM session_text WHERE uid = ?
    `).get(PROMPT_DB_CHARS, PROSE_DB_CHARS, uid) as
      { prompts: string | null; prose: string | null } | null
    return { files, prompts: lines(text?.prompts), prose: lines(text?.prose) }
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

function Block({ label, body, dim }: { label: string; body: string[]; dim?: boolean }) {
  return (
    <Box marginTop={1} flexDirection="row">
      <Box width={LABEL_COLUMNS} flexShrink={0}><Text dimColor>{label}</Text></Box>
      <Box flexDirection="column">
        {body.map((line, index) => (
          <Text key={`${index}:${line}`} wrap="truncate-end" dimColor={dim}>{line}</Text>
        ))}
      </Box>
    </Box>
  )
}

/**
 * Every line is single-line by construction and each block is sliced to its
 * share, so the pane never overflows and Ink is never asked to clip wrapped
 * text, which merges the clipped tail into the line above it.
 */
export function Preview({ row, db, now, maxLines = 12, columns = 80 }: {
  row: Row | undefined
  db: IndexDb
  now: number
  /** Content lines this preview may occupy. */
  maxLines?: number
  /** Width available, so lines are bounded to the pane they are drawn in. */
  columns?: number
}) {
  if (!row) return <Box><Text dimColor>nothing selected</Text></Box>

  const width = Math.max(12, columns - LABEL_COLUMNS)
  const { files, prompts, prose } = previewData(db, row.uid)
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
    file.startsWith(base) && base ? file.slice(base.length) : file
  ))

  const spent = 2 + (row.tier !== 'resume' ? 1 : 0) + (row.missing ? 1 : 0)
  const blocks = [
    { label: 'asked', body: asked, dim: false },
    { label: 'replied', body: prose, dim: true },
    { label: 'touched', body: touched, dim: false },
  ].filter((block) => block.body.length)
  // Each block that appears costs the blank line above it.
  const share = shareLines(
    Math.max(0, maxLines - spent - blocks.length),
    blocks.map((block) => block.body.length),
  )

  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">{title}</Text>
      <Text dimColor wrap="truncate-end">
        {cwd}{branch ? ` · ${branch}` : ''} · {relTime(row.endedAt, now)} ago
        {turns ? ` · ${turns} turns` : ''}
      </Text>
      {row.tier !== 'resume'
        ? <Text color="yellow" wrap="truncate-end">
            {client} cannot resume by id · enter starts a new briefed session
          </Text>
        : null}
      {row.missing
        ? <Text color="red" wrap="truncate-end">source transcript no longer on disk</Text>
        : null}
      {blocks.map((block, index) => (
        share[index]
          ? (
            <Block
              key={block.label}
              label={block.label}
              dim={block.dim}
              body={block.body.slice(0, share[index]).map((line) => (
                block.label === 'touched' ? boundedPathTail(line, width) : safe(line, width)
              ))}
            />
          )
          : null
      ))}
    </Box>
  )
}
