import { expect, test } from 'bun:test'
import Database from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IndexDb } from '../src/core/db'
import type { DialogueTurn, FileEvent, FileEventKind, SessionRef, SessionDoc } from '../src/types'

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
test('ordered dialogue is stored, renumbered, replaced and deleted with the session', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r)
  // A manifest decides what a role is, so a role the index does not know, and a
  // turn with nothing in it, are both dropped without leaving a gap in the
  // ordinals.
  const mixed = [
    { role: 'user', text: 'first question' },
    { role: 'system', text: 'ignored' },
    { role: 'assistant', text: '' },
    { role: 'assistant', text: 'first answer' },
  ] as unknown as DialogueTurn[]
  db.upsertDoc(doc(r, { dialogue: mixed }))
  expect(db.raw().query('SELECT ordinal, role, text FROM session_turn ORDER BY ordinal').all()).toEqual([
    { ordinal: 0, role: 'user', text: 'first question' },
    { ordinal: 1, role: 'assistant', text: 'first answer' },
  ])

  db.upsertDoc(doc(r, { dialogue: [{ role: 'user', text: 'replacement question' }] }))
  expect(db.raw().query('SELECT role, text FROM session_turn ORDER BY ordinal').all()).toEqual([
    { role: 'user', text: 'replacement question' },
  ])

  // A reader that stops producing turns must not leave the old ones behind.
  db.upsertDoc(doc(r))
  expect(db.raw().query('SELECT * FROM session_turn').all()).toEqual([])

  db.upsertDoc(doc(r, { dialogue: [{ role: 'assistant', text: 'back again' }] }))
  db.deleteSession(r.uid)
  expect(db.raw().query('SELECT * FROM session_turn').all()).toEqual([])
  db.close()
})
test('a failed replacement rolls the ordered dialogue back with everything else', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r)
  db.upsertDoc(doc(r, { dialogue: [{ role: 'user', text: 'the original turn' }] }))
  db.raw().exec(`CREATE TRIGGER fail_turn_replacement BEFORE INSERT ON session_text
    WHEN NEW.prompts LIKE '%different%' BEGIN SELECT RAISE(FAIL, 'replacement failed'); END`)
  expect(() => db.upsertDoc(doc(r, {
    prompts: ['totally different words'],
    dialogue: [{ role: 'user', text: 'the replacement turn' }],
  }))).toThrow('replacement failed')
  expect(db.raw().query('SELECT role, text FROM session_turn ORDER BY ordinal').all()).toEqual([
    { role: 'user', text: 'the original turn' },
  ])
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

