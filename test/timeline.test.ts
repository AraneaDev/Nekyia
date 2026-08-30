import { expect, test } from 'bun:test'
import { IndexDb } from '../src/core/db'
import { timeline } from '../src/core/timeline'
import type { FileEvent, SessionDoc, SessionRef } from '../src/types'

function ref(over: Partial<SessionRef> = {}): SessionRef {
  return {
    uid: 'claude:a', client: 'claude', nativeId: 'a', cwd: '/root/proj', gitBranch: 'main',
    title: 'fix the sse race', startedAt: 1000, endedAt: 2000, turns: 4,
    parentNativeId: null, tier: 'resume', origin: 'manifest',
    sourcePaths: ['/a.jsonl'], fingerprint: '1:1', ...over,
  }
}
function doc(r: SessionRef, over: Partial<SessionDoc> = {}): SessionDoc {
  return { ref: r, prompts: [], prose: [], files: [], truncated: false, ...over }
}
const events: FileEvent[] = [
  { path: 'src/sse.ts', kind: 'read', turn: 1 },
  { path: 'src/sse.ts', kind: 'edit', turn: 3 },
]

test('events under the directory come back in ordinal order', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r)
  db.upsertDoc(doc(r,{ files:['src/sse.ts'], fileEvents: events, fileDetail:'ordered' }))
  const [session]=timeline(db,{ dir:'/root/proj' })
  expect(session?.detail).toBe('ordered')
  expect(session?.entries.map(e=>[e.kind, e.resolved])).toEqual([
    ['read','/root/proj/src/sse.ts'], ['edit','/root/proj/src/sse.ts'],
  ]); db.close()
})
test('an event outside the directory is left out', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r)
  db.upsertDoc(doc(r,{ files:['/etc/hosts'], fileEvents:[{ path:'/etc/hosts', kind:'read', turn:0 }], fileDetail:'ordered' }))
  expect(timeline(db,{ dir:'/root/proj' })).toEqual([]); db.close()
})
test('a paths-only session appears with unordered entries', () => {
  const db=IndexDb.open(':memory:'); const r=ref({ uid:'copilot:b', client:'copilot' })
  db.upsertRef(r); db.upsertDoc(doc(r,{ files:['src/db.ts'] }))
  const [session]=timeline(db,{ dir:'/root/proj' })
  expect(session?.detail).toBe('paths')
  expect(session?.entries).toEqual([
    { ordinal:null, turn:null, kind:'unknown', path:'src/db.ts', resolved:'/root/proj/src/db.ts' },
  ]); db.close()
})
test('sessions are ordered newest first and bounded by limit', () => {
  const db=IndexDb.open(':memory:')
  for (const [uid, endedAt] of [['claude:a',1000],['claude:b',3000],['claude:c',2000]] as const) {
    const r=ref({ uid, nativeId:uid, endedAt })
    db.upsertRef(r); db.upsertDoc(doc(r,{ files:['x.ts'], fileEvents:[{path:'x.ts',kind:'edit',turn:0}], fileDetail:'ordered' }))
  }
  expect(timeline(db,{ dir:'/root/proj', limit:2 }).map(s=>s.ref.uid)).toEqual(['claude:b','claude:c']); db.close()
})
test('since filters whole sessions by end time', () => {
  const db=IndexDb.open(':memory:')
  const old=ref({ uid:'claude:old', endedAt:1000 }); const recent=ref({ uid:'claude:new', endedAt:9000 })
  for (const r of [old, recent]) {
    db.upsertRef(r); db.upsertDoc(doc(r,{ files:['x.ts'], fileEvents:[{path:'x.ts',kind:'edit',turn:0}], fileDetail:'ordered' }))
  }
  expect(timeline(db,{ dir:'/root/proj', since:5000 }).map(s=>s.ref.uid)).toEqual(['claude:new']); db.close()
})
test('a session indexed before file events keeps unknown detail', () => {
  const db=IndexDb.open(':memory:'); const r=ref(); db.upsertRef(r)
  db.upsertDoc(doc(r,{ files:['src/sse.ts'] }))
  db.raw().query("UPDATE session SET file_detail = 'unknown' WHERE uid = ?").run('claude:a')
  expect(timeline(db,{ dir:'/root/proj' })[0]?.detail).toBe('unknown'); db.close()
})
test('a root directory covers everything under it', () => {
  const db=IndexDb.open(':memory:'); const r=ref()
  db.upsertRef(r)
  db.upsertDoc(doc(r,{ files:['/etc/hosts'], fileEvents:[{ path:'/etc/hosts', kind:'read', turn:0 }], fileDetail:'ordered' }))
  // `/` already names a root, so appending a second slash would leave the one
  // directory that contains everything matching only UNC paths.
  const [session]=timeline(db,{ dir:'/' })
  expect(session?.entries.map(e=>e.resolved)).toEqual(['/etc/hosts']); db.close()
})
test('a session with no directory of its own is found under a root prefix', () => {
  const db=IndexDb.open(':memory:')
  const r=ref({ uid:'claude:elsewhere', cwd:null })
  db.upsertRef(r)
  db.upsertDoc(doc(r,{ files:['/srv/app/main.ts'], fileEvents:[{ path:'/srv/app/main.ts', kind:'edit', turn:0 }], fileDetail:'ordered' }))
  expect(timeline(db,{ dir:'/' }).map(s=>s.ref.uid)).toEqual(['claude:elsewhere']); db.close()
})
test('capped sessions with truncated events fall back to unordered facets', () => {
  const db=IndexDb.open(':memory:'); const r=ref()
  db.upsertRef(r)
  db.upsertDoc(doc(r,{
    files:['src/db.ts', '/etc/hosts'],
    fileEvents:[{ path:'/etc/hosts', kind:'read', turn:0 }],
    fileDetail:'ordered',
    fileEventsTruncated:true
  }))
  const [session]=timeline(db,{ dir:'/root/proj' })
  expect(session?.detail).toBe('paths')
  expect(session?.entries).toEqual([
    { ordinal:null, turn:null, kind:'unknown', path:'src/db.ts', resolved:'/root/proj/src/db.ts' },
  ])
  db.close()
})
