import { expect, test } from 'bun:test'
import { runHandoff, type HandoffDependencies } from '../src/commands/handoff'
import type { ExecPlan } from '../src/types'
import type { HandoffOptions } from '../src/commands/handoff'

function dependencies(over: Partial<HandoffDependencies> = {}): HandoffDependencies {
  const opened = { close() {} }
  return {
    indexPath: () => '/data/index.db',
    indexExists: () => true,
    needsConsent: () => false,
    buildAdapters: () => ({ adapters: [], diagnostics: [] }),
    openDb: () => opened as never,
    buildHandoffPlan: () => ({
      ok: true,
      plan: { kind: 'brief', cmd: 'opencode', args: ['brief'], cwd: '/work/project', prompt: 'brief' },
      briefChars: 5,
    }),
    checkPlan: () => ({ ok: true }),
    runPlan: async () => 0,
    shellQuote: (plan) => `cd ${plan.cwd} && ${plan.cmd} ${plan.args.join(' ')}`,
    log: () => {},
    error: () => {},
    ...over,
  }
}

test('direct handoff validates unsafe inputs and JSON mode before any reads', async () => {
  const invalid: HandoffOptions[] = [
    { uid: 'claude:a', to: 'codex', json: true },
    { uid: 'claude:a', to: 'bad\u001b[2J' },
    { uid: 'claude:a', to: 'bad\u202eclient' },
    { uid: 'claude:a', to: 'bad:client' },
    { uid: 'claude:a', to: 'a'.repeat(257) },
    { uid: 'claude:bad\u001b[2J', to: 'codex' },
    { uid: 'claude:bad\u202e', to: 'codex' },
    ...[NaN, Infinity, 0.5, -1].map((maxChars) => ({ uid: 'claude:a', to: 'codex', maxChars })),
  ]
  for (const opts of invalid) {
    const errors: string[] = []
    expect(await runHandoff(opts, dependencies({
      indexPath: () => { throw new Error('must not read') }, error: (m) => errors.push(m),
    }))).toBe(2)
    expect(errors.join('')).not.toMatch(/[\u001b\u202e]/u)
  }
})

test('planning and close failures prevent both launch and dry-run output, closing exactly once', async () => {
  for (const dryRun of [false, true]) {
    for (const stage of ['plan', 'close']) {
      let closes = 0
      let runs = 0
      const logs: string[] = []
      const errors: string[] = []
      const base = dependencies()
      expect(await runHandoff({ uid: 'claude:a', to: 'codex', dryRun }, dependencies({
        openDb: () => ({ close() { closes++; if (stage === 'close') throw new Error('close broke') } }) as never,
        buildHandoffPlan: (...args) => {
          if (stage === 'plan') throw new Error('plan broke\u001b[2J')
          return base.buildHandoffPlan(...args)
        },
        runPlan: async () => { runs++; return 0 },
        log: (m) => logs.push(m), error: (m) => errors.push(m),
      }))).toBe(1)
      expect(closes).toBe(1)
      expect(runs).toBe(0)
      expect(logs).toEqual([])
      expect(errors.join('')).toContain(stage)
      expect(errors.join('')).not.toContain('\u001b')
    }
  }
})

test('an intent resolves to its canned preamble, a note is passed through as-is, and neither defaults to none', async () => {
  const cases: [Partial<HandoffOptions>, string | undefined][] = [
    [{}, undefined],
    [{ intent: 'continue' }, undefined],
    [{ intent: 'review' }, 'Review this session'],
    [{ note: 'focus on the retry logic' }, 'focus on the retry logic'],
  ]
  for (const [extra, expected] of cases) {
    let seenPreamble: string | undefined = 'unset'
    const code = await runHandoff({ uid: 'claude:a', to: 'codex', ...extra }, dependencies({
      buildHandoffPlan: (...args) => {
        seenPreamble = args[4]?.preamble
        return {
          ok: true,
          plan: { kind: 'brief', cmd: 'codex', args: ['brief'], cwd: '/work/project', prompt: 'brief' },
          briefChars: 5,
        }
      },
    }))
    expect(code).toBe(0)
    if (expected === undefined) expect(seenPreamble).toBeUndefined()
    else expect(seenPreamble).toContain(expected)
  }
})

