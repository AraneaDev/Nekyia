import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import Database from 'bun:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  askConsent,
  describePlan,
  needsConsent,
  readConsentLine,
} from '../src/commands/firstrun'
import { runReindex } from '../src/commands/reindex'
import { runPick } from '../src/commands/pick'
import { runSearch } from '../src/commands/search'
import { runShow } from '../src/commands/show'
import type { Adapter } from '../src/core/adapter'
import type { IndexDb } from '../src/core/db'
import { IndexDb as RealIndexDb } from '../src/core/db'
import type { SessionRef } from '../src/types'

let tmp: string
const saved = { ...process.env }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nekyia-fr-'))
  process.env.XDG_DATA_HOME = join(tmp, 'data')
})

afterEach(() => {
  process.env = { ...saved }
  rmSync(tmp, { recursive: true, force: true })
})

function adapter(overrides: Partial<Adapter> & { id: string; roots?: string[] }): Adapter {
  const ref: SessionRef = {
    uid: `${overrides.id}:secret-native-id`, client: overrides.id,
    nativeId: 'secret-native-id', cwd: '/private/project', gitBranch: null,
    title: 'secret prompt title', startedAt: 1, endedAt: 2, turns: 1,
    parentNativeId: null, tier: 'search', origin: 'manifest',
    sourcePaths: ['/private/transcript.jsonl'], fingerprint: 'secret-fingerprint',
  }
  return {
    manifest: { roots: overrides.roots ?? [tmp] } as Adapter['manifest'],
    detect: () => true,
    discover: async () => ({ refs: [ref], diagnostics: [], authoritative: true }),
    hydrate: async () => ({ ref, prompts: [], prose: [], files: [], truncated: false }),
    plan: () => null,
    ...overrides,
  }
}

test('consent requires an exact regular versioned marker, not an index file', () => {
  const path = join(process.env.XDG_DATA_HOME!, 'nekyia', 'index.db')
  expect(needsConsent()).toBe(true)
  mkdirSync(join(process.env.XDG_DATA_HOME!, 'nekyia'), { recursive: true })
  writeFileSync(path, '')
  expect(needsConsent()).toBe(true)

  const marker = join(process.env.XDG_DATA_HOME!, 'nekyia', 'consent-v1')
  writeFileSync(marker, 'foreign\n')
  expect(needsConsent()).toBe(true)
  writeFileSync(marker, 'nekyia-index-consent-v1\n')
  chmodSync(marker, 0o600)
  expect(needsConsent()).toBe(false)

  for (const mode of [0o644, 0o400, 0o660]) {
    chmodSync(marker, mode)
    expect(needsConsent()).toBe(true)
  }
  chmodSync(marker, 0o600)
  expect(needsConsent()).toBe(false)

  const target = join(tmp, 'elsewhere-marker')
  writeFileSync(target, 'nekyia-index-consent-v1\n')
  rmSync(marker)
  symlinkSync(target, marker)
  expect(needsConsent()).toBe(true)
})

test('describePlan is metadata-only, stable, sanitized, and reveals no ref content', async () => {
  const rootB = join(tmp, 'b\nroot')
  const rootA = join(tmp, 'a-root')
  mkdirSync(rootB)
  mkdirSync(rootA)
  let discoverCalls = 0
  const badDetect = adapter({ id: 'bad-detect', roots: [join(tmp, 'absent')], detect: () => {
    throw new Error('must not call detect')
  } })
  const badDiscover = adapter({ id: 'z\u001b[2J-client', roots: [rootB], discover: async () => {
    discoverCalls++
    throw new Error('must not read transcripts')
  } })
  const partial = adapter({
    id: 'a-client', roots: [rootB, rootA, join(tmp, 'absent')],
    discover: async () => ({
      refs: [], authoritative: false,
      diagnostics: [{ client: 'a-client', level: 'error', path: '/private', message: 'private' }],
    }),
  })

  const plan = await describePlan([badDiscover, badDetect, partial])
  expect(plan.map((row) => row.client)).toEqual(['a-client', 'z [2J-client'])
  expect(plan[0]!.roots).toEqual([rootA, rootB.replace('\n', ' ')])
  expect(plan[0]!.estimate).not.toBeUndefined()
  expect(plan[1]!.sessions).toBeNull()
  expect(discoverCalls).toBe(0)
  const serialized = JSON.stringify(plan)
  expect(serialized).not.toContain('secret-native-id')
  expect(serialized).not.toContain('secret prompt')
  expect(serialized).not.toContain('private/transcript')
})

