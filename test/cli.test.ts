import { afterAll, expect, spyOn, test } from 'bun:test'
import Database from 'bun:sqlite'
import { main, planCli, versionText } from '../src/cli'
import { parseSince } from '../src/commands/timeline'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

test('a client whose hydration failed does not get its extraction policy recorded', async () => {
  // The recorded value is a claim that the stored documents were produced by
  // that policy. Writing it after a failed read would make the claim false and,
  // worse, permanent: the source has not changed either, so nothing would ever
  // ask again. The client keeps its old value and is retried instead.
  const db = IndexDb.open(':memory:')
  const ref: SessionRef = {
    uid: 'claude:one', client: 'claude', nativeId: 'one', cwd: '/root/proj',
    gitBranch: null, title: 'one', startedAt: 1, endedAt: 2, turns: 1,
    parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: ['/one'],
    fingerprint: 'one:1',
  }
  let fail = false
  const adapter: Adapter = {
    id: 'claude', manifest: {} as Adapter['manifest'], detect: () => true,
    discover: async () => ({ refs: [ref], diagnostics: [], authoritative: true }),
    hydrate: async (seen) => {
      if (fail) throw new Error('unreadable')
      return { ref: seen, prompts: ['kept'], prose: [], files: [], truncated: false }
    },
    plan: () => null,
  }
  const set = { adapters: [adapter], diagnostics: [] }

  const small = { ...DEFAULT_CONFIG, maxFileBytes: 1_024 }
  expect(await reindexWith(db, small, set, { quiet: true })).toBe(0)
  const recorded = db.getExtraction('claude')
  expect(recorded).not.toBeNull()

  // The cap moves, so every session is due a re-read, and the re-read fails.
  fail = true
  const large = { ...DEFAULT_CONFIG, maxFileBytes: 64 * 1_024 * 1_024 }
  expect(await reindexWith(db, large, set, { quiet: true })).toBe(1)
  expect(db.getExtraction('claude')).toBe(recorded)

  // Which means the next run still knows there is work to do.
  fail = false
  expect(await reindexWith(db, large, set, { quiet: true })).toBe(0)
  expect(db.getExtraction('claude')).not.toBe(recorded)
  db.close()
  db.close()
})

// The argument contract, as a decision rather than a process.
//
// Everything above drives the CLI through `Bun.spawnSync`, which proves the
// binary works but can only see an exit code and whatever reached stderr. A
// rejection asserted as "exit 2" passes even when the wrong rule fired with
// the wrong message, and an accepted invocation says nothing at all about the
// options it built. `planCli` is the same decision without the process, so
// these tests can name the rule and read the options.

test('planCli reads the invocations that never reach a command', () => {
  expect(planCli(['--help'])).toEqual({ kind: 'usage' })
  expect(planCli(['-h'])).toEqual({ kind: 'usage' })
  expect(planCli(['--version'])).toEqual({ kind: 'version' })
  expect(planCli(['-v'])).toEqual({ kind: 'version' })
  expect(planCli(['version'])).toEqual({ kind: 'version' })
  expect(planCli([])).toEqual({ kind: 'pick' })
  expect(planCli(['frobnicate'])).toEqual({ kind: 'unknown', command: 'frobnicate' })
})

test('planCli scopes a bare search to the working directory and --all clears it', () => {
  expect(planCli(['search', 'sse', 'reconnect'], '/work')).toEqual({
    kind: 'search',
    options: {
      text: 'sse reconnect',
      cwd: '/work',
      client: undefined,
      file: undefined,
      sort: undefined,
      limit: undefined,
      json: false,
    },
  })
  const everywhere = planCli(['search', 'sse', '--all'], '/work')
  expect(everywhere.kind).toBe('search')
  expect(everywhere.kind === 'search' && everywhere.options.cwd).toBeUndefined()
})

test('planCli turns blame into a global newest-first search for one resolved file', () => {
  expect(planCli(['blame', 'src/sse.ts', '--limit', '5'], '/work')).toEqual({
    kind: 'search',
    options: {
      exactFile: '/work/src/sse.ts',
      client: undefined,
      limit: 5,
      json: false,
      // blame answers a per-file question, so it fixes the sort and never
      // narrows to a directory: the file is the whole scope.
      sort: 'recent',
    },
  })
})

