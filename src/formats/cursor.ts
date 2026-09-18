import { realpathSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { Glob } from 'bun'
import type { Config } from '../config'
import type { Manifest } from '../manifests/load'
import { isSafeNativeId, makeUid } from '../types'
import type { Diagnostic, SessionDoc, SessionRef } from '../types'
import type { FormatModule } from './jsonl-transcript'
import {
  containedRealPath, isObject, locateContained, readSmallJson, snapshotFile,
  sourceFingerprint, warning, type PathSnapshot,
} from './safe-read'

const META_BYTES = 64 * 1024

/**
 * The folder Cursor keeps a workspace's transcripts under.
 *
 * Always derived from the cwd, never the other way round: the reverse cannot
 * tell a slash from a dash that was already in a directory name.
 */
export function transcriptFolder(cwd: string): string {
  return cwd.replace(/^\/+/, '').split('/').join('-')
}

/** Where Cursor keeps a chat's readable transcript, derived from its cwd and native id. */
function transcriptPath(rootReal: string, cwd: string, nativeId: string): string {
  return join(rootReal, 'projects', transcriptFolder(cwd), 'agent-transcripts', nativeId, `${nativeId}.jsonl`)
}

/** Narrows a meta.json field to a non-negative finite millisecond timestamp, or null. */
function finiteMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Scans the chats tree for meta.json files and turns each usable one into a SessionRef. */
async function discover(manifest: Manifest, root: string): Promise<{ refs: SessionRef[]; diagnostics: Diagnostic[] }> {
  const refs: SessionRef[] = []
  const diagnostics: Diagnostic[] = []
  if (manifest.format !== 'json-dir') return { refs, diagnostics }
  let rootReal: string
  try {
    rootReal = realpathSync(root)
  } catch (error) {
    diagnostics.push(warning(manifest.id, root, `scan failed: ${error}`))
    return { refs, diagnostics }
  }

  let candidates: string[]
  try {
    candidates = [...new Glob(manifest.jsonDir.glob).scanSync({
      cwd: rootReal, absolute: true, onlyFiles: false, followSymlinks: false,
    })].sort()
  } catch (error) {
    diagnostics.push(warning(manifest.id, root, `scan failed: ${error}`))
    return { refs, diagnostics }
  }

  for (const candidate of candidates) {
    const dir = containedRealPath(rootReal, candidate)
    if (dir === null) {
      diagnostics.push(warning(manifest.id, candidate, 'skipped path outside root or through symlink'))
      continue
    }
    const located = locateContained(rootReal, resolve(dir, 'meta.json'))
    if (located.kind === 'absent') continue
    if (located.kind === 'unsafe') {
      diagnostics.push(warning(manifest.id, dir, 'unsafe meta.json'))
      continue
    }
    try {
      const meta = await readSmallJson(located.path, META_BYTES)
      // Opening Cursor and quitting leaves an empty meta.json. That is normal,
      // not damage, so it is skipped without a diagnostic.
      if (meta.token.size === 0n) continue
      if (meta.parseError !== null || !isObject(meta.value)) {
        diagnostics.push(warning(manifest.id, located.path, 'invalid meta.json'))
        continue
      }
      const value = meta.value
      if (value.hasConversation === false) continue
      const nativeId = basename(dir)
      if (!isSafeNativeId(nativeId)) {
        diagnostics.push(warning(manifest.id, dir, 'skipped: unsafe chat id'))
        continue
      }
      const cwd = typeof value.cwd === 'string' && value.cwd.startsWith('/') ? value.cwd : null
      const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : null
      const startedAt = finiteMs(value.createdAtMs) ?? 0
      const endedAt = finiteMs(value.updatedAtMs) ?? startedAt

      const sources: PathSnapshot[] = [{ path: located.path, token: meta.token }]
      if (cwd !== null) {
        const transcript = locateContained(rootReal, transcriptPath(rootReal, cwd, nativeId))
        if (transcript.kind === 'ok') {
          sources.push({ path: transcript.path, token: await snapshotFile(transcript.path) })
        }
      }

      refs.push({
        uid: makeUid(manifest.id, nativeId),
        client: manifest.id,
        nativeId,
        cwd,
        gitBranch: null,
        title,
        startedAt,
        endedAt,
        turns: null,
        parentNativeId: null,
        tier: manifest.tier,
        origin: 'manifest',
        sourcePaths: sources.map((source) => source.path),
        fingerprint: sourceFingerprint(sources),
      })
    } catch (error) {
      diagnostics.push(warning(manifest.id, dir, `skipped: ${error}`))
    }
  }
  return { refs, diagnostics }
}

/** Reads Cursor's store: one meta.json per chat under chats/<md5(cwd)>/<chatId>. */
export const cursorReader: FormatModule = {
  discover,
  /** Stub: Task 12 replaces this with a reader for the agent-transcripts JSONL tree. */
  async hydrate(_manifest: Manifest, _root: string, ref: SessionRef, _config: Config): Promise<SessionDoc> {
    return { ref, prompts: [], prose: [], files: [], truncated: false }
  },
}
