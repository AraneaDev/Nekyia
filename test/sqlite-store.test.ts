import { afterEach, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/config'
import { parseCwd, parseSqlTime, sqliteStore } from '../src/formats/sqlite-store'
import { renderArgs, validateManifest } from '../src/manifests/load'
import copilotManifest from '../src/manifests/builtin/copilot.json'

const FIX = join(import.meta.dir, 'fixtures')
const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

const opencode = validateManifest({
  schema: 1, id: 'opencode', name: 'opencode', roots: [join(FIX, 'opencode')],
  format: 'sqlite-store', tier: 'search',
  sqlite: {
    file: 'opencode.db',
    sessions: 'SELECT id AS id, directory AS cwd, title AS title, parent_id AS parent_id, time_created AS started_at, time_updated AS ended_at FROM session',
    text: 'SELECT m.data AS message_data, p.data AS part_data FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = ?1 ORDER BY p.time_created',
    textShape: 'opencode-part', timeUnit: 'ms',
  },
})

const agy = validateManifest({
  schema: 1, id: 'agy', name: 'Antigravity CLI', roots: [join(FIX, 'agy')],
  format: 'sqlite-store', tier: 'resume',
  sqlite: {
    file: 'conversation_summaries.db',
    sessions: 'SELECT conversation_id AS id, title AS title, preview AS preview, step_count AS turns, last_modified_time AS ended_at, workspace_uris AS cwd_uris FROM conversation_summaries',
    cwdShape: 'file-uri-array', timeUnit: 'iso',
  },
  resume: { cmd: 'agy', args: ['--conversation', '{id}'], cwd: '{cwd}' },
})

test('parseSqlTime handles ms, seconds and nanosecond ISO', () => {
  expect(parseSqlTime(1785657600000, 'ms')).toBe(1785657600000)
  expect(parseSqlTime(1785657600, 's')).toBe(1785657600000)
  expect(parseSqlTime('2026-08-04 19:38:58.830144583+00:00', 'iso'))
    .toBe(Date.parse('2026-08-04T19:38:58.830+00:00'))
})

test('parseSqlTime returns 0 rather than coercing junk or overflow', () => {
  expect(parseSqlTime('not a time', 'iso')).toBe(0)
  expect(parseSqlTime('0', 'iso')).toBe(0)
  expect(parseSqlTime('1785657600000', 'ms')).toBe(0)
  expect(parseSqlTime(Number.MAX_VALUE, 's')).toBe(0)
})

test('parseCwd unwraps a file uri array', () => {
  expect(parseCwd(JSON.stringify(['file:///root/proj']), 'file-uri-array')).toBe('/root/proj')
  expect(parseCwd('[]', 'file-uri-array')).toBe(null)
})

test('parseCwd rejects malformed encodings and non-string plain values', () => {
  expect(parseCwd(JSON.stringify(['file:///%zz']), 'file-uri-array')).toBe(null)
  expect(parseCwd(42, 'plain')).toBe(null)
  expect(parseCwd('   ', 'plain')).toBe(null)
})

test('opencode discover reads sessions with directory, title and parent', async () => {
  const { refs } = await sqliteStore.discover(opencode, join(FIX, 'opencode'))
  const byId = Object.fromEntries(refs.map((ref) => [ref.nativeId, ref]))
  expect(refs).toHaveLength(2)
  expect(byId['ses_aaa']!.cwd).toBe('/root/proj')
  expect(byId['ses_aaa']!.title).toBe('Debug event stream drops')
  expect(byId['ses_bbb']!.parentNativeId).toBe('ses_aaa')
})

test('opencode hydrate reads text from parts, split by message role', async () => {
  const { refs } = await sqliteStore.discover(opencode, join(FIX, 'opencode'))
  const ref = refs.find((candidate) => candidate.nativeId === 'ses_aaa')!
  const doc = await sqliteStore.hydrate(opencode, join(FIX, 'opencode'), ref, DEFAULT_CONFIG)
  expect(doc.prompts).toEqual(['why does the event stream drop'])
  expect(doc.prose).toEqual(['The reader is not awaited.'])
})

test('opencode hydrate captures tool file paths but NEVER tool output', async () => {
  const { refs } = await sqliteStore.discover(opencode, join(FIX, 'opencode'))
  const ref = refs.find((candidate) => candidate.nativeId === 'ses_aaa')!
  const doc = await sqliteStore.hydrate(opencode, join(FIX, 'opencode'), ref, DEFAULT_CONFIG)
  expect(doc.files).toContain('/root/proj/src/stream.ts')
  expect([...doc.prompts, ...doc.prose].join(' ')).not.toContain('SECRET_TOOL_OUTPUT')
})

test('opencode hydration preserves prompts and tool facets after reaching its byte cap', async () => {
  const { refs } = await sqliteStore.discover(opencode, join(FIX, 'opencode'))
  const ref = refs.find((candidate) => candidate.nativeId === 'ses_aaa')!
  const doc = await sqliteStore.hydrate(
    opencode,
    join(FIX, 'opencode'),
    ref,
    { ...DEFAULT_CONFIG, maxFileBytes: 1 },
  )
  expect(doc.prompts).toEqual(['why does the event stream drop'])
  expect(doc.prose).toEqual([])
  expect(doc.files).toContain('/root/proj/src/stream.ts')
  expect(doc.truncated).toBe(true)
})

test('agy discover falls back to preview when title is empty', async () => {
  const { refs } = await sqliteStore.discover(agy, join(FIX, 'agy'))
  expect(refs).toHaveLength(1)
  expect(refs[0]!.title).toBe('Autonomous Systems Improvement Framework')
  expect(refs[0]!.cwd).toBe('/root/proj')
  expect(refs[0]!.turns).toBe(50)
})

test('a root that does not exist yields nothing at all, and never throws', async () => {
  const { refs, diagnostics } = await sqliteStore.discover(opencode, '/nonexistent')
  expect(refs).toEqual([])
  // The client is not installed. That is a complete answer, not a fault, and
  // reporting it would cost the client its authoritative status.
  expect(diagnostics).toEqual([])
})

test('a bad sessions query yields a diagnostic and leaves the database reusable', async () => {
  const bad = validateManifest({
    ...opencode,
    sqlite: { ...opencode.sqlite, sessions: 'SELECT missing FROM nowhere' },
  })
  const root = join(FIX, 'opencode')
  const result = await sqliteStore.discover(bad, root)
  expect(result.refs).toEqual([])
  expect(result.diagnostics[0]?.message).toContain('sessions query failed')

  const db = new Database(join(root, 'opencode.db'), { readonly: true })
  expect(db.query('SELECT count(*) AS count FROM session').get()).toEqual({ count: 2 })
  db.close()
})

test('plain hydration ignores non-user and non-assistant roles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sqlite-store-'))
  tempDirs.push(root)
  const db = new Database(join(root, 'sessions.db'), { create: true })
  db.exec('CREATE TABLE transcript(session_id TEXT, role TEXT, text TEXT)')
  const insert = db.prepare('INSERT INTO transcript VALUES (?1, ?2, ?3)')
  insert.run('one', 'user', 'safe prompt')
  insert.run('one', 'assistant', 'safe answer')
  insert.run('one', 'developer', 'PRIVATE DEVELOPER INSTRUCTION')
  insert.run('one', 'tool', 'PRIVATE TOOL OUTPUT')
  db.close()

  const manifest = validateManifest({
    schema: 1, id: 'plain', name: 'plain', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'sessions.db', sessions: "SELECT 'one' AS id",
      text: 'SELECT role, text FROM transcript WHERE session_id = ?1',
      textShape: 'plain',
    },
  })
  const { refs } = await sqliteStore.discover(manifest, root)
  const doc = await sqliteStore.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)
  expect(doc.prompts).toEqual(['safe prompt'])
  expect(doc.prose).toEqual(['safe answer'])
})

