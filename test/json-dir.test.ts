import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/config'
import { jsonDir, readHeadTail } from '../src/formats/json-dir'
import { validateManifest } from '../src/manifests/load'

const FIX = join(import.meta.dir, 'fixtures')
const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

function manifest(root: string) {
  return validateManifest({
    schema: 1, id: 'codebuff', name: 'Codebuff', roots: [root],
    format: 'json-dir', tier: 'search',
    jsonDir: { glob: 'projects/*/chats/*', variant: 'codebuff' },
  })
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-json-dir-'))
  tempDirs.push(root)
  return root
}

function putChat(
  root: string,
  name: string,
  messages: unknown = [{ id: 'u', variant: 'user', content: 'hello' }],
  runState: string | null = '{"sessionState":{"projectRoot":"/repo"},"traceSessionId":"session"}',
  meta?: unknown,
): string {
  const dir = join(root, 'projects/proj/chats', name)
  mkdirSync(dir, { recursive: true })
  if (messages !== null) {
    writeFileSync(join(dir, 'chat-messages.json'),
      typeof messages === 'string' ? messages : JSON.stringify(messages))
  }
  if (runState !== null) writeFileSync(join(dir, 'run-state.json'), runState)
  if (meta !== undefined) {
    writeFileSync(join(dir, 'chat-meta.json'), typeof meta === 'string' ? meta : JSON.stringify(meta))
  }
  return dir
}

test('readHeadTail returns byte-bounded ends without exposing the middle', async () => {
  const root = tempRoot()
  const path = join(root, 'large.txt')
  writeFileSync(path, `head:${'h'.repeat(30)}SECRET-MIDDLE${'t'.repeat(30)}:tail`)
  const { head, tail } = await readHeadTail(path, 16, 16)
  expect(new TextEncoder().encode(head).length).toBeLessThanOrEqual(16)
  expect(new TextEncoder().encode(tail).length).toBeLessThanOrEqual(16)
  expect(head).toStartWith('head:')
  expect(tail).toEndWith(':tail')
  expect(head + tail).not.toContain('SECRET-MIDDLE')
})

test('readHeadTail decodes UTF-8 boundaries independently and stays byte bounded', async () => {
  const root = tempRoot()
  const path = join(root, 'utf8.txt')
  writeFileSync(path, 'ab😀MIDDLE🙃yz')
  const { head, tail } = await readHeadTail(path, 4, 4)
  expect(head).toBe('ab')
  expect(tail).toBe('yz')
  expect(head + tail).not.toContain('MIDDLE')
})

test('readHeadTail normalizes negative and non-finite limits to zero', async () => {
  const root = tempRoot()
  const path = join(root, 'limits.txt')
  writeFileSync(path, 'do not read me')
  expect(await readHeadTail(path, -1, Number.NaN)).toEqual({ head: '', tail: '' })
  expect(await readHeadTail(path, Number.POSITIVE_INFINITY, -5)).toEqual({ head: '', tail: '' })
})

test('discovers bounded metadata without opening log.jsonl', async () => {
  const root = tempRoot()
  const dir = putChat(root, '2026-08-03T07-48-02.374Z', undefined,
    '{"sessionState":{"projectRoot":"/root/proj"},"traceSessionId":"safe-id"}',
    { firstPrompt: 'safe title', messageCount: 1 })
  writeFileSync(join(dir, 'log.jsonl'), 'SENTINEL PRIVATE DEBUG LOG')
  const opened: string[] = []
  const original = fsPromises.open
  const openSpy = spyOn(fsPromises, 'open').mockImplementation((async (path, ...args) => {
    opened.push(String(path))
    if (String(path).endsWith('log.jsonl')) throw new Error('log.jsonl was opened')
    return Reflect.apply(original, fsPromises, [path, ...args])
  }) as typeof fsPromises.open)
  try {
    const { refs } = await jsonDir.discover(manifest(root), root)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.nativeId).toBe('safe-id')
    expect(refs[0]!.cwd).toBe('/root/proj')
    expect(opened.some((path) => path.endsWith('run-state.json'))).toBe(true)
    expect(opened.some((path) => path.endsWith('chat-meta.json'))).toBe(true)
    expect(opened.some((path) => path.endsWith('log.jsonl'))).toBe(false)
  } finally {
    openSpy.mockRestore()
  }
})

test('takes title and turns from bounded chat metadata', async () => {
  const root = join(FIX, 'codebuff')
  const { refs } = await jsonDir.discover(manifest(root), root)
  expect(refs[0]!.title).toBe('install this MCP globally')
  expect(refs[0]!.turns).toBe(3)
})

test('parses startedAt from the chat directory name', async () => {
  const root = join(FIX, 'codebuff')
  const { refs } = await jsonDir.discover(manifest(root), root)
  expect(refs[0]!.startedAt).toBe(Date.parse('2026-08-03T07:48:02.374Z'))
})

