import type { RetainedTurn } from '../core/session-detail'
import type { ReaderAnchor } from './state'

/** One literal match identified in stored turn coordinates. */
export interface HistoryHit { ordinal: number; start: number; end: number }
/**
 * A sanitized rendered line with an explicit mapping to original source offsets.
 *
 * Headings and the spacer above them belong to their turn but sit before its
 * text, at offsets -1 and -2. A heading at offset 0 shared its position with
 * the turn's first row, so scrolling onto it resolved straight back to that
 * row and the reader could never move up past a turn.
 */
export interface HistoryLine {
  text: string
  ordinal: number | null
  offset: number
  endOffset: number
  legacyOrdinal?: number
  role?: 'user' | 'assistant'
  kind?: 'heading' | 'spacer'
}

/** The offset a turn's heading occupies, before any of its text. */
export const HEADING_OFFSET = -1
const SPACER_OFFSET = -2

/** Literal Unicode matching retains the database text's UTF-16 offsets. */
export function findHistory(turns: readonly RetainedTurn[], text: string): HistoryHit[] {
  if (!text) return []
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const expression = new RegExp(escaped, 'giu')
  return turns.flatMap(turn => [...turn.text.matchAll(expression)].map(match => ({
    ordinal: turn.ordinal, start: match.index, end: match.index + match[0].length,
  })))
}

/** Move through hits with wraparound; an empty result has no selected hit. */
export function nextHit(index: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1
  if (index < 0) return direction === 1 ? 0 : count - 1
  return (index + direction + count) % count
}

const bidi = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/u
const control = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Reflow sanitized text while explicitly carrying offsets into the original turn. */
export function buildHistoryLines(turns: readonly RetainedTurn[], columns: number): HistoryLine[] {
  const width = Math.max(1, Math.min(512, Math.floor(columns) || 1))
  const lines: HistoryLine[] = []
  for (const turn of turns) {
    const role = turn.role === 'user' ? 'user' : 'assistant'
    if (lines.length) lines.push({ text: '', ordinal: turn.ordinal, offset: SPACER_OFFSET, endOffset: SPACER_OFFSET, role, kind: 'spacer' })
    lines.push({ text: role === 'user' ? 'Prompt' : 'Reply', ordinal: turn.ordinal, offset: HEADING_OFFSET, endOffset: HEADING_OFFSET, role, kind: 'heading' })
    let safe = ''
    const offsets: number[] = []
    for (let index = 0; index < turn.text.length;) {
      const char = String.fromCodePoint(turn.text.codePointAt(index)!)
      if (!bidi.test(char)) {
        const replacement = char === '\n' ? '\n' : control.test(char) ? ' ' : char
        safe += replacement
        for (let unit = 0; unit < replacement.length; unit++) offsets.push(index + unit)
      }
      index += char.length
    }
    // The row being built, one grapheme at a time with its source span, so a
    // break can fall back to the last space without losing coordinates.
    let row: { text: string; size: number; start: number; end: number }[] = []
    let cells = 0
    let lineStart = offsets[0] ?? 0
    /** Finish a wrapped row without discarding its source coordinates. */
    const push = (parts: typeof row, fallback: number) => {
      lines.push({
        text: parts.map(part => part.text).join(''), ordinal: turn.ordinal, role,
        offset: parts[0]?.start ?? fallback, endOffset: parts.at(-1)?.end ?? fallback,
      })
    }
    for (const part of graphemes.segment(safe)) {
      const raw = offsets[part.index] ?? turn.text.length
      if (part.segment === '\n') {
        push(row, lineStart); row = []; cells = 0; lineStart = raw + 1
        continue
      }
      const size = Bun.stringWidth(part.segment)
      const end = (offsets[part.index + part.segment.length - 1] ?? raw) + 1
      if (row.length && cells + size > width) {
        if (part.segment === ' ') { push(row, raw); row = []; cells = 0; lineStart = end; continue }
        const space = row.findLastIndex(item => item.text === ' ')
        push(space > 0 ? row.slice(0, space) : row, raw)
        row = space > 0 ? row.slice(space + 1) : []
        cells = row.reduce((sum, item) => sum + item.size, 0)
      }
      if (!row.length) lineStart = raw
      // A terminal narrower than one grapheme omits that grapheme rather than overflowing.
      if (size <= width) { row.push({ text: part.segment, size, start: raw, end }); cells += size }
    }
    if (row.length || safe.endsWith('\n')) push(row, lineStart)
  }
  return lines
}

/** Locate a semantic anchor after reflow, falling back only for missing/legacy turns. */
export function anchorLine(lines: readonly HistoryLine[], anchor: ReaderAnchor): number {
  if (anchor.ordinal !== null) {
    const candidates = lines.map((line, index) => ({ line, index })).filter(item => item.line.ordinal === anchor.ordinal)
    const containing = candidates.find(item => item.line.endOffset > item.line.offset
      && anchor.offset >= item.line.offset && anchor.offset < item.line.endOffset)
    if (containing) return containing.index
    const preceding = candidates.filter(item => item.line.offset <= anchor.offset).at(-1)
    if (preceding) return preceding.index
    if (candidates.length) return candidates[0]!.index
  }
  return Math.max(0, Math.min(lines.length - 1, anchor.fallbackLine))
}
