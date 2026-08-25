import { expect, test } from 'bun:test'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/config'
import { jsonlTranscript } from '../src/formats/jsonl-transcript'
import { collectPaths } from '../src/formats/paths'
import { validateManifest } from '../src/manifests/load'

const fixtures = join(import.meta.dir, 'fixtures')

const claude = validateManifest({
  schema: 1,
  id: 'claude',
  name: 'Claude Code',
  roots: [],
  format: 'jsonl-transcript',
  tier: 'resume',
  jsonl: { glob: 'projects/*/*.jsonl', variant: 'claude' },
  resume: { cmd: 'claude', args: ['--resume', '{id}'] },
})

const codex = validateManifest({
  schema: 1,
  id: 'codex',
  name: 'Codex',
  roots: [],
  format: 'jsonl-transcript',
  tier: 'resume',
  jsonl: { glob: 'sessions/**/rollout-*.jsonl', variant: 'codex' },
  resume: { cmd: 'codex', args: ['resume', '{id}'] },
})

const generic = validateManifest({
  schema: 1,
  id: 'generic',
  name: 'Generic',
  roots: [],
  format: 'jsonl-transcript',
  tier: 'search',
  jsonl: {
    glob: '*.jsonl',
    variant: 'generic',
    generic: {
      idFrom: 'session.id',
      tsPath: 'timestamp',
      rolePath: 'role',
      textPath: 'text',
    },
  },
})

async function inTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-jsonl-'))
  try {
    await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

function spoolDirectories(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith('nekyia-jsonl-spool-'))
    .sort()
}

test('collectPaths recursively finds path fields and ignores ordinary strings', () => {
  expect(collectPaths({
    nested: [
      { file_path: '/x/y.ts' },
      { deeper: { filePath: '/z.ts' } },
      { path: '/root/My Project/a.ts' },
      { file: 'relative dir/file.ts' },
      { file: 'My File.ts' },
    ],
    ordinary: '/c.ts',
    file: 'x',
    request: { path: 'GET /v1/users' },
    description: { file: 'not a filesystem target' },
  }).sort()).toEqual([
    '/root/My Project/a.ts',
    '/x/y.ts',
    '/z.ts',
    'My File.ts',
    'relative dir/file.ts',
  ])
})

test('discover rejects empty native IDs for every JSONL variant', async () => {
  await inTempDir(async (root) => {
    const claudeDir = join(root, 'projects', 'p')
    mkdirSync(claudeDir, { recursive: true })
    writeJsonl(join(claudeDir, '.jsonl'), [{
      timestamp: '2026-08-01T00:00:00.000Z',
      message: { role: 'user', content: 'hello' },
    }])
    writeJsonl(join(root, 'codex.jsonl'), [{
      timestamp: '2026-08-01T00:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: '', cwd: '/root/proj' },
    }])
    writeJsonl(join(root, 'generic.jsonl'), [{
      session: { id: '' },
      timestamp: '2026-08-01T00:00:00.000Z',
      role: 'user',
      text: 'hello',
    }])
    writeJsonl(join(root, '.jsonl'), [{
      timestamp: '2026-08-01T00:00:00.000Z',
      role: 'user',
      text: 'hello',
    }])

    const claudeManifest = validateManifest({
      ...claude,
      tier: 'search',
      resume: undefined,
      jsonl: { glob: 'projects/*/.jsonl', variant: 'claude' },
    })
    const claudeResult = await jsonlTranscript.discover(claudeManifest, root)
    const codexManifest = validateManifest({
      ...codex,
      tier: 'search',
      resume: undefined,
      jsonl: { glob: 'codex.jsonl', variant: 'codex' },
    })
    const codexResult = await jsonlTranscript.discover(codexManifest, root)
    const genericResult = await jsonlTranscript.discover(generic, root)
    const genericFilenameManifest = validateManifest({
      ...generic,
      jsonl: {
        glob: '.jsonl',
        variant: 'generic',
        generic: {
          idFrom: 'filename',
          tsPath: 'timestamp',
          rolePath: 'role',
          textPath: 'text',
        },
      },
    })
    const genericFilenameResult = await jsonlTranscript.discover(
      genericFilenameManifest,
      root,
    )

    expect(claudeResult.refs).toEqual([])
    expect(codexResult.refs).toEqual([])
    expect(genericResult.refs).toEqual([])
    expect(genericFilenameResult.refs).toEqual([])
  })
})

test('Claude discovery keeps the first valid timestamp even when it equals mtime', async () => {
  await inTempDir(async (root) => {
    const directory = join(root, 'projects', 'p')
    const path = join(directory, 'timestamp.jsonl')
    const first = new Date('2026-08-01T10:00:00.000Z')
    mkdirSync(directory, { recursive: true })
    writeJsonl(path, [
      { timestamp: first.toISOString(), message: { role: 'user', content: 'first' } },
      { timestamp: '2026-08-01T11:00:00.000Z', message: { role: 'assistant', content: 'later' } },
    ])
    utimesSync(path, first, first)

    const { refs } = await jsonlTranscript.discover(claude, root)

    expect(refs[0]?.startedAt).toBe(first.getTime())
  })
})

