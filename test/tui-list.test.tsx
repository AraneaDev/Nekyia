import { expect, test } from 'bun:test'
import React, { act, useEffect } from 'react'
import { homedir } from 'node:os'
import { renderToString, Text } from 'ink'
import { render } from 'ink-testing-library'
import { DEFAULT_CONFIG } from '../src/config'
import { IndexDb } from '../src/core/db'
import type { Row } from '../src/core/query'
import {
  clientColor,
  ageEmphasis,
  railThumb,
  List,
  matchSpans,
  projectColor,
  ROW_FIXED_COLUMNS,
  titleColumns,
  type ListRowProps,
  visibleWindow,
} from '../src/tui/List'
import { boundedDisplayText, type DisplayWork } from '../src/tui/text'
import { useSessions, type SessionsState } from '../src/tui/useSessions'
import type { SessionRef } from '../src/types'

const NOW = 1_800_000_000_000

function withAct(action: () => void): void {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const previous = environment.IS_REACT_ACT_ENVIRONMENT
  environment.IS_REACT_ACT_ENVIRONMENT = true
  try {
    act(action)
  } finally {
    if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT
    else environment.IS_REACT_ACT_ENVIRONMENT = previous
  }
}

function row(i: number): Row {
  return {
    uid: `claude:${i}`, client: 'claude', nativeId: String(i), cwd: '/root/proj',
    gitBranch: 'main', title: `session ${i}`, startedAt: 0, endedAt: NOW,
    turns: 1, parentNativeId: null, tier: 'resume', origin: 'manifest',
    missing: false, score: 0, collapsed: 0,
  }
}

function seed(db: IndexDb, over: Partial<SessionRef>): void {
  const ref: SessionRef = {
    ...row(0),
    sourcePaths: [],
    fingerprint: 'f',
    ...over,
  }
  db.upsertRef(ref)
  db.upsertDoc({ ref, prompts: [], prose: [], files: [], truncated: false })
}

test('visibleWindow keeps a normalized selection on screen', () => {
  expect(visibleWindow(0, 100, 10)).toEqual([0, 10])
  expect(visibleWindow(50, 100, 10)).toEqual([41, 51])
  expect(visibleWindow(99, 100, 10)).toEqual([90, 100])
  expect(visibleWindow(0, 3, 10)).toEqual([0, 3])
  expect(visibleWindow(-4, 100, 10)).toEqual([0, 10])
  expect(visibleWindow(999, 100, 10)).toEqual([90, 100])
})

test('visibleWindow safely handles empty, zero, negative, fractional and non-finite inputs', () => {
  expect(visibleWindow(0, 0, 10)).toEqual([0, 0])
  expect(visibleWindow(0, 100, 0)).toEqual([0, 0])
  expect(visibleWindow(0, 100, -2)).toEqual([0, 0])
  expect(visibleWindow(5.9, 100.8, 3.7)).toEqual([3, 6])
  expect(visibleWindow(Number.NaN, 100, 5)).toEqual([0, 5])
  expect(visibleWindow(5, Number.POSITIVE_INFINITY, 5)).toEqual([0, 0])
  expect(visibleWindow(5, 100, Number.NaN)).toEqual([0, 0])
})

test('the list mounts only O(height) row components for a large corpus', () => {
  const rows = Array.from({ length: 10_000 }, (_, i) => row(i))
  let renderedRows = 0
  function CountingRow(props: ListRowProps) {
    renderedRows++
    return <Text>{props.row.title}</Text>
  }
  const view = render(
    <List rows={rows} selected={5_000} height={7} now={NOW} rowComponent={CountingRow} />,
  )
  expect(renderedRows).toBe(7)
  expect(view.lastFrame()).toContain('session 5000')
  view.unmount()
})

