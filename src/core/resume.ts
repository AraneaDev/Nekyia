import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { ExecPlan } from '../types'

/** Whether a plan can be launched, and if not, the reason to show the user. */
export interface RunResult {
  ok: boolean
  reason?: string
  exitCode?: number
}

/**
 * Internal implementation for SpawnOptions.
 */
interface SpawnOptions {
  cwd: string
  stdin: 'inherit'
  stdout: 'inherit'
  stderr: 'inherit'
}

/**
 * A spawned child. `kill` is optional because test doubles stand in for a real
 * subprocess and only have to supply what the caller reads back.
 */
interface SpawnedProcess {
  exited: Promise<number>
  kill?(signal?: number | NodeJS.Signals): void
}

/** The process launcher, injectable so tests can observe a spawn without running one. */
export interface RunIo {
  spawn(command: string[], options: SpawnOptions): SpawnedProcess
}

/**
 * Internal implementation for executableAt.
 */
function executableAt(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Internal implementation for resolveCommand.
 */
function resolveCommand(command: string, cwd: string): string | undefined {
  if (command.includes('/')) {
    const path = isAbsolute(command) ? command : resolve(cwd, command)
    return executableAt(path) ? path : undefined
  }
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const directory = isAbsolute(entry) ? entry : resolve(cwd, entry || '.')
    const path = join(directory, command)
    if (executableAt(path)) return path
  }
  return undefined
}

/** Checks a plan is launchable before any teardown happens, so a failure is reported into a live terminal rather than a torn-down one. */
export function checkPlan(plan: ExecPlan): RunResult {
  if (!plan.cwd) {
    return { ok: false, reason: 'the directory no longer exists' }
  }

  try {
    if (!statSync(plan.cwd).isDirectory()) {
      return { ok: false, reason: `the path ${plan.cwd} is not an accessible directory` }
    }
    accessSync(plan.cwd, constants.R_OK | constants.X_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: false, reason: `the directory ${plan.cwd} no longer exists` }
    }
    return { ok: false, reason: `the path ${plan.cwd} is not an accessible directory` }
  }

  if (!resolveCommand(plan.cmd, plan.cwd)) {
    return { ok: false, reason: `${plan.cmd} was not found or is not executable` }
  }
  return { ok: true }
}

const defaultIo: RunIo = {
  /**
   * Internal implementation for spawn.
   */
  spawn(command, options) {
    return Bun.spawn(command, options)
  },
}

/**
 * Stops reading fd 0 so the child has the terminal to itself.
 *
 * Ink restores cooked mode, drops its listener and unrefs stdin when it
 * unmounts, but it never pauses the stream. Unref only stops the handle
 * holding the event loop open; the read stays live. This process then sits
 * on that read for as long as the client runs, and the two race for every
 * keystroke: the client feels fine for a second or two, until the picker
 * finishes tearing down and starts winning races, and from then on it eats
 * roughly one key in six.
 */
function releaseStdin(): void {
  try { process.stdin.pause() } catch { /* stdin may not be a stream at all */ }
}

/**
 * Hands SIGINT and SIGTERM to the child for as long as it runs, and returns the
 * undo.
 *
 * The child is not detached, so it shares this process group. Ctrl-C at the tty
 * is therefore delivered to the whole group, and the child already has the
 * signal before this handler runs; forwarding it would deliver it twice. What
 * the handler is for is the default the runtime would otherwise apply, which is
 * to terminate this process at once. Agent CLIs read SIGINT as "cancel this
 * generation" rather than "quit", so dying on the first Ctrl-C hands the shell
 * its prompt back while the client is still alive, still in raw mode and still
 * repainting the same terminal. Ignoring the signal keeps the wrapper waiting
 * until the child decides it is done.
 *
 * SIGTERM is the mirror image. `kill <nekyia-pid>` addresses this process
 * alone, never the group, so nothing reaches the child unless it is passed on,
 * and the wrapper would exit leaving the client orphaned. The child may have
 * exited between the signal arriving and the kill, so the kill is guarded.
 */
function holdSignals(proc: SpawnedProcess): () => void {
  /**
   * Internal implementation for ignoreInterrupt.
   */
  const ignoreInterrupt = (): void => {
    // Deliberately empty: see above, the child already got this from the tty.
  }
  /**
   * Internal implementation for forwardTerminate.
   */
  const forwardTerminate = (): void => {
    try { proc.kill?.('SIGTERM') } catch { /* the child may already be gone */ }
  }
  process.on('SIGINT', ignoreInterrupt)
  process.on('SIGTERM', forwardTerminate)
  return () => {
    process.off('SIGINT', ignoreInterrupt)
    process.off('SIGTERM', forwardTerminate)
  }
}

/**
 * Spawns the client with inherited stdio and returns its exact process status.
 * The caller must tear down any TUI first: the child owns the terminal.
 */
export async function runPlan(plan: ExecPlan, io: RunIo = defaultIo): Promise<number> {
  const command = resolveCommand(plan.cmd, plan.cwd)
  if (!command) throw new Error(`${plan.cmd} was not found or is not executable`)
  releaseStdin()
  const proc = io.spawn([command, ...plan.args], {
    cwd: plan.cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const releaseSignals = holdSignals(proc)
  try {
    return await proc.exited
  } finally {
    releaseSignals()
  }
}

/**
 * Internal implementation for quote.
 */
function quote(value: string): string {
  return value !== '' && /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`
}

const SHELL_RESERVED_WORDS = new Set([
  '!', '{', '}', 'case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'if', 'in',
  'then', 'until', 'while',
])

/**
 * Internal implementation for quoteCommand.
 */
function quoteCommand(value: string): string {
  if (SHELL_RESERVED_WORDS.has(value) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
    return `'${value.replace(/'/g, `'\\''`)}'`
  }
  return quote(value)
}

/** Renders a plan as a copyable shell command, quoting anything the shell would otherwise interpret. */
export function shellQuote(plan: ExecPlan): string {
  const command = [quoteCommand(plan.cmd), ...plan.args.map(quote)].join(' ')
  const cwd = !isAbsolute(plan.cwd) && plan.cwd.startsWith('-') ? `./${plan.cwd}` : plan.cwd
  return `cd ${quote(cwd)} && ${command}`
}