test('sqlite files cannot escape their manifest root lexically or through symlinks', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'nekyia-sqlite-containment-'))
  tempDirs.push(temp)
  const root = join(temp, 'root')
  mkdirSync(root)
  const outside = join(temp, 'outside.db')
  const db = new Database(outside, { create: true })
  db.exec('CREATE TABLE transcript(session_id TEXT, role TEXT, text TEXT)')
  db.run("INSERT INTO transcript VALUES ('ses_aaa', 'user', 'OUTSIDE SECRET')")
  db.close()
  symlinkSync(outside, join(root, 'linked.db'))

  const escapedFiles = ['../outside.db', outside, 'linked.db']
  const fixtureRef = (await sqliteStore.discover(opencode, join(FIX, 'opencode'))).refs[0]!
  for (const file of escapedFiles) {
    const manifest = validateManifest({
      schema: 1, id: 'escaped', name: 'escaped', roots: [root],
      format: 'sqlite-store', tier: 'search',
      sqlite: {
        file,
        sessions: "SELECT 'ses_aaa' AS id",
        text: 'SELECT role, text FROM transcript WHERE session_id = ?1',
      },
    })
    const result = await sqliteStore.discover(manifest, root)
    expect(result.refs).toEqual([])
    expect(result.diagnostics[0]?.level).toBe('warn')
    const doc = await sqliteStore.hydrate(manifest, root, fixtureRef, DEFAULT_CONFIG)
    expect(doc.prompts).toEqual([])
  }
})

