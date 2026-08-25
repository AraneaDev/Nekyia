import { expect, test } from 'bun:test'
import { boundedDisplayText, wrappedDisplayLines } from '../src/tui/text'

test('the display bound keeps whole Unicode graphemes at the column edge', () => {
  const family = '👨‍👩‍👧‍👦'
  const output = boundedDisplayText(family.repeat(100), 10)
  expect(output).toBe(family.repeat(5))
  expect(Bun.stringWidth(output)).toBe(10)
})

test('history wrapping keeps the sanitized tail across terminal rows', () => {
  const source = `first ${'word '.repeat(20)}last\u001b[2J`
  const lines = wrappedDisplayLines(source, 18)
  expect(lines.length).toBeGreaterThan(1)
  expect(lines.every((line) => Bun.stringWidth(line) <= 18)).toBe(true)
  // Every character survives, with the escape byte turned into a space.
  expect(lines.join('')).toBe(source.replace('\u001b', ' '))
  expect(lines.join('')).toContain('last')
})

test('history wrapping never splits a grapheme across two rows', () => {
  const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}'
  const lines = wrappedDisplayLines(family.repeat(9), 10)
  expect(lines).toEqual([family.repeat(5), family.repeat(4)])
  expect(lines.every((line) => Bun.stringWidth(line) <= 10)).toBe(true)
})

test('history wrapping has nothing to say about nothing', () => {
  expect(wrappedDisplayLines('', 40)).toEqual([])
  expect(wrappedDisplayLines('anything', 0)).toEqual([])
  expect(wrappedDisplayLines('anything', -5)).toEqual([])
  expect(wrappedDisplayLines('anything', Number.NaN)).toEqual([])
})

test('a grapheme wider than the whole width still gets a row of its own', () => {
  // Two columns wide against a one-column budget: it has to go somewhere, and
  // an empty row followed by the same problem would never terminate.
  expect(wrappedDisplayLines('\u5b57\u5b57', 1)).toEqual(['\u5b57', '\u5b57'])
})