test('generic discovery keeps its first valid configured timestamp', async () => {
  await inTempDir(async (root) => {
    writeJsonl(join(root, 'session.jsonl'), [
      {
        session: { id: 'g1' },
        timestamp: '2026-08-01T10:00:00.000Z',
        role: 'user',
        text: 'first',
      },
      {
        session: { id: 'g1' },
        timestamp: '2026-08-01T11:00:00.000Z',
        role: 'assistant',
        text: 'later',
      },
    ])

    const { refs } = await jsonlTranscript.discover(generic, root)

    expect(refs[0]?.startedAt).toBe(Date.parse('2026-08-01T10:00:00.000Z'))
  })
})

test('generic hydration indexes and counts only configured user and assistant roles', async () => {
  await inTempDir(async (root) => {
    writeJsonl(join(root, 'roles.jsonl'), [
      { session: { id: 'roles' }, role: 'user', text: 'safe user' },
      { session: { id: 'roles' }, role: 'assistant', text: 'safe assistant' },
      { session: { id: 'roles' }, role: 'developer', text: 'DEVELOPER_SECRET' },
      { session: { id: 'roles' }, role: 'system', text: 'SYSTEM_SECRET' },
      { session: { id: 'roles' }, role: 'tool', text: 'TOOL_SECRET' },
      { session: { id: 'roles' }, role: 'unknown', text: 'UNKNOWN_SECRET' },
      { session: { id: 'roles' }, role: 'user', text: '   ' },
    ])
    const { refs } = await jsonlTranscript.discover(generic, root)
    const doc = await jsonlTranscript.hydrate(generic, root, refs[0]!, DEFAULT_CONFIG)

    expect(doc.prompts).toEqual(['safe user'])
    expect(doc.prose).toEqual(['safe assistant'])
    expect(doc.ref.turns).toBe(2)
  })
})

test('Claude discovery emits metadata when its valid first row exceeds the head budget', async () => {
  await inTempDir(async (root) => {
    const directory = join(root, 'projects', 'p')
    const path = join(directory, 'long-first-row.jsonl')
    mkdirSync(directory, { recursive: true })
    writeJsonl(path, [{
      timestamp: '2026-08-01T10:00:00.000Z',
      message: { role: 'user', content: 'x'.repeat(20 * 1024) },
    }])

    const { refs, diagnostics } = await jsonlTranscript.discover(claude, root)
    const stat = await Bun.file(path).stat()

    expect(diagnostics).toEqual([])
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      nativeId: 'long-first-row',
      cwd: null,
      gitBranch: null,
      title: null,
      startedAt: stat.mtime.getTime(),
      endedAt: stat.mtime.getTime(),
    })
  })
})

test('discovers Claude metadata from the bounded transcript head', async () => {
  const result = await jsonlTranscript.discover(claude, join(fixtures, 'claude'))

  expect(result.diagnostics).toEqual([])
  expect(result.refs).toHaveLength(1)
  expect(result.refs[0]).toMatchObject({
    uid: 'claude:11111111-2222-3333-4444-555555555555',
    nativeId: '11111111-2222-3333-4444-555555555555',
    cwd: '/root/proj',
    gitBranch: 'main',
    title: 'fix the sse reconnect race',
    startedAt: Date.parse('2026-08-01T10:00:00.000Z'),
    tier: 'resume',
    origin: 'manifest',
  })
  expect(result.refs[0]!.fingerprint).toMatch(/^\d+:\d+$/)
})

test('hydrates Claude prompts and assistant prose', async () => {
  const { refs } = await jsonlTranscript.discover(claude, join(fixtures, 'claude'))
  const doc = await jsonlTranscript.hydrate(
    claude,
    join(fixtures, 'claude'),
    refs[0]!,
    DEFAULT_CONFIG,
  )

  expect(doc.prompts).toEqual(['fix the sse reconnect race'])
  expect(doc.prose).toContain('I will look at the transport layer.')
  expect(doc.prose).toContain('Fixed by guarding the subscribe call.')
  expect(doc.ref.turns).toBe(4)
})

test('Claude hydration does not count empty or tool-only messages as turns', async () => {
  await inTempDir(async (root) => {
    const directory = join(root, 'projects', 'p')
    mkdirSync(directory, { recursive: true })
    writeJsonl(join(directory, 'turns.jsonl'), [
      { message: { role: 'assistant', content: [] } },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', input: { file_path: '/root/proj/a.ts' } }],
        },
      },
      { message: { role: 'user', content: 'safe prompt' } },
    ])
    const { refs } = await jsonlTranscript.discover(claude, root)
    const doc = await jsonlTranscript.hydrate(claude, root, refs[0]!, DEFAULT_CONFIG)

    expect(doc.ref.turns).toBe(1)
    expect(doc.files).toContain('/root/proj/a.ts')
  })
})

