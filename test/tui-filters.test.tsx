import { afterEach, expect, test } from 'bun:test'
import React from 'react'
import { cleanup, render } from 'ink-testing-library'
import { Filters } from '../src/tui/Filters'
import { clearedFilters, type PickerFilters } from '../src/tui/state'

const tick = () => new Promise(resolve => setTimeout(resolve, 15))
afterEach(cleanup)

async function choose(view: ReturnType<typeof render>, label: string) {
  for (let i = 0; i < 40; i++) {
    if (view.lastFrame()?.split('\n').some(line => line.includes(`▸ ${label}`))) return
    view.stdin.write('\x1b[B')
    await tick()
  }
  throw new Error(`Could not select ${label}: ${view.lastFrame()}`)
}

function fixture(value = clearedFilters(), rows = 24, columns = 90, now = Date.UTC(2026, 9, 8, 12)) {
  const applied: PickerFilters[] = []
  let closed = 0
  const props = { value, now, cwd: '/work/project', clients: ['claude', 'codex'], branches: ['main', null], rows, columns, onApply: (next: PickerFilters) => { applied.push(next) }, onClose: () => { closed++ } }
  const view = render(<Filters {...props} />)
  return { view, applied, props, closed: () => closed }
}

test('draft edits only commit once on Apply and Cancel preserves the supplied filters', async () => {
  const value = clearedFilters()
  const { view, applied, closed } = fixture(value)
  await tick()
  view.stdin.write('\r'); await tick()
  expect(view.lastFrame()).toContain('/work/project')
  expect(applied).toEqual([])
  expect(value.scope).toBeNull()
  await choose(view, 'Apply')
  view.stdin.write('\r'); await tick()
  expect(applied).toHaveLength(1)
  expect(applied[0]?.scope).toBe('/work/project')
  expect(closed()).toBe(1)
  view.unmount()
  const cancelled = fixture(value)
  await tick(); cancelled.view.stdin.write('\r'); await tick(); cancelled.view.stdin.write('\x1b'); await new Promise(resolve => setTimeout(resolve, 80))
  expect(cancelled.applied).toEqual([])
  expect(cancelled.closed()).toBe(1)
})

test('client, sorting, branch, file mode and bookmarks have independent editable controls', async () => {
  const { view, applied } = fixture()
  await tick()
  await choose(view, 'Client:'); view.stdin.write('\r'); await tick()
  await choose(view, 'Sort:'); view.stdin.write('\r'); await tick()
  await choose(view, 'Branch:'); view.stdin.write('\r'); await tick()
  await choose(view, 'File:'); view.stdin.write('src/main.ts'); await tick()
  await choose(view, 'File matching:'); view.stdin.write('\r'); await tick()
  await choose(view, 'Bookmarks:'); view.stdin.write('\r'); await tick()
  await choose(view, 'Apply'); view.stdin.write('\r'); await tick()
  expect(applied[0]).toEqual({ ...clearedFilters(), client: 'claude', sort: 'recent', branch: 'main', file: { path: 'src/main.ts', exact: true }, bookmarkedOnly: true })
})

test('individual resets preserve other drafts and Clear all filters resets the complete draft', async () => {
  const value: PickerFilters = { ...clearedFilters(), scope: '/repo', client: 'codex', branch: null, file: { path: 'one.ts', exact: true }, bookmarkedOnly: true }
  const { view, applied } = fixture(value, 8, 48)
  await tick()
  await choose(view, 'Client:')
  expect(view.lastFrame()).toContain('ctrl+r reset')
  view.stdin.write('\x12'); await tick()
  expect(view.lastFrame()).toContain('▸ Client: All visible clients')
  await choose(view, 'Apply'); view.stdin.write('\r'); await tick()
  expect(applied[0]).toEqual({ ...value, client: null })
  view.unmount()
  const cleared = fixture(value, 8, 48)
  await tick(); await choose(cleared.view, 'Clear all filters'); cleared.view.stdin.write('\r'); await tick()
  await choose(cleared.view, 'Apply'); cleared.view.stdin.write('\r'); await tick()
  expect(cleared.applied[0]).toEqual(clearedFilters())
  expect(value.client).toBe('codex')
})

test('custom errors focus the offending field and valid UTC/date/span bounds apply atomically', async () => {
  const value: PickerFilters = { ...clearedFilters(), time: { kind: 'custom', range: {}, sinceText: '', untilText: '' } }
  const { view, applied } = fixture(value, 8, 90)
  await tick()
  await choose(view, 'Since:'); view.stdin.write('bad-date'); await tick()
  await choose(view, 'Apply'); view.stdin.write('\r'); await tick()
  expect(applied).toEqual([])
  expect(view.lastFrame()).toContain('▸ Since:')
  expect(view.lastFrame()).toContain('Error:')
  expect(view.lastFrame()).toContain('UTC')
  view.stdin.write('\x15'); await tick(); view.stdin.write('2026-10-07'); await tick()
  await choose(view, 'Until:'); view.stdin.write('2026-10-08T12:00:00Z'); await tick()
  await choose(view, 'Apply'); view.stdin.write('\r'); await tick()
  expect(applied[0]?.time).toEqual({ kind: 'custom', range: { since: Date.UTC(2026, 9, 7), until: Date.UTC(2026, 9, 8, 12) }, sinceText: '2026-10-07', untilText: '2026-10-08T12:00:00Z' })
})

