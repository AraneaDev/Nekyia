import { closeSync, constants, fstatSync, openSync, opendirSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { userManifestDir } from '../config'
import { isSafeClientId, type ClientId, type Diagnostic, type Tier } from '../types'

/** The transcript store shapes Nekyia can read. Adding a client is a manifest unless its store needs a shape not listed here. */
export type FormatName = 'jsonl-transcript' | 'sqlite-store' | 'json-dir'

/** Every format name, for validating a manifest without trusting its own claim. */
export const FORMATS: readonly FormatName[] = [
  'jsonl-transcript',
  'sqlite-store',
  'json-dir',
]

/** A launch template. Placeholders are substituted by renderArgs and may sit anywhere inside an argument. */
export interface CommandSpec {
  cmd: string
  args: string[]
  cwd?: string
}

/**
 * Locates and interprets a line-per-record transcript.
 *
 * `variant` selects a reader tuned to a known client; `generic` describes an
 * unknown one field by field, so a new client needs no code.
 */
export interface JsonlSpec {
  glob: string
  variant: 'claude' | 'codex' | 'generic'
  generic?: {
    idFrom: 'filename' | string
    cwdPath?: string
    tsPath?: string
    /** Unit of the field `tsPath` names. Absent means milliseconds, which is what every manifest written before this field relied on. */
    tsUnit?: 'ms' | 's' | 'iso'
    rolePath?: string
    textPath?: string
    userRoles?: string[]
    assistantRoles?: string[]
  }
}

/**
 * Locates a SQLite store and the queries that project it onto Nekyia's model.
 *
 * The SQL is the adapter: aliasing columns to the field names Nekyia expects
 * is what lets a new client ship as a manifest.
 */
export interface SqliteSpec {
  file: string
  /** SQL returning session metadata, with columns aliased to manifest field names. */
  sessions: string
  /** Optional SQL returning transcript rows; ?1 is the native session id. */
  text?: string
  /**
   * Optional SQL returning a `path` column of files the session touched; ?1 is
   * the native session id.
   *
   * Clients that record this themselves are more precise than recovering paths
   * from tool inputs, and it is the only source for a store whose transcript
   * carries no tool calls at all.
   */
  files?: string
  textShape?: 'plain' | 'opencode-message-json' | 'opencode-part'
  cwdShape?: 'plain' | 'file-uri-array'
  timeUnit?: 'ms' | 's' | 'iso'
  /** Present when the client migrated from a JSON tree and did not backfill. */
  legacy?: { path: string }
}

/** Locates a directory tree holding one JSON document per session. */
export interface JsonDirSpec {
  glob: string
  variant: 'codebuff'
}

/**
 * Describes a flat prompt log kept beside the transcripts.
 *
 * Some clients record the opening prompt only here, so a session that is
 * otherwise unsearchable still gets a title.
 */
export interface SidecarSpec {
  file: string
  idField: string
  textField: string
  tsField?: string
  tsUnit?: 'ms' | 's'
  cwdField?: string
}

/**
 * Common fields shared across all manifest formats.
 */
interface ManifestCommon {
  schema: 1
  id: ClientId
  name: string
  roots: string[]
  tier: Tier
  sidecar?: SidecarSpec
  resume?: CommandSpec
  brief?: CommandSpec
}

/**
 * Describes a manifest for a client that stores its transcripts as JSONL.
 */
interface JsonlManifest extends ManifestCommon {
  format: 'jsonl-transcript'
  jsonl: JsonlSpec
  sqlite?: never
  jsonDir?: never
}

/**
 * Describes a manifest for a client that stores its transcripts in a SQLite database.
 */
interface SqliteManifest extends ManifestCommon {
  format: 'sqlite-store'
  jsonl?: never
  sqlite: SqliteSpec
  jsonDir?: never
}

/**
 * Describes a manifest for a client that stores its transcripts as JSON files in a directory.
 */
interface JsonDirManifest extends ManifestCommon {
  format: 'json-dir'
  jsonl?: never
  sqlite?: never
  jsonDir: JsonDirSpec
}

/** A validated client definition. The union keeps each format's block required and the other two impossible. */
export type Manifest = JsonlManifest | SqliteManifest | JsonDirManifest

/** Every manifest Nekyia will use this run, with what went wrong and where each one came from. */
export interface LoadedManifests {
  manifests: Manifest[]
  diagnostics: Diagnostic[]
  /** Provenance of the winning manifest after user overrides are applied. */
  sources: Map<ClientId, ManifestSource>
}

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_MANIFEST_FILES = 256
const MAX_MANIFEST_DIRECTORY_ENTRIES = 1024

/** Where a manifest was read from, so a user override can be told apart from a built-in. */
export interface ManifestSource {
  kind: 'built-in' | 'user'
  path: string
}

const TIERS: readonly Tier[] = ['resume', 'search', 'detected']

/**
 * Type guard for a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates that a value is a plain object, throwing an error otherwise.
 */
function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`)
  return value
}

/**
 * Validates that a value is a string, throwing an error otherwise.
 */
function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

/**
 * Validates that a value is a string or undefined, throwing an error otherwise.
 */
function expectOptionalString(value: unknown, field: string): string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${field} must be a string`)
  }
  return value
}

