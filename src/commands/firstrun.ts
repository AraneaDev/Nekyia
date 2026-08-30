import Database from 'bun:sqlite'
import { Glob } from 'bun'
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
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { dataDir, indexPath } from '../config'
import type { Adapter } from '../core/adapter'
import { expandRoot, type Manifest } from '../manifests/load'

const CONSENT_FILE = 'consent-v1'
const CONSENT_CONTENT = 'nekyia-index-consent-v1\n'
const MAX_CLIENT_DISPLAY = 80
const MAX_ROOT_DISPLAY = 512
const MAX_PATH_INPUT = 4096
const MAX_ROOTS_PER_CLIENT = 64
const MAX_ANSWER_BYTES = 256

/** How much confidence a session count carries, so the consent screen never states a guess as fact. */
export type EstimateKind = 'estimated' | 'at-least' | 'unknown'

/** One client's share of the first-run plan: what would be read, and how many sessions that is likely to be. */
export interface PlanRow {
  client: string
  roots: string[]
  sessions: number | null
  estimate: EstimateKind
}

/** Injection points for the consent prompt, so the boundary can be tested without a terminal. */
export interface ConsentOptions {
  yes?: boolean
  isTTY?: () => boolean
  write?: (text: string) => void
  readLine?: () => Promise<string | null>
}

/** The result of estimating session count in a directory, tracking if counting failed. */
interface RootEstimate {
  count: number
  failed: boolean
}

/** Formats a value for display by cleaning control characters and truncating to a maximum length. */
function displayText(value: unknown, max: number): string {
  const raw = typeof value === 'string' ? value : String(value)
  const clipped = raw.length > max ? `${raw.slice(0, Math.max(0, max - 1))}…` : raw
  const clean = clipped
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`
}

/** Compares two strings lexicographically for sorting. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Returns the path to the user consent marker file. */
function consentPath(): string {
  return join(dataDir(), CONSENT_FILE)
}

/** Checks the existence and safety of the data directory. */
function dataDirectoryState(): 'safe' | 'missing' | 'unsafe' {
  try {
    const info = lstatSync(dataDir())
    return info.isDirectory() && !info.isSymbolicLink() ? 'safe' : 'unsafe'
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
      ? 'missing'
      : 'unsafe'
  }
}

/** Consent is valid only when the exact versioned marker is a regular, non-symlink file. */
export function needsConsent(): boolean {
  if (dataDirectoryState() !== 'safe') return true
  const path = consentPath()
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = fstatSync(descriptor)
    if (!info.isFile()
      || (info.mode & 0o777) !== 0o600
      || info.size !== Buffer.byteLength(CONSENT_CONTENT)) return true
    const content = Buffer.alloc(info.size)
    const bytes = readSync(descriptor, content, 0, content.length, 0)
    return bytes !== content.length || content.toString('utf8') !== CONSENT_CONTENT
  } catch {
    return true
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
    }
  }
}

/** Persist affirmative authorization atomically, without following a marker symlink. */
export function recordConsent(): void {
  const directory = dataDir()
  // mkdir's mode is filtered by umask. Use a private temporary umask for this
  // synchronous operation so a hostile umask cannot make a newly-created
  // ancestor inaccessible, and always restore the caller's setting.
  const previousUmask = process.umask(0o077)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  } finally {
    process.umask(previousUmask)
  }
  let directoryFd: number | undefined
  try {
    directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const directoryInfo = fstatSync(directoryFd)
    if (!directoryInfo.isDirectory()) throw new Error('consent directory is not a safe directory')
    fchmodSync(directoryFd, 0o700)
    fsyncSync(directoryFd)
  } finally {
    if (directoryFd !== undefined) closeSync(directoryFd)
  }

  const path = consentPath()
  const temporary = join(directory, `.${CONSENT_FILE}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    // open's mode is filtered through umask; make the final invariant exact.
    fchmodSync(descriptor, 0o600)
    writeSync(descriptor, CONSENT_CONTENT)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    if (needsConsent()) throw new Error('consent marker verification failed')
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
    }
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

/** True when an existing object would make creating/opening the index unsafe. */
export function indexPathIsObstructed(): boolean {
  const directory = dataDirectoryState()
  if (directory === 'unsafe') return true
  if (directory === 'missing') return false
  try {
    return !lstatSync(indexPath()).isFile()
  } catch (error) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
  }
}

/** Checks if a candidate path is within a specified root directory. */
function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === ''
    || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

/** Resolves and validates a root path, returning its absolute and real paths if it is a directory. */
function safeRoot(raw: unknown): { path: string; real: string } | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_INPUT) return null
  try {
    const path = resolve(expandRoot(raw))
    if (path.length > MAX_PATH_INPUT || !statSync(path).isDirectory()) return null
    return { path, real: realpathSync(path) }
  } catch {
    return null
  }
}