test('planCli resolves a timeline directory against the working directory', () => {
  const now = Date.parse('2026-08-30T12:00:00Z')
  expect(planCli(['timeline', '--dir', 'src', '--since', '2d'], '/work', now)).toEqual({
    kind: 'timeline',
    options: {
      dir: '/work/src',
      since: now - 2 * 86_400_000,
      client: undefined,
      limit: undefined,
      json: false,
    },
  })
  const here = planCli(['timeline'], '/work', now)
  expect(here.kind === 'timeline' && here.options.dir).toBe('/work')
})

test('planCli passes show a uid and a character budget, including zero', () => {
  expect(planCli(['show', 'claude:abc', '--max-chars', '0'])).toEqual({
    kind: 'show',
    options: { uid: 'claude:abc', maxChars: 0 },
  })
  // A bare `show` is not a rejection here: the command prints its own usage.
  expect(planCli(['show'])).toEqual({ kind: 'show', options: {} })
})

test('planCli reads the flags of the commands that take no query', () => {
  expect(planCli(['index', '--rebuild', '--yes', '--quiet'])).toEqual({
    kind: 'index',
    options: { rebuild: true, quiet: true, yes: true },
  })
  expect(planCli(['doctor', '--sniff', '--emit-manifest', '/tmp/draft.json'])).toEqual({
    kind: 'doctor',
    options: { emitManifest: '/tmp/draft.json', json: false, sniff: true },
  })
  expect(planCli(['last'])).toEqual({ kind: 'last' })
  expect(planCli(['forget', 'claude:abc'])).toEqual({ kind: 'forget', uid: 'claude:abc' })
  expect(planCli(['prune', '--missing', '--client', 'claude'])).toEqual({
    kind: 'prune',
    options: { missing: true, client: 'claude' },
  })
  expect(planCli(['exclude', '/private/**'])).toEqual({ kind: 'exclude', glob: '/private/**' })
})

// One row per rule in `planCli`, asserted on the message rather than on the
// exit code. The subprocess tests above can only see "exit 2", so they stay
// green when two rules swap messages; these do not.
const REJECTED: [string[], string][] = [
  [['search', '--unknown'], "Unknown option '--unknown'"],
  [['search', '--client'], "Option '--client <value>' argument missing"],
  [['search', '--sort', 'random'], '--sort must be auto, recent, or relevance'],
  [['search', '--limit', 'wat'], '--limit must be a positive integer'],
  [['search', '--limit', '0'], '--limit must be a positive integer'],
  [['search', '--limit', '1.5'], '--limit must be a positive integer'],
  [['search', '--rebuild'], 'index options cannot be used with search'],
  [['search', '--dir', '/x'], 'index options cannot be used with search'],
  [['index', 'extra'], 'index does not accept positional arguments'],
  [['index', '--json'], 'search options cannot be used with index'],
  [['index', '--client', 'claude'], 'search options cannot be used with index'],
  [['last', 'extra'], 'last does not accept positional arguments'],
  [['last', '--all'], 'last does not accept options'],
  [['forget', 'claude:a', 'extra'], 'forget accepts exactly one uid'],
  [['forget', 'claude:a', '--missing'], 'forget does not accept options'],
  [['prune', 'extra'], 'prune does not accept positional arguments'],
  [['prune', '--missing', '--all'], 'only --missing and --client can be used with prune'],
  [['exclude', '/a/**', '/b/**'], 'exclude accepts exactly one glob'],
  [['exclude', '/a/**', '--json'], 'exclude does not accept options'],
  [['doctor', 'extra'], 'doctor does not accept positional arguments'],
  [['doctor', '--client', 'claude'], 'only --json, --sniff, and --emit-manifest can be used with doctor'],
  [['doctor', '--emit-manifest', '/tmp/d.json'], '--emit-manifest requires --sniff'],
  [['doctor', '--sniff', '--emit-manifest', '/tmp/d.json', '--json'], '--json cannot be combined with --emit-manifest'],
  [['show', 'claude:a', 'extra'], 'show accepts exactly one uid'],
  [['show', 'claude:bad\u001b[2J'], 'uid must not contain control characters'],
  [['show', 'malformed'], 'malformed uid: malformed'],
  [['show', ':empty-client'], 'malformed uid: :empty-client'],
  [['show', 'empty-native:'], 'malformed uid: empty-native:'],
  [['show', 'claude:a', '--json'], 'only --max-chars can be used with show'],
  // A bare negative is intercepted by parseArgs before the rule can fire, so
  // the reachable form of the rule is the joined one.
  [['show', 'claude:a', '--max-chars', '-1'], "Option '--max-chars' argument is ambiguous"],
  [['show', 'claude:a', '--max-chars=-1'], '--max-chars must be a non-negative integer'],
  [['show', 'claude:a', '--max-chars', '1.5'], '--max-chars must be a non-negative integer'],
  [['show', 'claude:a', '--max-chars', 'NaN'], '--max-chars must be a non-negative integer'],
  [['timeline', 'src/sse.ts'], 'timeline takes no positional arguments'],
  [['timeline', '--sort', 'recent'], 'only --dir, --since, --client, --limit, and --json can be used with timeline'],
  [['timeline', '--since', 'yesterday'], '--since takes a span such as 30m, 12h, 2d, 3w, or a date such as 2026-08-01'],
  [['blame'], 'blame accepts exactly one path'],
  [['blame', 'one.ts', 'two.ts'], 'blame accepts exactly one path'],
  [['blame', 'one.ts', '--sort', 'recent'], 'only --client, --limit, and --json can be used with blame'],
  [['blame', 'one.ts', '--all'], 'only --client, --limit, and --json can be used with blame'],
  [['blame', 'one\u0001.ts'], 'blame path is too long or contains control characters'],
  [['blame', 'x'.repeat(16_385)], 'blame path is too long or contains control characters'],
]

