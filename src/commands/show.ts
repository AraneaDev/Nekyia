import { existsSync } from 'node:fs'
import { indexPath } from '../config'
import { buildBrief } from '../core/brief'
import { buildContext } from '../core/context'
import { IndexDb } from '../core/db'
import { parseUid } from '../types'
import { emitAgentError } from '../agent-contract'

/** Names the session to render a handover for. */
export interface ShowOptions {
  uid?: string
  maxChars?: number
  json?: boolean
}

/**
 * Prints the deterministic handover for one session as Markdown.
 *
 * No model is involved: the same session always renders the same text.
 */
export async function runShow(opts: ShowOptions): Promise<number> {
  if (!opts.uid) {
    if (opts.json) emitAgentError('missing-uid', 'usage: nekyia show <uid>')
    else console.error('usage: nekyia show <uid>')
    return 2
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(opts.uid)) {
    if (opts.json) emitAgentError('invalid-uid', 'uid must not contain control characters')
    else console.error('error: uid must not contain control characters')
    return 2
  }
  try {
    parseUid(opts.uid)
  } catch {
    if (opts.json) emitAgentError('invalid-uid', 'malformed uid')
    else console.error(`error: malformed uid: ${opts.uid}`)
    return 2
  }
  if (opts.maxChars !== undefined
    && (!Number.isSafeInteger(opts.maxChars) || opts.maxChars < 0)) {
    if (opts.json) emitAgentError('invalid-budget', '--max-chars must be a non-negative integer')
    else console.error('error: --max-chars must be a non-negative integer')
    return 2
  }

  const path = indexPath()
  if (!existsSync(path)) {
    if (opts.json) emitAgentError('index-not-found', 'index not found; run "nekyia index" first')
    else console.error('index not found; run "nekyia index" first')
    return 1
  }

  // Printing a handover is a read. A readonly handle cannot migrate, so it
  // never upgrades the schema on the way, and like search it will not create
  // an index that a deletion race has removed.
  const db = IndexDb.openReadonly(path)
  try {
    if (opts.json) {
      const context = buildContext(db, opts.uid, { maxChars: opts.maxChars })
      if (!context) {
        emitAgentError('session-not-found', `no session with uid ${opts.uid}`)
        return 1
      }
      console.log(JSON.stringify(context, null, 2))
      return 0
    }
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
