import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Config } from '../config'
import { discoverLegacy, hydrateLegacy } from '../formats/opencode-legacy'
import { readSidecar, type SidecarEntry } from '../formats/prompt-sidecar'
import { FORMAT_MODULES } from '../formats/registry'
import type { Manifest, ManifestSource } from '../manifests/load'
import { expandRoot, loadManifests, renderArgs } from '../manifests/load'
import type { Diagnostic, ExecPlan, Origin, SessionDoc, SessionRef } from '../types'

/** One client, wired up: how to detect it, list its sessions, read one, and launch it. */
export interface Adapter {
  id: string
  manifest: Manifest
  detect(): boolean
  discover(): Promise<AdapterDiscovery>
  hydrate(ref: SessionRef, cfg: Config): Promise<SessionDoc>
  /** Returns null when no plan is possible, for example a session with no cwd. */
  plan(ref: SessionRef, promptText?: string): ExecPlan | null
}

/**
 * The outcome of listing one client's sessions.
 *
 * `authoritative` is the important field: when discovery could not see the
 * whole store, that client's sessions are protected from missing-source pruning.
 */
export interface AdapterDiscovery {
  refs: SessionRef[]
  diagnostics: Diagnostic[]
  /** False when discovery could not establish a complete view of this client's sessions. */
  authoritative: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === ''
    || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function containsPath(root: string, path: string): boolean {
  const lexicalRoot = resolve(root)
  const lexicalPath = resolve(path)
  if (!isContained(lexicalRoot, lexicalPath)) return false

  try {
    lstatSync(lexicalPath)
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
  }

  try {
    return isContained(realpathSync(lexicalRoot), realpathSync(lexicalPath))
  } catch {
    return false
  }
}

function rootForRef(roots: string[], ref: SessionRef): string | null {
  const sourcePaths = ref.sourcePaths
  if (sourcePaths.length === 0) return null
  for (const root of roots) {
    if (sourcePaths.every((path) => containsPath(root, path))) return root
  }
  return null
}

function cloneRef(ref: SessionRef, origin: Origin): SessionRef {
  return { ...ref, origin, sourcePaths: [...ref.sourcePaths] }
}

/**
 * Maps a manifest's provenance onto the origin stamped on the refs it produces.
 *
 * `sniffed` is never returned here: it belongs to sessions found without a
 * manifest, so an unknown source is reported as a built-in rather than guessed at.
 */
function originFor(source: ManifestSource | undefined): Origin {
  return source?.kind === 'user' ? 'user-manifest' : 'manifest'
}

function emptyDoc(ref: SessionRef, truncated: boolean): SessionDoc {
  return { ref, prompts: [], prose: [], files: [], truncated }
}

function enrichRef(ref: SessionRef, entry: SidecarEntry | undefined): void {
  if (!entry) return
  if (!ref.cwd) ref.cwd = entry.cwd
  if (!ref.title && entry.prompts.length) {
    ref.title = entry.prompts[0]!.split('\n', 1)[0]!.trim() || null
  }
  if (entry.firstTs) ref.startedAt = Math.min(ref.startedAt || entry.firstTs, entry.firstTs)
  if (entry.lastTs) ref.endedAt = Math.max(ref.endedAt, entry.lastTs)
}

function sidecarPath(root: string, manifest: Manifest): string | null {
  const file = manifest.sidecar?.file
  if (!file || isAbsolute(file) || file.split(/[\\/]+/).includes('..')) return null
  const path = resolve(root, file)
  return containsPath(root, path) ? path : null
}

function includeSidecarEntry(ref: SessionRef, path: string, entry: SidecarEntry): void {
  if (!ref.sourcePaths.includes(path)) ref.sourcePaths.push(path)
  const digest = createHash('sha256')
    .update(JSON.stringify([entry.prompts, entry.firstTs, entry.lastTs, entry.cwd]))
    .digest('hex')
  ref.fingerprint = JSON.stringify([ref.fingerprint, digest])
}

/**
 * Wires one manifest into a working adapter, resolving its roots and format module.
 *
 * `origin` is stamped onto every discovered ref, because the format readers know
 * only their own shape and not which manifest file asked for them.
 */
export function buildAdapter(manifest: Manifest, origin: Origin = 'manifest'): Adapter {
  const roots = manifest.roots.map(expandRoot)
  const format = FORMAT_MODULES[manifest.format]
  const clientId = manifest.id

  function sidecarFor(root: string): Map<string, SidecarEntry> {
    return manifest.sidecar ? readSidecar(root, manifest.sidecar) : new Map()
  }

  return {
    id: clientId,
    manifest,

    detect() {
      try {
        return roots.some((root) => existsSync(root))
      } catch {
        return false
      }
    },

    async discover() {
      const diagnostics: Diagnostic[] = []
      const selected = new Map<string, { ref: SessionRef; primary: boolean }>()
      let authoritative = true

      for (const root of roots) {
        try {
          if (!existsSync(root)) continue
        } catch (error) {
          authoritative = false
          diagnostics.push({
            client: clientId, level: 'error', path: root,
            message: `detect failed: ${errorMessage(error)}`,
          })
          continue
        }

        let local: Array<{ ref: SessionRef; primary: boolean }> = []
        try {
          const result = await format.discover(manifest, root)
          diagnostics.push(...result.diagnostics)
          if (result.diagnostics.some((item) => item.level !== 'ok')) authoritative = false
          local = result.refs.map((ref) => ({ ref: cloneRef(ref, origin), primary: true }))
        } catch (error) {
          authoritative = false
          diagnostics.push({
            client: clientId, level: 'error', path: root,
            message: `discover failed: ${errorMessage(error)}`,
          })
        }

        let hasLegacy = false
        try {
          hasLegacy = !!manifest.sqlite?.legacy
        } catch (error) {
          authoritative = false
          diagnostics.push({
            client: clientId, level: 'error', path: root,
            message: `legacy configuration failed: ${errorMessage(error)}`,
          })
        }
        if (hasLegacy) {
          try {
            const legacy = await discoverLegacy(manifest, root)
            diagnostics.push(...legacy.diagnostics)
            if (legacy.diagnostics.some((item) => item.level !== 'ok')) authoritative = false
            local.push(...legacy.refs.map((ref) => ({ ref: cloneRef(ref, origin), primary: false })))
          } catch (error) {
            authoritative = false
            diagnostics.push({
              client: clientId, level: 'error', path: root,
              message: `legacy discover failed: ${errorMessage(error)}`,
            })
          }
        }

        try {
          const sidecar = sidecarFor(root)
          const path = sidecarPath(root, manifest)
          for (const item of local) {
            const entry = sidecar.get(item.ref.nativeId)
            enrichRef(item.ref, entry)
            if (entry && path) includeSidecarEntry(item.ref, path, entry)
          }
        } catch (error) {
          authoritative = false
          diagnostics.push({
            client: clientId, level: 'error', path: root,
            message: `sidecar failed: ${errorMessage(error)}`,
          })
        }

        for (const item of local) {
          const current = selected.get(item.ref.uid)
          if (!current || (!current.primary && item.primary)) selected.set(item.ref.uid, item)
        }
      }

      return { refs: [...selected.values()].map((item) => item.ref), diagnostics, authoritative }
    },

    async hydrate(ref, cfg) {
      let root: string | null
      try {
        root = rootForRef(roots, ref)
      } catch {
        return emptyDoc(ref, true)
      }
      if (root === null) return emptyDoc(ref, true)

      // A reader failure must reach hydrateAll: it skips the upsert and leaves the
      // previous fingerprint in place, so the session is retried on the next scan
      // instead of being stamped as an empty document forever.
      const doc = manifest.sqlite?.legacy && ref.sourcePaths[0]?.endsWith('.json')
        ? await hydrateLegacy(manifest, root, ref, cfg)
        : await format.hydrate(manifest, root, ref, cfg)

      try {
        const entry = sidecarFor(root).get(ref.nativeId)
        if (entry) {
          const prompts = new Set(doc.prompts)
          for (const prompt of entry.prompts) {
            if (prompts.has(prompt)) continue
            prompts.add(prompt)
            doc.prompts.push(prompt)
          }
        }
      } catch {
        doc.truncated = true
      }
      return doc
    },

    plan(ref, promptText) {
      try {
        const useResume = manifest.tier === 'resume' && !!manifest.resume && !promptText
        const spec = useResume ? manifest.resume! : manifest.brief
        if (!spec) return null
        const sessionCwd = ref.cwd
        // {cwd} is left unsupplied for a session that recorded no directory, so
        // renderArgs keeps the placeholder verbatim rather than writing "null".
        const values: Record<string, string> = {
          id: ref.nativeId,
          prompt: promptText ?? '',
          ...(sessionCwd === null ? {} : { cwd: sessionCwd }),
        }
        // A spec.cwd that still asks for {cwd} after rendering never resolved, so it
        // falls back to the session's own directory and the plan is refused below.
        const rendered = spec.cwd === undefined ? null : renderArgs([spec.cwd], values)[0]!
        const cwd = rendered !== null && !rendered.includes('{cwd}') ? rendered : sessionCwd
        if (!cwd) return null
        return {
          kind: useResume ? 'resume' : 'brief',
          cmd: spec.cmd,
          args: renderArgs(spec.args, values),
          cwd,
          ...(useResume ? {} : { prompt: promptText ?? '' }),
        }
      } catch {
        return null
      }
    },
  }
}

/** Builds an adapter for every loaded manifest, carrying forward the diagnostics rather than dropping a client silently. */
export function buildAdapters(): { adapters: Adapter[]; diagnostics: Diagnostic[] } {
  const { manifests, diagnostics, sources } = loadManifests()
  const adapters = manifests.map(
    (manifest) => buildAdapter(manifest, originFor(sources.get(manifest.id))),
  )
  return { adapters, diagnostics }
}
