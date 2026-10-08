import type { RetainedTurn } from '../core/session-detail'
import type { ReaderAnchor } from './state'

/** One literal match identified in stored turn coordinates. */
export interface HistoryHit { ordinal: number; start: number; end: number }
/** A sanitized rendered line with an explicit mapping to original source offsets. */
export interface HistoryLine { text: string; ordinal: number | null; offset: number; endOffset: number; legacyOrdinal?: number }

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
    lines.push({ text: turn.role === 'user' ? 'Prompt' : 'Reply', ordinal: turn.ordinal, offset: 0, endOffset: 0 })
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
    let text = ''
    let cells = 0
    let start = offsets[0] ?? 0
    let end = start
    /** Finish a wrapped row without discarding its source coordinates. */
    const push = () => {
      lines.push({ text, ordinal: turn.ordinal, offset: start, endOffset: end })
      text = ''; cells = 0
    }
    for (const part of graphemes.segment(safe)) {
      const raw = offsets[part.index] ?? turn.text.length
      if (part.segment === '\n') {
        end = raw; push(); start = raw + 1; end = start
        continue
      }
      const size = Bun.stringWidth(part.segment)
      if (text && cells + size > width) { push(); start = raw }
      if (!text) start = raw
      // A terminal narrower than one grapheme omits that grapheme rather than overflowing.
      if (size <= width) text += part.segment
      cells += size
      end = (offsets[part.index + part.segment.length - 1] ?? raw) + 1
    }
    if (text || safe.endsWith('\n')) push()
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
