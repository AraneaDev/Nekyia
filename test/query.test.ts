import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config } from '../src/config'
import { IndexDb } from '../src/core/db'
import { query, querySnapshot, readSessionSnapshot, recencyDecay } from '../src/core/query'
import type { SessionDoc, SessionRef } from '../src/types'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

function seed(db: IndexDb, over: Partial<SessionRef>, text: Partial<SessionDoc> = {}): SessionRef {
  const ref: SessionRef = {
    uid: 'claude:a',
    client: 'claude',
    nativeId: 'a',
    cwd: '/root/proj',
    gitBranch: 'main',
    title: 'untitled',
    startedAt: NOW,
    endedAt: NOW,
    turns: 1,
    parentNativeId: null,
    tier: 'resume',
    origin: 'manifest',
    sourcePaths: ['/x'],
    fingerprint: 'f',
    ...over,
  }
  db.upsertRef(ref)
  db.upsertDoc({ ref, prompts: [], prose: [], files: [], truncated: false, ...text })
  return ref
}

test('recencyDecay halves at one half-life and safely handles bad boundaries', () => {
  expect(recencyDecay(NOW - 14 * DAY, NOW, 14)).toBeCloseTo(0.5, 5)
  expect(recencyDecay(NOW, NOW, 14)).toBeCloseTo(1, 5)
  expect(recencyDecay(NOW + DAY, NOW, 14)).toBe(1)
  expect(recencyDecay(0, NOW, 14)).toBe(1)
  expect(recencyDecay(NOW, NOW, 0)).toBe(1)
  expect(recencyDecay(NOW, NOW, Number.NaN)).toBe(1)
  expect(recencyDecay(NOW, Number.POSITIVE_INFINITY, 14)).toBe(1)
})

test('with no query text, results are newest first with deterministic ties', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:old', nativeId: 'old', endedAt: NOW - 10 * DAY })
  seed(db, { uid: 'claude:z', nativeId: 'z' })
  seed(db, { uid: 'claude:a', nativeId: 'a' })
  expect(query(db, DEFAULT_CONFIG, { now: NOW }).map((r) => r.uid))
    .toEqual(['claude:a', 'claude:z', 'claude:old'])
  db.close()
})

test('exact file matching resolves relative facets against each session cwd', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:a', nativeId: 'a', cwd: '/work/a' }, { files: ['README.md'] })
  seed(db, { uid: 'claude:b', nativeId: 'b', cwd: '/work/b' }, { files: ['README.md'] })
  seed(db, { uid: 'claude:absolute', nativeId: 'absolute', cwd: '/elsewhere' }, {
    files: ['/work/a/src/../README.md'],
  })
  seed(db, { uid: 'claude:unknown', nativeId: 'unknown', cwd: null }, { files: ['README.md'] })

  expect(query(db, DEFAULT_CONFIG, { exactFile: '/work/a/./README.md' }).map((row) => row.uid))
    .toEqual(['claude:a', 'claude:absolute'])
  expect(query(db, DEFAULT_CONFIG, { exactFile: '/work/b/README.md' }).map((row) => row.uid))
    .toEqual(['claude:b'])
  // A relative request cannot be anchored, so it fails closed rather than
  // becoming an unfiltered search.
  expect(query(db, DEFAULT_CONFIG, { exactFile: 'README.md' })).toEqual([])
  expect(query(db, DEFAULT_CONFIG, { exactFile: '' })).toEqual([])
  // The broad search filter intentionally retains its existing fragment semantics.
  expect(query(db, DEFAULT_CONFIG, { file: 'README.md' }).map((row) => row.uid))
    .toHaveLength(4)
  db.close()
})

