import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG, type Config } from '../src/config'
import {
  nextLauncher, presentationFor, presentations, resolveForLaunch, resolveLauncher,
} from '../src/core/launcher'
import { validateManifest } from '../src/manifests/load'

const shared = validateManifest({
  schema: 1, id: 'codebuff', name: 'Codebuff / Freebuff', roots: ['/nonexistent'],
  format: 'json-dir', tier: 'search',
  jsonDir: { glob: 'projects/*/chats/*', variant: 'codebuff' },
  launchers: {
    codebuff: { name: 'Codebuff', tier: 'search', brief: { cmd: 'codebuff', args: ['--cwd', '{cwd}', '{prompt}'], cwd: '{cwd}' } },
    freebuff: { name: 'Freebuff', tier: 'resume', resume: { cmd: 'freebuff', args: ['--continue', '{id}', '--cwd', '{cwd}'], cwd: '{cwd}' } },
  },
})
const single = validateManifest({
  schema: 1, id: 'claude', name: 'Claude Code', roots: ['/nonexistent'],
  format: 'jsonl-transcript', tier: 'resume', jsonl: { glob: '*.jsonl', variant: 'claude' },
  resume: { cmd: 'claude', args: ['--resume', '{id}'], cwd: '{cwd}' },
})
const installed = (...commands: string[]) => (command: string) => commands.includes(command)
const saved = (choice: string): Config => ({ ...DEFAULT_CONFIG, launchers: { codebuff: choice } })

test('a manifest without launchers is single, and needs no overlay', () => {
  const state = resolveLauncher(single, DEFAULT_CONFIG, installed('claude'))
  expect(state).toEqual({ kind: 'single' })
  expect(presentationFor(single, state)).toBeNull()
})

test('with exactly one client installed, that one is used without asking', () => {
  const state = resolveLauncher(shared, DEFAULT_CONFIG, installed('freebuff'))
  expect(state.kind === 'chosen' && state.name).toBe('freebuff')
})

test('with both installed and nothing saved, the user is asked', () => {
  expect(resolveLauncher(shared, DEFAULT_CONFIG, installed('codebuff', 'freebuff')))
    .toEqual({ kind: 'ask', options: ['codebuff', 'freebuff'] })
})

test('with both installed, a saved choice wins', () => {
  const state = resolveLauncher(shared, saved('freebuff'), installed('codebuff', 'freebuff'))
  expect(state.kind === 'chosen' && state.name).toBe('freebuff')
})

test('a saved choice that is no longer installed gives way to the one that is', () => {
  const state = resolveLauncher(shared, saved('freebuff'), installed('codebuff'))
  expect(state.kind === 'chosen' && state.name).toBe('codebuff')
})

test('with neither installed, the state says so and names both', () => {
  expect(resolveLauncher(shared, DEFAULT_CONFIG, installed()))
    .toEqual({ kind: 'none', options: ['codebuff', 'freebuff'] })
})

test('flipping cycles between installed launchers, and is impossible with one', () => {
  expect(nextLauncher(shared, saved('codebuff'), installed('codebuff', 'freebuff'))).toBe('freebuff')
  expect(nextLauncher(shared, saved('freebuff'), installed('codebuff', 'freebuff'))).toBe('codebuff')
  expect(nextLauncher(shared, DEFAULT_CONFIG, installed('codebuff', 'freebuff'))).toBe('codebuff')
  expect(nextLauncher(shared, DEFAULT_CONFIG, installed('codebuff'))).toBeNull()
  expect(nextLauncher(single, DEFAULT_CONFIG, installed('claude'))).toBeNull()
})

test('rows show the chosen launcher, and the manifest defaults while undecided', () => {
  expect(presentationFor(shared, resolveLauncher(shared, saved('freebuff'), installed('codebuff', 'freebuff'))))
    .toEqual({ tier: 'resume', label: 'freebuff', launcher: 'freebuff' })
  // Both installed, nothing saved: the state is `ask`, so nothing was chosen
  // and no `launcher` should be reported even though a default label is shown.
  expect(presentationFor(shared, resolveLauncher(shared, DEFAULT_CONFIG, installed('codebuff', 'freebuff'))))
    .toEqual({ tier: 'search', label: 'codebuff' })
})

test('presentationFor names no launcher when nothing is installed either', () => {
  // The `none` state shows the manifest's default label too, but nothing can
  // open the store, so `launcher` must be absent here as well.
  expect(presentationFor(shared, resolveLauncher(shared, DEFAULT_CONFIG, installed())))
    .toEqual({ tier: 'search', label: 'codebuff' })
})

test('presentations covers only clients that have launchers', () => {
  const map = presentations([shared, single], saved('freebuff'), installed('codebuff', 'freebuff', 'claude'))
  expect([...map.keys()]).toEqual(['codebuff'])
})

test('resolveForLaunch passes a launcherless manifest straight through with the row\'s own tier', () => {
  expect(resolveForLaunch(single, 'resume', DEFAULT_CONFIG, installed('claude')))
    .toEqual({ kind: 'resolved', launcher: undefined, tier: 'resume' })
})

test('resolveForLaunch resolves a shared store to its saved launcher and that launcher\'s tier', () => {
  expect(resolveForLaunch(shared, 'search', saved('freebuff'), installed('codebuff', 'freebuff')))
    .toEqual({ kind: 'resolved', launcher: 'freebuff', tier: 'resume' })
})

test('resolveForLaunch asks when both are installed and nothing is saved or chosen', () => {
  expect(resolveForLaunch(shared, 'search', DEFAULT_CONFIG, installed('codebuff', 'freebuff')))
    .toEqual({ kind: 'ask', options: ['codebuff', 'freebuff'] })
})

test('resolveForLaunch reports which launchers are unavailable when none is installed', () => {
  expect(resolveForLaunch(shared, 'search', DEFAULT_CONFIG, installed()))
    .toEqual({ kind: 'unavailable', message: 'none of codebuff, freebuff is on PATH' })
})

test('resolveForLaunch honours an explicit chosen launcher ahead of the saved choice or PATH state', () => {
  // The same keypress that answers the ask overlay must act on that choice
  // immediately, without waiting on the config update to land, so an explicit
  // `chosen` bypasses resolveLauncher entirely rather than merely seeding it.
  expect(resolveForLaunch(shared, 'search', saved('codebuff'), installed('codebuff', 'freebuff'), 'freebuff'))
    .toEqual({ kind: 'resolved', launcher: 'freebuff', tier: 'resume' })
})
