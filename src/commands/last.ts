import { existsSync } from 'node:fs'
import { indexPath, loadConfig, type Config } from '../config'
import { buildAdapters, type Adapter } from '../core/adapter'
import { buildBrief } from '../core/brief'
import { IndexDb } from '../core/db'
import { query, type QueryOpts, type Row } from '../core/query'
import { checkPlan, runPlan, type RunResult } from '../core/resume'
import { boundedDisplayText } from '../tui/List'
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
  checkPlan(plan: ExecPlan): RunResult
  runPlan(plan: ExecPlan): Promise<number>
  error(message: string): void
}

const defaults: LastDependencies = {
  indexPath,
  indexExists: existsSync,
  needsConsent,
  loadConfig,
  buildAdapters,
  openDb: (path) => IndexDb.openReadonly(path),
  query,
  buildBrief,
  cwd: () => process.cwd(),
  checkPlan,
  runPlan,
  error: (message) => { console.error(message) },
}

function message(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return boundedDisplayText(raw, 512) || 'unknown error'
}

function planFor(
  db: IndexDb,
  row: Row,
  adapters: Adapter[],
  makeBrief: LastDependencies['buildBrief'],
): { plan: ExecPlan | null; reason?: string } {
  const adapter = adapters.find((candidate) => candidate.id === row.client)
  if (!adapter) return { plan: null, reason: `no adapter for ${boundedDisplayText(row.client, 64)}` }

  if (row.tier === 'resume') {
    const plan = adapter.plan(row)
    if (!plan) return { plan: null, reason: 'the latest session cannot be launched' }
    if (plan.kind !== 'resume') {
      return { plan: null, reason: 'adapter plan does not match the resume session' }
    }
    return { plan }
  }

  if (row.tier === 'search') {
    const brief = makeBrief(db, row.uid)
    if (!brief) return { plan: null, reason: 'nothing is indexed for the latest session yet' }
    const plan = adapter.plan(row, brief)
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
    const rows = deps.query(db, deps.loadConfig(), {
      cwd: deps.cwd(),
      sort: 'recent',
      limit: 1,
    })
    if (rows.length === 0) failure = 'no sessions matched the current directory'
    else ({ plan, reason: failure } = planFor(db, rows[0]!, adapters, deps.buildBrief))
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
