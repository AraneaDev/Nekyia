import { expect, test } from 'bun:test'
import { forgetIn } from '../src/commands/privacy'
import { IndexDb } from '../src/core/db'
import type { SessionRef } from '../src/types'
import {
  MAX_CLIENT_ID_LENGTH,
  MAX_NATIVE_ID_LENGTH,
  MAX_UID_LENGTH,
  isSafeClientId,
  isSafeNativeId,
  makeUid,
  parseUid,
} from '../src/types'

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

test('native ids answer to the same control-safe contract client ids do', () => {
  expect(isSafeNativeId('019f71e8-26f9-7943')).toBe(true)
  // parseUid splits on the first colon, so the native half may hold more.
  expect(isSafeNativeId('a:b:c')).toBe(true)
  expect(isSafeNativeId('n'.repeat(MAX_NATIVE_ID_LENGTH))).toBe(true)
  for (const value of [
    '', 'bad\u0000', 'bad\n', 'bad\u202e', 'bad\u200f', 'n'.repeat(MAX_NATIVE_ID_LENGTH + 1),
  ]) {
    expect(isSafeNativeId(value)).toBe(false)
  }
})

test('the widest client and the widest native id still make one addressable uid', () => {
  const uid = makeUid('c'.repeat(MAX_CLIENT_ID_LENGTH), 'n'.repeat(MAX_NATIVE_ID_LENGTH))
  expect(uid.length).toBe(MAX_UID_LENGTH)
  expect(isSafeClientId(parseUid(uid).client)).toBe(true)
  expect(isSafeNativeId(parseUid(uid).nativeId)).toBe(true)
})

function indexed(db: IndexDb, uid: string, client: string): void {
  const ref: SessionRef = {
    uid,
    client,
    nativeId: parseUid(uid).nativeId,
    cwd: '/root/proj',
    gitBranch: null,
    title: null,
    startedAt: 0,
    endedAt: 0,
    turns: null,
    parentNativeId: null,
    tier: 'search',
    origin: 'manifest',
    sourcePaths: ['/x'],
    fingerprint: 'f',
  }
  db.upsertRef(ref)
}

test('forget accepts the widest uid a producer can make, and nothing wider', () => {
  // A producer that accepted a longer native id would index sessions forget
  // then refuses as malformed, leaving prune --client as the only way out.
  // privacy.ts owns the check a user actually hits, so the bound is exercised
  // through forget rather than compared against a second copy of the number.
  const client = 'c'.repeat(MAX_CLIENT_ID_LENGTH)
  const widest = makeUid(client, 'n'.repeat(MAX_NATIVE_ID_LENGTH))
  expect(widest.length).toBe(MAX_UID_LENGTH)

  const db = IndexDb.open(':memory:')
  try {
    indexed(db, widest, client)
    expect(forgetIn(db, widest)).toBe(true)
    indexed(db, `${widest}n`, client)
    expect(forgetIn(db, `${widest}n`)).toBe(false)
  } finally {
    db.close()
  }
})