test('keeps Claude sidechain prose in the same document', async () => {
  const { refs } = await jsonlTranscript.discover(claude, join(fixtures, 'claude'))
  const doc = await jsonlTranscript.hydrate(claude, '', refs[0]!, DEFAULT_CONFIG)

  expect(doc.prose).toContain('subagent found a double subscribe')
  expect(doc.ref.uid).toBe(refs[0]!.uid)
})

test('never indexes Claude tool output', async () => {
  const { refs } = await jsonlTranscript.discover(claude, join(fixtures, 'claude'))
  const doc = await jsonlTranscript.hydrate(claude, '', refs[0]!, DEFAULT_CONFIG)

  expect([...doc.prompts, ...doc.prose].join('\n'))
    .not.toContain('SECRET_TOOL_OUTPUT_MUST_NOT_BE_INDEXED')
})

test('extracts file facets from Claude tool input', async () => {
  const { refs } = await jsonlTranscript.discover(claude, join(fixtures, 'claude'))
  const doc = await jsonlTranscript.hydrate(claude, '', refs[0]!, DEFAULT_CONFIG)

  expect(doc.files).toContain('/root/proj/src/sse.ts')
})

test('over-cap Claude transcripts keep prompts and facets but drop prose', async () => {
  const { refs } = await jsonlTranscript.discover(claude, join(fixtures, 'claude'))
  const doc = await jsonlTranscript.hydrate(claude, '', refs[0]!, {
    ...DEFAULT_CONFIG,
    maxFileBytes: 10,
  })

  expect(doc.truncated).toBe(true)
  expect(doc.prompts).toEqual(['fix the sse reconnect race'])
  expect(doc.prose).toEqual([])
  expect(doc.files).toContain('/root/proj/src/sse.ts')
})

test('discovers Codex metadata and title', async () => {
  const { refs, diagnostics } = await jsonlTranscript.discover(
    codex,
    join(fixtures, 'codex'),
  )

  expect(diagnostics).toEqual([])
  expect(refs).toHaveLength(1)
  expect(refs[0]).toMatchObject({
    uid: 'codex:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    nativeId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    cwd: '/root/other',
    title: 'rewrite the transport layer',
    startedAt: Date.parse('2026-08-02T09:00:00.000Z'),
  })
})

test('hydrates only Codex user input_text and assistant output_text', async () => {
  const { refs } = await jsonlTranscript.discover(codex, join(fixtures, 'codex'))
  const doc = await jsonlTranscript.hydrate(codex, '', refs[0]!, DEFAULT_CONFIG)

  expect(doc.prompts).toEqual(['rewrite the transport layer'])
  expect(doc.prose).toEqual(['Rewriting transport now.'])
  expect(doc.ref.turns).toBe(2)
})

test('Codex ignores injected user envelopes and locks the first valid session metadata', async () => {
  await inTempDir(async (root) => {
    const path = join(root, 'codex.jsonl')
    writeJsonl(path, [
      {
        timestamp: '2026-08-02T09:00:00.000Z',
        type: 'session_meta',
        payload: { session_id: 'first-id', cwd: '/root/first' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<recommended_plugins>hidden</recommended_plugins>' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>hidden</environment_context>' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'actual user request' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'actual answer' }],
        },
      },
      {
        timestamp: '2026-08-03T09:00:00.000Z',
        type: 'session_meta',
        payload: { session_id: 'later-id', cwd: '/root/later' },
      },
    ])
    const manifest = validateManifest({
      ...codex,
      tier: 'search',
      resume: undefined,
      jsonl: { glob: 'codex.jsonl', variant: 'codex' },
    })
    const { refs } = await jsonlTranscript.discover(manifest, root)
    const doc = await jsonlTranscript.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)

    expect(refs[0]).toMatchObject({
      nativeId: 'first-id',
      cwd: '/root/first',
      title: 'actual user request',
      startedAt: Date.parse('2026-08-02T09:00:00.000Z'),
    })
    expect(doc.prompts).toEqual(['actual user request'])
    expect(doc.prose).toEqual(['actual answer'])
    expect(doc.ref.turns).toBe(2)
  })
})

test('Codex filters injected input blocks without dropping adjacent actual prompts', async () => {
  await inTempDir(async (root) => {
    const path = join(root, 'codex.jsonl')
    writeJsonl(path, [
      {
        timestamp: '2026-08-02T09:00:00.000Z',
        type: 'session_meta',
        payload: { session_id: 'mixed-blocks', cwd: '/root/proj' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<environment_context>hidden first</environment_context>' },
            { type: 'input_text', text: 'first actual prompt' },
          ],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'second actual prompt' },
            { type: 'input_text', text: '<recommended_plugins>hidden last</recommended_plugins>' },
          ],
        },
      },
    ])
    const manifest = validateManifest({
      ...codex,
      tier: 'search',
      resume: undefined,
      jsonl: { glob: 'codex.jsonl', variant: 'codex' },
    })
    const { refs } = await jsonlTranscript.discover(manifest, root)
    const doc = await jsonlTranscript.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)

    expect(refs[0]?.title).toBe('first actual prompt')
    expect(doc.prompts).toEqual(['first actual prompt', 'second actual prompt'])
    expect(doc.ref.turns).toBe(2)
  })
})

