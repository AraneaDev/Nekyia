import { expect, test } from 'bun:test'
import { IndexDb } from '../src/core/db'
import { readSessionDetail, qualityBadge } from '../src/core/session-detail'
import type { SessionRef } from '../src/types'

function fixture() {
  const db = IndexDb.open(':memory:')
  const ref: SessionRef = { uid: 'a', client: 'claude', nativeId: 'a', cwd: null, gitBranch: null, title: 'Title', startedAt: 1, endedAt: 2, turns: 2, parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: [], fingerprint: 'x' }
  db.upsertHydrated({ ref, prompts: ['old prompt'], prose: ['old reply'], files: ['a.ts'], truncated: false, dialogue: [{ role: 'user', text: 'first' }], fileDetail: 'ordered' })
  return db
}
test('detail keeps actual ordinal order and chooses each latest role from the end', () => {
  const db = fixture()
  db.raw().query('INSERT INTO session_turn VALUES (?, ?, ?, ?)').run('a', 90, 'user', 'latest question')
  db.raw().query('INSERT INTO session_turn VALUES (?, ?, ?, ?)').run('a', 7, 'assistant', 'latest answer')
  const detail = readSessionDetail(db, 'a')
  expect(detail.turns.map(t => t.ordinal)).toEqual([0, 7, 90])
  expect(detail.latestUser).toBe('latest question')
  expect(detail.latestReply).toBe('latest answer')
  expect(detail.ordered).toBe(true)
  expect(detail.fileCount).toBe(1)
  db.close()
})
test('latest text is bounded to 64 KiB even for Unicode and history to 1 MiB', () => {
  const db = fixture()
  db.raw().query('INSERT INTO session_turn VALUES (?, ?, ?, ?)').run('a', 7, 'assistant', '😀'.repeat(300_000))
  const detail = readSessionDetail(db, 'a')
  expect(Buffer.byteLength(detail.latestReply!)).toBeLessThanOrEqual(65_536)
  expect(detail.turns.reduce((n, t) => n + Buffer.byteLength(t.text), 0)).toBeLessThanOrEqual(1_048_576)
  expect(detail.reasons).toContain('reader-cap')
  db.close()
})
test('history turn limit and capped file count are truthful', () => {
  const db = fixture()
  const insert = db.raw().query('INSERT INTO session_turn VALUES (?, ?, ?, ?)')
  const file = db.raw().query('INSERT INTO session_file VALUES (?, ?)')
  for (let i = 1; i < 4100; i++) insert.run('a', i, 'user', 'x')
  for (let i = 0; i < 600; i++) file.run('a', `f${i}`)
  const detail = readSessionDetail(db, 'a')
  expect(detail.turns).toHaveLength(4096)
  expect(detail.reasons).toContain('reader-cap')
  expect(detail.fileCount).toBe(500)
  expect(detail.fileCountCapped).toBe(true)
  db.close()
})
test('legacy facets do not claim latest ordering; unavailable file details stay unknown', () => {
  const db = fixture()
  db.raw().exec("DROP TABLE session_turn; UPDATE meta SET value = '2' WHERE key = 'schema_version'")
  const detail = readSessionDetail(db, 'a')
  expect(detail.ordered).toBe(false)
  expect(detail.latestUser).toBe('old prompt')
  expect(detail.latestReply).toBe('old reply')
  expect(detail.reasons).toContain('legacy-text')
  expect(detail.fileCount).toBeNull()
  db.close()
})
test('absent role stays null and all quality facts follow badge precedence', () => {
  const db = fixture()
  db.raw().exec("UPDATE session SET missing = 1, truncated = 1, degraded = 1, file_events_truncated = 1 WHERE uid = 'a'")
  const detail = readSessionDetail(db, 'a')
  expect(detail.latestReply).toBeNull()
  expect(detail.reasons).toEqual(expect.arrayContaining(['source-missing', 'truncated', 'degraded', 'file-order']))
  expect(qualityBadge(detail.reasons)).toBe('Source missing')
  expect(qualityBadge(['degraded'])).toBe('History incomplete')
  expect(qualityBadge(['legacy-text'])).toBe('Details unavailable')
  expect(qualityBadge([])).toBeNull()
  expect(readSessionDetail(db, 'gone').reasons).toContain('details-unavailable')
  db.close()
})

test('latest summaries sanitize terminal controls without changing retained anchor text', () => {
  const db = fixture()
  db.raw().query('INSERT INTO session_turn VALUES (?, ?, ?, ?)').run('a', 50, 'user', 'before\t\x1b[31m\u202eafter\nnext')
  const detail = readSessionDetail(db, 'a')
  expect(detail.latestUser).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u202e]/u)
  expect(detail.latestUser).toContain('\nnext')
  expect(detail.turns[1]!.text).toContain('\x1b')
  db.close()
})

test('detail cache retains at most 32 recently inspected sessions per connection', () => {
  const db = fixture()
  const first = readSessionDetail(db, 'a')
  const base = db.getRef('a')!
  for (let i = 0; i < 32; i++) {
    db.upsertRef({ ...base, uid: `other-${i}`, nativeId: `other-${i}` })
    readSessionDetail(db, `other-${i}`)
  }
  expect(readSessionDetail(db, 'a')).not.toBe(first)
  db.close()
})
