import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/config'
import { discoverLegacy, hydrateLegacy } from '../src/formats/opencode-legacy'
import { validateManifest } from '../src/manifests/load'

const FIX = join(import.meta.dir, 'fixtures')
const tempDirs: string[] = []
const m = validateManifest({
  schema: 1, id: 'opencode', name: 'opencode', roots: [join(FIX, 'opencode')],
  format: 'sqlite-store', tier: 'search',
  sqlite: { file: 'opencode.db', sessions: 'SELECT 1', legacy: { path: 'storage' } },
})

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('discovers sessions from the json tree', async () => {
  const { refs } = await discoverLegacy(m, join(FIX, 'opencode'))
  expect(refs.map((r) => r.nativeId)).toEqual(['ses_old'])
  expect(refs[0]!.cwd).toBe('/root/legacy')
  expect(refs[0]!.title).toBe('An older session from the json era')
  expect(refs[0]!.startedAt).toBe(1780000000000)
})

test('hydrates text by joining parts to their message role', async () => {
  const { refs } = await discoverLegacy(m, join(FIX, 'opencode'))
  const doc = await hydrateLegacy(m, join(FIX, 'opencode'), refs[0]!)
  expect(doc.prompts).toEqual(['why did the legacy importer break'])
  expect(doc.prose).toEqual([])
})

test('returns nothing when the storage tree is absent', async () => {
  const { refs } = await discoverLegacy(m, '/nonexistent')
  expect(refs).toEqual([])
})

test('validates the legacy manifest shape', () => {
  expect(m.sqlite?.legacy).toEqual({ path: 'storage' })
  expect(() => validateManifest({
    schema: 1, id: 'bad', name: 'bad', roots: ['/tmp'], format: 'sqlite-store', tier: 'search',
    sqlite: { file: 'x.db', sessions: 'SELECT 1', legacy: { path: 42 } },
  })).toThrow('sqlite.legacy.path must be a string')
})

function makeLegacyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-legacy-'))
  tempDirs.push(root)
  return root
}

function put(root: string, path: string, value: unknown): void {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value))
}

function tempManifest(root: string, legacyPath = 'storage') {
  return validateManifest({
    schema: 1, id: 'legacy', name: 'legacy', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: { file: 'unused.db', sessions: 'SELECT 1', legacy: { path: legacyPath } },
  })
}

test('localizes malformed session diagnostics and continues discovery in chronological order', async () => {
  const root = makeLegacyRoot()
  put(root, 'storage/session/p1/bad.json', '{oops')
  put(root, 'storage/session/p1/z.json', {
    id: ' second ', projectID: 'p1', directory: '/two', title: 'Second',
    time: { created: 20, updated: 21 },
  })
  put(root, 'storage/session/p1/a.json', {
    id: ' first ', projectID: 'p1', directory: '/one', title: 'First',
    time: { created: 10, updated: 11 },
  })

  const result = await discoverLegacy(tempManifest(root), root)
  expect(result.refs.map((ref) => ref.nativeId)).toEqual(['first', 'second'])
  expect(result.diagnostics).toHaveLength(1)
  expect(result.diagnostics[0]?.path).toEndWith('bad.json')
})