test('planCli names the rule an invocation broke', () => {
  for (const [args, message] of REJECTED) {
    expect(() => planCli(args, '/work')).toThrow(message)
  }
})

test('every rejected invocation exits 2, the code that means the arguments were wrong', async () => {
  // The message assertions above say which rule fired, but not what the process
  // does about it: `main` returns 2 only for a CliError and 1 for anything else,
  // so a rule that threw a plain Error with the right message would pass there
  // and still report the wrong exit code. Both halves are pinned, or neither is.
  const spy = spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (const [args] of REJECTED) {
      expect(await main(args)).toBe(2)
    }
  } finally {
    spy.mockRestore()
  }
})

// Exit codes read in-process. The spawned runs above prove the binary exits
// correctly; these pin the same contract where the coverage instrument can see
// it, and they guard the rewiring of `dispatch` onto `planCli`. None of them
// reaches a command: every one is answered or rejected by the plan alone.
test('main answers the argument-only invocations with their exit codes', async () => {
  expect(await main(['--help'])).toBe(0)
  expect(await main(['-h'])).toBe(0)
  expect(await main(['--version'])).toBe(0)
  expect(await main(['frobnicate'])).toBe(2)
  expect(await main(['search', '--sort', 'random'])).toBe(2)
  expect(await main(['blame'])).toBe(2)
  expect(await main(['doctor', '--emit-manifest', '/tmp/nope.json'])).toBe(2)
})

test('the index summary counts what was committed, not what was attempted', async () => {
  // `updated` was the length of the changed list, which is the number of
  // sessions tried. A hydration that failed leaves the previous document in
  // place, so counting it as updated reports work that did not happen.
  const db = IndexDb.open(':memory:')
  const ref: SessionRef = {
    uid: 'claude:one', client: 'claude', nativeId: 'one', cwd: '/root/proj',
    gitBranch: null, title: 'one', startedAt: 1, endedAt: 2, turns: 1,
    parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: ['/one'],
    fingerprint: 'one:1',
  }
  const broken: SessionRef = { ...ref, uid: 'claude:two', nativeId: 'two', sourcePaths: ['/two'] }
  const adapter: Adapter = {
    id: 'claude', manifest: {} as Adapter['manifest'], detect: () => true,
    discover: async () => ({ refs: [ref, broken], diagnostics: [], authoritative: true }),
    hydrate: async (value) => {
      if (value.uid === broken.uid) throw new Error('unreadable')
      return { ref: value, prompts: ['kept'], prose: [], files: [], truncated: false }
    },
    plan: () => null,
  }

  const lines: string[] = []
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    await reindexWith(db, DEFAULT_CONFIG, { adapters: [adapter], diagnostics: [] })
  } finally {
    spy.mockRestore()
  }

  const summary = lines.find((line) => line.includes('sessions,'))
  expect(summary).toBe('2 sessions, 1 updated, 1 failed, 0 missing')
  db.close()
})

