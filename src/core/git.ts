/**
 * Which of a directory's files git already has.
 *
 * The useful half of a recovery question is the negative one: a tracked file
 * has a better source than any transcript, and an untracked file has none. So
 * this exists to partition a timeline, and it fails closed. Not a repository,
 * no git on PATH, a non-zero exit or unreadable output all come back
 * `consulted: false`, because an empty tracked set that reads as "nothing is
 * tracked" would be worse than no annotation at all.
 */

/** A spawned child, narrowed to what this module reads back. Injectable so tests observe a spawn without running one. */
export interface GitIo {
  spawn(command: string[], options: { cwd: string; stdout: 'pipe'; stderr: 'ignore' }): {
    stdout: ReadableStream<Uint8Array> | null
    exited: Promise<number>
  }
}

/** The answer, with `consulted` separating "nothing is tracked" from "git never said". */
export interface TrackedFiles {
  consulted: boolean
  tracked: Set<string>
}

const NOT_CONSULTED: TrackedFiles = { consulted: false, tracked: new Set() }

const defaultIo: GitIo = {
  /**
   * Spawns a child process using Bun's native spawn API.
   */
  spawn(command, options) {
    return Bun.spawn(command, options)
  },
}

/**
 * Ask git which files in a directory it is tracking.
 * Returns a promise that resolves to a TrackedFiles object.
 * If git is not available or returns a non-zero exit code, returns consulted: false.
 * Failures are closed: throws are caught and treated as if git was not consulted.
 */
export async function trackedFiles(dir: string, io: GitIo = defaultIo): Promise<TrackedFiles> {
  try {
    const proc = io.spawn(['git', 'ls-files', '-z'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (proc.stdout === null) return NOT_CONSULTED
    const text = await new Response(proc.stdout).text()
    if (await proc.exited !== 0) return NOT_CONSULTED
    const base = dir.replace(/\/+$/u, '')
    const tracked = new Set<string>()
    for (const entry of text.split('\0')) {
      if (entry.length > 0) tracked.add(`${base}/${entry}`)
    }
    return { consulted: true, tracked }
  } catch {
    return NOT_CONSULTED
  }
}
