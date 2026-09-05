import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/config'
import { buildAdapter, buildAdapters } from '../src/core/adapter'
import { validateManifest, type Manifest } from '../src/manifests/load'

const FIX = join(import.meta.dir, 'fixtures')
const tempDirs: string[] = []

function makeTemp(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(path)
  return path
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

function agyManifest(roots = [join(FIX, 'agy')]): Manifest {
  return validateManifest({
    schema: 1, id: 'agy', name: 'Antigravity CLI', roots,
    format: 'sqlite-store', tier: 'resume',
    sqlite: {
      file: 'conversation_summaries.db',
      sessions: 'SELECT conversation_id AS id, title AS title, preview AS preview, step_count AS turns, last_modified_time AS ended_at, workspace_uris AS cwd_uris FROM conversation_summaries',
      cwdShape: 'file-uri-array', timeUnit: 'iso',
    },
    sidecar: { file: 'history.jsonl', idField: 'conversationId', textField: 'display', tsField: 'timestamp', tsUnit: 'ms', cwdField: 'workspace' },
    resume: { cmd: 'agy', args: ['--conversation', '{id}', '{unknown}'], cwd: '{cwd}' },
    brief: { cmd: 'agy', args: ['{prompt}'], cwd: '{cwd}' },
  })
}

test('detect is false when no root exists', () => {
  expect(buildAdapter(agyManifest(['/nonexistent'])).detect()).toBe(false)
  expect(buildAdapter(agyManifest(['\0invalid'])).detect()).toBe(false)
})

test('agy hydrate takes its text from the sidecar', async () => {
  const adapter = buildAdapter(agyManifest())
  const { refs } = await adapter.discover()
  const doc = await adapter.hydrate(refs[0]!, DEFAULT_CONFIG)
  expect(doc.prompts).toEqual(['i want domination instead of wordworth'])
})

test('plan fills known placeholders and preserves unknown placeholders', async () => {
  const adapter = buildAdapter(agyManifest())
  const { refs } = await adapter.discover()
  expect(adapter.plan(refs[0]!)).toEqual({
    kind: 'resume', cmd: 'agy',
    args: ['--conversation', '597b1c48-7b0c-434a-83d6-14e908a699b5', '{unknown}'],
    cwd: '/root/proj',
  })
  const brief = adapter.plan(refs[0]!, 'where I left off')
  expect(brief).toEqual({
    kind: 'brief', cmd: 'agy', args: ['where I left off'], cwd: '/root/proj',
    prompt: 'where I left off',
  })
  expect(adapter.plan({ ...refs[0]!, cwd: null })).toBeNull()

  expect(adapter.plan(refs[0]!, '')).toEqual({
    kind: 'resume', cmd: 'agy',
    args: ['--conversation', '597b1c48-7b0c-434a-83d6-14e908a699b5', '{unknown}'],
    cwd: '/root/proj',
  })

  const search = buildAdapter({ ...agyManifest(), tier: 'search' })
  expect(search.plan(refs[0]!)).toEqual({
    kind: 'brief', cmd: 'agy', args: [''], cwd: '/root/proj', prompt: '',
  })
})

test('a throwing format is contained in discovery but reported by hydration', async () => {
  const broken = agyManifest()
  broken.sqlite!.sessions = 'SELECT * FROM nope'
  const adapter = buildAdapter(broken)
  const discovered = await adapter.discover()
  expect(discovered.refs).toEqual([])
  expect(discovered.diagnostics.some((item) => item.level === 'error')).toBe(true)
  expect(discovered.authoritative).toBeFalse()

  const good = buildAdapter(agyManifest())
  const { refs } = await good.discover()
  broken.sqlite!.text = 'SELECT * FROM nope WHERE id = ?1'
  // Swallowing this into an empty document would let the new fingerprint be
  // written over the old one, so the session would never be hydrated again.
  await expect(adapter.hydrate(refs[0]!, DEFAULT_CONFIG)).rejects.toThrow()
})

test('discovery explicitly reports warning-class store failures as non-authoritative', async () => {
  const root = makeTemp('nekyia-adapter-incomplete-')
  // A store Nekyia refuses to open leaves the view of this client incomplete,
  // so its sessions stay protected from missing-session pruning.
  const escaping = validateManifest({
    ...agyManifest([root]),
    sqlite: { ...agyManifest([root]).sqlite, file: '../outside.db' },
  })
  const discovered = await buildAdapter(escaping).discover()

  expect(discovered.refs).toEqual([])
  expect(discovered.diagnostics.some((item) => item.level === 'warn')).toBeTrue()
  expect(discovered.authoritative).toBeFalse()
})

test('a client that is installed but never used stays authoritative', async () => {
  const root = makeTemp('nekyia-adapter-unused-')
  const discovered = await buildAdapter(agyManifest([root])).discover()

  // Nothing is wrong here: there are no sessions, and that is a complete
  // answer. Treating it as a gap would disable prune --missing for the client.
  expect(discovered.refs).toEqual([])
  expect(discovered.diagnostics).toEqual([])
  expect(discovered.authoritative).toBeTrue()
})

test('successful built-in discovery is authoritative', async () => {
  expect((await buildAdapter(agyManifest()).discover()).authoritative).toBeTrue()
})

test('a throwing sidecar never escapes discovery or hydration', async () => {
  const manifest = agyManifest()
  const adapter = buildAdapter(manifest)
  const { refs } = await adapter.discover()
  Object.defineProperty(manifest, 'sidecar', {
    configurable: true,
    get() { throw new Error('sidecar exploded') },
  })
  const discovered = await adapter.discover()
  expect(discovered.refs).toHaveLength(1)
  expect(discovered.diagnostics.some((item) => item.message.includes('sidecar failed'))).toBe(true)
  expect(discovered.authoritative).toBeFalse()
  // A sidecar that throws is a failed read, not a size cap.
  const doc = await adapter.hydrate(refs[0]!, DEFAULT_CONFIG)
  expect(doc.truncated).toBe(false)
  expect(doc.degraded).toBe(true)
})

test('multiple roots stay isolated and resolve duplicate ids by manifest order', async () => {
  const temp = makeTemp('nekyia-adapter-')
  const first = join(temp, 'one')
  const second = join(temp, 'two')
  mkdirSync(first)
  mkdirSync(second)
  cpSync(join(FIX, 'agy', 'conversation_summaries.db'), join(first, 'conversation_summaries.db'))
  cpSync(join(FIX, 'agy', 'conversation_summaries.db'), join(second, 'conversation_summaries.db'))
  writeFileSync(join(first, 'history.jsonl'), `${JSON.stringify({ conversationId: '597b1c48-7b0c-434a-83d6-14e908a699b5', display: 'from first', timestamp: 1, workspace: '/one' })}\n`)
  writeFileSync(join(second, 'history.jsonl'), `${JSON.stringify({ conversationId: '597b1c48-7b0c-434a-83d6-14e908a699b5', display: 'from second', timestamp: 2, workspace: '/two' })}\n`)

  const adapter = buildAdapter(agyManifest([first, second]))
  const { refs } = await adapter.discover()
  expect(refs).toHaveLength(1)
  expect(refs[0]!.sourcePaths.every((path) => path.startsWith(first))).toBe(true)
  const doc = await adapter.hydrate(refs[0]!, DEFAULT_CONFIG)
  expect(doc.prompts).toEqual(['from first'])
})

test('root selection uses containment, supports multiple source paths, and deduplicates sidecar prompts', async () => {
  const temp = makeTemp('nekyia-adapter-prefix-')
  const root = join(temp, 'store')
  const sibling = join(temp, 'store-other')
  mkdirSync(root)
  mkdirSync(sibling)
  cpSync(join(FIX, 'agy', 'conversation_summaries.db'), join(root, 'conversation_summaries.db'))
  cpSync(join(FIX, 'agy', 'conversation_summaries.db'), join(sibling, 'conversation_summaries.db'))
  const id = '597b1c48-7b0c-434a-83d6-14e908a699b5'
  writeFileSync(join(root, 'history.jsonl'), `${JSON.stringify({ conversationId: id, display: 'right root' })}\n${JSON.stringify({ conversationId: id, display: 'right root' })}\n`)
  writeFileSync(join(sibling, 'history.jsonl'), `${JSON.stringify({ conversationId: id, display: 'wrong root' })}\n`)

  const adapter = buildAdapter(agyManifest([root, sibling]))
  const { refs } = await adapter.discover()
  const ref = { ...refs[0]!, sourcePaths: [join(root, 'extra'), ...refs[0]!.sourcePaths] }
  const doc = await adapter.hydrate(ref, DEFAULT_CONFIG)
  expect(doc.prompts).toEqual(['right root'])

  const escape = join(root, 'escaped-db')
  symlinkSync(join(sibling, 'conversation_summaries.db'), escape)
  const rejected = await adapter.hydrate({ ...refs[0]!, sourcePaths: [escape] }, DEFAULT_CONFIG)
  expect(rejected).toEqual({
    ref: { ...refs[0]!, sourcePaths: [escape] },
    prompts: [], prose: [], files: [], truncated: false, degraded: true,
  })
})

test('a primary database session wins over the same legacy session id', async () => {
  const temp = makeTemp('nekyia-adapter-primary-')
  cpSync(join(FIX, 'opencode'), temp, { recursive: true })
  const sessionDir = join(temp, 'storage', 'session', 'p1')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'ses_aaa.json'), JSON.stringify({
    id: 'ses_aaa', projectID: 'p1', directory: '/legacy', title: 'legacy duplicate',
    time: { created: 1, updated: 2 },
  }))
  const manifest = validateManifest({
    schema: 1, id: 'opencode', name: 'opencode', roots: [temp],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'opencode.db',
      sessions: 'SELECT id AS id, directory AS cwd, title AS title, parent_id AS parent_id, time_created AS started_at, time_updated AS ended_at FROM session',
      text: 'SELECT m.data AS message_data, p.data AS part_data FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = ?1 ORDER BY p.time_created',
      textShape: 'opencode-part', timeUnit: 'ms', legacy: { path: 'storage' },
    },
    brief: { cmd: 'opencode', args: ['{prompt}'], cwd: '{cwd}' },
  })
  const { refs } = await buildAdapter(manifest).discover()
  const duplicate = refs.filter((ref) => ref.nativeId === 'ses_aaa')
  expect(duplicate).toHaveLength(1)
  expect(duplicate[0]!.title).toBe('Debug event stream drops')
  expect(duplicate[0]!.sourcePaths[0]).toEndWith('opencode.db')
})

