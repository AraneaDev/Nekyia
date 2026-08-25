const PATH_KEYS = new Set([
  'file_path',
  'filePath',
  'path',
  'notebook_path',
  'notebookPath',
  'file',
])
const MAX_PATCH_INPUT_CHARS = 1024 * 1024
const MAX_PATCH_PATH_CHARS = 4096

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

/**
 * Recovers only apply_patch file headers from a Codex custom tool call.
 *
 * Modern Codex rollouts record the orchestration call as source text rather
 * than structured JSON arguments. Reading shell commands from that text would
 * be ambiguous and unsafe, but apply_patch has a narrow line-oriented grammar.
 * Both literal newlines and the escaped newlines used inside JavaScript string
 * literals are accepted; all patch contents and ordinary tool prose are ignored.
 */
export function collectPatchPaths(input: string): string[] {
  if (input.length > MAX_PATCH_INPUT_CHARS) return []
  if (!/(?:^|\W)(?:tools\.)?apply_patch(?:\W|$)/u.test(input)) return []

  const paths = new Set<string>()
  for (const line of input.split(/\r?\n|(?:\\r)?\\n/u)) {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/u.exec(line)
    const path = match?.[1]?.trim()
    if (path && path.length <= MAX_PATCH_PATH_CHARS && isPlausiblePath(path)) paths.add(path)
  }
  return [...paths]
}
