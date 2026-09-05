import { createHash } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Config } from '../config'
import type { Diagnostic, SessionDoc, SessionRef } from '../types'
import { MAX_SESSION_FILES, isSafeNativeId, makeUid } from '../types'
import type { FormatModule } from './jsonl-transcript'
import { collectPaths } from './paths'

/**
 * Represents a row retrieved from a SQLite database, where keys are column names.
 */
type SqlRow = Record<string, unknown>
const MAX_PROJECTED_JSON_BYTES = 4 * 1024 * 1024

/**
 * Normalizes a value to a string, returning null if it is empty, not a string, or contains null bytes.
 */
function sensibleString(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) return null
  return value.trim()
}

/**
 * Reads a timestamp in the unit a manifest declares, or null when it cannot be trusted.
 *
 * Exported so the legacy JSON reader honours the same manifest's `timeUnit`
 * exactly as this one does, rather than assuming milliseconds of its own.
 */
export function parseSqlTimeNullable(
  value: unknown,
  unit: 'ms' | 's' | 'iso' = 'ms',
): number | null {
  if (unit === 'ms' || unit === 's') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    const timestamp = unit === 's' ? value * 1000 : value
    return Number.isFinite(timestamp) && Math.abs(timestamp) <= Number.MAX_SAFE_INTEGER
      ? timestamp
      : null
  }

  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(trimmed)) {
    return null
  }
  const normalized = trimmed
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:?\d{2}$)/, '$1')
  const timestamp = Date.parse(normalized)
  return Number.isFinite(timestamp) ? timestamp : null
}

/**
 * Reads a timestamp in the unit a manifest declares, returning 0 for anything it cannot trust.
 *
 * Zero means unknown rather than 1970: callers rank on it, so a bogus value
 * must sort as undated instead of impossibly old.
 */
export function parseSqlTime(
  value: unknown,
  unit: 'ms' | 's' | 'iso' = 'ms',
): number {
  return parseSqlTimeNullable(value, unit) ?? 0
}

/** Reads a working directory, unwrapping the file-URI array shape some clients store instead of a plain path. */
export function parseCwd(
  value: unknown,
  shape: 'plain' | 'file-uri-array' = 'plain',
): string | null {
  if (shape === 'plain') return sensibleString(value)
  if (typeof value !== 'string') return null

  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return null
    const first = sensibleString(parsed[0])
    if (first === null) return null
    if (!first.startsWith('file://')) return first
    return sensibleString(decodeURIComponent(first.slice('file://'.length)))
  } catch {
    return null
  }
}

/**
 * Constructs a Diagnostic object with the specified properties.
 */
function diagnostic(
  client: string,
  level: Diagnostic['level'],
  path: string,
  message: string,
): Diagnostic {
  return { client, level, path, message }
}

/**
 * Extracts a human-readable error message from an unknown error object.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Extracts a valid title or preview string from a database row.
 */
function titleFromRow(row: SqlRow): string | null {
  const title = sensibleString(row.title)
  return title ?? sensibleString(row.preview)
}

/**
 * Returns the value as a number if it is a finite number, otherwise returns null.
 */
function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Returns a minimal empty SessionDoc for a given SessionRef.
 */
function emptyDoc(ref: SessionRef): SessionDoc {
  return { ref, prompts: [], prose: [], files: [], truncated: false }
}

/**
 * Checks if a given path is located within a specified root directory.
 */
function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === ''
    || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

/**
 * Where a manifest's store turned out to be.
 *
 * `absent` and `unsafe` are deliberately not the same answer: a client that
 * was never used has nothing to report, while a path escaping the root is a
 * refusal the user should hear about.
 */
type DatabaseLocation =
  | { kind: 'ok'; path: string }
  | { kind: 'absent' }
  | { kind: 'unsafe' }

/**
 * Checks if an error indicates that a file or directory was not found.
 */
function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Safely locates a SQLite database file within an allowed root directory.
 */
