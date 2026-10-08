import {expect, test} from 'bun:test'
import {clearedFilters, restoreSelection, resolveCustomTime} from '../src/tui/state'
import {paneLayout} from '../src/tui/layout'
import {emptySuggestions} from '../src/tui/empty-state'
import {actionsFor} from '../src/tui/actions.js'

test('restore follows UID and clamps removed selection', () => {
  expect(restoreSelection(['b', 'a'], 'a', 0)).toBe(1)
  expect(restoreSelection(['b', 'c'], 'gone', 9)).toBe(1)
  expect(restoreSelection([], 'gone', 9)).toBe(0)
})
test('custom bounds resolve UTC and reject inverted intervals', () => {
  expect(resolveCustomTime('2026-10-01', '2026-10-08', 0).range)
    .toEqual({since: Date.UTC(2026, 9, 1), until: Date.UTC(2026, 9, 8)})
  expect(() => resolveCustomTime('2026-10-08', '2026-10-01', 0)).toThrow()
  expect(clearedFilters().scope).toBeNull()
})
test('responsive sizes have correct thresholds and bounded geometry', () => {
  expect(paneLayout(120,18,3).mode).toBe('stack')
  expect(paneLayout(119,18,3).mode).toBe('stack')
  expect(paneLayout(160,8,3).mode).toBe('compact')
  for (const columns of [40,60,80,120,160]) for (const rows of [8,12,16,24,40]) {
    const layout = paneLayout(columns,rows,3)
    expect(layout.bodyRows).toBe(rows-3)
    expect(layout.listWidth+(layout.statsWidth?layout.statsWidth+2:0)).toBe(columns)
    expect(layout.previewWidth).toBe(columns)
  }
})
test('empty suggestions preserve state and deduplicate positive alternatives', () => {
  const state = {text:'needle',filters:{...clearedFilters(),time:{kind:'preset',preset:'7d'} as const}}
  const suggestions = emptySuggestions(state,(text,filters)=>text==='needle'&&filters.time.kind==='preset'&&filters.time.preset==='all'?2:0)
  expect(suggestions.map(item=>item.label)).toEqual(['Clear time'])
  expect(state.filters.time.preset).toBe('7d')
})
test('actions name native resume and explain unavailability',()=>{
  const resume=actionsFor({hasSelection:true,canResume:false,resumeReason:'Launcher not installed',canHandoff:false,handoffReason:'No target',hasMatch:false,hasPrompt:false,hasCommand:false,bookmarked:false,hasQuery:false,refreshing:false}).find(item=>item.id==='resume')!
  expect(resume.label).toBe('Resume session')
  expect(resume.enabled).toBe(false)
  expect(resume.reason).toBe('Launcher not installed')
})
