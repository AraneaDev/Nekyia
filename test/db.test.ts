import { expect, test } from 'bun:test'
import Database from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IndexDb } from '../src/core/db'
import type { SessionRef, SessionDoc } from '../src/types'

function ref(over: Partial<SessionRef> = {}): SessionRef {
  return {
    uid: 'claude:abc', client: 'claude', nativeId: 'abc',
    cwd: '/root/proj', gitBranch: 'main', title: 'Fix the SSE reconnect race',
    startedAt: 1000, endedAt: 2000, turns: 12,
    parentNativeId: null, tier: 'resume', origin: 'manifest',
    sourcePaths: ['/a.jsonl'], fingerprint: '111:222',
    ...over,
  }
}
function doc(r: SessionRef, over: Partial<SessionDoc> = {}): SessionDoc {
  return { ref: r, prompts: ['fix the sse reconnect obsoleteprompt'], prose: ['I found a race'], files: ['src/sse.ts'], truncated: false, ...over }
}

test('upsertRef then read back by uid', () => {
  const db = IndexDb.open(':memory:'); db.upsertRef(ref())
  expect(db.getRef('claude:abc')?.title).toBe('Fix the SSE reconnect race'); db.close()
})
test('upsertRef is idempotent and updates in place', () => {
  const db = IndexDb.open(':memory:'); db.upsertRef(ref()); db.upsertRef(ref({ title: 'Renamed', fingerprint: '999:999' }))
  expect(db.allUids()).toEqual(['claude:abc']); expect(db.getRef('claude:abc')?.fingerprint).toBe('999:999'); db.close()
})
test('getFingerprints returns uid to fingerprint', () => {
  const db = IndexDb.open(':memory:'); db.upsertRef(ref())
  expect(db.getFingerprints().get('claude:abc')).toBe('111:222'); db.close()
})
test('upsertDoc makes the session findable by prompt text', () => {
  const db = IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r); db.upsertDoc(doc(r))
  expect(db.ftsSearch('obsoleteprompt').map(h=>h.uid)).toEqual(['claude:abc']); db.close()
})
test('re-hydrating replaces old text rather than duplicating it', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r); db.upsertDoc(doc(r)); db.upsertDoc(doc(r,{prompts:['totally different words']}))
  expect(db.ftsSearch('obsoleteprompt')).toEqual([]); expect(db.ftsSearch('different').map(h=>h.uid)).toEqual(['claude:abc']); db.close()
})
test('files are stored as a separate facet', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r); db.upsertDoc(doc(r))
  expect(db.uidsTouchingFile('src/sse')).toEqual(['claude:abc']); db.close()
})
test('ordered dialogue is replaced and deleted with the session', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r)
  db.upsertDoc(doc(r, { dialogue: [
    { role: 'user', text: 'first question' },
    { role: 'assistant', text: 'first answer' },
  ] }))
  expect(db.raw().query('SELECT role, text FROM session_turn ORDER BY ordinal').all()).toEqual([
    { role: 'user', text: 'first question' },
    { role: 'assistant', text: 'first answer' },
  ])
  db.upsertDoc(doc(r, { dialogue: [{ role: 'user', text: 'replacement question' }] }))
  expect(db.raw().query('SELECT role, text FROM session_turn ORDER BY ordinal').all()).toEqual([
    { role: 'user', text: 'replacement question' },
  ])
  db.deleteSession(r.uid)
  expect(db.raw().query('SELECT * FROM session_turn').all()).toEqual([])
  db.close()
})
test('deleteSession removes the row, its text and its files', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r); db.upsertDoc(doc(r)); db.deleteSession('claude:abc')
  expect(db.allUids()).toEqual([]); expect(db.ftsSearch('reconnect')).toEqual([]); expect(db.uidsTouchingFile('src/sse')).toEqual([]); db.close()
})
test('markMissing flags sessions without deleting them', () => {
  const db=IndexDb.open(':memory:'); db.upsertRef(ref()); db.markMissing(['claude:abc'])
  expect(db.getRef('claude:abc')?.missing).toBe(true); db.close()
})

test('getMissingUids returns missing sessions and upsertRef clears them', () => {
  const db = IndexDb.open(':memory:')
  const item = ref()
  db.upsertRef(item)
  db.markMissing([item.uid])
  expect(db.getMissingUids()).toEqual(new Set([item.uid]))
  db.upsertRef(item)
  expect(db.getMissingUids()).toEqual(new Set())
  db.close()
})

test('upsertDoc rolls back every facet when replacement fails', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r); db.upsertDoc(doc(r))
  db.raw().exec(`CREATE TRIGGER fail_replacement BEFORE INSERT ON session_text
    WHEN NEW.prompts LIKE '%different%' BEGIN SELECT RAISE(FAIL, 'replacement failed'); END`)
  expect(() => db.upsertDoc(doc(r, { prompts: ['totally different words'], files: ['src/new.ts'], truncated: true }))).toThrow('replacement failed')
  expect(db.ftsSearch('obsoleteprompt').map(h=>h.uid)).toEqual(['claude:abc'])
  expect(db.ftsSearch('different')).toEqual([])
  expect(db.uidsTouchingFile('src/sse')).toEqual(['claude:abc'])
  expect(db.uidsTouchingFile('src/new')).toEqual([])
  expect(db.raw().query('SELECT hydrated, truncated FROM session WHERE uid = ?').get(r.uid)).toEqual({ hydrated: 1, truncated: 0 })
  db.close()
})

