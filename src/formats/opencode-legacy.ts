import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DEFAULT_CONFIG } from '../config'
import type { Config } from '../config'
import type { Manifest } from '../manifests/load'
import type { Diagnostic, SessionDoc, SessionRef } from '../types'
import { MAX_SESSION_FILES, isSafeNativeId, makeUid } from '../types'
import { collectPaths } from './paths'
import { parseSqlTimeNullable } from './sqlite-store'

const MAX_JSON_BYTES = 4 * 1024 * 1024

/**
 * Represents a JSON object as a dictionary mapping strings to unknown types.
 */
type JsonObject = Record<string, unknown>

/**
 * Represents a parsed JSON file with associated metadata and readability status.
 */
interface NamedJson {
  file: string
  path: string
  time: number
  size: number
  readable: boolean
  /** Unreadable because it is over the JSON ceiling, rather than because it is malformed. */
  oversized: boolean
}

/**
 * Type guard that checks if a value is a non-null, non-array object.
 */
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Trims a string and returns it if it is non-empty and contains no null bytes, otherwise returns null.
 */
function normalizedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 && !normalized.includes('\0') ? normalized : null
}

/**
 * Normalizes an optional string, returning undefined if it is null or empty after trimming.
 */
function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  const normalized = normalizedString(value)
  return normalized ?? undefined
}

/**
 * Reads the first of `keys` that holds a timestamp, in the unit the manifest declares.
 *
 * This reader and the SQLite one serve the same manifests, so they read
 * `timeUnit` through the same function. Assuming milliseconds here would place
 * a seconds-based store 56 years before the sessions its sibling reports.
 */
function objectTime(
  value: unknown,
  unit: 'ms' | 's' | 'iso',
  ...keys: string[]
): number | null {
  if (!isObject(value)) return null
  for (const key of keys) {
    const timestamp = parseSqlTimeNullable(value[key], unit)
    if (timestamp !== null) return timestamp
  }
  return null
}

/**
 * Comparator function to alphabetically sort strings.
 */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Determines whether a given path falls within a specified root directory.
 */
function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === ''
    || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

/**
 * Validates and resolves a legacy path against a root, ensuring it does not escape the root.
 */
function safeLegacyBase(root: string, legacyPath: string): string | null {
  if (
    legacyPath.trim().length === 0
    || legacyPath.includes('\0')
    || isAbsolute(legacyPath)
    || legacyPath.split(/[\\/]+/).includes('..')
  ) return null

  const lexicalRoot = resolve(root)
  const lexicalBase = resolve(lexicalRoot, legacyPath)
  if (!isWithin(lexicalRoot, lexicalBase)) return null

  try {
    const realRoot = realpathSync(lexicalRoot)
    if (!existsSync(lexicalBase)) return lexicalBase
    const realBase = realpathSync(lexicalBase)
    return isWithin(realRoot, realBase) ? realBase : null
  } catch {
    return null
  }
}

/**
 * Safely resolves an existing path, verifying that it is contained within the specified base directory.
 */
function safeExistingPath(base: string, path: string): string | null {
  try {
    const realBase = realpathSync(base)
    const realPath = realpathSync(path)
    return isWithin(realBase, realPath) ? realPath : null
  } catch {
    return null
  }
}

/**
 * Lists and sorts the names of all directories within a given path.
 */
function directoryNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareStrings)
  } catch {
    return []
  }
}

/**
 * Lists and sorts the names of all JSON files within a given path.
 */
function jsonFileNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort(compareStrings)
  } catch {
    return []
  }
}

/**
 * Represents the result of an attempt to read and parse a JSON file, including success or failure details.
 */
type JsonRead =
  | { ok: true; value: JsonObject; size: number; mtimeMs: number }
  | { ok: false; reason: string; oversized: boolean; size: number; mtimeMs: number }

/**
 * Safely reads and parses a JSON file from disk, enforcing size limits and structural validation.
 */