test('the selected row, collapsed count and client color render', () => {
  const rows = [
    row(0),
    { ...row(1), client: 'codex', tier: 'search' as const, collapsed: 4 },
  ]
  const { lastFrame, unmount } = render(<List rows={rows} selected={1} height={5} now={NOW} />)
  const frame = lastFrame()!
  // Selection is marked in the gutter; the row itself is no longer inverted and
  // a search-tier client is dimmed rather than given a glyph of its own.
  expect(frame).toContain('▌ codex')
  // Unselected rows sit on the track; the selected row takes the rail.
  expect(frame.split('\n')[0]).toMatch(/^│ claude/)
  expect(frame).toContain('+4')
  expect(clientColor('codex')).toBe('cyan')
  expect(clientColor('unknown')).toBe('white')
  expect(frame.split('\n')).toHaveLength(2)
  unmount()

  const active: number[] = []
  function InspectingRow(props: ListRowProps) {
    if (props.active) active.push(props.index)
    return <Text>{props.row.title}</Text>
  }
  const inspected = render(
    <List rows={rows} selected={1} height={5} now={NOW} rowComponent={InspectingRow} />,
  )
  expect(active).toEqual([1])
  inspected.unmount()
})

test('empty lists render nothing and an out-of-range selection is clamped', () => {
  const empty = render(<List rows={[]} selected={10} height={5} now={NOW} />)
  expect(empty.lastFrame()).toBe('')
  empty.unmount()

  const bounded = render(<List rows={[row(0), row(1)]} selected={99} height={5} now={NOW} />)
  expect(bounded.lastFrame()?.split('\n')).toHaveLength(2)
  bounded.unmount()
})

test('long Unicode titles stay on one terminal row and respect terminal width', () => {
  const rows = [{ ...row(0), title: '🧪界'.repeat(200) }]
  const frame = renderToString(<List rows={rows} selected={0} height={1} now={NOW} />, { columns: 40 })
  expect(frame.split('\n')).toHaveLength(1)
  expect(Bun.stringWidth(frame)).toBeLessThanOrEqual(40)
})

test('terminal controls in display fields cannot escape the virtualized row', () => {
  const rows = [{ ...row(0), cwd: '/root/bad\nproject', title: 'hello\n\u001b[31mred' }]
  const frame = renderToString(<List rows={rows} selected={0} height={1} now={NOW} />, { columns: 80 })
  expect(frame.split('\n')).toHaveLength(1)
  expect(frame).not.toContain('\u001b')
})

test('huge titles are bounded before grapheme and terminal-width processing', () => {
  const huge = `title start ${'x'.repeat(25 * 1024 * 1024)} unreachable end`
  const work: DisplayWork = { sampledCodeUnits: 0, graphemes: 0 }
  const title = boundedDisplayText(huge, 60, work)

  expect(work.sampledCodeUnits).toBeLessThanOrEqual(60 * 8 + 8)
  expect(work.graphemes).toBeLessThanOrEqual(60)
  expect(title).toStartWith('title start ')
  expect(title).not.toContain('unreachable end')
  expect(Bun.stringWidth(title)).toBeLessThanOrEqual(60)

  const frame = renderToString(
    <List rows={[{ ...row(0), title: huge }]} selected={0} height={1} now={NOW} />,
    { columns: 80 },
  )
  expect(frame).toContain('title start ')
  expect(frame).not.toContain('unreachable end')
  expect(Bun.stringWidth(frame)).toBeLessThanOrEqual(80)
})

test('oversized client and cwd fields are bounded before Ink sees them', () => {
  const hugeClient = `codexxxxx${'c'.repeat(1024 * 1024)} client tail`
  const hugeCwd = `project-start-${'p'.repeat(1024 * 1024)}-project-tail`
  const frame = renderToString(
    <List
      rows={[{ ...row(0), client: hugeClient, cwd: hugeCwd, title: 'safe title' }]}
      selected={0}
      height={1}
      now={NOW}
    />,
    { columns: 80 },
  )

  expect(frame).toContain('codexxxxx')
  expect(frame).toContain('…')
  expect(frame).toContain('safe title')
  expect(Bun.stringWidth(frame)).toBeLessThanOrEqual(80)
})

