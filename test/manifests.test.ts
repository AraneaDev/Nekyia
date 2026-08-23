import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expandRoot,
  loadManifests,
  renderArgs,
  validateManifest,
} from '../src/manifests/load'
import type { SidecarSpec } from '../src/manifests/load'

const sidecarWithoutTime: SidecarSpec = {
  file: 'history.jsonl',
  idField: 'id',
  textField: 'text',
}
void sidecarWithoutTime

const minimalManifest = {
  schema: 1,
  id: 'x',
  name: 'X',
  roots: ['~/.x'],
  format: 'jsonl-transcript',
  tier: 'search',
  jsonl: { glob: '*.jsonl', variant: 'claude' },
}

let tmp: string
const savedEnv = { ...process.env }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nekyia-manifests-'))
  process.env.XDG_CONFIG_HOME = join(tmp, 'config')
})

afterEach(() => {
  process.env = { ...savedEnv }
  rmSync(tmp, { recursive: true, force: true })
})

test('validates a minimal manifest', () => {
  expect(validateManifest(minimalManifest).id).toBe('x')
})

test('rejects unsupported manifest schemas', () => {
  expect(() => validateManifest({ ...minimalManifest, schema: 2 }))
    .toThrow('unsupported manifest schema')
})

test('rejects unknown formats', () => {
  expect(() => validateManifest({ ...minimalManifest, format: 'telepathy' }))
    .toThrow('unknown format')
})

test('requires a resume command for resume-tier manifests', () => {
  expect(() => validateManifest({ ...minimalManifest, tier: 'resume' }))
    .toThrow('tier "resume" requires a resume command')
})

test('requires the matching configuration block for every format', () => {
  const cases = [
    [{ ...minimalManifest, jsonl: undefined }, 'jsonl'],
    [{ ...minimalManifest, format: 'sqlite-store', jsonl: undefined }, 'sqlite'],
    [{ ...minimalManifest, format: 'json-dir', jsonl: undefined }, 'jsonDir'],
  ] as const

  for (const [manifest, section] of cases) {
    expect(() => validateManifest(manifest)).toThrow(section)
  }
})

test('rejects malformed jsonl configuration', () => {
  const cases = [
    [{ glob: 42, variant: 'claude' }, 'jsonl.glob'],
    [{ glob: '*.jsonl', variant: 'telepathy' }, 'jsonl.variant'],
    [{ glob: '*.jsonl', variant: 'generic', generic: { idFrom: 42 } }, 'jsonl.generic.idFrom'],
    [{ glob: '*.jsonl', variant: 'generic', generic: { idFrom: 'filename', cwdPath: 42 } }, 'jsonl.generic.cwdPath'],
    [{ glob: '*.jsonl', variant: 'generic', generic: { idFrom: 'filename', userRoles: ['user', 42] } }, 'jsonl.generic.userRoles'],
  ] as const

  for (const [jsonl, field] of cases) {
    expect(() => validateManifest({ ...minimalManifest, jsonl })).toThrow(field)
  }
})

test('rejects malformed sqlite configuration', () => {
  const cases = [
    [{ file: 42, sessions: 'SELECT 1' }, 'sqlite.file'],
    [{ file: 'x.db', sessions: 42 }, 'sqlite.sessions'],
    [{ file: 'x.db', sessions: 'SELECT 1', text: 42 }, 'sqlite.text'],
    [{ file: 'x.db', sessions: 'SELECT 1', textShape: 'json' }, 'sqlite.textShape'],
    [{ file: 'x.db', sessions: 'SELECT 1', cwdShape: 'uri' }, 'sqlite.cwdShape'],
    [{ file: 'x.db', sessions: 'SELECT 1', timeUnit: 'minutes' }, 'sqlite.timeUnit'],
  ] as const

  for (const [sqlite, field] of cases) {
    expect(() => validateManifest({
      ...minimalManifest,
      format: 'sqlite-store',
      jsonl: undefined,
      sqlite,
    })).toThrow(field)
  }
})

test('rejects malformed json-dir configuration', () => {
  expect(() => validateManifest({
    ...minimalManifest,
    format: 'json-dir',
    jsonl: undefined,
    jsonDir: { glob: 'projects/*', variant: 'other' },
  })).toThrow('jsonDir.variant')
})

test('validates every supplied command', () => {
  expect(() => validateManifest({
    ...minimalManifest,
    resume: { cmd: 'x', args: 'bad' },
  })).toThrow('resume.args')
  expect(() => validateManifest({
    ...minimalManifest,
    brief: { cmd: 42, args: [] },
  })).toThrow('brief.cmd')
})

test('validates every supplied sidecar', () => {
  expect(() => validateManifest({
    ...minimalManifest,
    sidecar: { file: 'x', idField: 'id', textField: 42 },
  })).toThrow('sidecar.textField')
  expect(() => validateManifest({
    ...minimalManifest,
    sidecar: { file: 'x', idField: 'id', textField: 'text', tsUnit: 'iso' },
  })).toThrow('sidecar.tsUnit')
})

test('rejects client ids that cannot round-trip through a uid', () => {
  expect(() => validateManifest({ ...minimalManifest, id: '' })).toThrow('manifest id')
  expect(() => validateManifest({ ...minimalManifest, id: 'foo:bar' })).toThrow('manifest id')
})

test('expands a leading tilde in roots', () => {
  expect(expandRoot('~/.claude')).toBe(`${process.env.HOME}/.claude`)
})

test('only expands a tilde representing the current home directory', () => {
  expect(expandRoot('~')).toBe(process.env.HOME!)
  expect(expandRoot('~other/.claude')).toBe('~other/.claude')
})

test('renders known command argument placeholders', () => {
  expect(renderArgs(
    ['--resume', '{id}', '--cwd', '{cwd}'],
    { id: 'abc', cwd: '/p' },
  )).toEqual(['--resume', 'abc', '--cwd', '/p'])
})

test('leaves unknown command argument placeholders untouched', () => {
  expect(renderArgs(['{unknown}'], { id: 'abc' })).toEqual(['{unknown}'])
})

test('loads all built-in manifests without errors', () => {
  const { manifests, diagnostics } = loadManifests()

  expect(manifests.map((manifest) => manifest.id)).toEqual([
    'agy',
    'claude',
    'codebuff',
    'codex',
    'kilo',
    'opencode',
  ])
  expect(manifests.find((manifest) => manifest.id === 'opencode')?.name).toBe('opencode')
  expect(diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
})
