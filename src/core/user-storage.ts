import { basename, dirname, join, parse as parsePath, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs'

const LOCK_ATTEMPTS = 50
const LOCK_WAIT_MS = 10
const LOCK_STALE_MS = 30_000
const LOCK_OWNER_FILE = 'owner'

/**
 * Represents an active lock on the configuration directory.
 */
interface ConfigLock {
  directory: string
  ownerPath: string
  token: string
  dev: number
  ino: number
}

/** Extracts a filesystem error code without assuming an Error instance. */
function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/**
 * Reads a bounded regular UTF-8 file without following symlinks.
 *
 * Only the directory that holds the file is checked, not every ancestor. A
 * symlink higher up is the system's or the user's own arrangement: macOS keeps
 * its temporary directories under /var, a link to /private/var, and dotfile
 * managers often link ~/.config. Refusing those made every read fail there, so
 * the config could not be loaded and indexing stopped.
 */
export function readUserText(path: string, maxBytes: number): string {
  const directory = dirname(resolve(path))
  const holder = lstatSync(directory)
  if (!holder.isDirectory() || holder.isSymbolicLink()) throw new Error('config directory is not a safe directory')
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('config is not a bounded regular file')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    if (offset !== bytes.length) throw new Error('config changed while reading')
    return bytes.toString('utf8')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Validates directory ancestors, creating missing private directories for writes. */
function ensureSafeDirectory(directory: string): void {
  const absolute = resolve(directory)
  const parsed = parsePath(absolute)
  let cursor = parsed.root
  for (const segment of absolute.slice(parsed.root.length).split('/').filter(Boolean)) {
    cursor = join(cursor, segment)
    try {
      const info = lstatSync(cursor)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('config path contains an unsafe directory')
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      const previousUmask = process.umask(0o077)
      try {
        try { mkdirSync(cursor, { mode: 0o700 }) } catch (mkdirError) {
          if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError
        }
      } finally {
        process.umask(previousUmask)
      }
      const created = lstatSync(cursor)
      if (!created.isDirectory() || created.isSymbolicLink()) {
        // Reaching here means the path was replaced between mkdir and lstat.
        // The ENOENT that led here was expected and handled, but it is kept as
        // the cause so the sequence is still legible when this fires.
        throw new Error('config path contains an unsafe directory', { cause: error })
      }
    }
  }
}

/** Writes bounded prevalidated bytes atomically with private file permissions. */
export function writeUserBytes(path: string, bytes: Buffer): void {
  const directory = dirname(resolve(path))
  ensureSafeDirectory(directory)
  const directoryInfo = lstatSync(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
    || realpathSync(directory) !== directory) {
    throw new Error('config directory is not a safe directory')
  }

  const target = resolve(path)
  try {
    const targetInfo = lstatSync(target)
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
      throw new Error('config path is not a regular file')
    }
  } catch (error) {
    const missing = errorCode(error) === 'ENOENT'
    if (!missing) throw error
  }

  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    fchmodSync(descriptor, 0o600)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset)
      if (written <= 0) throw new Error('config write made no progress')
      offset += written
    }
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, target)
    const parentDescriptor = openSync(
      directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try { fsyncSync(parentDescriptor) } finally { closeSync(parentDescriptor) }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
    }
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

/** Reads a bounded, regular no-follow lock owner record. */
function readLockOwner(path: string): { token: string; pid: number; mtimeMs: number } {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = fstatSync(fd)
    if (!info.isFile() || info.size < 1 || info.size > 1_024) {
      throw new Error('config lock owner is unsafe')
    }
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    if (offset !== bytes.length) throw new Error('config lock owner changed while reading')
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!isPlainObject(value)
      || typeof value.token !== 'string'
      || value.token.length !== 36
      || typeof value.pid !== 'number'
      || !Number.isSafeInteger(value.pid)
      || value.pid < 1) {
      throw new Error('config lock owner is invalid')
    }
    return { token: value.token, pid: value.pid, mtimeMs: info.mtimeMs }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Checks if a process with the given PID is currently running.
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}

/**
 * Creates a lock directory and owner file, throwing if the lock already exists.
 */
function createConfigLock(path: string): ConfigLock {
  mkdirSync(path, { mode: 0o700 })
  const directoryInfo = lstatSync(path)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error('config lock is unsafe')
  }
  const token = randomUUID()
  const ownerPath = join(path, LOCK_OWNER_FILE)
  let fd: number | undefined
  try {
    fd = openSync(
      ownerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    fchmodSync(fd, 0o600)
    const bytes = Buffer.from(JSON.stringify({ token, pid: process.pid }))
    const written = writeSync(fd, bytes, 0, bytes.length)
    if (written !== bytes.length) throw new Error('config lock write was incomplete')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    return {
      directory: path,
      ownerPath,
      token,
      dev: directoryInfo.dev,
      ino: directoryInfo.ino,
    }
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd) } catch {}
    try { unlinkSync(ownerPath) } catch {}
    try { rmdirSync(path) } catch {}
    throw error
  }
}