test('metadata planning never calls Bun.file or opens sidecars/transcript heads', async () => {
  const root = join(tmp, 'jsonl')
  mkdirSync(join(root, 'projects', 'p'), { recursive: true })
  writeFileSync(join(root, 'projects', 'p', 'one.jsonl'), 'private prompt')
  writeFileSync(join(root, 'history.jsonl'), 'private sidecar')
  let discoverCalls = 0
  const planned = adapter({
    id: 'claude', roots: [root],
    manifest: {
      roots: [root], format: 'jsonl-transcript',
      jsonl: { glob: 'projects/*/*.jsonl', variant: 'claude' },
      sidecar: { file: 'history.jsonl' },
    } as Adapter['manifest'],
    discover: async () => { discoverCalls++; throw new Error('must not run') },
  })
  const original = Bun.file
  let bunFileCalls = 0
  Bun.file = ((...args: Parameters<typeof Bun.file>) => {
    bunFileCalls++
    return original(...args)
  }) as typeof Bun.file
  try {
    const plan = await describePlan([planned])
    expect(plan[0]!.sessions).toBe(1)
    expect(plan[0]!.estimate).toBe('estimated')
  } finally {
    Bun.file = original
  }
  expect(discoverCalls).toBe(0)
  expect(bunFileCalls).toBe(0)
})

test('describePlan bounds hostile client and root values before display', async () => {
  const hugeClient = `client-${'x'.repeat(20_000)}`
  const hugeRoot = `/${'y'.repeat(20_000)}`
  const plan = await describePlan([adapter({ id: hugeClient, roots: [tmp] })])
  expect(plan[0]!.client.length).toBeLessThanOrEqual(80)
  expect(await describePlan([adapter({ id: 'huge-root', roots: [hugeRoot] })])).toEqual([])
})

test('sqlite planning uses a read-only metadata COUNT and marks partial totals', async () => {
  const good = join(tmp, 'sqlite-good')
  const bad = join(tmp, 'sqlite-bad')
  mkdirSync(good)
  mkdirSync(bad)
  const db = new Database(join(good, 'sessions.db'))
  db.exec('CREATE TABLE session (id TEXT); INSERT INTO session VALUES (\'a\'), (\'b\')')
  db.close()
  writeFileSync(join(bad, 'sessions.db'), 'not sqlite')
  const manifest = {
    roots: [good, bad], format: 'sqlite-store',
    sqlite: {
      file: 'sessions.db', sessions: 'SELECT id FROM session',
      text: 'SELECT secret_prompt FROM transcript',
    },
  } as Adapter['manifest']
  const plan = await describePlan([adapter({ id: 'sqlite', manifest })])
  expect(plan[0]!.sessions).toBe(2)
  expect(plan[0]!.estimate).toBe('at-least')
  const output: string[] = []
  await askConsent([adapter({ id: 'sqlite', manifest })], {
    yes: true, write: (text) => { output.push(text) },
  })
  expect(output.join('')).toContain('at least 2')
})

test('askConsent reports to stderr, --yes bypasses input, and empty plans work', async () => {
  const output: string[] = []
  let reads = 0
  expect(await askConsent([], {
    yes: true,
    write: (text) => { output.push(text) },
    readLine: async () => { reads++; return 'no' },
  })).toBe(true)
  expect(reads).toBe(0)
  expect(output.join('')).toContain('0 sessions total')
  expect(output.join('')).toContain('indexing does not make network calls')
  expect(output.join('')).toContain('Nothing leaves this machine')
  expect(output.join('')).toContain('no API key')
})

