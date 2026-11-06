import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { IndexDb } from '../src/core/db'
import { query } from '../src/core/query'
import { DEFAULT_CONFIG } from '../src/config'
import { compileSearch } from '../src/core/search-text'
import { readMatchEvidence } from '../src/core/search-match'
import type { DialogueTurn, SessionRef } from '../src/types'

function seed(db: IndexDb, id: string, dialogue: DialogueTurn[], age = 0) {
  const ref: SessionRef = { uid: id, client: 'codex', nativeId: id, cwd: '/project', gitBranch: null,
    title: '', startedAt: 1, endedAt: Date.now() - age, turns: dialogue.length, parentNativeId: null,
    tier: 'resume', origin: 'manifest', sourcePaths: [], fingerprint: 'x' }
  db.upsertHydrated({ ref, dialogue, prompts: dialogue.filter(t => t.role === 'user').map(t => t.text),
    prose: dialogue.filter(t => t.role === 'assistant').map(t => t.text), files: [], truncated: false })
}

test('a focused passage in a long old conversation outranks scattered recent mentions', () => {
  const db = IndexDb.open(':memory:')
  seed(db, 'migration', [
    ...Array.from({ length: 80 }, (_, i) => ({ role: 'user' as const, text: `unrelated topic ${i} ` + 'other details '.repeat(100) })),
    { role: 'user', text: 'Replace app engine search with Elasticsearch; migrate customer orders.' },
  ], 180 * 86400000)
  seed(db, 'incidental', [{ role: 'user', text: 'Open app settings.' },
    { role: 'assistant', text: 'The engine failed.' }, { role: 'user', text: 'Search for logs.' }])
  expect(query(db, DEFAULT_CONFIG, { text: 'app engine search' }).map(r => r.uid)).toEqual(['migration', 'incidental'])
  expect(query(db, DEFAULT_CONFIG, { text: 'app engine search', sort: 'recent' })[0]?.uid).toBe('incidental')
  db.close()
})

test('instruction envelopes cannot create matches but remain in original retained history', () => {
  const db = IndexDb.open(':memory:')
  const injected = '# AGENTS.md instructions for /project\n<INSTRUCTIONS>\nobsolete secretneedle instructions\n</INSTRUCTIONS>\nInvestigate a real migration.'
  seed(db, 'a', [{ role: 'user', text: injected }])
  expect(query(db, DEFAULT_CONFIG, { text: 'secretneedle' })).toEqual([])
  expect(query(db, DEFAULT_CONFIG, { text: 'migration' })[0]?.uid).toBe('a')
  expect(db.retainedTurns('a').turns[0]?.text).toBe(injected)
  seed(db, 'b', [{ role: 'user', text: 'Please explain AGENTS.md instructions and secretneedle.' }])
  expect(query(db, DEFAULT_CONFIG, { text: 'secretneedle' }).map(r => r.uid)).toEqual(['b'])
  db.close()
})

test('quotes require adjacent words and quoted phrases are never prefix-expanded', () => {
  expect(compileSearch('"app engine search" migration', 'literal')).toBe('"app engine search" "migration"')
  expect(compileSearch('"app engine"', 'prefix-last')).toBe('"app engine"')
  const db = IndexDb.open(':memory:')
  seed(db, 'together', [{ role: 'user', text: 'app engine search migration' }])
  seed(db, 'apart', [{ role: 'user', text: 'app settings engine diagnostics search migration' }])
  expect(query(db, DEFAULT_CONFIG, { text: '"app engine search"' }).map(r => r.uid)).toEqual(['together'])
  db.close()
})

test('matching excerpt comes from the highest scoring passage and deletion removes its index', () => {
  const db = IndexDb.open(':memory:')
  seed(db, 'a', [{ role: 'user', text: 'Needle ' + 'unrelated '.repeat(2000) },
    { role: 'assistant', text: 'Needle migration is complete.' }])
  const evidence = readMatchEvidence(db, 'a', '"needle" "migration"', db.retainedTurns('a').turns as any)
  expect(evidence?.text).toContain('migration is complete')
  expect(evidence?.field).toBe('reply')
  seed(db, 'a', [{ role: 'user', text: 'replacement conversation' }])
  expect(query(db, DEFAULT_CONFIG, { text: 'needle' })).toEqual([])
  db.deleteSessions(['a'])
  expect(query(db, DEFAULT_CONFIG, { text: 'replacement' })).toEqual([])
  db.close()
})