/**
 * Inspects a config lock to determine its staleness and ownership details.
 */
function inspectConfigLock(path: string): {
  dev: number
  ino: number
  stale: boolean
} {
  const directoryInfo = lstatSync(path)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error('config lock is unsafe')
  }
  const entries = readdirSync(path)
  if (entries.length !== 1 || entries[0] !== LOCK_OWNER_FILE) {
    // An incomplete crashed acquisition becomes recoverable only after the
    // directory itself ages past the stale bound.
    if (entries.length === 0) {
      return {
        dev: directoryInfo.dev,
        ino: directoryInfo.ino,
        stale: Date.now() - directoryInfo.mtimeMs > LOCK_STALE_MS,
      }
    }
    throw new Error('config lock contains unexpected entries')
  }
  const owner = readLockOwner(join(path, LOCK_OWNER_FILE))
  return {
    dev: directoryInfo.dev,
    ino: directoryInfo.ino,
    stale: Date.now() - owner.mtimeMs > LOCK_STALE_MS && !processIsAlive(owner.pid),
  }
}

/**
 * Removes a quarantined stale lock directory, validating its inode and contents first.
 */
function removeQuarantinedLock(path: string, dev: number, ino: number): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== dev || info.ino !== ino) {
    throw new Error('stale config lock ownership changed')
  }
  const entries = readdirSync(path)
  if (entries.length === 1 && entries[0] === LOCK_OWNER_FILE) {
    const ownerPath = join(path, LOCK_OWNER_FILE)
    // readLockOwner verifies a bounded regular O_NOFOLLOW file before unlink.
    readLockOwner(ownerPath)
    unlinkSync(ownerPath)
  } else if (entries.length !== 0) {
    throw new Error('stale config lock contains unexpected entries')
  }
  rmdirSync(path)
}

/**
 * Reports whether the recovery guard may be broken, tolerating an owner file
 * that is still being written.
 *
 * Unlike the config lock, the guard is created outside any other lock, so a
 * contender can observe an acquisition in progress: the owner file exists from
 * the moment it is created and is only written a syscall later. An unreadable
 * owner therefore says nothing about liveness, and only the directory's own age
 * can decide. A guard being acquired right now is milliseconds old, never
 * LOCK_STALE_MS, so this cannot report a live guard as stale. The unsafe-path
 * checks are rethrown untouched: a symlink or a non-directory is never broken.
 */
function inspectRecoveryGuard(path: string): { dev: number; ino: number; stale: boolean } {
  try {
    return inspectConfigLock(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw error
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw error
    return {
      dev: info.dev,
      ino: info.ino,
      stale: Date.now() - info.mtimeMs > LOCK_STALE_MS,
    }
  }
}

/**
 * Removes a quarantined stale guard, including one whose owner file was
 * created but never written.
 *
 * This is removeQuarantinedLock's counterpart for the guard, and keeps every
 * one of its defences: the inode is re-verified after the rename, an
 * unexpected entry aborts, and the owner is opened O_NOFOLLOW and confirmed to
 * be a bounded regular file before it is unlinked. Only the demand that the
 * owner parse is dropped, because a guard stranded mid-creation must stay
 * recoverable.
 */
function removeStaleGuard(path: string, dev: number, ino: number): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== dev || info.ino !== ino) {
    throw new Error('stale config recovery guard ownership changed')
  }
  const entries = readdirSync(path)
  if (entries.length === 1 && entries[0] === LOCK_OWNER_FILE) {
    const ownerPath = join(path, LOCK_OWNER_FILE)
    const fd = openSync(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const ownerInfo = fstatSync(fd)
      if (!ownerInfo.isFile() || ownerInfo.size > 1_024) {
        throw new Error('stale config recovery guard owner is unsafe')
      }
    } finally {
      closeSync(fd)
    }
    unlinkSync(ownerPath)
  } else if (entries.length !== 0) {
    throw new Error('stale config recovery guard contains unexpected entries')
  }
  rmdirSync(path)
}

/**
 * Takes the short-lived guard that serializes config lock creation, recovery
 * and release.
 *
 * The guard is a directory, so claiming it is atomic, and it records its owner
 * exactly as the config lock does. That record is what tells a guard stranded
 * by a hard kill apart from one a live process is holding: it is broken only
 * when it is both older than LOCK_STALE_MS and owned by a pid that no longer
 * exists. A guard that may still be live is never broken, because deleting one
 * would let a contender go on to delete a live owner's lock.
 */