test('hydrates exact user and ai variants with content and text blocks', async () => {
  const root = join(FIX, 'codebuff')
  const { refs } = await jsonDir.discover(manifest(root), root)
  const doc = await jsonDir.hydrate(manifest(root), root, refs[0]!, DEFAULT_CONFIG)
  expect(doc.prompts).toEqual(['install this MCP globally'])
  expect(doc.prose).toEqual(['Checking package.json first.', 'Installed globally.'])
})

test('never indexes non-text blocks or private variants', async () => {
  const root = tempRoot()
  putChat(root, '2026-08-05T09-00-00.000Z', [
    { variant: 'user', content: 'safe prompt', blocks: [
      { type: 'text', content: 'safe prompt block' },
      { type: 'tool', content: 'PRIVATE TOOL BLOCK' },
    ] },
    { variant: 'ai', content: 'safe answer', blocks: [
      { type: 'text', content: 'safe answer block' },
      { type: 'reasoning', content: 'PRIVATE REASONING' },
    ] },
    { variant: 'tool', content: 'PRIVATE TOOL' },
    { variant: 'system', content: 'PRIVATE SYSTEM' },
    { variant: 'developer', content: 'PRIVATE DEVELOPER' },
    { variant: 'assistant', content: 'PRIVATE ASSISTANT ALIAS' },
  ])
  const m = manifest(root)
  const ref = (await jsonDir.discover(m, root)).refs[0]!
  const doc = await jsonDir.hydrate(m, root, ref, DEFAULT_CONFIG)
  expect(doc.prompts).toEqual(['safe prompt', 'safe prompt block'])
  expect(doc.prose).toEqual(['safe answer', 'safe answer block'])
  expect(doc.ref.turns).toBe(6)
  expect(JSON.stringify(doc)).not.toContain('PRIVATE')
})

test('config cap preserves all prompts, drops assistant prose, and marks truncation', async () => {
  const root = tempRoot()
  const messages = [
    { variant: 'ai', content: 'drop this answer' },
    { variant: 'user', content: 'keep this prompt' },
    { variant: 'ai', content: 'drop this too' },
    { variant: 'user', blocks: [{ type: 'text', content: 'keep block prompt' }] },
  ]
  putChat(root, '2026-08-05T09-00-00.000Z', messages)
  const m = manifest(root)
  const ref = (await jsonDir.discover(m, root)).refs[0]!
  const doc = await jsonDir.hydrate(m, root, ref, { ...DEFAULT_CONFIG, maxFileBytes: 1 })
  expect(doc.prompts).toEqual(['keep this prompt', 'keep block prompt'])
  expect(doc.prose).toEqual([])
  expect(doc.truncated).toBe(true)
})

test('whole-file config cap suppresses all prose while retaining later prompts', async () => {
  const root = tempRoot()
  const first = JSON.stringify({ variant: 'ai', content: 'early answer' })
  const source = `[${first},${JSON.stringify({ variant: 'ai', content: 'late answer' })},${JSON.stringify({ variant: 'user', content: 'late prompt' })}]`
  putChat(root, '2026-08-05T09-00-00.000Z', source)
  const m = manifest(root)
  const ref = (await jsonDir.discover(m, root)).refs[0]!
  const doc = await jsonDir.hydrate(m, root, ref, {
    ...DEFAULT_CONFIG,
    maxFileBytes: 1 + Buffer.byteLength(first),
  })
  expect(doc.prompts).toEqual(['late prompt'])
  expect(doc.prose).toEqual([])
  expect(doc.truncated).toBe(true)
})

test('hydrate stops at its initial fstat snapshot and sees appends next time', async () => {
  const root = tempRoot()
  const first = JSON.stringify({ variant: 'user', content: 'initial prompt' })
  const second = JSON.stringify({ variant: 'user', content: 'appended prompt' })
  const dir = putChat(root, '2026-08-05T09-00-00.000Z', `[${first}`)
  const messages = join(dir, 'chat-messages.json')
  const m = manifest(root)
  const ref = (await jsonDir.discover(m, root)).refs[0]!
  const original = fsPromises.open
  let appended = false
  const openSpy = spyOn(fsPromises, 'open').mockImplementation((async (path, ...args) => {
    const handle = await Reflect.apply(original, fsPromises, [path, ...args])
    if (String(path) !== messages || appended) return handle
    return {
      stat: async (...statArgs: Parameters<typeof handle.stat>) => {
        const snapshot = await handle.stat(...statArgs)
        appendFileSync(messages, `,${second}]`)
        appended = true
        return snapshot
      },
      read: handle.read.bind(handle),
      close: handle.close.bind(handle),
    } as typeof handle
  }) as typeof fsPromises.open)
  try {
    const snapshotDoc = await jsonDir.hydrate(m, root, ref, DEFAULT_CONFIG)
    expect(snapshotDoc.prompts).toEqual(['initial prompt'])
    expect(snapshotDoc.ref.turns).toBe(1)
    expect(snapshotDoc.truncated).toBe(true)
  } finally {
    openSpy.mockRestore()
  }
  const futureDoc = await jsonDir.hydrate(m, root, ref, DEFAULT_CONFIG)
  expect(futureDoc.prompts).toEqual(['initial prompt', 'appended prompt'])
  expect(futureDoc.ref.turns).toBe(2)
  expect(futureDoc.truncated).toBe(false)
})