test('cross-turn fallback remains searchable with evidence free of injected instructions', () => {
  const db = IndexDb.open(':memory:')
  seed(db, 'a', [{ role: 'user', text: '<environment_context>app engine search</environment_context> app configuration' },
    { role: 'assistant', text: 'engine replacement' }, { role: 'user', text: 'search migration' }])
  expect(query(db, DEFAULT_CONFIG, { text: 'app engine search' }).map(r => r.uid)).toEqual(['a'])
  const evidence = readMatchEvidence(db, 'a', '"app" "engine" "search"', db.retainedTurns('a').turns as any)
  expect(evidence?.text).not.toContain('environment_context')
  expect(evidence?.text).not.toContain('app engine search')
  db.close()
})

test('overlapping passage boundaries preserve phrases and do not reward duplicated turns', () => {
  const db = IndexDb.open(':memory:')
  // `archive` ends the first 4096-character passage and `migration` starts past
  // it, so only the overlap between passages keeps the phrase findable.
  const text = 'filler '.repeat(584) + 'archive migration works'
  expect(text.indexOf('archive')).toBeLessThan(4096)
  expect(text.indexOf('migration')).toBeGreaterThanOrEqual(4096)
  seed(db, 'a', [{ role: 'user', text }])
  seed(db, 'b', Array.from({ length: 80 }, () => ({ role: 'user', text })))
  const hits = db.ftsSearch('"archive migration"')
  expect(hits.map(h => h.uid).sort()).toEqual(['a', 'b'])
  expect(hits.find(h => h.uid === 'a')?.score).toBe(hits.find(h => h.uid === 'b')?.score)
  db.raw().exec("DELETE FROM session WHERE uid = 'a'")
  expect(db.raw().query('SELECT count(*) AS n FROM session_passage WHERE uid = ?').get('a')).toEqual({ n: 0 })
  expect(query(db, DEFAULT_CONFIG, { text: '"archive migration"' }).map(r => r.uid)).toEqual(['b'])
  db.close()
})

test('ordinary requests discussing harness tags remain searchable', () => {
  const db = IndexDb.open(':memory:')
  seed(db, 'a', [{ role: 'user', text: 'Explain the <environment_context>contextneedle</environment_context> tag.' }])
  expect(query(db, DEFAULT_CONFIG, { text: 'contextneedle' }).map(r => r.uid)).toEqual(['a'])
  db.close()
})

test('an omitted oversized token cannot create false phrase adjacency', () => {
  const db = IndexDb.open(':memory:')
  seed(db, 'a', [{ role: 'user', text: 'alpha ' + 'x'.repeat(4097) + ' beta' }])
  expect(query(db, DEFAULT_CONFIG, { text: '"alpha beta"' })).toEqual([])
  expect(query(db, DEFAULT_CONFIG, { text: 'alpha beta' }).map(r => r.uid)).toEqual(['a'])
  db.close()
})


