import { expect, test } from 'bun:test'
import React from 'react'
import { render } from 'ink-testing-library'
import { History } from '../src/tui/History'
import { anchorLine, buildHistoryLines, findHistory, nextHit } from '../src/tui/history.js'
import type { SessionDetail } from '../src/core/session-detail'
import type { PickerRestore } from '../src/tui/state'
const tick = () => new Promise(resolve => setTimeout(resolve, 30))
const turns = [{ ordinal: 4, role: 'user', text: 'a.*b A.*B 東京 CAFÉ café' }]
const detail: SessionDetail = {
  uid: 'a', turns, latestUser: turns[0]!.text, latestReply: null,
  ordered: true, fileCount: 0, fileCountCapped: false, reasons: [],
}

test('compact reader keeps find and back controls visible',async()=>{
 const longDetail={...detail,turns:Array.from({length:1000},(_,ordinal)=>({ordinal,role:'user',text:'A retained message'}))}
 const view=render(<History detail={longDetail} rows={8} columns={40} onPosition={()=>{}} onClose={()=>{}}/>)
 await tick()
 expect(view.lastFrame()).toContain('Ctrl+F find')
 expect(view.lastFrame()).toContain('Esc back')
 view.unmount()
})

test('history find is literal and Unicode case insensitive with source offsets', () => {
  expect(findHistory(turns, 'a.*b')).toEqual([
    { ordinal: 4, start: 0, end: 4 }, { ordinal: 4, start: 5, end: 9 },
  ])
  expect(findHistory(turns, 'café')).toEqual([
    { ordinal: 4, start: 13, end: 17 }, { ordinal: 4, start: 18, end: 22 },
  ])
  expect(findHistory(turns, '')).toEqual([])
  expect(findHistory(turns, '[')).toEqual([])
  expect(nextHit(1, 2, 1)).toBe(0)
  expect(nextHit(0, 2, -1)).toBe(1)
  expect(nextHit(0, 0, 1)).toBe(-1)
})

test('wrapped anchors map source offsets past removed bidi and replaced control text', () => {
  const source = [{ ordinal: 19, role: 'assistant', text: 'ab\u202ecd\u001befgh\n東京xyz' }]
  const narrow = buildHistoryLines(source, 4)
  expect(narrow.map(line => line.text)).toContain('abcd')
  expect(narrow.map(line => line.text).join('')).not.toContain('\u202e')
  const anchor = { uid: 'a', ordinal: 19, offset: 11, fallbackLine: 0 }
  const wide = buildHistoryLines(source, 8)
  expect(narrow[anchorLine(narrow, anchor)]?.text).toBe('東京')
  expect(wide[anchorLine(wide, anchor)]?.text).toBe('東京xyz')
  expect(anchorLine(wide, { ...anchor, ordinal: null, fallbackLine: 99 })).toBe(wide.length - 1)
})

test('anchors outside retained offsets use the nearest available line', () => {
  const lines = [
    { text: 'first retained fragment', ordinal: 7, offset: 10, endOffset: 20 },
    { text: 'last retained fragment', ordinal: 7, offset: 20, endOffset: 30 },
  ]
  const anchor = { uid: 'a', ordinal: 7, offset: 99, fallbackLine: 0 }
  expect(anchorLine(lines, anchor)).toBe(1)
  expect(anchorLine(lines, { ...anchor, offset: 0 })).toBe(0)
  expect(anchorLine(lines, { ...anchor, ordinal: 99, fallbackLine: 1 })).toBe(1)
  expect(anchorLine([], anchor)).toBe(0)
  expect(nextHit(-1, 3, -1)).toBe(2)
})