function readJson(base: string, unresolvedPath: string): JsonRead {
  const path = safeExistingPath(base, unresolvedPath)
  if (path === null) {
    return {
      ok: false, reason: 'path is outside legacy storage', oversized: false, size: 0, mtimeMs: 0,
    }
  }
  let size = 0
  let mtimeMs = 0
  try {
    const stat = statSync(path)
    size = stat.size
    mtimeMs = stat.mtimeMs
    if (!stat.isFile()) {
      return {
        ok: false, reason: 'not a regular file', oversized: false,
        size: stat.size, mtimeMs: stat.mtimeMs,
      }
    }
    if (stat.size > MAX_JSON_BYTES) {
      return {
        ok: false, reason: `file exceeds ${MAX_JSON_BYTES} byte limit`, oversized: true,
        size: stat.size, mtimeMs: stat.mtimeMs,
      }
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isObject(parsed)) {
      return {
        ok: false, reason: 'JSON value must be an object', oversized: false,
        size: stat.size, mtimeMs: stat.mtimeMs,
      }
    }
    return { ok: true, value: parsed, size: stat.size, mtimeMs: stat.mtimeMs }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      oversized: false,
      size,
      mtimeMs,
    }
  }
}

/**
 * Creates a warning diagnostic object for skipped paths with a specific message.
 */
function diagnostic(client: string, path: string, message: string): Diagnostic {
  return { client, level: 'warn', path, message: `skipped: ${message}` }
}

/**
 * Discovers all source files relevant to a session, including messages and their parts.
 */
function relevantSourcePaths(
  base: string,
  sessionPath: string,
  sessionId: string,
): string[] {
  const paths = [sessionPath]
  const messageDirectory = safeExistingPath(base, join(base, 'message', sessionId))
  if (messageDirectory === null) return paths

  const messagePaths = jsonFileNames(messageDirectory).map((file) => join(messageDirectory, file))
  paths.push(...messagePaths)
  for (const messagePath of messagePaths) {
    const parsed = readJson(base, messagePath)
    if (!parsed.ok) continue
    const messageId = normalizedString(parsed.value.id)
    const owningSession = normalizedString(parsed.value.sessionID)
    const role = normalizedString(parsed.value.role)
    if (messageId === null || owningSession !== sessionId || role === null) continue

    const partDirectory = safeExistingPath(base, join(base, 'part', messageId))
    if (partDirectory === null) continue
    for (const file of jsonFileNames(partDirectory)) paths.push(join(partDirectory, file))
  }

  const rest = paths.slice(1).sort((left, right) => (
    compareStrings(relative(base, left), relative(base, right))
  ))
  return [sessionPath, ...rest]
}

/**
 * Computes a JSON string fingerprint of paths based on their modification times and sizes.
 */
function fingerprintFor(base: string, paths: string[]): string {
  const metadata: Array<[string, number, number]> = []
  for (const path of paths) {
    const safePath = safeExistingPath(base, path)
    if (safePath === null) continue
    try {
      const stat = statSync(safePath)
      metadata.push([relative(base, safePath), stat.mtimeMs, stat.size])
    } catch {
      // A concurrent deletion is reflected by its absence from the aggregate.
    }
  }
  return JSON.stringify(metadata)
}

