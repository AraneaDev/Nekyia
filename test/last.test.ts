import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/config'
import { runLast, type LastDependencies } from '../src/commands/last'
import type { Adapter } from '../src/core/adapter'
import type { Row } from '../src/core/query'
import type { ExecPlan } from '../src/types'

function row(over: Partial<Row> = {}): Row {
  return {
    uid: 'claude:new', client: 'claude', nativeId: 'new', cwd: '/work/project',
    gitBranch: 'main', title: 'latest', startedAt: 1, endedAt: 20, turns: 2,
    parentNativeId: null, tier: 'resume', origin: 'manifest',
    missing: false, score: 20, collapsed: 0,
    ...over,
  }
}

function adapter(plan: ExecPlan | null): Adapter {
  return {
    id: 'claude', manifest: {} as Adapter['manifest'], detect: () => true,
    discover: async () => ({ refs: [], diagnostics: [], authoritative: true }),
    hydrate: async () => { throw new Error('not reached') },
    plan: () => plan,
  }
}

function dependencies(over: Partial<LastDependencies> = {}): LastDependencies {
  const opened = { close() {} }
  return {
    indexPath: () => '/data/index.db',
    indexExists: () => true,
    needsConsent: () => false,
    loadConfig: () => DEFAULT_CONFIG,
    buildAdapters: () => ({
      adapters: [adapter({
        kind: 'resume', cmd: 'claude', args: ['--resume', 'new'], cwd: '/work/project',
      })],
      diagnostics: [],
    }),
    openDb: () => opened as never,
    query: (_db, _cfg, opts) => {
      expect(opts).toMatchObject({ cwd: '/work/project', sort: 'recent', limit: 1 })
      return [row()]
    },
    buildBrief: () => 'brief',
    cwd: () => '/work/project',
    checkPlan: () => ({ ok: true }),
    runPlan: async () => 0,
    error: () => {},
    ...over,
  }
}

test('last closes SQLite before validating and launching the latest visible session', async () => {
  const order: string[] = []
  const plan: ExecPlan = {
    kind: 'resume', cmd: 'claude', args: ['--resume', 'new'], cwd: '/work/project',
  }
  const code = await runLast(dependencies({
    openDb: () => ({ close: () => { order.push('close') } }) as never,
    buildAdapters: () => ({ adapters: [adapter(plan)], diagnostics: [] }),
    checkPlan: (value) => { order.push('check'); expect(value).toEqual(plan); return { ok: true } },
    runPlan: async (value) => { order.push('run'); expect(value).toEqual(plan); return 17 },
  }))
  expect(code).toBe(17)
  expect(order).toEqual(['close', 'check', 'run'])
})

test('last starts a deterministic briefed session for a search-tier client', async () => {
  const plans: ExecPlan[] = []
  const brief = 'deterministic indexed handover'
  const briefPlan: ExecPlan = {
    kind: 'brief', cmd: 'opencode', args: [brief], cwd: '/work/project', prompt: brief,
  }
  const searchRow = row({ client: 'opencode', tier: 'search', uid: 'opencode:new' })
  const searchAdapter = {
    ...adapter(briefPlan),
    id: 'opencode',
    plan: (selected: Row, prompt?: string) => {
      expect(selected.uid).toBe(searchRow.uid)
      expect(prompt).toBe(brief)
      return briefPlan
    },
  }
  expect(await runLast(dependencies({
    query: () => [searchRow],
    buildBrief: (_db, uid) => { expect(uid).toBe(searchRow.uid); return brief },
    buildAdapters: () => ({ adapters: [searchAdapter], diagnostics: [] }),
    checkPlan: () => ({ ok: true }),
    runPlan: async (plan) => { plans.push(plan); return 0 },
  }))).toBe(0)
  expect(plans).toEqual([briefPlan])
})