test('full-screen history supports Home End pages find cycling and nested Escape', async () => {
  let position: PickerRestore['reader'] = null
  let closed = 0
  const longDetail = { ...detail, turns: [{ ordinal: 4, role: 'user', text: 'first hit\n' + 'middle\n'.repeat(20) + 'last HIT' }] }
  const view = render(<History detail={longDetail} rows={8} columns={40}
    onPosition={value => { position = value }} onClose={() => { closed++ }} />)
  await tick()
  view.stdin.write('\u001b[F'); await tick()
  expect(view.lastFrame()).toContain('last HIT')
  expect(position!.anchor.offset).toBeGreaterThan(0)
  view.stdin.write('\u001b[H'); await tick()
  expect(view.lastFrame()).toContain('first hit')
  view.stdin.write('\u001b[6~'); await tick()
  expect(position!.anchor.offset).toBeGreaterThan(0)
  view.stdin.write('\u0006'); await tick()
  view.stdin.write('hit'); await tick()
  expect(view.lastFrame()).toContain('hit 1 of 2')
  view.stdin.write('\r'); await tick()
  view.stdin.write('\u001bOR'); await tick()
  expect(view.lastFrame()).toContain('hit 2 of 2')
  view.stdin.write('\u001b[1;2R'); await tick()
  expect(view.lastFrame()).toContain('hit 1 of 2')
  view.stdin.write('\u0006'); await tick()
  view.stdin.write('\u001b'); await tick()
  expect(closed).toBe(0)
  view.stdin.write('\u001b'); await tick()
  expect(closed).toBe(1)
  view.unmount()
})

test('reader resize preserves ordinal offset and capped legacy history is honest', async () => {
  let position: PickerRestore['reader'] = null
  const reader = <History detail={{ ...detail, turns: [{ ordinal: 20, role: 'assistant', text: '0123456789'.repeat(30) }] }}
    rows={8} columns={20} initial={{ anchor: { uid: 'a', ordinal: 20, offset: 100, fallbackLine: 0 }, findText: '', hitIndex: -1 }}
    onPosition={value => { position = value }} onClose={() => {}} />
  const view = render(reader); await tick()
  const offset = position!.anchor.offset
  view.rerender(React.cloneElement(reader, { columns: 40 })); await tick()
  expect(position!.anchor.ordinal).toBe(20)
  expect(position!.anchor.offset).toBe(offset)
  view.unmount()
  const legacy = render(<History detail={{ ...detail, turns: [], ordered: false, latestUser: 'legacy prompt', latestReply: 'legacy reply', reasons: ['reader-cap'] }}
    rows={12} columns={80} extraLines={['read src/file.ts']} onPosition={() => {}} onClose={() => {}} />)
  await tick()
  expect(legacy.lastFrame()).toContain('Prompt text')
  expect(legacy.lastFrame()).toContain('legacy reply')
  expect(legacy.lastFrame()).toContain('retained history capped')
  expect(legacy.lastFrame()).toContain('read src/file.ts')
  legacy.unmount()
})

test('legacy find uses fallback lines and no-match input preserves the current position', async () => {
  let position: PickerRestore['reader'] = null
  let closed = false
  const view = render(<History detail={{ ...detail, ordered: false, turns: [], latestUser: 'before\n' + 'middle\n'.repeat(10) + 'needle' }}
    rows={8} columns={40} onPosition={value => { position = value }} onClose={() => { closed = true }} />)
  await tick()
  view.stdin.write('\u0006'); await tick(); view.stdin.write('needle'); await tick()
  expect(view.lastFrame()).toContain('hit 1 of 1')
  expect(view.lastFrame()).toContain('needle')
  expect(position!.anchor.ordinal).toBeNull()
  const fallback = position!.anchor.fallbackLine
  view.stdin.write('missing'); await tick()
  expect(view.lastFrame()).toContain('No matches')
  expect(position!.anchor.fallbackLine).toBe(fallback)
  view.stdin.write('\u000f'); await tick()
  expect(closed).toBe(true)
  view.unmount()
})

test('reader applies every arrow in a burst before repaint', async () => {
  let position: PickerRestore['reader'] = null
  const source = { ...detail, turns: [{ ordinal: 4, role: 'user', text: Array.from({ length: 30 }, (_, i) => `row${i}`).join('\n') }] }
  const view = render(<History detail={source} rows={8} columns={40}
    onPosition={value => { position = value }} onClose={() => {}} />)
  await tick()
  view.stdin.write('\u001b[B'); view.stdin.write('\u001b[B'); view.stdin.write('\u001b[B')
  await tick()
  // The reader opens on the turn's heading, so three rows down is row2.
  expect(position!.anchor.offset).toBe(10)
  view.stdin.write('\u001b[A'); view.stdin.write('\u001b[A')
  await tick()
  expect(position!.anchor.offset).toBe(0)
  expect(view.lastFrame()).toContain('row1')
  view.unmount()
})