test('hydrates only matching user and assistant text in deterministic chronological order', async () => {
  const root = makeLegacyRoot()
  put(root, 'storage/session/p/s.json', {
    id: ' ses ', projectID: 'p', directory: '/repo', time: { created: 1, updated: 9 },
  })
  put(root, 'storage/message/ses/z.json', {
    id: ' msg_b ', sessionID: 'ses', role: 'assistant', time: { created: 20 },
  })
  put(root, 'storage/message/ses/a.json', {
    id: 'msg_a', sessionID: ' ses ', role: 'user', time: { created: 10 },
  })
  put(root, 'storage/message/ses/dev.json', {
    id: 'dev', sessionID: 'ses', role: 'developer', time: { created: 5 },
  })
  put(root, 'storage/message/ses/wrong.json', {
    id: 'wrong', sessionID: 'another', role: 'user', time: { created: 1 },
  })
  put(root, 'storage/part/msg_a/b.json', {
    id: 'p2', sessionID: 'ses', messageID: 'msg_a', type: 'text', text: 'second prompt',
    time: { created: 12 },
  })
  put(root, 'storage/part/msg_a/a.json', {
    id: 'p1', sessionID: 'ses', messageID: 'msg_a', type: 'text', text: 'first prompt',
    time: { created: 11 },
  })
  put(root, 'storage/part/msg_b/a.json', {
    id: 'p3', sessionID: 'ses', messageID: 'msg_b', type: 'text', text: 'answer',
    time: { created: 21 },
  })
  put(root, 'storage/part/msg_b/wrong.json', {
    id: 'p4', sessionID: 'other', messageID: 'msg_b', type: 'text', text: 'PRIVATE',
  })

  const manifest = tempManifest(root)
  const ref = (await discoverLegacy(manifest, root)).refs[0]!
  const doc = await hydrateLegacy(manifest, root, ref)
  expect(doc.prompts).toEqual(['first prompt', 'second prompt'])
  expect(doc.prose).toEqual(['answer'])
  expect(JSON.stringify(doc)).not.toContain('PRIVATE')
})

test('collects tool paths only from state.input and never indexes tool output', async () => {
  const root = makeLegacyRoot()
  put(root, 'storage/session/p/s.json', {
    id: 'ses', projectID: 'p', time: { created: 1, updated: 2 },
  })
  put(root, 'storage/message/ses/m.json', {
    id: 'msg', sessionID: 'ses', role: 'tool', time: { created: 1 },
  })
  put(root, 'storage/part/msg/private.json', {
    id: 'private', sessionID: 'ses', messageID: 'msg', type: 'text',
    text: 'PRIVATE TOOL ROLE TEXT',
  })
  put(root, 'storage/part/msg/tool.json', {
    id: 'tool', sessionID: 'ses', messageID: 'msg', type: 'tool',
    state: {
      input: { filePath: '/safe/input.ts' },
      output: 'SECRET_TOOL_OUTPUT /private/output.ts',
    },
  })
  const manifest = tempManifest(root)
  const ref = (await discoverLegacy(manifest, root)).refs[0]!
  const doc = await hydrateLegacy(manifest, root, ref)
  expect(doc.files).toEqual(['/safe/input.ts'])
  expect(JSON.stringify(doc)).not.toContain('SECRET_TOOL_OUTPUT')
  expect(JSON.stringify(doc)).not.toContain('/private/output.ts')
  expect(JSON.stringify(doc)).not.toContain('PRIVATE TOOL ROLE TEXT')
})

test('discovery fingerprints every relevant legacy source and tracks add, change, and delete', async () => {
  const root = makeLegacyRoot()
  put(root, 'storage/session/p/s.json', {
    id: 'ses', projectID: 'p', time: { created: 1, updated: 2 },
  })
  put(root, 'storage/message/ses/m.json', {
    id: 'msg', sessionID: 'ses', role: 'assistant', time: { created: 1 },
  })
  put(root, 'storage/part/msg/broken.json', '{bad')
  const manifest = tempManifest(root)

  const initial = (await discoverLegacy(manifest, root)).refs[0]!
  expect(initial.sourcePaths.map((path) => basename(path))).toEqual(['s.json', 'm.json', 'broken.json'])

  put(root, 'storage/part/msg/broken.json', {
    id: 'fixed', sessionID: 'ses', messageID: 'msg', type: 'text', text: 'now fixed',
  })
  const changed = (await discoverLegacy(manifest, root)).refs[0]!
  expect(changed.fingerprint).not.toBe(initial.fingerprint)

  put(root, 'storage/part/msg/added.json', {
    id: 'added', sessionID: 'ses', messageID: 'msg', type: 'text', text: 'added',
  })
  const added = (await discoverLegacy(manifest, root)).refs[0]!
  expect(added.sourcePaths.map((path) => basename(path))).toEqual([
    's.json', 'm.json', 'added.json', 'broken.json',
  ])
  expect(added.fingerprint).not.toBe(changed.fingerprint)

  rmSync(join(root, 'storage/part/msg/broken.json'))
  const deleted = (await discoverLegacy(manifest, root)).refs[0]!
  expect(deleted.sourcePaths.map((path) => basename(path))).toEqual(['s.json', 'm.json', 'added.json'])
  expect(deleted.fingerprint).not.toBe(added.fingerprint)
})

