import type { Config } from '../config'
import type { Diagnostic, SessionDoc, SessionRef } from '../types'
import type { Adapter } from './adapter'
import type { IndexDb } from './db'

/** Hydration progress, reported so a long first index can show what it is working on. */
export interface Progress {
  done: number
  total: number
  client: string
}

/** Higher runs later. Codebuff files average 19 MB, so it goes behind everything. */
const PRIORITY: Record<string, number> = { codebuff: 1 }

/** Orders sessions so the cheap clients hydrate first and the heaviest store cannot stall visible progress. */
export function orderByPriority(refs: SessionRef[]): SessionRef[] {
  return [...refs].sort((a, b) => (PRIORITY[a.client] ?? 0) - (PRIORITY[b.client] ?? 0))
}

/**
 * Determines the number of hardware concurrency threads available, defaulting to 8.
 */
function concurrency(): number {
  try {
    const n = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
      ?.hardwareConcurrency
    return Number.isFinite(n) && n !== undefined && n > 1
      ? Math.min(Math.floor(n), 16)
      : 8
  } catch {
    return 8
  }
}

/**
 * Extracts a string message from an unknown error object.
 */
function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unknown error'
  }
}

/**
 * A document that carries nothing and blames a failed read rather than a cap.
 *
 * Readers are not uniform about how they report an unreadable source: some
 * throw, and some catch their own I/O failure and return an empty document
 * marked degraded. Committing the second kind deletes a good indexed copy and
 * stamps the new fingerprint over it, so the next scan sees nothing to retry
 * and the loss is permanent. The two are the same event, so they get the same
 * treatment. A degraded document that still recovered something is a partial
 * read, not a failed one, and is worth more than the copy it replaces.
 */
function readNothing(doc: SessionDoc): boolean {
  return doc.degraded === true
    && doc.prompts.length === 0
    && doc.prose.length === 0
    && doc.files.length === 0
    && (doc.dialogue?.length ?? 0) === 0
}

/**
 * Hydrates and atomically persists changed refs. Callers must not pre-upsert changed refs:
 * a failed document write needs the previous fingerprint to remain visible to the next scan.
 */
export async function hydrateAll(
  db: IndexDb,
  cfg: Config,
  adapters: Adapter[],
  refs: SessionRef[],
  onProgress?: (progress: Progress) => void,
): Promise<Diagnostic[]> {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]))
  const queue = orderByPriority(refs)
  const total = queue.length
  if (total === 0) return []

  const diagnostics = Array.from({ length: total }, (): Diagnostic[] => [])
  const completed = Array.from({ length: total }, () => false)
  let done = 0
  let nextProgress = 0

  /**
   * Emits progress updates for completed hydration tasks in sequence.
   */
  function reportCompleted(): void {
    while (nextProgress < total && completed[nextProgress]) {
      const index = nextProgress++
      const ref = queue[index]!
      done++
      try {
        onProgress?.({ done, total, client: ref.client })
      } catch (error) {
        diagnostics[index]!.push({
          client: ref.client,
          level: 'warn',
          path: ref.sourcePaths[0] ?? null,
          message: `progress callback failed: ${errorMessage(error)}`,
        })
      }
    }
  }

  /**
   * Processes a slice of the session queue concurrently using workers.
   */
  async function runPhase(start: number, end: number): Promise<void> {
    let next = start

    /**
     * Continuously consumes and hydrates session references from the queue until exhausted.
     */
    async function worker(): Promise<void> {
      while (true) {
        const index = next++
        if (index >= end) return
        const ref = queue[index]!
        const adapter = byId.get(ref.client)
        if (!adapter) {
          diagnostics[index]!.push({
            client: ref.client,
            level: 'warn',
            path: null,
            message: 'no adapter for client',
          })
          completed[index] = true
          reportCompleted()
          continue
        }

        try {
          const safeRef: SessionRef = { ...ref, sourcePaths: [...ref.sourcePaths] }
          const doc = await adapter.hydrate(safeRef, cfg)
          if (readNothing(doc)) {
            // Reported under the same prefix a thrown reader gets, so the run's
            // exit code and the doctor's reading of it do not depend on which
            // way a reader chose to report the same unreadable source.
            diagnostics[index]!.push({
              client: ref.client,
              level: 'warn',
              path: ref.sourcePaths[0] ?? null,
              message: 'hydrate failed: nothing could be read, so the previous entry was kept',
            })
          } else {
            db.upsertHydrated(doc)
          }
        } catch (error) {
          diagnostics[index]!.push({
            client: ref.client,
            level: 'warn',
            path: ref.sourcePaths[0] ?? null,
            message: `hydrate failed: ${errorMessage(error)}`,
          })
        }
        completed[index] = true
        reportCompleted()
      }
    }

    const workerCount = Math.min(concurrency(), end - start)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  }

  const codebuffStart = queue.findIndex((ref) => ref.client === 'codebuff')
  const boundary = codebuffStart === -1 ? total : codebuffStart
  await runPhase(0, boundary)
  await runPhase(boundary, total)
  return diagnostics.flat()
}
