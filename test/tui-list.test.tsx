import { expect, test } from 'bun:test'
import React, { act, useEffect } from 'react'
import { renderToString, Text } from 'ink'
import { render } from 'ink-testing-library'
import { DEFAULT_CONFIG } from '../src/config'
import { IndexDb } from '../src/core/db'
import type { Row } from '../src/core/query'
import {
  boundedDisplayText,
  clientColor,
  List,
  ROW_FIXED_COLUMNS,
  titleColumns,
  type DisplayWork,
  type ListRowProps,
  visibleWindow,
} from '../src/tui/List'
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
    sourcePaths: [], fingerprint: '', missing: false, score: 0, collapsed: 0,
  }
}

function seed(db: IndexDb, over: Partial<SessionRef>): void {
  const ref: SessionRef = {
    ...row(0),
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

test('the selected row, collapsed count, client color and tier glyph render', () => {
  const rows = [
    row(0),
    { ...row(1), client: 'codex', tier: 'search' as const, collapsed: 4 },
  ]
  const { lastFrame, unmount } = render(<List rows={rows} selected={1} height={5} now={NOW} />)
  const frame = lastFrame()!
  expect(frame).toContain('o codex')
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

test('the display bound keeps whole Unicode graphemes at the column edge', () => {
  const family = '👨‍👩‍👧‍👦'
  const output = boundedDisplayText(family.repeat(100), 10)
  expect(output).toBe(family.repeat(5))
  expect(Bun.stringWidth(output)).toBe(10)
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

  withAct(() => state?.setScope('all'))
  withAct(() => state?.setClient('codex'))
  expect(state?.selected).toBe(0)
  expect(state?.rows.map((item) => item.uid)).toEqual(['codex:two'])

  withAct(() => state?.toggleScope())
  expect(state?.scope).toBe('cwd')
  expect(state?.rows).toEqual([])
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
  const raw = db.raw()
  const originalQuery = raw.query.bind(raw)
  let sessionSelects = 0
  raw.query = ((sql: string) => {
    if (sql === 'SELECT * FROM session') sessionSelects++
    return originalQuery(sql)
  }) as typeof raw.query

  let rerender: (() => void) | undefined
  function Harness() {
    const [, setTick] = React.useState(0)
    rerender = () => setTick((tick) => tick + 1)
    useSessions(db, { ...DEFAULT_CONFIG, hiddenClients: [] }, '/root/proj')
    return null
  }
  const view = render(<Harness />)
  expect(sessionSelects).toBe(1)
  withAct(() => rerender?.())
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
