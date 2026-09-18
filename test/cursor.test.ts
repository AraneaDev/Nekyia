import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/config'
import { cursorReader, transcriptFolder, unwrapUserText } from '../src/formats/cursor'
import { validateManifest } from '../src/manifests/load'
import cursorManifest from '../src/manifests/builtin/cursor.json'
import { buildAdapter } from '../src/core/adapter'
import { MAX_SESSION_FILES } from '../src/types'

const FIX = join(import.meta.dir, 'fixtures', 'cursor')
const manifest = validateManifest({
  schema: 1, id: 'cursor', name: 'Cursor', roots: [FIX],
  format: 'json-dir', tier: 'resume', jsonDir: { glob: 'chats/*/*', variant: 'cursor' },
  resume: { cmd: 'cursor-agent', args: ['--resume', '{id}'], cwd: '{cwd}' },
  brief: { cmd: 'cursor-agent', args: ['{prompt}'], cwd: '{cwd}' },
})
const FULL = 'c0ffee00-0000-4000-8000-000000000001'
const NO_TRANSCRIPT = 'c0ffee00-0000-4000-8000-000000000004'

test('the transcript folder is the cwd with its leading slash dropped and slashes as dashes', () => {
  expect(transcriptFolder('/root/glyphfall')).toBe('root-glyphfall')
  expect(transcriptFolder('/root')).toBe('root')
})

test('discovery reads cwd, title and millisecond times from meta.json', async () => {
  const { refs, diagnostics } = await cursorReader.discover(manifest, FIX)
  const full = refs.find((ref) => ref.nativeId === FULL)!
  expect(full.uid).toBe(`cursor:${FULL}`)
  expect(full.cwd).toBe('/root/proj')
  expect(full.title).toBe('Codebase Scan')
  expect(full.startedAt).toBe(1789721537974)
  expect(full.endedAt).toBe(1789722691124)
  expect(full.tier).toBe('resume')
  expect(diagnostics.filter((item) => item.level !== 'ok')).toEqual([])
})

test('an empty meta.json and a chat without a conversation are skipped silently', async () => {
  const { refs, diagnostics } = await cursorReader.discover(manifest, FIX)
  expect(refs.map((ref) => ref.nativeId).sort()).toEqual([FULL, NO_TRANSCRIPT])
  expect(diagnostics).toEqual([])
})

test('a change to the transcript changes the fingerprint source list', async () => {
  const { refs } = await cursorReader.discover(manifest, FIX)
  const full = refs.find((ref) => ref.nativeId === FULL)!
  expect(full.sourcePaths.some((path) => path.endsWith(`${FULL}.jsonl`))).toBe(true)
})

test('user text is unwrapped from Cursor\'s envelope', () => {
  expect(unwrapUserText('<timestamp>Friday</timestamp>\n<user_query>\nscan the repo\n</user_query>'))
    .toBe('scan the repo')
  expect(unwrapUserText('plain text')).toBe('plain text')
})

test('hydration reads both sides of the conversation and never tool output', async () => {
  const { refs } = await cursorReader.discover(manifest, FIX)
  const ref = refs.find((candidate) => candidate.nativeId === FULL)!
  const doc = await cursorReader.hydrate(manifest, FIX, ref, DEFAULT_CONFIG)
  expect(doc.prompts).toEqual(['scan the repo for issues', 'yes'])
  expect(doc.prose).toEqual(['Scanning the whole repo for issues.', 'Found two problems in app.ts.'])
  expect(doc.dialogue?.map((turn) => turn.role)).toEqual(['user', 'assistant', 'assistant', 'user'])
  expect(doc.files).toEqual(['/root/proj/src/app.ts'])
  expect(JSON.stringify(doc)).not.toContain('SECRET_TOOL_OUTPUT')
})

test('without a transcript at the derived path, prompts come from prompt_history.json', async () => {
  const { refs } = await cursorReader.discover(manifest, FIX)
  const ref = refs.find((candidate) => candidate.nativeId === NO_TRANSCRIPT)!
  const doc = await cursorReader.hydrate(manifest, FIX, ref, DEFAULT_CONFIG)
  expect(doc.prompts).toEqual(['explain the build'])
  expect(doc.prose).toEqual([])
})

test('a store that vanishes between discovery and hydration comes back degraded, not thrown', async () => {
  const { refs } = await cursorReader.discover(manifest, FIX)
  const ref = refs.find((candidate) => candidate.nativeId === FULL)!
  const doc = await cursorReader.hydrate(manifest, join(FIX, 'no-such-root'), ref, DEFAULT_CONFIG)
  expect(doc.degraded).toBe(true)
  expect(doc.prompts).toEqual([])
  expect(doc.prose).toEqual([])
  expect(doc.files).toEqual([])
  expect(doc.truncated).toBe(false)
})

