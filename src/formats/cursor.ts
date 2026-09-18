import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Glob } from 'bun'
import type { Config } from '../config'
import type { Manifest } from '../manifests/load'
import { isSafeNativeId, makeUid, MAX_SESSION_FILES } from '../types'
import type { Diagnostic, DialogueTurn, SessionDoc, SessionRef } from '../types'
import type { FormatModule } from './jsonl-transcript'
import {
  containedRealPath, isObject, locateContained, readSmallJson, snapshotFile,
  sourceFingerprint, warning, type PathSnapshot,
} from './safe-read'

const META_BYTES = 64 * 1024
const PROMPT_HISTORY_BYTES = 1024 * 1024

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

/** Cursor wraps what you typed in a timestamp and a user_query element; the index keeps only what you typed. */
export function unwrapUserText(text: string): string {
  const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text)
  const inner = query ? query[1]! : text
  return inner.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '').trim()
}

/** Reads a transcript up to the byte cap, dropping a line the cap cut in half. */
async function readTranscript(path: string, cap: number): Promise<{ lines: string[]; truncated: boolean }> {
  const file = Bun.file(path)
  const truncated = file.size > cap
  const text = await (truncated ? file.slice(0, cap) : file).text()
  const lines = text.split('\n')
  if (truncated) lines.pop()
  return { lines: lines.filter((line) => line.trim()), truncated }
}

/**
 * Reads the agent-transcripts JSONL for a chat, indexing user and assistant
 * text and recording tool paths as file facets. Falls back to the chat's
 * prompt_history.json when the derived transcript path holds no text, so the
 * session stays findable by what was typed even when the cwd-derived folder
 * guess misses.
 */
async function hydrate(_manifest: Manifest, root: string, ref: SessionRef, config: Config): Promise<SessionDoc> {
  const prompts: string[] = []
  const prose: string[] = []
  const dialogue: DialogueTurn[] = []
  const files = new Set<string>()
  let truncated = false
  let rootReal: string
  try {
    rootReal = realpathSync(root)
  } catch {
    // The store vanished between discovery and hydration. That is the
    // caller's business to report, not this reader's to throw over.
    return { ref, prompts: [], prose: [], files: [], truncated: false, degraded: true }
  }

  const located = ref.cwd === null
    ? { kind: 'absent' as const }
    : locateContained(rootReal, transcriptPath(rootReal, ref.cwd, ref.nativeId))

  if (located.kind === 'ok') {
    const read = await readTranscript(located.path, config.maxFileBytes)
    truncated = read.truncated
    for (const line of read.lines) {
      let entry: unknown
      try { entry = JSON.parse(line) } catch { continue }
      if (!isObject(entry) || !isObject(entry.message) || !Array.isArray(entry.message.content)) continue
      const role = entry.role === 'user' ? 'user' : entry.role === 'assistant' ? 'assistant' : null
      if (role === null) continue
      const texts: string[] = []
      for (const block of entry.message.content) {
        if (!isObject(block)) continue
        if (block.type === 'text' && typeof block.text === 'string') {
          const text = role === 'user' ? unwrapUserText(block.text) : block.text.trim()
          if (text) texts.push(text)
        } else if (block.type === 'tool_use' && isObject(block.input) && typeof block.input.path === 'string') {
          // The path a tool acted on is a facet; the tool's input and output are not indexed.
          if (files.size < MAX_SESSION_FILES) files.add(block.input.path)
          // A path the set already holds was never going to grow it further,
          // so reoffering it after the cap drops nothing and must not mark
          // the session truncated on its own.
          else if (!files.has(block.input.path)) truncated = true
        }
      }
      if (!texts.length) continue
      const text = texts.join('\n')
      if (role === 'user') prompts.push(text)
      else prose.push(text)
      dialogue.push({ role, text })
    }
    if (prompts.length || prose.length) {
      return { ref, prompts, prose, dialogue, files: [...files], truncated }
    }
    // A transcript that exists but carries no text leaves the session just as
    // unsearchable as a missing one, so it takes the same fallback below.
  }

  // The folder mapping is confirmed on a handful of paths. When it misses, the
  // session stays findable by what was typed rather than dropping out.
  const metaPath = ref.sourcePaths[0]
  if (metaPath) {
    const history = locateContained(rootReal, join(dirname(metaPath), 'prompt_history.json'))
    if (history.kind === 'ok') {
      const read = await readSmallJson(history.path, PROMPT_HISTORY_BYTES)
      if (read.parseError === null && Array.isArray(read.value)) {
        for (const item of read.value) {
          if (typeof item === 'string' && item.trim()) prompts.push(item.trim())
        }
      }
    }
  }
  return { ref, prompts, prose, files: [...files], truncated }
}

/** Reads Cursor's store: one meta.json per chat under chats/<md5(cwd)>/<chatId>. */
export const cursorReader: FormatModule = { discover, hydrate }
