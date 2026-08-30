import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_CONFIG_ITEMS, indexPath, updateConfig, type Config } from '../config'
import { IndexDb } from '../core/db'
import { expandRoot } from '../manifests/load'
import { MAX_UID_LENGTH, isSafeClientId, parseUid } from '../types'

/** Narrows what prune removes. With neither field set, prune deletes nothing rather than everything. */
export interface PruneOptions {
  missing?: boolean
  client?: string
}

const MAX_GLOB = 4_096
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/
/** Everything Bun's Glob treats as a pattern rather than a literal path character. */
const GLOB_META = /[*?[\]{}!\\]/

/** Checks if a session UID is valid, safe, and parsable. */
function validUid(uid: string): boolean {
  if (uid.length === 0 || uid.length > MAX_UID_LENGTH || UNSAFE_TEXT.test(uid)) return false
  try {
    const parsed = parseUid(uid)
    return validClient(parsed.client)
  } catch {
    return false
  }
}

/** Checks if a client ID is safe and correctly formatted. */
function validClient(client: string): boolean {
  return isSafeClientId(client)
}

/** Validates that a client identifier is safe for querying. */
function boundedClient(client: string): boolean {
  return isSafeClientId(client)
}

/** Checks if a glob string is valid, non-empty, safe, and within length bounds. */
function validGlob(glob: string): boolean {
  return glob.length > 0 && glob.length <= MAX_GLOB && !UNSAFE_TEXT.test(glob)
}

/** Returns the index path if it exists, otherwise null. */
function existingIndex(): string | null {
  const path = indexPath()
  try {
    // IndexDb performs the authoritative regular-file and symlink checks. This
    // lstat only distinguishes an absent index for a useful, truthful message.
    lstatSync(path)
    return path
  } catch (error) {
    const missing = typeof error === 'object' && error !== null
      && 'code' in error && error.code === 'ENOENT'
    if (missing) return null
    throw error
  }
}

/** Removes one session and every searchable facet derived from it. Returns false when the uid is unsafe or simply not indexed. */
export function forgetIn(db: IndexDb, uid: string): boolean {
  if (!validUid(uid)) return false
  if (!db.getRef(uid)) return false
  db.deleteSession(uid)
  return true
}

/**
 * Bulk-removes indexed sessions by missing-source or client.
 *
 * An unfiltered call is treated as a mistake and removes nothing: wiping the
 * whole index must be an explicit rebuild, never the default of a prune.
 */
export function pruneIn(db: IndexDb, opts: PruneOptions): number {
  if (opts.client !== undefined && !boundedClient(opts.client)) return 0
  let rows: Array<{ uid: string }>
  if (opts.missing && opts.client) {
    rows = db.raw().query(
      'SELECT uid FROM session WHERE missing = 1 AND client = ? ORDER BY uid',
    ).all(opts.client) as Array<{ uid: string }>
  } else if (opts.missing) {
    rows = db.raw().query(
      'SELECT uid FROM session WHERE missing = 1 ORDER BY uid',
    ).all() as Array<{ uid: string }>
  } else if (opts.client) {
    rows = db.raw().query(
      'SELECT uid FROM session WHERE client = ? ORDER BY uid',
    ).all(opts.client) as Array<{ uid: string }>
  } else {
    return 0
  }
  db.deleteSessions(rows.map((row) => row.uid))
  return rows.length
}

/** Returns a copy of the config with one directory exclusion added, rejecting a glob that is malformed, unbounded, or one entry too many. */
export function addExclude(cfg: Config, glob: string): Config {
  if (!validGlob(glob)) throw new Error('exclusion glob is invalid or too long')
  const exclude = [...cfg.exclude]
  if (!exclude.includes(glob)) exclude.push(glob)
  // A bare directory expands to two entries, so the item cap is checked on
  // every single addition rather than left to the write to discover.
  if (exclude.length > MAX_CONFIG_ITEMS) throw new Error('too many exclusions')
  return { ...cfg, exclude, hiddenClients: [...cfg.hiddenClients] }
}

/**
 * Turns one user-supplied exclusion into the patterns actually stored.
 *
 * A leading `~/` is expanded, because Glob matches an absolute cwd literally
 * and would never see a tilde. A pattern without glob syntax is a directory,
 * and `nekyia exclude <dir>` promises the directory and everything beneath it,
 * which Glob's whole-path matching only delivers as two separate patterns.
 */
export function excludePatterns(glob: string): string[] {
  const expanded = expandRoot(glob)
  if (GLOB_META.test(expanded)) return [expanded]
  // A trailing slash would otherwise produce a doubled separator that matches
  // neither the directory nor its children.
  const directory = expanded.replace(/\/+$/, '') || '/'
  return [directory, join(directory, '**')]
}

/** Purges one session from the index, reporting plainly when the uid is unknown. */
export async function runForget(uid?: string): Promise<number> {
  if (!uid) {
    console.error('usage: nekyia forget <uid>')
    return 2
  }
  if (!validUid(uid)) {
    console.error('error: malformed uid')
    return 2
  }
  const path = existingIndex()
  if (!path) {
    console.error('index not found; run "nekyia index" first')
    return 1
  }
  const db = IndexDb.openExistingWritable(path)
  try {
    const removed = forgetIn(db, uid)
    console.error(removed ? `forgot ${uid}` : `no session with uid ${uid}`)
    return removed ? 0 : 1
  } finally {
    db.close()
  }
}

/** Removes indexed sessions whose sources are gone, or every session of one client. */
export async function runPrune(opts: PruneOptions): Promise<number> {
  if (!opts.missing && !opts.client) {
    console.error('usage: nekyia prune --missing | --client <id>')
    return 2
  }
  if (opts.client !== undefined && !validClient(opts.client)) {
    console.error('error: invalid client id')
    return 2
  }
  const path = existingIndex()
  if (!path) {
    console.error('index not found; run "nekyia index" first')
    return 1
  }
  const db = IndexDb.openExistingWritable(path)
  try {
    const count = pruneIn(db, opts)
    console.error(`pruned ${count} sessions`)
    return 0
  } finally {
    db.close()
  }
}

/** Adds an index-time directory exclusion. Existing matches stay until the index is refreshed, and the command says so. */
export async function runExclude(glob?: string): Promise<number> {
  if (!glob) {
    console.error('usage: nekyia exclude <glob>')
    return 2
  }
  if (!validGlob(glob)) {
    console.error('error: exclusion glob is invalid or too long')
    return 2
  }
  const patterns = excludePatterns(glob)
  // Expansion can push a pattern past the bound the raw argument respected.
  if (!patterns.every(validGlob)) {
    console.error('error: exclusion glob is invalid or too long')
    return 2
  }
  let duplicate = false
  await updateConfig((current) => {
    duplicate = patterns.every((pattern) => current.exclude.includes(pattern))
    return patterns.reduce((config, pattern) => addExclude(config, pattern), current)
  })
  const stored = patterns.join(' and ')
  console.error(duplicate ? `already excluded ${stored}` : `excluded ${stored}`)
  console.error('Exclusions apply at index time. Run "nekyia index --rebuild" to drop what is already indexed.')
  return 0
}
