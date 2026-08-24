import { closeSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { SidecarSpec } from '../manifests/load'
import { userPromptText } from '../render'

const READ_CHUNK_BYTES = 64 * 1024
// Sidecars are prompt logs, so a multi-megabyte row is corrupt or unsafe to index.
const MAX_ROW_BYTES = 4 * 1024 * 1024
const NUMERIC_TIMESTAMP = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

/** What a sidecar contributes for one session: its prompts, its time span, and a working directory when it records one. */
export interface SidecarEntry {
  prompts: string[]
  firstTs: number
  lastTs: number
  cwd: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === ''
    || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function safeSidecarPath(root: string, file: string): string | null {
  if (isAbsolute(file) || file.split(/[\\/]+/).includes('..')) return null
  const lexicalRoot = resolve(root)
  const lexicalPath = resolve(lexicalRoot, file)
  if (!isWithin(lexicalRoot, lexicalPath)) return null

  try {
    const realRoot = realpathSync(lexicalRoot)
    const realPath = realpathSync(lexicalPath)
    return isWithin(realRoot, realPath) ? realPath : null
  } catch {
    return null
  }
}

function parseTimestamp(value: unknown, unit: SidecarSpec['tsUnit']): number | null {
  let parsed: number
  if (typeof value === 'number') {
    parsed = value
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || !NUMERIC_TIMESTAMP.test(trimmed)) return null
    parsed = Number(trimmed)
  } else {
    return null
  }

  if (!Number.isFinite(parsed) || parsed < 0) return null
  const timestamp = unit === 's' ? parsed * 1000 : parsed
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null
}

function decodeLine(parts: Uint8Array[]): string {
  const decoder = new TextDecoder()
  let line = ''
  for (const part of parts) line += decoder.decode(part, { stream: true })
  return line + decoder.decode()
}

function readLines(path: string, consume: (line: string) => void): boolean {
  let descriptor: number | undefined
  const buffer = new Uint8Array(READ_CHUNK_BYTES)
  let parts: Uint8Array[] = []
  let rowBytes = 0
  let oversized = false

  const append = (part: Uint8Array): void => {
    if (oversized || part.length === 0) return
    if (rowBytes + part.length > MAX_ROW_BYTES) {
      oversized = true
      parts = []
      rowBytes = 0
      return
    }
    parts.push(part.slice())
    rowBytes += part.length
  }

  const finish = (): void => {
    if (!oversized) consume(decodeLine(parts))
    parts = []
    rowBytes = 0
    oversized = false
  }

  try {
    descriptor = openSync(path, 'r')
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null)
      if (count === 0) break

      let start = 0
      while (start < count) {
        const newline = buffer.indexOf(0x0a, start)
        if (newline < 0 || newline >= count) {
          append(buffer.subarray(start, count))
          break
        }
        append(buffer.subarray(start, newline))
        finish()
        start = newline + 1
      }
    }
    if (oversized || rowBytes > 0) finish()
    return true
  } catch {
    return false
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        // The descriptor has already been handed off to the operating system.
      }
    }
  }
}

/** Reads a flat prompt log kept beside the transcripts, bounded per row so one oversized line cannot stall indexing. */
export function readSidecar(root: string, spec: SidecarSpec): Map<string, SidecarEntry> {
  const out = new Map<string, SidecarEntry>()
  const path = safeSidecarPath(root, spec.file)
  if (!path) return out

  const completed = readLines(path, (line) => {
    if (!line.trim()) return

    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(row)) return

    const rawId = row[spec.idField]
    // An entry with no session id cannot be attributed. Skipping is the honest choice.
    if (typeof rawId !== 'string') return
    const id = rawId.trim()
    if (!id) return

    const text = row[spec.textField]
    if (typeof text !== 'string' || !text.trim()) return

    const ts = spec.tsField ? parseTimestamp(row[spec.tsField], spec.tsUnit) : null

    const entry = out.get(id) ?? {
      prompts: [],
      firstTs: ts ?? Number.POSITIVE_INFINITY,
      lastTs: ts ?? 0,
      cwd: null,
    }
    // A harness wrapper is not a request, but it still happened, so its
    // timestamp and directory keep counting towards the session's bounds.
    const asked = userPromptText(text)
    if (asked) entry.prompts.push(asked)
    if (ts !== null) {
      entry.firstTs = Math.min(entry.firstTs, ts)
      entry.lastTs = Math.max(entry.lastTs, ts)
    }
    const cwd = spec.cwdField ? row[spec.cwdField] : undefined
    if (!entry.cwd && typeof cwd === 'string' && !CONTROL_CHARACTER.test(cwd)) {
      const normalized = cwd.trim()
      if (normalized) entry.cwd = normalized
    }
    out.set(id, entry)
  })

  if (!completed) return new Map()

  for (const entry of out.values()) {
    if (!Number.isFinite(entry.firstTs)) entry.firstTs = 0
  }
  return out
}