test('all source paths must belong to the same root before JSONL hydration', async () => {
  const temp = makeTemp('nekyia-adapter-jsonl-root-')
  const root = join(temp, 'root')
  mkdirSync(root)
  const inside = join(root, 'safe.jsonl')
  const outside = join(temp, 'secret.jsonl')
  writeFileSync(inside, `${JSON.stringify({ message: { role: 'user', content: 'safe' } })}\n`)
  writeFileSync(outside, `${JSON.stringify({ message: { role: 'user', content: 'SECRET_OUTSIDE_ROOT' } })}\n`)
  const manifest = validateManifest({
    schema: 1, id: 'claude-test', name: 'Claude test', roots: [root],
    format: 'jsonl-transcript', tier: 'resume',
    jsonl: { glob: '*.jsonl', variant: 'claude' },
    resume: { cmd: 'claude', args: ['--resume', '{id}'], cwd: '{cwd}' },
  })
  const adapter = buildAdapter(manifest)
  const { refs } = await adapter.discover()
  const ref = { ...refs[0]!, sourcePaths: [outside, inside] }
  const doc = await adapter.hydrate(ref, DEFAULT_CONFIG)
  // No root contains every source path, so nothing was read at all.
  expect(doc.truncated).toBe(false)
  expect(doc.degraded).toBe(true)
  expect([...doc.prompts, ...doc.prose].join('\n')).not.toContain('SECRET_OUTSIDE_ROOT')
})

