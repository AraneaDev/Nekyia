import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IndexDb } from '../src/core/db'
import { DEFAULT_CONFIG } from '../src/config'
import { runPick, type PickDependencies } from '../src/commands/pick'
import type { AppProps } from '../src/tui/App'
import { clearedFilters, restoreSelection, type PickerRestore } from '../src/tui/state'
import type { SessionRef } from '../src/types'
import { query } from '../src/core/query'

function ref(uid: string): SessionRef {
  return { uid, client: 'claude', nativeId: uid, cwd: '/project', gitBranch: 'main', title: uid, startedAt: 1, endedAt: 2, turns: 1, parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: [], fingerprint: 'x' }
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'nekyia-refresh-'))
  const path = join(dir, 'index.db')
  const writer = IndexDb.open(path)
  writer.upsertRef(ref('selected')); writer.upsertRef(ref('reader')); writer.close()
  const snapshots: AppProps[] = [], messages: string[] = [], events: string[] = []
  const state: PickerRestore = { text: 'retry ten', filters: { ...clearedFilters(), scope: '/project', branch: 'main', file: { path: 'file.ts', exact: true }, bookmarkedOnly: true }, selectedUid: 'selected', selectedIndex: 3, listTop: 2, reader: { anchor: { uid: 'reader', ordinal: 90, offset: 5, fallbackLine: 8 }, findText: 'needle', hitIndex: 2 } }
  let now = 5000
  const deps: PickDependencies = {
    isTTY: () => true, needsConsent: () => false, indexExists: () => true,
    indexPath: () => path, indexedAt: () => 100, loadConfig: () => DEFAULT_CONFIG,
    buildAdapters: () => ({ adapters: [], diagnostics: [] }), cwd: () => '/project', now: () => now,
    openDb: value => { events.push('open'); return IndexDb.openReadonly(value) },
    mount: props => {
      snapshots.push(props)
      const first = snapshots.length === 1
      return { waitUntilExit: async () => {
        if (first) { props.onStateChange?.(state); props.onReindex?.() }
      }, unmount: () => { events.push('unmount') } }
    },
    ensureIndex: async () => { now = 9000; events.push('refresh'); return 0 },
    checkPlan: () => { throw new Error('must not launch') }, runPlan: async () => { throw new Error('must not launch') },
    error: value => { messages.push(value) },
  }
  return { deps, path, snapshots, messages, events, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

for (const age of [undefined, -1, 3_599_999, 3_600_000, 7_200_000]) {
  test(`startup refreshes at one hour with default config (age ${age})`, async () => {
    const fixture = setup()
    const now = 36_000_000
    try {
      fixture.deps.now = () => now
      fixture.deps.indexedAt = () => age === undefined ? undefined : now - age
      fixture.deps.mount = props => {
        fixture.snapshots.push(props)
        return { waitUntilExit: async () => {}, unmount: () => {} }
      }
      expect(await runPick(fixture.deps)).toBe(0)
      const stale = age !== undefined && age >= 3_600_000
      expect(fixture.events.filter(event => event === 'refresh')).toHaveLength(stale ? 1 : 0)
      expect(fixture.snapshots[0]!.indexedAt).toBe(stale ? now : age === undefined ? undefined : now - age)
    } finally { fixture.cleanup() }
  })
}
test('refresh carries exact UID, committed filters, query, list window and reader into new connection', async () => {
  const fixture = setup()
  try {
    expect(await runPick(fixture.deps)).toBe(0)
    expect(fixture.snapshots).toHaveLength(2)
    expect(fixture.snapshots[1]!.initialState).toEqual(fixture.state)
    expect(fixture.snapshots[1]!.db).not.toBe(fixture.snapshots[0]!.db)
    expect(fixture.snapshots.map(props => props.indexedAt)).toEqual([100, 9000])
    expect(fixture.snapshots.map(props => props.now)).toEqual([5000, 9000])
    expect(fixture.events).toEqual(['open', 'unmount', 'refresh', 'open', 'unmount'])
  } finally { fixture.cleanup() }
})
for (const failure of ['code', 'throw'] as const) {
  test(`failed refresh (${failure}) reopens readable index with state and honest old age`, async () => {
    const fixture = setup()
    try {
      fixture.deps.ensureIndex = async () => {
        if (failure === 'throw') throw new Error('disk full\x1b')
        return 2
      }
      expect(await runPick(fixture.deps)).toBe(0)
      expect(fixture.snapshots).toHaveLength(2)
      expect(fixture.snapshots[1]!.initialState).toEqual(fixture.state)
      expect(fixture.snapshots[1]!.initialNotice).toMatch(/refresh.*failed.*existing index/i)
      expect(fixture.snapshots[1]!.initialNotice).not.toContain('\x1b')
      expect(fixture.snapshots.map(props => props.indexedAt)).toEqual([100, 100])
      expect(fixture.messages).toEqual([])
    } finally { fixture.cleanup() }
  })
}
test('failed refresh with no readable index returns failure after recovery attempt', async () => {
  const fixture = setup()
  try {
    fixture.deps.ensureIndex = async () => { rmSync(fixture.path); throw new Error('disk full') }
    expect(await runPick(fixture.deps)).toBe(1)
    expect(fixture.snapshots).toHaveLength(1)
    expect(fixture.messages.join(' ')).toMatch(/refresh.*disk full/i)
    expect(fixture.messages.join(' ')).toMatch(/reopen|readable/i)
  } finally { fixture.cleanup() }
})
test('removed reader returns to original browse selection with explanation', async () => {
  const fixture = setup()
  try {
    fixture.deps.ensureIndex = async () => {
      const db = IndexDb.open(fixture.path, false); db.deleteSession('reader'); db.close(); return 0
    }
    expect(await runPick(fixture.deps)).toBe(0)
    expect(fixture.snapshots[1]!.initialState).toEqual({ ...fixture.state, reader: null })
    expect(fixture.snapshots[1]!.initialNotice).toMatch(/reader.*no longer|history.*unavailable/i)
  } finally { fixture.cleanup() }
})
test('relative presets receive refreshed clock and custom resolved bounds stay fixed', async () => {
  for (const time of [
    { kind: 'preset', preset: '7d' } as const,
    { kind: 'custom', range: { since: 20, until: 40 }, sinceText: '7d', untilText: '2026-10-08' } as const,
  ]) {
    const fixture = setup()
    fixture.state.filters.time = time
    try {
      expect(await runPick(fixture.deps)).toBe(0)
      expect(fixture.snapshots[1]!.initialState?.filters.time).toEqual(time)
      expect(fixture.snapshots[1]!.now).toBe(9000)
    } finally { fixture.cleanup() }
  }
})

test('unreadable index age remains a controlled lifecycle failure with database cleanup', async () => {
  const fixture = setup()
  try {
    fixture.deps.indexedAt = () => { throw new Error('age unavailable') }
    expect(await runPick(fixture.deps)).toBe(1)
    expect(fixture.messages.join(' ')).toContain('age unavailable')
  } finally { fixture.cleanup() }
})


test('reordered selected UID restores identity and removed UID falls back to nearest result', async () => {
  for (const removed of [false, true]) {
    const fixture = setup()
    fixture.state.reader = null
    fixture.state.filters = clearedFilters()
    fixture.state.text = ''
    try {
      fixture.deps.ensureIndex = async () => {
        const db = IndexDb.open(fixture.path, false)
        db.upsertRef({ ...ref('newest'), endedAt: 8000 })
        if (removed) db.deleteSession('selected')
        else db.upsertRef({ ...ref('selected'), endedAt: 5000 })
        db.close()
        return 0
      }
      const originalMount = fixture.deps.mount
      fixture.deps.mount = props => {
        if (props.initialState) {
          const uids = query(props.db, DEFAULT_CONFIG, { sort: 'recent' }).map(row => row.uid)
          const restored = restoreSelection(uids, props.initialState.selectedUid, props.initialState.selectedIndex)
          expect(restored).toBe(1)
          expect(uids[restored]).toBe(removed ? 'reader' : 'selected')
          if (removed) expect(props.initialNotice).toContain('Selected session no longer matches')
        }
        return originalMount(props)
      }
      expect(await runPick(fixture.deps)).toBe(0)
    } finally { fixture.cleanup() }
  }
})
