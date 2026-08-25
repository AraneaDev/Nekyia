import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Glob } from 'bun'
import { validateManifest } from '../src/manifests/load'
import { candidateRoots, sniffJsonl, sniffRoots, sniffSqlite } from '../src/core/sniff'

const temporary: string[] = []

function tempDir(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'nekyia-sniff-')))
  temporary.push(path)
  return path
}

function tmpFile(name: string, content: string): string {
  const path = join(tempDir(), name)
  writeFileSync(path, content)
  return path
}

function sessionLines(extra = ''): string {
  return JSON.stringify({ ts: 1_785_661_200_000, cwd: '/root/proj', role: 'user', text: `secret-user${extra}` }) + '\n'
    + JSON.stringify({ ts: 1_785_661_300_000, cwd: '/root/proj', role: 'assistant', text: `secret-assistant${extra}` }) + '\n'
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('claims JSONL only when complete evidence occurs in each of two records', () => {
  const path = tmpFile('sessions.jsonl', sessionLines())
  const result = sniffJsonl(path)!
  expect(result.kind).toBe('jsonl')
  expect(result.suggested.tier).toBe('search')
  expect(result.suggested.jsonl?.generic).toMatchObject({
    cwdPath: 'cwd', tsPath: 'ts', tsUnit: 'ms', rolePath: 'role', textPath: 'text',
    userRoles: ['user'], assistantRoles: ['assistant'],
  })
  expect(() => validateManifest({
    ...result.suggested, id: 'draft', name: 'Draft', roots: [dirname(path)],
  })).not.toThrow()
})

test('does not merge evidence split across unrelated JSONL records', () => {
  const path = tmpFile('mixed.jsonl', [
    { ts: 1_785_661_200_000, cwd: '/root/proj' },
    { role: 'user', text: 'a secret' },
    { role: 'assistant', text: 'another secret' },
  ].map((record) => JSON.stringify(record)).join('\n'))
  expect(sniffJsonl(path)).toBeNull()
})

test('refuses JSONL logs, package metadata, implausible cwd and arbitrary roles', () => {
  expect(sniffJsonl(tmpFile('app.jsonl',
    '{"level":"INFO","timestamp":"2026-07-21T07:48:02.376Z","pid":48836,"msg":"started"}\n',
  ))).toBeNull()
  expect(sniffJsonl(tmpFile('package.json', '{"name":"thing","version":"1.0.0"}'))).toBeNull()
  expect(sniffJsonl(tmpFile('sessions.jsonl',
    '{"ts":1785661200000,"cwd":"not a path","role":"user","text":"x"}\n'
    + '{"ts":1785661300000,"cwd":"GET /api","role":"assistant","text":"y"}\n',
  ))).toBeNull()
  expect(sniffJsonl(tmpFile('events.jsonl',
    '{"ts":1785661200000,"cwd":"/root/proj","role":"worker","text":"x"}\n'
    + '{"ts":1785661300000,"cwd":"/root/proj","role":"server","text":"y"}\n',
  ))).toBeNull()
})

test('requires timestamps and at least two qualifying records', () => {
  expect(sniffJsonl(tmpFile('untimed.jsonl',
    '{"cwd":"/root/proj","role":"user","text":"x"}\n'
    + '{"cwd":"/root/proj","role":"assistant","text":"y"}\n',
  ))).toBeNull()
  expect(sniffJsonl(tmpFile('one.jsonl',
    '{"ts":1785661200000,"cwd":"/root/proj","role":"user","text":"x"}\n',
  ))).toBeNull()
})

test('bounds JSONL reads, ignores a huge line, and localizes malformed records', () => {
  const huge = JSON.stringify({ ts: 1_785_661_100_000, cwd: '/root/proj', role: 'user', text: 'x'.repeat(70_000) })
  expect(sniffJsonl(tmpFile('huge.jsonl', `${huge}\n${sessionLines()}`))).toBeNull()
  const path = tmpFile('localized.jsonl', `{broken\n${sessionLines()}${'x'.repeat(70_000)}`)
  expect(sniffJsonl(path)?.kind).toBe('jsonl')
})

test('JSONL samples never contain content and are bounded/control-safe', () => {
  const path = tmpFile('sessions.jsonl', sessionLines('\u202esecret-token'))
  const samples = sniffJsonl(path)!.sample
  const sample = samples.join('\n')
  expect(sample).not.toContain('secret-user')
  expect(sample).not.toContain('secret-assistant')
  expect(sample).not.toContain('secret-token')
  expect(samples.every((line) => !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(line))).toBe(true)
  expect(sample.length).toBeLessThanOrEqual(512)
})

test('rejects JSONL symlinks and non-regular files', () => {
  const dir = tempDir()
  const target = join(dir, 'target.jsonl')
  const link = join(dir, 'link.jsonl')
  writeFileSync(target, sessionLines())
  symlinkSync(target, link)
  expect(sniffJsonl(link)).toBeNull()
  expect(sniffJsonl(dir)).toBeNull()
})

function makeSqlite(
  schema: string,
  insert?: (db: Database) => void,
  name = 'agent.db',
): string {
  const path = join(tempDir(), name)
  const db = new Database(path, { create: true })
  db.exec(schema)
  insert?.(db)
  db.close()
  return path
}

test('claims a plausible session SQLite table and emits valid quoted SQL', () => {
  const path = makeSqlite(
    'CREATE TABLE conversation(id TEXT, directory TEXT, title TEXT, created_at INTEGER)',
    (db) => db.query('INSERT INTO conversation VALUES (?,?,?,?)')
      .run('c1', '/root/proj', 'A chat', 1_785_661_200_000),
  )
  const result = sniffSqlite(path)!
  expect(result.kind).toBe('sqlite')
  expect(result.suggested.tier).toBe('search')
  expect(result.suggested.sqlite?.sessions).toContain('"conversation"')
  expect(() => validateManifest({
    ...result.suggested, id: 'draft', name: 'Draft', roots: [dirname(path)],
  })).not.toThrow()
})

test('recognizes conservative timestamp variants and prefers semantic columns', () => {
  const path = makeSqlite(
    'CREATE TABLE sessions(account_id TEXT, session_id TEXT, directory TEXT, runtime INTEGER, '
      + 'updated_at INTEGER, username TEXT, name TEXT, title TEXT)',
    (db) => db.query('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)')
      .run('account-secret', 'session-good', '/root/proj', 123, 1_785_661_200_000, 'person', 'Generic', 'Chat'),
  )
  const sql = sniffSqlite(path)!.suggested.sqlite!.sessions
  expect(sql).toContain('"session_id" AS id')
  expect(sql).toContain('"updated_at" AS ended_at')
  expect(sql).toContain('"title" AS title')
  expect(sql).not.toContain('"account_id" AS id')
  expect(sql).not.toContain('"runtime" AS ended_at')
  expect(sql).not.toContain('"username" AS title')
  expect(sql).not.toContain('"name" AS title')

  const created = makeSqlite(
    'CREATE TABLE conversation(id TEXT, cwd TEXT, time_created INTEGER)',
    (db) => db.query('INSERT INTO conversation VALUES (?,?,?)')
      .run('c1', '/root/proj', 1_785_661_200_000),
  )
  expect(sniffSqlite(created)?.suggested.sqlite?.sessions).toContain('"time_created" AS ended_at')

  const contained = makeSqlite(
    'CREATE TABLE conversation(id TEXT, cwd TEXT, eventtimestamp INTEGER)',
    (db) => db.query('INSERT INTO conversation VALUES (?,?,?)')
      .run('c1', '/root/proj', 1_785_661_200_000),
  )
  expect(sniffSqlite(contained)?.suggested.sqlite?.sessions).toContain('"eventtimestamp" AS ended_at')
})

test('quotes hostile SQLite identifiers in inspection and suggested SQL', () => {
  const path = makeSqlite(
    'CREATE TABLE "chat""; DROP TABLE harmless;--"('
      + 'id TEXT, directory TEXT, "title""value" TEXT, created_at INTEGER);'
      + 'CREATE TABLE harmless(value TEXT)',
    (db) => db.query(
      'INSERT INTO "chat""; DROP TABLE harmless;--" VALUES (?,?,?,?)',
    ).run('c1', '/safe/project', 'private title', 1_785_661_200_000),
  )
  const result = sniffSqlite(path)!
  expect(result.suggested.sqlite?.sessions).toContain('"chat""; DROP TABLE harmless;--"')
  const db = new Database(path, { readonly: true })
  expect(db.query('SELECT COUNT(*) AS n FROM harmless').get()).toEqual({ n: 0 })
  db.close()
})

test('refuses empty/cache-shaped or implausible SQLite databases', () => {
  expect(sniffSqlite(makeSqlite('CREATE TABLE kv(key TEXT, value BLOB)'))).toBeNull()
  expect(sniffSqlite(makeSqlite(
    'CREATE TABLE cache(id TEXT, cwd TEXT, created_at INTEGER)',
    (db) => db.query('INSERT INTO cache VALUES (?,?,?)').run('x', '/root/proj', 1_785_661_200_000),
  ))).toBeNull()
  expect(sniffSqlite(makeSqlite(
    'CREATE TABLE conversation(id TEXT, directory TEXT, created_at INTEGER)',
    (db) => db.query('INSERT INTO conversation VALUES (?,?,?)').run('x', 'not/a/cwd', 123),
  ))).toBeNull()
})

test('SQLite samples contain schema only, and reject symlinks without creating files', () => {
  const secret = 'prompt-secret-value'
  const path = makeSqlite(
    'CREATE TABLE sessions(id TEXT, cwd TEXT, created_at INTEGER, content TEXT)',
    (db) => db.query('INSERT INTO sessions VALUES (?,?,?,?)')
      .run('x', '/root/proj', 1_785_661_200_000, secret),
  )
  const result = sniffSqlite(path)!
  expect(result.sample.join('\n')).not.toContain(secret)
  expect(result.sample.join('').length).toBeLessThanOrEqual(512)

  const link = join(dirname(path), 'link.db')
  symlinkSync(path, link)
  expect(sniffSqlite(link)).toBeNull()
  const absent = join(dirname(path), 'absent.db')
  expect(sniffSqlite(absent)).toBeNull()
  expect(() => readFileSync(absent)).toThrow()
})

test('SQLite inspection rejects oversized schema and projects oversized cells away', () => {
  const huge = 'private-value-'.repeat(20_000)
  const cellPath = makeSqlite(
    'CREATE TABLE sessions(id TEXT, cwd TEXT, created_at TEXT)',
    (db) => db.query('INSERT INTO sessions VALUES (?,?,?)').run(huge, huge, huge),
  )
  expect(sniffSqlite(cellPath)).toBeNull()

  const schemaPath = makeSqlite(
    `CREATE TABLE "sessions_${'x'.repeat(20_000)}"(id TEXT, cwd TEXT, created_at INTEGER)`,
    (db) => {
      const table = db.query("SELECT name FROM sqlite_master WHERE type='table'").get() as { name: string }
      db.query(`INSERT INTO "${table.name.replaceAll('"', '""')}" VALUES (?,?,?)`)
        .run('c1', '/root/proj', 1_785_661_200_000)
    },
  )
  expect(sniffSqlite(schemaPath)).toBeNull()
})

test('escapes JSONL basename glob metacharacters as a literal segment', () => {
  const path = tmpFile('sessions[1]*?.jsonl', sessionLines())
  const globPattern = sniffJsonl(path)!.suggested.jsonl!.glob
  const glob = new Glob(globPattern)
  expect(glob.match(`nested/${basename(path)}`)).toBe(true)
  expect(glob.match('nested/sessions11xx.jsonl')).toBe(false)
})

test('sniffRoots is deterministic, ignores symlinks, and enforces result/work caps', () => {
  const root = tempDir()
  for (let i = 0; i < 230; i++) {
    const dir = join(root, String(i).padStart(3, '0'))
    mkdirSync(dir)
    writeFileSync(join(dir, 'sessions.jsonl'), sessionLines(String(i)))
  }
  const outside = tempDir()
  writeFileSync(join(outside, 'sessions.jsonl'), sessionLines('outside'))
  symlinkSync(outside, join(root, '000-link'))

  const first = sniffRoots([root], 500)
  const second = sniffRoots([root], 500)
  expect(first.length).toBeLessThanOrEqual(200)
  expect(first.map((r) => r.path)).toEqual(second.map((r) => r.path))
  expect(first.every((r) => !r.path.includes('000-link'))).toBe(true)
})

test('sniffRoots caps caller roots before access and deduplicates overlapping roots', () => {
  const root = tempDir()
  const nested = join(root, 'nested')
  mkdirSync(nested)
  writeFileSync(join(nested, 'sessions.jsonl'), sessionLines())
  expect(sniffRoots([root, nested]).map((result) => result.path)).toEqual([
    join(nested, 'sessions.jsonl'),
  ])

  const roots = Array.from({ length: 66 }, () => tempDir())
  Object.defineProperty(roots, 64, {
    get() { throw new Error('root cap exceeded') },
  })
  expect(() => sniffRoots(roots)).not.toThrow()
})

test('sniffRoots bounds entries materialized from one hostile directory', () => {
  const root = tempDir()
  for (let i = 0; i < 300; i++) writeFileSync(join(root, `${String(i).padStart(3, '0')}.txt`), 'x')
  writeFileSync(join(root, 'zzz-sessions.jsonl'), sessionLines())
  expect(sniffRoots([root])).toEqual([])
})

test('candidateRoots normalizes/deduplicates and returns no symlinks', () => {
  const roots = candidateRoots()
  expect(new Set(roots).size).toBe(roots.length)
  expect(roots).toEqual([...roots].sort())
  expect(roots.every((path) => basename(path).length > 0)).toBe(true)
})

test('a JSONL draft declares the unit its timestamps are actually written in', () => {
  // plausibleTime already decides a small number can only be seconds. Emitting
  // that decision keeps the drafted manifest from dating every session to 1970.
  const path = tmpFile('seconds.jsonl',
    JSON.stringify({ ts: 1_787_640_881, cwd: '/root/proj', role: 'user', text: 'secret-user' }) + '\n'
    + JSON.stringify({ ts: 1_787_640_941, cwd: '/root/proj', role: 'assistant', text: 'secret-assistant' }) + '\n')

  const result = sniffJsonl(path)!

  expect(result.suggested.jsonl?.generic?.tsUnit).toBe('s')
  expect(() => validateManifest({
    ...result.suggested, id: 'draft', name: 'Draft', roots: [dirname(path)],
  })).not.toThrow()
})

test('a JSONL draft declares an ISO timestamp field as iso', () => {
  const path = tmpFile('iso.jsonl',
    JSON.stringify({ ts: '2026-08-01T10:00:00.000Z', cwd: '/root/proj', role: 'user', text: 'secret-user' }) + '\n'
    + JSON.stringify({ ts: '2026-08-01T11:00:00.000Z', cwd: '/root/proj', role: 'assistant', text: 'secret-assistant' }) + '\n')

  expect(sniffJsonl(path)!.suggested.jsonl?.generic?.tsUnit).toBe('iso')
})