test('the default line reader is bounded, chunk-aware, and leaves input reusable', async () => {
  const input = new PassThrough()
  const answer = readConsentLine(input)
  input.write(' Y')
  input.write('ES\nnext')
  expect(await answer).toBe(' YES')
  expect(input.destroyed).toBe(false)
  expect(input.listenerCount('data')).toBe(0)

  const huge = new PassThrough()
  const rejected = readConsentLine(huge)
  huge.write('x'.repeat(300))
  expect(await rejected).toBeNull()
  expect(huge.destroyed).toBe(false)
  expect(huge.listenerCount('data')).toBe(0)

  class StringInput extends EventEmitter {
    destroyed = false
    readableEnded = false
    isPaused() { return true }
    pause() { return this }
  }
  const stringInput = new StringInput()
  const oversizedString = readConsentLine(stringInput)
  stringInput.emit('data', 'é'.repeat(1_000_000))
  expect(await oversizedString).toBeNull()
  expect(stringInput.destroyed).toBe(false)
  expect(stringInput.listenerCount('data')).toBe(0)

  const utf8 = new StringInput()
  const split = readConsentLine(utf8)
  const encoded = Buffer.from('yé\n')
  utf8.emit('data', encoded.subarray(0, 2))
  utf8.emit('data', encoded.subarray(2))
  expect(await split).toBe('yé')
})

test('askConsent accepts yes case-insensitively and declines no, EOF, and non-TTY', async () => {
  for (const answer of [' y ', 'YES\r\n', 'YeS']) {
    expect(await askConsent([], {
      isTTY: () => true, write: () => {}, readLine: async () => answer,
    })).toBe(true)
  }
  for (const answer of ['n', 'anything', '', null]) {
    expect(await askConsent([], {
      isTTY: () => true, write: () => {}, readLine: async () => answer,
    })).toBe(false)
  }
  let read = false
  const output: string[] = []
  expect(await askConsent([], {
    isTTY: () => false,
    write: (text) => { output.push(text) },
    readLine: async () => { read = true; return 'yes' },
  })).toBe(false)
  expect(read).toBe(false)
  expect(output.join('')).toContain('Re-run with --yes')
})

test('declining first-run indexing creates no data files', async () => {
  const path = join(process.env.XDG_DATA_HOME!, 'nekyia', 'index.db')
  expect(await runReindex({
    consent: async () => false,
    adapterSet: { adapters: [], diagnostics: [] },
    quiet: true,
  })).toBe(1)
  expect(existsSync(path)).toBe(false)
  expect(existsSync(join(process.env.XDG_DATA_HOME!, 'nekyia'))).toBe(false)
})

test('a cold explicit --rebuild records authorization without prompting', async () => {
  let asked = 0
  expect(await runReindex({
    rebuild: true,
    consent: async () => { asked++; return false },
    adapterSet: { adapters: [], diagnostics: [] },
    quiet: true,
  })).toBe(0)
  expect(asked).toBe(0)
  expect(needsConsent()).toBe(false)
})

test('marker write failure returns before database creation', async () => {
  const data = join(process.env.XDG_DATA_HOME!, 'nekyia')
  const target = join(tmp, 'linked-data')
  mkdirSync(target)
  mkdirSync(process.env.XDG_DATA_HOME!, { recursive: true })
  symlinkSync(target, data)
  expect(await runReindex({
    yes: true, adapterSet: { adapters: [], diagnostics: [] }, quiet: true,
  })).toBe(1)
  expect(existsSync(join(target, 'index.db'))).toBe(false)
})

