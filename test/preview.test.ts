import { expect, test } from 'bun:test'
import { IndexDb } from '../src/core/db'
import type { Row } from '../src/core/query'
import { buildPreviewLines } from '../src/tui/Preview'

const NOW = 1_800_000_000_000

function row(over: Partial<Row> = {}): Row {
  return {
    uid: 'codebuff:c1', client: 'codebuff', nativeId: 'c1', cwd: '/root/proj',
    gitBranch: 'main', title: 'a shared chat', startedAt: 0, endedAt: NOW,
    turns: 1, parentNativeId: null, tier: 'search', origin: 'manifest',
    missing: false, score: 0, collapsed: 0,
    ...over,
  }
}

test('an undecided shared store says no client is chosen, not that this client cannot resume', () => {
  const db = IndexDb.open(':memory:')
  // clientLabel set (ask/none default) but no launcher resolved: the picker
  // has not decided which client would open this store, so the preview must
  // not claim a specific client "cannot resume by id".
  const lines = buildPreviewLines(db, row({ clientLabel: 'codebuff' }), { now: NOW })
  const warning = lines.find((line) => line.color === 'yellow')
  expect(warning?.text).toContain('no client chosen for this store yet')
  // Neither installed is the same undecided state, so the text must not
  // promise that Enter will ask.
  expect(warning?.text).not.toContain('enter asks')
  expect(warning?.text).not.toContain('cannot resume by id')
  db.close()
})

test('a chosen search-tier launcher still names itself as unable to resume', () => {
  const db = IndexDb.open(':memory:')
  const lines = buildPreviewLines(
    db, row({ clientLabel: 'codebuff', launcher: 'codebuff' }), { now: NOW },
  )
  const warning = lines.find((line) => line.color === 'yellow')
  expect(warning?.text).toContain('codebuff cannot resume by id')
  db.close()
})

test('a search-tier row with no overlay names the client that wrote it', () => {
  const db = IndexDb.open(':memory:')
  const lines = buildPreviewLines(db, row({ client: 'goose' }), { now: NOW })
  const warning = lines.find((line) => line.color === 'yellow')
  expect(warning?.text).toContain('goose cannot resume by id')
  db.close()
})
