import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import type { Config } from '../config'
import type { IndexDb } from '../core/db'
import { query, type Row } from '../core/query'

export type Scope = 'cwd' | 'all'

export interface SessionsState {
  rows: Row[]
  text: string
  setText: (text: string) => void
  scope: Scope
  setScope: (scope: Scope) => void
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
  const [scope, setScopeState] = useState<Scope>('cwd')
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
  }), [cfg.halfLifeDays, cfg.showSniffed, hiddenClientsKey])

  const rows = useMemo(
    () => query(db, queryConfig, {
      text: text || undefined,
      cwd: scope === 'cwd' ? cwd : undefined,
      client,
      limit: 500,
    }),
    [db, queryConfig, text, scope, cwd, client],
  )

  const rowCount = useRef(rows.length)
  rowCount.current = rows.length
  const selected = clampSelection(selectedState, rows.length)
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
    setScopeState((previous) => previous === 'cwd' ? 'all' : 'cwd')
    setSelectedState(0)
  }, [])
  const setClient = useCallback((next: string | undefined) => {
    setClientState(next)
    setSelectedState(0)
  }, [])

  return {
    rows,
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