async function acquireRecoveryGuard(directory: string, stem: string): Promise<ConfigLock> {
  const path = join(directory, `.${stem}.lock.recovery`)
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      return createConfigLock(path)
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    let retryNow = false
    try {
      const existing = inspectRecoveryGuard(path)
      if (existing.stale) {
        // Quarantine by rename first, exactly as the config lock does: the
        // removal re-verifies the inode it inspected, so a guard created in
        // the meantime is never the one deleted.
        const quarantine = join(directory, `.${stem}.lock.recovery.stale.${randomUUID()}`)
        renameSync(path, quarantine)
        removeStaleGuard(quarantine, existing.dev, existing.ino)
        retryNow = true
      }
    } catch (error) {
      // The guard was released between the failed creation and the inspection.
      // Creating it is the only way to take it, so go straight to the retry.
      if (errorCode(error) !== 'ENOENT') throw error
      retryNow = true
    }
    if (!retryNow && attempt + 1 < LOCK_ATTEMPTS) await Bun.sleep(LOCK_WAIT_MS)
  }
  // Naming the guard keeps the failure actionable: this is the one path that
  // needs a human to look at the directory.
  throw new Error(`config recovery is busy: ${path}`)
}

/**
 * Releases the short-lived recovery guard after verifying its ownership and token.
 */
function releaseRecoveryGuard(guard: ConfigLock): void {
  const info = lstatSync(guard.directory)
  if (!info.isDirectory() || info.isSymbolicLink()
    || info.dev !== guard.dev || info.ino !== guard.ino) {
    throw new Error('config recovery guard ownership changed before release')
  }
  const owner = readLockOwner(guard.ownerPath)
  if (owner.token !== guard.token) {
    throw new Error('config recovery guard token changed before release')
  }
  unlinkSync(guard.ownerPath)
  rmdirSync(guard.directory)
}

/**
 * Acquires a durable lock on the configuration directory, cleaning up stale locks if necessary.
 */
async function acquireConfigLock(directory: string, stem: string): Promise<ConfigLock> {
  const path = join(directory, `.${stem}.lock`)
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const guard = await acquireRecoveryGuard(directory, stem)
    let acquired: ConfigLock | null = null
    let busy = false
    try {
      try {
        const existing = inspectConfigLock(path)
        if (!existing.stale) {
          busy = true
        } else {
          const quarantine = join(directory, `.${stem}.lock.stale.${randomUUID()}`)
          renameSync(path, quarantine)
          removeQuarantinedLock(quarantine, existing.dev, existing.ino)
          acquired = createConfigLock(path)
        }
      } catch (error) {
        if (errorCode(error) === 'ENOENT') acquired = createConfigLock(path)
        else throw error
      }
    } finally {
      releaseRecoveryGuard(guard)
    }
    if (acquired) return acquired
    if (!busy) throw new Error('config lock acquisition failed')
    if (attempt + 1 < LOCK_ATTEMPTS) await Bun.sleep(LOCK_WAIT_MS)
  }
  throw new Error('config is busy')
}

/**
 * Releases the configuration lock under the protection of a recovery guard.
 */
async function releaseConfigLock(lock: ConfigLock): Promise<void> {
  const parent = resolve(join(lock.directory, '..'))
  const guard = await acquireRecoveryGuard(parent, basename(lock.directory).slice(1, -5))
  try {
    const directoryInfo = lstatSync(lock.directory)
    if (!directoryInfo.isDirectory()
      || directoryInfo.isSymbolicLink()
      || directoryInfo.dev !== lock.dev
      || directoryInfo.ino !== lock.ino) {
      throw new Error('config lock ownership changed before release')
    }
    const owner = readLockOwner(lock.ownerPath)
    if (owner.token !== lock.token) throw new Error('config lock token changed before release')
    // Every cooperating acquisition/recovery/release holds the guard, so the
    // verified directory cannot be replaced between verification and removal.
    unlinkSync(lock.ownerPath)
    rmdirSync(lock.directory)
  } finally {
    releaseRecoveryGuard(guard)
  }
}

/** Checks that a lock owner is a JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parses a bounded regular JSON file without following directory or file symlinks. */
export function readUserJson(path: string, maxBytes: number): unknown {
  return JSON.parse(readUserText(path, maxBytes))
}

/**
 * Serializes updates under a directory lock named from the filename without
 * its .json suffix. Recovery requires an old lock and a dead owner; an old
 * incomplete acquisition is recoverable, while a live owner remains protected.
 * The callback must not recursively acquire this same storage lock.
 */
export async function withUserStorageLock<T>(path: string, action: () => T | Promise<T>): Promise<T> {
  const directory = dirname(resolve(path))
  ensureSafeDirectory(directory)
  const lock = await acquireConfigLock(directory, basename(path, '.json'))
  try { return await action() } finally { await releaseConfigLock(lock) }
}

/** Performs a locked JSON read-modify-write; undefined means the file does not exist. */
export async function updateUserJson(path: string, update: (current: unknown) => unknown): Promise<void> {
  await withUserStorageLock(path, () => {
    let current: unknown
    try { current = readUserJson(path, 1024 * 1024) } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    const bytes = Buffer.from(`${JSON.stringify(update(current), null, 2)}\n`)
    if (bytes.length > 1024 * 1024) throw new Error('user state exceeds the size limit')
    writeUserBytes(path, bytes)
  })
}
