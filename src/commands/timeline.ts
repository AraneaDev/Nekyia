import { existsSync } from 'node:fs'
import { indexPath, loadConfig } from '../config'
import { IndexDb } from '../core/db'
import { trackedFiles } from '../core/git'
import { timeline } from '../core/timeline'
import { formatTimeline } from '../render'

/** Everything the timeline command accepts, mirroring its flags. */
export interface TimelineCommandOptions {
  dir: string
  since?: number
  client?: string
  limit?: number
  json?: boolean
}

const SPANS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/**
 * Reads `--since` in the vocabulary `relTime` already prints, plus a plain date.
 *
 * Anything else is refused rather than guessed at: a window a user thinks they
 * asked for and did not get is worse than an error, in a command someone runs
 * after losing work.
 */
export function parseSince(value: string, now: number = Date.now()): number {
  const span = /^(\d+)([mhdw])$/u.exec(value)
  if (span) return now - Number(span[1]) * SPANS[span[2]!]!
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const parsed = Date.parse(`${value}T00:00:00Z`)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new Error('--since takes a span such as 30m, 12h, 2d, 3w, or a date such as 2026-08-01')
}

/**
 * Prints a directory's file history, grouped by session.
 *
 * Read-only and index-only: it never opens a transcript and spawns nothing but
 * git (through `trackedFiles`). The index is opened without migrating it, the
 * same way `forget` and `prune` do, so a user who has not reindexed since the
 * file-event schema landed still gets an answer instead of a crash.
 */
export async function runTimeline(opts: TimelineCommandOptions): Promise<number> {
  loadConfig()
  const path = indexPath()
  if (!existsSync(path)) {
    // The same shape as an answered run, so a caller can reach `.sessions`
    // without first learning whether an index exists.
    if (opts.json) {
      console.log(JSON.stringify({
        dir: opts.dir,
        since: opts.since ?? null,
        git: { consulted: false },
        sessions: [],
      }, null, 2))
    } else {
      console.error('index not found; run "nekyia index" first')
    }
    return 0
  }
  const db = IndexDb.openReadonly(path)
  try {
    const sessions = timeline(db, {
      dir: opts.dir,
      since: opts.since,
      client: opts.client,
      limit: opts.limit ?? 40,
    })
    const git = await trackedFiles(opts.dir)
    if (opts.json) {
      console.log(JSON.stringify({
        dir: opts.dir,
        since: opts.since ?? null,
        git: { consulted: git.consulted },
        sessions: sessions.map((session) => ({
          uid: session.ref.uid,
          client: session.ref.client,
          cwd: session.ref.cwd,
          title: session.ref.title,
          endedAt: session.ref.endedAt,
          tier: session.ref.tier,
          // Whether the transcript these events came from is still on disk.
          // When it is not, `sourcePaths` names a file the caller cannot open,
          // and saying so is the point in a command about lost work.
          missing: session.ref.missing,
          // Provenance, so a caller can open the transcript itself rather than
          // trust the indexed summary. The index says where; the transcript
          // says what.
          sourcePaths: db.getRef(session.ref.uid)?.sourcePaths ?? [],
          fileDetail: session.detail,
          eventsTruncated: session.eventsTruncated,
          events: session.entries.map((entry) => ({
            ordinal: entry.ordinal,
            turn: entry.turn,
            kind: entry.kind,
            path: entry.path,
            resolved: entry.resolved,
            tracked: git.consulted ? git.tracked.has(entry.resolved) : null,
          })),
        })),
      }, null, 2))
    } else if (sessions.length === 0) {
      console.error('no sessions touched this directory')
    } else {
      for (const line of formatTimeline(sessions, { dir: opts.dir, git })) console.log(line)
    }
    return 0
  } finally {
    db.close()
  }
}
