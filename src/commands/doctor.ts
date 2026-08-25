import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildAdapter, type Adapter } from '../core/adapter'
import { IndexDb } from '../core/db'
import { sniffRoots, type SniffResult } from '../core/sniff'
import { configDir, dataDir, indexPath, loadConfig, userManifestDir } from '../config'
import {
  expandRoot,
  loadManifests,
  validateManifest,
  type Manifest,
  type ManifestSource,
} from '../manifests/load'
import type { Diagnostic, Origin } from '../types'

/** Selects what doctor reports and in what shape. */
export interface DoctorOptions {
  emitManifest?: string
  json?: boolean
  sniff?: boolean
}

const MAX_TEXT = 4_096
const MAX_DIAGNOSTICS = 512
const MAX_ROOTS = 64
const MAX_CONFIG_ITEMS = 256
const MAX_SIZE_CAPPED_IDS = 200
const UNSAFE_DISPLAY = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

function safeText(value: unknown, max = MAX_TEXT): string {
  const text = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
      ? String(value)
      : 'unavailable'
  return text.slice(0, max).replace(UNSAFE_DISPLAY, '?')
}

function safeList(values: string[], max = MAX_CONFIG_ITEMS): string[] {
  return values.slice(0, max).map((value) => safeText(value))
}

function safeDiagnostic(value: Diagnostic): Diagnostic {
  return {
    client: safeText(value.client, 256),
    level: value.level,
    path: value.path === null ? null : safeText(value.path),
    message: safeText(value.message),
  }
}

