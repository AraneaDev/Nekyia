import { existsSync, statSync } from 'node:fs'
import React from 'react'
import { render } from 'ink'
import { buildAdapters } from '../core/adapter'
import { IndexDb } from '../core/db'
import { checkPlan, runPlan, type RunResult } from '../core/resume'
import { indexPath, loadConfigChecked, type Config } from '../config'
import { App, type AppProps } from '../tui/App'
import { releaseTerminal } from '../tui/clipboard'
import { boundedDisplayText } from '../tui/text'
import type { ExecPlan } from '../types'
import { runReindex } from './reindex'
import { needsConsent } from './firstrun'

/**
 * How long the launch waits on a clipboard write that has not finished.
 *
 * A helper normally exits in a few milliseconds; half a second is long enough
 * to cover a cold one and short enough that a stuck one delays the client
 * rather than holding the terminal hostage.
 */
const CLIPBOARD_DRAIN_MS = 500

/**
 * Waits for a copy to finish, but never for longer than `ms`.
 *
 * The picker has already reported any failure to the user, so a rejection here
 * is nothing to say twice; the launch goes ahead either way.
 */
async function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) }),
    ])
  } catch {
    // Already announced in the picker.
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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
  loadConfig: () => Config
  buildAdapters: typeof buildAdapters
  openDb(path: string): IndexDb
  cwd(): string
  now(): number
  mount(props: AppProps): PickerInstance
  checkPlan(plan: ExecPlan): RunResult
  runPlan(plan: ExecPlan): Promise<number>
  ensureIndex(): Promise<number>
  error(message: string): void
  /** Undefined when the index's age cannot be read, so the picker states nothing. */
  indexedAt(path: string): number | undefined
}

/** Mounts the picker on the alternate screen, so the session list never displaces the user's scrollback. */
export function mountPicker(props: AppProps, renderer: typeof render = render): PickerInstance {
  return renderer(React.createElement(App, props), {
    alternateScreen: true,
    // History scrolling changes a viewport, not the surrounding chrome. Let
    // Ink patch only the changed terminal rows instead of erasing and
    // rewriting the whole screen for every held-arrow frame.
    incrementalRendering: true,
    // Only affordable because each repaint is now incremental: doubling Ink's
    // default 30 Hz throttle would otherwise double the cost of a held key.
    maxFps: 60,
  })
}

const defaults: PickDependencies = {
  /** Checks if both stdin and stdout are interactive terminals. */
  isTTY: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  indexExists: existsSync,
  needsConsent,
  indexPath,
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
  /** Opens the index database for reading. */
  openDb: (path) => IndexDb.open(path, false),
  /** Returns the current working directory. */
  cwd: () => process.cwd(),
  /** Returns the current timestamp in milliseconds. */
  now: () => Date.now(),
  mount: mountPicker,
  checkPlan,
  runPlan,
  /** Builds or refreshes the index if required before picking. */
  ensureIndex: () => runReindex({ yes: false }),
  /** Outputs an error message to stderr. */
  error: (message) => { console.error(message) },
  /** Reads the last modification time of the index file. */
  indexedAt: (path) => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return undefined
    }
  },
}

/** Extracts and safely formats the message string from an error object. */
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
      // A run that indexed some clients and failed on others still leaves a
      // usable index behind. Refusing to open the picker would lock the user
      // out of the sessions that were indexed, so only a missing marker or a
      // missing index is fatal here; the verification below still has to pass.
      let partialIndex = false
      try {
        partialIndex = !deps.needsConsent() && deps.indexExists(path)
      } catch {
        // The verification below reports a stable first-run error.
      }
      if (!partialIndex) {
        deps.error('no session index found; first-run indexing did not complete')
        return code
      }
      deps.error('indexing completed with errors; continuing with the available sessions')
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
  let pendingCopy: Promise<void> | null = null
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
      indexedAt: deps.indexedAt(path),
      /** Captures the chosen execution plan and optional copy task when the user selects a session. */
      onExec: (plan, copy) => {
        if (pending) return
        pending = plan
        pendingCopy = copy ?? null
      },
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

  // Ink has let go of the terminal but the client has not taken it yet, which is
  // the only moment a copy can finish safely: the OSC 52 fallback writes an
  // escape sequence to stdout, which the launched client would otherwise receive,
  // and the helper process dies with this one when the launch replaces it.
  if (pendingCopy) await settleWithin(pendingCopy, CLIPBOARD_DRAIN_MS)
  // The wait above is bounded, so a copy can still be in flight here. Past this
  // line the terminal belongs to the client, and a helper that fails later must
  // not fall back to writing an escape sequence into it.
  releaseTerminal()

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
