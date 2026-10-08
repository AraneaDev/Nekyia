import { afterEach, expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/config'
import { IndexDb } from '../src/core/db'
import { query } from '../src/core/query'
import { readSessionDetail } from '../src/core/session-detail'
import { buildSummaryLines } from '../src/tui/summary'
import type { SessionRef } from '../src/types'

let db: IndexDb | undefined
afterEach(() => { db?.close(); db = undefined })

function fixture() {
  db = IndexDb.open(':memory:')
  const ref: SessionRef = {
    uid: 'claude:a', client: 'claude', nativeId: 'a', cwd: '/work', gitBranch: 'main',
    title: 'Selected title', startedAt: 1, endedAt: 2, turns: 2, parentNativeId: null,
    tier: 'resume', origin: 'manifest', sourcePaths: [], fingerprint: 'x',
  }
  db.upsertHydrated({ ref, prompts: ['request'], prose: ['reply'], files: [], truncated: false,
    dialogue: [{ role: 'user', text: 'request' }, { role: 'assistant', text: 'reply' }], fileDetail: 'ordered' })
  return { row: query(db, DEFAULT_CONFIG, { now: 2 })[0]!, detail: readSessionDetail(db, ref.uid) }
}

test('preview wraps both summaries when their complete text fits', () => {
  const { row, detail } = fixture()
  const lines = buildSummaryLines(row, { ...detail,
    latestUser: 'u '.repeat(22) + 'REQUEST_END', latestReply: 'r '.repeat(22) + 'REPLY_END',
  }, null, { columns: 40, maxLines: 6 })
  expect(lines).toHaveLength(6)
  expect(lines.map(line => line.text).join('\n')).toContain('REQUEST_END')
  expect(lines.map(line => line.text).join('\n')).toContain('REPLY_END')
  for (const line of lines) expect(Bun.stringWidth(line.text)).toBeLessThanOrEqual(40)
})

test('competing summaries both receive space instead of a greedy first block', () => {
  const { row, detail } = fixture()
  const lines = buildSummaryLines(row, { ...detail,
    latestUser: 'request '.repeat(100), latestReply: 'response '.repeat(100),
  }, null, { columns: 40, maxLines: 6 })
  expect(lines).toHaveLength(6)
  expect(lines[2]!.text).toContain('Latest request: request')
  expect(lines[4]!.text).toContain('Latest reply: response')
})

test('space unused by a short request is available to the longer reply', () => {
  const { row, detail } = fixture()
  const lines = buildSummaryLines(row, { ...detail,
    latestUser: 'short', latestReply: 'response '.repeat(100),
  }, null, { columns: 40, maxLines: 6 })
  expect(lines).toHaveLength(6)
  expect(lines[2]!.text).toBe('Latest request: short')
  expect(lines[3]!.text).toContain('Latest reply: response')
  expect(lines[5]!.text).toContain('response')
})

test('child evidence precedes summaries without changing selected identity', () => {
  const { row, detail } = fixture()
  const lines = buildSummaryLines(row, detail, {
    uid: 'claude:child', field: 'prompt', text: 'matched fragment',
    spans: [{ start: 0, end: 7 }], anchor: { ordinal: 9, offset: 3 },
  }, { columns: 80, maxLines: 4 })
  expect(lines.map(line => line.text)).toEqual([
    'Selected title', 'Matched related session claude:child', 'matched fragment', 'main · 0 files',
  ])
  expect(lines[2]!.spans).toEqual([{ start: 0, end: 7 }])
  expect(row.uid).toBe('claude:a')
})

test('preview distinguishes incomplete ordered replies from legacy grouped text', () => {
  const { row, detail } = fixture()
  const incomplete = buildSummaryLines(row, { ...detail, reasons: ['reader-cap'] }, null, { columns: 80, maxLines: 8 })
  expect(incomplete.map(line => line.text).join('\n')).toContain('Last retained reply: reply')
  const legacy = buildSummaryLines(row, { ...detail, ordered: false, reasons: ['legacy-text'], fileCount: null }, null, { columns: 80, maxLines: 8 })
  const text = legacy.map(line => line.text).join('\n')
  expect(text).toContain('Prompt text: request')
  expect(text).toContain('Reply text: reply')
  expect(text).toContain('File details unavailable')
  expect(text).not.toContain('Latest')
})

test('preview omits duplicate title summaries and handles missing selection', () => {
  const { row, detail } = fixture()
  const lines = buildSummaryLines(row, { ...detail, latestUser: ' SELECTED TITLE ', latestReply: null }, null, { columns: 80, maxLines: 8 })
  expect(lines.map(line => line.text)).toEqual(['Selected title', 'main · 0 files'])
  expect(buildSummaryLines(undefined, detail, null, { columns: 80, maxLines: 8 })).toEqual([])
  expect(buildSummaryLines(row, null, null, { columns: 80, maxLines: 8 })).toEqual([])
})