test('Codex hydration excludes developer and tool output while extracting tool paths', async () => {
  await inTempDir(async (root) => {
    const path = join(root, 'codex.jsonl')
    writeJsonl(path, [
      {
        timestamp: '2026-08-02T09:00:00.000Z',
        type: 'session_meta',
        payload: { session_id: 'codex-private', cwd: '/root/proj' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'DEVELOPER_SECRET' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          arguments: JSON.stringify({ file_path: '/root/proj/src/tool.ts' }),
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', output: 'TOOL_OUTPUT_SECRET' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'safe prompt' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'safe prose' }],
        },
      },
    ])
    const manifest = validateManifest({
      ...codex,
      tier: 'search',
      resume: undefined,
      jsonl: { glob: 'codex.jsonl', variant: 'codex' },
    })
    const { refs } = await jsonlTranscript.discover(manifest, root)
    const doc = await jsonlTranscript.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)
    const indexed = [...doc.prompts, ...doc.prose].join('\n')

    expect(doc.prompts).toEqual(['safe prompt'])
    expect(doc.prose).toEqual(['safe prose'])
    expect(doc.files).toContain('/root/proj/src/tool.ts')
    expect(indexed).not.toContain('DEVELOPER_SECRET')
    expect(indexed).not.toContain('TOOL_OUTPUT_SECRET')
  })
})

test('streaming hydration discards oversized rows and continues with later safe rows', async () => {
  await inTempDir(async (root) => {
    const path = join(root, 'codex.jsonl')
    writeFileSync(path, `${JSON.stringify({
      timestamp: '2026-08-02T09:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: 'oversized', cwd: '/root/proj' },
    })}\n{"type":"response_item","payload":{"type":"function_call_output","output":"OVERSIZED_SECRET`)
    appendFileSync(path, 'x'.repeat(4 * 1024 * 1024))
    appendFileSync(path, `"}}\n${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'safe after oversized row' }],
      },
    })}\n`)
    const manifest = validateManifest({
      ...codex,
      tier: 'search',
      resume: undefined,
      jsonl: { glob: 'codex.jsonl', variant: 'codex' },
    })
    const { refs } = await jsonlTranscript.discover(manifest, root)
    const doc = await jsonlTranscript.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)

    expect(doc.prompts).toEqual(['safe after oversized row'])
    expect([...doc.prompts, ...doc.prose].join('\n')).not.toContain('OVERSIZED_SECRET')
    expect(doc.truncated).toBe(true)
  })
})

test('streaming hydration preserves oversized user prompts', async () => {
  await inTempDir(async (root) => {
    const path = join(root, 'codex.jsonl')
    writeFileSync(path, `${JSON.stringify({
      timestamp: '2026-08-02T09:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: 'oversized-user', cwd: '/root/proj' },
    })}\n{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"LARGE_USER_PROMPT`)
    appendFileSync(path, 'x'.repeat(4 * 1024 * 1024))
    appendFileSync(path, '"}]}}\n')
    const manifest = validateManifest({
      ...codex,
      tier: 'search',
      resume: undefined,
      jsonl: { glob: 'codex.jsonl', variant: 'codex' },
    })
    const { refs } = await jsonlTranscript.discover(manifest, root)
    const doc = await jsonlTranscript.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)

    expect(doc.prompts).toHaveLength(1)
    expect(doc.prompts[0]?.startsWith('LARGE_USER_PROMPT')).toBe(true)
    expect(doc.prompts[0]!.length).toBeGreaterThan(4 * 1024 * 1024)
    expect(doc.truncated).toBe(false)
  })
})

test('streaming hydration preserves oversized tool-input rows and extracts files', async () => {
  await inTempDir(async (root) => {
    const path = join(root, 'codex.jsonl')
    writeFileSync(path, `${JSON.stringify({
      timestamp: '2026-08-02T09:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: 'oversized-tool-input', cwd: '/root/proj' },
    })}\n{"type":"response_item","payload":{"type":"function_call","arguments":"{\\"file_path\\":\\"/root/proj/src/huge-tool.ts\\",\\"padding\\":\\"`)
    appendFileSync(path, 'x'.repeat(4 * 1024 * 1024))
    appendFileSync(path, '\\"}"}}\n')
    const manifest = validateManifest({
      ...codex,
      tier: 'search',
      resume: undefined,
      jsonl: { glob: 'codex.jsonl', variant: 'codex' },
    })
    const { refs } = await jsonlTranscript.discover(manifest, root)
    const doc = await jsonlTranscript.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)

    expect(doc.files).toContain('/root/proj/src/huge-tool.ts')
    expect(doc.truncated).toBe(false)
  })
})

