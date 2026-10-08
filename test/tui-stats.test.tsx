import { afterEach, expect, test } from 'bun:test'
import React from 'react'
import { cleanup, render } from 'ink-testing-library'
import { StatsPanel } from '../src/tui/StatsPanel'
import { activitySparkline, resultStats } from '../src/tui/result-stats'
import { paneLayout } from '../src/tui/layout'
import type { Row } from '../src/core/query'

afterEach(cleanup)
const now = new Date(2026, 9, 8, 12).getTime()
function row(uid: string, endedAt: number, client = 'claude', cwd: string | null = '/work'): Row {
  return { uid, client, nativeId: uid, cwd, gitBranch: null, title: uid,
    startedAt: endedAt, endedAt, turns: 1, parentNativeId: null, tier: 'resume',
    origin: 'manifest', missing: false, score: 0, collapsed: 0 }
}

test('stats count displayed results and include empty local days without future activity', () => {
  const first = new Date(2026, 9, 2).getTime()
  const stats = resultStats([
    row('a', first), row('b', now), row('c', now, 'codex', '/other'),
    row('old', first-1), row('future', now+1), row('invalid', NaN, 'codex', null),
  ], now)
  expect(stats.total).toBe(6)
  expect(stats.projects).toBe(2)
  expect(stats.days.map(day=>day.count)).toEqual([1,0,0,0,0,0,2])
  expect(stats.clients.map(client=>[client.id,client.count])).toEqual([['claude',4],['codex',2]])
  expect(activitySparkline(stats.days)).toBe('▄ · · · · · █')
})

test('local calendar boundaries work across daylight saving transitions', () => {
  const clock = new Date(2026, 9, 28, 12).getTime()
  const boundary = new Date(2026, 9, 25).getTime()
  const stats=resultStats([row('before',boundary-1),row('at',boundary),row('after',boundary+1)],clock)
  expect(stats.days.map(day=>day.count)).toEqual([0,0,1,2,0,0,0])
  expect(activitySparkline(resultStats([],clock).days)).toBe('· · · · · · ·')
})

test('panel explicitly labels capped results and stays within its geometry', async () => {
  const stats=resultStats(Array.from({length:500},(_,index)=>row(String(index),now,index%2?'codex':'claude')),now)
  for(const rows of [8,12,20]){
    const view=render(<StatsPanel stats={stats} columns={26} rows={rows} overflowed/>)
    await new Promise(resolve=>setTimeout(resolve,20))
    expect(view.lastFrame()).toContain('Shown results only')
    expect(view.lastFrame()).toContain('Last 7 days')
    expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(rows)
    for(const line of view.lastFrame()!.split('\n'))expect(Bun.stringWidth(line)).toBeLessThanOrEqual(26)
    view.unmount()
  }
})

test('stats never take preview width and can be collapsed', () => {
  expect(paneLayout(139,24,4).statsWidth).toBe(0)
  expect(paneLayout(140,24,4).listWidth).toBe(112)
  expect(paneLayout(160,24,4).statsWidth).toBe(26)
  expect(paneLayout(160,24,4).previewWidth).toBe(160)
  expect(paneLayout(160,24,4,false).listWidth).toBe(160)
  expect(paneLayout(160,17,4).statsWidth).toBe(0)
})