test('a run with nothing to report says so without inventing a failure count', async () => {
  const db = IndexDb.open(':memory:')
  const ref: SessionRef = {
    uid: 'claude:one', client: 'claude', nativeId: 'one', cwd: '/root/proj',
    gitBranch: null, title: 'one', startedAt: 1, endedAt: 2, turns: 1,
    parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: ['/one'],
    fingerprint: 'one:1',
  }
  const adapter: Adapter = {
    id: 'claude', manifest: {} as Adapter['manifest'], detect: () => true,
    discover: async () => ({ refs: [ref], diagnostics: [], authoritative: true }),
    hydrate: async (value) => ({
      ref: value, prompts: ['kept'], prose: [], files: [], truncated: false,
    }),
    plan: () => null,
  }

  const lines: string[] = []
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    await reindexWith(db, DEFAULT_CONFIG, { adapters: [adapter], diagnostics: [] })
  } finally {
    spy.mockRestore()
  }

  expect(lines.find((line) => line.includes('sessions,'))).toBe('1 sessions, 1 updated, 0 missing')
  db.close()
})

test('indexing refuses a config it cannot honour rather than indexing everything', () => {
  // The defaults a broken config falls back to carry an empty `exclude`, so
  // continuing would write exactly the directories the user asked Nekyia to
  // stay out of, permanently and silently. Refuse before the database exists.
  const env = environment()
  mkdirSync(join(env.XDG_CONFIG_HOME, 'nekyia'), { recursive: true })
  writeFileSync(join(env.XDG_CONFIG_HOME, 'nekyia', 'config.json'), '{not json')

  const result = run(['index', '--yes'], env)
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain('config.json')
  expect(existsSync(join(env.XDG_DATA_HOME, 'nekyia', 'index.db'))).toBe(false)
})

test('indexing refuses when only the exclusion list is unusable', () => {
  const env = environment()
  mkdirSync(join(env.XDG_CONFIG_HOME, 'nekyia'), { recursive: true })
  writeFileSync(
    join(env.XDG_CONFIG_HOME, 'nekyia', 'config.json'),
    JSON.stringify({ exclude: '/root/secret' }),
  )

  const result = run(['index', '--yes'], env)
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain('exclude')
  expect(existsSync(join(env.XDG_DATA_HOME, 'nekyia', 'index.db'))).toBe(false)
})

test('indexing is unbothered by a config whose only fault is a preference', () => {
  const env = environment()
  mkdirSync(join(env.XDG_CONFIG_HOME, 'nekyia'), { recursive: true })
  writeFileSync(
    join(env.XDG_CONFIG_HOME, 'nekyia', 'config.json'),
    JSON.stringify({ halfLifeDays: 'fourteen' }),
  )

  const result = run(['index', '--yes'], env)
  expect(result.exitCode).toBe(0)
  expect(existsSync(join(env.XDG_DATA_HOME, 'nekyia', 'index.db'))).toBe(true)
})

test('searching still answers on a broken config, but says the config was not honoured', () => {
  // Stopping a search over a config typo was never the intent. Saying nothing
  // was the bug: the results are drawn without the visibility rules the user
  // wrote, and nothing on screen admits it.
  const env = environment()
  expect(run(['index', '--yes'], env).exitCode).toBe(0)
  mkdirSync(join(env.XDG_CONFIG_HOME, 'nekyia'), { recursive: true })
  writeFileSync(
    join(env.XDG_CONFIG_HOME, 'nekyia', 'config.json'),
    JSON.stringify({ hiddenClients: 42 }),
  )

  const result = run(['search', 'reconnect', '--all'], env)
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain('sse reconnect')
  expect(result.stderr.toString()).toContain('hiddenClients')
})

