/** Space assigned to the virtual list and selected preview, excluding chrome. */
export interface PaneLayout {
  mode: 'stack' | 'compact'
  listWidth: number
  previewWidth: number
  bodyRows: number
  statsWidth: number
}

/**
 * Reserves a small fixed stats panel only when at least 112 list columns remain.
 * Preview width is always the entire terminal; short terminals retain a compact
 * one-line preview. Hiding stats immediately returns their width to the list.
 */
export function paneLayout(columns: number, rows: number, chromeRows: number, showStats = true): PaneLayout {
  const bodyRows = Math.max(1, rows - chromeRows)
  const statsWidth = showStats && columns >= 140 && rows >= 18 ? 26 : 0
  return { mode: rows < 12 ? 'compact' : 'stack', listWidth: columns - (statsWidth ? statsWidth + 2 : 0), previewWidth: columns, bodyRows, statsWidth }
}
