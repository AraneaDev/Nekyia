import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