test('public adapter methods contain malicious getters', async () => {
  const manifest = agyManifest()
  const adapter = buildAdapter(manifest)
  const { refs } = await adapter.discover()

  Object.defineProperty(manifest, 'sqlite', {
    configurable: true,
    get() { throw new Error('sqlite getter exploded') },
  })
  const discovered = await adapter.discover()
  expect(discovered.diagnostics.some((item) => item.level === 'error')).toBe(true)

  const hostileRef = { ...refs[0]! }
  Object.defineProperty(hostileRef, 'sourcePaths', {
    get() { throw new Error('paths getter exploded') },
  })
  expect((await adapter.hydrate(hostileRef, DEFAULT_CONFIG)).degraded).toBe(true)

  const hostilePlanRef = { ...refs[0]! }
  Object.defineProperty(hostilePlanRef, 'cwd', {
    get() { throw new Error('cwd getter exploded') },
  })
  expect(adapter.plan(hostilePlanRef)).toBeNull()
})

test('buildAdapters composes every valid built-in manifest', () => {
  const built = buildAdapters()
  expect(built.adapters.map((adapter) => adapter.id)).toEqual([
    'agy', 'claude', 'codebuff', 'codex', 'copilot', 'kilo', 'opencode',
  ])
  expect(built.diagnostics.every((item) => item.level !== 'error')).toBe(true)
})

test('the shared prompt log is read once a run, not once per session', async () => {
  // Discovery reads the sidecar to enrich every ref, and hydration then read it
  // again for each session, reparsing the whole shared log every time. It also
  // meant the content a session was fingerprinted against and the content
  // eventually stored could come from two different reads of a moving file.
  const adapter = buildAdapter(agyManifest())
  const opened: string[] = []
  const realOpenSync = fs.openSync
  const spy = spyOn(fs, 'openSync').mockImplementation(((
    path: fs.PathLike, flags: number, mode: number,
  ) => {
    if (String(path).endsWith('history.jsonl')) opened.push(String(path))
    return realOpenSync(path, flags, mode)
  }) as typeof fs.openSync)
  try {
    const { refs } = await adapter.discover()
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) await adapter.hydrate(ref, DEFAULT_CONFIG)
  } finally {
    spy.mockRestore()
  }
  expect(opened).toHaveLength(1)
})
