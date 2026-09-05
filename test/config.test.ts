import { expect, test, beforeEach, afterEach } from 'bun:test'
import {
  configDir,
  dataDir,
  indexPath,
  loadConfig,
  isExcluded,
  updateConfig,
  loadConfigChecked,
  DEFAULT_CONFIG,
} from '../src/config'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tmp: string
const saved = { ...process.env }

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nekyia-')))
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

test('rejects an oversized config before parsing it', () => {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'config.json'), `{"exclude":["${'x'.repeat(1024 * 1024)}"]}`)
  expect(loadConfig()).toEqual(DEFAULT_CONFIG)
})

test('uses defaults for config fields with invalid types', () => {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'config.json'), JSON.stringify({
    exclude: 42,
    halfLifeDays: 'fourteen',
    maxFileBytes: 'large',
    hiddenClients: ['valid', 42],
  }))
  expect(loadConfig()).toEqual(DEFAULT_CONFIG)
})

test('a config written by an older version still loads and still updates', async () => {
  // showSniffed was retired. A config that still carries it must keep working:
  // a normal load ignores it, and the strict read behind `nekyia exclude` must
  // not reject the whole file over a key Nekyia itself once wrote.
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'config.json'), JSON.stringify({
    halfLifeDays: 30,
    showSniffed: true,
  }))
  const loaded = loadConfig()
  expect(loaded.halfLifeDays).toBe(30)
  expect('showSniffed' in loaded).toBe(false)

  const updated = await updateConfig((config) => ({ ...config, halfLifeDays: 7 }))
  expect(updated.halfLifeDays).toBe(7)
  // The retired key is dropped on the way out rather than carried forever.
  expect('showSniffed' in updated).toBe(false)
  expect(loadConfig().halfLifeDays).toBe(7)
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

test('auto-reindex on open is unset by default, so the picker never reindexes on its own', () => {
  expect(DEFAULT_CONFIG.autoReindexAfterHours).toBeUndefined()
  expect(loadConfig().autoReindexAfterHours).toBeUndefined()
})

test('a configured auto-reindex age loads, including zero for every open', () => {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'config.json'), JSON.stringify({ autoReindexAfterHours: 24 }))
  expect(loadConfig().autoReindexAfterHours).toBe(24)

  writeFileSync(join(configDir(), 'config.json'), JSON.stringify({ autoReindexAfterHours: 0 }))
  expect(loadConfig().autoReindexAfterHours).toBe(0)
})

test('an invalid auto-reindex age falls back to unset rather than throwing', () => {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'config.json'), JSON.stringify({ autoReindexAfterHours: 'always' }))
  expect(loadConfig().autoReindexAfterHours).toBeUndefined()
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

test('the pair stored for a bare directory covers the directory and its children', () => {
  const c = { ...DEFAULT_CONFIG, exclude: ['/home/u/secret', '/home/u/secret/**'] }
  expect(isExcluded('/home/u/secret', c)).toBe(true)
  expect(isExcluded('/home/u/secret/project', c)).toBe(true)
  expect(isExcluded('/home/u/secretive', c)).toBe(false)
})

test('compiled exclusions are never served stale, even when the array is mutated in place', () => {
  const exclude = ['/root/secret/**']
  const c = { ...DEFAULT_CONFIG, exclude }
  expect(isExcluded('/root/secret/thing', c)).toBe(true)
  exclude[0] = '/root/other/**'
  expect(isExcluded('/root/secret/thing', c)).toBe(false)
  expect(isExcluded('/root/other/thing', c)).toBe(true)
  exclude.push('/root/secret/**')
  expect(isExcluded('/root/secret/thing', c)).toBe(true)
  exclude.length = 0
  expect(isExcluded('/root/other/thing', c)).toBe(false)
})

test('isExcluded is false for a null cwd', () => {
  const c = { ...DEFAULT_CONFIG, exclude: ['/root/**'] }
  expect(isExcluded(null, c)).toBe(false)
})

test('isExcluded is false for an empty cwd', () => {
  const c = { ...DEFAULT_CONFIG, exclude: ['**'] }
  expect(isExcluded('', c)).toBe(false)
})

test('an absent config is not a problem: defaults are what the user asked for', () => {
  const loaded = loadConfigChecked()
  expect(loaded.problem).toBeNull()
  expect(loaded.config).toEqual(DEFAULT_CONFIG)
})

test('a config that cannot be parsed is reported rather than silently replaced', () => {
  // The defaults this falls back to include an empty `exclude`, so a config
  // nobody can read broadens what gets indexed instead of narrowing it. The
  // caller has to be able to tell that apart from having no config at all.
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'config.json'), '{not json')
  const loaded = loadConfigChecked()
  expect(loaded.problem).toContain('config.json')
  expect(loaded.config).toEqual(DEFAULT_CONFIG)
})

test('an invalid privacy field is reported even when the rest of the config is fine', () => {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'config.json'), JSON.stringify({
    exclude: '/root/secret',
    halfLifeDays: 30,
  }))
  const loaded = loadConfigChecked()
  expect(loaded.problem).toContain('exclude')
  // The fields that did parse are still honoured; only the instruction that
  // was lost makes the config untrustworthy.
  expect(loaded.config.halfLifeDays).toBe(30)
  expect(loaded.config.exclude).toEqual([])
})

test('an invalid hidden client list is reported: visibility is an instruction too', () => {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'config.json'), JSON.stringify({ hiddenClients: 42 }))
  expect(loadConfigChecked().problem).toContain('hiddenClients')
})

test('an invalid tuning field is not a problem, which is what the fallback was always for', () => {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(join(configDir(), 'config.json'), JSON.stringify({
    halfLifeDays: 'fourteen',
    exclude: ['/root/secret'],
  }))
  const loaded = loadConfigChecked()
  expect(loaded.problem).toBeNull()
  expect(loaded.config.halfLifeDays).toBe(DEFAULT_CONFIG.halfLifeDays)
  expect(loaded.config.exclude).toEqual(['/root/secret'])
})

test('loadConfig still answers with a usable config in every one of those cases', () => {
  mkdirSync(configDir(), { recursive: true })
  for (const raw of ['{not json', JSON.stringify({ exclude: 42 })]) {
    writeFileSync(join(configDir(), 'config.json'), raw)
    expect(loadConfig()).toEqual(DEFAULT_CONFIG)
  }
})
