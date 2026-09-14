import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { resolveBun } from '../bin/resolve-bun.mjs'

const LAUNCHER = join(import.meta.dir, '..', 'bin', 'nekyia.mjs')
const tempDirs: string[] = []

/**
 * Absolute path to a node binary, or null on a machine without one.
 *
 * Absolute matters: one test spawns with an empty PATH, and a bare 'node'
 * would then be unresolvable by the spawn itself rather than by the launcher,
 * which is not the thing under test.
 */
function resolveNode(): string | null {
  const probe = spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' })
  const path = probe.stdout?.trim()
  return probe.status === 0 && path ? path : null
}

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

test('the launcher runs the CLI in-process when Bun starts it', () => {
  const result = spawnSync(process.execPath, [LAUNCHER, '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('nekyia - search every agent CLI session')
})

test('the launcher re-execs through Bun when Node starts it', () => {
  const node = resolveNode()
  if (!node) return
  const result = spawnSync(node, [LAUNCHER, '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('nekyia - search every agent CLI session')
})

test('the launcher forwards the CLI exit code rather than always exiting zero', () => {
  const result = spawnSync(process.execPath, [LAUNCHER, 'not-a-real-command'], { encoding: 'utf8' })
  expect(result.status).not.toBe(0)
})

test('the launcher explains itself when no Bun is on PATH', () => {
  const node = resolveNode()
  if (!node) return
  const result = spawnSync(node, [LAUNCHER, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '', Path: '' },
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('https://bun.sh')
  expect(result.stderr).toContain('PATH')
  // The failure this replaces. If it reappears, the guard stopped working.
  expect(result.stderr).not.toContain("Cannot find module 'bun:sqlite'")
})