/**
 * Validates that an untrusted object correctly implements CommandSpec.
 */
function validateCommand(value: unknown, field: 'resume' | 'brief'): CommandSpec {
  const command = expectRecord(value, field)
  const cmd = expectString(command.cmd, `${field}.cmd`)
  if (!Array.isArray(command.args) || !command.args.every((arg) => typeof arg === 'string')) {
    throw new Error(`${field}.args must be an array of strings`)
  }
  const cwd = expectOptionalString(command.cwd, `${field}.cwd`)
  return { cmd, args: command.args, ...(cwd === undefined ? {} : { cwd }) }
}

/**
 * Validates that an untrusted object correctly implements SidecarSpec.
 */
function validateSidecar(value: unknown): SidecarSpec {
  const sidecar = expectRecord(value, 'sidecar')
  const file = expectString(sidecar.file, 'sidecar.file')
  const idField = expectString(sidecar.idField, 'sidecar.idField')
  const textField = expectString(sidecar.textField, 'sidecar.textField')
  const tsField = expectOptionalString(sidecar.tsField, 'sidecar.tsField')
  const cwdField = expectOptionalString(sidecar.cwdField, 'sidecar.cwdField')
  if (sidecar.tsUnit !== undefined && sidecar.tsUnit !== 'ms' && sidecar.tsUnit !== 's') {
    throw new Error('sidecar.tsUnit must be "ms" or "s"')
  }
  return {
    file,
    idField,
    textField,
    ...(tsField === undefined ? {} : { tsField }),
    ...(sidecar.tsUnit === undefined ? {} : { tsUnit: sidecar.tsUnit }),
    ...(cwdField === undefined ? {} : { cwdField }),
  }
}

/**
 * Validates that an untrusted object correctly implements JsonlSpec.
 */
