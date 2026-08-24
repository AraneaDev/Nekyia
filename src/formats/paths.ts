const PATH_KEYS = new Set([
  'file_path',
  'filePath',
  'path',
  'notebook_path',
  'notebookPath',
  'file',
])

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