test('incrementally hydrates a valid transcript above 64 MiB without Bun.file', async () => {
  const root = tempRoot()
  const dir = putChat(root, '2026-08-05T09-00-00.000Z')
  const messages = join(dir, 'chat-messages.json')
  const fd = openSync(messages, 'w')
  try {
    writeSync(fd, '[')
    const padding = 'x'.repeat(1024 * 1024)
    for (let index = 0; index < 65; index += 1) {
      if (index > 0) writeSync(fd, ',')
      writeSync(fd, JSON.stringify({ variant: 'ai', content: padding }))
    }
    writeSync(fd, `,${JSON.stringify({ variant: 'user', content: 'prompt beyond old ceiling' })}]`)
  } finally {
    closeSync(fd)
  }
  const m = manifest(root)
  const ref = (await jsonDir.discover(m, root)).refs[0]!
  const original = Bun.file
  const fileSpy = spyOn(Bun, 'file').mockImplementation(((path: Bun.PathLike, ...args: unknown[]) => {
    if (String(path).endsWith('chat-messages.json')) throw new Error('whole-file API used')
    return Reflect.apply(original, Bun, [path, ...args]) as ReturnType<typeof Bun.file>
  }) as typeof Bun.file)
  try {
    const doc = await jsonDir.hydrate(m, root, ref, { ...DEFAULT_CONFIG, maxFileBytes: 1 })
    expect(doc.prompts).toEqual(['prompt beyond old ceiling'])
    expect(doc.prose).toEqual([])
    expect(doc.ref.turns).toBe(66)
    expect(doc.truncated).toBe(true)
  } finally {
    fileSpy.mockRestore()
  }
})

test('skips an oversized element, resumes at the next element, and marks truncation', async () => {
  const root = tempRoot()
  const huge = 'PRIVATE OVERSIZED ANSWER '.repeat(800_000)
  putChat(root, '2026-08-05T09-00-00.000Z', [
    { variant: 'ai', content: huge },
    { variant: 'user', content: 'safe later prompt' },
  ])
  const m = manifest(root)
  const ref = (await jsonDir.discover(m, root)).refs[0]!
  const doc = await jsonDir.hydrate(m, root, ref, DEFAULT_CONFIG)
  expect(doc.prompts).toEqual(['safe later prompt'])
  expect(doc.prose).toEqual([])
  expect(doc.ref.turns).toBe(2)
  expect(doc.truncated).toBe(true)
  expect(JSON.stringify(doc)).not.toContain('PRIVATE OVERSIZED ANSWER')
})

test('a chat directory with no chat-meta still discovers', async () => {
  const root = join(FIX, 'codebuff-nometa')
  const { refs } = await jsonDir.discover(manifest(root), root)
  expect(refs).toHaveLength(1)
  expect(refs[0]!.title).toBe(null)
})

test('malformed or missing files are localized and deterministic', async () => {
  const root = tempRoot()
  putChat(root, '2026-08-05T09-00-02.000Z', null, null)
  putChat(root, '2026-08-05T09-00-01.000Z', '{bad', '{bad', '{bad')
  putChat(root, '2026-08-05T09-00-00.000Z', undefined, null)
  const result = await jsonDir.discover(manifest(root), root)
  expect(result.refs.map((ref) => ref.nativeId)).toEqual([
    '2026-08-05T09-00-00.000Z',
    '2026-08-05T09-00-01.000Z',
  ])
  expect(result.diagnostics.length).toBeGreaterThanOrEqual(3)
  const bad = result.refs.find((ref) => ref.nativeId.endsWith('01.000Z'))!
  const doc = await jsonDir.hydrate(manifest(root), root, bad, DEFAULT_CONFIG)
  expect(doc.prompts).toEqual([])
  expect(doc.truncated).toBe(true)
})

test('normalizes ids and falls back to a nonempty directory id', async () => {
  const root = tempRoot()
  putChat(root, '2026-08-05T09-00-01.000Z', undefined,
    '{"sessionState":{"cwd":" /repo "},"traceSessionId":"  stable-id  "}')
  putChat(root, '2026-08-05T09-00-00.000Z', undefined,
    '{"traceSessionId":"   "}')
  const { refs } = await jsonDir.discover(manifest(root), root)
  expect(refs.map((ref) => ref.nativeId)).toEqual([
    '2026-08-05T09-00-00.000Z', 'stable-id',
  ])
  expect(refs[1]!.cwd).toBe('/repo')
})

