import { expect, test } from 'bun:test'
import { buildBrief } from '../src/core/brief'
import { IndexDb } from '../src/core/db'
import type { SessionRef } from '../src/types'

function seed(
  db: IndexDb,
  prompts: string[],
  prose: string[],
  files: string[] = [],
  over: Partial<SessionRef> = {},
) {
  const ref: SessionRef = {
    uid: 'claude:a', client: 'claude', nativeId: 'a', cwd: '/root/proj', gitBranch: 'main',
    title: 'Fix the SSE reconnect race', startedAt: 1_800_000_000_000,
    endedAt: 1_800_003_600_000, turns: 4, parentNativeId: null, tier: 'resume',
    origin: 'manifest', sourcePaths: ['/x'], fingerprint: 'f', ...over,
  }
  db.upsertRef(ref)
  db.upsertDoc({ ref, prompts, prose, files, truncated: false })
}

test('the brief carries title, directory, branch, files and every prompt', () => {
  const db = IndexDb.open(':memory:')
  seed(db, ['fix the sse reconnect', 'now add a test'], ['I guarded the subscribe call'], ['src/sse.ts'])
  const brief = buildBrief(db, 'claude:a')!
  expect(brief).toContain('Fix the SSE reconnect race')
  expect(brief).toContain('/root/proj')
  expect(brief).toContain('main')
  expect(brief).toContain('fix the sse reconnect')
  expect(brief).toContain('now add a test')
  expect(brief).toContain('src/sse.ts')
  db.close()
})

test('the budget drops the oldest prose first and keeps every prompt', () => {
  const db = IndexDb.open(':memory:')
  seed(db, ['keep me'], ['OLDEST'.repeat(200), 'NEWEST'.repeat(80)])
  const brief = buildBrief(db, 'claude:a', { maxChars: 900 })!
  expect(brief).toContain('keep me')
  expect(brief).toContain('NEWEST')
  expect(brief).not.toContain('OLDEST')
  expect(brief.length).toBeLessThanOrEqual(900)
  db.close()
})

test('an unknown or unhydrated uid returns null rather than throwing', () => {
  const db = IndexDb.open(':memory:')
  expect(buildBrief(db, 'claude:nope')).toBeNull()
  const ref: SessionRef = {
    uid: 'claude:bare', client: 'claude', nativeId: 'bare', cwd: null, gitBranch: null,
    title: null, startedAt: 0, endedAt: 0, turns: null, parentNativeId: null,
    tier: 'resume', origin: 'manifest', sourcePaths: ['/x'], fingerprint: 'f',
  }
  db.upsertRef(ref)
  expect(buildBrief(db, ref.uid)).toBeNull()
  db.close()
})

test('the brief says plainly that it is a handover, not a resume', () => {
  const db = IndexDb.open(':memory:')
  seed(db, ['a'], [])
  const brief = buildBrief(db, 'claude:a')!.toLowerCase()
  expect(brief).toContain('previous session')
  expect(brief).toContain('not a resumed session')
  db.close()
})

test('tiny budgets preserve all user prompts instead of splitting or silently losing them', () => {
  const db = IndexDb.open(':memory:')
  const prompt = 'keep this emoji 🧪 and the rest of this prompt'
  seed(db, [prompt], ['discard me'])
  const brief = buildBrief(db, 'claude:a', { maxChars: 1 })!
  expect(brief).toContain(prompt)
  expect(brief).toContain('could not be met without dropping user prompts')
  expect(brief).not.toContain('discard me')
  expect(brief).not.toContain('�')
  db.close()
})

test('invalid core budgets fail explicitly and zero is a valid tiny budget', () => {
  const db = IndexDb.open(':memory:')
  seed(db, ['keep'], [])
  for (const maxChars of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    expect(() => buildBrief(db, 'claude:a', { maxChars })).toThrow('maxChars')
  }
  expect(buildBrief(db, 'claude:a', { maxChars: 0 })).toContain('keep')
  db.close()
})

test('files have stable order and a deterministic forty-item limit', () => {
  const db = IndexDb.open(':memory:')
  const files = Array.from({ length: 45 }, (_, index) => `src/${String(44 - index).padStart(2, '0')}.ts`)
  seed(db, ['keep'], [], files)
  const brief = buildBrief(db, 'claude:a')!
  expect(brief).toContain('src/00.ts')
  expect(brief).toContain('src/39.ts')
  expect(brief).not.toContain('src/40.ts')
  expect(brief.indexOf('src/00.ts')).toBeLessThan(brief.indexOf('src/01.ts'))
  db.close()
})

test('invalid timestamps and terminal controls are rendered safely', () => {
  const db = IndexDb.open(':memory:')
  seed(db, ['prompt\u001b[2J\rreturn'], [], [], { endedAt: 8_640_000_000_000_001, title: 'title\n## injected' })
  const brief = buildBrief(db, 'claude:a')!
  expect(brief).toContain('- Ended: (unknown)')
  expect(brief).not.toContain('\u001b')
  expect(brief).not.toContain('\r')
  expect(brief).not.toContain('Title: title\n## injected')
  db.close()
})

test('a missing source remains available as an explicitly stale indexed handover', () => {
  const db = IndexDb.open(':memory:')
  seed(db, ['keep'], [])
  db.markMissing(['claude:a'])
  const brief = buildBrief(db, 'claude:a')!
  expect(brief).toContain('source is currently unavailable')
  expect(brief).toContain('keep')
  db.close()
})

test('large prose trimming uses a bounded number of renders', () => {
  const db = IndexDb.open(':memory:')
  const prose = Array.from({ length: 20_000 }, (_, index) => `line-${String(index).padStart(5, '0')}`)
  seed(db, ['keep this prompt'], prose)

  const originalJoin = Array.prototype.join
  let joins = 0
  Array.prototype.join = function (...args: Parameters<typeof originalJoin>) {
    joins++
    return originalJoin.apply(this, args)
  }
  try {
    const brief = buildBrief(db, 'claude:a', { maxChars: 500 })!
    expect(brief).toContain('keep this prompt')
    expect(brief).toContain('line-19999')
    expect(brief).not.toContain('line-00000')
    expect(brief.length).toBeLessThanOrEqual(500)
  } finally {
    Array.prototype.join = originalJoin
    db.close()
  }
  expect(joins).toBeLessThanOrEqual(8)
})
