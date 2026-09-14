import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { resolveBun } from '../bin/resolve-bun.mjs'

const tempDirs: string[] = []

function makeTemp(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(path)
  return path
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('resolveBun finds an executable bun on PATH', () => {
  const dir = makeTemp('nekyia-bun-')
  const bun = join(dir, 'bun')
  writeFileSync(bun, '#!/bin/sh\nexit 0\n')
  chmodSync(bun, 0o755)
  expect(resolveBun({ PATH: dir }, 'linux')).toBe(bun)
})

test('resolveBun skips a non-executable file of the right name', () => {
  const dir = makeTemp('nekyia-bun-')
  const bun = join(dir, 'bun')
  writeFileSync(bun, 'not executable\n')
  chmodSync(bun, 0o644)
  expect(resolveBun({ PATH: dir }, 'linux')).toBeNull()
})

test('resolveBun returns null for an empty or absent PATH', () => {
  expect(resolveBun({ PATH: '' }, 'linux')).toBeNull()
  expect(resolveBun({}, 'linux')).toBeNull()
})

test('resolveBun searches PATH entries in order and ignores empty segments', () => {
  const first = makeTemp('nekyia-bun-a-')
  const second = makeTemp('nekyia-bun-b-')
  const winner = join(first, 'bun')
  writeFileSync(winner, '#!/bin/sh\nexit 0\n')
  chmodSync(winner, 0o755)
  const loser = join(second, 'bun')
  writeFileSync(loser, '#!/bin/sh\nexit 0\n')
  chmodSync(loser, 0o755)
  expect(resolveBun({ PATH: ['', first, second].join(delimiter) }, 'linux')).toBe(winner)
})

test('resolveBun looks for bun.exe on Windows', () => {
  const dir = makeTemp('nekyia-bun-')
  writeFileSync(join(dir, 'bun.exe'), 'binary\n')
  expect(resolveBun({ PATH: dir }, 'win32')).toBe(join(dir, 'bun.exe'))
})
