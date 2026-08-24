import { afterAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildAdapter } from '../src/core/adapter'
import { validateManifest } from '../src/manifests/load'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const temporaries: string[] = []

function environment(rootOverride = true) {
  const tmp = mkdtempSync(join(tmpdir(), 'nekyia-doc-'))
  temporaries.push(tmp)
  const roots = join(tmp, 'roots')
  mkdirSync(roots)
  return {
    tmp,
    roots,
    env: {
      ...process.env,
      HOME: join(tmp, 'home'),
      XDG_CONFIG_HOME: join(tmp, 'config'),
      XDG_DATA_HOME: join(tmp, 'data'),
      ...(rootOverride ? { NEKYIA_ROOT_OVERRIDE: roots } : { NEKYIA_ROOT_OVERRIDE: undefined }),
    },
  }
}

function run(args: string[], env: Record<string, string | undefined>) {
  return Bun.spawnSync(['bun', CLI, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
}

function genericManifest(id: string) {
  return {
    schema: 1, id, name: `User ${id}`, roots: ['/ignored'],
    format: 'jsonl-transcript', tier: 'search',
    jsonl: { glob: '**/*.jsonl', variant: 'generic', generic: { idFrom: 'filename' } },
  }
}

function sessionLines(secret = 'DO_NOT_REPORT_THIS_PROMPT') {
  return [
    { ts: '2026-08-01T00:00:00Z', cwd: '/work/example', role: 'user', text: secret },
    { ts: '2026-08-01T00:01:00Z', cwd: '/work/example', role: 'assistant', text: 'DO_NOT_REPORT_THIS_ANSWER' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n'
}

afterAll(() => {
  for (const path of temporaries) rmSync(path, { recursive: true, force: true })
})

test('doctor names every built-in client, provenance, paths, and override', () => {
  const setup = environment()
  const result = run(['doctor'], setup.env)
  expect(result.exitCode).toBe(0)
  const out = result.stdout.toString()
  for (const client of ['claude', 'codex', 'opencode', 'kilo', 'codebuff', 'agy']) {
    expect(out).toContain(client)
  }
  expect(out).toContain('built-in')
  expect(out).toContain('config')
  expect(out).toContain('index.db')
  expect(out).toContain('NEKYIA_ROOT_OVERRIDE')
})

test('doctor reports user override provenance accurately and discovery authority', () => {
  const setup = environment()
  const clients = join(setup.env.XDG_CONFIG_HOME!, 'nekyia', 'clients')
  mkdirSync(clients, { recursive: true })
  writeFileSync(join(clients, 'claude.json'), `${JSON.stringify(genericManifest('claude'))}\n`)
  mkdirSync(join(setup.roots, 'claude'))
  writeFileSync(join(setup.roots, 'claude', 'broken.jsonl'), '{not json}\n')

  const result = run(['doctor', '--json'], setup.env)
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe('')
  const report = JSON.parse(result.stdout.toString())
  const claude = report.clients.find((client: any) => client.client === 'claude')
  expect(claude.source).toBe('user')
  expect(claude.authoritative).toBe(false)
  expect(report.diagnostics.some((item: any) => item.client === 'claude')).toBe(true)
})

test('doctor JSON is parseable, bounded and never includes transcript content', () => {
  const setup = environment()
  const clients = join(setup.env.XDG_CONFIG_HOME!, 'nekyia', 'clients')
  mkdirSync(clients, { recursive: true })
  writeFileSync(join(clients, 'mystery.json'), `${JSON.stringify(genericManifest('mystery'))}\n`)
  mkdirSync(join(setup.roots, 'mystery'))
  writeFileSync(join(setup.roots, 'mystery', 'sessions.jsonl'), sessionLines())

  const result = run(['doctor', '--json'], setup.env)
  expect(result.exitCode).toBe(0)
  const stdout = result.stdout.toString()
  expect(() => JSON.parse(stdout)).not.toThrow()
  expect(stdout).not.toContain('DO_NOT_REPORT_THIS_PROMPT')
  expect(stdout).not.toContain('DO_NOT_REPORT_THIS_ANSWER')
  expect(stdout.length).toBeLessThan(200_000)
})

test('doctor does not create an absent index and reads an existing index summary', () => {
  const setup = environment()
  const path = join(setup.env.XDG_DATA_HOME!, 'nekyia', 'index.db')
  expect(run(['doctor', '--json'], setup.env).exitCode).toBe(0)
  expect(existsSync(path)).toBe(false)

  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('schema_version', '1');
    CREATE TABLE session(uid TEXT PRIMARY KEY, truncated INTEGER NOT NULL, missing INTEGER NOT NULL);
    INSERT INTO session VALUES ('x:1', 1, 0), ('x:2', 0, 1);
  `)
  db.close()
  const before = readFileSync(path)
  const beforeFiles = readdirSync(dirname(path)).sort()
  const report = JSON.parse(run(['doctor', '--json'], setup.env).stdout.toString())
  expect(report.index).toMatchObject({ sessions: 2, proseTruncated: 1, missing: 1 })
  expect(report.index.sizeCappedSessions).toEqual(['x:1'])
  expect(readFileSync(path)).toEqual(before)
  expect(readdirSync(dirname(path)).sort()).toEqual(beforeFiles)
})

test('doctor refuses a symlinked index instead of following it', () => {
  const setup = environment()
  const path = join(setup.env.XDG_DATA_HOME!, 'nekyia', 'index.db')
  mkdirSync(dirname(path), { recursive: true })
  const target = join(setup.tmp, 'outside.db')
  writeFileSync(target, 'do not touch')
  symlinkSync(target, path)
  const result = run(['doctor', '--json'], setup.env)
  expect(result.exitCode).toBe(0)
  const report = JSON.parse(result.stdout.toString())
  expect(report.diagnostics.some((item: any) => item.client === 'index')).toBe(true)
  expect(readFileSync(target, 'utf8')).toBe('do not touch')
})

test('doctor diagnoses a dangling index symlink instead of treating it as absent', () => {
  const setup = environment()
  const path = join(setup.env.XDG_DATA_HOME!, 'nekyia', 'index.db')
  const missing = join(setup.tmp, 'missing.db')
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(missing, path)
  const result = run(['doctor', '--json'], setup.env)
  expect(result.exitCode).toBe(0)
  const report = JSON.parse(result.stdout.toString())
  expect(report.diagnostics.some((item: any) => (
    item.client === 'index' && item.message.includes('could not inspect index')
  ))).toBe(true)
  expect(existsSync(missing)).toBe(false)
})

test('doctor reports every bounded loaded manifest without a second silent cap', () => {
  const setup = environment()
  const clients = join(setup.env.XDG_CONFIG_HOME!, 'nekyia', 'clients')
  mkdirSync(clients, { recursive: true })
  const ids: string[] = []
  for (let index = 0; index < 256; index++) {
    const id = `user-${String(index).padStart(3, '0')}`
    ids.push(id)
    writeFileSync(join(clients, `${id}.json`), JSON.stringify(genericManifest(id)))
  }
  const result = run(['doctor', '--json'], setup.env)
  expect(result.exitCode).toBe(0)
  const report = JSON.parse(result.stdout.toString())
  const reported = new Set(report.clients.map((client: any) => client.client))
  for (const id of ids) expect(reported.has(id)).toBe(true)
  for (const id of ['agy', 'claude', 'codebuff', 'codex', 'kilo', 'opencode']) {
    expect(reported.has(id)).toBe(true)
  }
  expect(report.clients).toHaveLength(262)
})

test('doctor --sniff emits a deterministic working draft without private samples', async () => {
  const setup = environment(false)
  const store = join(setup.env.HOME!, '.mystery', 'history.jsonl')
  mkdirSync(dirname(store), { recursive: true })
  mkdirSync(join(setup.env.HOME!, '.bun', 'install', 'cache'), { recursive: true, mode: 0o700 })
  writeFileSync(store, sessionLines('TOP_SECRET_PROMPT'))
  const output = join(setup.tmp, 'draft.json')

  const result = run(['doctor', '--sniff', '--emit-manifest', output], setup.env)
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toBe('')
  expect(result.stderr.toString()).toContain('draft manifest written')
  const raw = readFileSync(output, 'utf8')
  expect(raw).not.toContain('TOP_SECRET_PROMPT')
  const draft = JSON.parse(raw)
  const manifest = validateManifest(draft)
  expect(draft.roots).toEqual([dirname(store)])
  const discovered = await buildAdapter(manifest).discover()
  expect(discovered.authoritative).toBe(true)
  expect(discovered.refs).toHaveLength(1)
})

test('manifest emission requires sniff, never overwrites, and rejects symlink targets', () => {
  const setup = environment(false)
  const store = join(setup.env.HOME!, '.mystery', 'history.jsonl')
  mkdirSync(dirname(store), { recursive: true })
  writeFileSync(store, sessionLines())

  const noSniff = join(setup.tmp, 'no-sniff.json')
  expect(run(['doctor', '--emit-manifest', noSniff], setup.env).exitCode).toBe(2)
  expect(existsSync(noSniff)).toBe(false)

  const existing = join(setup.tmp, 'existing.json')
  writeFileSync(existing, 'keep me')
  expect(run(['doctor', '--sniff', '--emit-manifest', existing], setup.env).exitCode).toBe(1)
  expect(readFileSync(existing, 'utf8')).toBe('keep me')
  expect(readdirSync(setup.tmp).some((name) => name.endsWith('.tmp'))).toBe(false)

  const victim = join(setup.tmp, 'victim.json')
  const link = join(setup.tmp, 'link.json')
  writeFileSync(victim, 'victim')
  symlinkSync(victim, link)
  expect(run(['doctor', '--sniff', '--emit-manifest', link], setup.env).exitCode).toBe(1)
  expect(readFileSync(victim, 'utf8')).toBe('victim')

  const realParent = join(setup.tmp, 'real-parent')
  const linkedParent = join(setup.tmp, 'linked-parent')
  mkdirSync(realParent)
  symlinkSync(realParent, linkedParent)
  expect(run([
    'doctor', '--sniff', '--emit-manifest', join(linkedParent, 'draft.json'),
  ], setup.env).exitCode).toBe(1)
  expect(existsSync(join(realParent, 'draft.json'))).toBe(false)
})

test('manifest emission is private under hostile umask and JSON mode is rejected', () => {
  const setup = environment(false)
  const store = join(setup.env.HOME!, '.mystery', 'history.jsonl')
  mkdirSync(dirname(store), { recursive: true })
  mkdirSync(join(setup.env.HOME!, '.bun', 'install', 'cache'), { recursive: true, mode: 0o700 })
  writeFileSync(store, sessionLines())
  const output = join(setup.tmp, 'private.json')
  const doctorUrl = new URL('../src/commands/doctor.ts', import.meta.url).href
  const script = [
    `const m = await import(${JSON.stringify(doctorUrl)})`,
    'process.umask(0o777)',
    `process.exitCode = await m.runDoctor({ sniff: true, emitManifest: ${JSON.stringify(output)} })`,
    "const fs = await import('node:fs')",
    `console.log((fs.statSync(${JSON.stringify(output)}).mode & 0o777).toString(8), process.umask().toString(8))`,
  ].join('; ')
  const result = Bun.spawnSync([process.execPath, '--eval', script], {
    env: { ...setup.env, BUN_INSTALL: process.env.BUN_INSTALL || dirname(dirname(process.execPath)) },
    stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString().trim()).toBe('600 777')

  const rejected = join(setup.tmp, 'rejected.json')
  const both = run(['doctor', '--json', '--sniff', '--emit-manifest', rejected], setup.env)
  expect(both.exitCode).toBe(2)
  expect(both.stderr.toString()).toContain('--json cannot be combined')
  expect(existsSync(rejected)).toBe(false)
})

test('doctor options belong only to doctor', () => {
  const setup = environment()
  for (const args of [
    ['search', '--sniff'],
    ['index', '--emit-manifest', 'x'],
    ['doctor', '--rebuild'],
    ['doctor', 'extra'],
  ]) {
    const result = run(args, setup.env)
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain('error:')
  }
})
