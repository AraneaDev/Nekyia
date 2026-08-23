import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSidecar } from '../src/formats/prompt-sidecar'

const FIX = join(import.meta.dir, 'fixtures')

test('reads codex history keyed by session id, converting seconds to ms', () => {
  const m = readSidecar(join(FIX, 'codex'), {
    file: 'history.jsonl', idField: 'session_id', textField: 'text', tsField: 'ts', tsUnit: 's',
  })
  const e = m.get('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')!
  expect(e.prompts).toEqual(['rewrite the transport layer'])
  expect(e.firstTs).toBe(1785661200000)
})

test('reads agy history and captures the workspace as cwd', () => {
  const m = readSidecar(join(FIX, 'agy'), {
    file: 'history.jsonl', idField: 'conversationId', textField: 'display',
    tsField: 'timestamp', tsUnit: 'ms', cwdField: 'workspace',
  })
  const e = m.get('597b1c48-7b0c-434a-83d6-14e908a699b5')!
  expect(e.prompts).toEqual(['i want domination instead of wordworth'])
  expect(e.cwd).toBe('/root/proj')
})

test('skips lines with no session id rather than inventing one', () => {
  const m = readSidecar(join(FIX, 'agy'), {
    file: 'history.jsonl', idField: 'conversationId', textField: 'display',
  })
  expect([...m.keys()]).toEqual(['597b1c48-7b0c-434a-83d6-14e908a699b5'])
})

test('returns an empty map when the sidecar does not exist', () => {
  expect(readSidecar('/nonexistent', { file: 'history.jsonl', idField: 'x', textField: 'y' }).size).toBe(0)
})

