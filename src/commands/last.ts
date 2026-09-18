import { existsSync } from 'node:fs'
import { indexPath, loadConfigChecked, type Config } from '../config'
import { buildAdapters, type Adapter } from '../core/adapter'
import { buildBrief } from '../core/brief'
import { IndexDb } from '../core/db'
import { defaultOnPath, resolveForLaunch, type OnPath } from '../core/launcher'
import { query, type QueryOpts, type Row } from '../core/query'
import { checkPlan, runPlan, type RunResult } from '../core/resume'
import { boundedDisplayText, boundedErrorMessage as message } from '../tui/text'
import type { Diagnostic, ExecPlan } from '../types'
import { needsConsent } from './firstrun'

/** Injection points for the newest-session launch, so the command can be tested without spawning anything. */
export interface LastDependencies {
  indexPath(): string
  indexExists(path: string): boolean
  needsConsent(): boolean
  loadConfig(): Config
  buildAdapters(): { adapters: Adapter[]; diagnostics: Diagnostic[] }
  openDb(path: string): IndexDb
  query(db: IndexDb, cfg: Config, opts: QueryOpts): Row[]
  buildBrief(db: IndexDb, uid: string): string | null
  cwd(): string
  onPath: OnPath
  checkPlan(plan: ExecPlan): RunResult
  runPlan(plan: ExecPlan): Promise<number>
  error(message: string): void
}

const defaults: LastDependencies = {
  indexPath,
  indexExists: existsSync,
  needsConsent,
  /**
   * Loads the config, saying so when the one on disk could not be honoured.
   *
   * The command still runs: a config typo was never meant to stop it. What it
   * must not do is apply the permissive defaults in silence.
   */
  loadConfig: () => {
    const { config, problem } = loadConfigChecked()
    if (problem !== null) console.error(`warning: ${problem}`)
    return config
  },
  buildAdapters,
  /** Opens the index database in readonly mode. */
  openDb: (path) => IndexDb.openReadonly(path),
  query,
  buildBrief,
  /** Returns the current working directory. */
  cwd: () => process.cwd(),
  onPath: defaultOnPath(),
  checkPlan,
  runPlan,
  /** Outputs an error message to stderr. */
  error: (message) => { console.error(message) },
}

/** Selects the appropriate execution plan to resume or re-brief a given session row. */
function planFor(
  db: IndexDb,
  row: Row,
  adapters: Adapter[],
  makeBrief: LastDependencies['buildBrief'],
  cfg: Config,
  onPath: OnPath,
): { plan: ExecPlan | null; reason?: string } {
  const adapter = adapters.find((candidate) => candidate.id === row.client)
  if (!adapter) return { plan: null, reason: `no adapter for ${boundedDisplayText(row.client, 64)}` }

  // A shared store has no launcher of its own to plan from: which command
  // actually opens it depends on the same saved-choice/installed resolution
  // the picker uses, so `last` must run it too rather than guessing the
  // manifest's nominal tier. `resolveForLaunch` is the one place that
  // resolution and its refusal wording live.
  const resolved = resolveForLaunch(adapter.manifest, row.tier, cfg, onPath)
  if (resolved.kind === 'unavailable') return { plan: null, reason: resolved.message }
  if (resolved.kind === 'ask') {
    return {
      plan: null,
      reason: `both ${resolved.options.join(' and ')} are installed; choose one with ctrl+l in the picker`,
    }
  }
  const { launcher, tier } = resolved

  if (tier === 'resume') {
    const plan = adapter.plan(row, undefined, launcher)
    if (!plan) return { plan: null, reason: 'the latest session cannot be launched' }
    if (plan.kind !== 'resume') {
      return { plan: null, reason: 'adapter plan does not match the resume session' }
    }
    return { plan }
  }

  if (tier === 'search') {
    const brief = makeBrief(db, row.uid)
    if (!brief) return { plan: null, reason: 'nothing is indexed for the latest session yet' }
    const plan = adapter.plan(row, brief, launcher)
    if (!plan) return { plan: null, reason: 'the latest session cannot start a briefed session' }
    if (plan.kind !== 'brief') {
      return { plan: null, reason: 'adapter plan does not match the search session' }
    }
    return { plan }
  }

  return { plan: null, reason: 'the latest session is detected but cannot be launched' }
}

/** Launch the newest visible session under the current directory. */
export async function runLast(overrides: Partial<LastDependencies> = {}): Promise<number> {
  const deps: LastDependencies = { ...defaults, ...overrides }
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

  let plan: ExecPlan | null = null
  let failure: string | undefined
  try {
    const cfg = deps.loadConfig()
    const rows = deps.query(db, cfg, {
      cwd: deps.cwd(),
      sort: 'recent',
      limit: 1,
    })
    if (rows.length === 0) failure = 'no sessions matched the current directory'
    else ({ plan, reason: failure } = planFor(db, rows[0]!, adapters, deps.buildBrief, cfg, deps.onPath))
  } catch (error) {
    failure = `could not select the latest session: ${message(error)}`
  } finally {
    try {
      db.close()
    } catch (error) {
      failure ??= `could not close the session index: ${message(error)}`
      plan = null
    }
  }

  if (!plan) {
    deps.error(failure ?? 'the latest session cannot be launched')
    return 1
  }

  let checked: RunResult
  try {
    checked = deps.checkPlan(plan)
  } catch (error) {
    deps.error(`could not validate the launch: ${message(error)}`)
    return 1
  }
  if (!checked.ok) {
    deps.error(boundedDisplayText(checked.reason ?? 'the latest session cannot be launched', 512))
    return 1
  }

  try {
    return await deps.runPlan(plan)
  } catch (error) {
    deps.error(`could not launch the client: ${message(error)}`)
    return 1
  }
}