test('discovery trims metadata, falls back from NULL cwd_uris, and preserves epoch zero', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sqlite-metadata-'))
  tempDirs.push(root)
  const db = new Database(join(root, 'sessions.db'), { create: true })
  db.exec('CREATE TABLE sessions(id TEXT, cwd_uris TEXT, cwd TEXT, title TEXT, started_at INTEGER, ended_at INTEGER)')
  db.run("INSERT INTO sessions VALUES ('  one  ', NULL, '  /root/proj  ', '  A title  ', 0, 5)")
  db.run("INSERT INTO sessions VALUES ('two', NULL, '/root/two', 'Two', 'junk', 7)")
  db.close()
  const manifest = validateManifest({
    schema: 1, id: 'metadata', name: 'metadata', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'sessions.db',
      sessions: 'SELECT * FROM sessions',
      cwdShape: 'file-uri-array',
      timeUnit: 'ms',
    },
  })

  const { refs } = await sqliteStore.discover(manifest, root)
  const byId = Object.fromEntries(refs.map((ref) => [ref.nativeId, ref]))
  expect(byId.one?.cwd).toBe('/root/proj')
  expect(byId.one?.title).toBe('A title')
  expect(byId.one?.startedAt).toBe(0)
  expect(byId.two?.startedAt).toBe(7)
})

test('hydration keeps prompts and tool facets while bounding assistant prose', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sqlite-budget-'))
  tempDirs.push(root)
  const db = new Database(join(root, 'sessions.db'), { create: true })
  db.exec('CREATE TABLE transcript(session_id TEXT, role TEXT, text TEXT)')
  const insert = db.prepare('INSERT INTO transcript VALUES (?1, ?2, ?3)')
  insert.run('one', 'user', 'keep this prompt even over budget')
  insert.run('one', 'assistant', 'DROP THIS PROSE')
  for (let index = 0; index < 40; index += 1) {
    insert.run('one', 'tool', `PRIVATE TOOL OUTPUT ${index} ${'x'.repeat(2048)}`)
  }
  insert.run('one', 'user', 'keep this later prompt too')
  db.close()
  const manifest = validateManifest({
    schema: 1, id: 'budget', name: 'budget', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'sessions.db', sessions: "SELECT 'one' AS id",
      text: 'SELECT role, text FROM transcript WHERE session_id = ?1 ORDER BY rowid',
      textShape: 'plain',
    },
  })
  const { refs } = await sqliteStore.discover(manifest, root)
  const doc = await sqliteStore.hydrate(
    manifest,
    root,
    refs[0]!,
    { ...DEFAULT_CONFIG, maxFileBytes: 10 },
  )
  expect(doc.prompts).toEqual([
    'keep this prompt even over budget',
    'keep this later prompt too',
  ])
  expect(doc.prose).toEqual([])
  expect(doc.truncated).toBe(true)
  expect([...doc.prompts, ...doc.prose].join(' ')).not.toContain('PRIVATE TOOL OUTPUT')
})

test('opencode-message-json indexes safe text and tool inputs only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sqlite-legacy-'))
  tempDirs.push(root)
  const db = new Database(join(root, 'sessions.db'), { create: true })
  db.exec('CREATE TABLE message(session_id TEXT, data TEXT)')
  const insert = db.prepare('INSERT INTO message VALUES (?1, ?2)')
  insert.run('one', JSON.stringify({ role: 'user', parts: [{ type: 'text', text: 'legacy prompt' }] }))
  insert.run('one', JSON.stringify({
    role: 'assistant',
    parts: [
      { type: 'text', text: 'legacy answer' },
      {
        type: 'tool',
        state: {
          input: { filePath: '/root/proj/src/legacy.ts' },
          output: 'PRIVATE LEGACY TOOL OUTPUT',
        },
      },
    ],
  }))
  insert.run('one', JSON.stringify({ role: 'developer', parts: [{ type: 'text', text: 'PRIVATE INSTRUCTION' }] }))
  db.close()
  const manifest = validateManifest({
    schema: 1, id: 'legacy', name: 'legacy', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'sessions.db', sessions: "SELECT 'one' AS id",
      text: 'SELECT data FROM message WHERE session_id = ?1 ORDER BY rowid',
      textShape: 'opencode-message-json',
    },
  })
  const { refs } = await sqliteStore.discover(manifest, root)
  const doc = await sqliteStore.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)
  expect(doc.prompts).toEqual(['legacy prompt'])
  expect(doc.prose).toEqual(['legacy answer'])
  expect(doc.files).toEqual(['/root/proj/src/legacy.ts'])
  expect([...doc.prompts, ...doc.prose].join(' ')).not.toContain('PRIVATE')
})