test('bidi formatting controls are stripped from every untrusted display field', () => {
  const bidi = '\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u206a\u206f'
  const unsafe = {
    ...row(0),
    client: `co\u202edex`,
    cwd: `/root/pro\u2066ject\u2069`,
    title: `alpha${bidi}omega`,
  }
  const frame = renderToString(<List rows={[unsafe]} selected={0} height={1} now={NOW} />, { columns: 80 })

  for (const control of bidi) expect(frame).not.toContain(control)
  expect(frame).toContain('codex')
  expect(frame).toContain('project')
  expect(frame).toContain('alphaomega')
  expect(frame.indexOf('codex')).toBeLessThan(frame.indexOf('project'))
  expect(frame.indexOf('project')).toBeLessThan(frame.indexOf('alphaomega'))
})

test('useSessions composes text, scope and client filters and resets selection', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:one', nativeId: 'one', title: 'needle', cwd: '/root/proj' })
  seed(db, { uid: 'codex:two', client: 'codex', nativeId: 'two', title: 'needle', cwd: '/else' })
  seed(db, { uid: 'claude:three', nativeId: 'three', title: 'other', cwd: '/root/proj' })

  let state: SessionsState | undefined
  function Harness() {
    const current = useSessions(db, DEFAULT_CONFIG, '/root/proj')
    useEffect(() => { state = current })
    return null
  }
  const view = render(<Harness />)
  expect(state?.rows.map((item) => item.uid).sort()).toEqual(['claude:one', 'claude:three'])

  withAct(() => state?.setSelected(1))
  withAct(() => state?.setText('needle'))
  expect(state?.selected).toBe(0)
  expect(state?.rows.map((item) => item.uid)).toEqual(['claude:one'])

  withAct(() => state?.setScope(null))
  withAct(() => state?.setClient('codex'))
  expect(state?.selected).toBe(0)
  expect(state?.rows.map((item) => item.uid)).toEqual(['codex:two'])

  // Tab narrows to the project of the row under the cursor, not to a fixed
  // directory, so it follows what is on screen.
  withAct(() => state?.toggleScope())
  expect(state?.scope).toBe('/else')
  expect(state?.rows.map((item) => item.uid)).toEqual(['codex:two'])

  // Pressing it again widens back to the whole index.
  withAct(() => state?.toggleScope())
  expect(state?.scope).toBeNull()
  view.unmount()
  db.close()
})

function mountSessions(db: IndexDb, cwd: string, cfg = DEFAULT_CONFIG) {
  let state: SessionsState | undefined
  function Harness() {
    const current = useSessions(db, cfg, cwd)
    useEffect(() => { state = current })
    return null
  }
  const view = render(<Harness />)
  return { view, read: () => state! }
}

test('the client cycle holds only clients the index has, and always offers all of them', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'opencode:one', client: 'opencode', nativeId: 'one', cwd: '/root/proj' })
  seed(db, { uid: 'claude:one', nativeId: 'one', cwd: '/root/proj' })

  const { view, read } = mountSessions(db, '/root/proj')
  // No entry for the built-in clients this machine has never used: every step
  // lands on a filter that has something behind it.
  expect(read().clientCycle).toEqual([undefined, 'claude', 'opencode'])

  const seen: (string | undefined)[] = []
  for (let press = 0; press < 4; press++) {
    withAct(() => read().cycleClient())
    seen.push(read().client)
  }
  // Undefined leads, so the way back to an unfiltered list is always one more
  // press rather than a filter you cannot get out of.
  expect(seen).toEqual(['claude', 'opencode', undefined, 'claude'])
  expect(read().rows.map((item) => item.uid)).toEqual(['claude:one'])

  view.unmount()
  db.close()
})

test('a hidden client is left out of the cycle it could only ever show nothing for', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:one', nativeId: 'one', cwd: '/root/proj' })
  seed(db, { uid: 'codex:one', client: 'codex', nativeId: 'one', cwd: '/root/proj' })

  const cfg = { ...DEFAULT_CONFIG, hiddenClients: ['codex'] }
  const { view, read } = mountSessions(db, '/root/proj', cfg)
  expect(read().clientCycle).toEqual([undefined, 'claude'])
  view.unmount()
  db.close()
})