test('an exact path with no basename matches nothing without scanning for it', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:a', nativeId: 'a', cwd: '/work/a' }, { files: ['README.md'] })
  const original = db.fileFacetsContaining.bind(db)
  let scans = 0
  db.fileFacetsContaining = ((fragment: string) => {
    scans++
    return original(fragment)
  }) as typeof db.fileFacetsContaining

  // `/` normalizes to `/`, whose last segment is empty: an unguarded prefilter
  // would become LIKE '%%' and read the whole facet table to match nothing.
  expect(query(db, DEFAULT_CONFIG, { exactFile: '/' })).toEqual([])
  expect(scans).toBe(0)
  expect(query(db, DEFAULT_CONFIG, { exactFile: '/work/a/README.md' }).map((row) => row.uid))
    .toEqual(['claude:a'])
  expect(scans).toBe(1)
  db.close()
})

test('the search path reads the narrow row shape and never resolves provenance', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:a', nativeId: 'a', sourcePaths: ['/transcripts/a.jsonl'] })
  const original = db.getRef.bind(db)
  let refReads = 0
  db.getRef = ((uid: string) => {
    refReads++
    return original(uid)
  }) as typeof db.getRef

  const rows = query(db, DEFAULT_CONFIG, { now: NOW })
  expect(rows).toHaveLength(1)
  // The picker searches on every keystroke, so the row it gets back must not
  // carry a field that costs a JSON parse per row and that nothing renders.
  expect(Object.keys(rows[0]!)).not.toContain('sourcePaths')
  expect(Object.keys(db.searchRefs()[0]!)).not.toContain('sourcePaths')
  expect(refReads).toBe(0)
  db.close()
})

test('a session snapshot is stable while ordinary queries see later database writes', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:first', nativeId: 'first' })
  const snapshot = readSessionSnapshot(db)
  seed(db, { uid: 'claude:later', nativeId: 'later', endedAt: NOW + 1 })

  expect(querySnapshot(db, DEFAULT_CONFIG, snapshot).map((row) => row.uid))
    .toEqual(['claude:first'])
  expect(query(db, DEFAULT_CONFIG).map((row) => row.uid))
    .toEqual(['claude:later', 'claude:first'])
  db.close()
})

test('searching a snapshot never reads the session table again', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:root', nativeId: 'root' }, { prose: ['needle'] })
  seed(
    db,
    { uid: 'claude:fork', nativeId: 'fork', parentNativeId: 'root', endedAt: NOW + 1 },
    { prose: ['needle'] },
  )

  const snapshot = readSessionSnapshot(db)
  const original = db.searchRefs.bind(db)
  let reads = 0
  db.searchRefs = (() => {
    reads++
    return original()
  }) as typeof db.searchRefs

  // The fork chain collapses the same way on every pass, so the components are
  // reused rather than rebuilt alongside a fresh read of the table.
  for (const text of ['', 'needle', 'untitled needle', 'untitled']) {
    expect(querySnapshot(db, DEFAULT_CONFIG, snapshot, { text: text || undefined, now: NOW })
      .map((row) => row.uid)).toEqual(['claude:fork'])
  }
  expect(reads).toBe(0)
  expect(query(db, DEFAULT_CONFIG, { now: NOW }).map((row) => row.uid)).toEqual(['claude:fork'])
  expect(reads).toBe(1)
  db.close()
})

test('weighted relevance and recency decay produce the intended rankings', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:title', nativeId: 'title', title: 'needle' }, { prose: ['needle'] })
  seed(db, { uid: 'claude:prose', nativeId: 'prose', title: 'unrelated' }, { prose: ['needle needle'] })
  expect(query(db, DEFAULT_CONFIG, { text: 'needle', sort: 'relevance', now: NOW })[0]?.uid)
    .toBe('claude:title')

  seed(db, {
    uid: 'claude:old', nativeId: 'old', endedAt: NOW - 365 * DAY, title: 'sse sse sse',
  }, { prompts: ['sse sse sse sse'] })
  seed(db, {
    uid: 'claude:new', nativeId: 'new', endedAt: NOW, title: 'sse reconnect',
  }, { prompts: ['fix the sse reconnect'] })
  expect(query(db, DEFAULT_CONFIG, { text: 'sse', now: NOW })[0]?.uid).toBe('claude:new')
  expect(query(db, DEFAULT_CONFIG, { text: 'sse', sort: 'relevance', now: NOW })[0]?.uid)
    .toBe('claude:old')
  db.close()
})

