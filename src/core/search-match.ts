import { randomUUID } from 'node:crypto'
import type { IndexDb } from './db'
import type { RetainedTurn } from './session-detail'

/** Character offsets into sanitized evidence. */
export interface TextSpan { start: number; end: number }
/** Native FTS evidence plus a location verified against retained turns. */
export interface MatchEvidence {
  uid: string
  field: 'title' | 'prompt' | 'reply'
  text: string
  spans: TextSpan[]
  anchor: null | { ordinal: number; offset: number }
}

/** Only an exact unique occurrence across the retained window verifies a location. */
export function uniqueTurnAnchor(segment: string, turns: readonly RetainedTurn[]): MatchEvidence['anchor'] {
  if (!segment) return null
  let anchor: MatchEvidence['anchor'] = null
  for (const turn of turns) {
    const offset = turn.text.indexOf(segment)
    if (offset < 0) continue
    if (anchor || turn.text.indexOf(segment, offset + 1) >= 0) return null
    anchor = { ordinal: turn.ordinal, offset }
  }
  return anchor
}

/** Remove terminal controls, retaining a position map for native highlighted spans. */
function sanitize(text: string, spans: TextSpan[]): { text: string; spans: TextSpan[] } {
  const offsets: number[] = [0]
  let safe = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    safe += /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/u.test(char)
      ? '' : /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(char) ? ' ' : char
    offsets.push(safe.length)
  }
  return { text: safe, spans: spans.map(span => ({ start: offsets[span.start]!, end: offsets[span.end]! })).filter(span => span.end > span.start) }
}

/** Native FTS evidence is read exclusively for this UID, never inferred from a literal input match. */
export function readMatchEvidence(db: IndexDb, uid: string, expression: string, turns: readonly RetainedTurn[]): MatchEvidence | null {
  const nonce = randomUUID()
  const start = `\u0001${nonce}:s\u0002`
  const end = `\u0001${nonce}:e\u0002`
  const ellipsis = `\u0001${nonce}:x\u0002`
  const snippets = db.matchSnippets(uid, expression, start, end, ellipsis)
  if (!snippets) return null
  const index = snippets.findIndex(snippet => snippet.includes(start))
  if (index < 0) return null
  const source = snippets[index]!
  const clipped = source.length > 8192
  const bounded = source.slice(0, 8192)
  const spans: TextSpan[] = []
  let plain = ''
  let opening: number | null = null
  let malformed = false
  for (let i = 0; i < bounded.length;) {
    if (bounded.startsWith(start, i)) {
      if (opening !== null) malformed = true
      opening = plain.length
      i += start.length
    } else if (bounded.startsWith(end, i)) {
      if (opening === null) malformed = true
      else spans.push({ start: opening, end: plain.length })
      opening = null
      i += end.length
    } else if (bounded.startsWith(ellipsis, i)) {
      plain += ellipsis
      i += ellipsis.length
    } else { plain += bounded[i]!; i++ }
  }
  if (opening !== null) malformed = true
  // A clipped marker can contain its nonce in fragments: remove those fragments
  // as well, and fall back to bounded unhighlighted evidence.
  if (clipped) malformed = true
  const segments = plain.split(ellipsis).filter(Boolean)
  let anchor: MatchEvidence['anchor'] = null
  if (!malformed && index !== 0) {
    for (const segment of segments) {
      const verified = uniqueTurnAnchor(segment, turns)
      if (verified) { anchor = verified; break }
    }
  }
  plain = plain.split(ellipsis).join('…')
  // Translate offsets past internal ellipsis markers to their display glyph.
  const visibleSpans = spans.map(span => {
    /** Map a native plain offset through display ellipsis replacement. */
    const map = (offset: number) => plainOffset(bounded, offset, start, end, ellipsis)
    return { start: map(span.start), end: map(span.end) }
  })
  if (malformed) {
    plain = plain.replace(new RegExp(nonce.replace(/-/g, '\\-') + ':[sex]?', 'g'), '')
    plain = plain.replace(/\u0001[^\u0002]*$/u, '')
  }
  const safe = sanitize(plain, malformed ? [] : visibleSpans)
  return { uid, field: (['title', 'prompt', 'reply'] as const)[index]!, ...safe, anchor }
}

/** Convert a marker-free offset to display text after replacing internal ellipses. */
function plainOffset(source: string, offset: number, start: string, end: string, ellipsis: string): number {
  const clean = source.split(start).join('').split(end).join('')
  const prefix = clean.slice(0, offset)
  return prefix.split(ellipsis).join('…').length
}
