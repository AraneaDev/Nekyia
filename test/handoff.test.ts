import { afterEach, expect, test } from 'bun:test'
import { buildAdapter } from '../src/core/adapter'
import { buildBrief } from '../src/core/brief'
import { IndexDb } from '../src/core/db'
import { buildHandoffPlan, preambleForIntent } from '../src/core/handoff'
import { validateManifest } from '../src/manifests/load'
import type { SessionRef } from '../src/types'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const databases: IndexDb[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

test('every built-in brief template delivers context using its interactive prompt contract', () => {
  const prompt = 'Historical context 🧪\nquoted \'text\' and {cwd} stay literal'
  const cwd = '/work/source project'
  const expected: Record<string, string[]> = {
    claude: [prompt], codex: [prompt], agy: ['--prompt-interactive', prompt],
    copilot: ['--interactive', prompt], opencode: ['--prompt', prompt],
    kilo: ['--prompt', prompt], codebuff: ['--cwd', cwd, prompt],
    goose: ['run', '-t', prompt, '-s'],
  }
  const directory = join(import.meta.dir, '../src/manifests/builtin')
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    const manifest = validateManifest(JSON.parse(readFileSync(join(directory, file), 'utf8')))
    const target = buildAdapter(manifest)
    expect(target.plan({ nativeId: 'source-id', cwd }, prompt)).toEqual({
      kind: 'brief', cmd: manifest.id, args: expected[manifest.id], cwd, prompt,
    })
  }
})

function seed(hydrated = true) {
  const db = IndexDb.open(':memory:')
  databases.push(db)
  const ref: SessionRef = {
    uid: 'claude:a', client: 'claude', nativeId: 'a', cwd: '/root/proj', gitBranch: 'main',
    title: 'Fix reconnect', startedAt: 0, endedAt: 1800000000000, turns: 2,
    parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: [], fingerprint: 'f',
  }
  db.upsertRef(ref)
  if (hydrated) db.upsertDoc({
    ref, prompts: ['fix reconnect 🧪\nthen test it'], prose: ['old reply\n'.repeat(400), 'latest reply'],
    files: ['src/sse.ts'], truncated: false,
  })
  return db
}

function adapter(id = 'codex', brief = true) {
  return buildAdapter(validateManifest({
    schema: 1, id, name: id, roots: ['/nonexistent'], format: 'jsonl-transcript', tier: 'resume',
    jsonl: { glob: '*.jsonl', variant: 'codex' },
    resume: { cmd: id, args: ['resume', '{id}'], cwd: '{cwd}' },
    ...(brief ? { brief: { cmd: id, args: ['{prompt}'], cwd: '{cwd}' } } : {}),
  }))
}

test('review asks the target to critique rather than continue; continue adds nothing', () => {
  expect(preambleForIntent('continue')).toBeUndefined()
  const review = preambleForIntent('review')
  expect(review).toBeDefined()
  expect(review!.toLowerCase()).toContain('review')
  expect(review!.toLowerCase()).toContain('critic')
})

test('handoff\'s preamble option threads a review intent into the launched plan\'s prompt', () => {
  const db = seed()
  const result = buildHandoffPlan(db, 'claude:a', 'codex', [adapter()], { preamble: preambleForIntent('review') })
  if (!result.ok) throw new Error(result.reason)
  expect(result.plan.prompt).toStartWith(preambleForIntent('review')!)
  expect(result.plan.prompt).toContain('fix reconnect 🧪\nthen test it')
})

test('handoff starts fresh in the source directory for both cross-client and same-client targets', () => {
  const db = seed()
  for (const id of ['codex', 'claude']) {
    const target = adapter(id)
    expect(target.detect()).toBe(false)
    const result = buildHandoffPlan(db, 'claude:a', id, [target])
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    const brief = buildBrief(db, 'claude:a')!
    expect(result).toEqual({
      ok: true, briefChars: brief.length,
      plan: { kind: 'brief', cmd: id, args: [brief], prompt: brief, cwd: '/root/proj' },
    })
  }
})

test('handoff preserves every prompt for impossible and zero budgets, and meets feasible budgets', () => {
  const db = seed()
  for (const maxChars of [0, 200, 1000]) {
    const result = buildHandoffPlan(db, 'claude:a', 'codex', [adapter()], { maxChars })
    if (!result.ok) throw new Error(result.reason)
    expect(result.plan.prompt).toBe(buildBrief(db, 'claude:a', { maxChars })!)
    expect(result.plan.prompt).toContain('fix reconnect 🧪\nthen test it')
    expect(result.briefChars).toBe(result.plan.prompt!.length)
    if (maxChars === 1000) expect(result.briefChars).toBeLessThanOrEqual(maxChars)
    else expect(result.plan.prompt).toContain('all prompts were retained')
  }
})

test('handoff reports absent source, unknown target, and unhydrated source', () => {
  const db = seed(false)
  expect(buildHandoffPlan(db, 'claude:missing', 'codex', [adapter()]))
    .toEqual({ ok: false, reason: 'no session with uid claude:missing' })
  expect(buildHandoffPlan(db, 'claude:a', 'unknown', [adapter()]))
    .toEqual({ ok: false, reason: 'no adapter for unknown' })
  expect(buildHandoffPlan(db, 'claude:a', 'codex', [adapter()]))
    .toEqual({ ok: false, reason: 'nothing indexed for this session yet' })
})

test('handoff rejects absent brief templates, unusable cwd, and a target returning native resume', () => {
  const db = seed()
  for (const target of [adapter('codex', false), {
    ...adapter(), plan: () => ({ kind: 'resume' as const, cmd: 'codex', args: ['resume', 'a'], cwd: '/root/proj' }),
  }]) {
    expect(buildHandoffPlan(db, 'claude:a', 'codex', [target]))
      .toEqual({ ok: false, reason: 'this session cannot be launched' })
  }
  db.raw().run('UPDATE session SET cwd = NULL WHERE uid = ?', ['claude:a'])
  expect(buildHandoffPlan(db, 'claude:a', 'codex', [adapter()]))
    .toEqual({ ok: false, reason: 'this session cannot be launched' })
})
