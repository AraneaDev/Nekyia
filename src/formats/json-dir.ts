import {
  constants,
  lstatSync,
  promises as fsPromises,
  realpathSync,
  type BigIntStats,
} from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { Glob } from 'bun'
import type { Config } from '../config'
import { isSafeNativeId, makeUid } from '../types'
import type { Diagnostic, SessionDoc, SessionRef } from '../types'
import type { FormatModule } from './jsonl-transcript'

const RUN_STATE_HEAD_BYTES = 4 * 1024
const RUN_STATE_TAIL_BYTES = 8 * 1024
const META_BYTES = 64 * 1024
const READ_CHUNK_BYTES = 64 * 1024
/** A single array element is the only unit retained in memory during hydration. */
const MAX_ELEMENT_BYTES = 16 * 1024 * 1024

/**
 * Internal implementation for JsonObject.
 */
type JsonObject = Record<string, unknown>

/**
 * Internal implementation for SnapshotToken.
 */
interface SnapshotToken {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

/**
 * Internal implementation for PathSnapshot.
 */
interface PathSnapshot {
  path: string
  token: SnapshotToken
}

/**
 * Internal implementation for isObject.
 */
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Internal implementation for decodeHead.
 */
function decodeHead(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes, { stream: true })
}

/**
 * Internal implementation for decodeTail.
 */
function decodeTail(bytes: Uint8Array): string {
  let start = 0
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1
  return new TextDecoder().decode(bytes.subarray(start))
}

/** Read byte-bounded ends of a file without touching its middle. */
export async function readHeadTail(
  path: string,
  headBytes: number,
  tailBytes: number,
): Promise<{ head: string; tail: string }> {
  const snapshot = await readHeadTailSnapshot(path, headBytes, tailBytes)
  return { head: snapshot.head, tail: snapshot.tail }
}

/**
 * Internal implementation for snapshotToken.
 */
function snapshotToken(stat: BigIntStats): SnapshotToken {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  }
}

/**
 * Internal implementation for sameSnapshot.
 */
function sameSnapshot(left: SnapshotToken, right: SnapshotToken): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

/**
 * Internal implementation for stableSnapshotRead.
 */
async function stableSnapshotRead<T>(
  path: string,
  read: (handle: FileHandle, token: SnapshotToken) => Promise<T>,
): Promise<{ value: T; token: SnapshotToken }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await openReadonly(path)
    try {
      const before = snapshotToken(await handle.stat({ bigint: true }))
      const value = await read(handle, before)
      const after = snapshotToken(await handle.stat({ bigint: true }))
      if (sameSnapshot(before, after)) return { value, token: before }
    } finally {
      await handle.close()
    }
  }
  throw new Error('file changed during bounded read')
}

/**
 * Internal implementation for readHeadTailSnapshot.
 */
async function readHeadTailSnapshot(
  path: string,
  headBytes: number,
  tailBytes: number,
): Promise<{ head: string; tail: string; token: SnapshotToken }> {
  /**
   * Internal implementation for normalized.
   */
  const normalized = (value: number): number => Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
  const requestedHead = normalized(headBytes)
  const requestedTail = normalized(tailBytes)
  const snapshot = await stableSnapshotRead(path, async (handle, token) => {
    const headLength = Number(
      token.size < BigInt(requestedHead) ? token.size : BigInt(requestedHead),
    )
    const tailLength = Number(
      token.size < BigInt(requestedTail) ? token.size : BigInt(requestedTail),
    )
    const headBuffer = Buffer.alloc(headLength)
    const tailBuffer = Buffer.alloc(tailLength)
    const headRead = headLength === 0
      ? 0
      : (await handle.read(headBuffer, 0, headLength, 0)).bytesRead
    const tailRead = tailLength === 0
      ? 0
      : (await handle.read(
        tailBuffer,
        0,
        tailLength,
        Number(token.size - BigInt(tailLength)),
      )).bytesRead
    return {
      head: decodeHead(headBuffer.subarray(0, headRead)),
      tail: decodeTail(tailBuffer.subarray(0, tailRead)),
    }
  })
  return { ...snapshot.value, token: snapshot.token }
}

/**
 * Internal implementation for openReadonly.
 */
async function openReadonly(path: string): Promise<FileHandle> {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  try {
    return await fsPromises.open(path, constants.O_RDONLY | noFollow)
  } catch (error) {
    const code = isObject(error) && typeof error.code === 'string' ? error.code : ''
    if (noFollow !== 0 && (code === 'EINVAL' || code === 'ENOTSUP')) {
      return fsPromises.open(path, constants.O_RDONLY)
    }
    throw error
  }
}

