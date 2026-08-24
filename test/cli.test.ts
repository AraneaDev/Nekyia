import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/config'
import type { Adapter } from '../src/core/adapter'
import { IndexDb } from '../src/core/db'
import { reindexWith, safeOverrideRoot } from '../src/commands/reindex'
import type { SessionRef } from '../src/types'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const FIX = join(import.meta.dir, 'fixtures')
const temporaries: string[] = []

function environment() {
  const tmp = mkdtempSync(join(tmpdir(), 'nekyia-cli-'))
  temporaries.push(tmp)
  return {
    XDG_CONFIG_HOME: join(tmp, 'config'),
    XDG_DATA_HOME: join(tmp, 'data'),
    NEKYIA_ROOT_OVERRIDE: FIX,
  }
}

function run(args: string[], env: Record<string, string | undefined> = {}) {
  return Bun.spawnSync(['bun', CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

afterAll(() => {
  for (const tmp of temporaries) rmSync(tmp, { recursive: true, force: true })
})

test('index then search finds a session across clients', () => {
  const env = environment()
  const idx = run(['index', '--yes'], env)
  expect(idx.exitCode).toBe(0)
  expect(idx.stdout.toString()).toBe('')
  expect(idx.stderr.toString()).toContain('sessions')

  const out = run(['search', 'reconnect', '--all'], env)
  expect(out.exitCode).toBe(0)
  expect(out.stdout.toString()).toContain('sse reconnect')

  const json = run(['search', 'reconnect', '--all', '--json'], env)
  expect(json.exitCode).toBe(0)
  const publicRow = JSON.parse(json.stdout.toString())[0]
  expect(publicRow.client).toBe('claude')
  expect(publicRow.sourcePaths).toBeUndefined()
  expect(publicRow.fingerprint).toBeUndefined()
  expect(publicRow.missing).toBeUndefined()
})

test('search without an index is clean and does not create a database', () => {
  const env = environment()
  const dbPath = join(env.XDG_DATA_HOME, 'nekyia', 'index.db')
  const plain = run(['search', 'anything', '--all'], env)
  expect(plain.exitCode).toBe(0)
  expect(plain.stderr.toString()).toContain('index')
  expect(existsSync(dbPath)).toBe(false)

  const json = run(['search', 'anything', '--all', '--json'], env)
  expect(json.exitCode).toBe(0)
  expect(json.stdout.toString().trim()).toBe('[]')
  expect(existsSync(dbPath)).toBe(false)
})

test('fixture override accepts one contained segment and rejects traversal and escaping symlinks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nekyia-root-'))
  temporaries.push(tmp)
  const base = join(tmp, 'fixtures')
  const outside = join(tmp, 'outside')
  mkdirSync(join(base, 'safe'), { recursive: true })
  mkdirSync(outside)
  symlinkSync(outside, join(base, 'escape'))
  expect(safeOverrideRoot(base, 'safe')).toBe(join(base, 'safe'))
  expect(safeOverrideRoot(base, '../outside')).toBeNull()
  expect(safeOverrideRoot(base, 'nested/client')).toBeNull()
  expect(safeOverrideRoot(base, 'escape')).toBeNull()
})

test('rebuild preserves old searchable data on hydration failure and retries it later', async () => {
  const db = IndexDb.open(':memory:')
  const old: SessionRef = {
    uid: 'claude:retry', client: 'claude', nativeId: 'retry', cwd: '/root/proj',
    gitBranch: null, title: 'old title', startedAt: 1, endedAt: 2, turns: 1,
    parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: ['/old'],
    fingerprint: 'old-fingerprint',
  }
  db.upsertHydrated({ ref: old, prompts: ['old searchable prompt'], prose: [], files: [], truncated: false })
  const fresh = { ...old, title: 'new title', fingerprint: 'new-fingerprint', sourcePaths: ['/new'] }
  let fail = true
  const adapter: Adapter = {
    id: 'claude', manifest: {} as Adapter['manifest'], detect: () => true,
    discover: async () => ({ refs: [fresh], diagnostics: [], authoritative: true }),
    hydrate: async (ref) => {
      if (fail) throw new Error('temporary read failure')
      return { ref, prompts: ['new searchable prompt'], prose: [], files: [], truncated: false }
    },
    plan: () => null,
  }

  expect(await reindexWith(db, DEFAULT_CONFIG, { adapters: [adapter], diagnostics: [] }, {
    rebuild: true, quiet: true,
  })).toBe(1)
  expect(db.getRef(old.uid)?.fingerprint).toBe('old-fingerprint')
  expect(db.ftsSearch('old').map((hit) => hit.uid)).toEqual([old.uid])

  fail = false
  expect(await reindexWith(db, DEFAULT_CONFIG, { adapters: [adapter], diagnostics: [] }, {
    rebuild: true, quiet: true,
  })).toBe(0)
  expect(db.getRef(old.uid)?.fingerprint).toBe('new-fingerprint')
  expect(db.ftsSearch('new').map((hit) => hit.uid)).toEqual([old.uid])
  db.close()
})

