import { expect, test } from 'bun:test'
import { publicRow } from '../src/commands/search'
import type { Row } from '../src/core/query'

function row(over: Partial<Row> = {}): Row {
  return {
    uid: 'codebuff:c1', client: 'codebuff', nativeId: 'c1', cwd: '/work/project',
    gitBranch: 'main', title: 'a shared chat', startedAt: 1, endedAt: 20, turns: 2,
    parentNativeId: null, tier: 'search', origin: 'manifest',
    missing: false, score: 20, collapsed: 0,
    ...over,
  }
}

test('publicRow names the resolved launcher separately from the manifest id that wrote the session', () => {
  const shown = publicRow(row({ tier: 'resume', clientLabel: 'freebuff' }), [])
  expect(shown.client).toBe('codebuff')
  expect(shown.tier).toBe('resume')
  expect(shown.launcher).toBe('freebuff')
})

test('publicRow has no launcher key for a client with no overlay', () => {
  const shown = publicRow(row(), [])
  expect(shown.client).toBe('codebuff')
  expect('launcher' in shown).toBe(false)
})
