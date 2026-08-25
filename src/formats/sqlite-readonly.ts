import { Database } from 'bun:sqlite'
import { pathToFileURL } from 'node:url'

export interface ReadonlySqliteResult<T> {
  value: T
  immutableFallback: boolean
}

type OpenReadonlyDatabase = (
  path: string,
  options: { readonly: true; create: false; strict: boolean },
) => Database

interface ReadonlySqliteOptions {
  strict?: boolean
  /** Deterministic test seam for an OS-level locking failure. */
  open?: OpenReadonlyDatabase
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function lockingUnavailable(error: unknown): boolean {
  return message(error).toLowerCase().includes('unable to open database file')
}

function immutableUri(path: string): string {
  const url = pathToFileURL(path)
  url.searchParams.set('mode', 'ro')
  url.searchParams.set('immutable', '1')
  return url.href
}

function readOnce<T>(
  path: string,
  read: (db: Database) => T,
  strict: boolean,
  open: OpenReadonlyDatabase,
): T {
  const db = open(path, { readonly: true, create: false, strict })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

/**
 * Reads an external SQLite store without requiring write access beside it.
 *
 * SQLite may need journal or shared-memory sidecars even for an ordinary
 * read-only connection. Sandboxed clients can deny those sidecar writes. Use
 * normal locking first, then retry the same bounded read as an immutable
 * snapshot only for that specific open failure.
 */
export function readReadonlySqlite<T>(
  path: string,
  read: (db: Database) => T,
  options: ReadonlySqliteOptions = {},
): ReadonlySqliteResult<T> {
  const strict = options.strict === true
  const open = options.open ?? ((candidate, databaseOptions) => (
    new Database(candidate, databaseOptions)
  ))
  try {
    return { value: readOnce(path, read, strict, open), immutableFallback: false }
  } catch (error) {
    if (!lockingUnavailable(error)) throw error
    return {
      value: readOnce(immutableUri(path), read, strict, open),
      immutableFallback: true,
    }
  }
}