/** Discovers sessions left behind in opencode's pre-SQLite JSON tree, for installs that migrated without backfilling. */
export async function discoverLegacy(
  manifest: Manifest,
  root: string,
): Promise<{ refs: SessionRef[]; diagnostics: Diagnostic[] }> {
  const refs: SessionRef[] = []
  const diagnostics: Diagnostic[] = []
  const legacy = manifest.sqlite?.legacy
  if (!legacy) return { refs, diagnostics }

  const timeUnit = manifest.sqlite?.timeUnit ?? 'ms'
  const base = safeLegacyBase(root, legacy.path)
  if (base === null) {
    diagnostics.push(diagnostic(manifest.id, resolve(root, legacy.path), 'legacy path is outside manifest root'))
    return { refs, diagnostics }
  }
  const sessionRoot = join(base, 'session')
  if (!existsSync(sessionRoot)) return { refs, diagnostics }
  const safeSessionRoot = safeExistingPath(base, sessionRoot)
  if (safeSessionRoot === null) {
    diagnostics.push(diagnostic(manifest.id, sessionRoot, 'session path is outside legacy storage'))
    return { refs, diagnostics }
  }

  const discovered: Array<{ ref: SessionRef; key: string }> = []
  for (const projectId of directoryNames(safeSessionRoot)) {
    const unresolvedProjectRoot = join(safeSessionRoot, projectId)
    const projectRoot = safeExistingPath(base, unresolvedProjectRoot)
    if (projectRoot === null) continue
    for (const file of jsonFileNames(projectRoot)) {
      const path = join(projectRoot, file)
      const parsed = readJson(base, path)
      if (!parsed.ok) {
        diagnostics.push(diagnostic(manifest.id, path, parsed.reason))
        continue
      }

      const value = parsed.value
      const nativeId = normalizedString(value.id)
      const storedProjectId = normalizedString(value.projectID)
      const cwd = optionalString(value.directory)
      const title = optionalString(value.title)
      const parentNativeId = optionalString(value.parentID)
      if (
        nativeId === null
        || storedProjectId !== projectId
        || cwd === undefined
        || title === undefined
        || parentNativeId === undefined
      ) {
        diagnostics.push(diagnostic(manifest.id, path, 'invalid session shape'))
        continue
      }
      // The id comes from a stored document, so it is not trusted to be
      // addressable. A session whose uid `forget` would refuse is left
      // unindexed rather than indexed and unremovable.
      if (!isSafeNativeId(nativeId)) {
        diagnostics.push(diagnostic(
          manifest.id,
          path,
          'session id is empty, over-long, or carries control or bidi characters',
        ))
        continue
      }

      const created = objectTime(value.time, timeUnit, 'created') ?? Math.floor(parsed.mtimeMs)
      const updated = objectTime(value.time, timeUnit, 'updated') ?? created
      const sourcePaths = relevantSourcePaths(base, path, nativeId)
      discovered.push({
        key: relative(base, path),
        ref: {
          uid: makeUid(manifest.id, nativeId),
          client: manifest.id,
          nativeId,
          cwd,
          gitBranch: null,
          title,
          startedAt: created,
          endedAt: updated,
          turns: null,
          parentNativeId,
          tier: manifest.tier,
          origin: 'manifest',
          sourcePaths,
          fingerprint: fingerprintFor(base, sourcePaths),
        },
      })
    }
  }

  discovered.sort((left, right) => (
    left.ref.startedAt - right.ref.startedAt || compareStrings(left.key, right.key)
  ))
  const seen = new Set<string>()
  for (const item of discovered) {
    if (seen.has(item.ref.nativeId)) continue
    seen.add(item.ref.nativeId)
    refs.push(item.ref)
  }
  return { refs, diagnostics }
}

/**
 * Collects and orders metadata for all readable JSON files within a directory by their creation time.
 */
function orderedJsonMetadata(base: string, directory: string, unit: 'ms' | 's' | 'iso'): {
  rows: NamedJson[]
} {
  const rows: NamedJson[] = []
  const safeDirectory = safeExistingPath(base, directory)
  if (safeDirectory === null) return { rows }
  for (const file of jsonFileNames(safeDirectory)) {
    const path = join(safeDirectory, file)
    const parsed = readJson(base, path)
    rows.push({
      file,
      path,
      time: parsed.ok
        ? (objectTime(parsed.value.time, unit, 'created', 'start') ?? Number.MAX_SAFE_INTEGER)
        : Number.MAX_SAFE_INTEGER,
      size: parsed.size,
      readable: parsed.ok,
      oversized: !parsed.ok && parsed.oversized,
    })
  }
  rows.sort((left, right) => left.time - right.time || compareStrings(left.file, right.file))
  return { rows }
}

