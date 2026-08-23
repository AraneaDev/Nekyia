import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { userManifestDir } from '../config'
import type { ClientId, Diagnostic, Tier } from '../types'

export type FormatName = 'jsonl-transcript' | 'sqlite-store' | 'json-dir'

export const FORMATS: readonly FormatName[] = [
  'jsonl-transcript',
  'sqlite-store',
  'json-dir',
]

export interface CommandSpec {
  cmd: string
  args: string[]
  cwd?: string
}

export interface JsonlSpec {
  glob: string
  variant: 'claude' | 'codex' | 'generic'
  generic?: {
    idFrom: 'filename' | string
    cwdPath?: string
    tsPath?: string
    rolePath?: string
    textPath?: string
    userRoles?: string[]
    assistantRoles?: string[]
  }
}

export interface SqliteSpec {
  file: string
  /** SQL returning session metadata, with columns aliased to manifest field names. */
  sessions: string
  /** Optional SQL returning transcript rows; ?1 is the native session id. */
  text?: string
  textShape?: 'plain' | 'opencode-message-json' | 'opencode-part'
  cwdShape?: 'plain' | 'file-uri-array'
  timeUnit?: 'ms' | 's' | 'iso'
  /** Present when the client migrated from a JSON tree and did not backfill. */
  legacy?: { path: string }
}

export interface JsonDirSpec {
  glob: string
  variant: 'codebuff'
}

export interface SidecarSpec {
  file: string
  idField: string
  textField: string
  tsField?: string
  tsUnit?: 'ms' | 's'
  cwdField?: string
}

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

interface JsonlManifest extends ManifestCommon {
  format: 'jsonl-transcript'
  jsonl: JsonlSpec
  sqlite?: never
  jsonDir?: never
}

interface SqliteManifest extends ManifestCommon {
  format: 'sqlite-store'
  jsonl?: never
  sqlite: SqliteSpec
  jsonDir?: never
}

interface JsonDirManifest extends ManifestCommon {
  format: 'json-dir'
  jsonl?: never
  sqlite?: never
  jsonDir: JsonDirSpec
}

export type Manifest = JsonlManifest | SqliteManifest | JsonDirManifest

export interface LoadedManifests {
  manifests: Manifest[]
  diagnostics: Diagnostic[]
}

const TIERS: readonly Tier[] = ['resume', 'search', 'detected']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`)
  return value
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

function expectOptionalString(value: unknown, field: string): string | undefined {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${field} must be a string`)
  }
  return value
}

function validateCommand(value: unknown, field: 'resume' | 'brief'): CommandSpec {
  const command = expectRecord(value, field)
  const cmd = expectString(command.cmd, `${field}.cmd`)
  if (!Array.isArray(command.args) || !command.args.every((arg) => typeof arg === 'string')) {
    throw new Error(`${field}.args must be an array of strings`)
  }
  const cwd = expectOptionalString(command.cwd, `${field}.cwd`)
  return { cmd, args: command.args, ...(cwd === undefined ? {} : { cwd }) }
}

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

function validateSqlite(value: unknown): SqliteSpec {
  const sqlite = expectRecord(value, 'sqlite')
  const file = expectString(sqlite.file, 'sqlite.file')
  const sessions = expectString(sqlite.sessions, 'sqlite.sessions')
  const text = expectOptionalString(sqlite.text, 'sqlite.text')
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
    ...(sqlite.textShape === undefined ? {} : { textShape: sqlite.textShape }),
    ...(sqlite.cwdShape === undefined ? {} : { cwdShape: sqlite.cwdShape }),
    ...(sqlite.timeUnit === undefined ? {} : { timeUnit: sqlite.timeUnit }),
    ...(legacy === undefined ? {} : { legacy }),
  }
}

function validateJsonDir(value: unknown): JsonDirSpec {
  const jsonDir = expectRecord(value, 'jsonDir')
  const glob = expectString(jsonDir.glob, 'jsonDir.glob')
  if (jsonDir.variant !== 'codebuff') {
    throw new Error('jsonDir.variant must be "codebuff"')
  }
  return { glob, variant: jsonDir.variant }
}

export function expandRoot(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

export function renderArgs(
  args: string[],
  values: Record<string, string>,
): string[] {
  return args.map((arg) => arg.replace(/\{(\w+)\}/g, (placeholder, key: string) => (
    Object.hasOwn(values, key) ? values[key]! : placeholder
  )))
}

export function validateManifest(value: unknown): Manifest {
  if (!isRecord(value) || value.schema !== 1) {
    throw new Error('unsupported manifest schema')
  }
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.includes(':')) {
    throw new Error('manifest id must be a non-empty string without colons')
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

function manifestFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(directory, name))
}

function readManifest(path: string): Manifest {
  return validateManifest(JSON.parse(readFileSync(path, 'utf8')) as unknown)
}

export function loadManifests(): LoadedManifests {
  const manifests = new Map<ClientId, Manifest>()
  const diagnostics: Diagnostic[] = []
  const builtinDir = join(import.meta.dir, 'builtin')

  for (const path of manifestFiles(builtinDir)) {
    try {
      const manifest = readManifest(path)
      manifests.set(manifest.id, manifest)
    } catch (error) {
      diagnostics.push({
        client: basename(path, '.json'),
        level: 'error',
        path,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  let userFiles: string[] = []
  try {
    userFiles = manifestFiles(userManifestDir())
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
  }
}