/** Validates a candidate path is safely contained within its root and hasn't escaped via symlinks. */
function safeCandidate(root: { path: string; real: string }, relativePath: string): string | null {
  if (typeof relativePath !== 'string' || relativePath.length > MAX_PATH_INPUT) return null
  const candidate = resolve(root.path, relativePath)
  if (!isContained(root.path, candidate)) return null
  try {
    return isContained(root.real, realpathSync(candidate)) ? candidate : null
  } catch {
    return null
  }
}

/** Counts files or directories matching a glob pattern safely within a root directory. */
function countGlob(
  root: { path: string; real: string },
  pattern: unknown,
  kind: 'file' | 'directory',
): RootEstimate {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_PATH_INPUT) {
    return { count: 0, failed: true }
  }
  try {
    let count = 0
    for (const matched of new Glob(pattern).scanSync({
      cwd: root.path,
      onlyFiles: kind === 'file',
      followSymlinks: false,
      dot: true,
    })) {
      const candidate = safeCandidate(root, matched)
      if (!candidate) continue
      const info = lstatSync(candidate)
      if ((kind === 'file' && info.isFile()) || (kind === 'directory' && info.isDirectory())) count++
    }
    return { count, failed: false }
  } catch {
    return { count: 0, failed: true }
  }
}

/** Estimates session count for an SQLite store by querying its sessions and legacy json paths. */
function sqliteEstimate(root: { path: string; real: string }, manifest: Manifest): RootEstimate {
  if (manifest.format !== 'sqlite-store') return { count: 0, failed: true }
  let count = 0
  let failed = false
  const file = safeCandidate(root, manifest.sqlite.file)
  if (file) {
    let db: Database | undefined
    try {
      const sql = manifest.sqlite.sessions.trim().replace(/;+\s*$/, '')
      if (sql.length === 0 || sql.length > 1_000_000 || sql.includes('\0')) throw new Error('unsafe SQL')
      db = new Database(file, { readonly: true, create: false })
      const row = db.query(`SELECT COUNT(*) AS count FROM (${sql}) AS nekyia_sessions`).get() as {
        count?: unknown
      } | null
      if (!row || typeof row.count !== 'number' || !Number.isSafeInteger(row.count) || row.count < 0) {
        throw new Error('invalid count')
      }
      count += row.count
    } catch {
      failed = true
    } finally {
      try { db?.close() } catch {}
    }
  }

  const legacy = manifest.sqlite.legacy?.path
  if (legacy) {
    const base = safeCandidate(root, legacy)
    if (base) {
      const legacyRoot = safeRoot(base)
      if (legacyRoot) {
        const result = countGlob(legacyRoot, 'session/*/*.json', 'file')
        count += result.count
        failed ||= result.failed
      }
    }
  }
  return { count, failed }
}

/** Estimates the session count for a root based on its manifest format. */
function estimateRoot(root: { path: string; real: string }, manifest: Manifest): RootEstimate {
  try {
    if (manifest.format === 'jsonl-transcript') {
      return countGlob(root, manifest.jsonl.glob, 'file')
    }
    if (manifest.format === 'json-dir') {
      return countGlob(root, manifest.jsonDir.glob, 'directory')
    }
    if (manifest.format === 'sqlite-store') return sqliteEstimate(root, manifest)
  } catch {
    // Malformed third-party manifest getters produce an unknown estimate.
  }
  return { count: 0, failed: true }
}

/**
 * Build a metadata-only discovery summary. This never calls Adapter.discover,
 * opens sidecars, or reads transcript contents.
 */
export async function describePlan(adapters: Adapter[]): Promise<PlanRow[]> {
  const out: PlanRow[] = []
  for (const adapter of adapters) {
    let manifest: Manifest
    let configured: unknown[]
    try {
      manifest = adapter.manifest
      configured = Array.isArray(manifest.roots)
        ? manifest.roots.slice(0, MAX_ROOTS_PER_CLIENT)
        : []
    } catch {
      continue
    }

    const roots = configured.map(safeRoot).filter((root): root is NonNullable<typeof root> => !!root)
    if (roots.length === 0) continue
    const estimates = roots.map((root) => estimateRoot(root, manifest))
    const count = estimates.reduce((sum, estimate) => sum + estimate.count, 0)
    const failures = estimates.filter((estimate) => estimate.failed).length
    let client = 'unknown'
    try { client = displayText(adapter.id, MAX_CLIENT_DISPLAY) } catch {}
    out.push({
      client,
      roots: [...new Set(roots.map((root) => displayText(root.path, MAX_ROOT_DISPLAY)))]
        .sort(compareText),
      sessions: failures === estimates.length ? null : count,
      estimate: failures === estimates.length ? 'unknown' : failures > 0 ? 'at-least' : 'estimated',
    })
  }
  return out.sort((a, b) => compareText(a.client, b.client))
}

