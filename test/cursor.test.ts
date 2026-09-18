import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/config'
import { cursorReader, transcriptFolder, unwrapUserText } from '../src/formats/cursor'
import { validateManifest } from '../src/manifests/load'

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
