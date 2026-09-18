import {
  lstatSync,
  realpathSync,
} from 'node:fs'
import { basename, resolve } from 'node:path'
import { Glob } from 'bun'
import type { Config } from '../config'
import { isSafeNativeId, makeUid } from '../types'
import type { DialogueTurn, Diagnostic, SessionDoc, SessionRef } from '../types'
import type { FormatModule } from './jsonl-transcript'
import {
  containedRealPath, isObject, locateContained, openReadonly, readHeadTailSnapshot,
  readSmallJson, snapshotFile, sourceFingerprint, warning,
  type JsonObject, type PathSnapshot,
} from './safe-read'

const RUN_STATE_HEAD_BYTES = 4 * 1024
const RUN_STATE_TAIL_BYTES = 8 * 1024
const META_BYTES = 64 * 1024
const READ_CHUNK_BYTES = 64 * 1024
/** A single array element is the only unit retained in memory during hydration. */
const MAX_ELEMENT_BYTES = 16 * 1024 * 1024

/**
 * Extracts the first string value associated with a given JSON key using regex.
 */
function firstMatch(text: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`))
  if (!match) return null
  try {
    const value: unknown = JSON.parse(`"${match[1]}"`)
    return typeof value === 'string' ? value.trim() || null : null
  } catch {
    return null
  }
}

/**
 * Extracts the first non-empty line from a string, truncating if necessary.
 */
function firstLine(value: string): string | null {
  const line = value.split(/\r?\n/, 1)[0]!.trim()
  if (!line) return null
  return line.length <= 200 ? line : `${line.slice(0, 197)}...`
}

/**
 * Parses a specific timestamp format from a directory name into a Unix timestamp.
 */
function parsedDirectoryTimestamp(path: string): number | null {
  const parsed = Date.parse(basename(path).replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d+)Z$/,
    '$1T$2:$3:$4.$5Z',
  ))
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Extracts non-empty text content blocks from a message object.
 */
function messageParts(message: JsonObject): string[] {
  const parts: string[] = []
  if (typeof message.content === 'string' && message.content.trim()) {
    parts.push(message.content.trim())
  }
  if (Array.isArray(message.blocks)) {
    for (const block of message.blocks) {
      if (isObject(block) && block.type === 'text'
        && typeof block.content === 'string' && block.content.trim()) {
        parts.push(block.content.trim())
      }
    }
  }
  return parts
}

/**
 * Represents the outcome of scanning a JSON array file.
 */
interface ArrayScanResult {
  turns: number
  /** A size cap dropped content: the whole file, or one element too large to hold. */
  truncated: boolean
  /** The array itself did not parse, so content was lost to a malformed source rather than to a cap. */
  degraded: boolean
}

/**
 * Iterate one top-level JSON array element at a time from a single descriptor.
 * Memory is bounded to one 16 MiB element. Larger elements are structurally
 * skipped and reported as truncation; later prompts remain recoverable.
 */
async function scanMessageArray(
  path: string,
  configCap: number,
  onMessage: (value: unknown, proseAllowed: boolean) => void,
): Promise<ArrayScanResult> {
  const handle = await openReadonly(path)
  let turns = 0
  let truncated = false
  let degraded = false
  try {
    const stat = await handle.stat()
    const cap = Number.isFinite(configCap) && configCap >= 0 ? configCap : 0
    const proseAllowed = stat.size <= cap
    if (!proseAllowed) truncated = true
    const initialSize = stat.size

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    let offset = 0
    let state: string = 'before-array'
    let allowEnd = true
    let active = false
    let depth = 0
    let inString = false
    let escaped = false
    let primitive = false
    let topString = false
    let elementBytes = 0
    let elementOversized = false
    let decoder: TextDecoder | null = null
    let decoded: string[] = []

    /**
     * Initializes the parser state for reading a new top-level JSON array element.
     */
    const beginElement = (byte: number): void => {
      active = true
      depth = byte === 0x7b || byte === 0x5b ? 1 : 0
      inString = byte === 0x22
      topString = inString
      primitive = depth === 0 && !inString
      escaped = false
      elementBytes = 0
      elementOversized = false
      decoder = new TextDecoder()
      decoded = []
    }

    /**
     * Appends decoded bytes to the current element being parsed.
     */
    const append = (bytes: Uint8Array): void => {
      if (bytes.length === 0) return
      elementBytes += bytes.length
      if (elementBytes > MAX_ELEMENT_BYTES) {
        elementOversized = true
        decoder = null
        decoded = []
        return
      }
      if (decoder !== null) decoded.push(decoder.decode(bytes, { stream: true }))
    }

    /**
     * Finalizes parsing of the current element and invokes the callback.
     */
    const finishElement = (): void => {
      if (elementOversized || decoder === null) {
        turns += 1
        truncated = true
      } else {
        try {
          decoded.push(decoder.decode())
          const value: unknown = JSON.parse(decoded.join(''))
          turns += 1
          onMessage(value, proseAllowed)
        } catch {
          // One malformed element is a corrupt transcript, not a cap.
          degraded = true
        }
      }
      active = false
      decoder = null
      decoded = []
      state = 'comma-or-end'
    }

    while (offset < initialSize) {
      const requested = Math.min(buffer.length, initialSize - offset)
      const { bytesRead } = await handle.read(buffer, 0, requested, offset)
      if (bytesRead === 0) break
      let segmentStart = active ? 0 : -1
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = buffer[index]!
        if (!active) {
          const whitespace = byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
          if (state === 'before-array') {
            if (whitespace) continue
            if (byte === 0x5b) {
              state = 'value-or-end'
              allowEnd = true
            } else {
              degraded = true
              state = 'done'
            }
            continue
          }
          if (state === 'value-or-end') {
            if (whitespace) continue
            if (byte === 0x5d && allowEnd) {
              state = 'done'
              continue
            }
            if (byte === 0x5d) {
              degraded = true
              state = 'done'
              continue
            }
            beginElement(byte)
            segmentStart = index
            continue
          } else if (state === 'comma-or-end') {
            if (whitespace) continue
            if (byte === 0x2c) {
              state = 'value-or-end'
              allowEnd = false
            } else if (byte === 0x5d) {
              state = 'done'
            } else {
              degraded = true
              state = 'done'
            }
            continue
          } else {
            if (!whitespace) degraded = true
            continue
          }
        }

        if (inString) {
          if (escaped) escaped = false
          else if (byte === 0x5c) escaped = true
          else if (byte === 0x22) {
            inString = false
            if (topString) {
              append(buffer.subarray(segmentStart, index + 1))
              finishElement()
              segmentStart = -1
            }
          }
          continue
        }

        if (depth > 0) {
          if (byte === 0x22) inString = true
          else if (byte === 0x7b || byte === 0x5b) depth += 1
          else if (byte === 0x7d || byte === 0x5d) {
            depth -= 1
            if (depth === 0) {
              append(buffer.subarray(segmentStart, index + 1))
              finishElement()
              segmentStart = -1
            }
          }
          continue
        }

        if (primitive && (byte === 0x2c || byte === 0x5d
          || byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d)) {
          append(buffer.subarray(segmentStart, index))
          finishElement()
          segmentStart = -1
          if (byte === 0x2c) {
            state = 'value-or-end'
            allowEnd = false
          } else if (byte === 0x5d) state = 'done'
          continue
        }
      }
      if (active && segmentStart >= 0) append(buffer.subarray(segmentStart, bytesRead))
      offset += bytesRead
    }

    if (active && primitive) finishElement()
    // An array that never closed inside the snapshot is an incomplete document:
    // a file still being written, or a truncated one. Either way no cap caused it.
    if (active || state !== 'done') degraded = true
    return { turns, truncated, degraded }
  } finally {
    await handle.close()
  }
}

/** Reads Codebuff's store, which Freebuff shares: projects/<name>/chats/<chatId>. */
export const codebuffReader: FormatModule = {
  /**
   * Scans the root directory to locate and extract metadata for session chats.
   */
  async discover(manifest, root) {
    const refs: SessionRef[] = []
    const diagnostics: Diagnostic[] = []
    const metadataQuality = new Map<string, number>()
    const spec = manifest.jsonDir!
    let rootReal: string
    try {
      rootReal = realpathSync(root)
    } catch (error) {
      diagnostics.push(warning(manifest.id, root, `scan failed: ${error}`))
      return { refs, diagnostics }
    }

    let candidates: string[]
    try {
      candidates = [...new Glob(spec.glob).scanSync({
        cwd: rootReal,
        absolute: true,
        onlyFiles: false,
        followSymlinks: false,
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

      const messagesCandidate = resolve(dir, 'chat-messages.json')
      const locatedMessages = locateContained(rootReal, messagesCandidate)
      // A chat with no messages file was abandoned before anything was written.
      // There is nothing to index and nothing to report.
      if (locatedMessages.kind === 'absent') continue
      const messages = locatedMessages.kind === 'ok' ? locatedMessages.path : null
      if (messages === null) {
        diagnostics.push(warning(manifest.id, messagesCandidate, 'unsafe chat-messages.json'))
        continue
      }

      try {
        if (!lstatSync(messages).isFile()) throw new Error('chat-messages.json is not a file')
        const messagesToken = await snapshotFile(messages)
        let cwd: string | null = null
        let nativeId: string | null = null
        let runStateSnapshot: PathSnapshot | null = null
        const runStateCandidate = resolve(dir, 'run-state.json')
        const locatedRunState = locateContained(rootReal, runStateCandidate)
        // Run state carries the working directory and native id. Its absence
        // costs those facets but not the session, exactly as a missing
        // chat-meta.json does, so it is not reported either.
        const runState = locatedRunState.kind === 'ok' ? locatedRunState.path : null
        if (locatedRunState.kind === 'unsafe') {
          diagnostics.push(warning(manifest.id, runStateCandidate, 'unsafe run-state.json'))
        }
        if (runState !== null) {
          try {
            const { head, tail, token } = await readHeadTailSnapshot(
              runState,
              RUN_STATE_HEAD_BYTES,
              RUN_STATE_TAIL_BYTES,
            )
            runStateSnapshot = { path: runState, token }
            cwd = firstMatch(head, 'projectRoot') ?? firstMatch(head, 'cwd')
            nativeId = firstMatch(tail, 'traceSessionId')
            if (cwd === null && nativeId === null) {
              diagnostics.push(warning(
                manifest.id,
                runState,
                'run-state.json has no bounded session metadata',
              ))
            }
          } catch (error) {
            diagnostics.push(warning(manifest.id, runState, `invalid run-state.json: ${error}`))
          }
        }

        const hasExtractedId = nativeId !== null
        nativeId = nativeId?.trim() || basename(dir).trim()
        if (!nativeId) {
          diagnostics.push(warning(manifest.id, dir, 'skipped: no usable session id'))
          continue
        }
        // Whether it was extracted from run-state.json or taken from the
        // directory name, the id is content Nekyia did not choose. One that
        // cannot round-trip through a uid would index a session `forget` then
        // refuses to remove, so it is dropped and reported instead. The id
        // itself is never echoed: it is the untrusted value.
        if (!isSafeNativeId(nativeId)) {
          diagnostics.push(warning(
            manifest.id,
            dir,
            'skipped: session id is over-long or carries control or bidi characters',
          ))
          continue
        }

        let title: string | null = null
        let turns: number | null = null
        let metaSnapshot: PathSnapshot | null = null
        const metaCandidate = resolve(dir, 'chat-meta.json')
        const meta = containedRealPath(rootReal, metaCandidate)
        if (meta !== null) {
          try {
            const result = await readSmallJson(meta, META_BYTES)
            metaSnapshot = { path: meta, token: result.token }
            if (result.parseError !== null) throw result.parseError
            if (!isObject(result.value)) throw new Error('metadata must be an object')
            title = typeof result.value.firstPrompt === 'string'
              ? firstLine(result.value.firstPrompt)
              : null
            turns = typeof result.value.messageCount === 'number'
              && Number.isInteger(result.value.messageCount) && result.value.messageCount >= 0
              ? result.value.messageCount
              : null
          } catch (error) {
            diagnostics.push(warning(manifest.id, meta, `invalid chat-meta.json: ${error}`))
          }
        }

        const fallbackTime = Number(messagesToken.mtimeNs / 1_000_000n)
        const sources: PathSnapshot[] = [{ path: messages, token: messagesToken }]
        if (runStateSnapshot !== null) sources.push(runStateSnapshot)
        if (metaSnapshot !== null) sources.push(metaSnapshot)
        const sourcePaths = sources.map((source) => source.path)
        metadataQuality.set(
          messages,
          Number(hasExtractedId) + Number(cwd !== null) + Number(title !== null)
            + Number(turns !== null),
        )
        refs.push({
          uid: makeUid(manifest.id, nativeId),
          client: manifest.id,
          nativeId,
          cwd,
          gitBranch: null,
          title,
          startedAt: parsedDirectoryTimestamp(dir) ?? fallbackTime,
          endedAt: fallbackTime,
          turns,
          parentNativeId: null,
          tier: manifest.tier,
          origin: 'manifest',
          sourcePaths,
          fingerprint: sourceFingerprint(sources),
        })
      } catch (error) {
        diagnostics.push(warning(manifest.id, dir, `skipped: ${error}`))
      }
    }

    // Usable extracted metadata wins over merely present files; ties choose the
    // latest directory timestamp, then its lexical message path for stability.
    const byUid = new Map<string, SessionRef>()
    for (const candidate of refs) {
      const existing = byUid.get(candidate.uid)
      if (!existing) {
        byUid.set(candidate.uid, candidate)
        continue
      }
      const candidateQuality = metadataQuality.get(candidate.sourcePaths[0]!) ?? 0
      const existingQuality = metadataQuality.get(existing.sourcePaths[0]!) ?? 0
      const candidateWins = candidateQuality > existingQuality
        || (candidateQuality === existingQuality
          && (candidate.startedAt > existing.startedAt
            || (candidate.startedAt === existing.startedAt
              && candidate.sourcePaths[0]!.localeCompare(existing.sourcePaths[0]!) > 0)))
      if (candidateWins) byUid.set(candidate.uid, candidate)
      diagnostics.push(warning(
        manifest.id,
        candidate.sourcePaths[0]!,
        `duplicate session id ${candidate.nativeId}; kept ${
          (candidateWins ? candidate : existing).sourcePaths[0]}`,
      ))
    }
    const uniqueRefs = [...byUid.values()].sort(
      (a, b) => a.startedAt - b.startedAt || a.nativeId.localeCompare(b.nativeId),
    )
    return { refs: uniqueRefs, diagnostics }
  },

  /**
   * Reads and parses a session's messages, applying size caps and error handling.
   */
  async hydrate(manifest, root, ref, config: Config): Promise<SessionDoc> {
    // Every early return below is a source that could not be read at all, which
    // is a degraded read and not a size cap: no config change recovers it.
    /**
     * Returns a degraded, unread session document structure for error cases.
     */
    const unread = (): SessionDoc => ({
      ref,
      prompts: [],
      prose: [],
      files: [],
      truncated: false,
      degraded: true,
    })
    let rootReal: string
    try {
      rootReal = realpathSync(root)
    } catch {
      return unread()
    }
    const path = ref.sourcePaths[0]
    if (!path) return unread()
    const messages = containedRealPath(rootReal, path)
    if (messages === null || basename(messages) !== 'chat-messages.json') return unread()

    const prompts: string[] = []
    const prose: string[] = []
    // Recorded beside the grouped facets, never instead of them: the facets are
    // what full-text search ranks, and this is the order they were said in.
    // A turn is kept exactly when its text is, so the two never disagree.
    const dialogue: DialogueTurn[] = []
    let scan: ArrayScanResult
    try {
      // Prompt output is intentionally not globally capped: preserving every user
      // prompt means the returned prompt collection may grow with the transcript.
      scan = await scanMessageArray(messages, config.maxFileBytes, (value, proseAllowed) => {
        if (!isObject(value) || (value.variant !== 'user' && value.variant !== 'ai')) return
        const parts = messageParts(value)
        if (value.variant === 'user') {
          prompts.push(...parts)
          for (const part of parts) dialogue.push({ role: 'user', text: part })
        } else if (proseAllowed) {
          prose.push(...parts)
          for (const part of parts) dialogue.push({ role: 'assistant', text: part })
        }
      })
    } catch {
      return unread()
    }

    return {
      ref: { ...ref, turns: scan.turns },
      prompts,
      prose,
      dialogue,
      files: [],
      truncated: scan.truncated,
      degraded: scan.degraded,
    }
  },
}
