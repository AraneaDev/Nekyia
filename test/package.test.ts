import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('both bins are declared', () => {
  expect(Object.keys(pkg.bin).sort()).toEqual(['nek', 'nekyia'])
})

test('the licence is MIT and the file exists', () => {
  expect(pkg.license).toBe('MIT')
  expect(existsSync(join(root, 'LICENSE'))).toBe(true)
})

test('no runtime dependency pulls in a native module', () => {
  const deps = Object.keys(pkg.dependencies ?? {})
  expect(deps).not.toContain('better-sqlite3')
  expect(deps).not.toContain('node-gyp')
})

test('the README carries no em dashes', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  expect(readme).not.toContain('—')
  expect(readme).not.toMatch(/\b(?:we|our|companies)\b/i)
})

test('the README names the exact roadmap and truthful launch tiers', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  for (const client of [
    'Aider', 'Goose', 'Crush', 'Cursor CLI', 'GitHub Copilot CLI', 'Qwen Code',
    'Continue CLI', 'Droid', 'Amazon Q Developer CLI', 'Plandex', 'OpenHands',
    'Amp', 'Warp Agent', 'Grok CLI', 'Rovo Dev', 'Auggie', 'Trae', 'Cline CLI',
    'Zed',
  ]) expect(readme).toContain(client)
  expect(readme).toContain('opencode <brief>')
  expect(readme).toContain('codebuff --cwd <cwd> <brief>')
  expect(readme).toContain('Search-tier clients always start fresh briefed sessions')
  expect(readme).toContain('bun build --compile')
})

test('the README states the offline privacy boundary plainly', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8').toLowerCase()
  expect(readme).toContain('no network')
  expect(readme).toContain('no api key')
  expect(readme).toContain('no telemetry')
})

test('the package contains only publishable runtime material', () => {
  expect(pkg.files).toEqual(['src', 'README.md', 'LICENSE'])
  expect(pkg.engines?.bun).toBe('>=1.1.0')
  expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['ink', 'react'])
  expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual([
    '@types/bun', '@types/react', 'ink-testing-library', 'typescript',
  ])
})

test('both executable entry points use the Bun shebang', () => {
  for (const entry of Object.values(pkg.bin) as string[]) {
    expect(readFileSync(join(root, entry), 'utf8')).toStartWith('#!/usr/bin/env bun\n')
  }
})

test('the bug template carries a disclosure warning', () => {
  const template = readFileSync(
    join(root, '.github', 'ISSUE_TEMPLATE', 'bug_report.md'),
    'utf8',
  ).toLowerCase()
  expect(template).toContain('prompts and file paths')
  expect(template).toContain('redact')
})