function locateDatabase(root: string, file: string): DatabaseLocation {
  if (isAbsolute(file) || file.split(/[\\/]+/).includes('..')) return { kind: 'unsafe' }
  const lexicalRoot = resolve(root)
  const lexicalPath = resolve(lexicalRoot, file)
  if (!isWithin(lexicalRoot, lexicalPath)) return { kind: 'unsafe' }

  let realRoot: string
  let realPath: string
  try {
    realRoot = realpathSync(lexicalRoot)
  } catch (error) {
    return isNotFound(error) ? { kind: 'absent' } : { kind: 'unsafe' }
  }
  try {
    realPath = realpathSync(lexicalPath)
  } catch (error) {
    return isNotFound(error) ? { kind: 'absent' } : { kind: 'unsafe' }
  }
  return isWithin(realRoot, realPath) ? { kind: 'ok', path: realPath } : { kind: 'unsafe' }
}

/**
 * Strips trailing semicolons and whitespace from a SQL query string.
 */
function innerQuery(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '')
}

/**
 * Constructs a SQL query to project structured JSON messages and parts from the raw source table.
 */
function structuredProjection(sql: string, shape: 'opencode-part' | 'opencode-message-json'): string {
  const source = innerQuery(sql)
  if (shape === 'opencode-part') {
    return `
      WITH raw_source AS MATERIALIZED (${source}),
      ordered_source AS MATERIALIZED (
        SELECT row_number() OVER () AS source_ordinal, * FROM raw_source
      ),
      typed_source AS MATERIALIZED (
        SELECT
          source_ordinal,
          CASE WHEN json_valid(message_data) THEN message_data END AS message_json,
          CASE WHEN json_valid(part_data) THEN part_data END AS part_json,
          length(CAST(COALESCE(message_data, '') AS BLOB)) AS message_source_bytes,
          length(CAST(COALESCE(part_data, '') AS BLOB)) AS part_source_bytes
        FROM ordered_source
      ),
      source AS (
        SELECT
          source_ordinal,
          message_json,
          part_json,
          message_source_bytes + part_source_bytes AS full_source_bytes,
          -- A part query repeats its owning message once per part, so charging
          -- the message on every row would bill an N-part message N times and
          -- exhaust the caller's budget long before the transcript ends. Only
          -- the first row of each message pays for it, exactly as the
          -- opencode-message-json shape charges part 0.
          --
          -- A row whose message JSON is unusable, either invalid or carrying no
          -- id, has no identity to group on. The second partition key hands
          -- every such row a partition of its own, so it keeps paying per row:
          -- over-charging a message that cannot be identified is safer than
          -- collapsing all unidentifiable rows into one partition and charging
          -- the whole group once.
          CASE WHEN row_number() OVER (
            PARTITION BY
              json_extract(message_json, '$.id'),
              CASE WHEN json_extract(message_json, '$.id') IS NULL THEN source_ordinal END
            ORDER BY source_ordinal
          ) = 1 THEN message_source_bytes ELSE 0 END
            + part_source_bytes AS projected_source_bytes
        FROM typed_source
      )
      SELECT
        json_extract(message_json, '$.role') AS projected_role,
        json_extract(part_json, '$.type') AS projected_part_type,
        CASE
          WHEN json_extract(part_json, '$.type') = 'text'
            AND (
              json_extract(message_json, '$.role') = 'user'
              OR (
                json_extract(message_json, '$.role') = 'assistant'
                AND full_source_bytes <= ?2
              )
            )
          THEN json_extract(part_json, '$.text')
        END AS projected_text,
        CASE WHEN json_extract(part_json, '$.type') = 'tool'
          AND length(CAST(json_extract(part_json, '$.state.input') AS BLOB)) <= ?3
          THEN json_extract(part_json, '$.state.input')
        END AS projected_input,
        CASE WHEN json_extract(part_json, '$.type') = 'tool'
          AND length(CAST(json_extract(part_json, '$.state.input') AS BLOB)) > ?3
          THEN 1 ELSE 0
        END AS projected_input_oversized,
        projected_source_bytes
      FROM source
      ORDER BY source_ordinal
    `
  }

  return `
    WITH raw_source AS MATERIALIZED (${source}),
    ordered_source AS MATERIALIZED (
      SELECT row_number() OVER () AS source_ordinal, * FROM raw_source
    ),
    source AS (
      SELECT
        source_ordinal,
        CASE WHEN json_valid(data) THEN data END AS message_json,
        length(CAST(COALESCE(data, '') AS BLOB)) AS full_source_bytes
      FROM ordered_source
    ),
    expanded AS (
      SELECT
        source_ordinal,
        message_json,
        full_source_bytes,
        part.key AS part_key,
        part.value AS part_json
      FROM source
      JOIN json_each(message_json, '$.parts') AS part
      WHERE json_extract(message_json, '$.role') IN ('user', 'assistant')
    )
    SELECT
      json_extract(message_json, '$.role') AS projected_role,
      json_extract(part_json, '$.type') AS projected_part_type,
      CASE
        WHEN json_extract(part_json, '$.type') = 'text'
          AND (
            json_extract(message_json, '$.role') = 'user'
            OR (
              json_extract(message_json, '$.role') = 'assistant'
              AND full_source_bytes <= ?2
            )
          )
        THEN json_extract(part_json, '$.text')
      END AS projected_text,
      CASE WHEN json_extract(part_json, '$.type') = 'tool'
        AND length(CAST(json_extract(part_json, '$.state.input') AS BLOB)) <= ?3
        THEN json_extract(part_json, '$.state.input')
      END AS projected_input,
      CASE WHEN json_extract(part_json, '$.type') = 'tool'
        AND length(CAST(json_extract(part_json, '$.state.input') AS BLOB)) > ?3
        THEN 1 ELSE 0
      END AS projected_input_oversized,
      CASE WHEN CAST(part_key AS INTEGER) = 0 THEN full_source_bytes ELSE 0 END
        AS projected_source_bytes
    FROM expanded
    ORDER BY source_ordinal, CAST(part_key AS INTEGER)
  `
}