// Reading is not a writing operation. `doctor`, `last` and `timeline` already
// open the index readonly; `search` and `show` opened it readwrite and ran the
// migration ladder, so printing a handover could upgrade the schema underneath
// the user. The observable half of that is the migration itself: with the file
// closed cleanly SQLite leaves no WAL behind, and these tests run as root, so
// neither stray journal files nor a read-only mode bit would tell the two
// opens apart. What does tell them apart is whether the stamp moved.
function downgradeIndex(env: Record<string, string>, version: string): void {
  const raw = new Database(join(env.XDG_DATA_HOME, 'nekyia', 'index.db'))
  try {
    raw.exec('DROP TABLE IF EXISTS session_file_event')
    raw.exec('DROP TABLE IF EXISTS session_turn')
    raw.exec('ALTER TABLE session DROP COLUMN file_events_truncated')
    raw.exec('ALTER TABLE session DROP COLUMN file_detail')
    raw.query('UPDATE meta SET value = ? WHERE key = ?').run(version, 'schema_version')
  } finally {
    raw.close()
  }
}

function schemaVersion(env: Record<string, string>): string {
  const raw = new Database(join(env.XDG_DATA_HOME, 'nekyia', 'index.db'))
  try {
    return (raw.query('SELECT value FROM meta WHERE key = ?').get('schema_version') as {
      value: string
    }).value
  } finally {
    raw.close()
  }
}

test('search answers on an unmigrated index and leaves it unmigrated', () => {
  const env = environment()
  expect(run(['index', '--yes', '--quiet'], env).exitCode).toBe(0)
  downgradeIndex(env, '2')

  const result = run(['search', 'reconnect', '--all'], env)
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain('sse reconnect')
  expect(schemaVersion(env)).toBe('2')
})

test('show answers on an unmigrated index and leaves it unmigrated', () => {
  const env = environment()
  expect(run(['index', '--yes', '--quiet'], env).exitCode).toBe(0)
  const uid = JSON.parse(
    run(['search', 'reconnect', '--all', '--json'], env).stdout.toString(),
  )[0].uid as string
  downgradeIndex(env, '2')

  const result = run(['show', uid], env)
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain('sse reconnect')
  expect(schemaVersion(env)).toBe('2')
})

test('--ids prints one addressable uid per line, ready to pass to show or forget', () => {
  // Finding a session by eye and then acting on it meant re-running the whole
  // query as JSON purely to recover an identifier, because the human table has
  // no addressable field in it.
  const env = environment()
  expect(run(['index', '--yes', '--quiet'], env).exitCode).toBe(0)

  const ids = run(['search', 'reconnect', '--all', '--ids'], env)
  expect(ids.exitCode).toBe(0)
  const lines = ids.stdout.toString().trim().split('\n')
  expect(lines.length).toBeGreaterThan(0)
  for (const line of lines) expect(line).toMatch(/^[a-z0-9-]+:\S+$/)

  // The uid it printed is one show actually accepts.
  const shown = run(['show', lines[0]!], env)
  expect(shown.exitCode).toBe(0)
})

test('--ids and --json are different answers to the same question, not both at once', () => {
  const result = run(['search', 'x', '--ids', '--json'])
  expect(result.exitCode).toBe(2)
  expect(result.stderr.toString()).toContain('error:')
})

test('the default table is left exactly as it was', () => {
  const env = environment()
  expect(run(['index', '--yes', '--quiet'], env).exitCode).toBe(0)
  const table = run(['search', 'reconnect', '--all'], env).stdout.toString()
  expect(table).toContain('sse reconnect')
  expect(table).not.toMatch(/^claude:/m)
})

test('the collapsed score names the session that earned it in JSON too', () => {
  const env = environment()
  expect(run(['index', '--yes', '--quiet'], env).exitCode).toBe(0)
  const rows = JSON.parse(
    run(['search', 'reconnect', '--all', '--json'], env).stdout.toString(),
  ) as Array<Record<string, unknown>>
  expect(rows.length).toBeGreaterThan(0)
  // Nothing in the fixtures collapses to a different scorer, so the field is
  // absent rather than echoing the row's own uid back at the caller.
  for (const row of rows) expect(row.matchedUid).toBeUndefined()
})
