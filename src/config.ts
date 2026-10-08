import { join } from 'node:path'
import { readUserText, writeUserBytes, withUserStorageLock } from './core/user-storage.js'
import { homedir } from 'node:os'
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
  /**
   * Reindexes on picker startup once the index is at least this many hours old.
   *
   * Defaults to one hour. `0` refreshes on every open with a known index age.
   */
  autoReindexAfterHours?: number
  /**
   * Which launcher opens a store that more than one client writes, by manifest id.
   *
   * Absent until the user chooses. Only consulted when both clients are on PATH;
   * with one installed there is nothing to choose.
   */
  launchers?: Record<string, string>
}

/** The settings used when no config file exists, or when the one on disk cannot be trusted. */
export const DEFAULT_CONFIG: Config = {
  exclude: [],
  halfLifeDays: 14,
  maxFileBytes: 25 * 1024 * 1024,
  hiddenClients: [],
  autoReindexAfterHours: 1,
}

const MAX_CONFIG_BYTES = 1024 * 1024
/** Upper bound on the entries of any config list, enforced on every write. */
export const MAX_CONFIG_ITEMS = 256
const MAX_CONFIG_STRING = 4096
const CONFIG_FIELDS = new Set([
  'exclude', 'halfLifeDays', 'maxFileBytes', 'hiddenClients', 'autoReindexAfterHours', 'launchers',
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
/**
 * Fields that carry an instruction about what Nekyia may hold or show, rather
 * than a preference about how it ranks or reads.
 *
 * The difference decides what a config nobody can honour means. Losing
 * `halfLifeDays` costs the user their ranking preference for one run. Losing
 * `exclude` silently indexes directories they asked Nekyia to stay out of, and
 * the defaults these fall back to are the permissive ones, so the failure
 * broadens what is held instead of narrowing it.
 */
const POLICY_FIELDS = new Set(['exclude', 'hiddenClients'])
/** Extracts the code of a filesystem failure. */
function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/** Reads bounded configuration text using shared secure user storage. */
function readBoundedConfig(path: string): string {
  return readUserText(path, MAX_CONFIG_BYTES)
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

/** A bounded map of non-empty, bounded strings. */
function isLauncherChoices(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.length <= MAX_CONFIG_ITEMS && entries.every(([key, choice]) => (
    key.length > 0 && key.length <= MAX_CONFIG_STRING
    && typeof choice === 'string' && choice.length > 0 && choice.length <= MAX_CONFIG_STRING
  ))
}

/**
 * Parses a raw configuration string, optionally throwing errors on unknown or invalid fields.
 */
function parseConfig(raw: string, strict: boolean, dropped?: string[]): Config {
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
      // A non-strict read keeps going on the fields it can use, but the caller
      // still has to learn which instruction it just lost.
      dropped?.push(key)
      return
    }
    ;(config as unknown as Record<string, unknown>)[key] = copy(parsed[key])
  }
  assign('exclude', isStringArray, (value) => [...value])
  assign('halfLifeDays', isFiniteNumber, (value) => value)
  assign('maxFileBytes', isFiniteNumber, (value) => value)
  assign('hiddenClients', isStringArray, (value) => [...value])
  assign('autoReindexAfterHours', isFiniteNumber, (value) => value)
  assign('launchers', isLauncherChoices, (value) => ({ ...value }))
  return config
}

/**
 * Serializes and validates a configuration object into a UTF-8 Buffer.
 */
function configBytes(config: Config): Buffer {
  if (!isStringArray(config.exclude)
    || !isFiniteNumber(config.halfLifeDays)
    || !isFiniteNumber(config.maxFileBytes)
    || !isStringArray(config.hiddenClients)
    || (config.autoReindexAfterHours !== undefined && !isFiniteNumber(config.autoReindexAfterHours))
    || (config.launchers !== undefined && !isLauncherChoices(config.launchers))) {
    throw new Error('config exceeds limits or contains invalid values')
  }
  const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`)
  if (bytes.length > MAX_CONFIG_BYTES) throw new Error('config exceeds the size limit')
  return bytes
}

/** A config to work from, and whether the one on disk could actually be honoured. */
export interface ConfigLoad {
  config: Config
  /**
   * Null when there is no config file, or when the one there was honoured in
   * full. Otherwise a printable account of what was lost.
   *
   * Only the fields in `POLICY_FIELDS` set this. A dropped preference really is
   * the harmless case the fallback was written for; a dropped instruction is
   * not, because the value it falls back to is the permissive one.
   */
  problem: string | null
}

/**
 * Reads the config file, reporting whether it could be honoured.
 *
 * A missing, oversized or malformed config must never stop a search, so a
 * usable config always comes back. What it must not do is pass silently: the
 * defaults it falls back to include an empty `exclude` and an empty
 * `hiddenClients`, so a config nobody can read widens what Nekyia indexes and
 * shows rather than leaving it alone. Callers that are about to write on the
 * strength of those fields need to know before they do.
 */
export function loadConfigChecked(): ConfigLoad {
  const path = join(configDir(), 'config.json')
  let raw: string
  try {
    raw = readBoundedConfig(path)
  } catch (error) {
    // No config is not a broken config: the defaults are the whole intent.
    if (errorCode(error) === 'ENOENT') return { config: freshDefaults(), problem: null }
    const detail = error instanceof Error ? error.message : String(error)
    return { config: freshDefaults(), problem: `${path} could not be read: ${detail}` }
  }

  const dropped: string[] = []
  let config: Config
  try {
    config = parseConfig(raw, false, dropped)
  } catch {
    return { config: freshDefaults(), problem: `${path} is not valid JSON` }
  }

  const lost = dropped.filter((key) => POLICY_FIELDS.has(key)).sort()
  return {
    config,
    problem: lost.length === 0 ? null : `${path} has an unusable ${lost.join(' and ')}`,
  }
}

/**
 * Reads the config file, falling back to defaults rather than failing.
 *
 * Kept for every caller that has nothing to decide on the answer. A caller that
 * is about to act on `exclude` or `hiddenClients` wants `loadConfigChecked`,
 * which says whether those survived the read.
 */
export function loadConfig(): Config {
  return loadConfigChecked().config
}

/** Writes the config atomically, validating and sizing the payload before touching the filesystem. */
export function saveConfig(config: Config): void {
  writeUserBytes(join(configDir(), 'config.json'), configBytes(config))
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

/** Serializes a strict, lossless config read-modify-write operation. */
export async function updateConfig(
  mutate: (current: Config) => Config | Promise<Config>,
): Promise<Config> {
  return withUserStorageLock(join(configDir(), 'config.json'), async () => {
    const next = await mutate(loadConfigForUpdate())
    saveConfig(next)
    return next
  })
}

/** Saves which launcher opens a shared store, keeping every other setting as it is. */
export async function saveLauncherChoice(clientId: string, launcher: string): Promise<void> {
  await updateConfig((current) => ({
    ...current,
    launchers: { ...(current.launchers ?? {}), [clientId]: launcher },
  }))
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