test('indexedClients names each client the index holds once, in a stable order', () => {
  const db = IndexDb.open(':memory:')
  // An index with nothing in it names no clients rather than throwing.
  expect(db.indexedClients()).toEqual([])

  db.upsertRef(ref({ uid: 'opencode:1', client: 'opencode', nativeId: '1' }))
  db.upsertRef(ref({ uid: 'claude:1', client: 'claude', nativeId: '1' }))
  db.upsertRef(ref({ uid: 'claude:2', client: 'claude', nativeId: '2' }))
  // Sorted and deduplicated, so the picker's cycle is the same on every run
  // however the rows happened to be written.
  expect(db.indexedClients()).toEqual(['claude', 'opencode'])

  // A client is present only while it still has a session in the table.
  db.deleteSessions(['claude:1', 'claude:2'])
  expect(db.indexedClients()).toEqual(['opencode'])
  db.close()
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
    raw.query('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '5')
    raw.close()
    expect(() => { opened=IndexDb.open(path) }).toThrow('unsupported schema version: 5')
    const check=new Database(path)
    expect(check.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: '5' })
    check.close()
  } finally {
    opened?.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('a fresh index is stamped at schema version 4', () => {
  const db=IndexDb.open(':memory:')
  expect(db.schemaVersion()).toBe(4); db.close()
})
test('schema version 4 adds the file event table', () => {
  const db=IndexDb.open(':memory:')
  const columns=db.raw().query('PRAGMA table_info(session_file_event)').all() as Array<{name:string}>
  expect(columns.map(c=>c.name)).toEqual(['uid','ordinal','turn','path','kind']); db.close()
})
test('a session indexed before file events reads as unknown detail', () => {
  const db=IndexDb.open(':memory:'); db.upsertRef(ref())
  const row=db.raw().query('SELECT file_detail, file_events_truncated FROM session WHERE uid = ?')
    .get('claude:abc') as { file_detail: string; file_events_truncated: number }
  expect(row).toEqual({ file_detail: 'unknown', file_events_truncated: 0 }); db.close()
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

/**
 * The schema exactly as version 1 shipped it, written out here rather than
 * imported: a migration test that builds its fixture from the code under test
 * would still pass if the ladder quietly changed what version 1 means.
 */
const V1_SCHEMA = `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE session (
    uid TEXT PRIMARY KEY,
    client TEXT NOT NULL,
    native_id TEXT NOT NULL,
    cwd TEXT,
    git_branch TEXT,
    title TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    turns INTEGER,
    parent_native_id TEXT,
    tier TEXT NOT NULL,
    origin TEXT NOT NULL,
    source_paths TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    missing INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    hydrated INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX session_cwd_idx ON session(cwd);
  CREATE INDEX session_ended_at_idx ON session(ended_at DESC);
  CREATE TABLE session_text (
    rowid INTEGER PRIMARY KEY,
    uid TEXT UNIQUE NOT NULL,
    title TEXT,
    prompts TEXT,
    prose TEXT
  );
  CREATE VIRTUAL TABLE session_fts USING fts5(
    title,
    prompts,
    prose,
    content='session_text',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );
  CREATE TABLE session_file (
    uid TEXT NOT NULL,
    path TEXT NOT NULL
  );
  CREATE INDEX session_file_uid_idx ON session_file(uid);
  CREATE INDEX session_file_path_idx ON session_file(path);
`

/**
 * The schema exactly as version 2 shipped it: version 1 plus the one column the
 * `degraded` step appended. Written out for the same reason V1_SCHEMA is.
 */
const V2_SCHEMA = V1_SCHEMA.replace(
  '    hydrated INTEGER NOT NULL DEFAULT 0\n  );',
  '    hydrated INTEGER NOT NULL DEFAULT 0,\n    degraded INTEGER NOT NULL DEFAULT 0\n  );',
)

const V1_COLUMNS = [
  'uid', 'client', 'native_id', 'cwd', 'git_branch', 'title', 'started_at', 'ended_at',
  'turns', 'parent_native_id', 'tier', 'origin', 'source_paths', 'fingerprint', 'missing',
  'truncated', 'hydrated',
]

function temporaryPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nekyia-migrate-'))
  return { dir, path: join(dir, 'index.db') }
}

/** Writes a populated version 1 index by hand, the way a released Nekyia left one on disk. */
function writeV1Index(path: string): void {
  const raw = new Database(path, { create: true })
  try {
    raw.exec(V1_SCHEMA)
    raw.query('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1')
    raw.query(`
      INSERT INTO session (
        uid, client, native_id, cwd, git_branch, title, started_at, ended_at,
        turns, parent_native_id, tier, origin, source_paths, fingerprint,
        missing, truncated, hydrated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'claude:old', 'claude', 'old', '/root/proj', 'main', 'An indexed v1 session',
      1000, 2000, 7, null, 'resume', 'manifest', JSON.stringify(['/a.jsonl']), 'fp-v1',
      1, 1, 1,
    )
    raw.query(
      'INSERT INTO session_text (uid, title, prompts, prose) VALUES (?, ?, ?, ?)',
    ).run('claude:old', 'An indexed v1 session', 'legacyprompt text', 'legacy prose')
    raw.query(
      'INSERT INTO session_fts(rowid, title, prompts, prose) VALUES (?, ?, ?, ?)',
    ).run(1, 'An indexed v1 session', 'legacyprompt text', 'legacy prose')
    raw.query('INSERT INTO session_file (uid, path) VALUES (?, ?)').run('claude:old', 'src/legacy.ts')
  } finally {
    raw.close()
  }
}

/** Writes a populated version 2 index by hand, the way the released Nekyia before this change left one on disk. */
function writeV2Index(path: string): void {
  const raw = new Database(path, { create: true })
  try {
    raw.exec(V2_SCHEMA)
    raw.query('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '2')
    raw.query(`
      INSERT INTO session (
        uid, client, native_id, cwd, git_branch, title, started_at, ended_at,
        turns, parent_native_id, tier, origin, source_paths, fingerprint,
        missing, truncated, hydrated, degraded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'claude:two', 'claude', 'two', '/root/proj', 'main', 'An indexed v2 session',
      1000, 2000, 9, null, 'resume', 'manifest', JSON.stringify(['/b.jsonl']), 'fp-v2',
      0, 1, 1, 1,
    )
    raw.query(
      'INSERT INTO session_text (uid, title, prompts, prose) VALUES (?, ?, ?, ?)',
    ).run('claude:two', 'An indexed v2 session', 'legacytwoprompt text', 'legacy two prose')
    raw.query(
      'INSERT INTO session_fts(rowid, title, prompts, prose) VALUES (?, ?, ?, ?)',
    ).run(1, 'An indexed v2 session', 'legacytwoprompt text', 'legacy two prose')
    raw.query('INSERT INTO session_file (uid, path) VALUES (?, ?)').run('claude:two', 'src/legacy-two.ts')
  } finally {
    raw.close()
  }
}

function storedVersion(path: string): string | null {
  const raw = new Database(path)
  try {
    const row = raw.query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | null
    return row?.value ?? null
  } finally {
    raw.close()
  }
}

function tableNames(path: string): string[] {
  const raw = new Database(path)
  try {
    return (raw.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name)
  } finally {
    raw.close()
  }
}

function sessionColumns(path: string): string[] {
  const raw = new Database(path)
  try {
    return (raw.query('PRAGMA table_info(session)').all() as Array<{ name: string }>)
      .map((row) => row.name)
  } finally {
    raw.close()
  }
}

test('a real version 1 index migrates to the current schema with every row intact', () => {
  const { dir, path } = temporaryPath()
  try {
    writeV1Index(path)
    expect(sessionColumns(path)).toEqual(V1_COLUMNS)

    const db = IndexDb.open(path, false)
    try {
      expect(storedVersion(path)).toBe('4')
      expect(sessionColumns(path)).toEqual([...V1_COLUMNS, 'degraded', 'file_detail', 'file_events_truncated'])
      expect(tableNames(path)).toContain('session_turn')
      expect(tableNames(path)).toContain('session_file_event')

      const stored = db.getRef('claude:old')!
      expect(stored.title).toBe('An indexed v1 session')
      expect(stored.cwd).toBe('/root/proj')
      expect(stored.turns).toBe(7)
      expect(stored.sourcePaths).toEqual(['/a.jsonl'])
      expect(stored.fingerprint).toBe('fp-v1')
      expect(stored.missing).toBe(true)
      // The one flag version 1 had is carried over; the new one defaults to
      // false, because a v1 index never recorded that cause separately.
      expect(stored.truncated).toBe(true)
      expect(stored.degraded).toBe(false)

      expect(db.allUids()).toEqual(['claude:old'])
      expect(db.ftsSearch('legacyprompt').map((hit) => hit.uid)).toEqual(['claude:old'])
      expect(db.uidsTouchingFile('src/legacy')).toEqual(['claude:old'])
      expect(db.schemaVersion()).toBe(4)
    } finally {
      db.close()
    }

    // The migrated file passes the strict validation the mutating commands do.
    const writable = IndexDb.openExistingWritable(path)
    writable.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a migrated index and a freshly created one have the same session columns', () => {
  const migrated = temporaryPath()
  const fresh = temporaryPath()
  try {
    writeV1Index(migrated.path)
    IndexDb.open(migrated.path, false).close()
    IndexDb.open(fresh.path).close()
    expect(sessionColumns(migrated.path)).toEqual(sessionColumns(fresh.path))
    expect(tableNames(migrated.path)).toEqual(tableNames(fresh.path))
    expect(storedVersion(fresh.path)).toBe('4')
  } finally {
    rmSync(migrated.dir, { recursive: true, force: true })
    rmSync(fresh.dir, { recursive: true, force: true })
  }
})

test('a version 1 index stays usable by the commands that cannot migrate it', () => {
  const { dir, path } = temporaryPath()
  try {
    writeV1Index(path)

    // doctor and last open readonly: they must read the older index as it is.
    const readonly = IndexDb.openReadonly(path)
    try {
      expect(readonly.schemaVersion()).toBe(1)
      expect(readonly.searchRefs().map((row) => row.uid)).toEqual(['claude:old'])
      expect(readonly.getRef('claude:old')?.degraded).toBe(false)
    } finally {
      readonly.close()
    }
    expect(storedVersion(path)).toBe('1')

    // forget and prune open writable without migrating, and still delete.
    const writable = IndexDb.openExistingWritable(path)
    try {
      writable.deleteSession('claude:old')
      expect(writable.allUids()).toEqual([])
    } finally {
      writable.close()
    }
    expect(storedVersion(path)).toBe('1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a migration step that fails leaves the version it started from', () => {
  const { dir, path } = temporaryPath()
  try {
    // Stamped as version 1 but without the table the next step alters: the step
    // must roll back whole rather than stamping a version the file lacks.
    const raw = new Database(path, { create: true })
    raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    raw.query('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1')
    raw.close()

    expect(() => IndexDb.open(path, false)).toThrow()
    expect(storedVersion(path)).toBe('1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('a real version 2 index migrates to the current schema with every row and flag intact', () => {
  const { dir, path } = temporaryPath()
  try {
    writeV2Index(path)
    expect(tableNames(path)).not.toContain('session_turn')

    const db = IndexDb.open(path, false)
    try {
      expect(storedVersion(path)).toBe('4')
      expect(db.schemaVersion()).toBe(4)
      // The version 3 step only adds a table; version 4 adds both a table and
      // the two file-detail columns.
      expect(sessionColumns(path)).toEqual([...V1_COLUMNS, 'degraded', 'file_detail', 'file_events_truncated'])
      expect(tableNames(path)).toContain('session_turn')
      expect(tableNames(path)).toContain('session_file_event')
      expect(
        (db.raw().query('PRAGMA table_info(session_turn)').all() as Array<{ name: string }>)
          .map((row) => row.name),
      ).toEqual(['uid', 'ordinal', 'role', 'text'])

      const stored = db.getRef('claude:two')!
      expect(stored.title).toBe('An indexed v2 session')
      expect(stored.turns).toBe(9)
      expect(stored.sourcePaths).toEqual(['/b.jsonl'])
      expect(stored.fingerprint).toBe('fp-v2')
      expect(stored.missing).toBe(false)
      // Both split flags survive the step that only added a table.
      expect(stored.truncated).toBe(true)
      expect(stored.degraded).toBe(true)

      expect(db.allUids()).toEqual(['claude:two'])
      expect(db.ftsSearch('legacytwoprompt').map((hit) => hit.uid)).toEqual(['claude:two'])
      expect(db.uidsTouchingFile('src/legacy-two')).toEqual(['claude:two'])
      // Nothing to show until the session is hydrated again.
      expect(db.raw().query('SELECT * FROM session_turn').all()).toEqual([])
    } finally {
      db.close()
    }

    // The migrated file passes the strict validation the mutating commands do.
    const writable = IndexDb.openExistingWritable(path)
    writable.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an index whose stamp disagrees with its shape is refused instead of stamped current', () => {
  const { dir, path } = temporaryPath()
  try {
    // A real state reachable from an unreleased development branch: stamped 2,
    // already carrying `session_turn`, but never given the `degraded` column.
    // `migrate` trusts the stamp, so it replays the version 3 step as a no-op
    // create and then genuinely runs the version 4 step before validation
    // catches the missing column.
    writeV1Index(path)
    const raw = new Database(path)
    try {
      raw.query("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run()
      raw.exec(`
        CREATE TABLE session_turn (
          uid TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          PRIMARY KEY (uid, ordinal)
        )
      `)
    } finally {
      raw.close()
    }

    let opened: IndexDb | undefined
    try {
      expect(() => { opened = IndexDb.open(path, false) })
        .toThrow(/index schema columns do not match: session/)
      // The refusal is actionable: it names the file and the way out, and rules
      // out the command a user would otherwise try first.
      expect(() => { opened = IndexDb.open(path, false) }).toThrow(path)
      expect(() => { opened = IndexDb.open(path, false) }).toThrow('nekyia index')
      expect(() => { opened = IndexDb.open(path, false) }).toThrow('--rebuild')
    } finally {
      opened?.close()
    }

    // The column really is still missing, so every later open refuses too rather
    // than handing out an index that claims to be current. The version 4 step
    // did commit its own column additions before validation ran.
    expect(sessionColumns(path)).toEqual([...V1_COLUMNS, 'file_detail', 'file_events_truncated'])
    expect(() => IndexDb.open(path, false)).toThrow('index schema columns do not match: session')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a version 2 index stays usable by the commands that cannot migrate it', () => {
  const { dir, path } = temporaryPath()
  try {
    writeV2Index(path)

    const readonly = IndexDb.openReadonly(path)
    try {
      expect(readonly.schemaVersion()).toBe(2)
      expect(readonly.searchRefs().map((row) => row.uid)).toEqual(['claude:two'])
    } finally {
      readonly.close()
    }

    // forget and prune delete without migrating, so the delete must not touch a
    // table this index has no reason to have yet.
    const writable = IndexDb.openExistingWritable(path)
    try {
      expect(writable.schemaVersion()).toBe(2)
      writable.deleteSession('claude:two')
      expect(writable.allUids()).toEqual([])
      expect(writable.ftsSearch('legacytwoprompt')).toEqual([])
      expect(writable.uidsTouchingFile('src/legacy-two')).toEqual([])
    } finally {
      writable.close()
    }
    expect(storedVersion(path)).toBe('2')
    expect(tableNames(path)).not.toContain('session_turn')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const events: FileEvent[] = [
  { path: 'src/sse.ts', kind: 'read', turn: 2 },
  { path: 'src/sse.ts', kind: 'edit', turn: 5 },
  { path: 'test/sse.test.ts', kind: 'write', turn: 6 },
]
test('file events are stored in order with a dense ordinal', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r)
  db.upsertDoc(doc(r,{ fileEvents: events, fileDetail: 'ordered' }))
  const rows=db.raw().query('SELECT ordinal, turn, path, kind FROM session_file_event WHERE uid = ? ORDER BY ordinal').all('claude:abc')
  expect(rows).toEqual([
    { ordinal: 0, turn: 2, path: 'src/sse.ts', kind: 'read' },
    { ordinal: 1, turn: 5, path: 'src/sse.ts', kind: 'edit' },
    { ordinal: 2, turn: 6, path: 'test/sse.test.ts', kind: 'write' },
  ]); db.close()
})
test('re-hydrating replaces the event log rather than appending to it', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r)
  db.upsertDoc(doc(r,{ fileEvents: events, fileDetail: 'ordered' }))
  db.upsertDoc(doc(r,{ fileEvents: [{ path: 'a.ts', kind: 'edit', turn: 0 }], fileDetail: 'ordered' }))
  const rows=db.raw().query('SELECT path FROM session_file_event WHERE uid = ?').all('claude:abc')
  expect(rows).toEqual([{ path: 'a.ts' }]); db.close()
})
test('a document with no events reads as paths detail, never unknown', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r); db.upsertDoc(doc(r))
  const row=db.raw().query('SELECT file_detail FROM session WHERE uid = ?').get('claude:abc')
  expect(row).toEqual({ file_detail: 'paths' }); db.close()
})
test('the event cap flag is stored without touching truncated', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r)
  db.upsertDoc(doc(r,{ fileEvents: events, fileDetail: 'ordered', fileEventsTruncated: true }))
  const row=db.raw().query('SELECT truncated, file_events_truncated FROM session WHERE uid = ?').get('claude:abc')
  expect(row).toEqual({ truncated: 0, file_events_truncated: 1 }); db.close()
})
test('an event with an unrecognised kind is dropped rather than stored', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r)
  db.upsertDoc(doc(r,{ fileEvents: [{ path: 'a.ts', kind: 'sideways' as FileEventKind, turn: 0 }], fileDetail: 'ordered' }))
  expect(db.raw().query('SELECT COUNT(*) AS n FROM session_file_event').get()).toEqual({ n: 0 }); db.close()
})
test('forget removes a session event log', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r)
  db.upsertDoc(doc(r,{ fileEvents: events, fileDetail: 'ordered' })); db.deleteSession('claude:abc')
  expect(db.raw().query('SELECT COUNT(*) AS n FROM session_file_event').get()).toEqual({ n: 0 }); db.close()
})

test('uidsUnderPrefix matches a directory exactly, not its case-folded neighbours', () => {
  const db=IndexDb.open(':memory:')
  const entries: Array<[string, string]> = [
    ['claude:under', '/root/Proj/src/a.ts'],
    ['claude:cased', '/root/PROJ/src/a.ts'],
    ['claude:sibling', '/root/Project/src/a.ts'],
  ]
  for (const [uid, file] of entries) {
    const r=ref({ uid, nativeId: uid, cwd: null })
    db.upsertRef(r)
    db.upsertDoc(doc(r, { files: [file], fileEvents: [{ path: file, kind: 'edit', turn: 0 }], fileDetail: 'ordered' }))
  }
  // A range predicate compares bytes, so it neither folds case the way `LIKE`
  // did nor reaches into the directory next door.
  expect(db.uidsUnderPrefix('/root/Proj')).toEqual(['claude:under'])
})
test('uidsUnderPrefix under a root does not grow a second slash', () => {
  const db=IndexDb.open(':memory:')
  const r=ref({ uid: 'claude:rooted', nativeId: 'rooted', cwd: null })
  db.upsertRef(r)
  db.upsertDoc(doc(r, { files: ['/etc/hosts'], fileEvents: [{ path: '/etc/hosts', kind: 'read', turn: 0 }], fileDetail: 'ordered' }))
  expect(db.uidsUnderPrefix('/')).toEqual(['claude:rooted'])
  db.close()
})
test('uidsUnderPrefix is served by the path indices rather than scanning', () => {
  const db=IndexDb.open(':memory:')
  const plans = ['session_file_event', 'session_file'].map((table) => (
    db.raw().query(
      `EXPLAIN QUERY PLAN SELECT DISTINCT uid FROM ${table} WHERE path >= ? AND path < ?`,
    ).all('/root/proj/', '/root/proj0') as Array<{ detail: string }>
  ).map((row) => row.detail).join(' '))
  // A prefix `LIKE` scanned both tables here, because SQLite only turns one
  // into a range when the column collation matches `case_sensitive_like`.
  expect(plans[0]).toContain('USING INDEX session_file_event_path_idx')
  expect(plans[1]).toContain('USING INDEX session_file_path_idx')
  db.close()
})