/** Abstract interface for the readable stream providing user consent input. */
interface ConsentInput {
  destroyed: boolean
  readableEnded: boolean
  isPaused(): boolean
  pause(): unknown
  // EventEmitter-compatible surface shared by process.stdin and test streams.
  // `any` is load-bearing: listeners are called with concrete argument types
  // (a chunk is `Buffer | string`), and `unknown[]` would reject them.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  on(event: string, listener: (...args: any[]) => void): unknown
  once(event: string, listener: (...args: any[]) => void): unknown
  off(event: string, listener: (...args: any[]) => void): unknown
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Read one bounded line without closing or destroying stdin. */
export function readConsentLine(input: ConsentInput = process.stdin): Promise<string | null> {
  if (input.readableEnded || input.destroyed) return Promise.resolve(null)
  const wasPaused = input.isPaused()
  return new Promise((resolvePromise) => {
    const decoder = new StringDecoder('utf8')
    let value = ''
    let bytes = 0
    let settled = false
    /** Cleans up stream event listeners to avoid memory leaks. */
    const cleanup = () => {
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('error', onError)
      if (wasPaused) input.pause()
    }
    /** Finalizes reading by resolving the promise and cleaning up listeners. */
    const finish = (answer: string | null) => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(answer)
    }
    /** Handles incoming data chunks, searching for a newline character to complete the line read. */
    const onData = (chunk: Buffer | string) => {
      let buffer: Buffer
      if (typeof chunk === 'string') {
        const chunkBytes = Buffer.byteLength(chunk)
        // Reject before Buffer.from so an attacker-controlled string cannot
        // force a second, equally large allocation merely to answer y/N.
        if (chunkBytes > MAX_ANSWER_BYTES - bytes) return finish(null)
        buffer = Buffer.from(chunk)
      } else {
        buffer = chunk
      }
      const lf = buffer.indexOf(0x0a)
      const cr = buffer.indexOf(0x0d)
      const newline = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr)
      const content = newline < 0 ? buffer : buffer.subarray(0, newline)
      bytes += content.byteLength
      if (bytes > MAX_ANSWER_BYTES) return finish(null)
      value += decoder.write(content)
      if (newline >= 0) {
        value += decoder.end()
        finish(value)
      }
    }
    /** Handles the end of the input stream. */
    const onEnd = () => finish(value + decoder.end() || null)
    /** Handles input stream errors. */
    const onError = () => finish(null)
    input.on('data', onData)
    input.once('end', onEnd)
    input.once('error', onError)
  })
}

/** Formats a session count estimate into a human-readable label. */
function countLabel(row: PlanRow): string {
  if (row.sessions === null) return 'unknown'
  if (row.estimate === 'at-least') return `at least ${row.sessions}`
  return `about ${row.sessions}`
}

/** Shows exactly what would be inspected and waits for an explicit yes before any store is opened. */
export async function askConsent(
  adapters: Adapter[],
  opts: ConsentOptions = {},
): Promise<boolean> {
  const write = opts.write ?? ((text: string) => process.stderr.write(text))
  const plan = await describePlan(adapters)
  const known = plan.reduce((sum, row) => sum + (row.sessions ?? 0), 0)

  write('Nekyia is about to build its index for the first time.\n\n')
  write('It reads your local session transcripts, including the prompts you typed.\n')
  write('Nothing leaves this machine: indexing does not make network calls, uses no API key,\n')
  write('and sends no telemetry.\n\n')
  for (const row of plan) {
    write(`  ${row.client.padEnd(10)} ${countLabel(row).padStart(12)} sessions   ${row.roots.join(', ')}\n`)
  }
  const hasUnknown = plan.some((row) => row.sessions === null || row.estimate === 'at-least')
  write(`\n  ${known} sessions total${hasUnknown ? ' (plus unknown/partial counts)' : ''}. Expect this to take under a minute.\n\n`)
  write('To keep a directory out of the index, add a glob to the "exclude" list in\n')
  write('your config before continuing. Run "nekyia doctor" to see where that lives.\n\n')

  if (opts.yes === true) return true
  const isTTY = opts.isTTY ?? (() => process.stdin.isTTY === true)
  if (!isTTY()) {
    write('Not a terminal, so nothing was indexed. Re-run with --yes to proceed.\n')
    return false
  }
  write('Build the index now? [y/N] ')
  const answer = await (opts.readLine ?? readConsentLine)()
  const normalized = answer?.trim().toLowerCase()
  return normalized === 'y' || normalized === 'yes'
}
