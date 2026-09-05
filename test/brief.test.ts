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
  lost: { truncated?: boolean; degraded?: boolean } = {},
) {
  const ref: SessionRef = {
    uid: 'claude:a', client: 'claude', nativeId: 'a', cwd: '/root/proj', gitBranch: 'main',
    title: 'Fix the SSE reconnect race', startedAt: 1_800_000_000_000,
    endedAt: 1_800_003_600_000, turns: 4, parentNativeId: null, tier: 'resume',
    origin: 'manifest', sourcePaths: ['/x'], fingerprint: 'f', ...over,
  }
  db.upsertRef(ref)
  db.upsertDoc({
    ref,
    prompts,
    prose,
    files,
    truncated: lost.truncated ?? false,
    degraded: lost.degraded ?? false,
  })
}

const SIZE_CAPPED_LINE = 'Part of this session was too large to index, so some replies are missing from this handover.'
const DEGRADED_LINE = 'Part of this session could not be read from its source, so some of it is missing from this handover.'

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

test('a file list cut by the forty-item cap says so without inventing a total', () => {
  const db = IndexDb.open(':memory:')
  const files = Array.from({ length: 60 }, (_, index) => `src/${String(index).padStart(2, '0')}.ts`)
  seed(db, ['keep'], [], files)
  const brief = buildBrief(db, 'claude:a')!
  expect((brief.match(/^- src\//gm) ?? []).length).toBe(40)
  expect(brief).toContain('- (more files omitted)')
  // Past the cap the real total is unknown, so no count may be claimed.
  expect(brief).not.toMatch(/- \(\d+ more files? omitted\)/)
  db.close()
})

test('a budget that trims the file list counts what it left out', () => {
  const db = IndexDb.open(':memory:')
  const files = Array.from({ length: 12 }, (_, index) => `src/${String(index).padStart(2, '0')}.ts`)
  seed(db, ['keep'], [], files)
  const budget = buildBrief(db, 'claude:a')!.length - 40
  const brief = buildBrief(db, 'claude:a', { maxChars: budget })!
  const listed = (brief.match(/^- src\//gm) ?? []).length
  expect(listed).toBeGreaterThan(0)
  expect(listed).toBeLessThan(files.length)
  expect(brief).toContain(`- (${files.length - listed} more files omitted)`)
  expect(brief.length).toBeLessThanOrEqual(budget)
  db.close()
})

test('a session tail dropped by the budget is announced rather than vanishing', () => {
  const db = IndexDb.open(':memory:')
  const files = Array.from({ length: 60 }, (_, index) => `src/${String(index).padStart(2, '0')}.ts`)
  seed(db, ['keep this prompt'], ['I left the reconnect guard half written'], files)
  const brief = buildBrief(db, 'claude:a', { maxChars: 500 })!
  expect(brief).not.toContain('## Where it ended')
  expect(brief).not.toContain('half written')
  expect(brief).toContain('The end of the session was omitted to fit the character budget.')
  expect(brief).toContain('- (more files omitted)')
  expect(brief.length).toBeLessThanOrEqual(500)
  db.close()
})

test('markers are budgeted like entries, so nothing is exceeded or quietly under-reported', () => {
  const db = IndexDb.open(':memory:')
  const files = Array.from({ length: 60 }, (_, index) => `src/${String(index).padStart(2, '0')}.ts`)
  seed(db, ['keep this prompt'], ['the closing state'], files)
  const notice = 'The end of the session was omitted to fit the character budget.'
  const broken: string[] = []
  for (let budget = 0; budget <= 1000; budget++) {
    const brief = buildBrief(db, 'claude:a', { maxChars: budget })!
    if (!brief.includes('keep this prompt')) broken.push(`${budget}: lost a prompt`)
    // Retaining every prompt is the one licence to run past the budget.
    if (brief.includes('could not be met without dropping user prompts')) continue
    if (brief.length > budget) broken.push(`${budget}: ran to ${brief.length}`)
    if (brief.includes('## Files touched') && !brief.includes('(more files omitted)')) {
      broken.push(`${budget}: shortened the file list in silence`)
    }
    // Silence about the tail is allowed only when the notice itself cannot fit.
    if (!brief.includes('## Where it ended') && !brief.includes(notice)
      && brief.length + 2 + notice.length <= budget) {
      broken.push(`${budget}: dropped the tail in silence`)
    }
  }
  expect(broken).toEqual([])
  db.close()
})

test('a marker is dropped rather than pushing the brief one character over', () => {
  const db = IndexDb.open(':memory:')
  const files = Array.from({ length: 60 }, (_, index) => `src/${String(index).padStart(2, '0')}.ts`)
  seed(db, ['keep'], ['closing state'], files)

  let fits = 0
  while (buildBrief(db, 'claude:a', { maxChars: fits })!.includes('could not be met')) fits++
  // The smallest budget the mandatory body fits is its own length exactly.
  expect(buildBrief(db, 'claude:a', { maxChars: fits })!.length).toBe(fits)

  let admits = fits
  while (!buildBrief(db, 'claude:a', { maxChars: admits })!.includes('## Files touched')) admits++
  const short = buildBrief(db, 'claude:a', { maxChars: admits - 1 })!
  expect(short).not.toContain('## Files touched')
  expect(short.length).toBeLessThanOrEqual(admits - 1)
  const exact = buildBrief(db, 'claude:a', { maxChars: admits })!
  expect(exact).toContain('- (more files omitted)')
  expect(exact.length).toBeLessThanOrEqual(admits)

  // The over-budget escape hatch still declares what it left out.
  const zero = buildBrief(db, 'claude:a', { maxChars: 0 })!
  expect(zero).toContain('could not be met without dropping user prompts')
  expect(zero).toContain('- (more files omitted)')
  expect(zero).toContain('The end of the session was omitted')
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

test('a complete session claims no gaps it does not have', () => {
  const db = IndexDb.open(':memory:')
  seed(db, ['keep'], ['closing state'])
  const brief = buildBrief(db, 'claude:a')!
  expect(brief).not.toContain(SIZE_CAPPED_LINE)
  expect(brief).not.toContain(DEGRADED_LINE)
  db.close()
})

test('a size cap and an unreadable source are disclosed, each in its own words', () => {
  const capped = IndexDb.open(':memory:')
  seed(capped, ['keep'], ['closing state'], [], {}, { truncated: true })
  const cappedBrief = buildBrief(capped, 'claude:a')!
  expect(cappedBrief).toContain(SIZE_CAPPED_LINE)
  expect(cappedBrief).not.toContain(DEGRADED_LINE)
  capped.close()

  const unreadable = IndexDb.open(':memory:')
  seed(unreadable, ['keep'], ['closing state'], [], {}, { degraded: true })
  const unreadableBrief = buildBrief(unreadable, 'claude:a')!
  expect(unreadableBrief).toContain(DEGRADED_LINE)
  expect(unreadableBrief).not.toContain(SIZE_CAPPED_LINE)
  unreadable.close()

  const both = IndexDb.open(':memory:')
  seed(both, ['keep'], ['closing state'], [], {}, { truncated: true, degraded: true })
  const bothBrief = buildBrief(both, 'claude:a')!
  expect(bothBrief).toContain(SIZE_CAPPED_LINE)
  expect(bothBrief).toContain(DEGRADED_LINE)
  both.close()
})

test('what indexing lost is stated at every budget, and never at the cost of the bound', () => {
  const db = IndexDb.open(':memory:')
  const files = Array.from({ length: 60 }, (_, index) => `src/${String(index).padStart(2, '0')}.ts`)
  seed(db, ['keep this prompt'], ['the closing state'], files, {}, {
    truncated: true,
    degraded: true,
  })
  const broken: string[] = []
  for (let budget = 0; budget <= 1000; budget++) {
    const brief = buildBrief(db, 'claude:a', { maxChars: budget })!
    // Both notices sit in the mandatory body, so no budget may drop either.
    if (!brief.includes(SIZE_CAPPED_LINE)) broken.push(`${budget}: hid the size cap`)
    if (!brief.includes(DEGRADED_LINE)) broken.push(`${budget}: hid the unreadable source`)
    if (!brief.includes('keep this prompt')) broken.push(`${budget}: lost a prompt`)
    // Retaining every prompt is the one licence to run past the budget.
    if (brief.includes('could not be met without dropping user prompts')) continue
    if (brief.length > budget) broken.push(`${budget}: ran to ${brief.length}`)
  }
  expect(broken).toEqual([])
  db.close()
})

test('the disclosure lines are priced into the mandatory body, not paid for by the budget', () => {
  const plain = IndexDb.open(':memory:')
  seed(plain, ['keep'], ['closing state'])
  const disclosing = IndexDb.open(':memory:')
  seed(disclosing, ['keep'], ['closing state'], [], {}, { truncated: true, degraded: true })

  const smallestFit = (db: IndexDb): number => {
    let budget = 0
    while (buildBrief(db, 'claude:a', { maxChars: budget })!.includes('could not be met')) budget++
    return budget
  }

  const plainFit = smallestFit(plain)
  const disclosingFit = smallestFit(disclosing)
  // Two mandatory lines, each costing its own text plus one joining newline.
  expect(disclosingFit - plainFit).toBe(2 + SIZE_CAPPED_LINE.length + DEGRADED_LINE.length)
  // At exactly that budget the brief fits it to the character.
  expect(buildBrief(disclosing, 'claude:a', { maxChars: disclosingFit })!.length).toBe(disclosingFit)

  // One character short, the prompt-preserving escape hatch takes over, and it
  // still states both gaps rather than hiding them to save room.
  const short = buildBrief(disclosing, 'claude:a', { maxChars: disclosingFit - 1 })!
  expect(short).toContain('could not be met without dropping user prompts')
  expect(short).toContain(SIZE_CAPPED_LINE)
  expect(short).toContain(DEGRADED_LINE)

  // A zero budget is the same story.
  const zero = buildBrief(disclosing, 'claude:a', { maxChars: 0 })!
  expect(zero).toContain(SIZE_CAPPED_LINE)
  expect(zero).toContain(DEGRADED_LINE)
  expect(zero).toContain('keep')

  plain.close()
  disclosing.close()
})

/** Seeds a session that also carries the ordered dialogue its facets were built from. */
function seedWithTurns(db: IndexDb, prompts: string[], prose: string[]) {
  const ref: SessionRef = {
    uid: 'claude:a', client: 'claude', nativeId: 'a', cwd: '/root/proj', gitBranch: 'main',
    title: 'Fix the SSE reconnect race', startedAt: 1_800_000_000_000,
    endedAt: 1_800_003_600_000, turns: prompts.length + prose.length, parentNativeId: null,
    tier: 'resume', origin: 'manifest', sourcePaths: ['/x'], fingerprint: 'f',
  }
  db.upsertRef(ref)
  db.upsertDoc({
    ref,
    prompts,
    prose,
    files: [],
    truncated: false,
    dialogue: [
      ...prompts.map((text) => ({ role: 'user' as const, text })),
      ...prose.map((text) => ({ role: 'assistant' as const, text })),
    ],
  })
}

test('each message is delimited, so a multi-line one is not read as several', () => {
  // Both sections were newline-joined blobs. A prompt written across three
  // lines and three prompts of one line each produced the same text, so the
  // model acting on the handover could not tell one instruction from the next.
  const db = IndexDb.open(':memory:')
  seedWithTurns(db, ['refactor the parser\nkeep the messages\nadd a test', 'then ship it'], [])
  const brief = buildBrief(db, 'claude:a')!

  expect(brief).toContain('**Prompt 1**\nrefactor the parser\nkeep the messages\nadd a test')
  expect(brief).toContain('**Prompt 2**\nthen ship it')
  db.close()
})

test('the tail is trimmed by whole messages, never mid-sentence', () => {
  // Trimming by stored line meant a handover could open partway through a
  // sentence, with nothing saying the start of it was gone.
  const db = IndexDb.open(':memory:')
  const long = 'a reply that runs across\nseveral separate lines\nand ends here'
  seedWithTurns(db, ['ask'], [long, 'the last word'])

  const whole = buildBrief(db, 'claude:a')!
  expect(whole).toContain(long)

  // A budget with room for the newest message but not the one before it.
  const tight = buildBrief(db, 'claude:a', { maxChars: whole.length - 20 })!
  expect(tight).toContain('the last word')
  expect(tight).not.toContain('several separate lines')
  // And no fragment of the dropped message survives on its own.
  expect(tight).not.toContain('and ends here')
  db.close()
})

test('a reply keeps its position, so a trimmed tail says what it is the tail of', () => {
  const db = IndexDb.open(':memory:')
  seedWithTurns(db, ['ask'], ['first reply', 'second reply', 'third reply'])
  const brief = buildBrief(db, 'claude:a')!
  expect(brief).toContain('**Reply 1**\nfirst reply')
  expect(brief).toContain('**Reply 3**\nthird reply')
  // Separated, so one message cannot read as the continuation of the last.
  expect(brief).toContain('first reply\n\n**Reply 2**')
  db.close()
})

test('a session with no recorded dialogue claims no boundaries it does not know', () => {
  // Indexed before ordered turns existed, so where one message ended is simply
  // not known. Numbering the stored lines would invent a structure the index
  // never had, which is worse than the blob it really is.
  const db = IndexDb.open(':memory:')
  seed(db, ['a prompt\nwrapped over two lines'], ['a reply'])
  const brief = buildBrief(db, 'claude:a')!
  expect(brief).toContain('a prompt\nwrapped over two lines')
  expect(brief).not.toContain('**Prompt 1**')
  expect(brief).not.toContain('**Reply 1**')
  db.close()
})

test('the budget holds exactly for labelled messages, at every size', () => {
  // The labels and the blank line between messages are real characters, so the
  // budget has to price them like anything else. A bound that is only usually
  // right is not a bound.
  const db = IndexDb.open(':memory:')
  seedWithTurns(
    db,
    ['the one thing I asked'],
    Array.from({ length: 12 }, (_, index) => `reply ${index} across\ntwo lines of text`),
  )
  const whole = buildBrief(db, 'claude:a')!

  for (let maxChars = 0; maxChars <= whole.length + 40; maxChars += 7) {
    const brief = buildBrief(db, 'claude:a', { maxChars })!
    // Prompts are never dropped, so a budget below the mandatory body is
    // exceeded on purpose and says so. Every other budget is a real bound.
    if (brief.includes('could not be met without dropping user prompts')) continue
    expect(brief.length).toBeLessThanOrEqual(maxChars)
  }
  db.close()
})

test('a trimmed tail keeps whole messages and never a fragment of the one before', () => {
  const db = IndexDb.open(':memory:')
  seedWithTurns(db, ['ask'], ['alpha line one\nalpha line two', 'bravo', 'charlie'])
  const whole = buildBrief(db, 'claude:a')!

  for (let maxChars = 0; maxChars <= whole.length; maxChars += 3) {
    const brief = buildBrief(db, 'claude:a', { maxChars })!
    // Either a message is present with its label and all of its lines, or it
    // is absent entirely. A half-message is what trimming by line produced.
    if (brief.includes('alpha line two')) {
      expect(brief).toContain('**Reply 1**\nalpha line one\nalpha line two')
    }
  }
  db.close()
})
