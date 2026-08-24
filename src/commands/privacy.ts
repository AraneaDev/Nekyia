import { lstatSync } from 'node:fs'
import { indexPath, updateConfig, type Config } from '../config'
import { IndexDb } from '../core/db'
import { isSafeClientId, parseUid } from '../types'

export interface PruneOptions {
  missing?: boolean
  client?: string
}

const MAX_UID = 4_096
const MAX_GLOB = 4_096
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/

function validUid(uid: string): boolean {
  if (uid.length === 0 || uid.length > MAX_UID || UNSAFE_TEXT.test(uid)) return false
  try {
    const parsed = parseUid(uid)
    return validClient(parsed.client)
  } catch {
    return false
  }
}

function validClient(client: string): boolean {
  return isSafeClientId(client)
}

function boundedClient(client: string): boolean {
  return isSafeClientId(client)
}

function validGlob(glob: string): boolean {
  return glob.length > 0 && glob.length <= MAX_GLOB && !UNSAFE_TEXT.test(glob)
}

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

export function forgetIn(db: IndexDb, uid: string): boolean {
  if (!validUid(uid)) return false
  if (!db.getRef(uid)) return false
  db.deleteSession(uid)
  return true
}

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

export function addExclude(cfg: Config, glob: string): Config {
  if (!validGlob(glob)) throw new Error('exclusion glob is invalid or too long')
  const exclude = [...cfg.exclude]
  if (!exclude.includes(glob)) exclude.push(glob)
  return { ...cfg, exclude, hiddenClients: [...cfg.hiddenClients] }
}

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

export async function runExclude(glob?: string): Promise<number> {
  if (!glob) {
    console.error('usage: nekyia exclude <glob>')
    return 2
  }
  if (!validGlob(glob)) {
    console.error('error: exclusion glob is invalid or too long')
    return 2
  }
  let duplicate = false
  await updateConfig((current) => {
    duplicate = current.exclude.includes(glob)
    return addExclude(current, glob)
  })
  console.error(duplicate ? `already excluded ${glob}` : `excluded ${glob}`)
  console.error('Exclusions apply at index time. Run "nekyia index --rebuild" to drop what is already indexed.')
  return 0
}