test('last refuses absent indexes and invalid consent without creating or opening anything', async () => {
  for (const state of [
    { exists: false, consent: false, expected: 'index not found' },
    { exists: true, consent: true, expected: 'consent' },
  ]) {
    const errors: string[] = []
    let opens = 0
    const code = await runLast(dependencies({
      indexExists: () => state.exists,
      needsConsent: () => state.consent,
      openDb: () => { opens++; throw new Error('must not open') },
      error: (message) => errors.push(message),
    }))
    expect(code).toBe(1)
    expect(opens).toBe(0)
    expect(errors.join(' ')).toContain(state.expected)
  }
})

test('last safely rejects empty results, adapter errors, missing briefs, and plan kind mismatches', async () => {
  const cases: Array<Partial<LastDependencies>> = [
    { query: () => [] },
    { buildAdapters: () => ({ adapters: [], diagnostics: [{ client: 'x', level: 'error', path: null, message: 'bad' }] }) },
    { query: () => [row({ tier: 'search' })], buildBrief: () => null },
    { buildAdapters: () => ({ adapters: [adapter({ kind: 'brief', cmd: 'x', args: [], cwd: '/work/project' })], diagnostics: [] }) },
  ]
  for (const overrides of cases) {
    const errors: string[] = []
    expect(await runLast(dependencies({ ...overrides, error: (message) => errors.push(message) }))).toBe(1)
    expect(errors).not.toEqual([])
  }
})

test('last returns launch validation errors without spawning', async () => {
  const errors: string[] = []
  let ran = false
  expect(await runLast(dependencies({
    checkPlan: () => ({ ok: false, reason: 'the directory no longer exists' }),
    runPlan: async () => { ran = true; return 0 },
    error: (message) => errors.push(message),
  }))).toBe(1)
  expect(ran).toBe(false)
  expect(errors).toEqual(['the directory no longer exists'])
})

test('last reports an index it could not inspect rather than guessing', async () => {
  const errors: string[] = []
  const code = await runLast(dependencies({
    indexExists: () => { throw new Error('EACCES: permission denied') },
    runPlan: async () => { throw new Error('must not launch without an index') },
    error: (text) => { errors.push(text) },
  }))

  expect(code).toBe(1)
  expect(errors).toEqual(['could not inspect index state: EACCES: permission denied'])
})

test('last refuses to run when a client manifest is invalid, and points at doctor', async () => {
  const errors: string[] = []
  const code = await runLast(dependencies({
    buildAdapters: () => ({
      adapters: [],
      diagnostics: [{ client: 'kilo', level: 'error', path: null, message: 'unknown format' }],
    }),
    runPlan: async () => { throw new Error('must not launch on a broken manifest set') },
    error: (text) => { errors.push(text) },
  }))

  expect(code).toBe(1)
  expect(errors).toEqual(['client manifests are invalid; run "nekyia doctor" for details'])
})

test('last runs when manifests report only warnings, which are not fatal', async () => {
  // The guard keys on error level alone. A warning means one client's view is
  // incomplete, which is not a reason to refuse every other client's sessions.
  const code = await runLast(dependencies({
    buildAdapters: () => ({
      adapters: [adapter({
        kind: 'resume', cmd: 'claude', args: ['--resume', 'new'], cwd: '/work/project',
      })],
      diagnostics: [{ client: 'kilo', level: 'warn', path: null, message: 'store unreadable' }],
    }),
    runPlan: async () => 0,
    error: (text) => { throw new Error(`unexpected error output: ${text}`) },
  }))

  expect(code).toBe(0)
})

test('last reports client manifests it could not load at all', async () => {
  const errors: string[] = []
  const code = await runLast(dependencies({
    buildAdapters: () => { throw new Error('manifest directory vanished') },
    runPlan: async () => { throw new Error('must not launch without adapters') },
    error: (text) => { errors.push(text) },
  }))

  expect(code).toBe(1)
  expect(errors).toEqual(['could not load client manifests: manifest directory vanished'])
})