test('structured hydration projects a huge tool output away before rows cross into JS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sqlite-projection-'))
  tempDirs.push(root)
  const db = new Database(join(root, 'sessions.db'), { create: true })
  db.exec(`
    CREATE TABLE message(id TEXT, session_id TEXT, data TEXT);
    CREATE TABLE part(message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `)
  const insertMessage = db.prepare('INSERT INTO message VALUES (?1, ?2, ?3)')
  const insertPart = db.prepare('INSERT INTO part VALUES (?1, ?2, ?3, ?4)')
  insertMessage.run('m1', 'one', JSON.stringify({ role: 'user' }))
  insertMessage.run('m2', 'one', JSON.stringify({ role: 'assistant' }))
  insertMessage.run('m3', 'one', JSON.stringify({ role: 'user' }))
  insertPart.run('m1', 'one', 1, JSON.stringify({ type: 'text', text: 'first prompt' }))
  insertPart.run('m2', 'one', 2, JSON.stringify({
    type: 'tool',
    state: {
      input: { filePath: '/root/proj/src/huge.ts' },
      output: `PRIVATE HUGE OUTPUT ${'x'.repeat(16 * 1024 * 1024)}`,
    },
  }))
  insertPart.run('m3', 'one', 3, JSON.stringify({ type: 'text', text: 'later prompt' }))
  db.close()

  const text = 'SELECT m.data AS message_data, p.data AS part_data FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = ?1 ORDER BY p.time_created'
  const manifest = validateManifest({
    schema: 1, id: 'projection', name: 'projection', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'sessions.db', sessions: "SELECT 'one' AS id",
      text, textShape: 'opencode-part',
    },
  })
  const { refs } = await sqliteStore.discover(manifest, root)
  const querySpy = spyOn(Database.prototype, 'query')
  let doc
  let hydrationSql: unknown
  try {
    doc = await sqliteStore.hydrate(
      manifest,
      root,
      refs[0]!,
      { ...DEFAULT_CONFIG, maxFileBytes: 1 },
    )
    hydrationSql = querySpy.mock.calls
      .map((call) => call[0])
      .find((sql) => typeof sql === 'string' && sql.includes('projected_source_bytes'))
  } finally {
    querySpy.mockRestore()
  }

  expect(hydrationSql).toContain('json_extract')
  expect(hydrationSql).toContain(`raw_source AS MATERIALIZED (${text})`)
  expect(doc!.prompts).toEqual(['first prompt', 'later prompt'])
  expect(doc!.files).toContain('/root/proj/src/huge.ts')
  expect(doc!.truncated).toBe(true)
  expect([...doc!.prompts, ...doc!.prose].join(' ')).not.toContain('PRIVATE HUGE OUTPUT')
})

test('legacy projection preserves source order and numeric part order explicitly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sqlite-order-'))
  tempDirs.push(root)
  const db = new Database(join(root, 'sessions.db'), { create: true })
  db.exec('CREATE TABLE message(session_id TEXT, n INTEGER, data TEXT)')
  const insert = db.prepare('INSERT INTO message VALUES (?1, ?2, ?3)')
  for (const n of [1, 3, 2]) {
    insert.run('one', n, JSON.stringify({
      role: 'user',
      parts: [
        { type: 'text', text: `${n}a` },
        { type: 'text', text: `${n}b` },
      ],
    }))
  }
  db.close()
  const text = 'SELECT data FROM message WHERE session_id = ?1 ORDER BY n DESC'
  const manifest = validateManifest({
    schema: 1, id: 'order', name: 'order', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'sessions.db', sessions: "SELECT 'one' AS id",
      text, textShape: 'opencode-message-json',
    },
  })
  const { refs } = await sqliteStore.discover(manifest, root)
  const querySpy = spyOn(Database.prototype, 'query')
  let doc
  let hydrationSql: unknown
  try {
    doc = await sqliteStore.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)
    hydrationSql = querySpy.mock.calls
      .map((call) => call[0])
      .find((sql) => typeof sql === 'string' && sql.includes('projected_source_bytes'))
  } finally {
    querySpy.mockRestore()
  }
  expect(doc!.prompts).toEqual(['3a', '3b', '2a', '2b', '1a', '1b'])
  expect(hydrationSql).toContain('ORDER BY source_ordinal, CAST(part_key AS INTEGER)')
})

test('legacy projection charges an expanded message only once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sqlite-charge-'))
  tempDirs.push(root)
  const db = new Database(join(root, 'sessions.db'), { create: true })
  db.exec('CREATE TABLE message(session_id TEXT, data TEXT)')
  const data = JSON.stringify({
    role: 'assistant',
    parts: [
      { type: 'text', text: 'first answer' },
      { type: 'text', text: 'second answer' },
    ],
  })
  db.run('INSERT INTO message VALUES (?1, ?2)', ['one', data])
  db.close()
  const manifest = validateManifest({
    schema: 1, id: 'charge', name: 'charge', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'sessions.db', sessions: "SELECT 'one' AS id",
      text: 'SELECT data FROM message WHERE session_id = ?1',
      textShape: 'opencode-message-json',
    },
  })
  const { refs } = await sqliteStore.discover(manifest, root)
  const doc = await sqliteStore.hydrate(
    manifest,
    root,
    refs[0]!,
    { ...DEFAULT_CONFIG, maxFileBytes: Buffer.byteLength(data) },
  )
  expect(doc.prose).toEqual(['first answer', 'second answer'])
  expect(doc.truncated).toBe(false)
})