test('an index with nothing in it still cycles instead of getting stuck', () => {
  const db = IndexDb.open(':memory:')
  const { view, read } = mountSessions(db, '/root/proj')
  expect(read().clientCycle).toEqual([undefined])
  withAct(() => read().cycleClient())
  expect(read().client).toBeUndefined()
  expect(read().rows).toEqual([])
  view.unmount()
  db.close()
})

test('a client filter the cycle no longer holds steps back to all clients', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:one', nativeId: 'one', cwd: '/root/proj' })
  const { view, read } = mountSessions(db, '/root/proj')
  // The state a filter is left in when the sessions behind it are removed.
  withAct(() => read().setClient('codex'))
  expect(read().rows).toEqual([])
  withAct(() => read().cycleClient())
  expect(read().client).toBeUndefined()
  expect(read().rows.map((item) => item.uid)).toEqual(['claude:one'])
  view.unmount()
  db.close()
})

test('the picker opens scoped to a project it has sessions for', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:one', nativeId: 'one', cwd: '/root/proj' })
  seed(db, { uid: 'claude:two', nativeId: 'two', cwd: '/elsewhere' })
  const { view, read } = mountSessions(db, '/root/proj')
  expect(read().scope).toBe('/root/proj')
  expect(read().rows.map((item) => item.uid)).toEqual(['claude:one'])
  view.unmount()
  db.close()
})

test('a subdirectory of a project it has sessions for opens scoped as well', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:one', nativeId: 'one', cwd: '/root/proj/src/deep' })
  const { view, read } = mountSessions(db, '/root/proj')
  expect(read().scope).toBe('/root/proj')
  expect(read().rows.map((item) => item.uid)).toEqual(['claude:one'])
  view.unmount()
  db.close()
})

test('the home directory opens on the whole index, sessions of its own or not', () => {
  const db = IndexDb.open(':memory:')
  const home = homedir()
  seed(db, { uid: 'claude:home', nativeId: 'home', cwd: home })
  seed(db, { uid: 'claude:proj', nativeId: 'proj', cwd: '/root/proj' })
  // Scoping here would hide every project under it, and the home directory is
  // where the fewest sessions are actually worked on.
  const { view, read } = mountSessions(db, home)
  expect(read().scope).toBeNull()
  expect(read().rows.map((item) => item.uid).sort()).toEqual(['claude:home', 'claude:proj'])
  view.unmount()
  db.close()
})

test('a filesystem root opens on the whole index rather than on everything below it', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:one', nativeId: 'one', cwd: '/root/proj' })
  // Every session is under "/", so only the root rule can widen this one.
  const { view, read } = mountSessions(db, '/')
  expect(read().scope).toBeNull()
  view.unmount()

  // A Windows-shaped root reaches a POSIX build through a config or a test, and
  // is recognised rather than treated as an ordinary directory.
  const drive = mountSessions(db, 'C:\\')
  expect(drive.read().scope).toBeNull()
  drive.view.unmount()
  db.close()
})

test('a directory with nothing indexed under it opens on the whole index', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:one', nativeId: 'one', cwd: '/root/proj' })
  // A fresh clone, or a project that has never been indexed: an empty picker is
  // never the useful answer.
  const { view, read } = mountSessions(db, '/root/unindexed')
  expect(read().scope).toBeNull()
  expect(read().rows.map((item) => item.uid)).toEqual(['claude:one'])

  // Tab still narrows from there, to the project of the row under the cursor.
  withAct(() => read().toggleScope())
  expect(read().scope).toBe('/root/proj')
  view.unmount()
  db.close()
})

test('a directory whose only sessions are hidden opens on the whole index', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'codex:one', client: 'codex', nativeId: 'one', cwd: '/root/proj' })
  seed(db, { uid: 'claude:one', nativeId: 'one', cwd: '/elsewhere' })
  // The starting scope is decided by the query the list runs, so a directory
  // whose rows are all filtered out counts as having nothing indexed under it.
  const cfg = { ...DEFAULT_CONFIG, hiddenClients: ['codex'] }
  const { view, read } = mountSessions(db, '/root/proj', cfg)
  expect(read().scope).toBeNull()
  view.unmount()
  db.close()
})

