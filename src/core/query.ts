import type { Config } from '../config'
import type { IndexDb, SearchRef } from './db'

/** Everything a search can be narrowed or sorted by. Omitted fields mean no constraint. */
export interface QueryOpts {
  text?: string
  cwd?: string
  client?: string
  file?: string
  sort?: 'auto' | 'recent' | 'relevance'
  limit?: number
  includeMissing?: boolean
  /** Injectable for deterministic tests. */
  now?: number
}

/**
 * A search result: the stored session, its blended score, and how much of its fork chain folded into it.
 *
 * Provenance is deliberately absent. Nothing downstream of a search resolves a
 * session back to its files, so `SearchRef` leaves those columns unread rather
 * than handing on values a caller would have to trust.
 */
export interface Row extends SearchRef {
  score: number
  /** How many older sessions in this fork chain were folded into this row. */
  collapsed: number
}

const DAY = 86_400_000

/**
 * Weights a session by age on a half-life curve, so an old exact match can still lose to a recent near one.
 *
 * Returns 1 for anything it cannot date, leaving relevance to decide rather
 * than inventing a penalty from a missing timestamp.
 */
export function recencyDecay(endedAt: number, now: number, halfLifeDays: number): number {
  if (!Number.isFinite(endedAt) || endedAt === 0
    || !Number.isFinite(now) || !Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return 1
  }
  const ageDays = Math.max(0, (now - endedAt) / DAY)
  return Math.pow(0.5, ageDays / halfLifeDays)
}

function normalizedPath(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const slashed = trimmed.replace(/\\/g, '/')
  if (slashed.startsWith('//')) {
    const [server, share, ...tail] = slashed.slice(2).split('/').filter(Boolean)
    if (!server || !share || server === '.' || server === '..' || share === '.' || share === '..') {
      return null
    }
    const parts: string[] = []
    for (const part of tail) {
      if (part === '.') continue
      if (part === '..') {
        if (parts.length > 0) parts.pop()
      } else {
        parts.push(part)
      }
    }
    const suffix = parts.length > 0 ? `/${parts.join('/')}` : ''
    return `//${server}/${share}${suffix}`.toLowerCase()
  }

  const drive = slashed.match(/^([A-Za-z]:)\//)
  if (drive) {
    const parts: string[] = []
    for (const part of slashed.slice(drive[0].length).split('/')) {
      if (!part || part === '.') continue
      if (part === '..') {
        if (parts.length > 0) parts.pop()
      } else {
        parts.push(part)
      }
    }
    return `${drive[1]!.toLowerCase()}/${parts.join('/')}`.toLowerCase()
  }

  const absolute = slashed.startsWith('/')
  const parts: string[] = []
  for (const part of slashed.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') parts.pop()
      else if (!absolute) parts.push(part)
    } else {
      parts.push(part)
    }
  }

  let result = `${absolute ? '/' : ''}${parts.join('/')}`
  if (!result) result = absolute ? '/' : '.'
  return result
}

/** True when `cwd` is `scope` or lives beneath it. */
function underScope(cwd: string | null, scope: string): boolean {
  if (!cwd) return false
  const child = normalizedPath(cwd)
  const parent = normalizedPath(scope)
  if (!child || !parent) return false
  if (child === parent) return true
  return parent.endsWith('/') ? child.startsWith(parent) : child.startsWith(`${parent}/`)
}

/**
 * FTS5 punctuation is query syntax. Extract the same kinds of word tokens that
 * unicode61 indexes, then quote them so operators such as OR remain literals.
 */
function literalFtsQuery(text: string): string | null {
  const terms = text.match(/[\p{L}\p{N}_]+/gu)
  if (!terms?.length) return null
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' ')
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function compareUid(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

class Components {
  private readonly parents: number[]

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index)
  }

  find(index: number): number {
    let root = index
    while (this.parents[root] !== root) root = this.parents[root]!
    while (this.parents[index] !== index) {
      const parent = this.parents[index]!
      this.parents[index] = root
      index = parent
    }
    return root
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left)
    const rightRoot = this.find(right)
    if (leftRoot === rightRoot) return
    // Stable roots make corrupt cycles and equivalent inputs deterministic.
    if (leftRoot < rightRoot) this.parents[rightRoot] = leftRoot
    else this.parents[leftRoot] = rightRoot
  }
}

