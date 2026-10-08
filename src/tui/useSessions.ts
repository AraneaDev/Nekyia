import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { Config } from '../config'
import type { IndexDb } from '../core/db'
import type { Presentation } from '../core/launcher'
import { querySnapshot, readSessionSnapshot, resolveFacetPath, type Row, type SessionSnapshot } from '../core/query'
import { presetTimeRange, type TimePreset, type TimeRange } from '../core/time-range'
import {clearedFilters, restoreSelection, type PickerFilters, type PickerRestore} from './state'

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
const EMPTY_BOOKMARKS: ReadonlySet<string> = new Set()
const TIME_PRESETS: readonly TimePreset[] = ['all', 'today', 'yesterday', '7d', '30d']

/** The picker's search state and the actions that change it, kept out of the component so it can be tested directly. */
export interface SessionsState {
  filters: PickerFilters
  applyFilters: (filters: PickerFilters) => void
  snapshot: SessionSnapshot
  countMatches: (text: string, filters: PickerFilters) => number
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
  timePreset: TimePreset
  /** Resolved bounds shared with related-session membership annotations. */
  activeTimeRange: TimeRange
  cycleTimePreset: () => void
  clearTimePreset: () => void
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
export function useSessions(
  db: IndexDb, cfg: Config, cwd: string, presentation?: Map<string, Presentation>, now?: number, initial?: PickerRestore, bookmarks: ReadonlySet<string> = EMPTY_BOOKMARKS, clock: () => number = () => now ?? Date.now(),
): SessionsState {
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

  const [text, setTextState] = useState(initial?.text ?? '')
  const [filters, setFilters] = useState<PickerFilters>(() => initial?.filters ?? {
    ...clearedFilters(), scope: initialScope(db, queryConfig, snapshot, cwd),
  })
  const [selectionNow, setSelectionNow] = useState(() => now ?? clock())
  const activeTimeRange = useMemo(() => filters.time.kind === 'preset'
    ? presetTimeRange(filters.time.preset, selectionNow) : filters.time.range, [filters.time, selectionNow])
  const scope = filters.scope
  const client = filters.client ?? undefined
  const timePreset = filters.time.kind === 'preset' ? filters.time.preset : 'all'
  const options = useCallback((value: string, f: PickerFilters) => ({
    text: value || undefined, cwd: f.scope ?? undefined, client: f.client ?? undefined,
    ...(f.time.kind === 'preset' ? presetTimeRange(f.time.preset, selectionNow) : f.time.range),
    sort: f.sort, branch: f.branch, file: f.file?.exact ? undefined : f.file?.path, exactFile: f.file?.exact ? resolveFacetPath(f.file.path,cwd) ?? f.file.path : undefined,
    bookmarkedUids: f.bookmarkedOnly ? bookmarks : undefined,
    matchMode: 'prefix-last' as const, includeMissing: true, presentation, now: selectionNow,
  }), [selectionNow, bookmarks, presentation, cwd])
  const found = useMemo(() => querySnapshot(db, queryConfig, snapshot, {
    ...options(text, filters), limit: SESSION_DISPLAY_LIMIT + 1,
  }), [db, queryConfig, snapshot, options, text, filters])
  const overflowed = found.length > SESSION_DISPLAY_LIMIT
  const rows = useMemo(() => found.slice(0, SESSION_DISPLAY_LIMIT), [found])
  const [selectedState, setSelectedState] = useState(() => restoreSelection(
    rows.map(row => row.uid), initial?.selectedUid ?? null, initial?.selectedIndex ?? 0,
  ))
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const selected = clampSelection(selectedState, rows.length)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  useEffect(() => { if (selectedState !== selected) setSelectedState(selected) }, [selectedState, selected])
  const setSelected = useCallback((next: SetStateAction<number>) => {
    setSelectedState(previous => clampSelection(typeof next === 'function' ? next(previous) : next, rowsRef.current.length))
  }, [])
  const move = useCallback((delta: number) => {
    setSelectedState(previous => clampSelection(previous + (Number.isFinite(delta) ? Math.trunc(delta) : 0), rowsRef.current.length))
  }, [])
  const applyFilters = useCallback((next: PickerFilters) => {
    if (next.time.kind === 'preset') setSelectionNow(clock())
    setFilters(next); setSelectedState(0)
  }, [clock])
  const update = useCallback((fn: (f: PickerFilters) => PickerFilters) => {
    setFilters(fn); setSelectedState(0)
  }, [])
  const setText = useCallback((value: string) => { setTextState(value); setSelectedState(0) }, [])
  const setScope = useCallback((value: Scope) => update(f => ({...f,scope:value})), [update])
  const toggleScope = useCallback(() => update(f => ({...f,scope:f.scope !== null ? null :
    rowsRef.current[selectedRef.current]?.cwd || cwd || null})), [update,cwd])
  const setClient = useCallback((value: string | undefined) => update(f => ({...f,client:value ?? null})), [update])
  const cycleClient = useCallback(() => update(f => {
    const at=clientCycle.indexOf(f.client ?? undefined)
    return {...f,client:clientCycle[(at+1)%clientCycle.length] ?? null}
  }), [update,clientCycle])
  const cycleTimePreset = useCallback(() => {
    setSelectionNow(clock())
    update(f => {
      const preset=f.time.kind==='preset'?f.time.preset:'all'
      return {...f,time:{kind:'preset',preset:TIME_PRESETS[(TIME_PRESETS.indexOf(preset)+1)%TIME_PRESETS.length]!}}
    })
  }, [update,clock])
  const clearTimePreset = useCallback(() => {
    setSelectionNow(clock())
    update(f => ({...f,time:{kind:'preset',preset:'all'}}))
  }, [update,clock])
  const countMatches = useCallback((value:string,f:PickerFilters) => querySnapshot(db,queryConfig,snapshot,{
    ...options(value,f),limit:1,
  }).length,[db,queryConfig,snapshot,options])
  return {rows,overflowed,text,setText,scope,setScope,toggleScope,client,setClient,clientCycle,cycleClient,
    timePreset,activeTimeRange,cycleTimePreset,clearTimePreset,selected,setSelected,move,filters,applyFilters,snapshot,countMatches}
}
