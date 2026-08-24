import { type Config, isExcluded } from '../config'
import type { Diagnostic, SessionRef } from '../types'
import type { Adapter, AdapterDiscovery } from './adapter'
import type { IndexDb } from './db'

export interface Scan {
  refs: SessionRef[]
  changed: SessionRef[]
  missing: string[]
  diagnostics: Diagnostic[]
}

interface Discovered extends AdapterDiscovery {
  client: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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

  const refs = [...refsByUid.values()]
  const missingBeforeScan = db.getMissingUids()
  const changed = refs.filter((ref) =>
    known.get(ref.uid) !== ref.fingerprint || missingBeforeScan.has(ref.uid))
  const missing = [...known.keys()]
    .filter((uid) => {
      const separator = uid.indexOf(':')
      const client = separator > 0 ? uid.slice(0, separator) : ''
      return !refsByUid.has(uid)
        && (excludedUids.has(uid) || !protectedClients.has(client))
    })
    .sort()

  return { refs, changed, missing, diagnostics }
}
