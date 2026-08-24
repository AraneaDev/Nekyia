import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/config'
import { buildAdapter } from '../src/core/adapter'
import { IndexDb } from '../src/core/db'
import { scan } from '../src/core/discover'
import { hydrateAll, orderByPriority } from '../src/core/hydrate'
import { validateManifest } from '../src/manifests/load'
import type { Adapter } from '../src/core/adapter'
import type { SessionDoc, SessionRef } from '../src/types'

const FIX = join(import.meta.dir, 'fixtures')
const claude = buildAdapter(validateManifest({
  schema: 1, id: 'claude', name: 'Claude Code', roots: [join(FIX, 'claude')],
  format: 'jsonl-transcript', tier: 'resume',
  jsonl: { glob: 'projects/*/*.jsonl', variant: 'claude' },
  resume: { cmd: 'claude', args: ['--resume', '{id}'], cwd: '{cwd}' },
}))

const r = (client: string, nativeId = 'x'): SessionRef => ({
  uid: `${client}:${nativeId}`, client, nativeId, cwd: null, gitBranch: null, title: null,
  startedAt: 0, endedAt: 0, turns: null, parentNativeId: null, tier: 'search',
  origin: 'manifest', sourcePaths: [], fingerprint: '',
})

function doc(ref: SessionRef, prompt = ref.nativeId): SessionDoc {
  return { ref, prompts: [prompt], prose: [], files: [], truncated: false }
}

function fakeAdapter(
  id: string,
  hydrate: (ref: SessionRef) => SessionDoc | Promise<SessionDoc>,
): Adapter {
  return {
    id,
    manifest: {} as Adapter['manifest'],
    detect: () => true,
    discover: async () => ({ refs: [], diagnostics: [], authoritative: true }),
    hydrate: async (ref) => hydrate(ref),
    plan: () => null,
  }
}

test('codebuff is ordered last', () => {
  const ordered = orderByPriority([r('codebuff'), r('claude'), r('agy')])
  expect(ordered.map((x) => x.client)).toEqual(['claude', 'agy', 'codebuff'])
})

test('hydrateAll writes text that is then searchable', async () => {
  const db = IndexDb.open(':memory:')
  const s = await scan(db, DEFAULT_CONFIG, [claude])
  await hydrateAll(db, DEFAULT_CONFIG, [claude], s.changed)
  expect(db.ftsSearch('reconnect').map((h) => h.uid))
    .toEqual(['claude:11111111-2222-3333-4444-555555555555'])
  db.close()
})

test('hydrateAll reports progress for every ref', async () => {
  const db = IndexDb.open(':memory:')
  const s = await scan(db, DEFAULT_CONFIG, [claude])
  const seen: number[] = []
  await hydrateAll(db, DEFAULT_CONFIG, [claude], s.changed, (p) => seen.push(p.done))
  expect(seen).toEqual([1])
  db.close()
})

test('a ref whose adapter is unknown yields a diagnostic, not a throw', async () => {
  const db = IndexDb.open(':memory:')
  const diags = await hydrateAll(db, DEFAULT_CONFIG, [claude], [r('ghost')])
  expect(diags.some((d) => d.client === 'ghost' && d.level === 'warn')).toBe(true)
  db.close()
})

test('priority ordering is stable and does not mutate its input', () => {
  const input = [r('codebuff', 'one'), r('claude'), r('agy'), r('codebuff', 'two')]
  const before = [...input]
  const ordered = orderByPriority(input)
  expect(ordered.map((ref) => ref.uid)).toEqual([
    'claude:x', 'agy:x', 'codebuff:one', 'codebuff:two',
  ])
  expect(input).toEqual(before)
  expect(ordered).not.toBe(input)
})

test('an empty queue performs no work or progress', async () => {
  const db = IndexDb.open(':memory:')
  let progress = 0
  expect(await hydrateAll(db, DEFAULT_CONFIG, [], [], () => progress++)).toEqual([])
  expect(progress).toBe(0)
  db.close()
})

test('concurrency is capped and every ref is persisted', async () => {
  const db = IndexDb.open(':memory:')
  let active = 0
  let peak = 0
  const adapter = fakeAdapter('alpha', async (ref) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 2))
    active--
    return doc(ref)
  })
  const refs = Array.from({ length: 40 }, (_, index) => r('alpha', String(index)))
  expect(await hydrateAll(db, DEFAULT_CONFIG, [adapter], refs)).toEqual([])
  expect(peak).toBeGreaterThan(1)
  expect(peak).toBeLessThanOrEqual(16)
  expect(db.allUids()).toHaveLength(40)
  db.close()
})

