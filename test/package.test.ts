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

test('the package carries the metadata npm and trusted publishing need', () => {
  // Trusted publishing verifies repository.url against the GitHub repo and
  // refuses the publish when they differ, so this string is load-bearing.
  expect(pkg.repository).toEqual({
    type: 'git',
    url: 'git+https://github.com/AraneaDev/Nekyia.git',
  })
  expect(pkg.homepage).toBe('https://aranea-development.nl/en/tools/nekyia')
  expect(pkg.bugs?.url).toBe('https://github.com/AraneaDev/Nekyia/issues')
  expect(pkg.author).toBe('AraneaDev')
  expect(pkg.publishConfig?.access).toBe('public')
  expect(pkg.keywords).toContain('cli')
  expect(pkg.keywords).toContain('bun')
  expect(pkg.keywords.length).toBeGreaterThanOrEqual(5)
})

test('the prepare script cannot touch a consumer git config', () => {
  // npm runs prepare before packing, and some install paths run it on the
  // consumer's machine. .githooks is not in the tarball, so the guard makes
  // it a no-op everywhere except a source checkout.
  expect(pkg.scripts.prepare).toStartWith('[ -d .githooks ]')
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
  expect(readme).toContain('opencode --prompt <brief>')
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

test('the README follows the project house style and documents the npm install', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  expect(readme).toStartWith('<div align="center">\n\n# Nekyia')
  expect(readme).toContain('github/v/release/AraneaDev/Nekyia')
  expect(readme).toContain('actions/workflow/status/AraneaDev/Nekyia/ci.yml')
  // Nothing about npm appears while the package is unresolvable: not the
  // badges, which shields renders as broken red boxes, and not an install
  // command that 404s.
  expect(readme).not.toContain('img.shields.io/npm/')
  expect(readme).not.toContain('bun install -g nekyia')
  expect(readme).not.toContain('npmjs.com/package/nekyia')
  expect(readme).toContain('> **Nekyia**')
  expect(readme).toContain('git clone https://github.com/AraneaDev/Nekyia.git')
  // The pre-release hedges are gone now that the package is on the registry.
  expect(readme).not.toContain('status-pre--release')
  expect(readme).not.toContain('not yet published to npm')
  // 1.0.0 is a real release, so the release badge should not have to reach
  // for prereleases to find one, and no prose should still call this a
  // pre-release.
  expect(readme).not.toContain('include_prereleases')
  expect(readme).not.toMatch(/pre-release/iu)
})

test('the package contains only publishable runtime material', () => {
  // 'bin' is load-bearing, not tidiness: the bin field alone ships only the
  // launcher, and the launcher imports resolve-bun.mjs, which is not a bin
  // entry. Drop 'bin' here and the published package fails on its own import.
  expect(pkg.files).toEqual(['bin', 'src', 'README.md', 'LICENSE'])
  expect(pkg.engines?.bun).toBe('>=1.1.0')
  expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['ink', 'react'])
  expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual([
    '@eslint/js', '@stryker-mutator/core', '@types/bun', '@types/react',
    'eslint', 'eslint-plugin-jsdoc', 'ink-testing-library', 'typescript',
    'typescript-eslint',
  ])
})

test('no bin path carries a leading ./, which npm strips on publish', () => {
  // npm's publish-time normalization rejects a "./"-prefixed bin target and
  // silently drops the entry, so the package installs with no command at all.
  // It warns and carries on, and `npm pack` does not warn, so this is only
  // visible on a publish. Nekyia shipped 1.0.0 into exactly that failure.
  for (const entry of Object.values(pkg.bin) as string[]) {
    expect(entry).not.toStartWith('./')
    expect(entry).not.toStartWith('/')
  }
})

test('both bins point at the Node-readable launcher', () => {
  for (const entry of Object.values(pkg.bin) as string[]) {
    expect(entry).toBe('bin/nekyia.mjs')
    // Node has to be able to read this file, because reaching nekyia from
    // Node is exactly the case the launcher exists to handle.
    expect(readFileSync(join(root, entry), 'utf8')).toStartWith('#!/usr/bin/env node\n')
  }
})

test('the CLI itself still declares Bun', () => {
  expect(readFileSync(join(root, 'src/cli.ts'), 'utf8')).toStartWith('#!/usr/bin/env bun\n')
})

test('the bug template carries a disclosure warning', () => {
  const template = readFileSync(
    join(root, '.github', 'ISSUE_TEMPLATE', 'bug_report.md'),
    'utf8',
  ).toLowerCase()
  expect(template).toContain('prompts and file paths')
  expect(template).toContain('redact')
})
