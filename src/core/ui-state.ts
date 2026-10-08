import { join } from 'node:path'
import { readUserJson, updateUserJson } from './user-storage.js'

/** Only exact session identifiers are persisted; metadata remains in the index. */
export interface BookmarkState { version: 1; uids: string[] }

/** Read status keeps an invalid existing file protected from fallback writes. */
export interface BookmarkLoad {
  state: BookmarkState
  warning: string | null
  writable: boolean
}

/** Storage contract usable by the picker with an isolated store in tests. */
export interface BookmarkStore {
  load(): BookmarkLoad
  set(uid: string, enabled: boolean): Promise<BookmarkState>
  remove(uid: string): Promise<BookmarkState>
}

const MAX_BYTES = 1024 * 1024
const MAX_BOOKMARKS = 256

/** Strictly checks the versioned UID-only schema, retaining stale identifiers. */
function parseBookmarks(value: unknown): BookmarkState {
  if (value === undefined) return { version: 1, uids: [] }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Bookmarks must be a versioned object')
  }
  const state = value as Record<string, unknown>
  if (state.version !== 1) throw new Error('Unsupported bookmark version')
  if (Object.keys(state).some(key => key !== 'version' && key !== 'uids') || !Array.isArray(state.uids)
    || state.uids.some(uid => typeof uid !== 'string' || uid.length === 0)) {
    throw new Error('Bookmarks must contain only session UIDs')
  }
  const uids = [...new Set(state.uids as string[])]
  if (uids.length > MAX_BOOKMARKS) throw new Error('Bookmarks are limited to 256 sessions')
  return { version: 1, uids }
}

/** Loads a bounded file, reporting read-only fallback instead of discarding invalid data. */
export function loadBookmarks(dir: string): BookmarkLoad {
  try {
    return { state: parseBookmarks(readUserJson(join(dir, 'ui-state.json'), MAX_BYTES)), warning: null, writable: true }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { state: { version: 1, uids: [] }, warning: null, writable: true }
    }
    return {
      state: { version: 1, uids: [] }, writable: false,
      warning: `Bookmarks are read-only: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** Toggles an exact UID under a durable lock; failures leave the previous file intact. */
export async function setBookmark(dir: string, uid: string, enabled: boolean): Promise<BookmarkState> {
  if (typeof uid !== 'string' || uid.length === 0) throw new Error('A bookmark requires a session UID')
  let next: BookmarkState = { version: 1, uids: [] }
  await updateUserJson(join(dir, 'ui-state.json'), current => {
    const state = parseBookmarks(current)
    next = parseBookmarks({ version: 1, uids: enabled ? [...state.uids, uid] : state.uids.filter(saved => saved !== uid) })
    return next
  })
  return next
}

/** Removes a saved UID only after an explicit user action. */
export async function removeBookmark(dir: string, uid: string): Promise<BookmarkState> {
  return setBookmark(dir, uid, false)
}

/** Binds storage to an explicit directory, allowing tests to avoid host user state. */
export function bookmarkStore(dir: string): BookmarkStore {
  return {
    /** Reads this store's current state. */
    load() { return loadBookmarks(dir) },
    /** Persists a toggle before reporting success. */
    set(uid, enabled) { return setBookmark(dir, uid, enabled) },
    /** Explicitly removes a stored identifier. */
    remove(uid) { return removeBookmark(dir, uid) },
  }
}