test('recent sort still requires a text match but ignores relevance', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:strong', nativeId: 'strong', endedAt: NOW - DAY, title: 'term term term' })
  seed(db, { uid: 'claude:weak', nativeId: 'weak', endedAt: NOW, title: 'term' })
  seed(db, { uid: 'claude:nope', nativeId: 'nope', endedAt: NOW + DAY, title: 'other' })
  expect(query(db, DEFAULT_CONFIG, { text: 'term', sort: 'recent', now: NOW }).map((r) => r.uid))
    .toEqual(['claude:weak', 'claude:strong'])
  db.close()
})

test('FTS input is literal-safe for punctuation and empty punctuation never throws', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:punct', nativeId: 'punct', title: 'fix sse reconnect quoted' })
  expect(query(db, DEFAULT_CONFIG, { text: 'sse: reconnect* "quoted"', now: NOW }).map((r) => r.uid))
    .toEqual(['claude:punct'])
  expect(() => query(db, DEFAULT_CONFIG, { text: '" OR : * - ( )', now: NOW })).not.toThrow()
  expect(query(db, DEFAULT_CONFIG, { text: '" OR : * - ( )', now: NOW })).toEqual([])
  db.close()
})

test('punctuation-only input is safe but operational FTS failures still propagate', () => {
  const db = IndexDb.open(':memory:')
  db.close()
  expect(query(db, DEFAULT_CONFIG, { text: ': * - ( )', now: NOW })).toEqual([])
  expect(() => query(db, DEFAULT_CONFIG, { text: 'needle', now: NOW })).toThrow()
})

test('cwd scope normalizes boundaries, trailing separators, dot segments, and Windows paths', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:exact', nativeId: 'exact', cwd: '/root/proj' })
  seed(db, { uid: 'claude:in', nativeId: 'in', cwd: '/root/proj/pkg/../sub' })
  seed(db, { uid: 'claude:sibling', nativeId: 'sibling', cwd: '/root/project-other' })
  seed(db, { uid: 'claude:win', nativeId: 'win', cwd: 'C:\\Work\\Repo\\sub' })
  seed(db, { uid: 'claude:win-sibling', nativeId: 'win-sibling', cwd: 'C:\\Work\\Repository' })
  expect(query(db, DEFAULT_CONFIG, { cwd: '/root/proj/', now: NOW }).map((r) => r.uid))
    .toEqual(['claude:exact', 'claude:in'])
  expect(query(db, DEFAULT_CONFIG, { cwd: 'c:/work/repo\\', now: NOW }).map((r) => r.uid))
    .toEqual(['claude:win'])
  db.close()
})

test('Windows drive roots are case-insensitive anchors that traversal cannot escape', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:work', nativeId: 'work', cwd: 'C:\\WORK\\Repo' })
  seed(db, { uid: 'claude:rooted', nativeId: 'rooted', cwd: 'c:/../../Windows/System32' })
  seed(db, { uid: 'claude:other-drive', nativeId: 'other-drive', cwd: 'D:\\Work' })
  expect(query(db, DEFAULT_CONFIG, { cwd: 'c:\\', now: NOW }).map((r) => r.uid))
    .toEqual(['claude:rooted', 'claude:work'])
  expect(query(db, DEFAULT_CONFIG, { cwd: 'C:/windows', now: NOW }).map((r) => r.uid))
    .toEqual(['claude:rooted'])
  expect(query(db, DEFAULT_CONFIG, { cwd: 'c:\\work\\repo\\..\\repo', now: NOW }).map((r) => r.uid))
    .toEqual(['claude:work'])
  db.close()
})

