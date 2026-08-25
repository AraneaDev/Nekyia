import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { buildAdapter, buildAdapters, type Adapter } from '../core/adapter'
import { IndexDb } from '../core/db'
import { scan } from '../core/discover'
import { hydrateAll } from '../core/hydrate'
import { indexPath, loadConfig, type Config } from '../config'
import { loadManifests } from '../manifests/load'
import type { Diagnostic, SessionRef } from '../types'

/** Controls an index refresh, including whether to discard and rebuild. */
export interface ReindexOptions {
  rebuild?: boolean
  quiet?: boolean
  yes?: boolean
  /** Test hook for the consent boundary. */
  consent?: (adapters: Adapter[], opts: { yes?: boolean }) => Promise<boolean>
  /** Test hook that avoids reading process-global manifests. */
  adapterSet?: AdapterSet
}

/** A resolved set of adapters and whatever went wrong building them. */
export interface AdapterSet {
  adapters: Adapter[]
  diagnostics: Diagnostic[]
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === ''
    || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

/** Resolves one fixture client without allowing a custom manifest to escape the fixture tree. */
export function safeOverrideRoot(base: string, clientId: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(clientId)) return null
  const lexicalBase = resolve(base)
  const candidate = resolve(lexicalBase, clientId)
  if (!contained(lexicalBase, candidate)) return null

  try {
    const realBase = realpathSync(lexicalBase)
    if (existsSync(candidate) && !contained(realBase, realpathSync(candidate))) return null
  } catch {
    return null
  }
  return candidate
}

/** Re-points every manifest root at a fixture tree. Test hook only. */
function adaptersForRun(): AdapterSet {
  const base = process.env.NEKYIA_ROOT_OVERRIDE
  if (!base) return buildAdapters()
  const { manifests, diagnostics } = loadManifests()
  const adapters: Adapter[] = []
  for (const manifest of manifests) {
    const root = safeOverrideRoot(base, manifest.id)
    if (!root) {
      diagnostics.push({
        client: manifest.id,
        level: 'error',
        path: base,
        message: 'fixture root override rejected unsafe client path',
      })
      continue
    }
    adapters.push(buildAdapter({ ...manifest, roots: [root] }))
  }
  return { adapters, diagnostics }
}

function showDiagnostics(diagnostics: Diagnostic[], quiet: boolean): void {
  if (quiet) return
  for (const diagnostic of diagnostics) {
    if (diagnostic.level === 'ok') continue
    const location = diagnostic.path ? ` (${diagnostic.path})` : ''
    console.error(`[${diagnostic.level}] ${diagnostic.client}: ${diagnostic.message}${location}`)
  }
}

function hydrationFailed(diagnostic: Diagnostic): boolean {
  return diagnostic.message === 'no adapter for client'
    || diagnostic.message.startsWith('hydrate failed:')
}

/** Indexes using caller-owned resources. Exported to keep failure semantics directly testable. */
export async function reindexWith(
  db: IndexDb,
  cfg: Config,
  adapterSet: AdapterSet,
  opts: ReindexOptions = {},
): Promise<number> {
  const quiet = opts.quiet === true
  // A rejected manifest means the adapter set is incomplete. Scanning without
  // that client would make global missing detection authoritative by accident.
  // Abort before any database mutation; warning-only diagnostics remain usable.
  if (adapterSet.diagnostics.some((diagnostic) => diagnostic.level === 'error')) {
    showDiagnostics(adapterSet.diagnostics, quiet)
    return 1
  }
  const discovered = await scan(db, cfg, adapterSet.adapters)
  const discoveryDiagnostics = [...adapterSet.diagnostics, ...discovered.diagnostics]

  // An exclusion is a retention decision, so it hard-deletes: the row, its
  // stored text and its search entries go before anything else touches the
  // database. scan keeps the two lists disjoint, so nothing is deleted here
  // and then marked below, or the reverse.
  db.deleteSessions(discovered.excluded)
  // Missing is reversible state. Rebuild never hard-deletes old rows: each
  // successfully hydrated replacement commits atomically, while a failure
  // leaves the previous fingerprint and searchable document available.
  db.markMissing(discovered.missing)
  const changed: SessionRef[] = opts.rebuild ? discovered.refs : discovered.changed

  let lastPercent = -1
  const hydrationDiagnostics = await hydrateAll(
    db,
    cfg,
    adapterSet.adapters,
    changed,
    (progress) => {
      if (quiet) return
      const percent = Math.floor((progress.done / progress.total) * 100)
      if (percent === lastPercent) return
      lastPercent = percent
      process.stderr.write(
        `\rindexing ${progress.done}/${progress.total} (${percent}%)`,
      )
    },
  )

  if (!quiet && changed.length > 0) process.stderr.write('\n')
  showDiagnostics([...discoveryDiagnostics, ...hydrationDiagnostics], quiet)
  if (!quiet) {
    console.error(
      `${discovered.refs.length} sessions, ${changed.length} updated, ${discovered.missing.length} missing`,
    )
  }
  return discoveryDiagnostics.some((diagnostic) => diagnostic.level === 'error')
    || hydrationDiagnostics.some(hydrationFailed)
    ? 1
    : 0
}

/** Refreshes fingerprints, then hydrates only the sessions that changed. */
export async function runReindex(opts: ReindexOptions = {}): Promise<number> {
  const cfg = loadConfig()
  const adapterSet = opts.adapterSet ?? adaptersForRun()
  // Manifest construction errors make the adapter set incomplete. Refuse before
  // consent and, critically, before IndexDb.open creates any first-run files.
  if (adapterSet.diagnostics.some((diagnostic) => diagnostic.level === 'error')) {
    showDiagnostics(adapterSet.diagnostics, opts.quiet === true)
    return 1
  }

  const { askConsent, indexPathIsObstructed, needsConsent, recordConsent } = await import('./firstrun')
  if (indexPathIsObstructed()) {
    if (!opts.quiet) console.error('index path exists but is not a regular file')
    return 1
  }
  if (needsConsent()) {
    // The plan defines explicit --rebuild as authorization. It still records
    // the same marker before discovery or database creation.
    const accepted = opts.rebuild === true
      ? true
      : opts.consent
        ? await opts.consent(adapterSet.adapters, { yes: opts.yes })
        : await askConsent(adapterSet.adapters, {
          yes: opts.yes,
          ...(opts.quiet ? { write: () => {} } : {}),
        })
    if (!accepted) return 1
    if (indexPathIsObstructed()) {
      if (!opts.quiet) console.error('index path exists but is not a regular file')
      return 1
    }
    try {
      recordConsent()
    } catch (error) {
      if (!opts.quiet) {
        const detail = error instanceof Error ? error.message : String(error)
        console.error(`could not record indexing consent: ${detail}`)
      }
      return 1
    }
  }

  const db = IndexDb.open(indexPath())
  try {
    return await reindexWith(db, cfg, adapterSet, opts)
  } finally {
    db.close()
  }
}
