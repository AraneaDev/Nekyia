import Database from 'bun:sqlite'
import { lstatSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SessionDoc, SessionRef } from '../types'

/**
 * A session as the index holds it: the discovered reference, whether its source
 * has since disappeared, and what hydration could not carry over.
 */
export interface StoredRef extends SessionRef {
  missing: boolean
  /** A size cap stopped indexing short of the whole session. Raising `maxFileBytes` can recover it. */
  truncated: boolean
  /** Content was lost to a parse or read failure rather than to a cap, so no setting recovers it. */
  degraded: boolean
}

/** One full-text match: the session it belongs to and its weighted relevance. */
export interface FtsHit {
  uid: string
  score: number
}

const SCHEMA_VERSION = 2
/** The oldest stamped schema this build still opens. Older indexes are migrated up to SCHEMA_VERSION. */
const MIN_SCHEMA_VERSION = 1
/** How long a statement waits for another process's lock; SQLite otherwise gives up instantly. */
const BUSY_TIMEOUT_MS = 5_000

/** The whole schema as version 1 shipped it, kept verbatim as the first rung of the ladder. */
const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS session (
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
  CREATE INDEX IF NOT EXISTS session_cwd_idx ON session(cwd);
  CREATE INDEX IF NOT EXISTS session_ended_at_idx ON session(ended_at DESC);
  CREATE TABLE IF NOT EXISTS session_text (
    rowid INTEGER PRIMARY KEY,
    uid TEXT UNIQUE NOT NULL,
    title TEXT,
    prompts TEXT,
    prose TEXT
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
    title,
    prompts,
    prose,
    content='session_text',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );
  CREATE TABLE IF NOT EXISTS session_file (
    uid TEXT NOT NULL,
    path TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_file_uid_idx ON session_file(uid);
  CREATE INDEX IF NOT EXISTS session_file_path_idx ON session_file(path);
`

/**
 * One step per schema version: `MIGRATIONS[n]` takes an index from version n-1 to n.
 *
 * `migrate` runs every step above the stamped version in order, each in its own
 * transaction that stamps its own version as it commits, so an upgrade
 * interrupted halfway resumes at the step it stopped on rather than claiming a
 * version the file does not have. A brand new index walks the same ladder,
 * which is what keeps a freshly created database column-for-column identical to
 * a migrated one.
 *
 * Adding version 3 means adding a `3:` step here, a `3:` entry to
 * SESSION_COLUMNS, and raising SCHEMA_VERSION. Nothing else changes.
 */
const MIGRATIONS: Record<number, (db: Database) => void> = {
  1: (db) => { db.exec(SCHEMA_V1) },
  // Sessions indexed under version 1 recorded one conflated flag, so they keep
  // whatever `truncated` they were stamped with and start out not degraded.
  // The next hydration of each session writes the split values.
  2: (db) => { db.exec('ALTER TABLE session ADD COLUMN degraded INTEGER NOT NULL DEFAULT 0') },
}

const SESSION_COLUMNS_V1 = [
  'uid', 'client', 'native_id', 'cwd', 'git_branch', 'title', 'started_at', 'ended_at',
  'turns', 'parent_native_id', 'tier', 'origin', 'source_paths', 'fingerprint', 'missing',
  'truncated', 'hydrated',
]

/**
 * The `session` columns each schema version leaves behind, in the order SQLite reports them.
 *
 * A migrated index and a newly created one agree because both walk the same
 * ladder: ADD COLUMN appends, and the create step is the version 1 schema.
 */
const SESSION_COLUMNS: Record<number, string[]> = {
  1: SESSION_COLUMNS_V1,
  2: [...SESSION_COLUMNS_V1, 'degraded'],
}

/**
 * Reads the stamped schema version, or 0 for an index that has never been stamped.
 *
 * A value that is not a plain safe integer is a corrupt or foreign stamp rather
 * than a version this build could reason about, so it throws instead of being
 * coerced into one.
 */
function storedSchemaVersion(db: Database): number {
  const hasMeta = db.query(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'
  `).get() !== null
  if (!hasMeta) return 0
  const stored = db.query("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string | null } | null
  if (!stored) return 0
  if (stored.value === null || !/^\d+$/.test(stored.value)) {
    throw new Error(`invalid schema version: ${String(stored.value)}`)
  }
  const version = Number(stored.value)
  if (!Number.isSafeInteger(version)) throw new Error(`invalid schema version: ${stored.value}`)
  return version
}

/**
 * Narrows a stamped version to one this build can work with.
 *
 * Unstamped and newer-than-us are both refused here; older but known versions
 * are returned as they are, because the paths that cannot migrate still read
 * them correctly and the paths that can migrate them will.
 */
function supportedVersion(version: number): number {
  if (version < MIN_SCHEMA_VERSION || version > SCHEMA_VERSION) {
    throw new Error(`unsupported schema version: ${version === 0 ? 'missing' : version}`)
  }
  return version
}

interface SessionRow {
  uid: string
  client: string
  native_id: string
  cwd: string | null
  git_branch: string | null
  title: string | null
  started_at: number
  ended_at: number
  turns: number | null
  parent_native_id: string | null
  tier: SessionRef['tier']
  origin: SessionRef['origin']
  source_paths: string
  fingerprint: string
  missing: number
  truncated: number
  /** Absent from a version 1 index, which had no column for it. */
  degraded?: number
}

interface TextRow {
  rowid: number
  title: string
  prompts: string
  prose: string
}

/**
 * Reads the stored provenance, degrading to no known source when the column is unreadable.
 *
 * The field is written as a JSON array by this module, but a truncated write or
 * a hand-edited index would otherwise throw a SyntaxError out of every read that
 * maps rows through here, including a search over the whole table.
 */
function parseSourcePaths(value: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) return []
  return parsed as string[]
}