test('skips malformed, non-object, and invalid prompt rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sidecar-'))
  try {
    writeFileSync(join(root, 'history.jsonl'), [
      '{not json',
      'null',
      '[]',
      JSON.stringify({ id: '', text: 'empty id' }),
      JSON.stringify({ id: '   ', text: 'blank id' }),
      JSON.stringify({ id: 'one', text: 42 }),
      JSON.stringify({ id: 'one', text: '   ' }),
      JSON.stringify({ id: 'one', text: 'valid', timestamp: 'not-a-number' }),
    ].join('\n'))

    expect(readSidecar(root, {
      file: 'history.jsonl', idField: 'id', textField: 'text', tsField: 'timestamp',
    })).toEqual(new Map([
      ['one', { prompts: ['valid'], firstTs: 0, lastTs: 0, cwd: null }],
    ]))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('aggregates in file order while tracking timestamp bounds and first nonempty cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sidecar-'))
  try {
    writeFileSync(join(root, 'history.jsonl'), [
      JSON.stringify({ id: 'one', text: ' later ', timestamp: 30, cwd: '' }),
      JSON.stringify({ id: 'two', text: 'other', timestamp: 20, cwd: '/other' }),
      JSON.stringify({ id: 'one', text: 'earlier', timestamp: 10, cwd: '/first' }),
      JSON.stringify({ id: 'one', text: 'latest', timestamp: 40, cwd: '/ignored' }),
    ].join('\n'))

    expect(readSidecar(root, {
      file: 'history.jsonl', idField: 'id', textField: 'text', tsField: 'timestamp',
      cwdField: 'cwd',
    }).get('one')).toEqual({
      prompts: ['later', 'earlier', 'latest'],
      firstTs: 10,
      lastTs: 40,
      cwd: '/first',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects absolute paths, traversal, and symlinks escaping the root', () => {
  const base = mkdtempSync(join(tmpdir(), 'nekyia-sidecar-path-'))
  const root = join(base, 'root')
  const outside = join(base, 'outside.jsonl')
  mkdirSync(root)
  writeFileSync(outside, `${JSON.stringify({ id: 'escaped', text: 'secret' })}\n`)
  writeFileSync(join(root, 'inside.jsonl'), `${JSON.stringify({ id: 'inside', text: 'prompt' })}\n`)
  const spec = { idField: 'id', textField: 'text' }

  try {
    expect(readSidecar(root, { ...spec, file: '../outside.jsonl' }).size).toBe(0)
    expect(readSidecar(root, { ...spec, file: outside }).size).toBe(0)
    expect(readSidecar(root, { ...spec, file: 'nested/../inside.jsonl' }).size).toBe(0)

    try {
      symlinkSync(outside, join(root, 'linked.jsonl'))
    } catch {
      return
    }
    expect(readSidecar(root, { ...spec, file: 'linked.jsonl' }).size).toBe(0)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('parses timestamps without coercion and preserves zero as a lower bound', () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sidecar-ts-'))
  try {
    writeFileSync(join(root, 'history.jsonl'), [
      JSON.stringify({ id: ' zero ', text: 'epoch', ts: 0 }),
      JSON.stringify({ id: 'zero', text: 'later', ts: 10 }),
      JSON.stringify({ id: 'invalid', text: 'boolean', ts: true }),
      JSON.stringify({ id: 'invalid', text: 'array', ts: [12] }),
      JSON.stringify({ id: 'invalid', text: 'blank', ts: '  ' }),
      JSON.stringify({ id: 'invalid', text: 'negative', ts: -1 }),
      JSON.stringify({ id: 'invalid', text: 'overflow', ts: '1e309' }),
      JSON.stringify({ id: 'invalid', text: 'multiplier overflow', ts: Number.MAX_VALUE }),
      JSON.stringify({ id: 'numeric', text: 'decimal', ts: ' 2.5 ' }),
    ].join('\n'))

    const result = readSidecar(root, {
      file: 'history.jsonl', idField: 'id', textField: 'text', tsField: 'ts', tsUnit: 's',
    })
    expect(result.get('zero')).toEqual({
      prompts: ['epoch', 'later'], firstTs: 0, lastTs: 10000, cwd: null,
    })
    expect(result.get('invalid')).toEqual({
      prompts: ['boolean', 'array', 'blank', 'negative', 'overflow', 'multiplier overflow'],
      firstTs: 0,
      lastTs: 0,
      cwd: null,
    })
    expect(result.get('numeric')?.firstTs).toBe(2500)
    expect(result.has(' zero ')).toBeFalse()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skips oversized rows, continues reading, and preserves split UTF-8', () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sidecar-stream-'))
  try {
    const prefix = '{"id":"split","text":"'
    const boundaryPadding = 'a'.repeat(64 * 1024 - 1 - new TextEncoder().encode(prefix).length)
    writeFileSync(join(root, 'history.jsonl'), [
      JSON.stringify({ id: 'oversized', text: 'x'.repeat(4 * 1024 * 1024) }),
      JSON.stringify({ id: 'oversized', text: 'kept' }),
      `${prefix}${boundaryPadding}€"}`,
    ].join('\n'))

    const result = readSidecar(root, {
      file: 'history.jsonl', idField: 'id', textField: 'text',
    })
    expect(result.get('oversized')?.prompts).toEqual(['kept'])
    expect(result.get('split')?.prompts[0]?.endsWith('€')).toBeTrue()
    expect(result.get('split')?.prompts[0]?.includes('�')).toBeFalse()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('uses the first trimmed cwd without control characters', () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sidecar-cwd-'))
  try {
    writeFileSync(join(root, 'history.jsonl'), [
      JSON.stringify({ id: 'one', text: 'first', cwd: '/unsafe\npath' }),
      JSON.stringify({ id: 'one', text: 'second', cwd: '  /root/My Project  ' }),
      JSON.stringify({ id: 'one', text: 'third', cwd: '/ignored' }),
    ].join('\n'))

    expect(readSidecar(root, {
      file: 'history.jsonl', idField: 'id', textField: 'text', cwdField: 'cwd',
    }).get('one')?.cwd).toBe('/root/My Project')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
