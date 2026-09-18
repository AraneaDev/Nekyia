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

/** What a row shows for a client with launchers: the tier and name of whichever opens it. */
export interface Presentation {
  tier: Tier
  label: string
}

/** Null for a single-launcher client, whose stored tier and id already say everything. */
export function presentationFor(manifest: Manifest, state: LauncherState): Presentation | null {
  if (state.kind === 'single') return null
  if (state.kind === 'chosen') return { tier: state.spec.tier, label: state.name }
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