test('unchanged custom relative bounds stay fixed and navigation keeps selection visible after resize', async () => {
  const value: PickerFilters = { ...clearedFilters(), time: { kind: 'custom', range: { since: 1000 }, sinceText: '2d', untilText: '' } }
  const { view, applied, props } = fixture(value, 20, 70)
  await tick()
  view.stdin.write('\t'); await tick()
  expect(view.lastFrame()).toContain('▸ Client:')
  view.stdin.write('\x1b[Z'); await tick()
  expect(view.lastFrame()).toContain('▸ Project:')
  await choose(view, 'Cancel')
  view.rerender(<Filters {...props} rows={8} columns={35} />); await tick()
  expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(8)
  view.stdin.write('\x1b[A'); await tick()
  expect(view.lastFrame()).toContain('▸ Apply')
  view.stdin.write('\r'); await tick()
  expect(applied[0]?.time).toEqual(value.time)
})


test('preset choices include custom and invalid upper bounds stay in the draft with a visible diagnostic', async () => {
  const { view, applied } = fixture()
  await tick()
  await choose(view, 'Time:')
  for (const label of ['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'Custom']) {
    view.stdin.write('\r'); await tick()
    expect(view.lastFrame()).toContain(`Time: ${label}`)
  }
  await choose(view, 'Until:'); view.stdin.write('2026-02-30'); await tick()
  await choose(view, 'Apply'); view.stdin.write('\r'); await tick()
  expect(applied).toEqual([])
  expect(view.lastFrame()).toContain('▸ Until:')
  expect(view.lastFrame()).toContain('Error:')
  view.stdin.write('\x15'); await tick(); view.stdin.write('2026-10-07'); await tick()
  await choose(view, 'Since:'); view.stdin.write('2026-10-08'); await tick()
  await choose(view, 'Apply'); view.stdin.write('\r'); await tick()
  expect(applied).toEqual([])
  expect(view.lastFrame()).toContain('must precede')
})

test('choosing exact matching without a file path does not apply an empty restrictive filter', async () => {
  const { view, applied } = fixture()
  await tick()
  await choose(view, 'File matching:'); view.stdin.write('\r'); await tick()
  await choose(view, 'Apply'); view.stdin.write('\r'); await tick()
  expect(applied[0]?.file).toBeUndefined()
})


test('filter help returns to the same unsaved draft and keeps parent filter input inactive', async () => {
  const { view, props, applied } = fixture()
  let helpClosed = 0
  await tick()
  view.stdin.write('\r'); await tick()
  await choose(view, 'File:'); view.stdin.write('src/keep.ts'); await tick()
  view.rerender(<Filters {...props} helpOpen={true} onHelpClose={() => { helpClosed++ }} />)
  await tick()
  expect(view.lastFrame()).toContain('Filter help')
  view.stdin.write('ignored'); await tick()
  view.stdin.write('\x1b'); await new Promise(resolve => setTimeout(resolve, 80))
  expect(helpClosed).toBe(1)
  view.rerender(<Filters {...props} helpOpen={false} />); await tick()
  expect(view.lastFrame()).toContain('File: src/keep.ts')
  view.stdin.write('\x13'); await tick()
  expect(applied[0]?.scope).toBe('/work/project')
  expect(applied[0]?.file).toEqual({ path: 'src/keep.ts', exact: false })
})

test('relative custom input resolves against one captured Apply time after the dialog has been open', async () => {
  const value: PickerFilters = { ...clearedFilters(), time: { kind: 'custom', range: {}, sinceText: '', untilText: '' } }
  const { view, props, applied } = fixture(value)
  let appliedNow = props.now
  const clock = () => appliedNow++
  view.rerender(<Filters {...props} clock={clock} />)
  await tick()
  await choose(view, 'Since:'); view.stdin.write('2d'); await tick()
  await choose(view, 'Until:'); view.stdin.write('1d'); await tick()
  const atApply = Date.UTC(2026, 9, 10, 18)
  appliedNow = atApply
  view.stdin.write('\x13'); await tick()
  expect(applied[0]?.time).toEqual({ kind: 'custom', range: { since: atApply - 2 * 86_400_000, until: atApply - 86_400_000 }, sinceText: '2d', untilText: '1d' })
})