test('oversized projected tool input is nulled in SQL and marks the document truncated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sqlite-input-cap-'))
  tempDirs.push(root)
  const db = new Database(join(root, 'sessions.db'), { create: true })
  db.exec(`
    CREATE TABLE message(id TEXT, session_id TEXT, data TEXT);
    CREATE TABLE part(message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `)
  db.run('INSERT INTO message VALUES (?1, ?2, ?3)', ['m1', 'one', JSON.stringify({ role: 'assistant' })])
  db.run('INSERT INTO part VALUES (?1, ?2, ?3, ?4)', [
    'm1', 'one', 1, JSON.stringify({
      type: 'tool',
      state: {
        input: {
          filePath: '/root/proj/src/too-large.ts',
          padding: 'x'.repeat(5 * 1024 * 1024),
        },
        output: 'private',
      },
    }),
  ])
  db.close()
  const text = 'SELECT m.data AS message_data, p.data AS part_data FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = ?1 ORDER BY p.time_created'
  const manifest = validateManifest({
    schema: 1, id: 'input-cap', name: 'input-cap', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'sessions.db', sessions: "SELECT 'one' AS id",
      text, textShape: 'opencode-part',
    },
  })
  const { refs } = await sqliteStore.discover(manifest, root)
  const querySpy = spyOn(Database.prototype, 'query')
  let doc
  let hydrationSql: unknown
  try {
    doc = await sqliteStore.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)
    hydrationSql = querySpy.mock.calls
      .map((call) => call[0])
      .find((sql) => typeof sql === 'string' && sql.includes('projected_source_bytes'))
  } finally {
    querySpy.mockRestore()
  }
  expect(hydrationSql).toContain('projected_input_oversized')
  expect(hydrationSql).toContain('<= ?3')
  expect(doc!.files).not.toContain('/root/proj/src/too-large.ts')
  expect(doc!.truncated).toBe(true)
})

const copilot = validateManifest(copilotManifest)

test('copilot discover reads cwd, summary as title and the recorded branch', async () => {
  const { refs } = await sqliteStore.discover(copilot, join(FIX, 'copilot'))
  const byId = Object.fromEntries(refs.map((ref) => [ref.nativeId, ref]))
  expect(refs).toHaveLength(2)

  const alpha = byId['c51a6cd4-ff7c-40af-ac6b-7ef82da474ca']!
  expect(alpha.cwd).toBe('/root/proj')
  expect(alpha.title).toBe('Chase the duplicate listener')
  expect(alpha.gitBranch).toBe('feature/alpha')
  expect(alpha.turns).toBe(2)
  expect(alpha.startedAt).toBe(Date.parse('2026-08-24T18:13:48.383Z'))
  expect(alpha.endedAt).toBe(Date.parse('2026-08-24T18:13:50.611Z'))
})

test('copilot discover leaves the branch null when the session has none', async () => {
  const { refs } = await sqliteStore.discover(copilot, join(FIX, 'copilot'))
  const ref = refs.find((candidate) => candidate.nativeId === '222fe270-df55-4a9a-8afd-2821ed25322d')!
  expect(ref.gitBranch).toBe(null)
})

test('copilot hydrate splits turns into prompts and prose in turn order', async () => {
  const { refs } = await sqliteStore.discover(copilot, join(FIX, 'copilot'))
  const ref = refs.find((candidate) => candidate.nativeId === 'c51a6cd4-ff7c-40af-ac6b-7ef82da474ca')!
  const doc = await sqliteStore.hydrate(copilot, join(FIX, 'copilot'), ref, DEFAULT_CONFIG)
  expect(doc.prompts).toEqual(['Chase the duplicate listener', 'Now check the teardown path'])
  expect(doc.prose).toEqual(['The listener is attached twice.'])
})

test('copilot resume attaches by id using the form the CLI itself prints', () => {
  expect(copilot.tier).toBe('resume')
  expect(renderArgs(copilot.resume!.args, { id: 'abc-123', cwd: '/root/proj' }))
    .toEqual(['--resume=abc-123'])
})

test('an absent store is a zero-session answer, not a warning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-absent-'))
  tempDirs.push(root)
  const manifest = validateManifest({
    ...copilotManifest, roots: [root],
  })
  const { refs, diagnostics } = await sqliteStore.discover(manifest, root)

  // The client's root exists but it was never used, so there is simply
  // nothing to report. A diagnostic here would mark discovery non-authoritative
  // and switch off missing-session pruning for the client.
  expect(refs).toEqual([])
  expect(diagnostics).toEqual([])
})