test('diagnostics and progress follow queue order despite completion order', async () => {
  const db = IndexDb.open(':memory:')
  const adapter = fakeAdapter('alpha', async (ref) => {
    if (ref.nativeId === 'slow-failure') {
      await new Promise((resolve) => setTimeout(resolve, 10))
      throw new Error('slow boom')
    }
    return doc(ref)
  })
  const progress: Array<[number, string]> = []
  const diagnostics = await hydrateAll(db, DEFAULT_CONFIG, [adapter], [
    r('alpha', 'slow-failure'),
    r('ghost'),
    r('alpha', 'okay'),
  ], ({ done, client }) => progress.push([done, client]))

  expect(progress).toEqual([[1, 'alpha'], [2, 'ghost'], [3, 'alpha']])
  expect(diagnostics.map((diagnostic) => diagnostic.client)).toEqual(['alpha', 'ghost'])
  expect(db.getRef('alpha:okay')?.uid).toBe('alpha:okay')
  db.close()
})

test('database and progress callback failures are isolated', async () => {
  const db = IndexDb.open(':memory:')
  const originalUpsertHydrated = db.upsertHydrated.bind(db)
  db.upsertHydrated = (value) => {
    if (value.ref.nativeId === 'db-failure') throw new Error('db boom')
    originalUpsertHydrated(value)
  }
  const adapter = fakeAdapter('alpha', (ref) => doc(ref, `search-${ref.nativeId}`))
  const seen: number[] = []
  const diagnostics = await hydrateAll(db, DEFAULT_CONFIG, [adapter], [
    r('alpha', 'db-failure'),
    r('alpha', 'callback-failure'),
    r('alpha', 'survivor'),
  ], (progress) => {
    seen.push(progress.done)
    if (progress.done === 2) throw new Error('callback boom')
  })

  expect(seen).toEqual([1, 2, 3])
  expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
    'hydrate failed: db boom',
    'progress callback failed: callback boom',
  ])
  expect(db.ftsSearch('survivor').map((hit) => hit.uid)).toEqual(['alpha:survivor'])
  db.close()
})

test('hydrateAll shields caller refs from adapter mutation', async () => {
  const db = IndexDb.open(':memory:')
  const input = r('alpha')
  input.sourcePaths = ['/original']
  const adapter = fakeAdapter('alpha', (received) => {
    received.title = 'mutated'
    received.sourcePaths.push('/added')
    return doc(received)
  })
  await hydrateAll(db, DEFAULT_CONFIG, [adapter], [input])
  expect(input.title).toBeNull()
  expect(input.sourcePaths).toEqual(['/original'])
  db.close()
})

test('a failed document write keeps the old fingerprint and remains retryable', async () => {
  const db = IndexDb.open(':memory:')
  const oldRef = { ...r('alpha'), fingerprint: 'old-fingerprint', title: 'Old title' }
  db.upsertRef(oldRef)
  db.upsertDoc(doc(oldRef, 'oldsearchableprompt'))
  const changedRef = { ...oldRef, fingerprint: 'new-fingerprint', title: 'New title' }
  const adapter = fakeAdapter('alpha', (ref) => doc(ref, 'newfailingprompt'))
  adapter.discover = async () => ({
    refs: [changedRef], diagnostics: [], authoritative: true,
  })
  db.raw().exec(`CREATE TRIGGER fail_hydrated_doc BEFORE INSERT ON session_text
    WHEN NEW.prompts LIKE '%newfailing%' BEGIN SELECT RAISE(FAIL, 'doc write failed'); END`)

  const diagnostics = await hydrateAll(db, DEFAULT_CONFIG, [adapter], [changedRef])

  expect(diagnostics.map((diagnostic) => diagnostic.message))
    .toEqual(['hydrate failed: doc write failed'])
  expect(db.getRef(changedRef.uid)?.fingerprint).toBe('old-fingerprint')
  expect(db.getRef(changedRef.uid)?.title).toBe('Old title')
  expect(db.ftsSearch('oldsearchableprompt').map((hit) => hit.uid)).toEqual([oldRef.uid])
  expect(db.ftsSearch('newfailingprompt')).toEqual([])
  expect((await scan(db, DEFAULT_CONFIG, [adapter])).changed).toEqual([changedRef])
  db.close()
})

test('codebuff hydration starts only after all other clients settle', async () => {
  const db = IndexDb.open(':memory:')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let ordinaryStarted = false
  let codebuffStarted = false
  const ordinary = fakeAdapter('alpha', async (ref) => {
    ordinaryStarted = true
    await gate
    return doc(ref)
  })
  const codebuff = fakeAdapter('codebuff', (ref) => {
    codebuffStarted = true
    return doc(ref)
  })

  const running = hydrateAll(db, DEFAULT_CONFIG, [ordinary, codebuff], [
    r('codebuff'), r('alpha'),
  ])
  await Promise.resolve()
  expect(ordinaryStarted).toBeTrue()
  expect(codebuffStarted).toBeFalse()
  release()
  await running
  expect(codebuffStarted).toBeTrue()
  db.close()
})