test('a transcript that yields no text falls back to prompt_history.json', async () => {
  // The file exists at the derived path but holds nothing indexable (here,
  // only a tool call). The session must stay findable by what was typed.
  const root = mkdtempSync(join(tmpdir(), 'nekyia-cursor-'))
  const nativeId = 'c0ffee00-0000-4000-8000-0000000000fe'
  const cwd = '/root/proj'
  const transcriptDir = join(root, 'projects', transcriptFolder(cwd), 'agent-transcripts', nativeId)
  mkdirSync(transcriptDir, { recursive: true })
  writeFileSync(
    join(transcriptDir, `${nativeId}.jsonl`),
    `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', input: { path: '/root/proj/a.ts' } }] } })}\n`,
  )
  const chatDir = join(root, 'chats', 'ef8738aabf9379365c557ced89c9e405', nativeId)
  mkdirSync(chatDir, { recursive: true })
  writeFileSync(join(chatDir, 'meta.json'), '{}')
  writeFileSync(join(chatDir, 'prompt_history.json'), JSON.stringify(['explain the build']))

  const ref = {
    uid: `cursor:${nativeId}`, client: 'cursor', nativeId, cwd, gitBranch: null,
    title: null, startedAt: 0, endedAt: 0, turns: null, parentNativeId: null,
    tier: 'resume' as const, origin: 'manifest' as const,
    sourcePaths: [join(chatDir, 'meta.json')], fingerprint: '',
  }
  const doc = await cursorReader.hydrate(manifest, root, ref, DEFAULT_CONFIG)
  expect(doc.prompts).toEqual(['explain the build'])
  expect(doc.files).toEqual(['/root/proj/a.ts'])
})

test('a duplicate path arriving after the file cap does not itself mark the session truncated', async () => {
  // Filling the cap exactly, then reoffering one of those same paths, must not
  // flip `truncated`: that path was never going to grow the set further, so
  // nothing was actually dropped on its account. A genuinely new path arriving
  // after the cap is the one that should.
  const root = mkdtempSync(join(tmpdir(), 'nekyia-cursor-'))
  const nativeId = 'c0ffee00-0000-4000-8000-0000000000ff'
  const cwd = '/root/proj'
  const transcriptDir = join(root, 'projects', transcriptFolder(cwd), 'agent-transcripts', nativeId)
  mkdirSync(transcriptDir, { recursive: true })

  const blocks = Array.from({ length: MAX_SESSION_FILES }, (_, index) => (
    { type: 'tool_use', input: { path: `/root/proj/file-${index}.ts` } }
  ))
  // One more block reusing the very first path: the set is already full and
  // already holds this path, so this must not be counted as a drop.
  blocks.push({ type: 'tool_use', input: { path: '/root/proj/file-0.ts' } })
  const line = JSON.stringify({ role: 'assistant', message: { content: blocks } })
  writeFileSync(join(transcriptDir, `${nativeId}.jsonl`), `${line}\n`)

  const ref = {
    uid: `cursor:${nativeId}`, client: 'cursor', nativeId, cwd, gitBranch: null,
    title: null, startedAt: 0, endedAt: 0, turns: null, parentNativeId: null,
    tier: 'resume' as const, origin: 'manifest' as const, sourcePaths: [], fingerprint: '',
  }
  const doc = await cursorReader.hydrate(manifest, root, ref, DEFAULT_CONFIG)
  expect(doc.files).toHaveLength(MAX_SESSION_FILES)
  expect(doc.truncated).toBe(false)

  // A genuinely new path offered after the cap is the one that should mark it.
  blocks.push({ type: 'tool_use', input: { path: '/root/proj/file-new.ts' } })
  writeFileSync(join(transcriptDir, `${nativeId}.jsonl`), `${JSON.stringify({ role: 'assistant', message: { content: blocks } })}\n`)
  const truncatedDoc = await cursorReader.hydrate(manifest, root, ref, DEFAULT_CONFIG)
  expect(truncatedDoc.files).toHaveLength(MAX_SESSION_FILES)
  expect(truncatedDoc.truncated).toBe(true)
})

/** cursor-agent 2026.09.15-d2fe57e, from its own --help. */
const CURSOR_SUBCOMMANDS = [
  'persist', 'install-shell-integration', 'uninstall-shell-integration', 'login', 'logout', 'mcp',
  'plugin', 'worker', 'status', 'models', 'bedrock', 'about', 'update', 'create-chat',
  'generate-rule', 'agent', 'ls', 'resume', 'help',
]

test('a brief cannot be parsed as a cursor-agent subcommand, whatever note leads it', () => {
  // commander dispatches only when the whole operand equals a command name, and
  // a brief is one argument that always carries the handover heading.
  const adapter = buildAdapter(validateManifest(cursorManifest))
  for (const note of CURSOR_SUBCOMMANDS) {
    const brief = `${note}\n\n# Handover from a previous session\n\ncontext`
    const plan = adapter.plan({ nativeId: FULL, cwd: '/root/proj' }, brief)!
    expect(plan.args).toHaveLength(1)
    expect(CURSOR_SUBCOMMANDS).not.toContain(plan.args[0]!)
  }
})

test('the built-in Cursor client resumes by chat id', () => {
  const adapter = buildAdapter(validateManifest(cursorManifest))
  expect(adapter.plan({ nativeId: FULL, cwd: '/root/proj' })).toEqual({
    kind: 'resume', cmd: 'cursor-agent', args: ['--resume', FULL], cwd: '/root/proj',
  })
})
