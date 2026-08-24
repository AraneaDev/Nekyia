import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Config } from '../config'
import { discoverLegacy, hydrateLegacy } from '../formats/opencode-legacy'
import { readSidecar, type SidecarEntry } from '../formats/prompt-sidecar'
import { FORMAT_MODULES } from '../formats/registry'
import type { Manifest } from '../manifests/load'
import { expandRoot, loadManifests, renderArgs } from '../manifests/load'
import type { Diagnostic, ExecPlan, SessionDoc, SessionRef } from '../types'

export interface Adapter {
  id: string
  manifest: Manifest
  detect(): boolean
  discover(): Promise<AdapterDiscovery>
  hydrate(ref: SessionRef, cfg: Config): Promise<SessionDoc>
  /** Returns null when no plan is possible, for example a session with no cwd. */
  plan(ref: SessionRef, promptText?: string): ExecPlan | null
}

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

function cloneRef(ref: SessionRef): SessionRef {
  return { ...ref, sourcePaths: [...ref.sourcePaths] }
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

export function buildAdapter(manifest: Manifest): Adapter {
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
          local = result.refs.map((ref) => ({ ref: cloneRef(ref), primary: true }))
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
            local.push(...legacy.refs.map((ref) => ({ ref: cloneRef(ref), primary: false })))
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

      let doc: SessionDoc
      try {
        doc = manifest.sqlite?.legacy && ref.sourcePaths[0]?.endsWith('.json')
          ? await hydrateLegacy(manifest, root, ref, cfg)
          : await format.hydrate(manifest, root, ref, cfg)
      } catch {
        doc = emptyDoc(ref, false)
      }

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
        if (!spec || !ref.cwd) return null
        const values = { id: ref.nativeId, cwd: ref.cwd, prompt: promptText ?? '' }
        return {
          kind: useResume ? 'resume' : 'brief',
          cmd: spec.cmd,
          args: renderArgs(spec.args, values),
          cwd: ref.cwd,
          ...(useResume ? {} : { prompt: promptText ?? '' }),
        }
      } catch {
        return null
      }
    },
  }
}

export function buildAdapters(): { adapters: Adapter[]; diagnostics: Diagnostic[] } {
  const { manifests, diagnostics } = loadManifests()
  return { adapters: manifests.map(buildAdapter), diagnostics }
}
