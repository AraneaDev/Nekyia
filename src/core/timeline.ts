import type { FileEventKind } from '../types'
import type { IndexDb, SearchRef } from './db'
import { isAbsolutePath, normalizedPath, resolveFacetPath } from './query'

/** One file operation, resolved against the session that recorded it. */
export interface TimelineEntry {
  /** Position in the session's log, or null for a client that records names only. */
  ordinal: number | null
  turn: number | null
  kind: FileEventKind
  /** The facet as recorded, which may be relative. */
  path: string
  resolved: string
}

/** One session's contribution to a directory's history. */
export interface TimelineSession {
  ref: SearchRef
  detail: 'unknown' | 'paths' | 'ordered'
  eventsTruncated: boolean
  entries: TimelineEntry[]
}

/** What a timeline can be narrowed by. Omitted fields mean no constraint. */
export interface TimelineOpts {
  dir: string
  since?: number
  client?: string
  limit?: number
}

const KINDS = new Set<string>(['read', 'write', 'edit', 'delete', 'move', 'unknown'])

/**
 * Whether a resolved path sits at or under a directory.
 *
 * The trailing-slash guard is what makes `--dir /` mean the whole filesystem:
 * a directory that already ends in a slash names a root, and appending a second
 * one would match only UNC paths. `underScope` in `query.ts` reads the same.
 */
function under(resolved: string, dir: string): boolean {
  if (resolved === dir) return true
  return dir.endsWith('/') ? resolved.startsWith(dir) : resolved.startsWith(`${dir}/`)
}

/**
 * Every file operation recorded under a directory, grouped by the session that
 * made it.
 *
 * Grouping is a correctness decision. Ordering inside a session is exact,
 * because the ordinal came from the transcript. Ordering between sessions is
 * `ended_at` and therefore coarse, so the groups are placed approximately and
 * nothing pretends otherwise.
 *
 * Candidates come from two arms, both index-served: a session whose own working
 * directory sits under the target, and a session holding a path that is already
 * absolute under it. Each candidate's facets are then resolved against its own
 * working directory, which is the only thing a relative facet means anything
 * against. A session whose directory is elsewhere and which named these files
 * relatively is not found, the same limit `blame` documents.
 */
export function timeline(db: IndexDb, opts: TimelineOpts): TimelineSession[] {
  const dir = normalizedPath(opts.dir)
  if (!dir || !isAbsolutePath(dir)) return []

  const byUid = new Map<string, SearchRef>()
  for (const ref of db.searchRefs()) byUid.set(ref.uid, ref)

  const candidates = new Set(db.uidsUnderPrefix(dir))
  for (const ref of byUid.values()) {
    const cwd = ref.cwd ? normalizedPath(ref.cwd) : null
    if (cwd && under(cwd, dir)) candidates.add(ref.uid)
  }

  const uids = [...candidates].filter((uid) => {
    const ref = byUid.get(uid)
    if (!ref) return false
    if (opts.client && ref.client !== opts.client) return false
    if (opts.since !== undefined && ref.endedAt < opts.since) return false
    return true
  })
  if (uids.length === 0) return []

  const details = db.fileDetailsFor(uids)
  const eventsByUid = new Map<string, TimelineEntry[]>()
  for (const row of db.fileEventsFor(uids)) {
    const ref = byUid.get(row.uid)
    const resolved = resolveFacetPath(row.path, ref?.cwd ?? null)
    if (!resolved || !under(resolved, dir)) continue
    const list = eventsByUid.get(row.uid) ?? []
    list.push({
      ordinal: row.ordinal,
      turn: row.turn,
      kind: KINDS.has(row.kind) ? row.kind as FileEventKind : 'unknown',
      path: row.path,
      resolved,
    })
    eventsByUid.set(row.uid, list)
  }

  const sessions: TimelineSession[] = []
  for (const uid of uids) {
    const ref = byUid.get(uid)!
    const detail = details.get(uid)?.detail
    const level = detail === 'ordered' || detail === 'paths' ? detail : 'unknown'
    // A reader that records names only still has something to say about this
    // directory, and dropping it would make a client silently vanish from a
    // recovery view. Its facets come back unordered, which is what they are.
    const entries = level === 'ordered'
      ? eventsByUid.get(uid) ?? []
      : db.fileFacetsForUid(uid)
        .map((path) => ({ path, resolved: resolveFacetPath(path, ref.cwd) }))
        .filter((item): item is { path: string; resolved: string } => (
          item.resolved !== null && under(item.resolved, dir)
        ))
        .map((item) => ({
          ordinal: null, turn: null, kind: 'unknown' as FileEventKind,
          path: item.path, resolved: item.resolved,
        }))
    if (entries.length === 0) continue
    sessions.push({
      ref,
      detail: level,
      eventsTruncated: details.get(uid)?.eventsTruncated ?? false,
      entries,
    })
  }

  sessions.sort((a, b) => b.ref.endedAt - a.ref.endedAt || (a.ref.uid < b.ref.uid ? -1 : 1))
  return opts.limit !== undefined ? sessions.slice(0, opts.limit) : sessions
}
