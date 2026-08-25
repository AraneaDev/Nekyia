import { existsSync } from 'node:fs'
import { indexPath, loadConfig } from '../config'
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

function publicRow(row: ReturnType<typeof query>[number]) {
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
  }
}

/** Searches from the terminal, printing a table or machine-readable JSON. */
export async function runSearch(opts: SearchOptions = {}): Promise<number> {
  const cfg = loadConfig()
  const path = indexPath()
  if (!existsSync(path)) {
    if (opts.json) console.log('[]')
    else console.error('index not found; run "nekyia index" first')
    return 0
  }
  // Keep search read-existing: a deletion race after existsSync must not silently
  // recreate an empty index and suppress the later first-run consent flow.
  const db = IndexDb.open(path, false)
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
      console.log(JSON.stringify(rows.map(publicRow), null, 2))
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
