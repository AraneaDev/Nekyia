import { Database } from 'bun:sqlite'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from 'node:fs'
import type { Dir, Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Manifest } from '../manifests/load'
import { expandRoot, loadManifests } from '../manifests/load'

/**
 * A store Nekyia recognised but does not ship support for, with a draft manifest to start from.
 *
 * `confidence` and `sample` exist so a person can judge the guess: a draft is
 * a starting point for a manifest, never a supported client.
 */
export interface SniffResult {
  path: string
  kind: 'jsonl' | 'sqlite'
  confidence: number
  sample: string[]
  suggested: Partial<Manifest>
}

const MAX_JSONL_BYTES = 64 * 1024
const MAX_JSONL_LINE_BYTES = 16 * 1024
const MAX_JSONL_RECORDS = 40
const MAX_TABLES = 64
const MAX_COLUMNS = 64
const MAX_IDENTIFIER_BYTES = 256
const MAX_ID_BYTES = 512
const MAX_CWD_BYTES = 4_096
const MAX_TIME_BYTES = 64
const MAX_INPUT_ROOTS = 64
const MAX_DIRECTORY_ENTRIES = 256
const MAX_WALK_DIRS = 256
const MAX_WALK_FILES = 512
const MAX_WALK_ENTRIES = 4_096
const MAX_RESULTS = 200
const MAX_DEPTH = 6

const TIME_KEYS = ['ts', 'timestamp', 'time', 'created', 'created_at', 'createdAt', 'date'] as const
const CWD_KEYS = ['cwd', 'directory', 'workspace', 'projectRoot', 'project_root', 'worktree', 'path'] as const
const ROLE_KEYS = ['role', 'variant', 'author', 'sender', 'type'] as const
const TEXT_KEYS = ['text', 'content', 'message', 'display', 'input', 'prompt'] as const
const USER_ROLES = new Set(['user', 'human'])
const ASSISTANT_ROLES = new Set(['assistant', 'model', 'ai'])
const CREDIBLE_ROLES = new Set([...USER_ROLES, ...ASSISTANT_ROLES, 'system', 'developer'])
const NEVER_JSON = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json',
  'composer.json', 'deno.json', 'deno.jsonc', 'bun.lock', 'bun.lockb',
])

/**
 * Represents a generic JSON object with string keys.
 */
type JsonRecord = Record<string, unknown>

/**
 * Describes the inferred field mappings and content of a JSONL file.
 */
interface JsonlShape {
  tsPath: string
  cwdPath: string
  rolePath: string
  textPath: string
  records: JsonRecord[]
  roles: Set<string>
}

/**
 * Checks if a given path is located strictly within a root directory.
 */
