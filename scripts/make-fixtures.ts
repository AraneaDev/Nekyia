import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const fixtures = join(import.meta.dir, '../test/fixtures')

function recreate(name: string): Database {
  const path = join(fixtures, name)
  mkdirSync(join(path, '..'), { recursive: true })
  rmSync(path, { force: true })
  return new Database(path, { create: true })
}

const opencode = recreate('opencode/opencode.db')
opencode.exec(`
  CREATE TABLE project(id TEXT PRIMARY KEY, worktree TEXT, vcs TEXT, name TEXT);
  CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
  CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
`)
opencode.run(
  'INSERT INTO project VALUES (?1, ?2, ?3, ?4)',
  ['p1', '/root/proj', 'git', null],
)
const insertOpenCodeSession = opencode.prepare(
  'INSERT INTO session VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
)
insertOpenCodeSession.run(
  'ses_aaa',
  'p1',
  null,
  'witty-nebula',
  '/root/proj',
  'Debug event stream drops',
  '1.1.19',
  1785657600000,
  1785661200000,
)
insertOpenCodeSession.run(
  'ses_bbb',
  'p1',
  'ses_aaa',
  'brave-comet',
  '/root/proj',
  'Debug event stream drops, continued',
  '1.1.19',
  1785661300000,
  1785661900000,
)
const insertOpenCodeMessage = opencode.prepare(
  'INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)',
)
insertOpenCodeMessage.run(
  'm1',
  'ses_aaa',
  1785657600000,
  1785657600000,
  JSON.stringify({ role: 'user', time: { created: 1785657600000 } }),
)
insertOpenCodeMessage.run(
  'm2',
  'ses_aaa',
  1785657700000,
  1785657700000,
  JSON.stringify({ role: 'assistant', time: { created: 1785657700000 } }),
)
const insertOpenCodePart = opencode.prepare(
  'INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
)
insertOpenCodePart.run(
  'p1',
  'm1',
  'ses_aaa',
  1785657600000,
  1785657600000,
  JSON.stringify({ type: 'text', text: 'why does the event stream drop' }),
)
insertOpenCodePart.run(
  'p2',
  'm2',
  'ses_aaa',
  1785657700000,
  1785657700000,
  JSON.stringify({ type: 'text', text: 'The reader is not awaited.' }),
)
insertOpenCodePart.run(
  'p3',
  'm2',
  'ses_aaa',
  1785657800000,
  1785657800000,
  JSON.stringify({
    type: 'tool',
    tool: 'read',
    state: {
      status: 'completed',
      input: { filePath: '/root/proj/src/stream.ts' },
      output: 'SECRET_TOOL_OUTPUT_MUST_NOT_BE_INDEXED',
    },
  }),
)
opencode.close()

const kilo = recreate('kilo/kilo.db')
kilo.exec(`
  CREATE TABLE session(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
  CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
`)
kilo.run(
  'INSERT INTO session VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
  [
    'ses_kkk',
    'p1',
    null,
    'lucky-moon',
    '/root/proj',
    'Kilo session',
    '1.0.0',
    1785657600000,
    1785661200000,
  ],
)
kilo.run(
  'INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)',
  [
    'msg_kkk_user',
    'ses_kkk',
    1785657600000,
    1785657600000,
    JSON.stringify({ role: 'user', time: { created: 1785657600000 } }),
  ],
)
kilo.run(
  'INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  [
    'prt_kkk_user_text',
    'msg_kkk_user',
    'ses_kkk',
    1785657600000,
    1785657600000,
    JSON.stringify({ type: 'text', text: 'review the kilo session' }),
  ],
)
kilo.close()

const agy = recreate('agy/conversation_summaries.db')
agy.exec(`
  CREATE TABLE conversation_summaries(
    conversation_id TEXT,
    title TEXT,
    preview TEXT,
    step_count INTEGER,
    last_modified_time TEXT,
    workspace_uris TEXT,
    status TEXT
  );
`)
agy.run(
  'INSERT INTO conversation_summaries VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  [
    '597b1c48-7b0c-434a-83d6-14e908a699b5',
    '',
    'Autonomous Systems Improvement Framework',
    50,
    '2026-08-04 19:38:58.830144583+00:00',
    JSON.stringify(['file:///root/proj']),
    '',
  ],
)
agy.close()

console.log('fixtures written')
