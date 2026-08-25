import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import type { Config } from '../config'
import type { IndexDb } from '../core/db'
import { query, type Row } from '../core/query'

/**
 * The directory the list is narrowed to, or null for the whole index. A path
 * rather than a flag, so the picker can narrow to whatever project the cursor
 * is on instead of only to the directory it was launched from.
 */
export type Scope = string | null

/**
 * Rows the picker will show at once. One more than this is asked for, so an
 * index that runs past the limit can be reported as such instead of being
 * silently counted as exactly this many.
 */
export const SESSION_DISPLAY_LIMIT = 500

/** The picker's search state and the actions that change it, kept out of the component so it can be tested directly. */
export interface SessionsState {
  rows: Row[]
  /** True when the search matched more sessions than `rows` can show. */
  overflowed: boolean
  text: string
  setText: (text: string) => void
  scope: Scope
  setScope: (scope: Scope) => void
  /** Narrows to the selected session's project, or widens back to everything. */
  toggleScope: () => void
  client: string | undefined
  setClient: (client: string | undefined) => void
  selected: number
  setSelected: (selected: SetStateAction<number>) => void
  move: (delta: number) => void
}

function clampSelection(selected: number, length: number): number {
  if (length <= 0) return 0
  const safe = Number.isFinite(selected) ? Math.floor(selected) : 0
  return Math.max(0, Math.min(length - 1, safe))
}

/** Query state shared by the picker and its keyboard bindings. */
export function useSessions(db: IndexDb, cfg: Config, cwd: string): SessionsState {
  const [text, setTextState] = useState('')
  const [scope, setScopeState] = useState<Scope>(cwd || null)
  const [client, setClientState] = useState<string | undefined>()
  const [selectedState, setSelectedState] = useState(0)

  // Config is commonly rebuilt by a parent render. Depend only on the values
  // which query() consumes, so equivalent identities do not hit SQLite again.
  const hiddenClientsKey = JSON.stringify(
    Array.isArray(cfg.hiddenClients)
      ? cfg.hiddenClients.filter((value): value is string => typeof value === 'string')
      : [],
  )
  const queryConfig = useMemo<Config>(() => ({
    ...cfg,
    hiddenClients: JSON.parse(hiddenClientsKey) as string[],
  }), [cfg.halfLifeDays, hiddenClientsKey])

  const found = useMemo(
    () => query(db, queryConfig, {
      text: text || undefined,
      cwd: scope ?? undefined,
      client,
      // Sessions whose transcript has vanished stay in the list. They cannot be
      // launched, but hiding them turns "the file is gone" into "the session
      // never existed"; the preview says which one it is in red.
      includeMissing: true,
      limit: SESSION_DISPLAY_LIMIT + 1,
    }),
    [db, queryConfig, text, scope, cwd, client],
  )
  const overflowed = found.length > SESSION_DISPLAY_LIMIT
  const rows = useMemo(
    () => (found.length > SESSION_DISPLAY_LIMIT ? found.slice(0, SESSION_DISPLAY_LIMIT) : found),
    [found],
  )

  const rowCount = useRef(rows.length)
  rowCount.current = rows.length
  // Read at the moment tab is pressed, so narrowing follows the cursor rather
  // than whichever row was selected when the handler was built.
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const selectedRef = useRef(0)
  const selected = clampSelection(selectedState, rows.length)
  selectedRef.current = selected
  useEffect(() => {
    if (selectedState !== selected) setSelectedState(selected)
  }, [selectedState, selected])

  const setSelected = useCallback((next: SetStateAction<number>) => {
    setSelectedState((previous) => {
      const value = typeof next === 'function' ? next(previous) : next
      return clampSelection(value, rowCount.current)
    })
  }, [])

  const move = useCallback((delta: number) => {
    const step = Number.isFinite(delta) ? Math.trunc(delta) : 0
    setSelectedState((previous) => clampSelection(
      clampSelection(previous, rowCount.current) + step,
      rowCount.current,
    ))
  }, [])

  const setText = useCallback((next: string) => {
    setTextState(next)
    setSelectedState(0)
  }, [])
  const setScope = useCallback((next: Scope) => {
    setScopeState(next)
    setSelectedState(0)
  }, [])
  const toggleScope = useCallback(() => {
    setScopeState((previous) => {
      if (previous !== null) return null
      const row = rowsRef.current[selectedRef.current]
      return (typeof row?.cwd === 'string' && row.cwd) || cwd || null
    })
    setSelectedState(0)
  }, [cwd])
  const setClient = useCallback((next: string | undefined) => {
    setClientState(next)
    setSelectedState(0)
  }, [])

  return {
    rows,
    overflowed,
    text,
    setText,
    scope,
    setScope,
    toggleScope,
    client,
    setClient,
    selected,
    setSelected,
    move,
  }
}
