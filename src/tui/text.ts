/**
 * Bounding and measuring untrusted text for a terminal.
 *
 * Every display field in this codebase comes from an indexed transcript, so it
 * reaches a terminal only through the helpers here. They are deliberately free
 * of React and Ink: the non-interactive commands print through `render.ts` and
 * must not pay Ink's module-load cost to sanitize a title. `Bun.stringWidth`
 * and `Intl.Segmenter` are runtime built-ins, so this module imports nothing.
 */

const DISPLAY_SCAN_FACTOR = 8
/** Ceiling on every width-derived allocation, so a nonsense terminal width cannot ask for an unbounded string. */
export const MAX_DISPLAY_COLUMNS = 512
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu
const BIDI_FORMAT = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/gu
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Records how much text bounding inspected, so the caps stay observable in tests. */
export interface DisplayWork {
  sampledCodeUnits: number
  graphemes: number
}

/**
 * Clamps the requested column width between 0 and MAX_DISPLAY_COLUMNS.
 */
function displayColumns(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(MAX_DISPLAY_COLUMNS, Math.max(0, Math.floor(value)))
}

/** Code units worth reading for a given column budget, generous enough that narrow graphemes still fill the width. */
export function scanLimit(columns: number): number {
  return columns * DISPLAY_SCAN_FACTOR + DISPLAY_SCAN_FACTOR
}

/**
 * Takes the first `limit` code units without cutting a surrogate pair open, returning the valid text sample.
 */
function prefixByCodeUnits(value: string, limit: number): { sample: string; truncated: boolean } {
  const truncated = value.length > limit
  let sample = value.slice(0, limit)
  const last = sample.charCodeAt(sample.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) sample = sample.slice(0, -1)
  return { sample, truncated }
}

/** Takes the last `limit` code units without cutting a surrogate pair open, so the sample is always valid text. */
export function suffixByCodeUnits(value: string, limit: number): { sample: string; truncated: boolean } {
  const truncated = value.length > limit
  let sample = value.slice(-limit)
  const first = sample.charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) sample = sample.slice(1)
  return { sample, truncated }
}

/**
 * Removes control and BIDI formatting characters to prevent terminal layout corruption.
 */
function sanitizeDisplaySample(value: string): string {
  return value.replace(CONTROL, ' ').replace(BIDI_FORMAT, '')
}

/**
 * Returns a safe prefix no wider than `maxColumns`. The input slice is bounded
 * before regex, grapheme segmentation, or terminal-width measurement, keeping
 * display work proportional to the requested terminal width.
 */
export function boundedDisplayText(
  value: string,
  maxColumns: number,
  work?: DisplayWork,
): string {
  const columns = displayColumns(maxColumns)
  if (columns === 0) return ''

  const { sample, truncated } = prefixByCodeUnits(value, scanLimit(columns))
  if (work) work.sampledCodeUnits += sample.length
  const safe = sanitizeDisplaySample(sample)
  let result = ''
  let width = 0

  for (const part of GRAPHEMES.segment(safe)) {
    if (work) work.graphemes++
    const isPossiblySplitTail = truncated && part.index + part.segment.length === safe.length
    if (isPossiblySplitTail) break
    const partWidth = Bun.stringWidth(part.segment)
    if (width + partWidth > columns) break
    result += part.segment
    width += partWidth
    if (width === columns) break
  }
  return result
}

/**
 * Sanitizes a line and folds it onto as many terminal rows as it needs, keeping
 * every character instead of cutting the tail off at the right edge.
 *
 * `boundedDisplayText` is right for a list row or a browsing preview: they show
 * one row per value and the reader has no way to reach past it, so scanning
 * further than the width would be work spent on text that is dropped. The
 * opened history is the opposite. It is the one view whose whole purpose is
 * reading a reply in full, and its scroll model can reach every row produced
 * here, so a 400-character answer must continue rather than disappear.
 *
 * Nothing bounds the input, so a caller must bring its own budget: this reads
 * the entire string and returns a row for roughly every `maxColumns` of it.
 */
export function wrappedDisplayLines(value: string, maxColumns: number): string[] {
  const columns = displayColumns(maxColumns)
  if (columns === 0 || value.length === 0) return []
  const safe = sanitizeDisplaySample(value)
  const lines: string[] = []
  let pieces: string[] = []
  let width = 0

  for (const part of GRAPHEMES.segment(safe)) {
    const partWidth = Bun.stringWidth(part.segment)
    // A grapheme wider than the whole width still has to go somewhere, so it
    // takes a row of its own rather than looping forever on an empty line.
    if (pieces.length > 0 && width + partWidth > columns) {
      lines.push(pieces.join(''))
      pieces = []
      width = 0
    }
    pieces.push(part.segment)
    width += partWidth
  }
  if (pieces.length > 0) lines.push(pieces.join(''))
  return lines
}

/** Pads to a terminal width; `padEnd` counts code units, which a wide character breaks. */
export function padColumns(value: string, columns: number): string {
  return value + ' '.repeat(Math.max(0, columns - Bun.stringWidth(value)))
}

/**
 * Keeps the end of a path when it will not fit. Trimming the far end drops the
 * file name, which is the part worth reading; the directories above it are not.
 */
export function boundedPathTail(value: string, columns: number): string {
  const limit = displayColumns(columns)
  if (limit === 0) return ''
  if (Bun.stringWidth(value) <= limit) return value
  const { sample } = suffixByCodeUnits(value, scanLimit(limit))
  let kept = ''
  for (const part of [...GRAPHEMES.segment(sample)].reverse()) {
    const next = part.segment + kept
    if (Bun.stringWidth(next) > limit - 1) break
    kept = next
  }
  return `…${kept}`
}