/**
 * Constructs a SQL query to project plain text messages directly from a column without parsing JSON.
 */
function plainProjection(db: Database, sql: string): string {
  const source = innerQuery(sql)
  const statement = db.query(source) as unknown as { columnNames: string[] }
  const column = statement.columnNames.includes('text')
    ? 'source.text'
    : statement.columnNames.includes('data')
      ? 'source.data'
      : 'NULL'
  return `
    WITH raw_source AS MATERIALIZED (${source}),
    source AS MATERIALIZED (
      SELECT row_number() OVER () AS source_ordinal, * FROM raw_source
    )
    SELECT
      source.role AS projected_role,
      CASE
        WHEN source.role = 'user' THEN ${column}
        WHEN source.role = 'assistant'
          AND length(CAST(COALESCE(${column}, '') AS BLOB)) <= ?2
        THEN ${column}
      END AS projected_text,
      NULL AS projected_part_type,
      NULL AS projected_input,
      0 AS projected_input_oversized,
      length(CAST(COALESCE(${column}, '') AS BLOB)) AS projected_source_bytes
    FROM source
    ORDER BY source_ordinal
  `
}

/**
 * Safely parses a projected JSON tool input string, enforcing size limits.
 */
function projectedInput(value: unknown): unknown | null {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_PROJECTED_JSON_BYTES) {
    return null
  }
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * Reads the paths a client recorded for one session, bounded and sanitised.
 *
 * The store belongs to the client, so blank and unusable values are dropped
 * rather than trusted, and passing the ceiling marks the document truncated
 * instead of silently keeping a partial list.
 */
function collectRecordedFiles(
  db: Database,
  sql: string,
  nativeId: string,
  into: Set<string>,
  onTruncated: () => void,
): void {
  for (const row of db.query(innerQuery(sql)).iterate(nativeId) as Iterable<SqlRow>) {
    if (into.size >= MAX_SESSION_FILES) {
      onTruncated()
      return
    }
    const path = sensibleString(row.path)
    if (path !== null) into.add(path)
  }
}