test('a store escaping the manifest root is still refused, and says so', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-escape-'))
  tempDirs.push(root)
  const manifest = validateManifest({
    ...copilotManifest,
    roots: [root],
    sqlite: { ...copilotManifest.sqlite, file: '../outside.db' },
  })
  const { refs, diagnostics } = await sqliteStore.discover(manifest, root)

  expect(refs).toEqual([])
  expect(diagnostics).toHaveLength(1)
  expect(diagnostics[0]!.level).toBe('warn')
  expect(diagnostics[0]!.message).toContain('outside the manifest root')
})

test('copilot hydrate reports the files the session touched', async () => {
  const { refs } = await sqliteStore.discover(copilot, join(FIX, 'copilot'))
  const ref = refs.find((candidate) => candidate.nativeId === 'c51a6cd4-ff7c-40af-ac6b-7ef82da474ca')!
  const doc = await sqliteStore.hydrate(copilot, join(FIX, 'copilot'), ref, DEFAULT_CONFIG)

  // Without this the session can never match `search --file`, because a plain
  // text shape carries no tool inputs to recover paths from.
  expect(doc.files).toEqual(['/root/proj/src/listener.ts', '/root/proj/src/teardown.ts'])
})

test('a files query is bounded, and says so when it runs over', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-many-files-'))
  tempDirs.push(root)
  const db = new Database(join(root, 'store.db'), { create: true })
  db.exec('CREATE TABLE f(session_id TEXT, path TEXT)')
  const insert = db.prepare('INSERT INTO f VALUES (?1, ?2)')
  db.exec('BEGIN')
  for (let i = 0; i < 1100; i++) insert.run('one', `/root/proj/file-${i}.ts`)
  db.exec('COMMIT')
  db.close()

  const manifest = validateManifest({
    schema: 1, id: 'many', name: 'many', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'store.db', sessions: "SELECT 'one' AS id",
      files: 'SELECT path AS path FROM f WHERE session_id = ?1',
    },
  })
  const { refs } = await sqliteStore.discover(manifest, root)
  const doc = await sqliteStore.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)

  expect(doc.files).toHaveLength(1024)
  expect(doc.truncated).toBe(true)
})

test('a manifest with only a files query still hydrates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-files-only-'))
  tempDirs.push(root)
  const db = new Database(join(root, 'store.db'), { create: true })
  db.exec('CREATE TABLE f(session_id TEXT, path TEXT)')
  db.prepare('INSERT INTO f VALUES (?1, ?2)').run('one', '/root/proj/only.ts')
  db.close()

  const manifest = validateManifest({
    schema: 1, id: 'files-only', name: 'files only', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'store.db', sessions: "SELECT 'one' AS id",
      files: 'SELECT path AS path FROM f WHERE session_id = ?1',
    },
  })
  const { refs } = await sqliteStore.discover(manifest, root)
  const doc = await sqliteStore.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)

  expect(doc.files).toEqual(['/root/proj/only.ts'])
  expect(doc.prompts).toEqual([])
})

const PART_SQL = 'SELECT m.data AS message_data, p.data AS part_data FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = ?1 ORDER BY p.time_created'

function partStore(prefix: string, message: string, parts: string[]): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(root)
  const db = new Database(join(root, 'sessions.db'), { create: true })
  db.exec(`
    CREATE TABLE message(id TEXT, session_id TEXT, data TEXT);
    CREATE TABLE part(message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `)
  db.run('INSERT INTO message VALUES (?1, ?2, ?3)', ['m1', 'one', message])
  parts.forEach((part, index) => {
    db.run('INSERT INTO part VALUES (?1, ?2, ?3, ?4)', ['m1', 'one', index, part])
  })
  db.close()
  return root
}

function partManifest(id: string, root: string) {
  return validateManifest({
    schema: 1, id, name: id, roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'sessions.db', sessions: "SELECT 'one' AS id",
      text: PART_SQL, textShape: 'opencode-part',
    },
  })
}

test('part projection charges a repeated message only once', async () => {
  const message = JSON.stringify({ id: 'msg_1', role: 'assistant' })
  const parts = ['first answer', 'second answer', 'third answer']
    .map((text) => JSON.stringify({ type: 'text', text }))
  const root = partStore('nekyia-sqlite-part-charge-', message, parts)
  const manifest = partManifest('part-charge', root)

  // The source SQL repeats the owning message on every part row, so the honest
  // budget is the message plus its parts. Charging the message once per row
  // would bill it three times over and drop prose the cap allows.
  const budget = Buffer.byteLength(message)
    + parts.reduce((total, part) => total + Buffer.byteLength(part), 0)
  const { refs } = await sqliteStore.discover(manifest, root)
  const doc = await sqliteStore.hydrate(
    manifest,
    root,
    refs[0]!,
    { ...DEFAULT_CONFIG, maxFileBytes: budget },
  )

  expect(doc.prose).toEqual(['first answer', 'second answer', 'third answer'])
  expect(doc.truncated).toBe(false)
})