test('useSessions clamps selection after filtering and move is stable and empty-safe', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:one', nativeId: 'one', title: 'one', cwd: '/root/proj' })
  seed(db, { uid: 'claude:two', nativeId: 'two', title: 'two', cwd: '/root/proj' })
  let state: SessionsState | undefined
  function Harness() {
    const current = useSessions(db, DEFAULT_CONFIG, '/root/proj')
    useEffect(() => { state = current })
    return null
  }
  const view = render(<Harness />)
  const firstMove = state!.move
  const firstSetText = state!.setText
  const firstSetScope = state!.setScope
  const firstToggleScope = state!.toggleScope
  const firstSetClient = state!.setClient
  const firstSetSelected = state!.setSelected
  withAct(() => state?.setSelected(99))
  expect(state?.selected).toBe(1)
  withAct(() => state?.move(-1))
  expect(state?.selected).toBe(0)
  withAct(() => state?.setText('absent'))
  expect(state?.rows).toEqual([])
  withAct(() => state?.move(1))
  expect(state?.selected).toBe(0)
  expect(state?.move).toBe(firstMove)
  expect(state?.setText).toBe(firstSetText)
  expect(state?.setScope).toBe(firstSetScope)
  expect(state?.toggleScope).toBe(firstToggleScope)
  expect(state?.setClient).toBe(firstSetClient)
  expect(state?.setSelected).toBe(firstSetSelected)
  view.unmount()
  db.close()
})

test('equivalent config identities do not rerun the query', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:one', nativeId: 'one', cwd: '/root/proj' })
  const originalSearchRefs = db.searchRefs.bind(db)
  let sessionSelects = 0
  db.searchRefs = (() => {
    sessionSelects++
    return originalSearchRefs()
  }) as typeof db.searchRefs

  let rerender: (() => void) | undefined
  let rows: ReturnType<typeof useSessions>['rows'] | undefined
  function Harness() {
    const [, setTick] = React.useState(0)
    rerender = () => setTick((tick) => tick + 1)
    rows = useSessions(db, { ...DEFAULT_CONFIG, hiddenClients: [] }, '/root/proj').rows
    return null
  }
  const view = render(<Harness />)
  expect(sessionSelects).toBe(1)
  const before = rows
  withAct(() => rerender?.())
  // The picker holds one snapshot for its lifetime, so counting reads of the
  // session table no longer tells us whether the query itself reran. A rerun
  // builds a fresh array, so identity is what actually discriminates here.
  expect(rows).toBe(before)
  expect(sessionSelects).toBe(1)
  view.unmount()
  db.close()
})

test('the title column grows with the pane instead of a fixed 60', () => {
  // 92 was the old row width: 32 fixed columns plus a hardcoded 60 for the title.
  expect(titleColumns(ROW_FIXED_COLUMNS + 60)).toBe(60)
  expect(titleColumns(200)).toBe(200 - ROW_FIXED_COLUMNS)
  expect(titleColumns(120)).toBe(120 - ROW_FIXED_COLUMNS)
  // Narrow panes keep a readable floor rather than collapsing to nothing.
  expect(titleColumns(10)).toBe(8)
  expect(titleColumns(0)).toBe(8)
  expect(titleColumns(Number.NaN)).toBe(8)
})

test('a wide list renders titles past the old 92 column row', () => {
  const wide: Row = { ...row(0), title: 'y'.repeat(300) }
  const view = render(<List rows={[wide]} selected={0} height={1} now={NOW} columns={300} />)
  const rendered = view.lastFrame()!.split('\n').find((line) => line.includes('y'))!
  expect(rendered.length).toBeGreaterThan(92)
  view.unmount()
})

test('a match is split out of the title so it can be lit', () => {
  expect(matchSpans('fix the retry budget', 'retry')).toEqual(['fix the ', 'retry', ' budget'])
  // Case folds, because the query is typed and the title is not.
  expect(matchSpans('Fix the RETRY budget', 'retry')).toEqual(['Fix the ', 'RETRY', ' budget'])
  // Only the first occurrence: this shows the list reacting, not full markup.
  expect(matchSpans('retry the retry', 'retry')).toEqual(['', 'retry', ' the retry'])
  // No query, or no hit, leaves the title in one piece.
  expect(matchSpans('fix the retry budget', '')).toEqual(['fix the retry budget', '', ''])
  expect(matchSpans('fix the retry budget', '   ')).toEqual(['fix the retry budget', '', ''])
  expect(matchSpans('fix the retry budget', 'absent')).toEqual(['fix the retry budget', '', ''])
})

