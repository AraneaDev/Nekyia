import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/config'
import type { Adapter } from '../src/core/adapter'
import { buildAdapter } from '../src/core/adapter'
import { IndexDb } from '../src/core/db'
import { scan } from '../src/core/discover'
import { validateManifest } from '../src/manifests/load'
import type { Diagnostic, SessionRef } from '../src/types'

const FIX = join(import.meta.dir, 'fixtures')
const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

function ref(client: string, nativeId: string, over: Partial<SessionRef> = {}): SessionRef {
  return {
    uid: `${client}:${nativeId}`,
    client,
    nativeId,
    cwd: '/root/proj',
    gitBranch: null,
    title: nativeId,
    startedAt: 1,
    endedAt: 2,
    turns: 1,
    parentNativeId: null,
    tier: 'search',
    origin: 'manifest',
    sourcePaths: [`/${client}/${nativeId}`],
    fingerprint: `${nativeId}:1`,
    ...over,
  }
}

function fakeAdapter(
  id: string,
  options: {
    detected?: boolean
    refs?: SessionRef[]
    diagnostics?: Diagnostic[]
    detectError?: unknown
    discoverError?: unknown
    discover?: () => Promise<{ refs: SessionRef[]; diagnostics: Diagnostic[] }>
  } = {},
): Adapter {
  return {
    id,
    manifest: {} as Adapter['manifest'],
    detect() {
      if (options.detectError !== undefined) throw options.detectError
      return options.detected ?? true
    },
    async discover() {
      if (options.discover) return options.discover()
      if (options.discoverError !== undefined) throw options.discoverError
      return { refs: options.refs ?? [], diagnostics: options.diagnostics ?? [] }
    },
    async hydrate() { throw new Error('not used') },
    plan() { return null },
  }
}

const claude = buildAdapter(validateManifest({
  schema: 1,
  id: 'claude',
  name: 'Claude Code',
  roots: [join(FIX, 'claude')],
  format: 'jsonl-transcript',
  tier: 'resume',
  jsonl: { glob: 'projects/*/*.jsonl', variant: 'claude' },
  resume: { cmd: 'claude', args: ['--resume', '{id}'], cwd: '{cwd}' },
}))

test('everything is changed against an empty index', async () => {
  const db = IndexDb.open(':memory:')
  const result = await scan(db, DEFAULT_CONFIG, [claude])
  expect(result.refs).toHaveLength(1)
  expect(result.changed).toHaveLength(1)
  db.close()
})

test('nothing is changed on a second scan with no edits', async () => {
  const db = IndexDb.open(':memory:')
  const first = await scan(db, DEFAULT_CONFIG, [claude])
  for (const item of first.changed) db.upsertRef(item)
  expect((await scan(db, DEFAULT_CONFIG, [claude])).changed).toEqual([])
  db.close()
})

test('excluded directories never reach the index', async () => {
  const db = IndexDb.open(':memory:')
  const result = await scan(db, {
    ...DEFAULT_CONFIG,
    exclude: ['/root/proj/**', '/root/proj'],
  }, [claude])
  expect(result.refs).toEqual([])
  expect(result.changed).toEqual([])
  db.close()
})

test('an excluded previously indexed ref is reported missing', async () => {
  const db = IndexDb.open(':memory:')
  const indexed = ref('alpha', 'secret', { cwd: '/root/secret' })
  db.upsertRef(indexed)
  const result = await scan(db, {
    ...DEFAULT_CONFIG,
    exclude: ['/root/secret'],
  }, [fakeAdapter('alpha', { refs: [indexed] })])
  expect(result.refs).toEqual([])
  expect(result.missing).toEqual(['alpha:secret'])
  db.close()
})

test('sessions in the index but gone from disk are reported missing', async () => {
  const db = IndexDb.open(':memory:')
  const first = await scan(db, DEFAULT_CONFIG, [claude])
  for (const item of first.changed) db.upsertRef(item)
  db.upsertRef({ ...first.refs[0]!, uid: 'claude:vanished', nativeId: 'vanished' })
  expect((await scan(db, DEFAULT_CONFIG, [claude])).missing).toEqual(['claude:vanished'])
  db.close()
})