/**
 * A stored session without its provenance: what a search actually consumes.
 *
 * `sourcePaths` and `fingerprint` exist for discovery and hydration, which
 * resolve a session back to the files it came from. A search reads every row in
 * the index on every keystroke and reads neither field, so it selects the
 * narrower shape rather than paying a JSON parse per row for values it drops.
 *
 * `truncated` and `degraded` are left out for the same reason: nothing a result
 * row renders mentions them, and only the handover, which reads one session at a
 * time through `getRef`, has anything to say about them. Leaving them out also
 * keeps the select list identical to the one a version 1 index answers, so a
 * search over an index this build has not migrated yet still works.
 */
export type SearchRef = Omit<StoredRef, 'sourcePaths' | 'fingerprint' | 'truncated' | 'degraded'>

type SearchRow = Omit<SessionRow, 'source_paths' | 'fingerprint' | 'truncated' | 'degraded'>

/** The columns `searchRefs` selects, in the order `SearchRow` declares them. */
const SEARCH_COLUMNS = `
  uid, client, native_id, cwd, git_branch, title, started_at, ended_at,
  turns, parent_native_id, tier, origin, missing
`

/** Maps the narrow index row onto the shared session shape, keeping snake_case confined to this module. */
function rowToSearchRef(row: SearchRow): SearchRef {
  return {
    uid: row.uid,
    client: row.client,
    nativeId: row.native_id,
    cwd: row.cwd,
    gitBranch: row.git_branch,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    turns: row.turns,
    parentNativeId: row.parent_native_id,
    tier: row.tier,
    origin: row.origin,
    missing: Boolean(row.missing),
  }
}

/**
 * Maps a raw index row onto the full stored shape, provenance included.
 *
 * `degraded` is absent from a version 1 row, which is read as false: that index
 * recorded no read failures separately from size caps.
 */
export function rowToRef(row: SessionRow): StoredRef {
  return {
    ...rowToSearchRef(row),
    sourcePaths: parseSourcePaths(row.source_paths),
    fingerprint: row.fingerprint,
    truncated: Boolean(row.truncated),
    degraded: Boolean(row.degraded),
  }
}

/**
 * Owns the SQLite index: schema, migrations, and every read and write.
 *
 * Metadata and search facets are committed together per session, so a
 * half-hydrated session is never visible to a query.
 */
