import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import type { ExecPlan } from '../types'

export interface RunResult {
  ok: boolean
  reason?: string
  exitCode?: number
}

interface SpawnOptions {
  cwd: string
  stdin: 'inherit'
  stdout: 'inherit'
  stderr: 'inherit'
}

export interface RunIo {
  spawn(command: string[], options: SpawnOptions): { exited: Promise<number> }
}

function executableAt(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

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
  spawn(command, options) {
    return Bun.spawn(command, options)
  },
}

/**
 * Spawns the client with inherited stdio and returns its exact process status.
 * The caller must tear down any TUI first: the child owns the terminal.
 */
export async function runPlan(plan: ExecPlan, io: RunIo = defaultIo): Promise<number> {
  const command = resolveCommand(plan.cmd, plan.cwd)
  if (!command) throw new Error(`${plan.cmd} was not found or is not executable`)
  const proc = io.spawn([command, ...plan.args], {
    cwd: plan.cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return await proc.exited
}

function quote(value: string): string {
  return value !== '' && /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`
}

const SHELL_RESERVED_WORDS = new Set([
  '!', '{', '}', 'case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'if', 'in',
  'then', 'until', 'while',
])

function quoteCommand(value: string): string {
  if (SHELL_RESERVED_WORDS.has(value) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
    return `'${value.replace(/'/g, `'\\''`)}'`
  }
  return quote(value)
}

export function shellQuote(plan: ExecPlan): string {
  const command = [quoteCommand(plan.cmd), ...plan.args.map(quote)].join(' ')
  const cwd = !isAbsolute(plan.cwd) && plan.cwd.startsWith('-') ? `./${plan.cwd}` : plan.cwd
  return `cd ${quote(cwd)} && ${command}`
}
