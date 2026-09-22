import { existsSync } from 'node:fs'
import { indexPath, loadConfigChecked } from '../config'
import { IndexDb } from '../core/db'
import { defaultOnPath, presentations } from '../core/launcher'
import { query } from '../core/query'
import { loadManifests } from '../manifests/load'
import { formatRow } from '../render'
import { serializeSearchRow } from '../agent-contract'

/** Everything the search command accepts, mirroring its flags. */
export interface SearchOptions {
  text?: string
  cwd?: string
  client?: string
  file?: string
  /** Internal exact resolved-path filter used by the blame shorthand. */
  exactFile?: string
  sort?: 'auto' | 'recent' | 'relevance'
  limit?: number
  json?: boolean
  /** Print only the session ids, so a result found by eye can be passed to `show` or `forget`. */
  ids?: boolean
}

/**
 * One result row as `--json` publishes it, provenance included.
 *
 * `sourcePaths` is where the session was read from, so an agent that wants more
 * than the indexed summary can open the transcript itself. It stays an array:
 * a session can span several files, and for the directory-backed clients it is
 * not a single transcript at all.
 *
 * Exported for its own unit test: `client` stays the manifest id that wrote
 * the session, even for a shared store whose `tier` follows whichever launcher
 * was resolved, because rewriting `client` to the launcher's name would lose
 * which store the row actually came from. `launcher` carries that name instead.
 */
export function publicRow(
  row: ReturnType<typeof query>[number],
  sourcePaths: string[],
  quality: Partial<{
    truncated: boolean
    degraded: boolean
    fileDetail: 'unknown' | 'paths' | 'ordered'
    eventsTruncated: boolean
  }> = {},
) {
  return serializeSearchRow({ ...row, ...quality }, sourcePaths)
}

/** Searches from the terminal, printing a table or machine-readable JSON. */
export async function runSearch(opts: SearchOptions = {}): Promise<number> {
  // A search is never stopped by a config it cannot read, but it does say so:
  // the results below are drawn without whatever visibility rule was lost, and
  // nothing else on screen would admit that. Stderr, so `--json` stays clean.
  const { config: cfg, problem } = loadConfigChecked()
  if (problem !== null) console.error(`warning: ${problem}`)
  const path = indexPath()
  if (!existsSync(path)) {
    if (opts.json) console.log('[]')
    else console.error('index not found; run "nekyia index" first')
    return 0
  }
  // Reading never writes: a readonly handle cannot migrate, so searching an
  // index that has not been reindexed since an upgrade answers from it as it
  // is rather than quietly moving it up the ladder. It also still refuses to
  // create one, so a deleted index cannot be replaced by an empty stand-in
  // that suppresses the first-run consent flow.
  const db = IndexDb.openReadonly(path)
  try {
    const rows = query(db, cfg, {
      text: opts.text,
      cwd: opts.cwd,
      client: opts.client,
      file: opts.file,
      exactFile: opts.exactFile,
      sort: opts.sort,
      limit: opts.limit ?? 40,
      presentation: presentations(loadManifests().manifests, cfg, defaultOnPath()),
    })
    if (opts.json) {
      // The search itself reads the narrow row shape, which leaves provenance
      // unread. Only the rows that are actually printed are read back in full,
      // which a one-shot call bounded by `--limit` can afford and the picker,
      // scanning every row per keystroke, could not.
      console.log(JSON.stringify(
        rows.map((row) => {
          const ref = db.getRef(row.uid)
          const detail = db.fileDetailsFor([row.uid]).get(row.uid)
          return publicRow(row, ref?.sourcePaths ?? [], {
            ...(ref ?? {}),
            ...(detail ? {
              fileDetail: detail.detail as 'unknown' | 'paths' | 'ordered',
              eventsTruncated: detail.eventsTruncated,
            } : {}),
          })
        }),
        null,
        2,
      ))
    } else if (opts.ids) {
      // Nothing but the identifiers, so the output is usable as it stands:
      // `nekyia search x --ids | head -1 | xargs nekyia show`. A run that
      // matched nothing prints nothing and still succeeds, which is what a
      // pipeline wants from an empty result.
      for (const row of rows) console.log(row.uid)
    } else if (rows.length === 0) {
      console.error('no sessions matched')
    } else {
      const now = Date.now()
      for (const row of rows) console.log(formatRow(row, now))
    }
    return 0
  } finally {
    db.close()
  }
}
