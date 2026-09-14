import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Finds a runnable bun on PATH.
 *
 * Node's own resolution is not usable here: the launcher has to report a
 * missing Bun as a sentence rather than as a spawn ENOENT, so the lookup
 * happens before anything is spawned. Windows has no executable bit worth
 * testing, so presence is the only check there.
 */
export function resolveBun(env = process.env, platform = process.platform) {
  const windows = platform === 'win32'
  const name = windows ? 'bun.exe' : 'bun'
  const mode = windows ? constants.F_OK : constants.X_OK
  const search = env.PATH ?? env.Path ?? ''

  for (const dir of search.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, mode)
      return candidate
    } catch {
      // Not here, or not runnable. Keep looking.
    }
  }
  return null
}
