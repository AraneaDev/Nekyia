import { expect, test } from 'bun:test'
import { boundedDisplayText } from '../src/tui/text'

test('the display bound keeps whole Unicode graphemes at the column edge', () => {
  const family = '👨‍👩‍👧‍👦'
  const output = boundedDisplayText(family.repeat(100), 10)
  expect(output).toBe(family.repeat(5))
  expect(Bun.stringWidth(output)).toBe(10)
})