test('a part row whose message carries no id keeps paying for that message', async () => {
  const message = JSON.stringify({ role: 'assistant' })
  const parts = ['first answer', 'second answer']
    .map((text) => JSON.stringify({ type: 'text', text }))
  const root = partStore('nekyia-sqlite-part-anon-', message, parts)
  const manifest = partManifest('part-anon', root)

  // Without an id there is nothing to group the rows of one message on, so each
  // row keeps paying in full. Over-charging a message that cannot be identified
  // is deliberate: merging every unidentifiable row would under-charge instead.
  const budget = Buffer.byteLength(message)
    + parts.reduce((total, part) => total + Buffer.byteLength(part), 0)
  const { refs } = await sqliteStore.discover(manifest, root)
  const doc = await sqliteStore.hydrate(
    manifest,
    root,
    refs[0]!,
    { ...DEFAULT_CONFIG, maxFileBytes: budget },
  )

  expect(doc.prose).toEqual(['first answer'])
  expect(doc.truncated).toBe(true)
})

test('paths recovered from tool inputs stop at the per-session ceiling', async () => {
  const message = JSON.stringify({ id: 'msg_1', role: 'assistant' })
  const part = JSON.stringify({
    type: 'tool',
    state: {
      input: {
        edits: Array.from({ length: 1100 }, (_unused, index) => ({
          filePath: `/root/proj/file-${index}.ts`,
        })),
      },
    },
  })
  const root = partStore('nekyia-sqlite-tool-files-', message, [part])
  const manifest = partManifest('tool-files', root)
  const { refs } = await sqliteStore.discover(manifest, root)
  const doc = await sqliteStore.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)

  // A files query is already bounded this way. A tool input is the path most
  // likely to run away, and a partial list must never look like a whole one.
  expect(doc.files).toHaveLength(1024)
  expect(doc.truncated).toBe(true)
})

test('a session id that could never round-trip through a uid is refused, and says so', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sqlite-unsafe-id-'))
  tempDirs.push(root)
  const db = new Database(join(root, 'sessions.db'), { create: true })
  db.exec('CREATE TABLE sessions(id TEXT, ended_at INTEGER)')
  db.run('INSERT INTO sessions VALUES (?1, ?2)', ['ses_fine', 1])
  db.run('INSERT INTO sessions VALUES (?1, ?2)', ['ses\u202ebad', 2])
  db.run('INSERT INTO sessions VALUES (?1, ?2)', ['ses\u0007bad', 3])
  db.run('INSERT INTO sessions VALUES (?1, ?2)', ['x'.repeat(4_096), 4])
  db.close()
  const manifest = validateManifest({
    schema: 1, id: 'unsafe-id', name: 'unsafe id', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: { file: 'sessions.db', sessions: 'SELECT * FROM sessions' },
  })

  const { refs, diagnostics } = await sqliteStore.discover(manifest, root)

  // `forget` refuses such a uid, so indexing the session would leave
  // `prune --client` as the only way to remove it.
  expect(refs.map((ref) => ref.nativeId)).toEqual(['ses_fine'])
  expect(diagnostics).toHaveLength(3)
  for (const entry of diagnostics) {
    expect(entry.level).toBe('warn')
    expect(entry.message).toContain('session skipped')
    // The offending id is never echoed back into a terminal.
    expect(entry.message).not.toContain('\u202e')
  }
})

test('a tool input that survives the size cap but will not parse degrades the document', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-sqlite-bad-input-'))
  tempDirs.push(root)
  const db = new Database(join(root, 'sessions.db'), { create: true })
  db.exec(`
    CREATE TABLE message(id TEXT, session_id TEXT, data TEXT);
    CREATE TABLE part(message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `)
  db.run('INSERT INTO message VALUES (?1, ?2, ?3)', ['m1', 'one', JSON.stringify({ role: 'assistant' })])
  db.run('INSERT INTO part VALUES (?1, ?2, ?3, ?4)', [
    'm1', 'one', 1, JSON.stringify({ type: 'tool', state: { input: '{not json', output: 'private' } }),
  ])
  db.close()
  const text = 'SELECT m.data AS message_data, p.data AS part_data FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = ?1 ORDER BY p.time_created'
  const manifest = validateManifest({
    schema: 1, id: 'bad-input', name: 'bad input', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'sessions.db', sessions: "SELECT 'one' AS id",
      text, textShape: 'opencode-part',
    },
  })
  const { refs } = await sqliteStore.discover(manifest, root)
  const doc = await sqliteStore.hydrate(manifest, root, refs[0]!, DEFAULT_CONFIG)
  // Small enough to pass the projection's ceiling, so the loss is malformed
  // content and not a cap: reporting it as size-capped would be a wrong fix.
  expect(doc.truncated).toBe(false)
  expect(doc.degraded).toBe(true)
})
/**
 * Builds a two-session store in WAL mode, checkpointed so the main file has
 * settled the way an idle client's store looks.
 */
