import { afterEach, beforeEach, expect, test } from 'bun:test'
import Database from 'bun:sqlite'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG, configDir, indexPath, loadConfig, updateConfig } from '../src/config'
import { IndexDb } from '../src/core/db'
import type { SessionRef } from '../src/types'
import { addExclude, excludePatterns, forgetIn, pruneIn } from '../src/commands/privacy'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
let temporary: string
let savedEnvironment: NodeJS.ProcessEnv

beforeEach(() => {
  temporary = realpathSync(mkdtempSync(join(tmpdir(), 'nekyia-privacy-')))
  savedEnvironment = { ...process.env }
  process.env.XDG_CONFIG_HOME = join(temporary, 'config')
  process.env.XDG_DATA_HOME = join(temporary, 'data')
})

afterEach(() => {
  process.env = savedEnvironment
  rmSync(temporary, { recursive: true, force: true })
})

function seed(db: IndexDb, uid: string, cwd = '/root/proj') {
  const separator = uid.indexOf(':')
  const ref: SessionRef = {
    uid,
    client: uid.slice(0, separator),
    nativeId: uid.slice(separator + 1),
    cwd,
    gitBranch: null,
    title: 'title',
    startedAt: 0,
    endedAt: 1,
    turns: 1,
    parentNativeId: null,
    tier: 'search',
    origin: 'manifest',
    sourcePaths: [],
    fingerprint: 'fingerprint',
  }
  db.upsertHydrated({
    ref,
    prompts: [`a secret prompt for ${uid}`],
    prose: [],
    files: [`/${ref.client}/${ref.nativeId}.ts`],
    truncated: false,
  })
}