function contained(root: string, candidate: string): boolean {
  const rest = relative(root, candidate)
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`))
}

function overrideManifest(manifest: Manifest, base: string | undefined): Manifest | null {
  if (!base) return manifest
  if (manifest.id.length > 256 || base.length > MAX_TEXT) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.id)) return null
  const lexicalBase = resolve(base)
  const candidate = resolve(lexicalBase, manifest.id)
  if (!contained(lexicalBase, candidate)) return null
  try {
    const realBase = realpathSync(lexicalBase)
    if (existsSync(candidate) && !contained(realBase, realpathSync(candidate))) return null
  } catch {
    return null
  }
  return { ...manifest, roots: [candidate] }
}

/**
 * Mirrors the provenance mapping `buildAdapters` applies, so a client wired up
 * here reports the same origin it would when the whole set is built at once.
 */
function originFor(source: ManifestSource | undefined): Origin {
  return source?.kind === 'user' ? 'user-manifest' : 'manifest'
}

function manifestAdapters(
  manifests: Manifest[],
  sources: Map<string, ManifestSource>,
  diagnostics: Diagnostic[],
): Map<string, Adapter> {
  const result = new Map<string, Adapter>()
  const base = process.env.NEKYIA_ROOT_OVERRIDE
  for (const manifest of manifests) {
    const selected = overrideManifest(manifest, base)
    if (!selected) {
      diagnostics.push({
        client: manifest.id,
        level: 'error',
        path: base ?? null,
        message: 'fixture root override rejected unsafe client path',
      })
      continue
    }
    try {
      result.set(manifest.id, buildAdapter(selected, originFor(sources.get(manifest.id))))
    } catch (error) {
      diagnostics.push({
        client: manifest.id,
        level: 'error',
        path: null,
        message: `adapter construction failed: ${safeText(error instanceof Error ? error.message : error)}`,
      })
    }
  }
  return result
}

function installedRoots(manifest: Manifest): string[] {
  const roots = manifest.roots
    .slice(0, MAX_ROOTS)
    .filter((root) => root.length <= MAX_TEXT)
    .map(expandRoot)
  return roots.filter((path) => {
    try {
      const stat = lstatSync(path)
      return stat.isDirectory() && !stat.isSymbolicLink()
    } catch {
      return false
    }
  })
}

interface IndexSummary {
  sessions: number
  proseTruncated: number
  missing: number
  sizeCappedSessions: string[]
  sizeCappedOverflow: boolean
}

function emptyIndexSummary(): IndexSummary {
  return {
    sessions: 0,
    proseTruncated: 0,
    missing: 0,
    sizeCappedSessions: [],
    sizeCappedOverflow: false,
  }
}

function readIndexSummary(path: string, diagnostics: Diagnostic[]): IndexSummary {
  try {
    lstatSync(path)
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined
    if (code === 'ENOENT') return emptyIndexSummary()
    diagnostics.push({
      client: 'index', level: 'error', path,
      message: `could not inspect index: ${safeText(error instanceof Error ? error.message : error)}`,
    })
    return emptyIndexSummary()
  }
  let db: IndexDb | null = null
  try {
    db = IndexDb.openReadonly(path)
    const row = db.raw().query(
      'SELECT COUNT(*) n, COALESCE(SUM(truncated), 0) t, COALESCE(SUM(missing), 0) m FROM session',
    ).get() as { n: number; t: number; m: number }
    const capped = db.raw().query(
      'SELECT uid FROM session WHERE truncated = 1 ORDER BY uid LIMIT ?',
    ).all(MAX_SIZE_CAPPED_IDS + 1) as Array<{ uid: string }>
    return {
      sessions: Number(row.n) || 0,
      proseTruncated: Number(row.t) || 0,
      missing: Number(row.m) || 0,
      sizeCappedSessions: capped.slice(0, MAX_SIZE_CAPPED_IDS).map((item) => safeText(item.uid, 512)),
      sizeCappedOverflow: capped.length > MAX_SIZE_CAPPED_IDS,
    }
  } catch (error) {
    diagnostics.push({
      client: 'index', level: 'error', path,
      message: `could not inspect index: ${safeText(error instanceof Error ? error.message : error)}`,
    })
    return emptyIndexSummary()
  } finally {
    try { db?.close() } catch { /* best effort on a corrupt index */ }
  }
}

function publicSniff(result: SniffResult) {
  return {
    path: safeText(result.path),
    kind: result.kind,
    confidence: result.confidence,
    // Sniffer samples are intentionally omitted: even future sniffers cannot
    // accidentally turn doctor JSON into a transcript-content export.
  }
}

function writeManifestExclusive(path: string, draft: Manifest): void {
  if (path.length === 0 || path.length > MAX_TEXT || /[\u0000]/.test(path)) {
    throw new Error('output path is invalid or too long')
  }
  const target = resolve(path)
  const parent = dirname(target)
  const parentStat = lstatSync(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || realpathSync(parent) !== parent) {
    throw new Error('output parent is not a safe directory')
  }

  // Validate before opening anything, and use exclusive creation so existing
  // regular files, symlinks, and racing replacements are never overwritten.
  validateManifest(draft)
  const temporary = resolve(parent, `.${dirname(target) === parent ? target.slice(parent.length + 1) : 'manifest'}.${process.pid}.${randomUUID()}.tmp`)
  let fd: number | null = null
  let published = false
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    fchmodSync(fd, 0o600)
    const bytes = Buffer.from(`${JSON.stringify(draft, null, 2)}\n`)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written <= 0) throw new Error('output write made no progress')
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    // link(2) is an atomic, non-overwriting publication: unlike rename it
    // fails if any object (including a symlink) already occupies target.
    linkSync(temporary, target)
    published = true
    unlinkSync(temporary)
    const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd) } catch {}
    }
    try { unlinkSync(temporary) } catch {}
    if (published) {
      try { unlinkSync(target) } catch {}
    }
    throw error
  }
}

/**
 * Reports what Nekyia can see: clients, roots, parse failures, caps, and stores it cannot read.
 *
 * Every value is bounded and stripped of control characters before printing,
 * because it comes from transcripts Nekyia does not control.
 */
export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  if (opts.emitManifest && opts.json) {
    console.error('error: --json cannot be combined with --emit-manifest')
    return 2
  }
  if (opts.emitManifest && !opts.sniff) {
    console.error('error: --emit-manifest requires --sniff')
    return 2
  }

  const cfg = loadConfig()
  const loaded = loadManifests()
  const diagnostics: Diagnostic[] = [...loaded.diagnostics]
  const adapters = manifestAdapters(loaded.manifests, loaded.sources, diagnostics)
  const clients: Array<Record<string, unknown>> = []

  for (const manifest of loaded.manifests) {
    const adapter = adapters.get(manifest.id)
    const roots = adapter ? installedRoots(adapter.manifest) : []
    let sessions = 0
    let authoritative: boolean | null = roots.length ? false : null
    if (adapter && roots.length) {
      try {
        const discovered = await adapter.discover()
        sessions = discovered.refs.length
        authoritative = discovered.authoritative
        diagnostics.push(...discovered.diagnostics)
      } catch (error) {
        diagnostics.push({
          client: manifest.id, level: 'error', path: null,
          message: `discover failed: ${safeText(error instanceof Error ? error.message : error)}`,
        })
      }
    }
    const source = loaded.sources.get(manifest.id)
    clients.push({
      client: safeText(manifest.id, 256),
      name: safeText(manifest.name, 512),
      source: source?.kind ?? 'unknown',
      sourcePath: source ? safeText(source.path) : null,
      installed: roots.length > 0,
      roots: safeList(roots, MAX_ROOTS),
      sessions,
      authoritative,
      tier: manifest.tier,
      canResume: !!manifest.resume,
    })
  }

  const index = readIndexSummary(indexPath(), diagnostics)
  const sniffed = opts.sniff ? sniffRoots() : []
  const report = {
    paths: {
      config: safeText(configDir()),
      userManifests: safeText(userManifestDir()),
      data: safeText(dataDir()),
      index: safeText(indexPath()),
    },
    rootOverride: process.env.NEKYIA_ROOT_OVERRIDE
      ? safeText(process.env.NEKYIA_ROOT_OVERRIDE)
      : null,
    config: {
      exclude: safeList(cfg.exclude),
      halfLifeDays: cfg.halfLifeDays,
      hiddenClients: safeList(cfg.hiddenClients),
    },
    clients,
    index,
    diagnostics: diagnostics
      .filter((item) => item.level !== 'ok')
      .slice(0, MAX_DIAGNOSTICS)
      .map(safeDiagnostic),
    diagnosticsOverflow: diagnostics.filter((item) => item.level !== 'ok').length > MAX_DIAGNOSTICS,
    sniffed: sniffed.map(publicSniff),
  }

  if (opts.emitManifest) {
    const first = sniffed[0]
    if (!first) {
      console.error('nothing to emit: run "nekyia doctor --sniff" and check what was found')
      return 1
    }
    const draft = validateManifest({
      ...first.suggested,
      schema: 1,
      id: 'CHANGE_ME',
      name: 'CHANGE ME',
      roots: [dirname(first.path)],
    })
    try {
      writeManifestExclusive(opts.emitManifest, draft)
    } catch (error) {
      console.error(`could not write draft manifest: ${safeText(error instanceof Error ? error.message : error)}`)
      return 1
    }
    console.error(`draft manifest written to ${safeText(resolve(opts.emitManifest))}`)
    console.error('Set id and name, then test it before claiming the resume tier.')
    return 0
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
    return 0
  }

  console.log('paths')
  console.log(`  config         ${report.paths.config}`)
  console.log(`  user manifests ${report.paths.userManifests}`)
  console.log(`  index          ${report.paths.index}`)
  if (report.rootOverride) {
    console.log('')
    console.log(`  NEKYIA_ROOT_OVERRIDE is set to ${report.rootOverride}`)
    console.log('  That is a test hook. Real history is NOT being read.')
  }
  console.log('')
  console.log('clients')
  for (const client of report.clients) {
    const status = client.installed ? `${String(client.sessions).padStart(5)} sessions` : '    not installed'
    const authority = client.installed && client.authoritative === false ? '  [partial]' : ''
    console.log(`  ${String(client.client).padEnd(10)} ${status}  (${client.source})${authority}`)
  }
  console.log('')
  console.log('index')
  console.log(`  ${index.sessions} sessions, ${index.proseTruncated} size-capped, ${index.missing} missing from disk`)
  for (const uid of index.sizeCappedSessions) console.log(`  size-capped: ${uid}`)
  if (index.sizeCappedOverflow) console.log('  additional size-capped sessions omitted')
  if (report.diagnostics.length) {
    console.log('')
    console.log('problems')
    for (const item of report.diagnostics) {
      console.log(`  [${item.level}] ${item.client}: ${item.message}${item.path ? ` (${item.path})` : ''}`)
    }
    if (report.diagnosticsOverflow) console.log('  additional diagnostics omitted')
  }
  if (report.sniffed.length) {
    console.log('')
    console.log('stores found with no manifest (guesses, not supported clients)')
    for (const item of report.sniffed) console.log(`  ${item.kind}  ${item.path}`)
    console.log('  Write a manifest with: nekyia doctor --sniff --emit-manifest <file>')
  }
  return 0
}