test('UNC share roots are case-insensitive anchors and do not cross shares', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:unc', nativeId: 'unc', cwd: '\\\\SERVER\\Share\\Dir' })
  seed(db, { uid: 'claude:unc-rooted', nativeId: 'unc-rooted', cwd: '//server/share/../../Windows' })
  seed(db, { uid: 'claude:unc-other', nativeId: 'unc-other', cwd: '\\\\server\\other\\Dir' })
  expect(query(db, DEFAULT_CONFIG, { cwd: '\\\\server\\SHARE', now: NOW }).map((r) => r.uid))
    .toEqual(['claude:unc', 'claude:unc-rooted'])
  db.close()
})

test('fork chains collapse to newest member and retain the best score', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:root', nativeId: 'root', endedAt: NOW - 2 * DAY, title: 'needle needle' })
  seed(db, { uid: 'claude:mid', nativeId: 'mid', parentNativeId: 'root', endedAt: NOW - DAY, title: 'needle' })
  seed(db, { uid: 'claude:tip', nativeId: 'tip', parentNativeId: 'mid', endedAt: NOW, title: 'needle' })
  const rows = query(db, DEFAULT_CONFIG, { text: 'needle', sort: 'relevance', now: NOW })
  expect(rows).toHaveLength(1)
  expect(rows[0]?.uid).toBe('claude:tip')
  expect(rows[0]?.collapsed).toBe(2)
  expect(rows[0]?.score).toBeGreaterThan(0)
  db.close()
})

test('cycles collapse deterministically and cross-client parents never connect', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:a', nativeId: 'a', parentNativeId: 'b', endedAt: NOW })
  seed(db, { uid: 'claude:b', nativeId: 'b', parentNativeId: 'a', endedAt: NOW })
  seed(db, { uid: 'codex:c', client: 'codex', nativeId: 'c', parentNativeId: 'a', endedAt: NOW })
  const rows = query(db, DEFAULT_CONFIG, { now: NOW })
  expect(rows.map((r) => [r.uid, r.collapsed])).toEqual([
    ['claude:a', 1],
    ['codex:c', 0],
  ])
  db.close()
})

test('orphan siblings can collapse through their absent parent', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:a', nativeId: 'a', parentNativeId: 'absent', endedAt: NOW - DAY })
  seed(db, { uid: 'claude:b', nativeId: 'b', parentNativeId: 'absent', endedAt: NOW })
  expect(query(db, DEFAULT_CONFIG, { now: NOW }).map((r) => [r.uid, r.collapsed]))
    .toEqual([['claude:b', 1]])
  db.close()
})

test('filtered parents still connect visible descendants without inflating collapsed count', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:root', nativeId: 'root', endedAt: NOW - 2 * DAY })
  seed(db, { uid: 'claude:left', nativeId: 'left', parentNativeId: 'root', endedAt: NOW - DAY })
  seed(db, { uid: 'claude:right', nativeId: 'right', parentNativeId: 'root', endedAt: NOW })
  db.markMissing(['claude:root'])
  const rows = query(db, DEFAULT_CONFIG, { now: NOW })
  expect(rows.map((r) => [r.uid, r.collapsed])).toEqual([['claude:right', 1]])
  db.close()
})

test('duplicate native IDs do not overwrite rows or create ambiguous parent edges', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:dup-1', nativeId: 'dup', cwd: '/one' })
  seed(db, { uid: 'claude:dup-2', nativeId: 'dup', cwd: '/two' })
  seed(db, { uid: 'claude:child', nativeId: 'child', parentNativeId: 'dup' })
  expect(query(db, DEFAULT_CONFIG, { now: NOW }).map((r) => r.uid))
    .toEqual(['claude:child', 'claude:dup-1', 'claude:dup-2'])
  db.close()
})