function run(args: string[]) {
  return Bun.spawnSync(['bun', CLI, ...args], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

test('forget removes the row, searchable text, and file facets', () => {
  const db = IndexDb.open(':memory:')
  seed(db, 'claude:a')
  expect(forgetIn(db, 'claude:a')).toBe(true)
  expect(db.allUids()).toEqual([])
  expect(db.ftsSearch('secret')).toEqual([])
  expect(db.uidsTouchingFile('a.ts')).toEqual([])
  db.close()
})

test('forget reports false for an unknown uid instead of pretending', () => {
  const db = IndexDb.open(':memory:')
  expect(forgetIn(db, 'claude:nope')).toBe(false)
  expect(forgetIn(db, `claude:${'x'.repeat(4_096)}`)).toBe(false)
  expect(pruneIn(db, { client: 'bad client' })).toBe(0)
  db.close()
})

test('prune selectors use exact AND semantics and client values are data', () => {
  const db = IndexDb.open(':memory:')
  seed(db, 'claude:here')
  seed(db, 'claude:gone')
  seed(db, 'codex:gone')
  seed(db, "x' OR 1=1 --:literal")
  db.markMissing(['claude:gone', 'codex:gone'])

  expect(pruneIn(db, { missing: true, client: 'claude' })).toBe(1)
  expect(db.allUids()).toEqual(['claude:here', 'codex:gone', "x' OR 1=1 --:literal"])
  expect(pruneIn(db, { client: "x' OR 1=1 --" })).toBe(1)
  expect(db.allUids()).toEqual(['claude:here', 'codex:gone'])
  expect(pruneIn(db, {})).toBe(0)
  db.close()
})

test('a multi-row prune rolls every facet back when any deletion fails', () => {
  const db = IndexDb.open(':memory:')
  seed(db, 'claude:a')
  seed(db, 'claude:b')
  db.markMissing(['claude:a', 'claude:b'])
  db.raw().exec(`
    CREATE TRIGGER reject_b BEFORE DELETE ON session
    WHEN OLD.uid = 'claude:b' BEGIN SELECT RAISE(ABORT, 'reject b'); END;
  `)
  expect(() => pruneIn(db, { missing: true })).toThrow('reject b')
  expect(db.allUids()).toEqual(['claude:a', 'claude:b'])
  expect(db.ftsSearch('secret').map((row) => row.uid).sort()).toEqual(['claude:a', 'claude:b'])
  expect(db.uidsTouchingFile('.ts')).toEqual(['claude:a', 'claude:b'])
  db.close()
})

test('addExclude appends without duplication and never aliases caller arrays', () => {
  const input = { ...DEFAULT_CONFIG, exclude: ['/already/**'], hiddenClients: [] }
  const changed = addExclude(input, '/root/client-work/**')
  expect(changed.exclude).toEqual(['/already/**', '/root/client-work/**'])
  expect(changed.exclude).not.toBe(input.exclude)
  const duplicate = addExclude(changed, '/root/client-work/**')
  expect(duplicate.exclude).toEqual(changed.exclude)
  expect(duplicate.exclude).not.toBe(changed.exclude)
})

test('a bare directory excludes the directory and its subtree, a glob is stored verbatim', () => {
  expect(excludePatterns('/home/u/secret')).toEqual(['/home/u/secret', '/home/u/secret/**'])
  expect(excludePatterns('/home/u/secret/')).toEqual(['/home/u/secret', '/home/u/secret/**'])
  expect(excludePatterns('/work/private/**')).toEqual(['/work/private/**'])
})

test('a leading tilde is expanded before the pattern is stored', () => {
  expect(excludePatterns('~/secret/**')).toEqual([join(homedir(), 'secret/**')])
  expect(excludePatterns('~')).toEqual([homedir(), join(homedir(), '**')])
  expect(excludePatterns('~notatilde')).toEqual(['~notatilde', '~notatilde/**'])
})

test('addExclude refuses to cross the config item cap, even one entry at a time', () => {
  const full = {
    ...DEFAULT_CONFIG,
    exclude: Array.from({ length: 256 }, (_, index) => `/x/${index}/**`),
    hiddenClients: [],
  }
  expect(() => addExclude(full, '/one-too-many/**')).toThrow('too many exclusions')
  expect(addExclude(full, '/x/0/**').exclude).toHaveLength(256)
})

test('excluding a bare directory stores both patterns and stays idempotent', () => {
  const first = run(['exclude', '/root/secret'])
  expect(first.exitCode).toBe(0)
  expect(first.stderr.toString()).toContain('excluded /root/secret and /root/secret/**')
  expect(loadConfig().exclude).toEqual(['/root/secret', '/root/secret/**'])

  const second = run(['exclude', '/root/secret'])
  expect(second.exitCode).toBe(0)
  expect(second.stderr.toString()).toContain('already excluded')
  expect(loadConfig().exclude).toEqual(['/root/secret', '/root/secret/**'])
})

test('forget and prune do not create an absent index', () => {
  for (const args of [['forget', 'claude:a'], ['prune', '--missing']]) {
    const result = run(args)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('index not found')
    expect(existsSync(indexPath())).toBe(false)
  }
})

test('forget and prune CLI report real outcomes and delete the selected rows', () => {
  mkdirSync(dirname(indexPath()), { recursive: true })
  const db = IndexDb.open(indexPath())
  seed(db, 'claude:one')
  seed(db, 'claude:two')
  seed(db, 'codex:one')
  db.markMissing(['claude:two', 'codex:one'])
  db.close()

  const forgotten = run(['forget', 'claude:one'])
  expect(forgotten.exitCode).toBe(0)
  expect(forgotten.stderr.toString()).toContain('forgot claude:one')
  const unknown = run(['forget', 'claude:nope'])
  expect(unknown.exitCode).toBe(1)
  expect(unknown.stderr.toString()).toContain('no session')
  const pruned = run(['prune', '--missing', '--client', 'claude'])
  expect(pruned.exitCode).toBe(0)
  expect(pruned.stderr.toString()).toContain('pruned 1 sessions')

  const remaining = IndexDb.open(indexPath(), false)
  expect(remaining.allUids()).toEqual(['codex:one'])
  expect(remaining.ftsSearch('secret').map((row) => row.uid)).toEqual(['codex:one'])
  remaining.close()
})

/**
 * Rolls a current index back to an older stamped version, the way a user who
 * has not reindexed since that version still has one on disk. `db.test.ts` owns
 * the from-scratch fixtures; this only needs a file the CLI will refuse to
 * migrate.
 */
function downgradeIndex(version: 1 | 2): void {
  const raw = new Database(indexPath())
  try {
    raw.exec('DROP TABLE IF EXISTS session_turn')
    if (version === 1) raw.exec('ALTER TABLE session DROP COLUMN degraded')
    raw.query('UPDATE meta SET value = ? WHERE key = ?').run(String(version), 'schema_version')
  } finally {
    raw.close()
  }
}

test('forget and prune still work on an index that has not been migrated', () => {
  for (const version of [1, 2] as const) {
    rmSync(dirname(indexPath()), { recursive: true, force: true })
    mkdirSync(dirname(indexPath()), { recursive: true })
    const db = IndexDb.open(indexPath())
    seed(db, 'claude:keep')
    seed(db, 'claude:drop')
    seed(db, 'codex:gone')
    db.markMissing(['codex:gone'])
    db.close()
    downgradeIndex(version)

    const forgotten = run(['forget', 'claude:drop'])
    expect(forgotten.exitCode).toBe(0)
    expect(forgotten.stderr.toString()).toContain('forgot claude:drop')

    const pruned = run(['prune', '--missing'])
    expect(pruned.exitCode).toBe(0)
    expect(pruned.stderr.toString()).toContain('pruned 1 sessions')

    // Neither command migrated the file it was asked to delete a row from.
    const raw = new Database(indexPath())
    try {
      expect(raw.query("SELECT value FROM meta WHERE key = 'schema_version'").get())
        .toEqual({ value: String(version) })
      expect(raw.query('SELECT uid FROM session ORDER BY uid').all())
        .toEqual([{ uid: 'claude:keep' }])
      expect(raw.query('SELECT uid FROM session_file ORDER BY uid').all())
        .toEqual([{ uid: 'claude:keep' }])
    } finally {
      raw.close()
    }
  }
})

test('client ids accepted by manifests remain addressable by privacy commands', () => {
  mkdirSync(dirname(indexPath()), { recursive: true })
  const db = IndexDb.open(indexPath())
  seed(db, 'client space:one')
  db.close()
  const result = run(['forget', 'client space:one'])
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toContain('forgot client space:one')
})

test('foreign and newer databases are rejected without mutation or sidecars', () => {
  for (const kind of ['foreign', 'newer']) {
    rmSync(dirname(indexPath()), { recursive: true, force: true })
    mkdirSync(dirname(indexPath()), { recursive: true })
    const raw = new Database(indexPath(), { create: true })
    if (kind === 'foreign') {
      raw.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema_version', '1'); CREATE TABLE unrelated(secret TEXT);")
    } else {
      raw.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema_version', '999');")
    }
    raw.close()
    const before = readFileSync(indexPath())
    const files = readdirSync(dirname(indexPath())).sort()
    for (const args of [['forget', 'claude:a'], ['prune', '--missing']]) {
      const result = run(args)
      expect(result.exitCode).toBe(1)
      expect(readFileSync(indexPath())).toEqual(before)
      expect(readdirSync(dirname(indexPath())).sort()).toEqual(files)
    }
  }
})

test('privacy CLI validates exact positional and option ownership', () => {
  const invalid = [
    ['forget'],
    ['forget', 'bad'],
    ['forget', 'claude:a', 'extra'],
    ['forget', 'claude:a', '--missing'],
    ['forget', `claude:${'x'.repeat(4_096)}`],
    ['forget', 'claude:a\u202e'],
    ['prune'],
    ['prune', '--client'],
    ['prune', '--client', 'claude', 'extra'],
    ['prune', '--missing', '--all'],
    ['prune', '--client', 'bad:client'],
    ['prune', '--client', 'bad\u202e'],
    ['exclude'],
    ['exclude', '/one/**', '/two/**'],
    ['exclude', '/one/**', '--client', 'claude'],
    ['exclude', 'bad\npattern'],
    ['exclude', 'x'.repeat(4_097)],
  ]
  for (const args of invalid) {
    const result = run(args)
    expect(result.exitCode).toBe(2)
  }
})

test('exclude writes a private config atomically, does not duplicate, and announces rebuild', () => {
  const first = run(['exclude', '/root/client-work/**'])
  expect(first.exitCode).toBe(0)
  expect(first.stderr.toString()).toContain('index --rebuild')
  const path = join(configDir(), 'config.json')
  expect(lstatSync(path).mode & 0o777).toBe(0o600)
  expect(loadConfig().exclude).toEqual(['/root/client-work/**'])

  const second = run(['exclude', '/root/client-work/**'])
  expect(second.exitCode).toBe(0)
  expect(second.stderr.toString()).toContain('already excluded')
  expect(loadConfig().exclude).toEqual(['/root/client-work/**'])
  expect(readFileSync(path, 'utf8')).not.toContain('.tmp')
})

test('duplicate exclude normalizes an existing regular config back to 0600', () => {
  expect(run(['exclude', '/same/**']).exitCode).toBe(0)
  const path = join(configDir(), 'config.json')
  chmodSync(path, 0o644)
  expect(run(['exclude', '/same/**']).exitCode).toBe(0)
  expect(lstatSync(path).mode & 0o777).toBe(0o600)
})

test('exclude rejects an over-cap update and leaves the valid config byte-for-byte unchanged', () => {
  mkdirSync(configDir(), { recursive: true })
  const path = join(configDir(), 'config.json')
  const config = { ...DEFAULT_CONFIG, exclude: Array.from({ length: 256 }, (_, index) => `/x/${index}/**`) }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  const before = readFileSync(path)
  const result = run(['exclude', '/one-too-many/**'])
  expect(result.exitCode).toBe(1)
  expect(readFileSync(path)).toEqual(before)
})

test('exclude rejects malformed existing config without replacing it with defaults', () => {
  mkdirSync(configDir(), { recursive: true })
  const path = join(configDir(), 'config.json')
  writeFileSync(path, '{ malformed but important', { mode: 0o600 })
  const before = readFileSync(path)
  const result = run(['exclude', '/must-not-write/**'])
  expect(result.exitCode).toBe(1)
  expect(readFileSync(path)).toEqual(before)
  expect(readdirSync(configDir()).sort()).toEqual(['config.json'])
})

test('exclude recovers a bounded stale owned lock and cleans it up', () => {
  mkdirSync(configDir(), { recursive: true })
  const lock = join(configDir(), '.config.lock')
  mkdirSync(lock, { mode: 0o700 })
  const owner = join(lock, 'owner')
  writeFileSync(owner, JSON.stringify({
    token: '00000000-0000-0000-0000-000000000000', pid: 2_147_483_647,
  }), { mode: 0o600 })
  const old = new Date(Date.now() - 60_000)
  utimesSync(owner, old, old)
  utimesSync(lock, old, old)
  const result = run(['exclude', '/after-stale/**'])
  expect(result.exitCode).toBe(0)
  expect(loadConfig().exclude).toEqual(['/after-stale/**'])
  expect(readdirSync(configDir()).sort()).toEqual(['config.json'])
})

test('stale takeover is serialized when two contenders arrive together', async () => {
  mkdirSync(configDir(), { recursive: true })
  const lock = join(configDir(), '.config.lock')
  mkdirSync(lock, { mode: 0o700 })
  const owner = join(lock, 'owner')
  writeFileSync(owner, JSON.stringify({
    token: '00000000-0000-0000-0000-000000000000', pid: 2_147_483_647,
  }), { mode: 0o600 })
  const old = new Date(Date.now() - 60_000)
  utimesSync(owner, old, old)
  utimesSync(lock, old, old)

  // Hold the non-recoverable guard until both child contenders are waiting,
  // then release it once so only one can quarantine the stale inode.
  const guard = join(configDir(), '.config.lock.recovery')
  mkdirSync(guard, { mode: 0o700 })
  const spawn = (glob: string) => Bun.spawn(['bun', CLI, 'exclude', glob], {
    env: { ...process.env }, stdout: 'pipe', stderr: 'pipe',
  })
  const first = spawn('/stale/a/**')
  const second = spawn('/stale/b/**')
  await Bun.sleep(50)
  rmdirSync(guard)
  expect(await first.exited).toBe(0)
  expect(await second.exited).toBe(0)
  expect(loadConfig().exclude.sort()).toEqual(['/stale/a/**', '/stale/b/**'])
  expect(readdirSync(configDir()).sort()).toEqual(['config.json'])
})

test('an abandoned recovery guard fails busy instead of being broken', () => {
  mkdirSync(configDir(), { recursive: true })
  const guard = join(configDir(), '.config.lock.recovery')
  mkdirSync(guard, { mode: 0o700 })
  const result = run(['exclude', '/guarded/**'])
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain('config recovery is busy')
  expect(result.stderr.toString()).toContain(guard)
  expect(lstatSync(guard).isDirectory()).toBe(true)
  expect(existsSync(join(configDir(), 'config.json'))).toBe(false)
})

test('a recovery guard stranded by a dead process is recovered, not wedged forever', () => {
  const old = new Date(Date.now() - 60_000)
  const stranded: Array<[string, (guard: string) => void]> = [
    ['a written owner', (guard) => {
      const owner = join(guard, 'owner')
      writeFileSync(owner, JSON.stringify({
        token: '00000000-0000-0000-0000-000000000000', pid: 2_147_483_647,
      }), { mode: 0o600 })
      utimesSync(owner, old, old)
    }],
    // Killed between creating the directory and creating the owner file.
    ['no owner', () => {}],
    // Killed between creating the owner file and writing it.
    ['an unwritten owner', (guard) => {
      const owner = join(guard, 'owner')
      writeFileSync(owner, '', { mode: 0o600 })
      utimesSync(owner, old, old)
    }],
  ]
  for (const [name, strand] of stranded) {
    rmSync(configDir(), { recursive: true, force: true })
    mkdirSync(configDir(), { recursive: true })
    const guard = join(configDir(), '.config.lock.recovery')
    mkdirSync(guard, { mode: 0o700 })
    strand(guard)
    utimesSync(guard, old, old)
    const result = run(['exclude', `/recovered/${name.replace(/ /g, '-')}/**`])
    expect(result.exitCode).toBe(0)
    expect(readdirSync(configDir()).sort()).toEqual(['config.json'])
  }
})

test('a stale-looking recovery guard whose owner is alive is never broken', () => {
  mkdirSync(configDir(), { recursive: true })
  const guard = join(configDir(), '.config.lock.recovery')
  mkdirSync(guard, { mode: 0o700 })
  const owner = join(guard, 'owner')
  writeFileSync(owner, JSON.stringify({
    token: '00000000-0000-0000-0000-000000000000', pid: process.pid,
  }), { mode: 0o600 })
  const old = new Date(Date.now() - 60_000)
  utimesSync(owner, old, old)
  utimesSync(guard, old, old)
  const result = run(['exclude', '/live-guard/**'])
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain('config recovery is busy')
  expect(lstatSync(guard).isDirectory()).toBe(true)
  expect(existsSync(join(configDir(), 'config.json'))).toBe(false)
})

test('exclude fails boundedly on a live lock without mutating config', () => {
  mkdirSync(configDir(), { recursive: true })
  const lock = join(configDir(), '.config.lock')
  mkdirSync(lock, { mode: 0o700 })
  writeFileSync(join(lock, 'owner'), JSON.stringify({
    token: '00000000-0000-0000-0000-000000000000', pid: process.pid,
  }), { mode: 0o600 })
  const started = Date.now()
  const result = run(['exclude', '/while-busy/**'])
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain('config is busy')
  expect(Date.now() - started).toBeLessThan(2_000)
  expect(existsSync(join(configDir(), 'config.json'))).toBe(false)
  expect(lstatSync(lock).isDirectory()).toBe(true)
})

test('exclude never follows an unsafe lock symlink', () => {
  mkdirSync(configDir(), { recursive: true })
  const victim = join(temporary, 'lock-victim')
  writeFileSync(victim, 'leave lock victim')
  symlinkSync(victim, join(configDir(), '.config.lock'))
  const result = run(['exclude', '/unsafe-lock/**'])
  expect(result.exitCode).toBe(1)
  expect(readFileSync(victim, 'utf8')).toBe('leave lock victim')
  expect(existsSync(join(configDir(), 'config.json'))).toBe(false)
})

test('a contender during release cannot replace or lose the current owner lock', async () => {
  let announceHeld!: () => void
  let allowRelease!: () => void
  const held = new Promise<void>((resolve) => { announceHeld = resolve })
  const release = new Promise<void>((resolve) => { allowRelease = resolve })
  const first = updateConfig(async (config) => {
    announceHeld()
    await release
    return addExclude(config, '/release/first/**')
  })
  await held
  const second = updateConfig((config) => addExclude(config, '/release/second/**'))
  await Bun.sleep(30)
  allowRelease()
  await Promise.all([first, second])
  expect(loadConfig().exclude.sort()).toEqual(['/release/first/**', '/release/second/**'])
  expect(readdirSync(configDir()).sort()).toEqual(['config.json'])
})

test('concurrent excludes serialize their read-modify-write updates', async () => {
  const spawn = (glob: string) => Bun.spawn(['bun', CLI, 'exclude', glob], {
    env: { ...process.env }, stdout: 'pipe', stderr: 'pipe',
  })
  const first = spawn('/concurrent/a/**')
  const second = spawn('/concurrent/b/**')
  expect(await first.exited).toBe(0)
  expect(await second.exited).toBe(0)
  expect(loadConfig().exclude.sort()).toEqual(['/concurrent/a/**', '/concurrent/b/**'])
  expect(readdirSync(configDir()).sort()).toEqual(['config.json'])
})

test('exclude keeps config mode private under a hostile child umask', () => {
  const privacyUrl = new URL('../src/commands/privacy.ts', import.meta.url).href
  const script = [
    `const privacy = await import(${JSON.stringify(privacyUrl)})`,
    'process.umask(0o000)',
    `process.exitCode = await privacy.runExclude('/private/**')`,
  ].join('; ')
  const result = Bun.spawnSync([process.execPath, '--eval', script], {
    env: { ...process.env }, stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode).toBe(0)
  expect(lstatSync(join(configDir(), 'config.json')).mode & 0o777).toBe(0o600)
})

test('exclude refuses a symlinked config and leaves its target unchanged', () => {
  const victim = join(temporary, 'victim.json')
  writeFileSync(victim, 'leave me')
  mkdirSync(configDir(), { recursive: true })
  symlinkSync(victim, join(configDir(), 'config.json'))
  const result = run(['exclude', '/secret/**'])
  expect(result.exitCode).toBe(1)
  expect(readFileSync(victim, 'utf8')).toBe('leave me')
})

test('exclude refuses a symlinked config directory and writes nothing outside', () => {
  const outside = join(temporary, 'outside')
  mkdirSync(outside)
  mkdirSync(dirname(configDir()), { recursive: true })
  symlinkSync(outside, configDir())
  const result = run(['exclude', '/secret/**'])
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(outside, 'config.json'))).toBe(false)
})

test('exclude refuses a symlinked ancestor before creating any descendant', () => {
  const outside = join(temporary, 'ancestor-target')
  const linked = join(temporary, 'linked-config-home')
  mkdirSync(outside)
  symlinkSync(outside, linked)
  process.env.XDG_CONFIG_HOME = linked
  const result = run(['exclude', '/secret/**'])
  expect(result.exitCode).toBe(1)
  expect(existsSync(join(outside, 'nekyia'))).toBe(false)
})

test('forget refuses a symlinked index and leaves its target unchanged', () => {
  const path = indexPath()
  const victim = join(temporary, 'victim.db')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(victim, 'leave me')
  symlinkSync(victim, path)
  const result = run(['forget', 'claude:a'])
  expect(result.exitCode).toBe(1)
  expect(readFileSync(victim, 'utf8')).toBe('leave me')
})
