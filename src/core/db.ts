import Database from 'bun:sqlite'
import { lstatSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DialogueTurn, SessionDoc, SessionRef } from '../types'

export interface StoredRef extends SessionRef {
  missing: boolean
}

export interface FtsHit {
  uid: string
  score: number
}

const SCHEMA_VERSION = 2

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
}

interface TextRow {
  rowid: number
  title: string
  prompts: string
  prose: string
}

export function rowToRef(row: SessionRow): StoredRef {
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
    sourcePaths: JSON.parse(row.source_paths) as string[],
    fingerprint: row.fingerprint,
    missing: Boolean(row.missing),
  }
}

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

  private static validateSchema(db: Database, version: number): void {
    const stored = db.query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string | null } | null
    if (!stored || stored.value !== String(version)) {
      throw new Error(`unsupported schema version: ${String(stored?.value ?? 'missing')}`)
    }

    const expected: Record<string, string[]> = {
      meta: ['key', 'value'],
      session: [
        'uid', 'client', 'native_id', 'cwd', 'git_branch', 'title', 'started_at', 'ended_at',
        'turns', 'parent_native_id', 'tier', 'origin', 'source_paths', 'fingerprint', 'missing',
        'truncated', 'hydrated',
      ],
      session_text: ['rowid', 'uid', 'title', 'prompts', 'prose'],
      session_fts: ['title', 'prompts', 'prose'],
      session_file: ['uid', 'path'],
    }
    if (version >= 2) expected.session_turn = ['uid', 'ordinal', 'role', 'text']
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
  }

  private static validateExistingSchema(db: Database): void {
    IndexDb.validateSchema(db, SCHEMA_VERSION)
  }

  /** Opens a validated existing Nekyia index for mutation without migration or PRAGMA writes. */
  static openExistingWritable(path: string): IndexDb {
    if (path === ':memory:') throw new Error('existing in-memory index is unsupported')
    IndexDb.validatePath(path, false)
    // A read-only preflight ensures foreign/newer files are never opened by a
    // writable SQLite connection at all.
    const inspection = new Database(path, { readonly: true, strict: true })
    try {
      IndexDb.validateExistingSchema(inspection)
    } finally {
      inspection.close()
    }
    IndexDb.validatePath(path, false)
    const db = new Database(path, { readwrite: true, create: false, strict: true })
    try {
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
      const hasMeta = db.query(`
        SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'
      `).get() !== null
      if (!hasMeta) throw new Error('index schema metadata is missing')
      const stored = db.query("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value: string | null } | null
      if (!stored || stored.value !== String(SCHEMA_VERSION)) {
        throw new Error(`unsupported schema version: ${String(stored?.value ?? 'missing')}`)
      }
      return new IndexDb(db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  private migrate(): void {
    const hasMeta = this.db.query(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'meta'
    `).get() !== null
    const stored = hasMeta
      ? this.db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string | null } | null
      : null

    let version = 0
    if (stored) {
      if (stored.value === null || !/^\d+$/.test(stored.value)) {
        throw new Error(`invalid schema version: ${String(stored.value)}`)
      }
      version = Number(stored.value)
      if (!Number.isSafeInteger(version)) throw new Error(`invalid schema version: ${stored.value}`)
    }
    if (version > SCHEMA_VERSION) throw new Error(`unsupported schema version: ${version}`)
    if (version > 0) IndexDb.validateSchema(this.db, version)
    if (version === SCHEMA_VERSION) return

    this.db.transaction(() => {
      this.db.exec(`
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
        CREATE TABLE IF NOT EXISTS session_turn (
          uid TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          PRIMARY KEY (uid, ordinal)
        );
        CREATE INDEX IF NOT EXISTS session_turn_uid_idx ON session_turn(uid);
      `)
      this.db.query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(SCHEMA_VERSION))
    })()
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

    this.db.query('DELETE FROM session_turn WHERE uid = ?').run(doc.ref.uid)
    const insertTurn = this.db.query(
      'INSERT INTO session_turn (uid, ordinal, role, text) VALUES (?, ?, ?, ?)',
    )
    const dialogue = Array.isArray(doc.dialogue) ? doc.dialogue : []
    let ordinal = 0
    for (const turn of dialogue) {
      if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')
        || typeof turn.text !== 'string' || turn.text.length === 0) continue
      insertTurn.run(doc.ref.uid, ordinal++, turn.role, turn.text)
    }

    this.db.query('UPDATE session SET hydrated = 1, truncated = ? WHERE uid = ?')
      .run(doc.truncated ? 1 : 0, doc.ref.uid)
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
      const deleteTurn = this.db.query('DELETE FROM session_turn WHERE uid = ?')
      const deleteRef = this.db.query('DELETE FROM session WHERE uid = ?')

      for (const value of new Set(values)) {
        const old = readText.get(value) as TextRow | null
        if (old) {
          deleteFts.run(old.rowid, old.title, old.prompts, old.prose)
          deleteText.run(value)
        }
        deleteFile.run(value)
        deleteTurn.run(value)
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

  raw(): Database {
    return this.db
  }

  close(): void {
    this.db.close()
  }
}
