import { clearedFilters, type PickerFilters } from './state'

/** A deliberate query/filter change, offered only when it produces results. */
export interface EmptySuggestion {
  label: string
  text: string
  filters: PickerFilters
}

/**
 * Computes suggestions without changing committed state. The count callback
 * must use the same hidden-client policy as the actual query; widening user
 * filters must never widen that policy. Equivalent candidates are checked once.
 */
export function emptySuggestions(
  state: { text: string; filters: PickerFilters },
  count: (text: string, filters: PickerFilters) => number,
): EmptySuggestion[] {
  const { text, filters } = state
  const candidates: EmptySuggestion[] = []
  /** Adds a filter-only candidate while retaining the user's search text. */
  const add = (label: string, next: PickerFilters) => candidates.push({ label, text, filters: next })
  if (text) candidates.push({ label: 'Clear search', text: '', filters })
  if (filters.scope !== null) add('Show all projects', { ...filters, scope: null })
  if (filters.time.kind === 'custom' || filters.time.preset !== 'all') {
    add('Clear time', { ...filters, time: { kind: 'preset', preset: 'all' } })
  }
  if (filters.client !== null) add('Show all clients', { ...filters, client: null })
  if (filters.branch !== undefined) add('Clear branch', { ...filters, branch: undefined })
  if (filters.file) add('Clear file', { ...filters, file: undefined })
  if (filters.bookmarkedOnly) add('Show unbookmarked sessions', { ...filters, bookmarkedOnly: false })
  add('Clear all filters', clearedFilters())
  const seen = new Set<string>([JSON.stringify(state)])
  return candidates.filter(item => {
    const key = JSON.stringify({ text: item.text, filters: item.filters })
    if (seen.has(key)) return false
    seen.add(key)
    return count(item.text, item.filters) > 0
  })
}
