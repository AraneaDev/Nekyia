import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { Config } from '../config'
import type { IndexDb } from '../core/db'
import { querySnapshot, readSessionSnapshot, type Row, type SessionSnapshot } from '../core/query'

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
  /** The client filters ctrl+f steps through: undefined for all, then the clients the index holds. */
  clientCycle: readonly (string | undefined)[]
  /** Steps the client filter on to the next entry of `clientCycle`. */
  cycleClient: () => void
  selected: number
  setSelected: (selected: SetStateAction<number>) => void
  move: (delta: number) => void
}

/**
 * Keeps a selection index within the bounds of a list, falling back to 0 if out of range.
 */
function clampSelection(selected: number, length: number): number {
  if (length <= 0) return 0
  const safe = Number.isFinite(selected) ? Math.floor(selected) : 0
  return Math.max(0, Math.min(length - 1, safe))
}

/** Drops the trailing separators a shell or a config file may leave on a directory path. */
function withoutTrailingSeparator(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  return trimmed || path
}

/**
 * True when the path is the top of a filesystem tree.
 *
 * A root is its own parent, which is what `dirname` reports for POSIX `/` and,
 * on Windows, for a drive or UNC root. A Windows-shaped path handed to a POSIX
 * build is recognised separately rather than mistaken for an ordinary
 * directory, which costs one regular expression and never throws.
 */
function isFilesystemRoot(path: string): boolean {
  return dirname(path) === path || /^[A-Za-z]:[\\/]?$/u.test(path)
}

/** True when the picker was launched from the user's home directory itself, not from a project inside it. */
function isHomeDirectory(path: string): boolean {
  let home: string
  try {
    home = homedir()
  } catch {
    // An environment without a resolvable home is not a home directory.
    return false
  }
  if (!home) return false
  return withoutTrailingSeparator(path) === withoutTrailingSeparator(home)
}

/**
 * The scope the picker opens on.
 *
 * Narrowing to the launch directory is right from inside a project and wrong
 * everywhere else. The home directory and a filesystem root are where sessions
 * are worked on least and where a scoped picker is emptiest, so both open on
 * the whole index. A directory with nothing indexed under it is the same
 * disappointment reached differently, a fresh clone or a project that has never
 * been indexed, and opens global too. Tab still narrows from any of them.
 *
 * "Nothing indexed" is asked through the query the list itself runs, over the
 * snapshot that is already in hand, so it answers with exactly the rows the
 * first frame would have shown: hidden clients dropped, missing sessions kept.
 */
function initialScope(db: IndexDb, cfg: Config, snapshot: SessionSnapshot, cwd: string): Scope {
  if (typeof cwd !== 'string' || !cwd.trim()) return null
  if (isFilesystemRoot(cwd) || isHomeDirectory(cwd)) return null
  const under = querySnapshot(db, cfg, snapshot, { cwd, includeMissing: true, limit: 1 })
  return under.length > 0 ? cwd : null
}

/** Query state shared by the picker and its keyboard bindings. */
export function useSessions(db: IndexDb, cfg: Config, cwd: string): SessionsState {
  // The picker holds one index handle for its whole run, so the session table is
  // read once here and every keystroke reuses those rows and the fork chains
  // derived from them, instead of rescanning the table per character typed.
  //
  // The invariant this buys is that the picker's view of the session table is
  // frozen at open. A session marked `missing` after this point keeps listing as
  // present until the picker is restarted. Nothing writes to the index while a
  // picker is up, and the non-interactive callers go through `query()`, which
  // reads fresh every call, so only this list can go stale. Should indexing ever
  // run alongside the picker, this memo is what has to be invalidated.
  const snapshot = useMemo(() => readSessionSnapshot(db), [db])

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

  // Which clients exist is a property of the index, so it is read once for the
  // picker's lifetime under the same frozen-at-open invariant as the snapshot,
  // never per keystroke and never per render.
  const indexedClients = useMemo(() => db.indexedClients(), [db])
  // Hidden clients are dropped from the results by every query, so an entry for
  // one would be a step that can only ever show an empty list: exactly the thing
  // this cycle exists to remove. `undefined` stays first no matter what the
  // index holds, so the way back to an unfiltered list is always one more press,
  // and an index with nothing in it still cycles rather than dividing by zero.
  const clientCycle = useMemo<readonly (string | undefined)[]>(() => {
    const hidden = new Set(JSON.parse(hiddenClientsKey) as string[])
    return [undefined, ...indexedClients.filter((client) => !hidden.has(client))]
  }, [indexedClients, hiddenClientsKey])

  const [text, setTextState] = useState('')
  const [scope, setScopeState] = useState<Scope>(
    () => initialScope(db, queryConfig, snapshot, cwd),
  )
  const [client, setClientState] = useState<string | undefined>()
  const [selectedState, setSelectedState] = useState(0)

  const found = useMemo(
    () => querySnapshot(db, queryConfig, snapshot, {
      text: text || undefined,
      cwd: scope ?? undefined,
      client,
      // Sessions whose transcript has vanished stay in the list. They cannot be
      // launched, but hiding them turns "the file is gone" into "the session
      // never existed"; the preview says which one it is in red.
      includeMissing: true,
      limit: SESSION_DISPLAY_LIMIT + 1,
    }),
    [db, queryConfig, snapshot, text, scope, cwd, client],
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
  // Read at the moment ctrl+f is pressed, for the same reason.
  const cycleRef = useRef(clientCycle)
  cycleRef.current = clientCycle
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
  const cycleClient = useCallback(() => {
    setClientState((previous) => {
      const cycle = cycleRef.current
      // A filter the cycle does not hold is not found, and -1 steps to the
      // first entry: the press widens back to all clients instead of sticking.
      const at = cycle.indexOf(previous)
      return cycle[(at + 1) % cycle.length]
    })
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
    clientCycle,
    cycleClient,
    selected,
    setSelected,
    move,
  }
}