export class IndexDb {
  private constructor(private readonly db: Database) {}

  private static validatePath(path: string, create: boolean): void {
    if (path === ':memory:') return
    const parent = dirname(path)
    if (create) mkdirSync(parent, { recursive: true })
    // This closes the ordinary final-component symlink case. A hostile actor
    // with write access to the parent can still swap it after lstat and before
    // SQLite opens the path; fully eliminating that TOCTOU needs fd-relative
    // database opening, which bun:sqlite does not expose.
    const parentInfo = lstatSync(parent)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new Error('database parent is not a safe directory')
    }
    try {
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error('database path is not a regular file')
      }
    } catch (error) {
      const missing = typeof error === 'object' && error !== null
        && 'code' in error && error.code === 'ENOENT'
      if (!missing || !create) throw error
    }
  }

  static open(path: string, create = true): IndexDb {
    IndexDb.validatePath(path, create)

    const db = new Database(path, { readwrite: true, create })
    try {
      db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`)
      db.exec('PRAGMA journal_mode=WAL')
      db.exec('PRAGMA synchronous=NORMAL')

      const index = new IndexDb(db)
      index.migrate()
      return index
    } catch (error) {
      db.close()
      throw error
    }
  }

  /**
   * Checks that a file really is a Nekyia index at a version this build reads.
   *
   * The column list is the one that version leaves behind rather than the
   * newest one, so an index a migrating command has not reached yet is
   * recognised instead of being rejected as foreign. Returns the version it
   * validated against.
   */
  private static validateExistingSchema(db: Database): number {
    const version = supportedVersion(storedSchemaVersion(db))

    const expected: Record<string, string[]> = {
      meta: ['key', 'value'],
      session: SESSION_COLUMNS[version]!,
      session_text: ['rowid', 'uid', 'title', 'prompts', 'prose'],
      session_fts: ['title', 'prompts', 'prose'],
      session_file: ['uid', 'path'],
    }
    for (const [table, columns] of Object.entries(expected)) {
      const object = db.query(
        "SELECT type FROM sqlite_master WHERE name = ? AND type = 'table'",
      ).get(table) as { type: string } | null
      if (!object) throw new Error(`index schema table is missing: ${table}`)
      // Table names are internal constants, never caller input.
      const found = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      if (found.map((row) => row.name).join('\0') !== columns.join('\0')) {
        throw new Error(`index schema columns do not match: ${table}`)
      }
    }
    const fts = db.query("SELECT sql FROM sqlite_master WHERE name = 'session_fts'")
      .get() as { sql: string | null } | null
    const ftsSql = fts?.sql?.replace(/\s+/g, ' ').toLowerCase() ?? ''
    if (!ftsSql.startsWith('create virtual table session_fts using fts5(')
      || !ftsSql.includes("content='session_text'")
      || !ftsSql.includes("content_rowid='rowid'")) {
      throw new Error('index search schema does not match')
    }
    return version
  }

  /**
   * Opens a validated existing Nekyia index for mutation without migration or PRAGMA writes.
   *
   * An index stamped at an older supported version is opened at that version:
   * `forget` and `prune` only delete rows, so neither has a reason to force a
   * schema upgrade onto a file the user asked it to remove something from.
   */
  static openExistingWritable(path: string): IndexDb {
    if (path === ':memory:') throw new Error('existing in-memory index is unsupported')
    IndexDb.validatePath(path, false)
    // A read-only preflight ensures foreign/newer files are never opened by a
    // writable SQLite connection at all.
    const inspection = new Database(path, { readonly: true, strict: true })
    try {
      // A connection-level setting, not a write to the file, so it is safe on a
      // foreign database and on a read-only handle.
      inspection.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`)
      IndexDb.validateExistingSchema(inspection)
    } finally {
      inspection.close()
    }
    IndexDb.validatePath(path, false)
    const db = new Database(path, { readwrite: true, create: false, strict: true })
    try {
      db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`)
      IndexDb.validateExistingSchema(db)
      return new IndexDb(db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  /** Opens an existing index without creating, migrating, journalling, or writing it. */
  static openReadonly(path: string): IndexDb {
    if (path === ':memory:') throw new Error('readonly in-memory index is unsupported')
    IndexDb.validatePath(path, false)
    const db = new Database(path, { readonly: true, strict: true })
    try {
      db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`)
      const hasMeta = db.query(`
        SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'
      `).get() !== null
      if (!hasMeta) throw new Error('index schema metadata is missing')
      // A readonly handle cannot migrate, so an older index it can still read is
      // opened as it is: refusing would take `doctor` and `last` away from a user
      // whose index simply has not been through a writing command yet.
      supportedVersion(storedSchemaVersion(db))
      return new IndexDb(db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  /**
   * Brings the open index up to SCHEMA_VERSION one version at a time.
   *
   * Every step commits with its own version stamp, so a crash between steps
   * leaves a consistent index that the next run resumes from.
   */
  private migrate(): void {
    let version = storedSchemaVersion(this.db)
    if (version > SCHEMA_VERSION) throw new Error(`unsupported schema version: ${version}`)

    while (version < SCHEMA_VERSION) {
      const next = version + 1
      const step = MIGRATIONS[next]
      if (!step) throw new Error(`no migration to schema version: ${next}`)
      this.db.transaction(() => {
        step(this.db)
        this.db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
          .run('schema_version', String(next))
      })()
      version = next
    }
  }

  private writeRef(ref: SessionRef): void {
    this.db.query(`
      INSERT INTO session (
        uid, client, native_id, cwd, git_branch, title, started_at, ended_at,
        turns, parent_native_id, tier, origin, source_paths, fingerprint, missing
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(uid) DO UPDATE SET
        cwd = excluded.cwd,
        git_branch = excluded.git_branch,
        title = excluded.title,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        turns = excluded.turns,
        parent_native_id = excluded.parent_native_id,
        tier = excluded.tier,
        origin = excluded.origin,
        source_paths = excluded.source_paths,
        fingerprint = excluded.fingerprint,
        missing = 0
    `).run(
      ref.uid,
      ref.client,
      ref.nativeId,
      ref.cwd,
      ref.gitBranch,
      ref.title,
      ref.startedAt,
      ref.endedAt,
      ref.turns,
      ref.parentNativeId,
      ref.tier,
      ref.origin,
      JSON.stringify(ref.sourcePaths),
      ref.fingerprint,
    )
  }

  upsertRef(ref: SessionRef): void {
    this.writeRef(ref)
  }

  private writeDoc(doc: SessionDoc): void {
    const old = this.db.query(
      'SELECT rowid, title, prompts, prose FROM session_text WHERE uid = ?',
    ).get(doc.ref.uid) as TextRow | null

    if (old) {
      this.db.query(`
        INSERT INTO session_fts(session_fts, rowid, title, prompts, prose)
        VALUES ('delete', ?, ?, ?, ?)
      `).run(old.rowid, old.title, old.prompts, old.prose)
      this.db.query('DELETE FROM session_text WHERE uid = ?').run(doc.ref.uid)
    }

    const title = doc.ref.title ?? ''
    const prompts = doc.prompts.join('\n')
    const prose = doc.prose.join('\n')
    const inserted = this.db.query(
      'INSERT INTO session_text (uid, title, prompts, prose) VALUES (?, ?, ?, ?)',
    ).run(doc.ref.uid, title, prompts, prose)

    this.db.query(`
      INSERT INTO session_fts(rowid, title, prompts, prose) VALUES (?, ?, ?, ?)
    `).run(inserted.lastInsertRowid, title, prompts, prose)

    this.db.query('DELETE FROM session_file WHERE uid = ?').run(doc.ref.uid)
    const insertFile = this.db.query('INSERT INTO session_file (uid, path) VALUES (?, ?)')
    for (const path of new Set(doc.files)) insertFile.run(doc.ref.uid, path)

    this.db.query('UPDATE session SET hydrated = 1, truncated = ?, degraded = ? WHERE uid = ?')
      .run(doc.truncated ? 1 : 0, doc.degraded ? 1 : 0, doc.ref.uid)
  }

  upsertDoc(doc: SessionDoc): void {
    this.db.transaction((value: SessionDoc) => {
      this.writeDoc(value)
    })(doc)
  }

  /** Persists discovery metadata and hydrated facets as one retry-safe transaction. */
  upsertHydrated(doc: SessionDoc): void {
    this.db.transaction((value: SessionDoc) => {
      this.writeRef(value.ref)
      this.writeDoc(value)
    })(doc)
  }

  /**
   * Every indexed session in the shape a search consumes.
   *
   * The provenance columns are left out of the SELECT as well as the mapping,
   * so a search over the whole table never reads or parses them.
   */
  searchRefs(): SearchRef[] {
    // Column list is an internal constant, never caller input.
    const rows = this.db.query(`SELECT ${SEARCH_COLUMNS} FROM session`).all() as SearchRow[]
    return rows.map(rowToSearchRef)
  }

  getRef(uid: string): StoredRef | null {
    const row = this.db.query('SELECT * FROM session WHERE uid = ?').get(uid) as SessionRow | null
    return row ? rowToRef(row) : null
  }

  getFingerprints(): Map<string, string> {
    const rows = this.db.query('SELECT uid, fingerprint FROM session').all() as Array<{
      uid: string
      fingerprint: string
    }>
    return new Map(rows.map((row) => [row.uid, row.fingerprint]))
  }

  getMissingUids(): Set<string> {
    const rows = this.db.query('SELECT uid FROM session WHERE missing = 1').all() as Array<{
      uid: string
    }>
    return new Set(rows.map((row) => row.uid))
  }

  allUids(): string[] {
    const rows = this.db.query('SELECT uid FROM session ORDER BY uid').all() as Array<{ uid: string }>
    return rows.map((row) => row.uid)
  }

  ftsSearch(query: string): FtsHit[] {
    return this.db.query(`
      SELECT st.uid, -bm25(session_fts, 8.0, 4.0, 1.0) AS score
      FROM session_fts
      JOIN session_text AS st ON st.rowid = session_fts.rowid
      WHERE session_fts MATCH ?
      ORDER BY score DESC
    `).all(query) as FtsHit[]
  }

  uidsTouchingFile(fragment: string): string[] {
    const literal = fragment.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
    const rows = this.db.query(`
      SELECT DISTINCT uid FROM session_file WHERE path LIKE ? ESCAPE '\\' ORDER BY uid
    `).all(`%${literal}%`) as Array<{ uid: string }>
    return rows.map((row) => row.uid)
  }

  deleteSession(uid: string): void {
    this.deleteSessions([uid])
  }

  /** Deletes all indexed facets for a set of sessions in one transaction. */
  deleteSessions(uids: string[]): void {
    this.db.transaction((values: string[]) => {
      const readText = this.db.query(
        'SELECT rowid, title, prompts, prose FROM session_text WHERE uid = ?',
      )
      const deleteFts = this.db.query(`
        INSERT INTO session_fts(session_fts, rowid, title, prompts, prose)
        VALUES ('delete', ?, ?, ?, ?)
      `)
      const deleteText = this.db.query('DELETE FROM session_text WHERE uid = ?')
      const deleteFile = this.db.query('DELETE FROM session_file WHERE uid = ?')
      const deleteRef = this.db.query('DELETE FROM session WHERE uid = ?')

      for (const value of new Set(values)) {
        const old = readText.get(value) as TextRow | null
        if (old) {
          deleteFts.run(old.rowid, old.title, old.prompts, old.prose)
          deleteText.run(value)
        }
        deleteFile.run(value)
        deleteRef.run(value)
      }
    })(uids)
  }

  markMissing(uids: string[]): void {
    this.db.transaction((values: string[]) => {
      const update = this.db.query('UPDATE session SET missing = 1 WHERE uid = ?')
      for (const uid of values) update.run(uid)
    })(uids)
  }

  /** The schema version of the open index, which is below SCHEMA_VERSION only on a path that cannot migrate. */
  schemaVersion(): number {
    return storedSchemaVersion(this.db)
  }

  raw(): Database {
    return this.db
  }

  close(): void {
    this.db.close()
  }
}
