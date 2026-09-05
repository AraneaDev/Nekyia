import { createHash } from 'node:crypto'
import { type Config, isExcluded } from '../config'
import type { Manifest } from '../manifests/load'
import type { Diagnostic, SessionRef } from '../types'
import type { Adapter, AdapterDiscovery } from './adapter'
import type { IndexDb } from './db'

/** What one discovery pass learned: everything visible, what changed and so needs hydrating, what has disappeared, and what the config now excludes. */
export interface Scan {
  refs: SessionRef[]
  changed: SessionRef[]
  missing: string[]
  /**
   * Indexed uids whose source is still on disk but is now covered by an
   * exclusion. Kept apart from `missing` because the two demand opposite
   * treatment: an exclusion is an instruction to delete, not an absence.
   */
  excluded: string[]
  diagnostics: Diagnostic[]
}

/**
 * Bumped when a reader starts extracting something different from an unchanged
 * source: a new field, a different notion of a prompt, a fixed parse.
 *
 * Nothing derives this. A change in what the readers keep is a decision someone
 * made, so it is recorded by hand, the way the schema ladder is.
 */
const EXTRACTION_VERSION = 1

/**
 * What this build would extract from a client's sources, rather than what those
 * sources are.
 *
 * A source fingerprint answers "have the bytes changed", which is not the only
 * way an indexed document goes out of date: the same bytes yield something else
 * once the size cap moves, a manifest describes the store differently, or a
 * reader learns to read more. The two questions are kept apart because they
 * have different answers and different granularities.
 *
 * Deliberately narrow. `halfLifeDays` orders results and changes nothing about
 * what was read, so re-ranking stays free. `exclude` and `hiddenClients` decide
 * what is retained rather than what is extracted, and are answered elsewhere in
 * this pass.
 */
export function extractionFingerprint(manifest: Manifest, cfg: Config): string {
  return createHash('sha256').update(JSON.stringify([
    EXTRACTION_VERSION,
    cfg.maxFileBytes,
    manifest.format,
    manifest.jsonl ?? null,
    manifest.sqlite ?? null,
    manifest.jsonDir ?? null,
    manifest.sidecar ?? null,
  ])).digest('hex')
}

/**
 * Adapter discovery results enriched with the client's identifier.
 */
interface Discovered extends AdapterDiscovery {
  client: string
}

/**
 * Extracts a string error message from an unknown error object.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs the cheap discovery phase across every installed client.
 *
 * Only fingerprints change detection: sessions whose fingerprint still
 * matches are never re-read. A client that could not be fully enumerated has
 * its sessions withheld from the missing list, so a transient read failure
 * cannot delete real history. Sessions the config excludes are reported in
 * `excluded` instead, which is a deliberate deletion rather than an absence.
 */
export async function scan(db: IndexDb, cfg: Config, adapters: Adapter[]): Promise<Scan> {
  const known = db.getFingerprints()
  const diagnostics: Diagnostic[] = []
  const installed: Adapter[] = []
  const protectedClients = new Set<string>()

  for (const adapter of adapters) {
    try {
      if (adapter.detect()) {
        installed.push(adapter)
      } else {
        diagnostics.push({
          client: adapter.id,
          level: 'ok',
          path: null,
          message: 'not installed',
        })
      }
    } catch (error) {
      protectedClients.add(adapter.id)
      diagnostics.push({
        client: adapter.id,
        level: 'error',
        path: null,
        message: `detect failed: ${errorMessage(error)}`,
      })
    }
  }

  const results = await Promise.all(installed.map(async (adapter): Promise<Discovered> => {
    try {
      const result = await adapter.discover()
      return { client: adapter.id, ...result }
    } catch (error) {
      return {
        client: adapter.id,
        refs: [],
        authoritative: false,
        diagnostics: [{
          client: adapter.id,
          level: 'error',
          path: null,
          message: `discover failed: ${errorMessage(error)}`,
        }],
      }
    }
  }))

  const refsByUid = new Map<string, SessionRef>()
  const excludedUids = new Set<string>()
  for (const result of results) {
    diagnostics.push(...result.diagnostics)
    if (!result.authoritative) protectedClients.add(result.client)
    for (const ref of result.refs) {
      if (isExcluded(ref.cwd, cfg)) {
        excludedUids.add(ref.uid)
        continue
      }
      const kept = refsByUid.get(ref.uid)
      if (kept) {
        const keptSource = kept.sourcePaths.join(', ') || 'no source path'
        const droppedSource = ref.sourcePaths.join(', ') || 'no source path'
        diagnostics.push({
          client: ref.client,
          level: 'warn',
          path: kept.sourcePaths[0] ?? null,
          message: `duplicate uid ${ref.uid}; kept ${keptSource}, dropped ${droppedSource}`,
        })
        continue
      }
      refsByUid.set(ref.uid, ref)
    }
  }

  // An exclusion is an instruction about retained data, so it is answered from
  // the index as well as from this scan. A session whose source has since been
  // deleted is never rediscovered, and so was never tested against a later
  // exclusion: it fell to `missing`, which keeps its text searchable.
  //
  // A rediscovered session is judged on the directory it reports now, above,
  // because the live location is the truth and the stored one may be stale.
  // Both lists below already narrow to uids this scan did not see, so that
  // check is restated here rather than relied upon from a distance: this is
  // the statement that decides a deletion.
  for (const stored of db.storedDirectories()) {
    if (!refsByUid.has(stored.uid) && isExcluded(stored.cwd, cfg)) {
      excludedUids.add(stored.uid)
    }
  }

  const refs = [...refsByUid.values()]
  const missingBeforeScan = db.getMissingUids()
  // A client whose extraction policy moved has every one of its sessions to
  // read again, however untouched their sources are: what is indexed for them
  // is not what this build would produce now. `truncated` says as much already,
  // promising that raising the cap can recover what it dropped, and only a
  // rebuild was keeping that promise.
  const restated = new Set(installed
    .filter((adapter) => {
      // An index that has never recorded what extracted it says nothing about
      // the past, and inventing an answer either way is worse than leaving it
      // alone: claiming it is current risks a stale document, and claiming it
      // is stale re-reads every transcript on disk the first time this build
      // runs. Nothing about those sessions' policy has changed, so nothing here
      // has grounds to re-read them. The value is recorded at the end of this
      // run, and every later change to it is caught.
      const recorded = db.getExtraction(adapter.id)
      return recorded !== null && recorded !== extractionFingerprint(adapter.manifest, cfg)
    })
    .map((adapter) => adapter.id))
  const changed = refs.filter((ref) =>
    restated.has(ref.client)
    || known.get(ref.uid) !== ref.fingerprint
    || missingBeforeScan.has(ref.uid))
  const indexed = [...known.keys()]
  // Seeing a ref and rejecting it on the exclusion list is a positive
  // observation, so it holds even for a client whose scan was partial.
  const excluded = indexed
    .filter((uid) => !refsByUid.has(uid) && excludedUids.has(uid))
    .sort()
  const missing = indexed
    .filter((uid) => {
      const separator = uid.indexOf(':')
      const client = separator > 0 ? uid.slice(0, separator) : ''
      // Excluded uids are reported once, in `excluded`: the caller deletes
      // those outright, and a uid in both lists would be flagged and dropped.
      return !refsByUid.has(uid)
        && !excludedUids.has(uid)
        && !protectedClients.has(client)
    })
    .sort()

  return { refs, changed, missing, excluded, diagnostics }
}
