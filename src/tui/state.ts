import { parseTimeBound, validateTimeRange, type TimePreset, type TimeRange } from '../core/time-range'

/** Presets resolve at refresh; custom bounds stay fixed after Apply. */
export type PickerTime =
  | { kind: 'preset'; preset: TimePreset }
  | { kind: 'custom'; range: TimeRange; sinceText: string; untilText: string }

/**
 * Committed filters independent of search text and hidden-client policy.
 * An undefined branch disables that filter; null selects sessions with no branch.
 */
export interface PickerFilters {
  scope: string | null
  client: string | null
  time: PickerTime
  sort: 'auto' | 'recent' | 'relevance'
  branch?: string | null
  file?: { path: string; exact: boolean }
  bookmarkedOnly: boolean
}

/**
 * A reader position in stored UTF-16 coordinates, independent of wrapping.
 * Legacy or missing turns use the clamped rendered fallback line instead.
 */
export interface ReaderAnchor {
  uid: string
  ordinal: number | null
  offset: number
  fallbackLine: number
}

/** Transient refresh continuity; this state is never written to bookmark storage. */
export interface PickerRestore {
  text: string
  filters: PickerFilters
  selectedUid: string | null
  selectedIndex: number
  listTop: number
  /** Only the current refresh run retains this presentation preference. */
  statsVisible?: boolean
  reader: null | { anchor: ReaderAnchor; findText: string; hitIndex: number }
}

/** Resets user filters; callers retain search text and enforce visibility policy. */
export function clearedFilters(): PickerFilters {
  return { scope: null, client: null, time: { kind: 'preset', preset: 'all' }, sort: 'auto', bookmarkedOnly: false }
}

/** Restores exact identity first, then clamps the old index to a surviving row. */
export function restoreSelection(uids: readonly string[], uid: string | null, index: number): number {
  const found = uid === null ? -1 : uids.indexOf(uid)
  return found >= 0 ? found : Math.max(0, Math.min(uids.length - 1, Number.isFinite(index) ? Math.floor(index) : 0))
}

/** Resolves relative custom input once while retaining its original editable spelling. */
export function resolveCustomTime(sinceText: string, untilText: string, now: number): Extract<PickerTime, { kind: 'custom' }> {
  const range: TimeRange = {}
  if (sinceText.trim()) range.since = parseTimeBound(sinceText.trim(), now, '--since')
  if (untilText.trim()) range.until = parseTimeBound(untilText.trim(), now, '--until')
  validateTimeRange(range)
  return { kind: 'custom', range, sinceText, untilText }
}