test('missing is global, including clients whose manifests were omitted', async () => {
  const db = IndexDb.open(':memory:')
  db.upsertRef(ref('alpha', 'gone'))
  db.upsertRef(ref('removed-manifest', 'gone'))

  const result = await scan(db, DEFAULT_CONFIG, [fakeAdapter('alpha', { detected: false })])

  expect(result.missing).toEqual(['alpha:gone', 'removed-manifest:gone'])
  expect(result.diagnostics).toEqual([
    { client: 'alpha', level: 'ok', path: null, message: 'not installed' },
  ])
  db.close()
})

test('transient adapter failures protect their unseen sessions from missing', async () => {
  const db = IndexDb.open(':memory:')
  for (const client of ['detect-broken', 'discover-broken', 'diagnostic-broken']) {
    db.upsertRef(ref(client, 'existing'))
  }
  db.upsertRef(ref('removed-manifest', 'gone'))

  const result = await scan(db, DEFAULT_CONFIG, [
    fakeAdapter('detect-broken', { detectError: new Error('detect boom') }),
    fakeAdapter('discover-broken', { discoverError: new Error('discover boom') }),
    fakeAdapter('diagnostic-broken', { diagnostics: [{
      client: 'diagnostic-broken', level: 'error', path: '/store', message: 'partial failure',
    }] }),
  ])

  expect(result.missing).toEqual(['removed-manifest:gone'])
  db.close()
})

test('a returned missing ref is changed even when its fingerprint is unchanged', async () => {
  const db = IndexDb.open(':memory:')
  const returned = ref('alpha', 'restored')
  db.upsertRef(returned)
  db.markMissing([returned.uid])

  const restored = await scan(db, DEFAULT_CONFIG, [fakeAdapter('alpha', { refs: [returned] })])
  expect(restored.changed).toEqual([returned])
  db.upsertRef(restored.changed[0]!)
  expect(db.getRef(returned.uid)?.missing).toBeFalse()
  expect((await scan(db, DEFAULT_CONFIG, [fakeAdapter('alpha', { refs: [returned] })])).changed)
    .toEqual([])
  db.close()
})

test('an adapter that is not installed contributes nothing and does not fail', async () => {
  const db = IndexDb.open(':memory:')
  const absent = buildAdapter(validateManifest({
    schema: 1,
    id: 'ghost',
    name: 'Ghost',
    roots: ['/nonexistent'],
    format: 'jsonl-transcript',
    tier: 'search',
    jsonl: { glob: '*.jsonl', variant: 'claude' },
  }))
  const result = await scan(db, DEFAULT_CONFIG, [claude, absent])
  expect(result.refs).toHaveLength(1)
  expect(result.diagnostics).toContainEqual({
    client: 'ghost', level: 'ok', path: null, message: 'not installed',
  })
  db.close()
})

test('detect and discover exceptions are contained as diagnostics', async () => {
  const db = IndexDb.open(':memory:')
  const result = await scan(db, DEFAULT_CONFIG, [
    fakeAdapter('detect-broken', { detectError: new Error('detect boom') }),
    fakeAdapter('discover-broken', { discoverError: new Error('discover boom') }),
  ])

  expect(result.refs).toEqual([])
  expect(result.diagnostics).toEqual([
    { client: 'detect-broken', level: 'error', path: null, message: 'detect failed: detect boom' },
    { client: 'discover-broken', level: 'error', path: null, message: 'discover failed: discover boom' },
  ])
  db.close()
})

test('adapter discovery actually overlaps', async () => {
  const db = IndexDb.open(':memory:')
  let active = 0
  let maximumActive = 0
  const discover = async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await Bun.sleep(25)
    active -= 1
    return { refs: [], diagnostics: [] }
  }

  await scan(db, DEFAULT_CONFIG, [
    fakeAdapter('alpha', { discover }),
    fakeAdapter('beta', { discover }),
  ])

  expect(maximumActive).toBe(2)
  db.close()
})