test('streaming hydration preserves oversized Claude assistant tool-use file facets', async () => {
  await inTempDir(async (root) => {
    const directory = join(root, 'projects', 'p')
    const path = join(directory, 'oversized-tool-use.jsonl')
    mkdirSync(directory, { recursive: true })
    writeFileSync(path, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"')
    appendFileSync(path, 'x'.repeat(4 * 1024 * 1024))
    appendFileSync(path, '"},{"type":"tool_use","input":{"file_path":"/root/proj/src/late-tool.ts"}}]}}\n')
    const { refs } = await jsonlTranscript.discover(claude, root)
    const doc = await jsonlTranscript.hydrate(claude, root, refs[0]!, DEFAULT_CONFIG)

    expect(doc.files).toContain('/root/proj/src/late-tool.ts')
    expect(doc.truncated).toBe(false)
  })
})

test('streaming hydration discards reordered oversized Codex tool output', async () => {
  await inTempDir(async (root) => {
    const spoolsBefore = spoolDirectories()
    const path = join(root, 'codex.jsonl')
    writeFileSync(path, `${JSON.stringify({
      timestamp: '2026-08-02T09:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: 'reordered-output', cwd: '/root/proj' },
    })}\n{"type":"response_item","payload":{"output":"REORDERED_OUTPUT_SECRET`)
    appendFileSync(path, 'x'.repeat(4 * 1024 * 1024))
    appendFileSync(path, '","type":"function_call\\u005foutput"}}\n')
    const manifest = validateManifest({
      ...codex,
      tier: 'search',
      resume: undefined,
      jsonl: { glob: 'codex.jsonl', variant: 'codex' },
    })
    const { refs } = await jsonlTranscript.discover(manifest, root)
    const doc = await jsonlTranscript.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)

    expect([...doc.prompts, ...doc.prose].join('\n'))
      .not.toContain('REORDERED_OUTPUT_SECRET')
    expect(doc.truncated).toBe(true)
    expect(spoolDirectories()).toEqual(spoolsBefore)
  })
})

test('streaming hydration bounds oversized generic ignored roles with configured paths', async () => {
  await inTempDir(async (root) => {
    const path = join(root, 'generic.jsonl')
    writeJsonl(path, [{
      session: { id: 'generic-private' },
      data: { body: 'safe prompt' },
      meta: { kind: 'user' },
    }])
    for (const role of ['system', 'tool']) {
      appendFileSync(path, `{"session":{"id":"generic-private"},"data":{"body":"${role.toUpperCase()}_SECRET`)
      appendFileSync(path, 'x'.repeat(4 * 1024 * 1024))
      appendFileSync(path, `"},"meta":{"kind":"${role}"}}\n`)
    }
    appendFileSync(path, '{"session":{"id":"generic-private"},"data":{"body":"ESCAPED_USER_PROMPT')
    appendFileSync(path, 'x'.repeat(4 * 1024 * 1024))
    appendFileSync(path, '"},"meta":{"kind":"us\\u0065r"}}\n')
    const manifest = validateManifest({
      ...generic,
      jsonl: {
        glob: 'generic.jsonl',
        variant: 'generic',
        generic: {
          idFrom: 'session.id',
          rolePath: 'meta.kind',
          textPath: 'data.body',
        },
      },
    })
    const { refs } = await jsonlTranscript.discover(manifest, root)
    const doc = await jsonlTranscript.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)

    expect(doc.prompts).toHaveLength(2)
    expect(doc.prompts[0]).toBe('safe prompt')
    expect(doc.prompts[1]?.startsWith('ESCAPED_USER_PROMPT')).toBe(true)
    expect(doc.prose).toEqual([])
    expect(doc.truncated).toBe(true)
  })
})

test('malformed JSONL is diagnosed safely and never throws', async () => {
  const result = await jsonlTranscript.discover(
    claude,
    join(fixtures, 'claude-broken'),
  )

  expect(result.refs).toEqual([])
  expect(result.diagnostics.length).toBeGreaterThan(0)
  expect(result.diagnostics.every((diagnostic) => (
    diagnostic.level === 'warn' && typeof diagnostic.message === 'string'
  ))).toBe(true)
})