/**
 * Internal implementation for firstMatch.
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
 * Internal implementation for firstLine.
 */
function firstLine(value: string): string | null {
  const line = value.split(/\r?\n/, 1)[0]!.trim()
  if (!line) return null
  return line.length <= 200 ? line : `${line.slice(0, 197)}...`
}

/**
 * Internal implementation for parsedDirectoryTimestamp.
 */
function parsedDirectoryTimestamp(path: string): number | null {
  const parsed = Date.parse(basename(path).replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d+)Z$/,
    '$1T$2:$3:$4.$5Z',
  ))
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Internal implementation for warning.
 */
function warning(client: string, path: string, message: string): Diagnostic {
  return { client, level: 'warn', path, message }
}

/**
 * Internal implementation for within.
 */
function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Where a file inside a session directory turned out to be.
 *
 * A file that is simply not there and one reached through a symlink out of the
 * root are different answers: the first is an incomplete chat, the second is a
 * refusal the user should hear about.
 */
type ContainedPath =
  | { kind: 'ok'; path: string }
  | { kind: 'absent' }
  | { kind: 'unsafe' }

/**
 * Internal implementation for isNotFound.
 */
function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Internal implementation for locateContained.
 */
function locateContained(rootReal: string, path: string): ContainedPath {
  const lexical = resolve(path)
  if (!within(rootReal, lexical)) return { kind: 'unsafe' }

  let actual: string
  try {
    actual = realpathSync(lexical)
  } catch (error) {
    return isNotFound(error) ? { kind: 'absent' } : { kind: 'unsafe' }
  }
  if (!within(rootReal, actual) || actual !== lexical) return { kind: 'unsafe' }
  return { kind: 'ok', path: actual }
}

/**
 * Internal implementation for containedRealPath.
 */
function containedRealPath(rootReal: string, path: string): string | null {
  const located = locateContained(rootReal, path)
  return located.kind === 'ok' ? located.path : null
}

/**
 * Internal implementation for readSmallJson.
 */
async function readSmallJson(path: string, cap: number): Promise<{
  value: unknown
  token: SnapshotToken
  parseError: unknown | null
}> {
  const snapshot = await stableSnapshotRead(path, async (handle, token) => {
    if (token.size > BigInt(cap)) throw new Error(`file exceeds ${cap} byte metadata limit`)
    const size = Number(token.size)
    const buffer = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== size) throw new Error('metadata changed while reading')
    return new TextDecoder().decode(buffer)
  })
  try {
    return { value: JSON.parse(snapshot.value), token: snapshot.token, parseError: null }
  } catch (parseError) {
    return { value: null, token: snapshot.token, parseError }
  }
}

/**
 * Internal implementation for messageParts.
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
 * Internal implementation for sourceFingerprint.
 */
function sourceFingerprint(sources: PathSnapshot[]): string {
  return sources.map(({ path, token }) => (
    `${path}:${token.dev}:${token.ino}:${token.size}:${token.mtimeNs}:${token.ctimeNs}`
  )).join('|')
}

/**
 * Internal implementation for snapshotFile.
 */
async function snapshotFile(path: string): Promise<SnapshotToken> {
  const handle = await openReadonly(path)
  try {
    return snapshotToken(await handle.stat({ bigint: true }))
  } finally {
    await handle.close()
  }
}

/**
 * Internal implementation for ArrayScanResult.
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
     * Internal implementation for beginElement.
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
     * Internal implementation for append.
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
     * Internal implementation for finishElement.
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

/** Reads stores that keep one directory of JSON documents per session. */
export const jsonDir: FormatModule = {
  /**
   * Internal implementation for discover.
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
   * Internal implementation for hydrate.
   */
  async hydrate(manifest, root, ref, config: Config): Promise<SessionDoc> {
    // Every early return below is a source that could not be read at all, which
    // is a degraded read and not a size cap: no config change recovers it.
    /**
     * Internal implementation for unread.
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
    let scan: ArrayScanResult
    try {
      // Prompt output is intentionally not globally capped: preserving every user
      // prompt means the returned prompt collection may grow with the transcript.
      scan = await scanMessageArray(messages, config.maxFileBytes, (value, proseAllowed) => {
        if (!isObject(value) || (value.variant !== 'user' && value.variant !== 'ai')) return
        const parts = messageParts(value)
        if (value.variant === 'user') prompts.push(...parts)
        else if (proseAllowed) prose.push(...parts)
      })
    } catch {
      return unread()
    }

    return {
      ref: { ...ref, turns: scan.turns },
      prompts,
      prose,
      files: [],
      truncated: scan.truncated,
      degraded: scan.degraded,
    }
  },
}