test('duplicate UIDs deterministically keep the first adapter result without mutating refs', async () => {
  const db = IndexDb.open(':memory:')
  const sourcePaths = Object.freeze(['/alpha/one'])
  const first = Object.freeze(ref('alpha', 'one', {
    title: 'first', sourcePaths: sourcePaths as unknown as string[],
  }))
  const second = ref('alpha', 'one', {
    title: 'second', fingerprint: 'second:2', sourcePaths: ['/alpha/two'],
  })

  const result = await scan(db, DEFAULT_CONFIG, [
    fakeAdapter('alpha', { refs: [first] }),
    fakeAdapter('alpha', { refs: [second] }),
  ])

  expect(result.refs).toEqual([first])
  expect(result.changed).toEqual([first])
  expect(first.title).toBe('first')
  expect(first.sourcePaths).toEqual(['/alpha/one'])
  expect(result.diagnostics).toContainEqual({
    client: 'alpha',
    level: 'warn',
    path: '/alpha/one',
    message: 'duplicate uid alpha:one; kept /alpha/one, dropped /alpha/two',
  })
  db.close()
})

test('diagnostics retain deterministic adapter order despite completion order', async () => {
  const db = IndexDb.open(':memory:')
  const diagnostic = (client: string): Diagnostic => ({
    client, level: 'warn', path: null, message: `${client} warning`,
  })
  const result = await scan(db, DEFAULT_CONFIG, [
    fakeAdapter('slow', { discover: async () => {
      await Bun.sleep(20)
      return { refs: [], diagnostics: [diagnostic('slow')] }
    } }),
    fakeAdapter('fast', { diagnostics: [diagnostic('fast')] }),
  ])

  expect(result.diagnostics).toEqual([diagnostic('slow'), diagnostic('fast')])
  db.close()
})

test('sidecar entry changes affect only their matching session fingerprint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-discover-sidecar-'))
  tempDirs.push(root)
  const sessions = join(root, 'sessions')
  mkdirSync(sessions)
  const firstId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const secondId = 'ffffffff-1111-2222-3333-444444444444'
  writeFileSync(join(sessions, 'first.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { session_id: firstId, cwd: '/root/proj' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'from transcript' } }),
  ].join('\n'))
  writeFileSync(join(sessions, 'second.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { session_id: secondId, cwd: '/root/other' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'second transcript' } }),
  ].join('\n'))
  const history = join(root, 'history.jsonl')
  const historyLine = (session_id: string, text: string) => JSON.stringify({ session_id, text })
  writeFileSync(history, [historyLine(firstId, 'first'), historyLine(secondId, 'second')].join('\n'))
  const adapter = buildAdapter(validateManifest({
    schema: 1,
    id: 'codex-test',
    name: 'Codex test',
    roots: [root],
    format: 'jsonl-transcript',
    tier: 'resume',
    jsonl: { glob: 'sessions/*.jsonl', variant: 'codex' },
    sidecar: { file: 'history.jsonl', idField: 'session_id', textField: 'text' },
    resume: { cmd: 'codex', args: ['resume', '{id}'], cwd: '{cwd}' },
  }))
  const db = IndexDb.open(':memory:')

  const first = await scan(db, DEFAULT_CONFIG, [adapter])
  expect(first.changed).toHaveLength(2)
  for (const item of first.changed) {
    expect(item.sourcePaths).toContain(history)
    db.upsertRef(item)
  }

  writeFileSync(history, [
    historyLine(firstId, 'a meaningfully longer prompt'),
    historyLine(secondId, 'second'),
  ].join('\n'))
  const edited = await scan(db, DEFAULT_CONFIG, [adapter])
  expect(edited.changed.map((item) => item.nativeId)).toEqual([firstId])
  db.upsertRef(edited.changed[0]!)

  writeFileSync(history, historyLine(secondId, 'second'))
  const removed = await scan(db, DEFAULT_CONFIG, [adapter])
  expect(removed.changed.map((item) => item.nativeId)).toEqual([firstId])
  expect(removed.changed[0]!.sourcePaths).not.toContain(history)
  db.upsertRef(removed.changed[0]!)

  writeFileSync(history, [historyLine(firstId, 'added back'), historyLine(secondId, 'second')].join('\n'))
  const added = await scan(db, DEFAULT_CONFIG, [adapter])
  expect(added.changed.map((item) => item.nativeId)).toEqual([firstId])
  expect(added.changed[0]!.sourcePaths).toContain(history)
  db.close()
})