test('global byte budget drops assistant prose but preserves prompts and tool facets', async () => {
  const root = makeLegacyRoot()
  put(root, 'storage/session/p/s.json', {
    id: 'ses', projectID: 'p', time: { created: 1, updated: 2 },
  })
  put(root, 'storage/message/ses/a.json', {
    id: 'assistant', sessionID: 'ses', role: 'assistant', time: { created: 1 },
  })
  put(root, 'storage/message/ses/u.json', {
    id: 'user', sessionID: 'ses', role: 'user', time: { created: 2 },
  })
  for (let index = 0; index < 10; index += 1) {
    put(root, `storage/part/assistant/${index}.json`, {
      id: `answer-${index}`, sessionID: 'ses', messageID: 'assistant', type: 'text',
      text: `assistant answer ${index}`,
    })
  }
  put(root, 'storage/part/user/prompt.json', {
    id: 'prompt', sessionID: 'ses', messageID: 'user', type: 'text', text: 'keep prompt',
  })
  put(root, 'storage/part/user/tool.json', {
    id: 'tool', sessionID: 'ses', messageID: 'user', type: 'tool',
    state: { input: { filePath: '/keep/facet.ts' }, output: 'SECRET OUTPUT' },
  })

  const manifest = tempManifest(root)
  const ref = (await discoverLegacy(manifest, root)).refs[0]!
  const doc = await hydrateLegacy(
    manifest,
    root,
    ref,
    { ...DEFAULT_CONFIG, maxFileBytes: 400 },
  )
  expect(doc.prompts).toEqual(['keep prompt'])
  expect(doc.files).toEqual(['/keep/facet.ts'])
  expect(doc.prose.length).toBeLessThan(10)
  expect(doc.prose).toEqual(['assistant answer 0', 'assistant answer 1', 'assistant answer 2'])
  expect(doc.truncated).toBe(true)
  expect(JSON.stringify(doc)).not.toContain('SECRET OUTPUT')
})

test('malformed relevant hydration files mark the document truncated', async () => {
  const root = makeLegacyRoot()
  put(root, 'storage/session/p/s.json', {
    id: 'ses', projectID: 'p', time: { created: 1, updated: 2 },
  })
  put(root, 'storage/message/ses/m.json', {
    id: 'msg', sessionID: 'ses', role: 'assistant', time: { created: 1 },
  })
  put(root, 'storage/part/msg/bad.json', '{oops')
  const manifest = tempManifest(root)
  const ref = (await discoverLegacy(manifest, root)).refs[0]!
  expect((await hydrateLegacy(manifest, root, ref)).truncated).toBe(true)
})

test('legacy storage cannot escape the manifest root lexically or through symlinks', async () => {
  const root = makeLegacyRoot()
  const outside = makeLegacyRoot()
  put(outside, 'session/p/s.json', {
    id: 'outside', projectID: 'p', time: { created: 1, updated: 2 },
  })
  symlinkSync(outside, join(root, 'linked'))

  for (const legacyPath of ['../outside', outside, 'linked']) {
    const result = await discoverLegacy(tempManifest(root, legacyPath), root)
    expect(result.refs).toEqual([])
  }
})