test('harness wrappers never become the title or a prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-jsonl-wrap-'))
  try {
    // Exactly how Claude Code records a slash command: the caveat, the command
    // block and the command's own output each arrive as separate user messages.
    mkdirSync(join(root, 'projects', '-root-proj'), { recursive: true })
    writeJsonl(join(root, 'projects', '-root-proj', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'), [
      {
        type: 'user', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/root/proj', gitBranch: 'main',
        message: {
          role: 'user',
          content: '<local-command-caveat>Caveat: The messages below were generated by the'
            + ' user while running local commands.</local-command-caveat>',
        },
      },
      {
        type: 'user', timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'user',
          content: '<command-name>/blog-ideas</command-name>\n'
            + '            <command-message>blog-ideas</command-message>\n'
            + '            <command-args>fresh news, as a tutorial</command-args>',
        },
      },
      {
        type: 'user', timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'user', content: '<local-command-stdout>Bye!</local-command-stdout>' },
      },
      {
        type: 'user', timestamp: '2026-01-01T00:00:03.000Z',
        message: { role: 'user', content: 'now write the outline' },
      },
    ])

    const { refs } = await jsonlTranscript.discover(claude, root)
    expect(refs[0]!.title).toBe('/blog-ideas fresh news, as a tutorial')

    const doc = await jsonlTranscript.hydrate(claude, root, refs[0]!, DEFAULT_CONFIG)
    expect(doc.prompts).toEqual(['/blog-ideas fresh news, as a tutorial', 'now write the outline'])
    for (const prompt of doc.prompts) expect(prompt).not.toContain('<')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a title keeps enough text for the widest terminal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-jsonl-title-'))
  try {
    mkdirSync(join(root, 'projects', '-root-proj'), { recursive: true })
    const long = `start ${'word '.repeat(120)}end`
    writeJsonl(join(root, 'projects', '-root-proj', 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff.jsonl'), [
      {
        type: 'user', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/root/proj', gitBranch: 'main',
        message: { role: 'user', content: long },
      },
    ])
    const { refs } = await jsonlTranscript.discover(claude, root)
    const title = refs[0]!.title!
    // Wide terminals run past 200 columns, so a title cut there loses text that
    // the screen had room for.
    expect(title.length).toBeGreaterThan(200)
    expect(title.startsWith('start word')).toBe(true)
    // Still bounded, so one runaway line cannot bloat the index.
    expect(title.length).toBeLessThanOrEqual(512)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a codex session id that could never round-trip through a uid is refused', async () => {
  await inTempDir(async (root) => {
    const path = join(root, 'codex.jsonl')
    writeJsonl(path, [{
      timestamp: '2026-08-01T00:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: 'ses\u0007bad', cwd: '/root/proj' },
    }])
    const manifest = validateManifest({
      ...codex,
      tier: 'search',
      resume: undefined,
      jsonl: { glob: 'codex.jsonl', variant: 'codex' },
    })

    const { refs, diagnostics } = await jsonlTranscript.discover(manifest, root)

    // Indexing it would produce a uid `forget` refuses, leaving `prune
    // --client` as the only way to remove the session again.
    expect(refs).toEqual([])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.level).toBe('warn')
    expect(diagnostics[0]!.path).toBe(path)
    expect(diagnostics[0]!.message).toContain('session skipped')
    expect(diagnostics[0]!.message).not.toContain('\u0007')
  })
})

test('a claude transcript whose filename cannot make a uid is refused', async () => {
  await inTempDir(async (root) => {
    const directory = join(root, 'projects', 'proj')
    mkdirSync(directory, { recursive: true })
    // A filename is content Nekyia did not choose, and Linux allows anything
    // but a slash and a NUL in one. The id comes straight from it here.
    const path = join(directory, 'ses\u0007bad.jsonl')
    writeJsonl(path, [{
      timestamp: '2026-08-01T00:00:00.000Z',
      cwd: '/root/proj',
      message: { role: 'user', content: 'hello' },
    }])

    const { refs, diagnostics } = await jsonlTranscript.discover(claude, root)

    expect(refs).toEqual([])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.level).toBe('warn')
    expect(diagnostics[0]!.path).toBe(path)
    expect(diagnostics[0]!.message).toContain('session skipped')
    expect(diagnostics[0]!.message).not.toContain('\u0007')
  })
})

test('a generic session id with bidi characters is refused, and doctor is told', async () => {
  await inTempDir(async (root) => {
    const path = join(root, 'session.jsonl')
    writeJsonl(path, [{
      session: { id: 'g\u202e1' },
      timestamp: '2026-08-01T00:00:00.000Z',
      role: 'user',
      text: 'hello',
    }])

    const { refs, diagnostics } = await jsonlTranscript.discover(generic, root)

    expect(refs).toEqual([])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.level).toBe('warn')
    expect(diagnostics[0]!.path).toBe(path)
    expect(diagnostics[0]!.message).toContain('session skipped')
  })
})

test('a generic manifest can declare that its timestamps are seconds', async () => {
  await inTempDir(async (root) => {
    writeJsonl(join(root, 'seconds.jsonl'), [{
      session: { id: 'g1' }, ts: 1_787_640_881, role: 'user', text: 'hello',
    }])
    const spec = {
      idFrom: 'session.id', tsPath: 'ts', rolePath: 'role', textPath: 'text',
    }
    const declared = validateManifest({
      ...generic,
      jsonl: { glob: 'seconds.jsonl', variant: 'generic', generic: { ...spec, tsUnit: 's' } },
    })
    const undeclared = validateManifest({
      ...generic,
      jsonl: { glob: 'seconds.jsonl', variant: 'generic', generic: spec },
    })

    const withUnit = await jsonlTranscript.discover(declared, root)
    const withoutUnit = await jsonlTranscript.discover(undeclared, root)

    expect(withUnit.refs[0]!.startedAt).toBe(1_787_640_881_000)
    // A manifest that declares nothing keeps the behaviour it has today.
    // Guessing seconds from magnitude would silently move every session a
    // correct manifest already places properly.
    expect(withoutUnit.refs[0]!.startedAt).toBe(1_787_640_881)
  })
})

