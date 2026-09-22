import { expect, test } from 'bun:test'
import { buildContext } from '../src/core/context'
import { IndexDb } from '../src/core/db'
import type { SessionDoc, SessionRef } from '../src/types'

function ref(over: Partial<SessionRef> = {}): SessionRef {
  return {
    uid: 'claude:context-1', client: 'claude', nativeId: 'context-1',
    cwd: '/work/project', gitBranch: 'main', title: 'retry tenant',
    startedAt: 1, endedAt: 2, turns: 3, parentNativeId: null,
    tier: 'resume', origin: 'manifest', sourcePaths: ['/tmp/session.jsonl'], fingerprint: 'f',
    ...over,
  }
}

function doc(session: SessionRef, over: Partial<SessionDoc> = {}): SessionDoc {
  return {
    ref: session,
    prompts: ['first prompt', 'second prompt'],
    prose: ['old reply', 'new reply'],
    dialogue: [
      { role: 'user', text: 'first prompt' },
      { role: 'assistant', text: 'old reply' },
      { role: 'user', text: 'second prompt' },
      { role: 'assistant', text: 'new reply' },
    ],
    files: ['src/retry.ts'],
    fileEvents: [{ path: 'src/retry.ts', kind: 'edit', turn: 2 }],
    fileDetail: 'ordered',
    truncated: false,
    ...over,
  }
}

test('context export includes ordered dialogue, files, events and quality', () => {
  const db = IndexDb.open(':memory:')
  const session = ref()
  db.upsertHydrated(doc(session))

  const context = buildContext(db, session.uid)!
  expect(context.contractVersion).toBe(1)
  expect(context.uid).toBe(session.uid)
  expect(context.prompts).toEqual(['first prompt', 'second prompt'])
  expect(context.dialogue).toEqual(doc(session).dialogue!)
  expect(context.files).toEqual(['src/retry.ts'])
  expect(context.events).toEqual([{ ordinal: 0, turn: 2, path: 'src/retry.ts', kind: 'edit' }])
  expect(context.quality.fileDetail).toBe('ordered')
  expect(context.limitations).toEqual([])
  db.close()
})

test('context export preserves prompts and reports omitted replies under a budget', () => {
  const db = IndexDb.open(':memory:')
  const session = ref()
  db.upsertHydrated(doc(session, { dialogue: undefined, prose: ['reply '.repeat(200)] }))

  const context = buildContext(db, session.uid, { maxChars: 600 })!
  expect(context.prompts).toEqual(['first prompt', 'second prompt'])
  expect(context.assistantProse).toEqual([])
  expect(context.limitations).toContain('budget-trimmed')
  expect(JSON.stringify(context).length).toBeLessThanOrEqual(600)
  db.close()
})

test('context export rejects a budget too small for mandatory metadata and prompts', () => {
  const db = IndexDb.open(':memory:')
  const session = ref()
  db.upsertHydrated(doc(session))

  expect(() => buildContext(db, session.uid, { maxChars: 1 })).toThrow('maxChars')
  db.close()
})

test('unknown and unhydrated sessions return no context', () => {
  const db = IndexDb.open(':memory:')
  expect(buildContext(db, 'claude:nope')).toBeNull()
  db.upsertRef(ref({ uid: 'claude:bare', nativeId: 'bare' }))
  expect(buildContext(db, 'claude:bare')).toBeNull()
  db.close()
})