test('oversized part files are skipped and mark hydration truncated without losing safe facets', async () => {
  const root = makeLegacyRoot()
  put(root, 'storage/session/p/s.json', {
    id: 'ses', projectID: 'p', time: { created: 1, updated: 2 },
  })
  put(root, 'storage/message/ses/user.json', {
    id: 'user', sessionID: 'ses', role: 'user', time: { created: 1 },
  })
  put(root, 'storage/message/ses/assistant.json', {
    id: 'assistant', sessionID: 'ses', role: 'assistant', time: { created: 2 },
  })
  put(root, 'storage/part/user/prompt.json', {
    id: 'prompt', sessionID: 'ses', messageID: 'user', type: 'text', text: 'keep prompt',
  })
  put(root, 'storage/part/user/tool.json', {
    id: 'tool', sessionID: 'ses', messageID: 'user', type: 'tool',
    state: { input: { path: '/keep/tool.ts' } },
  })
  put(root, 'storage/part/assistant/huge.json', `${'x'.repeat(4 * 1024 * 1024 + 1)}`)

  const manifest = tempManifest(root)
  const ref = (await discoverLegacy(manifest, root)).refs[0]!
  const doc = await hydrateLegacy(manifest, root, ref)
  expect(doc.prompts).toEqual(['keep prompt'])
  expect(doc.files).toEqual(['/keep/tool.ts'])
  expect(doc.prose).toEqual([])
  expect(doc.truncated).toBe(true)
})

test('legacy discovery reads time in the unit the manifest declares', async () => {
  const root = makeLegacyRoot()
  put(root, join('storage', 'session', 'proj', 'ses_seconds.json'), {
    id: 'ses_seconds',
    projectID: 'proj',
    directory: '/root/proj',
    title: 'a seconds-based store',
    time: { created: 1_787_640_881, updated: 1_787_640_941 },
  })
  const seconds = validateManifest({
    schema: 1, id: 'legacy', name: 'legacy', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'unused.db', sessions: 'SELECT 1', timeUnit: 's', legacy: { path: 'storage' },
    },
  })

  const { refs } = await discoverLegacy(seconds, root)

  // Both readers serve the same manifest. Reading these as milliseconds would
  // date the session to 1970 while its SQLite sibling reports 2026.
  expect(refs[0]!.startedAt).toBe(1_787_640_881_000)
  expect(refs[0]!.endedAt).toBe(1_787_640_941_000)
})

test('a legacy session id that could never round-trip through a uid is refused', async () => {
  const root = makeLegacyRoot()
  const path = join('storage', 'session', 'proj', 'bad.json')
  put(root, path, {
    id: 'ses\u202ebad',
    projectID: 'proj',
    directory: '/root/proj',
    title: 'a hostile id',
    time: { created: 1, updated: 2 },
  })

  const { refs, diagnostics } = await discoverLegacy(tempManifest(root), root)

  expect(refs).toEqual([])
  expect(diagnostics).toHaveLength(1)
  expect(diagnostics[0]!.level).toBe('warn')
  expect(diagnostics[0]!.path).toBe(join(root, path))
  expect(diagnostics[0]!.message).toContain('session id is empty, over-long')
  // The offending id is never echoed back into a terminal.
  expect(diagnostics[0]!.message).not.toContain('\u202e')
})

test('legacy hydration stops recovering paths at the per-session ceiling', async () => {
  const root = makeLegacyRoot()
  put(root, join('storage', 'session', 'proj', 'ses_many.json'), {
    id: 'ses_many',
    projectID: 'proj',
    directory: '/root/proj',
    title: 'many files',
    time: { created: 1, updated: 2 },
  })
  put(root, join('storage', 'message', 'ses_many', 'msg_1.json'), {
    id: 'msg_1', sessionID: 'ses_many', role: 'assistant', time: { created: 1 },
  })
  put(root, join('storage', 'part', 'msg_1', 'prt_1.json'), {
    id: 'prt_1',
    sessionID: 'ses_many',
    messageID: 'msg_1',
    type: 'tool',
    state: {
      input: {
        edits: Array.from({ length: 1100 }, (_unused, index) => ({
          filePath: `/root/proj/file-${index}.ts`,
        })),
      },
    },
  })
  const manifest = tempManifest(root)

  const { refs } = await discoverLegacy(manifest, root)
  const doc = await hydrateLegacy(manifest, root, refs[0]!, DEFAULT_CONFIG)

  // The same ceiling the SQLite reader enforces, reported the same way.
  expect(doc.files).toHaveLength(1024)
  expect(doc.truncated).toBe(true)
})