test('migration of unordered legacy facets excludes later harness envelopes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nekyia-migrate-passages-'))
  const path = join(dir, 'index.db')
  let db = IndexDb.open(path)
  try {
    seed(db, 'a', [{ role: 'user', text: 'Investigate migration' },
      { role: 'user', text: '<environment_context>harnessneedle</environment_context> Real request' }])
    expect(query(db, DEFAULT_CONFIG, { text: 'harnessneedle' })).toEqual([])
    db.raw().exec(`
      DROP TRIGGER passage_insert; DROP TRIGGER passage_delete; DROP TRIGGER passage_session_delete;
      DROP TABLE passage_fts; DROP TABLE session_passage; DELETE FROM session_turn;
      CREATE VIRTUAL TABLE session_fts USING fts5(title, prompts, prose, content='session_text', content_rowid='rowid', tokenize='porter unicode61');
      INSERT INTO session_fts(session_fts) VALUES('rebuild');
      UPDATE meta SET value = '4' WHERE key = 'schema_version';
    `)
    db.close()
    db = IndexDb.open(path)
    expect(query(db, DEFAULT_CONFIG, { text: 'harnessneedle' })).toEqual([])
    expect(query(db, DEFAULT_CONFIG, { text: 'request' }).map(r => r.uid)).toEqual(['a'])
    expect((db.raw().query('SELECT prompts FROM session_text WHERE uid = ?').get('a') as any).prompts).toContain('harnessneedle')
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('the excerpt comes from the better-scoring of two passages that both match', () => {
  const db = IndexDb.open(':memory:')
  // Both passages match the whole expression; the prompt column weighs four
  // times the reply column, so a reversed BM25 order would pick the reply.
  seed(db, 'a', [{ role: 'user', text: 'needle migration first' },
    { role: 'assistant', text: 'needle migration second' }])
  const evidence = readMatchEvidence(db, 'a', '"needle" "migration"', db.retainedTurns('a').turns as any)
  expect(evidence?.field).toBe('prompt')
  expect(evidence?.text).toContain('first')
  db.close()
})

test('an assistant echo never displaces an identical prompt passage', () => {
  const db = IndexDb.open(':memory:')
  seed(db, 'a', [{ role: 'assistant', text: 'rotate the signing keys' },
    { role: 'user', text: 'rotate the signing keys' }])
  const evidence = readMatchEvidence(db, 'a', '"signing" "keys"', db.retainedTurns('a').turns as any)
  expect(evidence?.field).toBe('prompt')
  db.close()
})

test('instructions after a leading envelope are still kept out of search', () => {
  const db = IndexDb.open(':memory:')
  seed(db, 'a', [{ role: 'user', text: '<environment_context>cwd</environment_context>\n'
    + '# AGENTS.md instructions for /project\n<INSTRUCTIONS>\nagentsneedle\n</INSTRUCTIONS>\nReal request here' }])
  expect(query(db, DEFAULT_CONFIG, { text: 'agentsneedle' })).toEqual([])
  expect(query(db, DEFAULT_CONFIG, { text: 'request' }).map(r => r.uid)).toEqual(['a'])
  db.close()
})

test('forgetting a UID removes its passages even without a session row', () => {
  const db = IndexDb.open(':memory:')
  db.raw().query("INSERT INTO session_passage (uid, title, prompt, reply) VALUES ('ghost', '', 'ghostneedle', '')").run()
  expect(db.ftsSearch('"ghostneedle"').map(h => h.uid)).toEqual(['ghost'])
  db.deleteSessions(['ghost'])
  expect(db.raw().query('SELECT count(*) AS n FROM session_passage WHERE uid = ?').get('ghost')).toEqual({ n: 0 })
  expect(db.ftsSearch('"ghostneedle"')).toEqual([])
  db.close()
})

/** A version 4 index with real content: the passage tables removed and the stamp set back. */
function writeV4Index(path: string): void {
  const db = IndexDb.open(path)
  try {
    seed(db, 'a', [{ role: 'user', text: 'Investigate migration' }])
    db.raw().exec(`
      DROP TRIGGER passage_insert; DROP TRIGGER passage_delete; DROP TRIGGER passage_session_delete;
      DROP TABLE passage_fts; DROP TABLE session_passage;
      CREATE VIRTUAL TABLE session_fts USING fts5(title, prompts, prose, content='session_text', content_rowid='rowid', tokenize='porter unicode61');
      INSERT INTO session_fts(session_fts) VALUES('rebuild');
      UPDATE meta SET value = '4' WHERE key = 'schema_version';
    `)
  } finally { db.close() }
}

test('a damaged version 4 index is refused with the reindex hint before migrating', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nekyia-v4-damaged-'))
  const path = join(dir, 'index.db')
  try {
    writeV4Index(path)
    const damaged = new Database(path)
    damaged.exec('DROP TABLE session_turn')
    damaged.close()
    // The version 5 step reads session_turn; without the check first, this was a raw SQL error.
    expect(() => IndexDb.open(path, false)).toThrow(/index schema table is missing: session_turn/)
    expect(() => IndexDb.open(path, false)).toThrow(/delete .*index\.db and run "nekyia index"/)
    // Refused before any step ran: the file is still a version 4 index.
    const check = new Database(path, { readonly: true })
    expect(check.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: '4' })
    check.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a healthy version 4 index still migrates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nekyia-v4-healthy-'))
  const path = join(dir, 'index.db')
  try {
    writeV4Index(path)
    const db = IndexDb.open(path, false)
    try {
      expect(query(db, DEFAULT_CONFIG, { text: 'migration' }).map(r => r.uid)).toEqual(['a'])
    } finally { db.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

for (const trigger of ['passage_insert', 'passage_delete', 'passage_session_delete']) {
  test(`a version 5 index missing ${trigger} is refused on every writable open`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekyia-trigger-'))
    const path = join(dir, 'index.db')
    try {
      IndexDb.open(path).close()
      const damaged = new Database(path)
      damaged.exec(`DROP TRIGGER ${trigger}`)
      damaged.close()
      const reason = new RegExp(`index search trigger is missing: ${trigger}`)
      expect(() => IndexDb.open(path, false)).toThrow(reason)
      expect(() => IndexDb.openExistingWritable(path)).toThrow(reason)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

test('titles are split into bounded passages and an oversized title token is not searchable', () => {
  const db = IndexDb.open(':memory:')
  const ref: SessionRef = { uid: 't', client: 'codex', nativeId: 't', cwd: '/project', gitBranch: null,
    title: 'alpha ' + 'x'.repeat(5000) + ' beta ' + 'word '.repeat(2000), startedAt: 1, endedAt: Date.now(),
    turns: 0, parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: [], fingerprint: 'x' }
  db.upsertHydrated({ ref, dialogue: [], prompts: [], prose: [], files: [], truncated: false })
  const titles = db.raw().query("SELECT length(title) AS n FROM session_passage WHERE uid = 't' AND title != ''").all() as Array<{ n: number }>
  expect(titles.length).toBeGreaterThan(1)
  for (const { n } of titles) expect(n).toBeLessThanOrEqual(4096)
  expect(db.ftsSearch(`"${'x'.repeat(5000)}"`)).toEqual([])
  expect(db.ftsSearch('"alpha beta"')).toEqual([])
  expect(db.ftsSearch('"alpha"').map(h => h.uid)).toEqual(['t'])
  db.close()
})

test('a passage trigger with the right name but a different body is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nekyia-trigger-body-'))
  const path = join(dir, 'index.db')
  try {
    IndexDb.open(path).close()
    const damaged = new Database(path)
    damaged.exec('DROP TRIGGER passage_insert; CREATE TRIGGER passage_insert AFTER INSERT ON session_passage BEGIN SELECT 1; END;')
    damaged.close()
    expect(() => IndexDb.open(path, false)).toThrow(/index search trigger does not match: passage_insert/)
    expect(() => IndexDb.openExistingWritable(path)).toThrow(/index search trigger does not match: passage_insert/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an unstamped database that already has tables is refused and left untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nekyia-foreign-'))
  const path = join(dir, 'other.db')
  try {
    const foreign = new Database(path)
    foreign.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes (body) VALUES ('mine')")
    foreign.close()
    expect(() => IndexDb.open(path, false)).toThrow(/not a Nekyia index: .*left untouched/)
    // Never the delete-and-reindex advice: this file may belong to something else.
    expect(() => IndexDb.open(path, false)).not.toThrow(/delete/)
    const check = new Database(path, { readonly: true })
    expect((check.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name)).toEqual(['notes'])
    check.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an existing empty database file is still initialised as an index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nekyia-empty-'))
  const path = join(dir, 'index.db')
  try {
    new Database(path).close()
    const db = IndexDb.open(path, false)
    try { expect(query(db, DEFAULT_CONFIG, {})).toEqual([]) } finally { db.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
