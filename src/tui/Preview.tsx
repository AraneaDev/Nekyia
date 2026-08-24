import React from 'react'
import { Box, Text } from 'ink'
import type { IndexDb } from '../core/db'
import type { Row } from '../core/query'
import { relTime } from '../render'
import { boundedDisplayText, boundedPathTail } from './List'

const FIELD_COLUMNS = 120
/** Width of the hanging label column in the preview. */
const LABEL_COLUMNS = 9
const TITLE_COLUMNS = 160
const PROMPT_DB_CHARS = 8_192
const FILE_DB_CHARS = 2_048

function safe(value: string | null | undefined, columns = FIELD_COLUMNS): string {
  return boundedDisplayText(typeof value === 'string' ? value : '', columns)
}

function previewData(db: IndexDb, uid: string): { files: string[]; prompts: string[] } {
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
      SELECT substr(prompts, 1, ?) AS prompts FROM session_text WHERE uid = ?
    `).get(PROMPT_DB_CHARS, uid) as { prompts: string | null } | null
    // Every opening line, not just the first: a tall pane has room to show how
    // the session actually began, and the caller trims to what fits.
    const prompts = (text?.prompts ?? '').split(/\r?\n/u)
      .map((line) => line.trim()).filter(Boolean)
    return { files, prompts }
  } catch {
    return { files: [], prompts: [] }
  }
}

/**
 * Every line is single-line by construction and the file list is sliced to the
 * caller's budget, so the box never overflows and Ink is never asked to clip
 * wrapped text, which merges the clipped tail into the line above it.
 */
export function Preview({ row, db, now, maxLines = 12, columns = 80 }: {
  row: Row | undefined
  db: IndexDb
  now: number
  /** Content lines this preview may occupy. */
  maxLines?: number
  /** Width available, so paths keep their tail rather than their directories. */
  columns?: number
}) {
  if (!row) return <Box><Text dimColor>nothing selected</Text></Box>

  const { files, prompts } = previewData(db, row.uid)
  const title = safe(row.title, TITLE_COLUMNS) || '(no title)'
  // Most clients derive the title from the opening prompt, so printing both
  // spends a line restating what is already on screen. Compare the raw values:
  // title and prompt are bounded to different widths, so comparing the bounded
  // forms would call a long shared prefix a difference.
  const rawTitle = typeof row.title === 'string' ? row.title : ''
  // The opening prompt usually is the title, so showing both spends a line
  // restating what is already on screen. Compare raw: the two are bounded to
  // different widths, and comparing the bounded forms calls a shared prefix a
  // difference.
  const opening = prompts.filter((line, index) => !(index === 0 && line === rawTitle))
  const client = safe(row.client, 32) || 'unknown client'
  const cwd = safe(row.cwd) || '(unknown directory)'
  const branch = safe(row.gitBranch, 64)
  const turns = typeof row.turns === 'number' && Number.isFinite(row.turns) && row.turns > 0
    ? Math.floor(row.turns)
    : 0

  const spent = 2
    + (row.tier !== 'resume' ? 1 : 0)
    + (row.missing ? 1 : 0)
  // Whatever the header does not use is split between the opening prompts and
  // the files, so a tall pane fills instead of trailing off into blank rows.
  const room = Math.max(0, maxLines - spent)
  const promptBudget = Math.min(opening.length, Math.max(0, Math.ceil(room / 3)))
  const shownPrompts = opening.slice(0, promptBudget).map((line) => safe(line))
  const filesRoom = room - (shownPrompts.length ? shownPrompts.length + 1 : 0) - 1
  const fileBudget = Math.max(0, Math.min(files.length, filesRoom))
  // The session's directory is already on the line above, so repeating it on
  // every path spends width on something the reader has just been told.
  const base = typeof row.cwd === 'string' && row.cwd ? `${row.cwd.replace(/\/+$/u, '')}/` : ''
  const shownFiles = (fileBudget > 0 ? files.slice(0, fileBudget) : [])
    .map((file) => (base && file.startsWith(base) ? file.slice(base.length) : file))

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
      {shownPrompts.length
        ? <Box marginTop={1} flexDirection="column">
            {shownPrompts.map((line, index) => (
              <Text key={`${index}:${line}`} wrap="truncate-end" dimColor={index > 0}>{line}</Text>
            ))}
          </Box>
        : null}
      {shownFiles.length
        ? <Box marginTop={1} flexDirection="row">
            <Box width={LABEL_COLUMNS} flexShrink={0}><Text dimColor>touched</Text></Box>
            <Box flexDirection="column">
              {shownFiles.map((file, index) => (
                <Text key={`${index}:${file}`} wrap="truncate-end">
                  {boundedPathTail(file, Math.max(12, columns - LABEL_COLUMNS))}
                </Text>
              ))}
            </Box>
          </Box>
        : null}
    </Box>
  )
}