test('missing, client, hidden-client, and file filters compose', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:gone', nativeId: 'gone' }, { files: ['src/shared.ts'] })
  db.markMissing(['claude:gone'])
  seed(db, { uid: 'codex:shared', client: 'codex', nativeId: 'shared' }, { files: ['src/shared.ts'] })
  seed(db, { uid: 'codex:shown', client: 'codex', nativeId: 'shown' }, { files: ['src/other.ts'] })

  expect(query(db, DEFAULT_CONFIG, { file: 'shared', now: NOW }).map((r) => r.uid))
    .toEqual(['codex:shared'])
  expect(query(db, DEFAULT_CONFIG, {
    file: 'shared', client: 'codex', includeMissing: true, now: NOW,
  }).map((r) => r.uid)).toEqual(['codex:shared'])
  expect(query(db, { ...DEFAULT_CONFIG, hiddenClients: ['codex'] }, {
    includeMissing: true, now: NOW,
  }).map((r) => r.uid)).toEqual(['claude:gone'])
  db.close()
})

test('limit has explicit zero and negative semantics and applies after collapse', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:root', nativeId: 'root', endedAt: NOW - DAY })
  seed(db, { uid: 'claude:tip', nativeId: 'tip', parentNativeId: 'root', endedAt: NOW })
  seed(db, { uid: 'claude:other', nativeId: 'other', endedAt: NOW - 2 * DAY })
  expect(query(db, DEFAULT_CONFIG, { limit: 1, now: NOW }).map((r) => r.uid)).toEqual(['claude:tip'])
  expect(query(db, DEFAULT_CONFIG, { limit: 0, now: NOW })).toEqual([])
  expect(query(db, DEFAULT_CONFIG, { limit: -1, now: NOW })).toEqual([])
  db.close()
})

test('invalid runtime option and config values degrade safely', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:a', nativeId: 'a', title: 'needle' })
  const badCfg = {
    ...DEFAULT_CONFIG,
    halfLifeDays: Number.NaN,
    hiddenClients: null,
  } as unknown as Config
  const badOpts = {
    text: 42,
    cwd: 42,
    client: 42,
    file: 42,
    sort: 'sideways',
    limit: Number.NaN,
    now: Number.POSITIVE_INFINITY,
  } as never
  // Every unusable value is ignored rather than thrown on or read as a filter,
  // so the search still answers with the sessions the index holds.
  expect(() => query(db, badCfg, badOpts)).not.toThrow()
  expect(query(db, badCfg, badOpts).map((r) => r.uid)).toEqual(['claude:a'])
  db.close()
})

test('a collapsed chain names the session that actually earned its score', () => {
  // The row is the newest session in the chain, but the score is the best any
  // member scored, which is right for ranking a chain and wrong to read as one
  // session's own relevance. A caller sorting or displaying `score` was told a
  // number the named session did not earn, with nothing on the row admitting it.
  const db = IndexDb.open(':memory:')
  const parent = seed(
    db,
    { uid: 'claude:parent', nativeId: 'parent', endedAt: NOW - DAY, title: 'reconnect' },
    { prompts: ['reconnect reconnect reconnect the socket reconnect'] },
  )
  seed(
    db,
    {
      uid: 'claude:child', nativeId: 'child', endedAt: NOW, title: 'follow up',
      parentNativeId: 'parent',
    },
    { prompts: ['one passing mention of reconnect'] },
  )

  const rows = query(db, DEFAULT_CONFIG, { text: 'reconnect', sort: 'relevance' })
  expect(rows).toHaveLength(1)
  // The newest session stays the row, because it is the one worth resuming.
  expect(rows[0]!.uid).toBe('claude:child')
  expect(rows[0]!.collapsed).toBe(1)
  // And the score is now attributed to the member that earned it.
  expect(rows[0]!.matchedUid).toBe(parent.uid)
  db.close()
})

test('a row that earned its own score claims no other session', () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:solo', nativeId: 'solo', title: 'reconnect the socket' })
  const rows = query(db, DEFAULT_CONFIG, { text: 'reconnect' })
  expect(rows).toHaveLength(1)
  expect(rows[0]!.matchedUid).toBeUndefined()
  db.close()
})
