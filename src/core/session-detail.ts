import type { IndexDb } from './db'

/**
 * Retained database text with its actual ordinal. Reader and match anchors use
 * UTF-16 offsets into this text; sanitization must carry an offset map rather
 * than changing the stored-coordinate contract.
 */
export interface RetainedTurn {
  ordinal: number
  role: string
  text: string
}
/** Underlying detail limitations; multiple reasons may apply simultaneously. */
export type QualityReason =
  | 'source-missing' | 'truncated' | 'degraded' | 'legacy-text'
  | 'file-order' | 'reader-cap' | 'details-unavailable'
/** Selected-session content and completeness facts, without launcher state. */
export interface SessionDetail {
  uid: string
  turns: RetainedTurn[]
  latestUser: string | null
  latestReply: string | null
  ordered: boolean
  fileCount: number | null
  fileCountCapped: boolean
  reasons: QualityReason[]
}

const DETAIL_CACHE_LIMIT = 32
const cache = new WeakMap<IndexDb, Map<string, SessionDetail>>()

/** Trim any partial UTF-8 boundary without exceeding the database's byte budget. */
function byteBound(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, maxBytes)).replace(/\ufffd$/u, '')
}

/** Summaries preserve line breaks while removing terminal controls and bidi formatting. */
function summary(text: string | null | undefined): string | null {
  if (!text) return null
  return byteBound(text, 65_536)
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ')
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/gu, '')
}

/**
 * Reads bounded retained history and separate latest-role summaries for one UID.
 * Results are shared through a 32-entry LRU per database connection and must be
 * treated as read-only. Refresh reopens the index to invalidate cached details;
 * legacy grouped facets explicitly report unavailable conversation ordering.
 */
export function readSessionDetail(db: IndexDb, uid: string): SessionDetail {
  let entries = cache.get(db)
  if (!entries) { entries = new Map(); cache.set(db, entries) }
  const cached = entries.get(uid)
  if (cached) {
    entries.delete(uid)
    entries.set(uid, cached)
    return cached
  }
  const detail: SessionDetail = { uid, turns: [], latestUser: null, latestReply: null, ordered: false, fileCount: null, fileCountCapped: false, reasons: [] }
  try {
    const ref = db.getRef(uid)
    if (!ref) { detail.reasons.push('details-unavailable'); return detail }
    if (ref.missing) detail.reasons.push('source-missing')
    if (ref.truncated) detail.reasons.push('truncated')
    if (ref.degraded) detail.reasons.push('degraded')
    const history = db.retainedTurns(uid)
    let left = 1_048_576
    detail.turns = history.turns.map(turn => {
      const text = byteBound(turn.text, left)
      left -= Buffer.byteLength(text)
      return { ...turn, text }
    })
    detail.ordered = detail.turns.length > 0
    if (detail.ordered) {
      const user = db.latestTurn(uid, 'user')
      const reply = db.latestTurn(uid, 'assistant')
      detail.latestUser = summary(user?.text)
      detail.latestReply = summary(reply?.text)
      if (history.capped || user?.capped || reply?.capped) detail.reasons.push('reader-cap')
    } else {
      const facets = db.groupedText(uid)
      detail.latestUser = summary(facets?.prompts)
      detail.latestReply = summary(facets?.prose)
      detail.reasons.push('legacy-text')
    }
    const files = db.fileDetailsFor([uid]).get(uid)
    if (files?.detail === 'ordered' || files?.detail === 'paths') {
      const count = db.boundedFileCount(uid)
      detail.fileCount = count.count
      detail.fileCountCapped = count.capped || ref.truncated || ref.degraded || files.eventsTruncated
    }
    if (files?.detail !== 'ordered' || files?.eventsTruncated) detail.reasons.push('file-order')
  } catch { detail.reasons.push('details-unavailable') }
  entries.set(uid, detail)
  if (entries.size > DETAIL_CACHE_LIMIT) entries.delete(entries.keys().next().value!)
  return detail
}

/** One quality badge, with missing source ahead of incomplete history and unavailable details. */
export function qualityBadge(reasons: readonly QualityReason[]): string | null {
  if (reasons.includes('source-missing')) return 'Source missing'
  if (reasons.some(reason => ['truncated', 'degraded', 'reader-cap'].includes(reason))) return 'History incomplete'
  return reasons.length ? 'Details unavailable' : null
}
