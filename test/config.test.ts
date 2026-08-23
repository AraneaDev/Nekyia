import { expect, test, beforeEach, afterEach } from 'bun:test'
import { configDir, dataDir, indexPath, loadConfig, isExcluded, DEFAULT_CONFIG } from '../src/config'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmp: string
const saved = { ...process.env }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nekyia-'))
  process.env.XDG_CONFIG_HOME = join(tmp, 'config')
  process.env.XDG_DATA_HOME = join(tmp, 'data')
})

afterEach(() => {
  process.env = { ...saved }
  rmSync(tmp, { recursive: true, force: true })
})

test('honours XDG env vars', () => {
  expect(configDir()).toBe(join(tmp, 'config', 'nekyia'))
  expect(dataDir()).toBe(join(tmp, 'data', 'nekyia'))
  expect(indexPath()).toBe(join(tmp, 'data', 'nekyia', 'index.db'))
})

test('falls back to ~/.config and ~/.local/share', () => {
  delete process.env.XDG_CONFIG_HOME
  delete process.env.XDG_DATA_HOME
  expect(configDir()).toBe(join(process.env.HOME!, '.config', 'nekyia'))
  expect(dataDir()).toBe(join(process.env.HOME!, '.local', 'share', 'nekyia'))
})

test('falls back when XDG env vars are empty', () => {
  process.env.XDG_CONFIG_HOME = ''
  process.env.XDG_DATA_HOME = ''
  expect(configDir()).toBe(join(process.env.HOME!, '.config', 'nekyia'))
  expect(dataDir()).toBe(join(process.env.HOME!, '.local', 'share', 'nekyia'))
})

test('returns defaults when no config file exists', () => {
  expect(loadConfig()).toEqual(DEFAULT_CONFIG)
})

test('merges a partial config file over the defaults', () => {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'config.json'), JSON.stringify({ halfLifeDays: 30 }))
  const c = loadConfig()
  expect(c.halfLifeDays).toBe(30)
  expect(c.maxFileBytes).toBe(DEFAULT_CONFIG.maxFileBytes)
})

test('returns defaults and does not throw on malformed json', () => {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'config.json'), '{not json')
  expect(loadConfig()).toEqual(DEFAULT_CONFIG)
})

test('uses defaults for config fields with invalid types', () => {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'config.json'), JSON.stringify({
    exclude: 42,
    halfLifeDays: 'fourteen',
    maxFileBytes: 'large',
    hiddenClients: ['valid', 42],
    showSniffed: 'yes',
  }))
  expect(loadConfig()).toEqual(DEFAULT_CONFIG)
})

test('preserves finite numeric config values regardless of sign', () => {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'config.json'), JSON.stringify({
    halfLifeDays: 0,
    maxFileBytes: -1,
  }))
  const config = loadConfig()
  expect(config.halfLifeDays).toBe(0)
  expect(config.maxFileBytes).toBe(-1)
})

test('uses defaults for non-object top-level json', () => {
  mkdirSync(configDir(), { recursive: true })
  for (const raw of ['null', '[]']) {
    writeFileSync(join(configDir(), 'config.json'), raw)
    expect(loadConfig()).toEqual(DEFAULT_CONFIG)
  }
})

test('returns fresh default arrays for every load', () => {
  const first = loadConfig()
  expect(first.exclude).not.toBe(DEFAULT_CONFIG.exclude)
  expect(first.hiddenClients).not.toBe(DEFAULT_CONFIG.hiddenClients)
  first.exclude.push('/mutated/**')
  first.hiddenClients.push('mutated')

  const second = loadConfig()
  expect(DEFAULT_CONFIG.exclude).toEqual([])
  expect(DEFAULT_CONFIG.hiddenClients).toEqual([])
  expect(second.exclude).toEqual([])
  expect(second.hiddenClients).toEqual([])
})

test('isExcluded matches a glob prefix', () => {
  const c = { ...DEFAULT_CONFIG, exclude: ['/root/secret/**'] }
  expect(isExcluded('/root/secret/thing', c)).toBe(true)
  expect(isExcluded('/root/public/thing', c)).toBe(false)
})

test('isExcluded is false for a null cwd', () => {
  const c = { ...DEFAULT_CONFIG, exclude: ['/root/**'] }
  expect(isExcluded(null, c)).toBe(false)
})

test('isExcluded is false for an empty cwd', () => {
  const c = { ...DEFAULT_CONFIG, exclude: ['**'] }
  expect(isExcluded('', c)).toBe(false)
})
