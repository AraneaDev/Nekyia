import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { cursorReader, transcriptFolder } from '../src/formats/cursor'
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
