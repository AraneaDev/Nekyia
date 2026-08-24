import { existsSync } from 'node:fs'
import React from 'react'
import { render } from 'ink'
import { buildAdapters } from '../core/adapter'
import { IndexDb } from '../core/db'
import { checkPlan, runPlan, type RunResult } from '../core/resume'
import { indexPath, loadConfig } from '../config'
import { App, type AppProps } from '../tui/App'
import { boundedDisplayText } from '../tui/List'
import type { ExecPlan } from '../types'
import { runReindex } from './reindex'
import { needsConsent } from './firstrun'

/** The subset of Ink's render handle the picker lifecycle needs. */
export interface PickerInstance {
  waitUntilExit(): Promise<unknown>
  unmount(): void
}

/** Injection points for the picker command, covering the terminal, index, and launch. */
export interface PickDependencies {
  isTTY(): boolean
  indexExists(path: string): boolean
  needsConsent(): boolean
  indexPath(): string
  loadConfig: typeof loadConfig
  buildAdapters: typeof buildAdapters
  openDb(path: string): IndexDb
  cwd(): string
  now(): number
  mount(props: AppProps): PickerInstance
  checkPlan(plan: ExecPlan): RunResult
  runPlan(plan: ExecPlan): Promise<number>
  ensureIndex(): Promise<number>
  error(message: string): void
}

/** Mounts the picker on the alternate screen, so the session list never displaces the user's scrollback. */
export function mountPicker(props: AppProps, renderer: typeof render = render): PickerInstance {
  return renderer(React.createElement(App, props), { alternateScreen: true })
}

const defaults: PickDependencies = {
  isTTY: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  indexExists: existsSync,
  needsConsent,
  indexPath,
  loadConfig,
  buildAdapters,
  openDb: (path) => IndexDb.open(path, false),
  cwd: () => process.cwd(),
  now: () => Date.now(),
  mount: mountPicker,
  checkPlan,
  runPlan,
  ensureIndex: () => runReindex({ yes: false }),
  error: (message) => { console.error(message) },
}

function message(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return boundedDisplayText(raw, 512) || 'unknown error'
}

/** Own the picker lifecycle and launch only after Ink and SQLite are closed. */
export async function runPick(overrides: Partial<PickDependencies> = {}): Promise<number> {
  const deps: PickDependencies = { ...defaults, ...overrides }
  if (!deps.isTTY()) {
    deps.error('the picker requires an interactive terminal; use nekyia search in scripts')
    return 1
  }

  const path = deps.indexPath()
  let requiresSetup: boolean
  try {
    requiresSetup = deps.needsConsent() || !deps.indexExists(path)
  } catch (error) {
    deps.error(`could not inspect first-run state: ${message(error)}`)
    return 1
  }
  if (requiresSetup) {
    let code: number
    try {
      code = await deps.ensureIndex()
    } catch (error) {
      deps.error(`could not build the session index: ${message(error)}`)
      return 1
    }
    if (code !== 0) {
      deps.error('no session index found; first-run indexing did not complete')
      return code
    }
    try {
      if (deps.needsConsent() || !deps.indexExists(path)) {
        deps.error('first-run indexing did not produce a valid consent marker and index')
        return 1
      }
    } catch (error) {
      deps.error(`could not verify first-run state: ${message(error)}`)
      return 1
    }
  }

  let db: IndexDb
  try {
    db = deps.openDb(path)
  } catch (error) {
    deps.error(`could not open the session index: ${message(error)}`)
    return 1
  }

  let picker: PickerInstance | undefined
  let pending: ExecPlan | null = null
  let lifecycleError: unknown
  try {
    const cfg = deps.loadConfig()
    const { adapters } = deps.buildAdapters()
    picker = deps.mount({
      db,
      cfg,
      adapters,
      cwd: deps.cwd(),
      now: deps.now(),
      onExec: (plan) => { pending ??= plan },
    })
    await picker.waitUntilExit()
  } catch (error) {
    lifecycleError = error
  } finally {
    try {
      picker?.unmount()
    } catch (error) {
      lifecycleError ??= error
    }
    try {
      db.close()
    } catch (error) {
      lifecycleError ??= error
    }
  }

  if (lifecycleError) {
    deps.error(`picker failed: ${message(lifecycleError)}`)
    return 1
  }
  if (!pending) return 0

  let checked: RunResult
  try {
    checked = deps.checkPlan(pending)
  } catch (error) {
    deps.error(`could not validate the launch: ${message(error)}`)
    return 1
  }
  if (!checked.ok) {
    deps.error(boundedDisplayText(
      checked.reason ?? 'the selected session cannot be launched',
      512,
    ))
    return 1
  }
  try {
    return await deps.runPlan(pending)
  } catch (error) {
    deps.error(`could not launch the client: ${message(error)}`)
    return 1
  }
}
