import type { Worker as BunWorker } from 'bun'
import type { Config } from '../config'
import type { QueryOpts, Row, SessionSnapshot } from '../core/query'
import type { EmptySuggestion } from './empty-state'
import type { MatchEvidence } from '../core/search-match'

/** Only read-only search and evidence operations cross the worker boundary. */
export type SearchJob =
  | { kind: 'search'; cfg: Config; opts: QueryOpts; preferredUid?: string | null; suggestions?: Array<{item: EmptySuggestion; opts: QueryOpts}> }
  | { kind: 'evidence'; uid: string; expression: string }
/** Search results carry the first row's evidence so rendering never repeats broad prefix FTS. */
export interface SearchAnswer {
  rows: Row[]
  evidence: MatchEvidence | null
  expression: string | null
  suggestions?: EmptySuggestion[]
}
/** One in-flight operation and at most one superseding request; intermediate keystrokes never queue up. */
interface Pending {
  id: number
  job: SearchJob
  resolve: (answer: SearchAnswer | null) => void
  reject: (error: Error) => void
}

/** Keeps SQLite work off Ink's input thread and discards obsolete results. */
export class BackgroundSearch {
  private worker: Worker & Pick<BunWorker, 'unref'>
  private revision = new Int32Array(new SharedArrayBuffer(4))
  private serial = 0
  private active: Pending | null = null
  private pending: Pending | null = null
  private closed = false

  /** The worker opens its own read-only handle, using the same frozen session snapshot. */
  constructor(path: string, snapshot: SessionSnapshot) {
    this.worker = new Worker(new URL('./search-background-worker.ts', import.meta.url).href) as Worker & Pick<BunWorker, 'unref'>
    this.worker.unref()
    /** Accept only the reply to the active operation. */
    this.worker.onmessage = (event: MessageEvent<{id: number; answer?: SearchAnswer; error?: string}>) => {
      const message = event.data
      const active = this.active
      if (!active || message.id !== active.id) return
      this.active = null
      if (active.id !== this.serial) active.resolve(null)
      else if (typeof message.error === 'string') active.reject(new Error(message.error))
      else active.resolve(message.answer ?? null)
      this.send()
    }
    /** Worker failure is visible and cannot strand a request. */
    this.worker.onerror = (event) => this.fail(new Error(event.message || 'Background search failed'))
    this.worker.postMessage({ kind: 'init', path, snapshot, revision: this.revision.buffer })
  }

  /** Replaces pending work; only the latest request may update the picker. */
  request(job: SearchJob): Promise<SearchAnswer | null> {
    if (this.closed) return Promise.reject(new Error('Background search is unavailable; restart the picker'))
    const id = ++this.serial
    Atomics.store(this.revision, 0, id)
    this.pending?.resolve(null)
    return new Promise((resolve, reject) => {
      this.pending = { id, job, resolve, reject }
      this.send()
    })
  }

  /** Never submit another SQLite job until the current one returns. */
  private send(): void {
    if (this.closed || this.active || !this.pending) return
    this.active = this.pending
    this.pending = null
    try { this.worker.postMessage({ kind: 'job', id: this.active.id, job: this.active.job }) }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
  }

  /** Surface failures instead of silently blocking the input thread with a synchronous fallback. */
  private fail(error: Error): void {
    this.active?.reject(error)
    this.pending?.reject(error)
    this.active = null
    this.pending = null
    this.closed = true
    this.worker.terminate()
  }

  /** Settle every waiter and release the read-only connection with its worker. */
  close(): void {
    this.closed = true
    this.active?.resolve(null)
    this.pending?.resolve(null)
    this.active = null
    this.pending = null
    this.worker.terminate()
  }
}