test('upsertHydrated rolls back the ref and every document facet together', () => {
  const db = IndexDb.open(':memory:')
  const oldRef = ref({ fingerprint: 'old-fingerprint' })
  db.upsertHydrated(doc(oldRef))
  db.raw().exec(`CREATE TRIGGER fail_atomic_replacement BEFORE INSERT ON session_text
    WHEN NEW.prompts LIKE '%replacement%' BEGIN SELECT RAISE(FAIL, 'atomic replacement failed'); END`)

  const changedRef = ref({ fingerprint: 'new-fingerprint', title: 'Changed title' })
  expect(() => db.upsertHydrated(doc(changedRef, {
    prompts: ['replacement'],
    files: ['src/replacement.ts'],
  }))).toThrow('atomic replacement failed')

  expect(db.getRef(oldRef.uid)?.fingerprint).toBe('old-fingerprint')
  expect(db.getRef(oldRef.uid)?.title).toBe(oldRef.title)
  expect(db.ftsSearch('obsoleteprompt').map((hit) => hit.uid)).toEqual([oldRef.uid])
  expect(db.uidsTouchingFile('src/sse')).toEqual([oldRef.uid])
  expect(db.uidsTouchingFile('replacement')).toEqual([])
  db.close()
})

test('deleteSession rolls back when the final session delete fails', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r); db.upsertDoc(doc(r))
  db.raw().exec(`CREATE TRIGGER fail_session_delete BEFORE DELETE ON session
    BEGIN SELECT RAISE(FAIL, 'session delete failed'); END`)
  expect(() => db.deleteSession(r.uid)).toThrow('session delete failed')
  expect(db.getRef(r.uid)?.uid).toBe(r.uid)
  expect(db.ftsSearch('obsoleteprompt').map(h=>h.uid)).toEqual([r.uid])
  expect(db.uidsTouchingFile('src/sse')).toEqual([r.uid])
  db.close()
})

test('markMissing rolls back the whole batch when one update fails', () => {
  const db=IndexDb.open(':memory:')
  const first=ref({ uid: 'claude:a', nativeId: 'a' }); const second=ref({ uid: 'claude:b', nativeId: 'b' })
  db.upsertRef(first); db.upsertRef(second)
  db.raw().exec(`CREATE TRIGGER fail_second_missing BEFORE UPDATE OF missing ON session
    WHEN NEW.uid = 'claude:b' AND NEW.missing = 1 BEGIN SELECT RAISE(FAIL, 'missing update failed'); END`)
  expect(() => db.markMissing([first.uid, second.uid])).toThrow('missing update failed')
  expect(db.getRef(first.uid)?.missing).toBe(false)
  expect(db.getRef(second.uid)?.missing).toBe(false)
  db.close()
})

test('open rejects a newer schema version without overwriting it', () => {
  const dir=mkdtempSync(join(tmpdir(), 'nekyia-db-')); const path=join(dir, 'index.db')
  let opened: IndexDb | undefined
  try {
    const raw=new Database(path, { create: true })
    raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    raw.query('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '3')
    raw.close()
    expect(() => { opened=IndexDb.open(path) }).toThrow('unsupported schema version: 3')
    const check=new Database(path)
    expect(check.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: '3' })
    check.close()
  } finally {
    opened?.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('open migrates a valid version-one index without losing session data', () => {
  const dir=mkdtempSync(join(tmpdir(), 'nekyia-db-')); const path=join(dir, 'index.db')
  try {
    const original=IndexDb.open(path); const r=ref(); original.upsertRef(r); original.upsertDoc(doc(r)); original.close()
    const old=new Database(path)
    old.exec("DROP TABLE session_turn; UPDATE meta SET value = '1' WHERE key = 'schema_version'")
    old.close()

    const migrated=IndexDb.open(path)
    expect(migrated.getRef(r.uid)?.title).toBe(r.title)
    expect(migrated.ftsSearch('obsoleteprompt').map((hit) => hit.uid)).toEqual([r.uid])
    expect(migrated.raw().query("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: '2' })
    expect(migrated.raw().query("SELECT name FROM sqlite_master WHERE name = 'session_turn'").get())
      .toEqual({ name: 'session_turn' })
    migrated.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('uidsTouchingFile treats percent and underscore literally', () => {
  const db=IndexDb.open(':memory:')
  const entries: Array<[SessionRef, string]> = [
    [ref({ uid: 'claude:percent', nativeId: 'percent' }), 'src/100%real.ts'],
    [ref({ uid: 'claude:percent-wild', nativeId: 'percent-wild' }), 'src/100Xreal.ts'],
    [ref({ uid: 'claude:underscore', nativeId: 'underscore' }), 'src/file_name.ts'],
    [ref({ uid: 'claude:underscore-wild', nativeId: 'underscore-wild' }), 'src/fileXname.ts'],
  ]
  for (const [r, file] of entries) { db.upsertRef(r); db.upsertDoc(doc(r, { files: [file] })) }
  expect(db.uidsTouchingFile('100%real')).toEqual(['claude:percent'])
  expect(db.uidsTouchingFile('file_name')).toEqual(['claude:underscore'])
  db.close()
})
