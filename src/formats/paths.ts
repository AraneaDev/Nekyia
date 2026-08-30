import type { FileEventKind } from '../types'

const PATH_KEYS = new Set([
  'file_path',
  'filePath',
  'path',
  'notebook_path',
  'notebookPath',
  'file',
])

/**
 * How much of a custom tool call is read, and how long a recovered path may be.
 *
 * A call body is transcript content, so both bounds exist to keep one runaway
 * row from doing unbounded work. The path bound is the widest any filesystem
 * accepts; anything longer is not a path this index can be asked about.
 */
const MAX_PATCH_INPUT_CHARS = 1024 * 1024
const MAX_PATCH_PATH_CHARS = 4096

/**
 * Evidence that a call body really drives the apply_patch bridge.
 *
 * Codex writes the bridge either as a bare `apply_patch` command or as the
 * `tools.apply_patch(...)` call it wraps around a patch string.
 */
const APPLY_PATCH_CALL = /(?:^|\W)(?:tools\.)?apply_patch(?:\W|$)/u

/**
 * Where one line ends in a patch body that arrived as text of its own.
 *
 * A call the tool contract names `apply_patch` carries the patch verbatim, so a
 * backslash in it is a backslash: a Windows header must not be cut in half at
 * its own separator.
 */
const PATCH_LINE_BREAK = /\r?\n/u

/**
 * Where one line ends in a patch Codex embedded in the source it hands a tool.
 *
 * The embedded form is the one that matters in practice: measured over 97
 * rollouts, all 934 such calls spell their headers with escaped newlines and
 * none spell them with a real one. Escapes are read the way the source itself
 * reads them, so a doubled backslash is a literal backslash and only an odd run
 * of them ends the line.
 */
const SOURCE_LINE_BREAK = /\r?\n|(?<=(?:^|[^\\])(?:\\\\)*)(?:\\r)?\\n/u

/** The three patch headers that name a file, and nothing else in the grammar. */
const PATCH_FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/u

/**
 * Internal implementation for isPlausiblePath.
 */
function isPlausiblePath(value: string): boolean {
  if (value.length <= 1 || /[\r\n]/.test(value)) return false
  if (!/\s/.test(value)) return true
  if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//i.test(value)) return false
  if (/^(?:\/|\.\.?\/|~\/|[A-Za-z]:[\\/])/.test(value)) return true
  return /[/\\]/.test(value) || /\.[A-Za-z0-9]{1,16}$/.test(value)
}

/**
 * Walks an arbitrary JSON value and collects the file paths tool calls mention.
 *
 * Only recognised path-shaped keys are read, and each candidate must still
 * look like a path, so prose and URLs do not become touched files.
 */
export function collectPaths(value: unknown, out = new Set<string>()): string[] {
  /**
   * Internal implementation for walk.
   */
  function walk(item: unknown): void {
    if (Array.isArray(item)) {
      for (const child of item) walk(child)
      return
    }

    if (typeof item !== 'object' || item === null) return

    for (const [key, child] of Object.entries(item)) {
      if (PATH_KEYS.has(key) && typeof child === 'string' && isPlausiblePath(child)) {
        out.add(child)
      }
      walk(child)
    }
  }

  walk(value)
  return [...out]
}

/** A patch header's file and what the header's verb says happened to it. */
export interface PatchEntry {
  path: string
  kind: FileEventKind
}

const PATCH_VERB_KINDS: Record<string, FileEventKind> = {
  Add: 'write',
  Update: 'edit',
  Delete: 'delete',
}

/**
 * Recovers apply_patch file headers, and the verb each one carries, from a
 * Codex custom tool call.
 *
 * Modern Codex rollouts record the edit as source text rather than as
 * structured JSON arguments, so the walk above finds nothing in them. Reading
 * shell commands from that text would be ambiguous and unsafe, but apply_patch
 * has a narrow line-oriented grammar: only the Add, Update and Delete headers
 * are read, so hunks, patch contents and ordinary tool prose are ignored. The
 * verb is the one place a Codex transcript states an operation outright, so
 * reading it costs nothing beyond the parse that was already happening.
 *
 * A call the tool contract already names `apply_patch` carries a bare patch
 * body, which never spells the command; any other call has to show that it
 * invokes the bridge before its body is scanned at all, and is then read as the
 * source text it is.
 */
export function collectPatchEntries(input: string, toolName?: string): PatchEntry[] {
  if (input.length > MAX_PATCH_INPUT_CHARS) return []
  const isPatchCall = toolName === 'apply_patch'
  if (!isPatchCall && !APPLY_PATCH_CALL.test(input)) return []

  const seen = new Set<string>()
  const entries: PatchEntry[] = []
  for (const line of input.split(isPatchCall ? PATCH_LINE_BREAK : SOURCE_LINE_BREAK)) {
    const match = PATCH_FILE_HEADER.exec(line)
    const path = match?.[2]?.trim()
    if (!path || path.length > MAX_PATCH_PATH_CHARS || !isPlausiblePath(path)) continue
    const verb = match![1]!
    const key = `${verb}\0${path}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ path, kind: PATCH_VERB_KINDS[verb] ?? 'unknown' })
  }
  return entries
}

/**
 * The file names an apply_patch call touches, without their verbs.
 *
 * Kept because callers that only want names should not have to know a patch
 * has verbs at all.
 */
export function collectPatchPaths(input: string, toolName?: string): string[] {
  return [...new Set(collectPatchEntries(input, toolName).map((entry) => entry.path))]
}