test('a declared timestamp unit refuses a value written in another shape', async () => {
  await inTempDir(async (root) => {
    writeJsonl(join(root, 'iso.jsonl'), [{
      session: { id: 'g1' }, ts: '2026-08-01T00:00:00.000Z', role: 'user', text: 'hello',
    }])
    const manifest = validateManifest({
      ...generic,
      jsonl: {
        glob: 'iso.jsonl',
        variant: 'generic',
        generic: {
          idFrom: 'session.id', tsPath: 'ts', tsUnit: 'ms', rolePath: 'role', textPath: 'text',
        },
      },
    })

    const { refs } = await jsonlTranscript.discover(manifest, root)

    // A manifest claiming milliseconds described a numeric field. Reading the
    // string anyway would mean the declaration bought nothing, so the reader
    // falls back to the file's own mtime instead.
    expect(refs[0]!.startedAt).toBe(refs[0]!.endedAt)
  })
})

test('paths recovered from Claude tool calls stop at the per-session ceiling', async () => {
  await inTempDir(async (root) => {
    const directory = join(root, 'projects', 'p')
    mkdirSync(directory, { recursive: true })
    writeJsonl(join(directory, 'many-files.jsonl'), [{
      timestamp: '2026-08-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          input: {
            edits: Array.from({ length: 1100 }, (_unused, index) => ({
              filePath: `/root/proj/file-${index}.ts`,
            })),
          },
        }],
      },
    }])

    const { refs } = await jsonlTranscript.discover(claude, root)
    const doc = await jsonlTranscript.hydrate(claude, root, refs[0]!, DEFAULT_CONFIG)

    // One runaway session must not bloat the index, and a partial file list
    // must never be handed back as a complete one.
    expect(doc.files).toHaveLength(1024)
    expect(doc.truncated).toBe(true)
  })
})

const codexAnyGlob = validateManifest({
  ...codex,
  jsonl: { glob: '*.jsonl', variant: 'codex' },
})

function rolloutName(id: string): string {
  return `rollout-2026-08-02T09-00-00-${id}.jsonl`
}

/** A Codex `session_meta` row, with whatever worker markers a case needs bolted on. */
function codexMeta(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    timestamp: '2026-08-02T09:00:00.000Z',
    type: 'session_meta',
    payload: { session_id: id, id, cwd: '/root/proj', ...extra },
  }
}

function codexUserMessage(text: string): unknown {
  return {
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  }
}

/**
 * The rollout kinds Codex writes side by side, and which of them is a session a
 * person could actually return to.
 *
 * A wrong exclusion here hides work someone really did, so every marker that
 * drops a rollout is pinned next to a case it resembles and that is kept.
 */
const WORKER_MATRIX: {
  name: string
  id: string
  markers: Record<string, unknown>
  kept: boolean
}[] = [
  {
    name: 'an interactive CLI session',
    id: '11111111-1111-4111-8111-111111111111',
    markers: { source: 'cli', thread_source: 'user', originator: 'codex-tui' },
    kept: true,
  },
  {
    // A person running `codex exec` themselves: the same source string the SDK
    // worker carries, so the source alone must never be enough to hide it.
    name: 'a user-invoked codex exec run',
    id: '22222222-2222-4222-8222-222222222222',
    markers: { source: 'exec', thread_source: 'user', originator: 'codex_cli_rs' },
    kept: true,
  },
  {
    name: 'an SDK worker',
    id: '33333333-3333-4333-8333-333333333333',
    markers: { source: 'exec', originator: 'codex_sdk_ts' },
    kept: false,
  },
  {
    name: 'a subagent rollout',
    id: '44444444-4444-4444-8444-444444444444',
    markers: {
      source: { subagent: { thread_spawn: { depth: 1, agent_nickname: 'Cicero' } } },
      thread_source: 'subagent',
    },
    kept: false,
  },
  {
    // Older Codex releases wrote no source at all. An unlabelled rollout counts
    // as a session until it says otherwise.
    name: 'a session with no source field',
    id: '55555555-5555-4555-8555-555555555555',
    markers: {},
    kept: true,
  },
]

test('Codex indexes real sessions and leaves worker rollouts out of the picker', async () => {
  await inTempDir(async (root) => {
    for (const entry of WORKER_MATRIX) {
      writeJsonl(join(root, rolloutName(entry.id)), [
        codexMeta(entry.id, entry.markers),
        codexUserMessage(`work for ${entry.name}`),
      ])
    }

    const { refs, diagnostics } = await jsonlTranscript.discover(codexAnyGlob, root)

    expect(diagnostics).toEqual([])
    expect(refs.map((ref) => ref.nativeId).sort()).toEqual(
      WORKER_MATRIX.filter((entry) => entry.kept).map((entry) => entry.id).sort(),
    )
    for (const entry of WORKER_MATRIX.filter((one) => one.kept)) {
      expect(refs.find((ref) => ref.nativeId === entry.id)?.title)
        .toBe(`work for ${entry.name}`)
    }
  })
})