function containedBy(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`))
}

/**
 * Checks if a path contains or is contained by any known root directories.
 */
function overlapsKnown(path: string, known: string[]): boolean {
  return known.some((root) => containedBy(root, path) || containedBy(path, root))
}

/**
 * Safely checks if a path points to a regular file, avoiding symlinks.
 */
function safeRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Validates whether a value represents a realistic timestamp within a reasonable range.
 */
function plausibleTime(value: unknown): boolean {
  const now = Date.now()
  const earliest = Date.UTC(2000, 0, 1)
  const latest = now + (10 * 366 * 24 * 60 * 60 * 1_000)
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 100_000_000_000 ? value * 1_000 : value
    return ms >= earliest && ms <= latest
  }
  if (typeof value !== 'string' || value.length > 64) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed >= earliest && parsed <= latest
}

/**
 * Validates whether a value is a plausible absolute directory path string.
 */
function plausibleCwd(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 2 || value.length > 4_096) return false
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) return false
  if (value === '/' || value === '\\') return false
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * Normalizes and validates a role string against a known set of credible roles.
 */
function credibleRole(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32) return null
  const role = value.trim().toLowerCase()
  return CREDIBLE_ROLES.has(role) ? role : null
}

/**
 * Checks if a value is a non-empty string after trimming whitespace.
 */
function nonemptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Finds the first key in a record that matches candidates and satisfies a predicate.
 */
function firstMatchingKey(
  record: JsonRecord,
  candidates: readonly string[],
  predicate: (value: unknown) => boolean,
): string | null {
  for (const key of candidates) {
    if (Object.hasOwn(record, key) && predicate(record[key])) return key
  }
  return null
}

/**
 * Attempts to infer the schema paths (time, cwd, role, text) from a JSON record.
 */
function recordShape(record: JsonRecord): Omit<JsonlShape, 'records' | 'roles'> | null {
  const tsPath = firstMatchingKey(record, TIME_KEYS, plausibleTime)
  const cwdPath = firstMatchingKey(record, CWD_KEYS, plausibleCwd)
  const rolePath = firstMatchingKey(record, ROLE_KEYS, (value) => credibleRole(value) !== null)
  const textPath = firstMatchingKey(record, TEXT_KEYS, nonemptyText)
  return tsPath && cwdPath && rolePath && textPath
    ? { tsPath, cwdPath, rolePath, textPath }
    : null
}

/**
 * Selects the most likely JSONL schema shape from a sample of parsed records.
 */
function chooseJsonlShape(records: JsonRecord[]): JsonlShape | null {
  const shapes = new Map<string, JsonlShape>()
  for (const record of records) {
    const fields = recordShape(record)
    if (!fields) continue
    const key = JSON.stringify([fields.tsPath, fields.cwdPath, fields.rolePath, fields.textPath])
    const current = shapes.get(key) ?? { ...fields, records: [], roles: new Set<string>() }
    current.records.push(record)
    const role = credibleRole(record[fields.rolePath])
    if (role) current.roles.add(role)
    shapes.set(key, current)
  }

  return [...shapes.values()]
    .filter((shape) => shape.records.length >= 2)
    .filter((shape) => [...shape.roles].some((role) => USER_ROLES.has(role)))
    .filter((shape) => [...shape.roles].some((role) => ASSISTANT_ROLES.has(role)))
    .sort((a, b) => b.records.length - a.records.length
      || JSON.stringify([a.tsPath, a.cwdPath, a.rolePath, a.textPath])
        .localeCompare(JSON.stringify([b.tsPath, b.cwdPath, b.rolePath, b.textPath])))[0] ?? null
}

/**
 * Reads a bounded initial chunk of a JSONL file to analyze its structure.
 */
function readJsonlPrefix(path: string): { text: string; truncated: boolean } | null {
  if (!safeRegularFile(path)) return null
  let fd: number | null = null
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile()) return null
    const buffer = Buffer.allocUnsafe(MAX_JSONL_BYTES)
    let read = 0
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, null)
      if (count === 0) break
      read += count
    }
    return {
      text: new TextDecoder('utf-8').decode(buffer.subarray(0, read)),
      truncated: stat.size > read,
    }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* already unusable */ }
    }
  }
}

/** Inspects a bounded prefix of a line-per-record file and drafts a manifest when the shape is recognisable. */
export function sniffJsonl(path: string): SniffResult | null {
  const name = basename(path).toLowerCase()
  if (NEVER_JSON.has(name) || !name.endsWith('.jsonl')) return null
  const prefix = readJsonlPrefix(path)
  if (!prefix) return null

  const lines = prefix.text.split('\n')
  if (prefix.truncated && !prefix.text.endsWith('\n')) lines.pop()
  const records: JsonRecord[] = []
  for (const line of lines) {
    if (records.length >= MAX_JSONL_RECORDS) break
    if (!line.trim() || Buffer.byteLength(line) > MAX_JSONL_LINE_BYTES) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        records.push(parsed as JsonRecord)
      }
    } catch {
      // A malformed or prefix-truncated row does not invalidate independent rows.
    }
  }
  if (records.length < 2) return null
  const shape = chooseJsonlShape(records)
  if (!shape) return null

  const userRoles = [...shape.roles].filter((role) => USER_ROLES.has(role)).sort()
  const assistantRoles = [...shape.roles].filter((role) => ASSISTANT_ROLES.has(role)).sort()
  const sample = [
    `record schema: ${shape.tsPath}(time), ${shape.cwdPath}(cwd), ${shape.rolePath}(role), ${shape.textPath}(redacted text)`,
    `matched records: ${Math.min(shape.records.length, MAX_JSONL_RECORDS)}`,
  ]

  return {
    path,
    kind: 'jsonl',
    confidence: 0.65,
    sample,
    suggested: {
      schema: 1,
      format: 'jsonl-transcript',
      tier: 'search',
      jsonl: {
        glob: `**/${basename(path).replace(/[\\*?[\]{}()!+@]/g, '\\$&')}`,
        variant: 'generic',
        generic: {
          idFrom: 'filename',
          cwdPath: shape.cwdPath,
          tsPath: shape.tsPath,
          tsUnit: declaredTimeUnit(shape.records[0]![shape.tsPath]),
          rolePath: shape.rolePath,
          textPath: shape.textPath,
          userRoles,
          assistantRoles,
        },
      },
    },
  }
}

/**
 * Encloses a SQL identifier in double quotes, escaping internal quotes.
 */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

/**
 * Sanitizes and truncates an identifier for safe use as a schema name.
 */
function safeSchemaName(identifier: string): string {
  return identifier
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '?')
    .slice(0, 64)
}

/**
 * Finds the first column name that matches any of the candidate names case-insensitively.
 */
function matchingColumn(columns: string[], candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    const column = columns.find((value) => value.toLowerCase() === candidate.toLowerCase())
    if (column) return column
  }
  return null
}

/**
 * Normalizes an identifier into lowercase word tokens, splitting by non-alphanumeric characters.
 */
function normalizedTokens(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * Identifies the most likely ID column from a list of column names.
 */
function idColumn(columns: string[]): string | null {
  const exact = matchingColumn(columns, ['id'])
  if (exact) return exact
  const sessionSpecific = matchingColumn(columns, [
    'session_id', 'conversation_id', 'thread_id', 'chat_id',
  ])
  if (sessionSpecific) return sessionSpecific
  return columns.find((column) => /_id$/i.test(column)) ?? null
}

/**
 * Identifies the most likely timestamp or date column from a list of column names.
 */
function timeColumn(columns: string[]): string | null {
  const exact = matchingColumn(columns, TIME_KEYS)
  if (exact) return exact
  const tokenMatch = columns.find((column) => {
    const tokens = normalizedTokens(column)
    if (tokens.includes('time') || tokens.includes('timestamp')) return true
    const last = tokens.at(-1)
    const penultimate = tokens.at(-2)
    return last === 'at' && ['created', 'updated', 'ended', 'started'].includes(penultimate ?? '')
  })
  if (tokenMatch) return tokenMatch
  return columns.find((column) => {
    const compact = column.toLowerCase().replace(/[^a-z0-9]/g, '')
    return compact.endsWith('timestamp')
      || /(?:created|updated|ended|started)(?:at|time)$/.test(compact)
      || /^time(?:created|updated|ended|started)/.test(compact)
  }) ?? null
}

/**
 * Identifies the most likely title or summary column from a list of column names.
 */
function titleColumn(columns: string[]): string | null {
  const exact = matchingColumn(columns, ['title', 'summary', 'preview', 'name'])
  if (exact) return exact
  return columns.find((column) => normalizedTokens(column).some(
    (token) => token === 'title' || token === 'summary' || token === 'preview',
  )) ?? null
}

/**
 * Reads directory entries up to a maximum limit, indicating if overflow occurred.
 */
function boundedDirectoryEntries(path: string): { entries: Dirent[]; overflow: boolean } | null {
  let directory: Dir | null = null
  try {
    directory = opendirSync(path)
    const entries: Dirent[] = []
    for (let i = 0; i <= MAX_DIRECTORY_ENTRIES; i++) {
      const entry = directory.readSync()
      if (entry === null) return { entries, overflow: false }
      if (i === MAX_DIRECTORY_ENTRIES) return { entries, overflow: true }
      entries.push(entry)
    }
    return { entries, overflow: true }
  } catch {
    return null
  } finally {
    try { directory?.closeSync() } catch { /* directory raced or was already closed */ }
  }
}

/**
 * Validates whether a value is a plausible, non-empty identifier string or number.
 */
function plausibleId(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
}

/**
 * Names the unit a plausible timestamp is written in.
 *
 * plausibleTime already decides that a small number can only be seconds, so a
 * draft manifest says so instead of leaving the reader to assume milliseconds
 * and place the session in 1970. Both drafts share this so the two sniffers
 * cannot drift apart on the same value.
 */
function declaredTimeUnit(value: unknown): 'ms' | 's' | 'iso' {
  if (typeof value === 'number') return value < 100_000_000_000 ? 's' : 'ms'
  return 'iso'
}

/** Inspects a SQLite file's tables and columns, opened read-only, and drafts a manifest when a session-like table is present. */
export function sniffSqlite(path: string): SniffResult | null {
  if (!safeRegularFile(path)) return null
  let db: Database | null = null
  try {
    const before = lstatSync(path)
    db = new Database(path, { readonly: true, strict: true })
    const after = lstatSync(path)
    if (
      !after.isFile()
      || after.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
    ) return null
    const tableRows = db.query(
      `SELECT CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) BETWEEN 1 AND ${MAX_IDENTIFIER_BYTES} THEN name ELSE NULL END AS name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT ${MAX_TABLES + 1}`,
    ).all() as Array<{ name: unknown }>
    if (tableRows.length > MAX_TABLES) return null
    if (tableRows.some((row) => row.name === null)) return null

    for (const tableRow of tableRows) {
      if (typeof tableRow.name !== 'string' || !/(session|conversation|thread|chat)/i.test(tableRow.name)) continue
      const table = tableRow.name
      const columnRows = db.query(
        `SELECT CASE WHEN typeof(name) = 'text' AND length(CAST(name AS BLOB)) BETWEEN 1 AND ${MAX_IDENTIFIER_BYTES} THEN name ELSE NULL END AS name FROM pragma_table_info(?1) LIMIT ${MAX_COLUMNS + 1}`,
      ).all(table) as Array<{ name: unknown }>
      if (columnRows.length === 0 || columnRows.length > MAX_COLUMNS) continue
      if (columnRows.some((row) => row.name === null)) continue
      const columns = columnRows.flatMap((row) => typeof row.name === 'string' ? [row.name] : [])
      const id = idColumn(columns)
      const cwd = matchingColumn(columns, CWD_KEYS)
      const time = timeColumn(columns)
      if (!id || !cwd || !time) continue
      const title = titleColumn(columns)

      const rows = db.query(
        `SELECT CASE WHEN typeof(${quoteIdentifier(id)}) IN ('integer', 'real') OR (typeof(${quoteIdentifier(id)}) = 'text' AND length(CAST(${quoteIdentifier(id)} AS BLOB)) <= ${MAX_ID_BYTES}) THEN ${quoteIdentifier(id)} ELSE NULL END AS __id, CASE WHEN typeof(${quoteIdentifier(cwd)}) = 'text' AND length(CAST(${quoteIdentifier(cwd)} AS BLOB)) <= ${MAX_CWD_BYTES} THEN ${quoteIdentifier(cwd)} ELSE NULL END AS __cwd, CASE WHEN typeof(${quoteIdentifier(time)}) IN ('integer', 'real') OR (typeof(${quoteIdentifier(time)}) = 'text' AND length(CAST(${quoteIdentifier(time)} AS BLOB)) <= ${MAX_TIME_BYTES}) THEN ${quoteIdentifier(time)} ELSE NULL END AS __time FROM ${quoteIdentifier(table)} LIMIT 3`,
      ).all() as Array<{ __id: unknown; __cwd: unknown; __time: unknown }>
      const plausible = rows.find((row) => (
        plausibleId(row.__id) && plausibleCwd(row.__cwd) && plausibleTime(row.__time)
      ))
      if (!plausible) continue

      const selectedTitle = title ? quoteIdentifier(title) : 'NULL'
      const sessions = `SELECT ${quoteIdentifier(id)} AS id, ${quoteIdentifier(cwd)} AS cwd, ${selectedTitle} AS title, ${quoteIdentifier(time)} AS ended_at FROM ${quoteIdentifier(table)}`
      const safeColumns = columns.slice(0, 12).map(safeSchemaName).join(', ')
      const sample = [`table ${safeSchemaName(table)}: ${safeColumns}`].map((value) => value.slice(0, 512))
      return {
        path,
        kind: 'sqlite',
        confidence: 0.65,
        sample,
        suggested: {
          schema: 1,
          format: 'sqlite-store',
          tier: 'search',
          sqlite: {
            file: basename(path),
            sessions,
            timeUnit: declaredTimeUnit(plausible.__time),
          },
        },
      }
    }
    return null
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* best-effort close on corrupt databases */ }
  }
}

/**
 * Retrieves a deduplicated list of expanded root paths from known manifests.
 */
function knownRoots(): string[] {
  try {
    const roots = loadManifests().manifests.flatMap((manifest) => manifest.roots.flatMap((root) => {
      const lexical = resolve(expandRoot(root))
      try {
        return [lexical, realpathSync(lexical)]
      } catch {
        return [lexical]
      }
    }))
    return [...new Set(roots.filter((path) => path.length > 0))].sort()
  } catch {
    return []
  }
}

/** Directories worth inspecting, excluding everything overlapping a tested manifest root. */
export function candidateRoots(): string[] {
  const home = resolve(homedir())
  const bases = [home, join(home, '.config'), join(home, '.local', 'share'), join(home, '.local', 'state')]
  const known = knownRoots()
  const candidates = new Set<string>()

  for (const base of bases) {
    const listed = boundedDirectoryEntries(base)
    if (!listed || listed.overflow) continue
    const entries = listed.entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const lexical = resolve(base, entry.name)
      if (overlapsKnown(lexical, known)) continue
      try {
        const real = realpathSync(lexical)
        if (real !== lexical || overlapsKnown(real, known)) continue
        candidates.add(real)
      } catch {
        // Hostile or racing directory entries are skipped.
      }
    }
  }
  return [...candidates].sort()
}

/**
 * Represents a directory path and its depth in a file system traversal.
 */
interface WalkItem { path: string; depth: number }

/**
 * Dispatches to the appropriate sniffer based on the file extension.
 */
function sniffKind(path: string): SniffResult | null {
  const extension = extname(path).toLowerCase()
  if (extension === '.jsonl') return sniffJsonl(path)
  if (extension === '.db' || extension === '.sqlite' || extension === '.sqlite3') return sniffSqlite(path)
  return null
}

/** Walks likely store locations and returns the best drafts, bounded in both directories visited and results returned. */
export function sniffRoots(dirs: string[] = candidateRoots(), limit = MAX_RESULTS): SniffResult[] {
  const resultLimit = Math.max(0, Math.min(MAX_RESULTS, Number.isFinite(limit) ? Math.floor(limit) : MAX_RESULTS))
  if (resultLimit === 0) return []
  const rootSet = new Set<string>()
  for (let index = 0; index < Math.min(dirs.length, MAX_INPUT_ROOTS); index++) {
    const path = dirs[index]
    if (typeof path !== 'string') continue
    try { rootSet.add(resolve(path)) } catch { /* malformed caller path */ }
  }
  const roots = [...rootSet].sort()
  const queue: WalkItem[] = []
  const queuedDirs = new Set<string>()
  for (const root of roots) {
    try {
      const stat = lstatSync(root)
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) continue
      queue.push({ path: root, depth: 0 })
      queuedDirs.add(root)
    } catch {
      // Missing and inaccessible roots are ordinary during heuristic discovery.
    }
  }

  const results: SniffResult[] = []
  const seenDirs = new Set<string>()
  const seenFiles = new Set<string>()
  /**
   * Sorts sniff results lexicographically by their file paths.
   */
  const sortedResults = () => results.sort((a, b) => a.path.localeCompare(b.path))
  let visitedDirs = 0
  let visitedFiles = 0
  let visitedEntries = 0
  for (let cursor = 0; cursor < queue.length && visitedDirs < MAX_WALK_DIRS; cursor++) {
    const current = queue[cursor]!
    visitedDirs++
    try {
      const stat = lstatSync(current.path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(current.path) !== current.path) continue
      if (seenDirs.has(current.path)) continue
      seenDirs.add(current.path)
    } catch {
      continue
    }
    const listed = boundedDirectoryEntries(current.path)
    if (!listed) continue
    visitedEntries += listed.entries.length + (listed.overflow ? 1 : 0)
    if (visitedEntries > MAX_WALK_ENTRIES) return sortedResults()
    if (listed.overflow) continue
    const entries = listed.entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(current.path, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (
          current.depth < MAX_DEPTH
          && queue.length < MAX_WALK_DIRS
          && !queuedDirs.has(path)
        ) {
          queue.push({ path, depth: current.depth + 1 })
          queuedDirs.add(path)
        }
        continue
      }
      if (!entry.isFile() || visitedFiles >= MAX_WALK_FILES) continue
      visitedFiles++
      if (seenFiles.has(path)) continue
      seenFiles.add(path)
      const sniffed = sniffKind(path)
      if (sniffed) results.push(sniffed)
      if (results.length >= resultLimit) return sortedResults()
    }
  }
  return sortedResults()
}
