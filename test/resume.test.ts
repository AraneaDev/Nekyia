import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPlan, runPlan, shellQuote } from '../src/core/resume'
import type { ExecPlan } from '../src/types'

const ok: ExecPlan = { kind: 'resume', cmd: 'echo', args: ['hello'], cwd: process.cwd() }
const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('checkPlan accepts a plan whose cwd exists and command is executable', () => {
  expect(checkPlan(ok).ok).toBe(true)
})

test('checkPlan refuses a vanished cwd rather than guessing', () => {
  const result = checkPlan({ ...ok, cwd: '/definitely/not/here' })
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('no longer exists')
})

test('checkPlan requires cwd to be an accessible directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-resume-'))
  temporary.push(root)
  const file = join(root, 'not-a-directory')
  writeFileSync(file, '')
  expect(checkPlan({ ...ok, cwd: file }).reason).toContain('not an accessible directory')

  const inaccessible = join(root, 'inaccessible')
  writeFileSync(inaccessible, '')
  chmodSync(inaccessible, 0)
  expect(checkPlan({ ...ok, cwd: inaccessible }).ok).toBe(false)
})

test('checkPlan refuses a command that is not on PATH', () => {
  const result = checkPlan({ ...ok, cmd: 'nekyia-does-not-exist' })
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('not found')
})

test('checkPlan accepts an explicit executable path and rejects a directory', () => {
  expect(checkPlan({ ...ok, cmd: '/bin/sh' }).ok).toBe(true)
  expect(checkPlan({ ...ok, cmd: process.cwd() }).ok).toBe(false)
})

test('checkPlan resolves relative PATH entries from the planned cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-resume-'))
  temporary.push(root)
  mkdirSync(join(root, 'bin'))
  for (const relative of ['bin/from-bin', 'from-dot']) {
    const executable = join(root, relative)
    writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    chmodSync(executable, 0o700)
  }

  const previous = process.env.PATH
  try {
    process.env.PATH = './bin'
    expect(checkPlan({ ...ok, cwd: root, cmd: 'from-bin' }).ok).toBe(true)
    process.env.PATH = '.'
    expect(checkPlan({ ...ok, cwd: root, cmd: 'from-dot' }).ok).toBe(true)
    process.env.PATH = ''
    expect(checkPlan({ ...ok, cwd: root, cmd: 'from-dot' }).ok).toBe(true)
    process.env.PATH = join(root, 'bin')
    expect(checkPlan({ ...ok, cwd: root, cmd: 'from-bin' }).ok).toBe(true)
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
})

test('runPlan executes the same absolute command accepted from relative PATH entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-resume-'))
  temporary.push(root)
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', 'relative-command'), '#!/bin/sh\nexit 23\n')
  chmodSync(join(root, 'bin', 'relative-command'), 0o700)
  writeFileSync(join(root, 'cwd-command'), '#!/bin/sh\nexit 24\n')
  chmodSync(join(root, 'cwd-command'), 0o700)

  const previous = process.env.PATH
  try {
    for (const path of ['./bin', 'bin']) {
      process.env.PATH = path
      const plan = { ...ok, cwd: root, cmd: 'relative-command', args: [] }
      expect(checkPlan(plan).ok).toBe(true)
      expect(await runPlan(plan)).toBe(23)
    }
    process.env.PATH = `:${join(root, 'missing')}`
    const plan = { ...ok, cwd: root, cmd: 'cwd-command', args: [] }
    expect(checkPlan(plan).ok).toBe(true)
    expect(await runPlan(plan)).toBe(24)
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
})

test('runPlan passes an absolute resolved executable to the process launcher', async () => {
  let command: string[] = []
  await runPlan(ok, {
    spawn(supplied) {
      command = supplied
      return { exited: Promise.resolve(0) }
    },
  })
  expect(command[0]?.startsWith('/')).toBe(true)
})

test('runPlan forwards the child exit code', async () => {
  expect(await runPlan({ ...ok, cmd: 'sh', args: ['-c', 'exit 7'] })).toBe(7)
})

test('runPlan preserves the conventional exit status for a signal', async () => {
  expect(await runPlan({ ...ok, cmd: 'sh', args: ['-c', 'kill -TERM $$'] })).toBe(143)
})

test('runPlan uses inherited stdio', async () => {
  let options: unknown
  const exit = await runPlan(ok, {
    spawn(command, supplied) {
      expect(command[0]?.endsWith('/echo')).toBe(true)
      expect(command.slice(1)).toEqual(['hello'])
      options = supplied
      return { exited: Promise.resolve(0) }
    },
  })
  expect(exit).toBe(0)
  expect(options).toMatchObject({
    cwd: process.cwd(), stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  })
})

test('shellQuote produces a command you can paste', () => {
  expect(shellQuote({ kind: 'resume', cmd: 'claude', args: ['--resume', 'a b'], cwd: '/root/my proj' }))
    .toBe(`cd '/root/my proj' && claude --resume 'a b'`)
})

test('shellQuote safely quotes cmd, empty values, quotes and newlines without a trailing space', () => {
  expect(shellQuote({
    kind: 'brief',
    cmd: 'odd command',
    args: ['', `it's`, 'two\nlines'],
    cwd: '',
  })).toBe(`cd '' && 'odd command' '' 'it'\\''s' 'two\nlines'`)
  expect(shellQuote({ ...ok, cmd: 'true', args: [] })).toBe(`cd ${process.cwd()} && true`)
})

test('shellQuote command names round-trip through a POSIX shell without parser ambiguity', () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-resume-'))
  temporary.push(root)
  const marker = join(root, 'ran')
  for (const command of ['FOO=bar', 'if', 'semi;colon']) {
    const executable = join(root, command)
    writeFileSync(executable, '#!/bin/sh\nprintf ok > "$1"\n')
    chmodSync(executable, 0o700)
    rmSync(marker, { force: true })
    const quoted = shellQuote({ kind: 'resume', cmd: command, args: [marker], cwd: root })
    const result = Bun.spawnSync(['/bin/sh', '-c', quoted], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
    })
    expect(result.exitCode).toBe(0)
    expect(readFileSync(marker, 'utf8')).toBe('ok')
  }
})

test('shellQuote protects a relative cwd beginning with a dash from cd option parsing', () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-resume-'))
  temporary.push(root)
  mkdirSync(join(root, '-project'))
  const quoted = shellQuote({ kind: 'resume', cmd: 'pwd', args: [], cwd: '-project' })
  expect(quoted).toStartWith('cd ./-project && ')
  const result = Bun.spawnSync(['/bin/sh', '-c', quoted], { cwd: root })
  expect(result.exitCode).toBe(0)
  expect(new TextDecoder().decode(result.stdout).trim()).toBe(join(root, '-project'))
})