function walStore(): { root: string; path: string; write: (sql: string, ...args: string[]) => void } {
  const root = mkdtempSync(join(tmpdir(), 'nekyia-wal-'))
  tempDirs.push(root)
  const path = join(root, 'store.db')
  const db = new Database(path, { readwrite: true, create: true })
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_updated INTEGER)')
  db.query('INSERT INTO session VALUES (?, ?, ?)').run('one', 'first', 1_000)
  db.query('INSERT INTO session VALUES (?, ?, ?)').run('two', 'second', 1_000)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return {
    root,
    path,
    write: (sql, ...args) => { db.query(sql).run(...args) },
  }
}

function walManifest(root: string, revision?: string) {
  return validateManifest({
    schema: 1, id: 'walclient', name: 'WAL client', roots: [root],
    format: 'sqlite-store', tier: 'search',
    sqlite: {
      file: 'store.db',
      sessions: 'SELECT id AS id, title AS title, time_updated AS ended_at FROM session',
      timeUnit: 'ms',
      ...(revision === undefined ? {} : { revision }),
    },
  })
}

async function fingerprints(manifest: ReturnType<typeof walManifest>, root: string) {
  const { refs } = await sqliteStore.discover(manifest, root)
  return new Map(refs.map((ref) => [ref.nativeId, ref.fingerprint]))
}

test('a commit that lives only in the write-ahead log still changes the fingerprint', async () => {
  // SQLite can commit into the -wal file without touching the main database,
  // so a fingerprint taken from the main file alone reads identically before
  // and after a real edit. The session is then never re-hydrated and the index
  // keeps serving text the source no longer has.
  const store = walStore()
  const manifest = walManifest(store.root)
  const before = await fingerprints(manifest, store.root)

  store.write('UPDATE session SET title = ?, time_updated = ? WHERE id = ?', 'edited', '2000', 'one')

  const after = await fingerprints(manifest, store.root)
  expect(after.get('one')).not.toBe(before.get('one'))
})

test('without a declared revision every session in a store shares one fingerprint', async () => {
  // The safe default. A store that cannot promise its session rows move when a
  // session changes is fingerprinted as a whole, so a change anywhere re-reads
  // everything rather than risking a change nobody noticed.
  const store = walStore()
  const prints = await fingerprints(walManifest(store.root), store.root)
  expect(prints.get('one')).toBe(prints.get('two'))
})

test('a declared revision fingerprints each session on its own row', async () => {
  const store = walStore()
  const manifest = walManifest(store.root, 'ended_at')
  const before = await fingerprints(manifest, store.root)
  expect(before.get('one')).not.toBe(before.get('two'))

  store.write('UPDATE session SET title = ?, time_updated = ? WHERE id = ?', 'edited', '2000', 'one')

  const after = await fingerprints(manifest, store.root)
  // The edited session is re-read, and the untouched one is left alone, which
  // is the whole point of asking a store for a per-session revision.
  expect(after.get('one')).not.toBe(before.get('one'))
  expect(after.get('two')).toBe(before.get('two'))
})

test('a revision naming a column the projection does not return falls back and says so', async () => {
  // A typo in a manifest must not quietly turn change detection off. Falling
  // back to the store-wide fingerprint costs re-reads; trusting a column that
  // is not there would cost updates nobody sees.
  const store = walStore()
  const manifest = walManifest(store.root, 'no_such_column')
  const { refs, diagnostics } = await sqliteStore.discover(manifest, store.root)
  expect(refs[0]!.fingerprint).toBe(refs[1]!.fingerprint)
  expect(diagnostics.some((item) => item.message.includes('revision'))).toBe(true)
})

test('the sqlite reader records the conversation in order too', async () => {
  const { refs } = await sqliteStore.discover(opencode, join(FIX, 'opencode'))
  const ref = refs.find((candidate) => candidate.nativeId === 'ses_aaa')!
  const doc = await sqliteStore.hydrate(opencode, join(FIX, 'opencode'), ref, DEFAULT_CONFIG)
  expect(doc.dialogue).toEqual([
    { role: 'user', text: 'why does the event stream drop' },
    { role: 'assistant', text: 'The reader is not awaited.' },
  ])
})