/** Build chain membership from every row, including rows later removed by filters. */
function chainComponents(rows: readonly SearchRef[]): Components {
  const components = new Components(rows.length)
  const byNative = new Map<string, number[]>()
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    const key = `${row.client}\0${row.nativeId}`
    const matches = byNative.get(key)
    if (matches) matches.push(index)
    else byNative.set(key, [index])
  }

  const orphanChildren = new Map<string, number>()
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    if (!row.parentNativeId) continue
    const parentKey = `${row.client}\0${row.parentNativeId}`
    const parents = byNative.get(parentKey)
    if (parents?.length === 1) {
      components.union(index, parents[0]!)
    } else if (!parents) {
      // Two children of an omitted parent are still forks of one conversation.
      const sibling = orphanChildren.get(parentKey)
      if (sibling === undefined) orphanChildren.set(parentKey, index)
      else components.union(index, sibling)
    }
    // Duplicate native IDs make the edge ambiguous; keeping it disconnected is
    // safer than silently merging unrelated conversations.
  }
  return components
}

function collapseChains(
  rows: Row[],
  allRows: readonly SearchRef[],
  components: Components,
): Row[] {
  const indexByUid = new Map(allRows.map((row, index) => [row.uid, index]))
  const groups = new Map<number, Row[]>()
  for (const row of rows) {
    const index = indexByUid.get(row.uid)
    if (index === undefined) continue
    const root = components.find(index)
    const group = groups.get(root)
    if (group) group.push(row)
    else groups.set(root, [row])
  }

  return [...groups.values()].map((group) => {
    const winner = group.reduce((best, candidate) => {
      const time = finite(candidate.endedAt)
      const bestTime = finite(best.endedAt)
      return time > bestTime || (time === bestTime && compareUid(candidate.uid, best.uid) < 0)
        ? candidate
        : best
    })
    return {
      ...winner,
      score: Math.max(...group.map((row) => finite(row.score))),
      collapsed: group.length - 1,
    }
  })
}

/**
 * Every indexed session as one search read them, held still for as long as the caller keeps it.
 *
 * A caller that searches repeatedly over an unchanging index, the picker once
 * per keystroke, reads the table once and hands the same array back, rather
 * than paying for a full table scan and a fresh fork-chain pass each time. The
 * cost is that the snapshot cannot see writes made after it was taken, so only
 * a caller that knows the index is not moving underneath it should hold one.
 */
export type SessionSnapshot = readonly SearchRef[]

/**
 * The fork-chain components of a snapshot, keyed by the snapshot itself.
 *
 * Union-find over the whole table is the expensive half of a search, and it
 * depends on nothing but the rows. Keying on the array means a snapshot that
 * goes out of scope takes its components with it, and a one-shot `query` gets
 * the same treatment as the picker without either having to say so.
 */
const snapshotComponents = new WeakMap<SessionSnapshot, Components>()

/** Reads the session table once, in the narrow shape a search consumes. */
export function readSessionSnapshot(db: IndexDb): SessionSnapshot {
  return db.searchRefs()
}

/** The snapshot's fork chains, built on first use and reused by every later search over it. */
function componentsFor(snapshot: SessionSnapshot): Components {
  const cached = snapshotComponents.get(snapshot)
  if (cached) return cached
  const components = chainComponents(snapshot)
  snapshotComponents.set(snapshot, components)
  return components
}

/**
 * The one search implementation, over a caller's snapshot or over a fresh read.
 *
 * A null snapshot means read the table, and it is read lazily so that input
 * which cannot become an FTS query still costs nothing.
 */
