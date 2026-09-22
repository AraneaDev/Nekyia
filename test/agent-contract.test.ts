import { expect, test } from 'bun:test'
import { serializeSearchRow } from '../src/agent-contract'
import type { Row } from '../src/core/query'

type TestRow = Row & Partial<{
  truncated: boolean
  degraded: boolean
  fileDetail: 'unknown' | 'paths' | 'ordered'
  eventsTruncated: boolean
}>

function row(over: Partial<TestRow> = {}): TestRow {
  return {
    uid: 'claude:session-1',
    client: 'claude',
    nativeId: 'session-1',
    cwd: '/work/project',
    gitBranch: 'main',
    title: 'retry tenant',
    startedAt: 1,
    endedAt: 2,
    turns: 3,
    parentNativeId: null,
    tier: 'search',
    origin: 'manifest',
    missing: false,
    score: 1.5,
    collapsed: 0,
    ...over,
  }
}

test('search serialization carries versioned identity and context quality', () => {
  const result = serializeSearchRow(row({
    missing: true,
    truncated: true,
    degraded: true,
    fileDetail: 'paths',
    eventsTruncated: true,
    launcher: 'claude',
  }), ['/tmp/session.jsonl'])

  expect(result.contractVersion).toBe(1)
  expect(result.uid).toBe('claude:session-1')
  expect(result.capability).toBe('search')
  expect(result.sourcePaths).toEqual(['/tmp/session.jsonl'])
  expect(result.quality).toEqual({
    missing: true,
    truncated: true,
    degraded: true,
    fileDetail: 'paths',
    eventsTruncated: true,
  })
  expect(result.limitations).toEqual([
    'source-missing',
    'content-truncated',
    'content-degraded',
    'file-events-unordered',
    'file-events-truncated',
  ])
})

test('unresolved launchers are not represented as capabilities', () => {
  const result = serializeSearchRow(row({ tier: 'detected' }), [])

  expect(result.capability).toBe('detected')
  expect('launcher' in result).toBe(false)
  expect(result.limitations).toContain('not-launchable')
})