test('partial rebuild discovery never destroys an unseen indexed session', async () => {
  const db = IndexDb.open(':memory:')
  const old: SessionRef = {
    uid: 'claude:kept', client: 'claude', nativeId: 'kept', cwd: '/root/proj',
    gitBranch: null, title: 'kept', startedAt: 1, endedAt: 2, turns: 1,
    parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: ['/old'],
    fingerprint: 'old',
  }
  db.upsertHydrated({ ref: old, prompts: ['still searchable'], prose: [], files: [], truncated: false })
  const partial: Adapter = {
    id: 'claude', manifest: {} as Adapter['manifest'], detect: () => true,
    discover: async () => ({
      refs: [], authoritative: false,
      diagnostics: [{ client: 'claude', level: 'warn', path: '/old', message: 'partial read' }],
    }),
    hydrate: async () => { throw new Error('not reached') }, plan: () => null,
  }
  expect(await reindexWith(db, DEFAULT_CONFIG, { adapters: [partial], diagnostics: [] }, {
    rebuild: true, quiet: true,
  })).toBe(0)
  expect(db.getRef(old.uid)?.missing).toBe(false)
  expect(db.ftsSearch('still').map((hit) => hit.uid)).toEqual([old.uid])
  db.close()
})

test('manifest construction errors abort before normal or rebuild indexing mutates old data', async () => {
  for (const rebuild of [false, true]) {
    const db = IndexDb.open(':memory:')
    const old: SessionRef = {
      uid: 'broken:kept', client: 'broken', nativeId: 'kept', cwd: '/root/proj',
      gitBranch: null, title: 'kept', startedAt: 1, endedAt: 2, turns: 1,
      parentNativeId: null, tier: 'search', origin: 'user-manifest', sourcePaths: ['/old'],
      fingerprint: 'old-fingerprint',
    }
    db.upsertHydrated({
      ref: old, prompts: ['old visible prompt'], prose: [], files: [], truncated: false,
    })

    const code = await reindexWith(db, DEFAULT_CONFIG, {
      adapters: [],
      diagnostics: [{
        client: 'broken', level: 'error', path: '/manifest.json',
        message: 'user manifest rejected',
      }],
    }, { rebuild, quiet: true })

    expect(code).toBe(1)
    expect(db.getRef(old.uid)?.missing).toBe(false)
    expect(db.getRef(old.uid)?.fingerprint).toBe('old-fingerprint')
    expect(db.ftsSearch('visible').map((hit) => hit.uid)).toEqual([old.uid])
    db.close()
  }
})

test('quiet indexing suppresses progress and summary', () => {
  const result = run(['index', '--yes', '--quiet'], environment())
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe('')
})

test('an unknown subcommand exits non-zero with usage', () => {
  const result = run(['frobnicate'])
  expect(result.exitCode).toBe(2)
  expect(result.stderr.toString()).toContain('usage')
})

test('last is strict and an absent index is non-creating', () => {
  const env = environment()
  const dbPath = join(env.XDG_DATA_HOME, 'nekyia', 'index.db')
  const absent = run(['last'], env)
  expect(absent.exitCode).toBe(1)
  expect(absent.stderr.toString()).toContain('index not found')
  expect(existsSync(dbPath)).toBe(false)

  for (const args of [['last', 'extra'], ['last', '--all'], ['last', '--json']]) {
    const invalid = run(args, env)
    expect(invalid.exitCode).toBe(2)
    expect(invalid.stderr.toString()).toContain('last does not accept')
    expect(existsSync(dbPath)).toBe(false)
  }
})

test('invalid option values and parse errors are clean CLI failures', () => {
  for (const args of [
    ['search', '--sort', 'random'],
    ['search', '--limit', 'wat'],
    ['search', '--limit', '-1'],
    ['search', '--client'],
    ['search', '--unknown'],
    ['index', 'extra'],
  ]) {
    const result = run(args)
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain('error:')
  }
})

test('help prints usage and a bare non-TTY invocation rejects the picker cleanly', () => {
  for (const args of [['--help'], ['-h']]) {
    const result = run(args)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('usage:')
  }
  const bare = run([])
  expect(bare.exitCode).toBe(1)
  expect(bare.stderr.toString()).toContain('interactive terminal')
})

test('show prints an indexed handover and accepts a character budget', () => {
  const env = environment()
  expect(run(['index', '--yes', '--quiet'], env).exitCode).toBe(0)
  const result = run([
    'show', 'claude:11111111-2222-3333-4444-555555555555', '--max-chars', '40000',
  ], env)
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain('Handover from a previous session')
  expect(result.stdout.toString()).toContain('fix the sse reconnect race')
})

test('show without an index is non-creating and unknown sessions are reported', () => {
  const env = environment()
  const dbPath = join(env.XDG_DATA_HOME, 'nekyia', 'index.db')
  const absent = run(['show', 'claude:anything'], env)
  expect(absent.exitCode).toBe(1)
  expect(absent.stderr.toString()).toContain('index not found')
  expect(existsSync(dbPath)).toBe(false)

  expect(run(['index', '--yes', '--quiet'], env).exitCode).toBe(0)
  const unknown = run(['show', 'claude:nope'], env)
  expect(unknown.exitCode).toBe(1)
  expect(unknown.stderr.toString()).toContain('no session with uid claude:nope')
})

test('show rejects missing or malformed uids and invalid budgets cleanly', () => {
  for (const args of [
    ['show'],
    ['show', 'malformed'],
    ['show', ':empty-client'],
    ['show', 'empty-native:'],
    ['show', 'claude:bad\u001b[2J'],
    ['show', 'claude:a', '--max-chars', '-1'],
    ['show', 'claude:a', '--max-chars', '1.5'],
    ['show', 'claude:a', '--max-chars', 'NaN'],
    ['show', 'claude:a', '--max-chars', 'Infinity'],
    ['show', 'claude:a', 'extra'],
  ]) {
    const result = run(args, environment())
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain(args.length === 1 ? 'usage:' : 'error:')
  }
})