test('reader help preserves find and anchor while suspending navigation', async () => {
  let position: PickerRestore['reader'] = null
  let helpClosed = false
  let readerClosed = false
  const props = { detail, rows: 12, columns: 80, onPosition: (value: PickerRestore['reader']) => { position = value }, onClose: () => { readerClosed = true }, onHelpClose: () => { helpClosed = true } }
  const view = render(<History {...props} />); await tick()
  view.stdin.write('\u0006'); await tick(); view.stdin.write('café'); await tick()
  const before = structuredClone(position)
  view.rerender(<History {...props} helpOpen />); await tick()
  expect(view.lastFrame()).toContain('History help')
  view.stdin.write('\u001bOR'); view.stdin.write('\u001b[B'); await tick()
  expect(position).toEqual(before)
  view.stdin.write('\u001b'); await tick()
  expect(helpClosed).toBe(true)
  expect(readerClosed).toBe(false)
  view.rerender(<History {...props} helpOpen={false} />); await tick()
  expect(view.lastFrame()).toContain('Find: café')
  expect(position).toEqual(before)
  view.unmount()
})

test('reader applies each F3 hit movement in a burst', async () => {
  let position: PickerRestore['reader'] = null
  const view = render(<History detail={detail} rows={12} columns={80}
    initial={{ anchor: { uid: 'a', ordinal: 4, offset: 13, fallbackLine: 0 }, findText: 'café', hitIndex: 0 }}
    onPosition={value => { position = value }} onClose={() => {}} />)
  await tick()
  view.stdin.write('\u001bOR'); view.stdin.write('\u001bOR')
  await tick()
  expect(position!.hitIndex).toBe(0)
  expect(position!.anchor.offset).toBe(13)
  view.unmount()
})

test('capped reader shows both retained scope and absent match location without evidence', async () => {
  const capped = { ...detail, reasons: ['reader-cap'] as SessionDetail['reasons'] }
  const view = render(<History detail={capped} rows={8} columns={40} evidence={null}
    initial={{ anchor: { uid: 'a', ordinal: null, offset: 0, fallbackLine: 0 }, findText: 'absentword', hitIndex: -1 }}
    onPosition={() => {}} onClose={() => {}} />)
  await tick()
  const frame = view.lastFrame()!
  expect(frame).toContain('retained history capped')
  expect(frame.replaceAll('\n', ' ')).toContain('Match location unavailable in retained history')
  expect(frame.split('\n').length).toBeLessThanOrEqual(8)
  expect(frame.split('\n').every(line => Bun.stringWidth(line) <= 40)).toBe(true)
  view.unmount()
})

test('scrolling up passes turn headings instead of snapping back to their first row', async () => {
  let position: PickerRestore['reader'] = null
  const source = { ...detail, turns: [
    { ordinal: 1, role: 'user', text: 'first question' },
    { ordinal: 2, role: 'assistant', text: 'first answer' },
    { ordinal: 3, role: 'user', text: 'second question' },
  ] }
  const view = render(<History detail={source} rows={5} columns={40}
    onPosition={value => { position = value }} onClose={() => {}} />)
  await tick()
  expect(view.lastFrame()).toContain('Prompt')
  for (let step = 0; step < 6; step++) { view.stdin.write('\u001b[B'); await tick() }
  expect(position!.anchor.ordinal).toBe(3)
  for (let step = 0; step < 6; step++) { view.stdin.write('\u001b[A'); await tick() }
  // Six rows down and six back up lands on the opening heading again.
  expect(position!.anchor).toMatchObject({ ordinal: 1, offset: -1 })
  expect(view.lastFrame()).toContain(' 1-3/8')
  view.unmount()
})