test('dry-run passes the budget through and skips executable availability checks', async () => {
  for (const maxChars of [undefined, 0, 1000]) {
    const base = dependencies()
    expect(await runHandoff({ uid: 'claude:a', to: 'codex', maxChars, dryRun: true }, dependencies({
      buildHandoffPlan: (...args) => {
        expect(args[1]).toBe('claude:a')
        expect(args[2]).toBe('codex')
        expect(args[4]).toEqual({ maxChars })
        return base.buildHandoffPlan(...args)
      },
      checkPlan: () => { throw new Error('must not check') },
      runPlan: async () => { throw new Error('must not launch') },
    }))).toBe(0)
  }
})

test('handoff catches setup, validation, and launch exceptions with bounded diagnostics', async () => {
  const fail = () => { throw new Error('failure\u001b[2J' + 'x'.repeat(1000)) }
  const cases: Partial<HandoffDependencies>[] = [
    { indexExists: fail }, { needsConsent: fail }, { buildAdapters: fail },
    { openDb: fail }, { checkPlan: fail }, { runPlan: fail },
    { buildHandoffPlan: () => ({ ok: false, reason: 'bad\u001b[2J' + 'x'.repeat(1000) }) },
  ]
  for (const overrides of cases) {
    const errors: string[] = []
    expect(await runHandoff({ uid: 'claude:a', to: 'codex' }, dependencies({
      ...overrides, error: (m) => errors.push(m),
    }))).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.length).toBeLessThan(600)
    expect(errors[0]).not.toContain('\u001b')
  }
})

test('handoff closes SQLite before validating and launching the target client', async () => {
  const order: string[] = []
  const plan: ExecPlan = {
    kind: 'brief', cmd: 'opencode', args: ['brief'], cwd: '/work/project', prompt: 'brief',
  }
  const code = await runHandoff({ uid: 'claude:a', to: 'opencode' }, dependencies({
    openDb: () => ({ close: () => { order.push('close') } }) as never,
    buildHandoffPlan: () => ({ ok: true, plan, briefChars: 5 }),
    checkPlan: (value) => { order.push('check'); expect(value).toEqual(plan); return { ok: true } },
    runPlan: async (value) => { order.push('run'); expect(value).toEqual(plan); return 9 },
  }))
  expect(code).toBe(9)
  expect(order).toEqual(['close', 'check', 'run'])
})

test('handoff prints the planned command with --dry-run instead of launching', async () => {
  const plan: ExecPlan = {
    kind: 'brief', cmd: 'codex', args: ['handover text'], cwd: '/work/project', prompt: 'handover text',
  }
  const logs: string[] = []
  let ran = false
  const code = await runHandoff({ uid: 'claude:a', to: 'codex', dryRun: true }, dependencies({
    buildHandoffPlan: () => ({ ok: true, plan, briefChars: 13 }),
    shellQuote: (value) => {
      expect(value).toEqual(plan)
      return "cd '/work/project' && codex 'handover text'"
    },
    log: (message) => logs.push(message),
    runPlan: async () => { ran = true; return 0 },
  }))
  expect(code).toBe(0)
  expect(ran).toBe(false)
  expect(logs).toEqual(["cd '/work/project' && codex 'handover text'"])
})

