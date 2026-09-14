import { existsSync } from 'node:fs'
import { indexPath } from '../config'
import { buildAdapters, type Adapter } from '../core/adapter'
import { IndexDb } from '../core/db'
import { buildHandoffPlan, type HandoffResult } from '../core/handoff'
import { checkPlan, runPlan, shellQuote, type RunResult } from '../core/resume'
import { boundedDisplayText } from '../tui/text'
import type { Diagnostic, ExecPlan } from '../types'
import { isSafeClientId, parseUid } from '../types'
import { needsConsent } from './firstrun'

/** Options accepted by `nekyia handoff <uid> --to <client>`. */
export interface HandoffOptions {
  uid?: string
  to?: string
  maxChars?: number
  dryRun?: boolean
  json?: boolean
}

/** Injection points for the handoff launch, so the command can be tested without spawning anything. */
export interface HandoffDependencies {
  indexPath(): string
  indexExists(path: string): boolean
  needsConsent(): boolean
  buildAdapters(): { adapters: Adapter[]; diagnostics: Diagnostic[] }
  openDb(path: string): IndexDb
  buildHandoffPlan(
    db: IndexDb,
    uid: string,
    targetClient: string,
    adapters: Adapter[],
    opts?: { maxChars?: number },
  ): HandoffResult
  checkPlan(plan: ExecPlan): RunResult
  runPlan(plan: ExecPlan): Promise<number>
  shellQuote(plan: ExecPlan): string
  log(message: string): void
  error(message: string): void
}

const defaults: HandoffDependencies = {
  indexPath,
  indexExists: existsSync,
  needsConsent,
  buildAdapters,
  /** Opens the index database in readonly mode: a handoff never writes to the index. */
  openDb: (path) => IndexDb.openReadonly(path),
  buildHandoffPlan,
  checkPlan,
  runPlan,
  shellQuote,
  /** Writes the planned command or JSON to stdout. */
  log: (message) => { console.log(message) },
  /** Writes a bounded diagnostic to stderr. */
  error: (message) => { console.error(message) },
}

/** Extracts and safely formats the message string from an error object. */
function message(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return boundedDisplayText(raw, 512) || 'unknown error'
}

/** Builds a handover from one session and launches a different client with it. */
export async function runHandoff(
  opts: HandoffOptions,
  overrides: Partial<HandoffDependencies> = {},
): Promise<number> {
  const deps: HandoffDependencies = { ...defaults, ...overrides }

  if (!opts.uid || !opts.to) {
    deps.error('usage: nekyia handoff <uid> --to <client>')
    return 2
  }
  if (/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(opts.uid)) {
    deps.error('error: uid must not contain control characters')
    return 2
  }
  try {
    parseUid(opts.uid)
  } catch {
    deps.error(`error: malformed uid: ${boundedDisplayText(opts.uid, 128)}`)
    return 2
  }
  if (!isSafeClientId(opts.to)) {
    deps.error('error: invalid target client id')
    return 2
  }
  if (opts.json && !opts.dryRun) {
    deps.error('error: --json requires --dry-run')
    return 2
  }
  if (opts.maxChars !== undefined
    && (!Number.isSafeInteger(opts.maxChars) || opts.maxChars < 0)) {
    deps.error('error: --max-chars must be a non-negative integer')
    return 2
  }

  const path = deps.indexPath()
  try {
    if (!deps.indexExists(path)) {
      deps.error('index not found; run "nekyia index" first')
      return 1
    }
    if (deps.needsConsent()) {
      deps.error('indexing consent is missing or invalid; run "nekyia index" first')
      return 1
    }
  } catch (error) {
    deps.error(`could not inspect index state: ${message(error)}`)
    return 1
  }

  let adapters: Adapter[]
  try {
    const built = deps.buildAdapters()
    if (built.diagnostics.some((diagnostic) => diagnostic.level === 'error')) {
      deps.error('client manifests are invalid; run "nekyia doctor" for details')
      return 1
    }
    adapters = built.adapters
  } catch (error) {
    deps.error(`could not load client manifests: ${message(error)}`)
    return 1
  }

  let db: IndexDb
  try {
    db = deps.openDb(path)
  } catch (error) {
    deps.error(`could not open the session index: ${message(error)}`)
    return 1
  }

  let result: HandoffResult | undefined
  let failure: string | undefined
  try {
    result = deps.buildHandoffPlan(db, opts.uid, opts.to, adapters, { maxChars: opts.maxChars })
  } catch (error) {
    failure = `could not plan this handoff: ${message(error)}`
  } finally {
    try {
      db.close()
    } catch (error) {
      failure ??= `could not close the session index: ${message(error)}`
      result = undefined
    }
  }

  if (failure || !result) {
    deps.error(failure ?? 'could not plan this handoff')
    return 1
  }
  if (!result.ok) {
    deps.error(boundedDisplayText(result.reason, 512))
    return 1
  }

  const { plan, briefChars } = result

  if (opts.dryRun) {
    deps.log(opts.json
      ? JSON.stringify({ cmd: plan.cmd, args: plan.args, cwd: plan.cwd, briefChars })
      : deps.shellQuote(plan))
    return 0
  }

  let checked: RunResult
  try {
    checked = deps.checkPlan(plan)
  } catch (error) {
    deps.error(`could not validate the launch: ${message(error)}`)
    return 1
  }
  if (!checked.ok) {
    deps.error(boundedDisplayText(checked.reason ?? 'this session cannot be launched', 512))
    return 1
  }

  try {
    return await deps.runPlan(plan)
  } catch (error) {
    deps.error(`could not launch the client: ${message(error)}`)
    return 1
  }
}