/** Reads SQLite-backed stores, projecting them onto Nekyia's model through the manifest's own SQL. */
/**
 * A fingerprint for the store as a whole, covering the write-ahead log.
 *
 * SQLite in WAL mode commits into a sidecar file and leaves the main database
 * untouched until a checkpoint, so a fingerprint taken from the main file alone
 * reads identically across a real edit and the session is never re-read. The
 * log is part of the database's current contents, so it is part of the answer
 * to "has any of this changed".
 *
 * A log that is absent, or cannot be stat'd, contributes a constant: journal
 * modes other than WAL keep everything in the main file, which is already here.
 */
function storeFingerprint(dbPath: string): string {
  const main = statSync(dbPath)
  let log = 'none'
  try {
    const wal = statSync(`${dbPath}-wal`)
    log = `${Math.floor(wal.mtimeMs)}:${wal.size}`
  } catch {
    // No log beside it, which is the whole story for a non-WAL database.
  }
  return `${Math.floor(main.mtimeMs)}:${main.size}:${log}`
}

/**
 * A fingerprint for one session, taken from the row the store reported for it.
 *
 * Every projected column counts, not only the declared revision: a title or a
 * turn count that moved is a session that moved, and the row is already in hand.
 * The declaration is what says the row can be trusted to move at all.
 */