test('rejects glob matches that escape root through symlinks', async () => {
  const temp = tempRoot()
  const root = join(temp, 'root')
  const outside = join(temp, 'outside')
  putChat(outside, '2026-08-05T09-00-00.000Z', [
    { variant: 'user', content: 'OUTSIDE SECRET' },
  ])
  mkdirSync(join(root, 'projects/proj'), { recursive: true })
  symlinkSync(join(outside, 'projects/proj/chats'), join(root, 'projects/proj/chats'))
  const result = await jsonDir.discover(manifest(root), root)
  expect(result.refs).toEqual([])
  expect(JSON.stringify(result)).not.toContain('OUTSIDE SECRET')
})

test('all relevant metadata sources are fingerprinted in deterministic order', async () => {
  const root = tempRoot()
  const dir = putChat(root, '2026-08-05T09-00-00.000Z', undefined, undefined,
    { firstPrompt: 'before', messageCount: 1 })
  const m = manifest(root)
  const first = (await jsonDir.discover(m, root)).refs[0]!
  expect(first.sourcePaths.map((path) => basename(path))).toEqual([
    'chat-messages.json', 'run-state.json', 'chat-meta.json',
  ])
  writeFileSync(join(dir, 'chat-meta.json'), JSON.stringify({
    firstPrompt: 'metadata title changed', messageCount: 1,
  }))
  const second = (await jsonDir.discover(m, root)).refs[0]!
  expect(second.fingerprint).not.toBe(first.fingerprint)
})

test('metadata fields and fingerprint come from the same stable file snapshots', async () => {
  const root = tempRoot()
  const dir = putChat(root, '2026-08-05T09-00-00.000Z', undefined,
    '{"sessionState":{"cwd":"/old"},"traceSessionId":"coherent"}',
    { firstPrompt: 'old title', messageCount: 1 })
  const runState = join(dir, 'run-state.json')
  const meta = join(dir, 'chat-meta.json')
  const replacements = new Map<string, string>([
    [runState, '{"sessionState":{"cwd":"/new"},"traceSessionId":"coherent"}'],
    [meta, JSON.stringify({ firstPrompt: 'new title', messageCount: 2 })],
  ])
  const mutated = new Set<string>()
  const original = fsPromises.open
  const openSpy = spyOn(fsPromises, 'open').mockImplementation((async (path, ...args) => {
    const handle = await Reflect.apply(original, fsPromises, [path, ...args])
    const name = String(path)
    const replacement = replacements.get(name)
    if (replacement === undefined || mutated.has(name)) return handle
    let statCalls = 0
    return {
      stat: async (...statArgs: Parameters<typeof handle.stat>) => {
        statCalls += 1
        if (statCalls === 2) {
          writeFileSync(name, replacement)
          mutated.add(name)
        }
        return handle.stat(...statArgs)
      },
      read: handle.read.bind(handle),
      close: handle.close.bind(handle),
    } as typeof handle
  }) as typeof fsPromises.open)
  let coherent
  try {
    coherent = (await jsonDir.discover(manifest(root), root)).refs[0]!
  } finally {
    openSpy.mockRestore()
  }
  expect(mutated).toEqual(new Set([runState, meta]))
  expect(coherent.cwd).toBe('/new')
  expect(coherent.title).toBe('new title')
  expect(coherent.turns).toBe(2)

  const next = (await jsonDir.discover(manifest(root), root)).refs[0]!
  expect(next.fingerprint).toBe(coherent.fingerprint)
  expect(next.cwd).toBe(coherent.cwd)
  expect(next.title).toBe(coherent.title)
})

test('deduplicates repeated native ids by completeness then recency', async () => {
  const root = tempRoot()
  putChat(root, '2026-08-05T09-00-00.000Z', undefined,
    '{"sessionState":{"cwd":"/chosen"},"traceSessionId":"duplicate"}')
  const newer = join(root, 'projects/other/chats/2026-08-05T09-00-01.000Z')
  mkdirSync(newer, { recursive: true })
  writeFileSync(join(newer, 'chat-messages.json'), JSON.stringify([
    { variant: 'user', content: 'chosen' },
  ]))
  writeFileSync(join(newer, 'run-state.json'), '{"traceSessionId":"duplicate"}')
  writeFileSync(join(newer, 'chat-meta.json'), '{bad')
  const result = await jsonDir.discover(manifest(root), root)
  expect(result.refs).toHaveLength(1)
  expect(result.refs[0]!.cwd).toBe('/chosen')
  expect(result.diagnostics.some((item) => item.message.includes('duplicate'))).toBe(true)
})
