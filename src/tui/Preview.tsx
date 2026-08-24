import React from 'react'
import { Box, Text } from 'ink'
import type { IndexDb } from '../core/db'
import type { Row } from '../core/query'
import { relTime } from '../render'
import { boundedDisplayText } from './List'

const FIELD_COLUMNS = 120
const TITLE_COLUMNS = 160
const PROMPT_DB_CHARS = 2_048
const FILE_DB_CHARS = 2_048

function safe(value: string | null | undefined, columns = FIELD_COLUMNS): string {
  return boundedDisplayText(typeof value === 'string' ? value : '', columns)
}

function previewData(db: IndexDb, uid: string): { files: string[]; first: string } {
  try {
    const files = (db.raw().query(`
      SELECT substr(path, 1, ?) AS path
      FROM session_file
      WHERE uid = ?
      ORDER BY path COLLATE BINARY ASC
      LIMIT 6
    `).all(FILE_DB_CHARS, uid) as { path: string }[])
      .map((item) => safe(item.path))
      .filter(Boolean)
    const text = db.raw().query(`
      SELECT substr(prompts, 1, ?) AS prompts FROM session_text WHERE uid = ?
    `).get(PROMPT_DB_CHARS, uid) as { prompts: string | null } | null
    const first = safe(text?.prompts?.split(/\r?\n/u, 1)[0] ?? '')
    return { files, first }
  } catch {
    return { files: [], first: '' }
  }
}

export function Preview({ row, db, now }: { row: Row | undefined; db: IndexDb; now: number }) {
  if (!row) return <Box><Text dimColor>no session selected</Text></Box>

  const { files, first } = previewData(db, row.uid)
  const title = safe(row.title, TITLE_COLUMNS) || '(no title)'
  const client = safe(row.client, 32) || 'unknown client'
  const cwd = safe(row.cwd) || '(unknown directory)'
  const branch = safe(row.gitBranch, 64)
  const turns = typeof row.turns === 'number' && Number.isFinite(row.turns) && row.turns > 0
    ? Math.floor(row.turns)
    : 0

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>{title}</Text>
      <Text dimColor>
        {client} - {cwd}{branch ? ` - ${branch}` : ''} - {relTime(row.endedAt, now)} ago
        {turns ? ` - ${turns} turns` : ''}
      </Text>
      {row.tier !== 'resume'
        ? <Text color="yellow">{client} cannot resume by id; enter starts a new briefed session</Text>
        : null}
      {row.missing ? <Text color="red">source transcript no longer on disk</Text> : null}
      {first ? <Box marginTop={1}><Text wrap="truncate-end">{first}</Text></Box> : null}
      {files.length
        ? <Box flexDirection="column" marginTop={1}>
            <Text dimColor>files touched</Text>
            {files.map((file, index) => <Text key={`${index}:${file}`} dimColor>  {file}</Text>)}
          </Box>
        : null}
    </Box>
  )
}
