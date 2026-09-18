import type { Config } from '../config'
import type { LauncherSpec, Manifest } from '../manifests/load'
import type { Tier } from '../types'
import { resolveCommand } from './resume'

/** Whether a command can be found on PATH. Injected so resolution never depends on the host in tests. */
export type OnPath = (command: string) => boolean

/**
 * Which launcher opens a store right now.
 *
 * `ask` only arises when more than one client is installed and the user has not
 * chosen, because only then would picking one silently be a guess.
 */
export type LauncherState =
  | { kind: 'single' }
  | { kind: 'chosen'; name: string; spec: LauncherSpec }
  | { kind: 'ask'; options: string[] }
  | { kind: 'none'; options: string[] }

/** Finds the command entry point (resume or brief) for a launcher spec. */
function commandOf(spec: LauncherSpec): string {
  return (spec.resume ?? spec.brief)!.cmd
}

/** Returns names of launchers installed on the host PATH. */
function installedLaunchers(manifest: Manifest, onPath: OnPath): string[] {
  const launchers = manifest.launchers ?? {}
  return Object.keys(launchers).filter((name) => onPath(commandOf(launchers[name]!)))
}

/** Resolves the active launcher from the saved choice and what is installed. */
export function resolveLauncher(manifest: Manifest, config: Config, onPath: OnPath): LauncherState {
  const launchers = manifest.launchers
  if (!launchers) return { kind: 'single' }
  const installed = installedLaunchers(manifest, onPath)
  const saved = config.launchers?.[manifest.id]
  if (saved !== undefined && installed.includes(saved)) {
    return { kind: 'chosen', name: saved, spec: launchers[saved]! }
  }
  if (installed.length === 1) {
    return { kind: 'chosen', name: installed[0]!, spec: launchers[installed[0]!]! }
  }
  if (installed.length === 0) return { kind: 'none', options: Object.keys(launchers) }
  return { kind: 'ask', options: installed }
}

/** The launcher a flip moves to, or null when fewer than two are installed. */
export function nextLauncher(manifest: Manifest, config: Config, onPath: OnPath): string | null {
  if (!manifest.launchers) return null
  const installed = installedLaunchers(manifest, onPath)
  if (installed.length < 2) return null
  const current = resolveLauncher(manifest, config, onPath)
  if (current.kind !== 'chosen') return installed[0]!
  return installed[(installed.indexOf(current.name) + 1) % installed.length]!
}

/**
 * What a row shows for a client with launchers: the tier and name of whichever opens it.
 *
 * `label` is a display name and is set even while undecided, defaulting to the
 * manifest id. `launcher` is the name of a launcher actually resolved to open
 * the store, and is set only in the `chosen` case: an `ask` or `none` state
 * has not chosen anything, so nothing was launched and nothing should claim
 * to have been.
 */
export interface Presentation {
  tier: Tier
  label: string
  launcher?: string
}

/** Null for a single-launcher client, whose stored tier and id already say everything. */
export function presentationFor(manifest: Manifest, state: LauncherState): Presentation | null {
  if (state.kind === 'single') return null
  if (state.kind === 'chosen') return { tier: state.spec.tier, label: state.name, launcher: state.name }
  return { tier: manifest.tier, label: manifest.id }
}

/** The overlay for every client that has launchers, keyed by manifest id. */
export function presentations(
  manifests: Manifest[],
  config: Config,
  onPath: OnPath,
): Map<string, Presentation> {
  const out = new Map<string, Presentation>()
  for (const manifest of manifests) {
    const shown = presentationFor(manifest, resolveLauncher(manifest, config, onPath))
    if (shown) out.set(manifest.id, shown)
  }
  return out
}

/** Checks PATH the same way a launch does. */
export function defaultOnPath(): OnPath {
  return (command) => resolveCommand(command, process.cwd()) !== undefined
}

/**
 * What a caller planning a launch should do about a row's client: a settled
 * launcher and the tier to treat it as (`launcher` is undefined for a client
 * with no `launchers` of its own, and `tier` then stays the row's own), a
 * question that still needs asking, or a refusal with the message to show.
 *
 * Both `nekyia last` and the picker plan a launch for a selected row, and both
 * need the same answer to "which client, and does that change the tier". This
 * is the one place that answer is worked out, so the refusal wording for an
 * uninstalled launcher exists in a single copy.
 */
export type ResolveForLaunch =
  | { kind: 'resolved'; launcher: string | undefined; tier: Tier }
  | { kind: 'ask'; options: string[] }
  | { kind: 'unavailable'; message: string }

/**
 * Resolves which launcher opens a row's store and what tier to treat it as.
 *
 * `chosen` is a launcher just picked from an ask overlay, honoured ahead of
 * `config`'s saved choice so the same keypress that answers the question can
 * also act on it without waiting on a config update to land.
 */
export function resolveForLaunch(
  manifest: Manifest,
  rowTier: Tier,
  config: Config,
  onPath: OnPath,
  chosen?: string,
): ResolveForLaunch {
  const launchers = manifest.launchers
  if (!launchers) return { kind: 'resolved', launcher: undefined, tier: rowTier }
  const state = chosen !== undefined && launchers[chosen]
    ? { kind: 'chosen' as const, name: chosen, spec: launchers[chosen]! }
    : resolveLauncher(manifest, config, onPath)
  if (state.kind === 'none') {
    return { kind: 'unavailable', message: `none of ${state.options.join(', ')} is on PATH` }
  }
  if (state.kind === 'ask') return { kind: 'ask', options: state.options }
  if (state.kind === 'chosen') return { kind: 'resolved', launcher: state.name, tier: state.spec.tier }
  // Unreachable: resolveLauncher only answers 'single' when manifest.launchers
  // is absent, and this line is reached only when it is present.
  return { kind: 'resolved', launcher: undefined, tier: rowTier }
}
