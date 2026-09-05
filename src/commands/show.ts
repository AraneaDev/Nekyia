import { existsSync } from 'node:fs'
import { indexPath } from '../config'
import { buildBrief } from '../core/brief'
import { IndexDb } from '../core/db'
import { parseUid } from '../types'

/** Names the session to render a handover for. */
export interface ShowOptions {
  uid?: string
  maxChars?: number
}

/**
 * Prints the deterministic handover for one session as Markdown.
 *
 * No model is involved: the same session always renders the same text.
 */
export async function runShow(opts: ShowOptions): Promise<number> {
  if (!opts.uid) {
    console.error('usage: nekyia show <uid>')
    return 2
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(opts.uid)) {
    console.error('error: uid must not contain control characters')
    return 2
  }
  try {
    parseUid(opts.uid)
  } catch {
    console.error(`error: malformed uid: ${opts.uid}`)
    return 2
  }
  if (opts.maxChars !== undefined
    && (!Number.isSafeInteger(opts.maxChars) || opts.maxChars < 0)) {
    console.error('error: --max-chars must be a non-negative integer')
    return 2
  }

  const path = indexPath()
  if (!existsSync(path)) {
    console.error('index not found; run "nekyia index" first')
    return 1
  }

  // Printing a handover is a read. A readonly handle cannot migrate, so it
  // never upgrades the schema on the way, and like search it will not create
  // an index that a deletion race has removed.
  const db = IndexDb.openReadonly(path)
  try {
    const brief = buildBrief(db, opts.uid, { maxChars: opts.maxChars })
    if (!brief) {
      console.error(`no session with uid ${opts.uid}`)
      return 1
    }
    console.log(brief)
    return 0
  } finally {
    db.close()
  }
}