test('a Codex session_meta row past the old head read is still discovered', async () => {
  await inTempDir(async (root) => {
    const id = '66666666-6666-4666-8666-666666666666'
    // Current Codex writes the whole system prompt into session_meta, which puts
    // that row past 16 KiB on every real rollout measured.
    writeJsonl(join(root, rolloutName(id)), [
      codexMeta(id, { base_instructions: { text: 'You are Codex. '.repeat(2000) } }),
      codexUserMessage('rewrite the transport layer'),
    ])

    const { refs, diagnostics } = await jsonlTranscript.discover(codexAnyGlob, root)

    expect(diagnostics).toEqual([])
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      nativeId: id,
      cwd: '/root/proj',
      title: 'rewrite the transport layer',
      startedAt: Date.parse('2026-08-02T09:00:00.000Z'),
    })
  })
})

test('a Codex rollout whose metadata outruns even the wider head falls back to its filename', async () => {
  await inTempDir(async (root) => {
    const id = '77777777-7777-4777-8777-777777777777'
    writeJsonl(join(root, rolloutName(id)), [
      codexMeta(id, { base_instructions: { text: 'You are Codex. '.repeat(10000) } }),
      codexUserMessage('this row is never reached'),
    ])

    const { refs } = await jsonlTranscript.discover(codexAnyGlob, root)

    // The metadata was unreadable, but the file names the thread it records, so
    // the session is still resumable rather than silently missing.
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ nativeId: id, cwd: null, title: null })
  })
})

test('Codex reads the newer id field when a rollout carries no session_id', async () => {
  await inTempDir(async (root) => {
    const path = join(root, 'codex.jsonl')
    writeJsonl(path, [{
      timestamp: '2026-08-02T09:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'thread-only-id', cwd: '/root/proj' },
    }])
    const manifest = validateManifest({
      ...codex,
      tier: 'search',
      resume: undefined,
      jsonl: { glob: 'codex.jsonl', variant: 'codex' },
    })

    const { refs, diagnostics } = await jsonlTranscript.discover(manifest, root)

    expect(diagnostics).toEqual([])
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ nativeId: 'thread-only-id', cwd: '/root/proj' })
  })
})

test('a codex id field that could never round-trip through a uid is refused', async () => {
  await inTempDir(async (root) => {
    const path = join(root, 'codex.jsonl')
    writeJsonl(path, [{
      timestamp: '2026-08-01T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'ses\u0007bad', cwd: '/root/proj' },
    }])
    const manifest = validateManifest({
      ...codex,
      tier: 'search',
      resume: undefined,
      jsonl: { glob: 'codex.jsonl', variant: 'codex' },
    })

    const { refs, diagnostics } = await jsonlTranscript.discover(manifest, root)

    // The fallback field is transcript content like any other, so it is held to
    // the bound session_id is held to.
    expect(refs).toEqual([])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.level).toBe('warn')
    expect(diagnostics[0]!.path).toBe(path)
    expect(diagnostics[0]!.message).toContain('session skipped')
    expect(diagnostics[0]!.message).not.toContain('\u0007')
  })
})

test('a Codex rollout written without the response_item envelope is still read', async () => {
  await inTempDir(async (root) => {
    const id = '88888888-8888-4888-8888-888888888888'
    writeJsonl(join(root, rolloutName(id)), [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'port the old rollout' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Ported it.' }],
      },
      { type: 'function_call', arguments: JSON.stringify({ filePath: '/root/proj/src/old.ts' }) },
    ])

    const { refs } = await jsonlTranscript.discover(codexAnyGlob, root)
    const doc = await jsonlTranscript.hydrate(codexAnyGlob, root, refs[0]!, DEFAULT_CONFIG)

    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({ nativeId: id, title: 'port the old rollout' })
    expect(doc.prompts).toEqual(['port the old rollout'])
    expect(doc.prose).toEqual(['Ported it.'])
    expect(doc.files).toEqual(['/root/proj/src/old.ts'])
  })
})

test('an empty or unnamed Codex rollout is not turned into a session', async () => {
  await inTempDir(async (root) => {
    writeFileSync(join(root, rolloutName('99999999-9999-4999-8999-999999999999')), '')
    // A file under the glob that names no thread cannot become one.
    writeJsonl(join(root, 'rollout-notes.jsonl'), [
      { type: 'event_msg', payload: { type: 'task_started' } },
    ])

    const { refs, diagnostics } = await jsonlTranscript.discover(codexAnyGlob, root)

    expect(refs).toEqual([])
    expect(diagnostics).toEqual([])
  })
})