function validateJsonl(value: unknown): JsonlSpec {
  const jsonl = expectRecord(value, 'jsonl')
  const glob = expectString(jsonl.glob, 'jsonl.glob')
  if (jsonl.variant !== 'claude' && jsonl.variant !== 'codex' && jsonl.variant !== 'generic') {
    throw new Error('jsonl.variant must be "claude", "codex", or "generic"')
  }

  let generic: JsonlSpec['generic']
  if (jsonl.generic !== undefined) {
    const supplied = expectRecord(jsonl.generic, 'jsonl.generic')
    const idFrom = expectString(supplied.idFrom, 'jsonl.generic.idFrom')
    const cwdPath = expectOptionalString(supplied.cwdPath, 'jsonl.generic.cwdPath')
    const tsPath = expectOptionalString(supplied.tsPath, 'jsonl.generic.tsPath')
    const rolePath = expectOptionalString(supplied.rolePath, 'jsonl.generic.rolePath')
    const textPath = expectOptionalString(supplied.textPath, 'jsonl.generic.textPath')
    if (
      supplied.tsUnit !== undefined
      && supplied.tsUnit !== 'ms'
      && supplied.tsUnit !== 's'
      && supplied.tsUnit !== 'iso'
    ) {
      throw new Error('jsonl.generic.tsUnit must be "ms", "s", or "iso"')
    }
    if (supplied.userRoles !== undefined && (
      !Array.isArray(supplied.userRoles)
      || !supplied.userRoles.every((role) => typeof role === 'string')
    )) {
      throw new Error('jsonl.generic.userRoles must be an array of strings')
    }
    if (supplied.assistantRoles !== undefined && (
      !Array.isArray(supplied.assistantRoles)
      || !supplied.assistantRoles.every((role) => typeof role === 'string')
    )) {
      throw new Error('jsonl.generic.assistantRoles must be an array of strings')
    }
    generic = {
      idFrom,
      ...(cwdPath === undefined ? {} : { cwdPath }),
      ...(tsPath === undefined ? {} : { tsPath }),
      ...(supplied.tsUnit === undefined ? {} : { tsUnit: supplied.tsUnit }),
      ...(rolePath === undefined ? {} : { rolePath }),
      ...(textPath === undefined ? {} : { textPath }),
      ...(supplied.userRoles === undefined ? {} : { userRoles: supplied.userRoles }),
      ...(supplied.assistantRoles === undefined
        ? {}
        : { assistantRoles: supplied.assistantRoles }),
    }
  }
  return { glob, variant: jsonl.variant, ...(generic === undefined ? {} : { generic }) }
}

/**
 * Validates that an untrusted object correctly implements SqliteSpec.
 */
function validateSqlite(value: unknown): SqliteSpec {
  const sqlite = expectRecord(value, 'sqlite')
  const file = expectString(sqlite.file, 'sqlite.file')
  const sessions = expectString(sqlite.sessions, 'sqlite.sessions')
  const text = expectOptionalString(sqlite.text, 'sqlite.text')
  const files = expectOptionalString(sqlite.files, 'sqlite.files')
  let legacy: SqliteSpec['legacy']
  if (sqlite.legacy !== undefined) {
    const supplied = expectRecord(sqlite.legacy, 'sqlite.legacy')
    legacy = { path: expectString(supplied.path, 'sqlite.legacy.path') }
  }
  if (
    sqlite.textShape !== undefined
    && sqlite.textShape !== 'plain'
    && sqlite.textShape !== 'opencode-message-json'
    && sqlite.textShape !== 'opencode-part'
  ) {
    throw new Error('sqlite.textShape must be "plain", "opencode-message-json", or "opencode-part"')
  }
  if (
    sqlite.cwdShape !== undefined
    && sqlite.cwdShape !== 'plain'
    && sqlite.cwdShape !== 'file-uri-array'
  ) {
    throw new Error('sqlite.cwdShape must be "plain" or "file-uri-array"')
  }
  if (
    sqlite.timeUnit !== undefined
    && sqlite.timeUnit !== 'ms'
    && sqlite.timeUnit !== 's'
    && sqlite.timeUnit !== 'iso'
  ) {
    throw new Error('sqlite.timeUnit must be "ms", "s", or "iso"')
  }
  return {
    file,
    sessions,
    ...(text === undefined ? {} : { text }),
    ...(files === undefined ? {} : { files }),
    ...(sqlite.textShape === undefined ? {} : { textShape: sqlite.textShape }),
    ...(sqlite.cwdShape === undefined ? {} : { cwdShape: sqlite.cwdShape }),
    ...(sqlite.timeUnit === undefined ? {} : { timeUnit: sqlite.timeUnit }),
    ...(legacy === undefined ? {} : { legacy }),
  }
}

/**
 * Validates that an untrusted object correctly implements JsonDirSpec.
 */
