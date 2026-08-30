import { join, parse as parsePath, resolve } from 'node:path'
import { homedir } from 'node:os'
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
import { Glob } from 'bun'

/** User-tunable settings that survive between runs. */
export interface Config {
  /** Directory glob exclusions applied at index time. */
  exclude: string[]
  /** Recency decay half-life in days. */
  halfLifeDays: number
  /** Maximum file size accepted for indexing, in bytes. */
  maxFileBytes: number
  /** Client names hidden from normal results. */
  hiddenClients: string[]
}

/** The settings used when no config file exists, or when the one on disk cannot be trusted. */
export const DEFAULT_CONFIG: Config = {
  exclude: [],
  halfLifeDays: 14,
  maxFileBytes: 25 * 1024 * 1024,
  hiddenClients: [],
}

const MAX_CONFIG_BYTES = 1024 * 1024
/** Upper bound on the entries of any config list, enforced on every write. */
export const MAX_CONFIG_ITEMS = 256
const MAX_CONFIG_STRING = 4096
const CONFIG_FIELDS = new Set([
  'exclude', 'halfLifeDays', 'maxFileBytes', 'hiddenClients',
])
/**
 * Fields Nekyia no longer honours but still accepts on disk.
 *
 * A strict read rejects unknown keys, so retiring a field outright would turn
 * every config an older version wrote into an error the next time it was
 * updated. A retired field is tolerated and then dropped: nothing assigns it,
 * so the next write simply leaves it out.
 */
const RETIRED_CONFIG_FIELDS = new Set(['showSniffed'])
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

/**
 * Extracts the error code from an unknown error object, if present.
 */
function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/**
 * Reads a config file synchronously up to MAX_CONFIG_BYTES, throwing if exceeded or modified during read.
 */
function readBoundedConfig(path: string): string {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error('config is not a bounded regular file')
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

/** Nekyia's configuration directory, honouring XDG_CONFIG_HOME. */
export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'nekyia')
}

/** Nekyia's data directory, honouring XDG_DATA_HOME. */
export function dataDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'nekyia')
}

/** Where the SQLite index lives. */
export function indexPath(): string {
  return join(dataDir(), 'index.db')
}

/** Where user-supplied client manifests are read from. */
export function userManifestDir(): string {
  return join(configDir(), 'clients')
}

/**
 * Creates a new instance of the default configuration to prevent accidental mutation of shared defaults.
 */
function freshDefaults(): Config {
  return {
    ...DEFAULT_CONFIG,
    exclude: [...DEFAULT_CONFIG.exclude],
    hiddenClients: [...DEFAULT_CONFIG.hiddenClients],
  }
}

/**
 * Checks if a value is a plain JavaScript object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

/**
 * Checks if a value is an array of strings, constrained by maximum items and string length limits.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_CONFIG_ITEMS
    && value.every((item) => typeof item === 'string' && item.length <= MAX_CONFIG_STRING)
}

/**
 * Checks if a value is a finite number.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Parses a raw configuration string, optionally throwing errors on unknown or invalid fields.
 */
function parseConfig(raw: string, strict: boolean): Config {
  const parsed: unknown = JSON.parse(raw)
  const config = freshDefaults()
  if (!isPlainObject(parsed)) {
    if (strict) throw new Error('config must be a JSON object')
    return config
  }
  if (strict && Object.keys(parsed).some(
    (key) => !CONFIG_FIELDS.has(key) && !RETIRED_CONFIG_FIELDS.has(key),
  )) {
    throw new Error('config contains unknown fields')
  }

  /**
   * Assigns a validated property to the config object.
   */
  const assign = <T>(
    key: keyof Config,
    valid: (value: unknown) => value is T,
    copy: (value: T) => Config[typeof key],
  ) => {
    if (parsed[key] === undefined) return
    if (!valid(parsed[key])) {
      if (strict) throw new Error(`config field is invalid: ${key}`)
      return
    }
    ;(config as unknown as Record<string, unknown>)[key] = copy(parsed[key])
  }
  assign('exclude', isStringArray, (value) => [...value])
  assign('halfLifeDays', isFiniteNumber, (value) => value)
  assign('maxFileBytes', isFiniteNumber, (value) => value)
  assign('hiddenClients', isStringArray, (value) => [...value])
  return config
}

/**
 * Serializes and validates a configuration object into a UTF-8 Buffer.
 */