test('a title whose case does not fold one-to-one is still cut where the match is', () => {
  // 'İ' is one code unit and lowercases to two, so a search run over a
  // lowercased copy hands back offsets that no longer line up with the title.
  expect(matchSpans('İstanbul deploy retry', 'retry'))
    .toEqual(['İstanbul deploy ', 'retry', ''])
  // The same drift used to land mid-surrogate, splitting one emoji across two
  // Text nodes with different colours: two replacement glyphs, one column wide.
  expect(matchSpans('İ😀x', '😀')).toEqual(['İ', '😀', 'x'])
  // Whatever is cut out is exactly what was there: the three spans rebuild the
  // title, which is the property a drifting offset breaks.
  for (const [title, needle] of [
    ['İstanbul deploy retry', 'retry'], ['İ😀x', '😀'], ['ẞtraße retry', 'RETRY'],
  ] as [string, string][]) {
    expect(matchSpans(title, needle).join('')).toBe(title)
  }
  // A query full of regex metacharacters is matched as the text it is.
  expect(matchSpans('fix a.*b now', 'a.*b')).toEqual(['fix ', 'a.*b', ' now'])
  expect(matchSpans('fix aXXb now', 'a.*b')).toEqual(['fix aXXb now', '', ''])
})

test('age reads as a gradient from today to long ago', () => {
  const hour = 3_600_000
  expect(ageEmphasis(NOW - hour, NOW)).toEqual({ dim: false, bold: true })
  expect(ageEmphasis(NOW - 3 * 24 * hour, NOW)).toEqual({ dim: false, bold: false })
  expect(ageEmphasis(NOW - 30 * 24 * hour, NOW)).toEqual({ dim: true, bold: false })
  expect(ageEmphasis(Number.NaN, NOW)).toEqual({ dim: true, bold: false })
})

test('a project keeps one colour and never borrows the unknown-client white', () => {
  const first = projectColor('api-gateway')
  expect(first).toBeDefined()
  expect(projectColor('api-gateway')).toBe(first)
  expect(projectColor('billing-svc')).toBeDefined()
  // A missing project is left uncoloured rather than given a hue that means nothing.
  expect(projectColor('-')).toBeUndefined()
  expect(projectColor('')).toBeUndefined()
  for (const name of ['a', 'infra', 'web-console', 'search-svc', 'x'.repeat(40)]) {
    expect(projectColor(name)).not.toBe('white')
  }
})

test('the rail shows where the visible rows fall in the whole list', () => {
  // A list that fits has nothing to scroll, so the track is whole.
  expect(railThumb(0, 10, 10)).toEqual([0, 10])
  expect(railThumb(0, 10, 3)).toEqual([0, 10])

  // At the top the thumb starts at the top; at the bottom it ends at the bottom.
  expect(railThumb(0, 10, 100)[0]).toBe(0)
  expect(railThumb(90, 10, 100)[1]).toBe(10)

  // It never leaves the track, whatever it is asked.
  for (const [start, visible, total] of [
    [0, 1, 1000], [500, 20, 1000], [999, 20, 1000], [-5, 10, 100], [10_000, 10, 100],
  ] as const) {
    const [from, to] = railThumb(start, visible, total)
    expect(from).toBeGreaterThanOrEqual(0)
    expect(to).toBeLessThanOrEqual(visible)
    expect(to).toBeGreaterThan(from)
  }

  // A very long list still leaves a thumb you can see rather than a stray mark.
  const [from, to] = railThumb(0, 20, 5000)
  expect(to - from).toBeGreaterThanOrEqual(2)
  // Unless there is barely any track to put it in.
  expect(railThumb(0, 1, 5000)).toEqual([0, 1])
  expect(railThumb(0, 0, 100)).toEqual([0, 0])
})
