import { expect, test } from 'bun:test'
import { formatRow, projectName, relTime, tierGlyph } from '../src/render'
import type { Row } from '../src/core/query'

const NOW = 1_800_000_000_000
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

test('relTime formats compactly', () => {
  expect(relTime(NOW - 30_000, NOW)).toBe('now')
  expect(relTime(NOW - 5 * MIN, NOW)).toBe('5m')
  expect(relTime(NOW - 3 * HOUR, NOW)).toBe('3h')
  expect(relTime(NOW - 2 * DAY, NOW)).toBe('2d')
  expect(relTime(NOW - 40 * DAY, NOW)).toBe('5w')
  expect(relTime(NOW - 400 * DAY, NOW)).toBe('1y')
})

test('relTime does not go negative for a clock skew in the future', () => {
  expect(relTime(NOW + 10 * DAY, NOW)).toBe('now')
})

test('row rendering is compact and includes tier and collapsed-count facets', () => {
  const row = {
    uid: 'claude:id', client: 'claude', nativeId: 'id', cwd: '/root/a-very-long-project-name',
    gitBranch: null, title: null, startedAt: NOW, endedAt: NOW - 5 * MIN, turns: 1,
    parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: [],
    fingerprint: 'f', missing: false, score: 1, collapsed: 2,
  } satisfies Row
  expect(projectName(null)).toBe('-')
  expect(projectName('/')).toBe('/')
  expect(tierGlyph('resume')).toBe('*')
  expect(tierGlyph('search')).toBe('o')
  expect(formatRow(row, NOW)).toContain('*  claude')
  expect(formatRow(row, NOW)).toContain('(no title)  +2')
  expect(formatRow(row, NOW)).toContain('a-very-long-proj')
})
