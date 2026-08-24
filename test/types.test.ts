import { expect, test } from 'bun:test'
import { isSafeClientId, makeUid, parseUid } from '../src/types'

test('makeUid joins client and native id', () => {
  expect(makeUid('claude', '9e64fb9e')).toBe('claude:9e64fb9e')
})

test('parseUid splits on the first colon only', () => {
  expect(parseUid('codex:019f71e8-26f9-7943')).toEqual({
    client: 'codex',
    nativeId: '019f71e8-26f9-7943',
  })
})

test('parseUid tolerates colons inside the native id', () => {
  expect(parseUid('agy:a:b:c')).toEqual({ client: 'agy', nativeId: 'a:b:c' })
})

test('parseUid throws on a malformed uid', () => {
  expect(() => parseUid('nocolon')).toThrow('malformed uid')
})

test('client ids share one bounded control-safe contract', () => {
  expect(isSafeClientId('client space')).toBe(true)
  expect(isSafeClientId('x'.repeat(256))).toBe(true)
  for (const value of ['', 'bad:id', 'bad\n', 'bad\u202e', 'x'.repeat(257)]) {
    expect(isSafeClientId(value)).toBe(false)
  }
})