test('a symlinked Nekyia data directory cannot import consent or write outside', async () => {
  const dataHome = process.env.XDG_DATA_HOME!
  const outside = join(tmp, 'outside-data')
  mkdirSync(dataHome, { recursive: true })
  mkdirSync(outside)
  const outsideMarker = join(outside, 'consent-v1')
  const outsideIndex = join(outside, 'index.db')
  writeFileSync(outsideMarker, 'nekyia-index-consent-v1\n')
  writeFileSync(outsideIndex, 'foreign index')
  symlinkSync(outside, join(dataHome, 'nekyia'))

  expect(needsConsent()).toBe(true)
  for (const options of [
    {},
    { yes: true },
    { rebuild: true },
  ]) {
    expect(await runReindex({
      ...options,
      adapterSet: { adapters: [], diagnostics: [] },
      quiet: true,
    })).toBe(1)
  }
  expect(Bun.file(outsideMarker).text()).resolves.toBe('nekyia-index-consent-v1\n')
  expect(Bun.file(outsideIndex).text()).resolves.toBe('foreign index')
  expect(() => RealIndexDb.open(join(dataHome, 'nekyia', 'index.db'), false)).toThrow()
  await expect(runSearch({ text: 'anything' })).rejects.toThrow()
  await expect(runShow({ uid: 'claude:anything' })).rejects.toThrow()
  expect(await runPick({
    isTTY: () => true,
    ensureIndex: () => runReindex({
      adapterSet: { adapters: [], diagnostics: [] }, quiet: true,
    }),
    error: () => {},
  })).toBe(1)
})

test('a valid prior marker authorizes rebuilding a deleted index without prompting', async () => {
  const options = { adapterSet: { adapters: [], diagnostics: [] }, quiet: true }
  expect(await runReindex({ ...options, yes: true })).toBe(0)
  rmSync(join(process.env.XDG_DATA_HOME!, 'nekyia', 'index.db'))
  let asked = false
  expect(await runReindex({
    ...options, consent: async () => { asked = true; return false },
  })).toBe(0)
  expect(asked).toBe(false)
})

test('decline is unconditional even if a concurrent process creates an index and marker', async () => {
  const path = join(process.env.XDG_DATA_HOME!, 'nekyia', 'index.db')
  let consentCalls = 0
  const code = await runReindex({
    consent: async () => {
      consentCalls++
      const { IndexDb } = await import('../src/core/db')
      const { recordConsent } = await import('../src/commands/firstrun')
      recordConsent()
      const db = IndexDb.open(path)
      db.close()
      return false
    },
    adapterSet: { adapters: [], diagnostics: [] },
    quiet: true,
  })
  expect(code).toBe(1)
  expect(consentCalls).toBe(1)
  expect(existsSync(path)).toBe(true)
  expect(needsConsent()).toBe(false)
})

test('affirmative consent writes a private marker before opening the database', async () => {
  const marker = join(process.env.XDG_DATA_HOME!, 'nekyia', 'consent-v1')
  const code = await runReindex({
    consent: async () => true,
    adapterSet: { adapters: [], diagnostics: [] },
    quiet: true,
  })
  expect(code).toBe(0)
  expect(needsConsent()).toBe(false)
  expect((await import('node:fs')).statSync(marker).mode & 0o777).toBe(0o600)
})

test('recordConsent enforces 0600 under a hostile umask without changing this process', () => {
  const childData = join(tmp, 'umask-data')
  const moduleUrl = new URL('../src/commands/firstrun.ts', import.meta.url).href
  const script = [
    'process.umask(0o777)',
    `const m = await import(${JSON.stringify(moduleUrl)})`,
    'm.recordConsent()',
    "const fs = await import('node:fs')",
    "const path = await import('node:path')",
    "const dir = path.join(process.env.XDG_DATA_HOME, 'nekyia')",
    "console.log(String(m.needsConsent()), (fs.statSync(dir).mode & 0o777).toString(8), (fs.statSync(path.join(dir, 'consent-v1')).mode & 0o777).toString(8), process.umask().toString(8))",
  ].join('; ')
  const child = Bun.spawnSync([process.execPath, '--eval', script], {
    env: { ...process.env, XDG_DATA_HOME: childData },
    stdout: 'pipe', stderr: 'pipe',
  })
  expect(child.exitCode).toBe(0)
  expect(child.stdout.toString().trim()).toBe('false 700 600 777')
})

