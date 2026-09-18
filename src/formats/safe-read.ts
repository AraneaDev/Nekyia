import {
  constants,
  promises as fsPromises,
  realpathSync,
  type BigIntStats,
} from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Diagnostic } from '../types'

/**
 * Represents a generic JSON object structure.
 */
export type JsonObject = Record<string, unknown>

/**
 * Captures file metadata to detect changes between operations.
 */
export interface SnapshotToken {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

/**
 * Associates a file path with its metadata snapshot.
 */
export interface PathSnapshot {
  path: string
  token: SnapshotToken
}

/**
 * Type guard to check if a value is a non-null, non-array object.
 */
export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decodes a UTF-8 byte array into a string, replacing invalid sequences.
 */
export function decodeHead(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes, { stream: true })
}

/**
 * Decodes a UTF-8 byte array into a string, handling potentially truncated multi-byte characters at the start.
 */
export function decodeTail(bytes: Uint8Array): string {
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
 * Creates a snapshot token from BigInt file statistics.
 */
export function snapshotToken(stat: BigIntStats): SnapshotToken {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  }
}

/**
 * Compares two snapshot tokens to determine if they represent the exact same file state.
 */
export function sameSnapshot(left: SnapshotToken, right: SnapshotToken): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

/**
 * Performs a read operation ensuring the file hasn't changed during the read.
 */
export async function stableSnapshotRead<T>(
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
 * Reads the head and tail of a file, returning the content along with a metadata snapshot.
 */
export async function readHeadTailSnapshot(
  path: string,
  headBytes: number,
  tailBytes: number,
): Promise<{ head: string; tail: string; token: SnapshotToken }> {
  /**
   * Normalizes a number to a non-negative integer, returning 0 as a fallback for non-finite or non-positive inputs.
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
 * Opens a file for reading, avoiding symbolic links if supported.
 */
export async function openReadonly(path: string): Promise<FileHandle> {
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
 * Constructs a diagnostic warning for a specific client and path.
 */
export function warning(client: string, path: string, message: string): Diagnostic {
  return { client, level: 'warn', path, message }
}

/**
 * Checks if a target path resolves within a given root directory.
 */
export function within(root: string, path: string): boolean {
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
export type ContainedPath =
  | { kind: 'ok'; path: string }
  | { kind: 'absent' }
  | { kind: 'unsafe' }

/**
 * Checks if an error indicates a missing file or directory.
 */
export function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Safely resolves a path within a root directory, checking for its existence and boundary constraints.
 */
export function locateContained(rootReal: string, path: string): ContainedPath {
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
 * Returns the actual real path if it safely resides within the root directory, or null otherwise.
 */
export function containedRealPath(rootReal: string, path: string): string | null {
  const located = locateContained(rootReal, path)
  return located.kind === 'ok' ? located.path : null
}

/**
 * Reads and parses a small JSON file up to a specified size limit.
 */
export async function readSmallJson(path: string, cap: number): Promise<{
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
 * Generates a unique fingerprint string from a collection of file snapshots.
 */
export function sourceFingerprint(sources: PathSnapshot[]): string {
  return sources.map(({ path, token }) => (
    `${path}:${token.dev}:${token.ino}:${token.size}:${token.mtimeNs}:${token.ctimeNs}`
  )).join('|')
}

/**
 * Captures the metadata snapshot of a given file path.
 */
export async function snapshotFile(path: string): Promise<SnapshotToken> {
  const handle = await openReadonly(path)
  try {
    return snapshotToken(await handle.stat({ bigint: true }))
  } finally {
    await handle.close()
  }
}
