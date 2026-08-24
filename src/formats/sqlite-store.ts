import { Database } from 'bun:sqlite'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Config } from '../config'
import type { Manifest } from '../manifests/load'
import type { Diagnostic, SessionDoc, SessionRef } from '../types'
import { makeUid } from '../types'
import type { FormatModule } from './jsonl-transcript'
import { collectPaths } from './paths'

type SqlRow = Record<string, unknown>
const MAX_PROJECTED_JSON_BYTES = 4 * 1024 * 1024

function sensibleString(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) return null
  return value.trim()
}

function parseSqlTimeNullable(
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

export function parseSqlTime(
  value: unknown,
  unit: 'ms' | 's' | 'iso' = 'ms',
): number {
  return parseSqlTimeNullable(value, unit) ?? 0
}

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

function diagnostic(
  client: string,
  level: Diagnostic['level'],
  path: string,
  message: string,
): Diagnostic {
  return { client, level, path, message }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function titleFromRow(row: SqlRow): string | null {
  const title = sensibleString(row.title)
  return title ?? sensibleString(row.preview)
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function emptyDoc(ref: SessionRef): SessionDoc {
  return { ref, prompts: [], prose: [], files: [], truncated: false }
}

function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === ''
    || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function safeDatabasePath(root: string, file: string): string | null {
  if (isAbsolute(file) || file.split(/[\\/]+/).includes('..')) return null
  const lexicalRoot = resolve(root)
  const lexicalPath = resolve(lexicalRoot, file)
  if (!isWithin(lexicalRoot, lexicalPath)) return null

  try {
    const realRoot = realpathSync(lexicalRoot)
    const realPath = realpathSync(lexicalPath)
    return isWithin(realRoot, realPath) ? realPath : null
  } catch {
    return null
  }
}

function innerQuery(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '')
}

function structuredProjection(sql: string, shape: 'opencode-part' | 'opencode-message-json'): string {
  const source = innerQuery(sql)
  if (shape === 'opencode-part') {
    return `
      WITH raw_source AS MATERIALIZED (${source}),
      ordered_source AS MATERIALIZED (
        SELECT row_number() OVER () AS source_ordinal, * FROM raw_source
      ),
      source AS (
        SELECT
          source_ordinal,
          CASE WHEN json_valid(message_data) THEN message_data END AS message_json,
          CASE WHEN json_valid(part_data) THEN part_data END AS part_json,
          length(CAST(COALESCE(message_data, '') AS BLOB))
            + length(CAST(COALESCE(part_data, '') AS BLOB)) AS projected_source_bytes
        FROM ordered_source
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
                AND projected_source_bytes <= ?2
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

export const sqliteStore: FormatModule = {
  async discover(manifest, root) {
    const spec = manifest.sqlite!
    const refs: SessionRef[] = []
    const diagnostics: Diagnostic[] = []
    const unresolvedPath = resolve(root, spec.file)
    const dbPath = safeDatabasePath(root, spec.file)

    if (!dbPath) {
      diagnostics.push(diagnostic(
        manifest.id,
        'warn',
        unresolvedPath,
        'database path is missing or outside the manifest root',
      ))
      return { refs, diagnostics }
    }

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
      const stat = statSync(dbPath)
      const fingerprint = `${Math.floor(stat.mtimeMs)}:${stat.size}`
      const rows = db.query(spec.sessions).all() as SqlRow[]
      for (const row of rows) {
        const nativeId = sensibleString(row.id)
        if (nativeId === null) continue
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

  async hydrate(manifest, root, ref, config: Config) {
    const spec = manifest.sqlite!
    if (!spec.text) return emptyDoc(ref)
    const dbPath = safeDatabasePath(root, spec.file)
    if (!dbPath) return emptyDoc(ref)

    const prompts: string[] = []
    const prose: string[] = []
    const files = new Set<string>()
    const maxBytes = Number.isFinite(config.maxFileBytes)
      ? Math.max(0, Math.floor(config.maxFileBytes))
      : 0
    let consumedBytes = 0
    let truncated = false
    const db = new Database(dbPath, { readonly: true })

    try {
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
          if (input === null && row.projected_input != null) truncated = true
          if (input !== null) {
            for (const path of collectPaths(input)) files.add(path)
          }
        }
      }
    } finally {
      db.close()
    }

    return { ref, prompts, prose, files: [...files], truncated }
  },
}
