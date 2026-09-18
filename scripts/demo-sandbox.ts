/**
 * Builds the sandbox the README media is captured in: the invented transcripts
 * in test/fixtures/demo, indexed by the real indexer.
 *
 * HOME, both XDG directories and every client root (through
 * NEKYIA_ROOT_OVERRIDE) point into the given directory, so no real history can
 * reach the index, let alone a frame.
 *
 * The fixture is written as if "now" were ANCHOR. Its timestamps and file
 * times are shifted to the moment of capture, so the ages on screen, and so
 * the media itself, come out the same on every run.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const fixture = join(root, 'test', 'fixtures', 'demo')
const ANCHOR = Date.parse('2026-01-15T12:00:00.000Z')

/** This checkout's entry point, so a capture never depends on a global install. */
export const nekyia = join(root, 'bin', 'nekyia.mjs')

export interface Sandbox {
  HOME: string
  XDG_DATA_HOME: string
  XDG_CONFIG_HOME: string
  NEKYIA_ROOT_OVERRIDE: string
}

/** Moves every timestamp in the copied fixture from ANCHOR by delta. */
function shift(dir: string, delta: number): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { shift(path, delta); continue }
    let latest = 0
    const text = readFileSync(path, 'utf8').replace(
      /"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)"/gu,
      (_match, stamp: string) => {
        const moved = Date.parse(stamp) + delta
        latest = Math.max(latest, moved)
        return `"${new Date(moved).toISOString()}"`
      },
    )
    writeFileSync(path, text)
    // A transcript's age is its file time, so that moves with the content.
    if (latest) utimesSync(path, latest / 1000, latest / 1000)
  }
}

/** Recreates the sandbox under dir and indexes the fixture into it. */
export function prepareSandbox(dir: string): Sandbox {
  rmSync(dir, { recursive: true, force: true })
  const sandbox: Sandbox = {
    HOME: join(dir, 'home'),
    XDG_DATA_HOME: join(dir, 'data'),
    XDG_CONFIG_HOME: join(dir, 'config'),
    NEKYIA_ROOT_OVERRIDE: join(dir, 'roots'),
  }
  for (const path of Object.values(sandbox)) mkdirSync(path, { recursive: true })
  cpSync(fixture, sandbox.NEKYIA_ROOT_OVERRIDE, { recursive: true })
  shift(sandbox.NEKYIA_ROOT_OVERRIDE, Date.now() - ANCHOR)

  const indexed = Bun.spawnSync(['bun', nekyia, 'index', '--yes', '--quiet'], {
    env: { ...process.env, ...sandbox },
  })
  if (!indexed.success) throw new Error(`index failed: ${indexed.stderr.toString().trim()}`)
  return sandbox
}

/**
 * A shell line that enters the sandbox and defines `nek` as this checkout, for
 * a tmux pane about to launch the picker.
 */
export function shellSetup(sandbox: Sandbox): string {
  const exports = Object.entries(sandbox).map(([key, value]) => `${key}=${value}`).join(' ')
  return `export ${exports} PS1='$ '; nek() { bun ${nekyia} "$@"; }; clear`
}