/** Hydrates one session from the legacy JSON tree, matching what the SQLite reader would have produced. */
export async function hydrateLegacy(
  manifest: Manifest,
  root: string,
  ref: SessionRef,
  config: Config = DEFAULT_CONFIG,
): Promise<SessionDoc> {
  const prompts: string[] = []
  const prose: string[] = []
  const files = new Set<string>()
  const legacy = manifest.sqlite?.legacy
  const base = legacy ? safeLegacyBase(root, legacy.path) : null
  if (base === null || ref.client !== manifest.id) {
    return { ref, prompts, prose, files: [], truncated: false }
  }

  const sessionId = normalizedString(ref.nativeId)
  if (sessionId === null) return { ref, prompts, prose, files: [], truncated: false }
  const timeUnit = manifest.sqlite?.timeUnit ?? 'ms'
  const messages = orderedJsonMetadata(base, join(base, 'message', sessionId), timeUnit)
  const maxBytes = Number.isFinite(config.maxFileBytes)
    ? Math.max(0, Math.floor(config.maxFileBytes))
    : 0
  let consumedBytes = 0
  let truncated = false
  let degraded = false

  /** A file this reader could not use: too large is a cap, anything else is a failed read. */
  function unusable(oversized: boolean): void {
    if (oversized) truncated = true
    else degraded = true
  }

  /**
   * Tracks bytes consumed against the budget, updating truncation status if the budget is exceeded.
   */
  function charge(size: number): boolean {
    if (size <= maxBytes - consumedBytes) {
      consumedBytes += size
      return true
    }
    consumedBytes = maxBytes
    truncated = true
    return false
  }

  for (const messageRow of messages.rows) {
    if (!messageRow.readable) {
      charge(messageRow.size)
      unusable(messageRow.oversized)
      continue
    }
    const parsedMessage = readJson(base, messageRow.path)
    if (!parsedMessage.ok) {
      charge(messageRow.size)
      unusable(parsedMessage.oversized)
      continue
    }
    const message = parsedMessage.value
    const messageId = normalizedString(message.id)
    const owningSession = normalizedString(message.sessionID)
    const role = normalizedString(message.role)
    if (owningSession !== sessionId) continue
    if (messageId === null || role === null) {
      charge(messageRow.size)
      // A stored message without an id or a role is malformed, not oversized.
      degraded = true
      continue
    }
    charge(messageRow.size)

    const parts = orderedJsonMetadata(base, join(base, 'part', messageId), timeUnit)
    for (const partRow of parts.rows) {
      if (!partRow.readable) {
        charge(partRow.size)
        unusable(partRow.oversized)
        continue
      }
      const parsedPart = readJson(base, partRow.path)
      if (!parsedPart.ok) {
        charge(partRow.size)
        unusable(parsedPart.oversized)
        continue
      }
      const part = parsedPart.value
      const owningPartSession = normalizedString(part.sessionID)
      const owningMessage = normalizedString(part.messageID)
      if (owningPartSession !== sessionId || owningMessage !== messageId) continue
      if (normalizedString(part.id) === null || normalizedString(part.type) === null) {
        charge(partRow.size)
        degraded = true
        continue
      }
      const withinBudget = charge(partRow.size)

      if (part.type === 'text') {
        const text = normalizedString(part.text)
        if (text !== null && role === 'user') prompts.push(text)
        else if (text !== null && role === 'assistant' && withinBudget) prose.push(text)
      } else if (part.type === 'tool') {
        if (!isObject(part.state)) {
          degraded = true
          continue
        }
        for (const path of collectPaths(part.state.input)) {
          // The per-session ceiling the SQLite reader enforces, applied here
          // too: a partial file list must never be reported as a complete one.
          if (files.size >= MAX_SESSION_FILES) {
            truncated = true
            break
          }
          files.add(path)
        }
      }
    }
  }

  return { ref, prompts, prose, files: [...files], truncated, degraded }
}