test('handoff --dry-run --json reports the plan and brief size as JSON', async () => {
  const plan: ExecPlan = {
    kind: 'brief', cmd: 'codex', args: ['handover text'], cwd: '/work/project', prompt: 'handover text',
  }
  const logs: string[] = []
  const code = await runHandoff({ uid: 'claude:a', to: 'codex', dryRun: true, json: true }, dependencies({
    buildHandoffPlan: () => ({ ok: true, plan, briefChars: 13 }),
    log: (message) => logs.push(message),
  }))
  expect(code).toBe(0)
  expect(JSON.parse(logs[0]!)).toEqual({
    cmd: 'codex', args: ['handover text'], cwd: '/work/project', briefChars: 13,
  })
})

test('handoff asks for a uid and a target when either is missing', async () => {
  const errors: string[] = []
  expect(await runHandoff({}, dependencies({ error: (m) => errors.push(m) }))).toBe(2)
  expect(errors).toEqual(['usage: nekyia handoff <uid> --to <client>'])

  errors.length = 0
  expect(await runHandoff({ uid: 'claude:a' }, dependencies({ error: (m) => errors.push(m) }))).toBe(2)
  expect(errors).toEqual(['usage: nekyia handoff <uid> --to <client>'])
})

test('handoff rejects a malformed uid and an invalid character budget', async () => {
  const errors: string[] = []
  expect(await runHandoff(
    { uid: 'malformed', to: 'codex' }, dependencies({ error: (m) => errors.push(m) }),
  )).toBe(2)
  expect(errors).toEqual(['error: malformed uid: malformed'])

  errors.length = 0
  expect(await runHandoff(
    { uid: 'claude:a', to: 'codex', maxChars: -1 }, dependencies({ error: (m) => errors.push(m) }),
  )).toBe(2)
  expect(errors).toEqual(['error: --max-chars must be a non-negative integer'])
})

test('handoff reports a planning failure without launching', async () => {
  const errors: string[] = []
  let ran = false
  const code = await runHandoff({ uid: 'claude:a', to: 'codex' }, dependencies({
    buildHandoffPlan: () => ({ ok: false, reason: 'no adapter for codex' }),
    runPlan: async () => { ran = true; return 0 },
    error: (m) => errors.push(m),
  }))
  expect(code).toBe(1)
  expect(ran).toBe(false)
  expect(errors).toEqual(['no adapter for codex'])
})

test('handoff returns launch validation errors without spawning', async () => {
  const errors: string[] = []
  let ran = false
  const code = await runHandoff({ uid: 'claude:a', to: 'codex' }, dependencies({
    checkPlan: () => ({ ok: false, reason: 'codex was not found or is not executable' }),
    runPlan: async () => { ran = true; return 0 },
    error: (m) => errors.push(m),
  }))
  expect(code).toBe(1)
  expect(ran).toBe(false)
  expect(errors).toEqual(['codex was not found or is not executable'])
})

test('handoff refuses absent indexes and invalid consent without opening the index', async () => {
  for (const state of [
    { exists: false, consent: false, expected: 'index not found' },
    { exists: true, consent: true, expected: 'consent' },
  ]) {
    const errors: string[] = []
    let opens = 0
    const code = await runHandoff({ uid: 'claude:a', to: 'codex' }, dependencies({
      indexExists: () => state.exists,
      needsConsent: () => state.consent,
      openDb: () => { opens++; throw new Error('must not open') },
      error: (m) => errors.push(m),
    }))
    expect(code).toBe(1)
    expect(opens).toBe(0)
    expect(errors.join(' ')).toContain(state.expected)
  }
})

test('handoff refuses to run when a client manifest is invalid', async () => {
  const errors: string[] = []
  const code = await runHandoff({ uid: 'claude:a', to: 'codex' }, dependencies({
    buildAdapters: () => ({
      adapters: [],
      diagnostics: [{ client: 'kilo', level: 'error', path: null, message: 'unknown format' }],
    }),
    runPlan: async () => { throw new Error('must not launch on a broken manifest set') },
    error: (m) => errors.push(m),
  }))
  expect(code).toBe(1)
  expect(errors).toEqual(['client manifests are invalid; run "nekyia doctor" for details'])
})