test('failed full discovery returns nonzero after consent without hiding the marker', async () => {
  const broken = adapter({
    id: 'broken', roots: [tmp],
    discover: async () => { throw new Error('transient discovery failure') },
  })
  expect(await runReindex({
    consent: async () => true,
    adapterSet: { adapters: [broken], diagnostics: [] },
    quiet: true,
  })).toBe(1)
  expect(needsConsent()).toBe(false)
  expect(existsSync(join(process.env.XDG_DATA_HOME!, 'nekyia', 'index.db'))).toBe(true)
})

test('adapter construction errors fail before consent and before database creation', async () => {
  let asked = false
  const code = await runReindex({
    consent: async () => { asked = true; return true },
    adapterSet: {
      adapters: [],
      diagnostics: [{ client: 'broken', level: 'error', path: null, message: 'bad manifest' }],
    },
    quiet: true,
  })
  expect(code).toBe(1)
  expect(asked).toBe(false)
  expect(needsConsent()).toBe(true)
})

test('an obstructing symlink is never opened as an index even after yes', async () => {
  const path = join(process.env.XDG_DATA_HOME!, 'nekyia', 'index.db')
  const target = join(tmp, 'target.db')
  mkdirSync(join(process.env.XDG_DATA_HOME!, 'nekyia'), { recursive: true })
  writeFileSync(target, 'do not overwrite')
  symlinkSync(target, path)
  expect(await runReindex({
    yes: true, adapterSet: { adapters: [], diagnostics: [] }, quiet: true,
  })).toBe(1)
  expect(Bun.file(target).text()).resolves.toBe('do not overwrite')
})

test('the bare picker builds on first run and then continues into Ink', async () => {
  const events: string[] = []
  let exists = false
  const db = { close: () => { events.push('close') } } as unknown as IndexDb
  const code = await runPick({
    isTTY: () => true,
    needsConsent: () => !exists,
    indexPath: () => '/index.db',
    indexExists: () => exists,
    ensureIndex: async () => { events.push('index'); exists = true; return 0 },
    openDb: () => db,
    mount: () => ({
      waitUntilExit: async () => { events.push('pick') },
      unmount: () => { events.push('unmount') },
    }),
    error: (message) => { throw new Error(message) },
  })
  expect(code).toBe(0)
  expect(events).toEqual(['index', 'pick', 'unmount', 'close'])
})

test('the bare picker continues when first-run indexing produced a partial index', async () => {
  const events: string[] = []
  const messages: string[] = []
  let exists = false
  let consentNeeded = true
  const db = { close: () => { events.push('close') } } as unknown as IndexDb
  const code = await runPick({
    isTTY: () => true,
    needsConsent: () => consentNeeded,
    indexPath: () => '/index.db',
    indexExists: () => exists,
    ensureIndex: async () => {
      events.push('index')
      exists = true
      consentNeeded = false
      return 1
    },
    openDb: () => db,
    mount: () => ({
      waitUntilExit: async () => { events.push('pick') },
      unmount: () => { events.push('unmount') },
    }),
    error: (message) => { messages.push(message) },
  })
  expect(code).toBe(0)
  expect(events).toEqual(['index', 'pick', 'unmount', 'close'])
  expect(messages).toEqual(['indexing completed with errors; continuing with the available sessions'])
})

test('a non-TTY picker refuses before attempting first-run indexing', async () => {
  let indexed = false
  expect(await runPick({
    isTTY: () => false,
    needsConsent: () => true,
    indexExists: () => false,
    ensureIndex: async () => { indexed = true; return 0 },
    error: () => {},
  })).toBe(1)
  expect(indexed).toBe(false)
})

test('picker gates on consent even when an index file already exists', async () => {
  let consentNeeded = true
  let ensured = 0
  const db = { close: () => {} } as unknown as IndexDb
  expect(await runPick({
    isTTY: () => true,
    needsConsent: () => consentNeeded,
    indexExists: () => true,
    ensureIndex: async () => { ensured++; consentNeeded = false; return 0 },
    openDb: () => db,
    mount: () => ({ waitUntilExit: async () => {}, unmount: () => {} }),
    error: (message) => { throw new Error(message) },
  })).toBe(0)
  expect(ensured).toBe(1)
})
