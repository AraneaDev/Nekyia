import { expect, test } from 'bun:test'
import React, { act, useEffect } from 'react'
import { Text } from 'ink'
import { render } from 'ink-testing-library'
import { DEFAULT_CONFIG } from '../src/config'
import { IndexDb } from '../src/core/db'
import { presetTimeRange } from '../src/core/time-range'
import { useSessions, type SessionsState } from '../src/tui/useSessions'
import { clearedFilters, type PickerRestore } from '../src/tui/state'
import type { SessionRef } from '../src/types'

function withAct(action: () => void): void {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = environment.IS_REACT_ACT_ENVIRONMENT
  environment.IS_REACT_ACT_ENVIRONMENT = true
  try { act(action) } finally {
    if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT
    else environment.IS_REACT_ACT_ENVIRONMENT = previous
  }
}
function fixture() {
  const db = IndexDb.open(':memory:')
  const before = new Date(2026, 9, 8, 23, 59).getTime()
  const after = new Date(2026, 9, 9, 0, 5).getTime()
  for (const [uid, time] of [['yesterday', before - 60_000], ['today', after - 60_000]] as const) {
    const ref: SessionRef = { uid, client: 'claude', nativeId: uid, cwd: null, gitBranch: null, title: uid, startedAt: time, endedAt: time, turns: 1, parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: [], fingerprint: 'x' }
    db.upsertRef(ref)
  }
  let clockNow = before, state!: SessionsState
  const initial: PickerRestore = { text: '', filters: { ...clearedFilters(), time: { kind: 'preset', preset: 'today' } }, selectedUid: null, selectedIndex: 0, listTop: 0, reader: null }
  function Harness() {
    const value = useSessions(db, DEFAULT_CONFIG, '/', undefined, before, initial, undefined, () => clockNow)
    useEffect(() => { state = value }, [value])
    return <Text>{value.rows.map(row => row.uid).join(',')}</Text>
  }
  const view = render(<Harness />)
  return { db, before, after, initial, get state() { return state }, view, advance: () => { clockNow = after } }
}
test('explicit Apply recaptures Today across midnight while ordinary search keeps captured range', () => {
  const f = fixture()
  try {
    expect(f.state.rows.map(row => row.uid)).toEqual(['yesterday'])
    f.advance()
    withAct(() => f.state.setText(''))
    expect(f.state.rows.map(row => row.uid)).toEqual(['yesterday'])
    withAct(() => f.state.applyFilters({ ...f.state.filters, time: { kind: 'preset', preset: 'today' } }))
    expect(f.state.rows.map(row => row.uid)).toEqual(['today'])
    expect(f.state.activeTimeRange).toEqual(presetTimeRange('today', f.after))
  } finally { f.view.unmount(); f.db.close() }
})
test('cycle and clear capture the explicit selection clock and expose matching active bounds', () => {
  const f = fixture()
  try {
    f.advance()
    withAct(() => f.state.cycleTimePreset())
    expect(f.state.timePreset).toBe('yesterday')
    expect(f.state.rows.map(row => row.uid)).toEqual(['yesterday'])
    expect(f.state.activeTimeRange).toEqual(presetTimeRange('yesterday', f.after))
    withAct(() => f.state.clearTimePreset())
    expect(f.state.activeTimeRange).toEqual({})
    expect(f.state.rows).toHaveLength(2)
  } finally { f.view.unmount(); f.db.close() }
})
test('resolved custom bounds remain fixed when clock advances or another filter applies', () => {
  const f = fixture()
  const range = { since: f.before - 120_000, until: f.before }
  try {
    withAct(() => f.state.applyFilters({ ...f.state.filters, time: { kind: 'custom', range, sinceText: '2m', untilText: '' } }))
    f.advance()
    withAct(() => f.state.applyFilters({ ...f.state.filters, sort: 'recent' }))
    expect(f.state.rows.map(row => row.uid)).toEqual(['yesterday'])
    expect(f.state.activeTimeRange).toEqual(range)
  } finally { f.view.unmount(); f.db.close() }
})
