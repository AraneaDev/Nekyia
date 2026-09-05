import { existsSync } from 'node:fs'
import { indexPath, loadConfigChecked } from '../config'
import { IndexDb } from '../core/db'
import { query } from '../core/query'
import { formatRow } from '../render'

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
}

/**
 * One result row as `--json` publishes it, provenance included.
 *
 * `sourcePaths` is where the session was read from, so an agent that wants more
 * than the indexed summary can open the transcript itself. It stays an array:
 * a session can span several files, and for the directory-backed clients it is
 * not a single transcript at all.
 */
function publicRow(row: ReturnType<typeof query>[number], sourcePaths: string[]) {
  return {
    uid: row.uid,
    client: row.client,
    nativeId: row.nativeId,
    cwd: row.cwd,
    gitBranch: row.gitBranch,
    title: row.title,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    turns: row.turns,
    parentNativeId: row.parentNativeId,
    tier: row.tier,
    origin: row.origin,
    score: row.score,
    collapsed: row.collapsed,
    sourcePaths,
  }
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
    })
    if (opts.json) {
      // The search itself reads the narrow row shape, which leaves provenance
      // unread. Only the rows that are actually printed are read back in full,
      // which a one-shot call bounded by `--limit` can afford and the picker,
      // scanning every row per keystroke, could not.
      console.log(JSON.stringify(
        rows.map((row) => publicRow(row, db.getRef(row.uid)?.sourcePaths ?? [])),
        null,
        2,
      ))
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
