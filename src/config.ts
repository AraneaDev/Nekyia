import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { Glob } from 'bun'

export interface Config {
  /** Directory glob exclusions applied at index time. */
  exclude: string[]
  /** Recency decay half-life in days. */
  halfLifeDays: number
  /** Maximum file size accepted for indexing, in bytes. */
  maxFileBytes: number
  /** Client names hidden from normal results. */
  hiddenClients: string[]
  /** Whether sniffed sessions are shown. */
  showSniffed: boolean
}

export const DEFAULT_CONFIG: Config = {
  exclude: [],
  halfLifeDays: 14,
  maxFileBytes: 25 * 1024 * 1024,
  hiddenClients: [],
  showSniffed: true,
}

export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'nekyia')
}

export function dataDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'nekyia')
}

export function indexPath(): string {
  return join(dataDir(), 'index.db')
}

export function userManifestDir(): string {
  return join(configDir(), 'clients')
}

function freshDefaults(): Config {
  return {
    ...DEFAULT_CONFIG,
    exclude: [...DEFAULT_CONFIG.exclude],
    hiddenClients: [...DEFAULT_CONFIG.hiddenClients],
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function loadConfig(): Config {
  try {
    const raw = readFileSync(join(configDir(), 'config.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const config = freshDefaults()
    if (!isPlainObject(parsed)) return config

    if (isStringArray(parsed.exclude)) config.exclude = [...parsed.exclude]
    if (isFiniteNumber(parsed.halfLifeDays)) config.halfLifeDays = parsed.halfLifeDays
    if (isFiniteNumber(parsed.maxFileBytes)) config.maxFileBytes = parsed.maxFileBytes
    if (isStringArray(parsed.hiddenClients)) config.hiddenClients = [...parsed.hiddenClients]
    if (typeof parsed.showSniffed === 'boolean') config.showSniffed = parsed.showSniffed
    return config
  } catch {
    return freshDefaults()
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
}

export function isExcluded(cwd: string | null, config: Config): boolean {
  if (!cwd) return false
  return config.exclude.some((pattern) => new Glob(pattern).match(cwd))
}