function validateJsonDir(value: unknown): JsonDirSpec {
  const jsonDir = expectRecord(value, 'jsonDir')
  const glob = expectString(jsonDir.glob, 'jsonDir.glob')
  if (jsonDir.variant !== 'codebuff') {
    throw new Error('jsonDir.variant must be "codebuff"')
  }
  return { glob, variant: jsonDir.variant }
}

/** Expands a leading `~`, and only when it means the current user's home. `~other` is left alone rather than guessed at. */
export function expandRoot(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** Substitutes `{id}`, `{cwd}` and `{prompt}` anywhere inside each argument. An unknown placeholder is left verbatim rather than blanked. */
export function renderArgs(
  args: string[],
  values: Record<string, string>,
): string[] {
  return args.map((arg) => arg.replace(/\{(\w+)\}/g, (placeholder, key: string) => (
    Object.hasOwn(values, key) ? values[key]! : placeholder
  )))
}

/**
 * Turns untrusted JSON into a Manifest, throwing on the first field that does not hold.
 *
 * Manifests are user-editable and name executables to run, so every field is
 * checked here rather than trusted at the point of use.
 */
export function validateManifest(value: unknown): Manifest {
  if (!isRecord(value) || value.schema !== 1) {
    throw new Error('unsupported manifest schema')
  }
  if (!isSafeClientId(value.id)) {
    throw new Error('manifest id must be bounded, control-safe, non-empty, and without colons')
  }
  if (typeof value.name !== 'string') throw new Error('manifest name must be a string')
  if (!Array.isArray(value.roots) || !value.roots.every((root) => typeof root === 'string')) {
    throw new Error('manifest roots must be an array of strings')
  }
  if (typeof value.format !== 'string') throw new Error('manifest format must be a string')
  if (!FORMATS.includes(value.format as FormatName)) {
    throw new Error(`unknown format: ${value.format}`)
  }
  if (typeof value.tier !== 'string') throw new Error('manifest tier must be a string')
  if (!TIERS.includes(value.tier as Tier)) throw new Error(`unknown tier: ${value.tier}`)
  const sidecar = value.sidecar === undefined ? undefined : validateSidecar(value.sidecar)
  const resume = value.resume === undefined ? undefined : validateCommand(value.resume, 'resume')
  const brief = value.brief === undefined ? undefined : validateCommand(value.brief, 'brief')
  if (value.tier === 'resume' && resume === undefined) {
    throw new Error('tier "resume" requires a resume command')
  }

  const common: ManifestCommon = {
    schema: 1,
    id: value.id,
    name: value.name,
    roots: [...value.roots],
    tier: value.tier as Tier,
    ...(sidecar === undefined ? {} : { sidecar }),
    ...(resume === undefined ? {} : { resume }),
    ...(brief === undefined ? {} : { brief }),
  }

  switch (value.format) {
    case 'jsonl-transcript':
      if (value.sqlite !== undefined) throw new Error('sqlite is invalid for jsonl-transcript')
      if (value.jsonDir !== undefined) throw new Error('jsonDir is invalid for jsonl-transcript')
      return { ...common, format: value.format, jsonl: validateJsonl(value.jsonl) }
    case 'sqlite-store':
      if (value.jsonl !== undefined) throw new Error('jsonl is invalid for sqlite-store')
      if (value.jsonDir !== undefined) throw new Error('jsonDir is invalid for sqlite-store')
      return { ...common, format: value.format, sqlite: validateSqlite(value.sqlite) }
    case 'json-dir':
      if (value.jsonl !== undefined) throw new Error('jsonl is invalid for json-dir')
      if (value.sqlite !== undefined) throw new Error('sqlite is invalid for json-dir')
      return { ...common, format: value.format, jsonDir: validateJsonDir(value.jsonDir) }
    default:
      throw new Error(`unknown format: ${value.format}`)
  }
}

/**
 * The result of scanning a directory for manifest files, with flags for boundary overflow.
 */
interface ManifestFiles {
  files: string[]
  manifestOverflow: boolean
  entryOverflow: boolean
}

/**
 * Scans a directory for manifest JSON files up to maximum permitted limits.
 */
function manifestFiles(directory: string): ManifestFiles {
  const names: string[] = []
  let manifestOverflow = false
  let entryOverflow = false
  let entries = 0
  const dir = opendirSync(directory)
  try {
    for (;;) {
      const entry = dir.readSync()
      if (!entry) break
      if (entries >= MAX_MANIFEST_DIRECTORY_ENTRIES) {
        entryOverflow = true
        break
      }
      entries++
      if (!entry.name.endsWith('.json')) continue
      if (names.length >= MAX_MANIFEST_FILES) {
        manifestOverflow = true
        break
      }
      names.push(entry.name)
    }
  } finally {
    dir.closeSync()
  }
  return {
    files: names.sort().map((name) => join(directory, name)),
    manifestOverflow,
    entryOverflow,
  }
}

/**
 * Reads and parses a manifest file from disk, returning it after full validation.
 */
function readManifest(path: string): Manifest {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
      throw new Error(`manifest must be a regular file no larger than ${MAX_MANIFEST_BYTES} bytes`)
    }
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    if (offset !== bytes.length) throw new Error('manifest changed while reading')
    return validateManifest(JSON.parse(bytes.toString('utf8')) as unknown)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Loads the built-in manifests, then lets user manifests override them by id.
 *
 * Enumeration is bounded in both file count and directory entries, so a
 * large or hostile config directory degrades to a diagnostic, not a hang.
 */
export function loadManifests(): LoadedManifests {
  const manifests = new Map<ClientId, Manifest>()
  const sources = new Map<ClientId, ManifestSource>()
  const diagnostics: Diagnostic[] = []
  const builtinDir = join(import.meta.dir, 'builtin')

  const builtinFiles = manifestFiles(builtinDir)
  for (const path of builtinFiles.files) {
    try {
      const manifest = readManifest(path)
      manifests.set(manifest.id, manifest)
      sources.set(manifest.id, { kind: 'built-in', path })
    } catch (error) {
      diagnostics.push({
        client: basename(path, '.json'),
        level: 'error',
        path,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (builtinFiles.manifestOverflow) {
    throw new Error(`built-in manifest limit ${MAX_MANIFEST_FILES} exceeded`)
  }
  if (builtinFiles.entryOverflow) {
    throw new Error(`built-in manifest directory entry limit ${MAX_MANIFEST_DIRECTORY_ENTRIES} exceeded`)
  }

  let userFiles: string[] = []
  try {
    const listed = manifestFiles(userManifestDir())
    userFiles = listed.files
    if (listed.manifestOverflow) {
      diagnostics.push({
        client: 'manifest', level: 'error', path: userManifestDir(),
        message: `user manifest limit ${MAX_MANIFEST_FILES} exceeded; at least one additional manifest omitted`,
      })
    }
    if (listed.entryOverflow) {
      diagnostics.push({
        client: 'manifest', level: 'error', path: userManifestDir(),
        message: `user manifest directory scan stopped after ${MAX_MANIFEST_DIRECTORY_ENTRIES} entries; additional entries were not inspected`,
      })
    }
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined
    if (code !== 'ENOENT') {
      diagnostics.push({
        client: 'manifest',
        level: 'error',
        path: userManifestDir(),
        message: `user manifest rejected: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  for (const path of userFiles) {
    try {
      const manifest = readManifest(path)
      manifests.set(manifest.id, manifest)
      sources.set(manifest.id, { kind: 'user', path })
      diagnostics.push({
        client: manifest.id,
        level: 'ok',
        path,
        message: 'user manifest',
      })
    } catch (error) {
      diagnostics.push({
        client: basename(path, '.json'),
        level: 'error',
        path,
        message: `user manifest rejected: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return {
    manifests: [...manifests.values()].sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics,
    sources,
  }
}