function configBytes(config: Config): Buffer {
  if (!isStringArray(config.exclude)
    || !isFiniteNumber(config.halfLifeDays)
    || !isFiniteNumber(config.maxFileBytes)
    || !isStringArray(config.hiddenClients)) {
    throw new Error('config exceeds limits or contains invalid values')
  }
  const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`)
  if (bytes.length > MAX_CONFIG_BYTES) throw new Error('config exceeds the size limit')
  return bytes
}

/**
 * Ensures the config directory exists and contains no symlinks or unsafe paths up to the root.
 */
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

/**
 * Reads the config file, falling back to defaults rather than failing.
 *
 * A missing, oversized or malformed config must never stop a search: the
 * worst case is that the user's tuning is ignored for this run.
 */
export function loadConfig(): Config {
  try {
    const raw = readBoundedConfig(join(configDir(), 'config.json'))
    return parseConfig(raw, false)
  } catch {
    return freshDefaults()
  }
}

/** Writes the config atomically, validating and sizing the payload before touching the filesystem. */
export function saveConfig(config: Config): void {
  // Validate and allocate the bounded payload before touching the filesystem.
  const bytes = configBytes(config)
  const directory = resolve(configDir())
  ensureSafeDirectory(directory)
  const directoryInfo = lstatSync(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
    || realpathSync(directory) !== directory) {
    throw new Error('config directory is not a safe directory')
  }

  const target = join(directory, 'config.json')
  try {
    const targetInfo = lstatSync(target)
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
      throw new Error('config path is not a regular file')
    }
  } catch (error) {
    const missing = errorCode(error) === 'ENOENT'
    if (!missing) throw error
  }

  const temporary = join(directory, `.config.${process.pid}.${randomUUID()}.tmp`)
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

/**
 * Loads the configuration for an update operation, throwing on invalid fields but allowing defaults on missing files.
 */
function loadConfigForUpdate(): Config {
  try {
    return parseConfig(readBoundedConfig(join(configDir(), 'config.json')), true)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return freshDefaults()
    throw error
  }
}

/**
 * Reads and validates the owner information of a lock file.
 */
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
async function acquireRecoveryGuard(directory: string): Promise<ConfigLock> {
  const path = join(directory, '.config.lock.recovery')
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
        const quarantine = join(directory, `.config.lock.recovery.stale.${randomUUID()}`)
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
async function acquireConfigLock(directory: string): Promise<ConfigLock> {
  const path = join(directory, '.config.lock')
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const guard = await acquireRecoveryGuard(directory)
    let acquired: ConfigLock | null = null
    let busy = false
    try {
      try {
        const existing = inspectConfigLock(path)
        if (!existing.stale) {
          busy = true
        } else {
          const quarantine = join(directory, `.config.lock.stale.${randomUUID()}`)
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
  const guard = await acquireRecoveryGuard(parent)
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

/** Serializes a strict, lossless config read-modify-write operation. */
export async function updateConfig(
  mutate: (current: Config) => Config | Promise<Config>,
): Promise<Config> {
  const directory = resolve(configDir())
  ensureSafeDirectory(directory)
  const lock = await acquireConfigLock(directory)
  try {
    const next = await mutate(loadConfigForUpdate())
    saveConfig(next)
    return next
  } finally {
    await releaseConfigLock(lock)
  }
}

const compiledExcludes = new WeakMap<string[], { patterns: string[]; globs: Glob[] }>()

/**
 * Compiles a config's exclusion patterns once instead of once per session.
 *
 * Discovery asks about every ref it sees, so building a Glob per pattern per
 * ref re-parses the same patterns thousands of times in one index run. The
 * cache is keyed on the config's own array and still compares its contents,
 * so neither a replaced config nor one mutated in place is served stale globs.
 */
function excludeGlobs(patterns: string[]): Glob[] {
  const cached = compiledExcludes.get(patterns)
  if (cached
    && cached.patterns.length === patterns.length
    && cached.patterns.every((pattern, index) => pattern === patterns[index])) {
    return cached.globs
  }
  const globs = patterns.map((pattern) => new Glob(pattern))
  compiledExcludes.set(patterns, { patterns: [...patterns], globs })
  return globs
}

/** Reports whether a directory is covered by a user exclusion, so it never reaches the index. */
export function isExcluded(cwd: string | null, config: Config): boolean {
  if (!cwd) return false
  return excludeGlobs(config.exclude).some((glob) => glob.match(cwd))
}