function search(
  db: IndexDb,
  cfg: Config,
  snapshot: SessionSnapshot | null,
  opts: QueryOpts,
): Row[] {
  const unsafeOpts = opts as Record<string, unknown>
  const text = typeof unsafeOpts.text === 'string' ? unsafeOpts.text.trim() : ''
  const hasText = text.length > 0
  const sort = unsafeOpts.sort === 'recent' || unsafeOpts.sort === 'relevance'
    ? unsafeOpts.sort
    : 'auto'
  const now = typeof unsafeOpts.now === 'number' && Number.isFinite(unsafeOpts.now)
    ? unsafeOpts.now
    : Date.now()

  let scores: Map<string, number> | null = null
  if (hasText) {
    const ftsQuery = literalFtsQuery(text)
    if (!ftsQuery) return []
    scores = new Map(db.ftsSearch(ftsQuery).map((hit) => [hit.uid, finite(hit.score)]))
    if (scores.size === 0) return []
  }

  const file = typeof unsafeOpts.file === 'string' && unsafeOpts.file.length > 0
    ? unsafeOpts.file
    : null
  const fileUids = file ? new Set(db.uidsTouchingFile(file)) : null
  const allRows = snapshot ?? db.searchRefs()
  const components = componentsFor(allRows)

  const config = cfg as unknown as Record<string, unknown>
  const hiddenClients = new Set(
    Array.isArray(config.hiddenClients)
      ? config.hiddenClients.filter((client): client is string => typeof client === 'string')
      : [],
  )
  const halfLifeDays = finite(config.halfLifeDays)
  const cwd = typeof unsafeOpts.cwd === 'string' && unsafeOpts.cwd.trim() ? unsafeOpts.cwd : null
  const client = typeof unsafeOpts.client === 'string' && unsafeOpts.client ? unsafeOpts.client : null
  const includeMissing = unsafeOpts.includeMissing === true

  const kept = allRows.filter((row) => {
    if (!includeMissing && row.missing) return false
    if (hiddenClients.has(row.client)) return false
    if (client && row.client !== client) return false
    if (cwd && !underScope(row.cwd, cwd)) return false
    if (fileUids && !fileUids.has(row.uid)) return false
    if (scores && !scores.has(row.uid)) return false
    return true
  })

  const scored: Row[] = kept.map((row) => {
    const endedAt = finite(row.endedAt)
    const relevance = scores?.get(row.uid) ?? 0
    const score = !scores || sort === 'recent'
      ? endedAt
      : sort === 'relevance'
        ? relevance
        : relevance * recencyDecay(endedAt, now, halfLifeDays)
    return { ...row, score: finite(score), collapsed: 0 }
  })

  const collapsed = collapseChains(scored, allRows, components)
  collapsed.sort((left, right) => {
    const score = finite(right.score) - finite(left.score)
    if (score) return score
    const ended = finite(right.endedAt) - finite(left.endedAt)
    return ended || compareUid(left.uid, right.uid)
  })

  if (unsafeOpts.limit === undefined) return collapsed
  if (typeof unsafeOpts.limit !== 'number' || !Number.isFinite(unsafeOpts.limit)) return collapsed
  const limit = Math.max(0, Math.floor(unsafeOpts.limit))
  return collapsed.slice(0, limit)
}

/**
 * Runs a search against the index as it is right now.
 *
 * Every non-interactive caller comes through here and reads the session table
 * afresh, so a session marked missing between two commands is missing in the
 * second one.
 */
export function query(db: IndexDb, cfg: Config, opts: QueryOpts = {}): Row[] {
  return search(db, cfg, null, opts)
}

/**
 * Runs a search over a caller-held snapshot, blending weighted text relevance
 * with recency and collapsing each fork chain to its newest session.
 *
 * Text and file matching still go to the live index; only the session table and
 * the fork chains over it are the caller's frozen copy.
 */
export function querySnapshot(
  db: IndexDb,
  cfg: Config,
  snapshot: SessionSnapshot,
  opts: QueryOpts = {},
): Row[] {
  return search(db, cfg, snapshot, opts)
}
