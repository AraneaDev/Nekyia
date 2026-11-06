import { IndexDb } from '../core/db'
import { querySnapshot, type SessionSnapshot } from '../core/query'
import { compileSearch } from '../core/search-text'
import { readMatchEvidence } from '../core/search-match'
import { readSessionDetail } from '../core/session-detail'
import type { SearchAnswer, SearchJob } from './search-background'

let db: IndexDb | null = null
let snapshot: SessionSnapshot = []
let revision: Int32Array | null = null
let startupError: string | null = null

/** The worker cannot launch clients, index sources, or mutate the index. */
self.onmessage = (event: MessageEvent<
  { kind: 'init'; path: string; snapshot: SessionSnapshot; revision: SharedArrayBuffer } | { kind: 'job'; id: number; job: SearchJob }
>) => {
  const message = event.data
  if (message.kind === 'init') {
    try { db = IndexDb.openReadonly(message.path); snapshot = message.snapshot; revision = new Int32Array(message.revision) }
    catch (error) { startupError = error instanceof Error ? error.message : String(error) }
    return
  }
  try {
    if (!db) throw new Error(startupError ?? 'Search index unavailable')
    const job = message.job
    let answer: SearchAnswer
    if (job.kind === 'search') {
      const rows = querySnapshot(db, job.cfg, snapshot, job.opts)
      if (revision && Atomics.load(revision, 0) !== message.id) { self.postMessage({id: message.id}); return }
      const chosen = rows.find(row => row.uid === job.preferredUid) ?? rows[0]
      const uid = chosen?.matchedUid ?? chosen?.uid
      const expression = job.opts.text ? compileSearch(job.opts.text, job.opts.matchMode ?? 'literal') : null
      const evidence = uid && expression ? readMatchEvidence(db, uid, expression, readSessionDetail(db, uid).turns) : null
      const suggestions = []
      if (!rows.length) for (const candidate of job.suggestions ?? []) {
        if (revision && Atomics.load(revision, 0) !== message.id) break
        if (querySnapshot(db, job.cfg, snapshot, candidate.opts).length) suggestions.push(candidate.item)
      }
      answer = { rows, evidence, expression, suggestions }
    } else {
      answer = { rows: [], expression: job.expression,
        evidence: readMatchEvidence(db, job.uid, job.expression, readSessionDetail(db, job.uid).turns) }
    }
    self.postMessage({ id: message.id, answer })
  } catch (error) {
    self.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) })
  }
}
