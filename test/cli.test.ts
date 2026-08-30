import { afterAll, expect, test } from 'bun:test'
import Database from 'bun:sqlite'
import { versionText } from '../src/cli'
import { parseSince } from '../src/commands/timeline'
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
  expect(publicRow.fingerprint).toBeUndefined()
  expect(publicRow.missing).toBeUndefined()
  // Provenance is published so that an agent given this JSON can read the raw
  // transcript itself. It stays a list: a session can span several files.
  expect(Array.isArray(publicRow.sourcePaths)).toBe(true)
  expect(publicRow.sourcePaths).toEqual([
    join(FIX, 'claude', 'projects', '-root-proj', '11111111-2222-3333-4444-555555555555.jsonl'),
  ])
  // The table stays exactly what it was: provenance is a JSON-only field.
  expect(out.stdout.toString()).not.toContain('.jsonl')

  const blamed = run(['blame', '/root/proj/src/sse.ts'], env)
  expect(blamed.exitCode).toBe(0)
  expect(blamed.stdout.toString()).toContain('sse reconnect')

  const blamedJson = run(['blame', '/root/proj/src/sse.ts', '--json'], env)
  expect(blamedJson.exitCode).toBe(0)
  const blamedRows = JSON.parse(blamedJson.stdout.toString())
  expect(blamedRows).toHaveLength(1)
  expect(blamedRows[0].uid).toBe('claude:11111111-2222-3333-4444-555555555555')

  // A path nothing touched matches nothing, and says so the way search does.
  const empty = run(['blame', '/root/proj/src/nothing-here.ts'], env)
  expect(empty.exitCode).toBe(0)
  expect(empty.stdout.toString()).toBe('')
  expect(empty.stderr.toString()).toContain('no sessions matched')

  // The root has no basename to prefilter on, and no facet can ever equal it.
  const root = run(['blame', '/', '--json'], env)
  expect(root.exitCode).toBe(0)
  expect(JSON.parse(root.stdout.toString())).toEqual([])
})

