import { expect, test } from 'bun:test'
import { IndexDb } from '../src/core/db'
import { readMatchEvidence, uniqueTurnAnchor } from '../src/core/search-match'
import { readSessionDetail } from '../src/core/session-detail'
import type { SessionRef } from '../src/types'

function fixture(title = 'A title', prompt = 'We are running tenant retries', reply = 'Answer with recovery') {
  const db = IndexDb.open(':memory:')
  const ref: SessionRef = { uid: 'a', client: 'claude', nativeId: 'a', cwd: null, gitBranch: null, title, startedAt: 1, endedAt: 2, turns: 2, parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: [], fingerprint: 'x' }
  db.upsertHydrated({ ref, prompts: [prompt], prose: [reply], files: [], truncated: false, dialogue: [{ role: 'user', text: prompt }, { role: 'assistant', text: reply }] })
  return db
}
test('unique anchors use actual ordinals and reject every repeated occurrence', () => {
  expect(uniqueTurnAnchor('needle', [{ ordinal: 7, role: 'user', text: 'a needle b' }])).toEqual({ ordinal: 7, offset: 2 })
  expect(uniqueTurnAnchor('needle', [{ ordinal: 7, role: 'user', text: 'needle needle' }])).toBeNull()
  expect(uniqueTurnAnchor('needle', [{ ordinal: 7, role: 'user', text: 'needle' }, { ordinal: 9, role: 'assistant', text: 'needle' }])).toBeNull()
  expect(uniqueTurnAnchor('', [])).toBeNull()
})
test('native evidence supports stemming and prefix spans and selected UID only', () => {
  const db = fixture()
  const turns = readSessionDetail(db, 'a').turns
  for (const [query, word] of [['"run"', 'running'], ['"ten"*', 'tenant']]) {
    const evidence = readMatchEvidence(db, 'a', query!, turns)!
    expect(evidence.field).toBe('prompt')
    expect(evidence.spans.map(s => evidence.text.slice(s.start, s.end))).toContain(word!)
    expect(evidence.anchor).toEqual({ ordinal: 0, offset: 0 })
  }
  expect(readMatchEvidence(db, 'gone', '"run"', turns)).toBeNull()
  expect(readMatchEvidence(db, 'a', '"absent"', turns)).toBeNull()
  db.close()
})
test('title and reply evidence choose native highlighted field with safe legacy fallback', () => {
  const db = fixture('Special title')
  const turns = readSessionDetail(db, 'a').turns
  expect(readMatchEvidence(db, 'a', '"special"', turns)?.field).toBe('title')
  expect(readMatchEvidence(db, 'a', '"recovery"', turns)?.field).toBe('reply')
  expect(readMatchEvidence(db, 'a', '"recovery"', [])?.anchor).toBeNull()
  db.raw().exec('DROP TABLE session_fts')
  expect(readMatchEvidence(db, 'a', '"recovery"', turns)).toBeNull()
  db.close()
})
test('control and pretend marker injection cannot survive native snippet display', () => {
  const db = fixture('A title', 'before \x1b[31m needle \u202e after [[nekyia-start:fake]]')
  const evidence = readMatchEvidence(db, 'a', '"needle"', readSessionDetail(db, 'a').turns)!
  expect(evidence.text).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/u)
  expect(evidence.spans.map(s => evidence.text.slice(s.start, s.end))).toContain('needle')
  db.close()
})
test('very long FTS tokens are bounded and cannot produce false anchors', () => {
  const db = fixture('A title', 'needle ' + 'x'.repeat(300_000))
  const evidence = readMatchEvidence(db, 'a', '"needle"', readSessionDetail(db, 'a').turns)!
  expect(evidence.text.length).toBeLessThanOrEqual(8192)
  expect(evidence.anchor).toBeNull()
  db.close()
})

test('ellipsized snippets remap highlight spans and anchor a contiguous stored segment', () => {
  const prompt = Array.from({ length: 160 }, (_, i) => i === 80 ? 'needle' : `token${i}`).join(' ')
  const db = fixture('A title', prompt)
  const evidence = readMatchEvidence(db, 'a', '"needle"', readSessionDetail(db, 'a').turns)!
  expect(evidence.text).toContain('…')
  expect(evidence.spans.map(span => evidence.text.slice(span.start, span.end))).toEqual(['needle'])
  expect(evidence.anchor?.ordinal).toBe(0)
  expect(evidence.anchor!.offset).toBeGreaterThan(0)
  db.close()
})