function rowFingerprint(row: SqlRow): string {
  const stable = Object.keys(row).sort().map((key) => [key, row[key]])
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

export const sqliteStore: FormatModule = {
  /**
   * Discovers sessions in a SQLite database, resolving references and checking integrity.
   */
  async discover(manifest, root) {
    const spec = manifest.sqlite!
    const refs: SessionRef[] = []
    const diagnostics: Diagnostic[] = []
    const unresolvedPath = resolve(root, spec.file)
    const located = locateDatabase(root, spec.file)

    // An absent store means the client is installed but unused. Reporting that
    // would mark discovery non-authoritative, which switches off missing-session
    // pruning for a client that simply has no sessions.
    if (located.kind === 'absent') return { refs, diagnostics }

    if (located.kind === 'unsafe') {
      diagnostics.push(diagnostic(
        manifest.id,
        'warn',
        unresolvedPath,
        'database path is outside the manifest root',
      ))
      return { refs, diagnostics }
    }
    const dbPath = located.path

    let db: Database
    try {
      db = new Database(dbPath, { readonly: true })
    } catch (error) {
      diagnostics.push(diagnostic(
        manifest.id,
        'warn',
        dbPath,
        `open failed: ${errorMessage(error)}`,
      ))
      return { refs, diagnostics }
    }

    try {
      const storePrint = storeFingerprint(dbPath)
      const rows = db.query(spec.sessions).all() as SqlRow[]
      // A revision the projection does not actually return is a manifest
      // mistake, and the costly way to be wrong about it is to trust it: an
      // edit the row cannot express is an edit nothing notices. Say so and fall
      // back to the store-wide fingerprint, which only costs re-reads.
      const declared = spec.revision
      const perSession = declared !== undefined
        && (rows.length === 0 || Object.hasOwn(rows[0]!, declared))
      if (declared !== undefined && !perSession) {
        diagnostics.push(diagnostic(
          manifest.id,
          'warn',
          dbPath,
          `sqlite.revision names a column the session query does not return: ${declared}`,
        ))
      }
      for (const row of rows) {
        const fingerprint = perSession ? rowFingerprint(row) : storePrint
        const nativeId = sensibleString(row.id)
        if (nativeId === null) continue
        // The id is transcript content, so it can carry anything. One that
        // cannot round-trip through a uid would index a session that `forget`
        // then refuses to remove, so the session is dropped and reported. The
        // id itself is never echoed: it is the untrusted value.
        if (!isSafeNativeId(nativeId)) {
          diagnostics.push(diagnostic(
            manifest.id,
            'warn',
            dbPath,
            'session skipped: id is empty, over-long, or carries control or bidi characters',
          ))
          continue
        }
        const endedAt = parseSqlTimeNullable(row.ended_at, spec.timeUnit) ?? 0
        const parsedStartedAt = row.started_at === undefined
          ? null
          : parseSqlTimeNullable(row.started_at, spec.timeUnit)
        const parentNativeId = sensibleString(row.parent_id)
        const cwdValue = row.cwd_uris ?? row.cwd
        const cwdShape = row.cwd_uris == null
          ? 'plain'
          : (spec.cwdShape ?? 'file-uri-array')

        refs.push({
          uid: makeUid(manifest.id, nativeId),
          client: manifest.id,
          nativeId,
          cwd: parseCwd(cwdValue, cwdShape),
          gitBranch: sensibleString(row.branch),
          title: titleFromRow(row),
          startedAt: parsedStartedAt ?? endedAt,
          endedAt,
          turns: optionalNumber(row.turns),
          parentNativeId,
          tier: manifest.tier,
          origin: 'manifest',
          sourcePaths: [dbPath],
          fingerprint,
        })
      }
    } catch (error) {
      diagnostics.push(diagnostic(
        manifest.id,
        'error',
        dbPath,
        `sessions query failed: ${errorMessage(error)}`,
      ))
    } finally {
      db.close()
    }

    return { refs, diagnostics }
  },

  /**
   * Reads a session's content from the database and constructs a populated SessionDoc.
   */
  async hydrate(manifest, root, ref, config: Config) {
    const spec = manifest.sqlite!
    if (!spec.text && !spec.files) return emptyDoc(ref)
    const located = locateDatabase(root, spec.file)
    if (located.kind !== 'ok') return emptyDoc(ref)
    const dbPath = located.path

    const prompts: string[] = []
    const prose: string[] = []
    const files = new Set<string>()
    const maxBytes = Number.isFinite(config.maxFileBytes)
      ? Math.max(0, Math.floor(config.maxFileBytes))
      : 0
    let consumedBytes = 0
    let truncated = false
    let degraded = false
    const db = new Database(dbPath, { readonly: true })

    try {
      if (spec.files) collectRecordedFiles(db, spec.files, ref.nativeId, files, () => { truncated = true })
      if (!spec.text) return { ref, prompts, prose, files: [...files], truncated, degraded }
      const isStructured = spec.textShape === 'opencode-part'
        || spec.textShape === 'opencode-message-json'
      const query = isStructured
        ? structuredProjection(spec.text, spec.textShape as 'opencode-part' | 'opencode-message-json')
        : plainProjection(db, spec.text)
      // SQLite necessarily materializes each source row internally, but the outer
      // projection prevents private output from crossing into JavaScript. iterate()
      // also prevents the small projected rows from accumulating in an array.
      const statement = db.query(query)
      const rows = isStructured
        ? statement.iterate(ref.nativeId, maxBytes, MAX_PROJECTED_JSON_BYTES)
        : statement.iterate(ref.nativeId, maxBytes)
      for (const row of rows as Iterable<SqlRow>) {
        const bytes = typeof row.projected_source_bytes === 'number'
          && Number.isFinite(row.projected_source_bytes)
          && row.projected_source_bytes >= 0
          ? row.projected_source_bytes
          : 0
        const withinBudget = consumedBytes <= maxBytes - bytes
        if (!withinBudget) truncated = true
        consumedBytes = withinBudget ? consumedBytes + bytes : maxBytes

        const role = row.projected_role
        const text = sensibleString(row.projected_text)
        if (text && role === 'user') prompts.push(text)
        else if (text && withinBudget) prose.push(text)

        if (row.projected_part_type === 'tool') {
          if (row.projected_input_oversized === 1) truncated = true
          const input = projectedInput(row.projected_input)
          // The projection nulls an oversized input, so a value that survived it
          // and still would not parse is malformed rather than too large.
          if (input === null && row.projected_input != null) degraded = true
          if (input !== null) {
            for (const path of collectPaths(input)) {
              // The same ceiling collectRecordedFiles enforces. Tool inputs are
              // the unguarded path most likely to run away, and stopping
              // silently would hide a partial file list behind a complete one.
              if (files.size >= MAX_SESSION_FILES) {
                truncated = true
                break
              }
              files.add(path)
            }
          }
        }
      }
    } finally {
      db.close()
    }

    return { ref, prompts, prose, files: [...files], truncated, degraded }
  },
}