test('blame is a strict global recent file-search shorthand', () => {
  const env = environment()
  for (const args of [
    ['blame'],
    ['blame', 'one.ts', 'two.ts'],
    ['blame', 'one.ts', '--all'],
    ['blame', 'one.ts', '--sort', 'recent'],
    ['blame', 'one.ts', '--file', 'two.ts'],
    ['blame', 'one.ts', '--limit', 'wat'],
    ['blame', 'one.ts', '--rebuild'],
    ['blame', 'one\u0001.ts'],
  ]) {
    const result = run(args, env)
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain('error:')
  }
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

test('a newly excluded session is deleted from the index, not just flagged missing', async () => {
  const db = IndexDb.open(':memory:')
  const secret: SessionRef = {
    uid: 'claude:secret', client: 'claude', nativeId: 'secret', cwd: '/root/secret/proj',
    gitBranch: null, title: 'secret', startedAt: 1, endedAt: 2, turns: 1,
    parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: ['/secret'],
    fingerprint: 'one',
  }
  db.upsertHydrated({ ref: secret, prompts: ['confidential handover'], prose: [], files: [], truncated: false })
  const adapter: Adapter = {
    id: 'claude', manifest: {} as Adapter['manifest'], detect: () => true,
    discover: async () => ({ refs: [secret], authoritative: true, diagnostics: [] }),
    hydrate: async () => { throw new Error('not reached') }, plan: () => null,
  }

  const code = await reindexWith(db, { ...DEFAULT_CONFIG, exclude: ['/root/secret/**'] }, {
    adapters: [adapter], diagnostics: [],
  }, { quiet: true })

  expect(code).toBe(0)
  expect(db.getRef(secret.uid)).toBeNull()
  expect(db.allUids()).toEqual([])
  expect(db.ftsSearch('confidential')).toEqual([])
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

test('since accepts the spans relTime prints', () => {
  const now=Date.parse('2026-08-30T12:00:00Z')
  expect(parseSince('2d', now)).toBe(now - 2*86_400_000)
  expect(parseSince('30m', now)).toBe(now - 30*60_000)
  expect(parseSince('3w', now)).toBe(now - 21*86_400_000)
  expect(parseSince('2026-08-01', now)).toBe(Date.parse('2026-08-01T00:00:00Z'))
})
test('since rejects what it cannot read', () => {
  expect(() => parseSince('yesterday')).toThrow('--since')
})
test('timeline rejects a positional argument', () => {
  const result = run(['timeline', 'src/sse.ts'])
  expect(result.exitCode).toBe(2)
  expect(result.stderr.toString()).toContain('error:')
})
test('timeline rejects flags it cannot honour', () => {
  const result = run(['timeline', '--sort', 'recent'])
  expect(result.exitCode).toBe(2)
  expect(result.stderr.toString()).toContain('error:')
})
test('timeline rejects a since it cannot read', () => {
  const result = run(['timeline', '--since', 'yesterday'])
  expect(result.exitCode).toBe(2)
  expect(result.stderr.toString()).toContain('--since')
})

// `timeline` is the first command to read the file-event tables through
// `IndexDb.openReadonly`, which never migrates. Nothing else in the suite
// opens an index stamped below schema version 4 and then reads through it,
// so the below-version-4 guards in `fileDetailsFor`, `fileEventsFor`, and
// `uidsUnderPrefix` were never exercised. This reuses the downgrade technique
// `test/privacy.test.ts`'s `downgradeIndex` uses for `forget` and `prune`:
// drop what schema version 4 added and restamp `schema_version`, the shape a
// real index has before its first reindex after this upgrade, then run the
// command itself and check it answers instead of throwing.
test('timeline runs cleanly against an index stamped below schema version 4', () => {
  const env = environment()
  expect(run(['index', '--yes', '--quiet'], env).exitCode).toBe(0)

  const dbPath = join(env.XDG_DATA_HOME, 'nekyia', 'index.db')
  const raw = new Database(dbPath)
  try {
    raw.exec('DROP TABLE IF EXISTS session_file_event')
    raw.exec('DROP TABLE IF EXISTS session_turn')
    raw.exec('ALTER TABLE session DROP COLUMN file_events_truncated')
    raw.exec('ALTER TABLE session DROP COLUMN file_detail')
    raw.query('UPDATE meta SET value = ? WHERE key = ?').run('2', 'schema_version')
  } finally {
    raw.close()
  }

  const result = run(['timeline', '--dir', '/root/proj'], env)
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe('')
  // Below schema version 4 the file-event tables and columns are gone, so
  // every session reads back as `unknown` detail rather than throwing.
  expect(result.stdout.toString()).toContain('sessions indexed before file events')
  expect(result.stdout.toString()).toContain(
    'indexed before file events; "nekyia index --rebuild" fills this in',
  )
})

test('timeline --json prints one shape whether or not an index exists', () => {
  const env = environment()
  const absent = run(['timeline', '--dir', '/root/proj', '--json'], env)
  expect(absent.exitCode).toBe(0)
  // A caller reaching `.sessions` must not have to learn first whether an
  // index exists; an array here would crash it.
  expect(JSON.parse(absent.stdout.toString())).toEqual({
    dir: '/root/proj', since: null, git: { consulted: false }, sessions: [],
  })

  expect(run(['index', '--yes', '--quiet'], env).exitCode).toBe(0)
  const present = JSON.parse(
    run(['timeline', '--dir', '/root/proj', '--json'], env).stdout.toString(),
  ) as Record<string, unknown>
  expect(Object.keys(present).sort()).toEqual(['dir', 'git', 'sessions', 'since'])
  expect((present.sessions as unknown[]).length).toBeGreaterThan(0)
  // Every session says whether the transcript it was read from is still there.
  for (const session of present.sessions as Array<Record<string, unknown>>) {
    expect(typeof session.missing).toBe('boolean')
  }
})

// The remediation `timeline` prints has to be the command that actually helps.
// `scan` decides what to hydrate from fingerprints alone, so a session whose
// transcript has not changed is skipped however stale its file detail is.
test('a plain index leaves migrated sessions unknown; --rebuild is what fills them in', async () => {
  const db = IndexDb.open(':memory:')
  const ref: SessionRef = {
    uid: 'claude:stale', client: 'claude', nativeId: 'stale', cwd: '/root/proj',
    gitBranch: null, title: 'before file events', startedAt: 1, endedAt: 2, turns: 1,
    parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: ['/old'],
    fingerprint: 'unchanged',
  }
  // A version 3 index held paths and nothing else, and the migration to 4 adds
  // the column at its default rather than filling it in, so every existing row
  // reads `unknown` until something re-hydrates it.
  db.upsertHydrated({ ref, prompts: [], prose: [], files: ['/root/proj/a.ts'], truncated: false })
  db.raw().query("UPDATE session SET file_detail = 'unknown' WHERE uid = ?").run(ref.uid)
  expect(db.fileDetailsFor([ref.uid]).get(ref.uid)?.detail).toBe('unknown')

  const adapter: Adapter = {
    id: 'claude', manifest: {} as Adapter['manifest'], detect: () => true,
    discover: async () => ({ refs: [ref], diagnostics: [], authoritative: true }),
    hydrate: async (seen) => ({
      ref: seen, prompts: [], prose: [], files: ['/root/proj/a.ts'],
      fileEvents: [{ path: '/root/proj/a.ts', kind: 'edit' as const, turn: 0 }],
      fileDetail: 'ordered' as const, truncated: false,
    }),
    plan: () => null,
  }
  const set = { adapters: [adapter], diagnostics: [] }

  expect(await reindexWith(db, DEFAULT_CONFIG, set, { quiet: true })).toBe(0)
  expect(db.fileDetailsFor([ref.uid]).get(ref.uid)?.detail).toBe('unknown')

  expect(await reindexWith(db, DEFAULT_CONFIG, set, { rebuild: true, quiet: true })).toBe(0)
  expect(db.fileDetailsFor([ref.uid]).get(ref.uid)?.detail).toBe('ordered')
  db.close()
})

test('version names the release and where it came from', () => {
  const plain = versionText('1.2.3', (text, url) => `${text} <${url}>`)
  expect(plain).toContain('nekyia 1.2.3')
  expect(plain).toContain('Find the session. Pick up the thread.')
  expect(plain).toContain('Aranea Development <https://aranea-development.nl>')
  expect(plain).toContain('AraneaDev/Nekyia <https://github.com/AraneaDev/Nekyia>')
  // The myth is one sentence, not a paragraph competing with the version.
  expect(plain.split('\n').length).toBeLessThanOrEqual(10)
})
