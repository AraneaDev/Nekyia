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
  ['p1', '/home/dev/work/proj', 'git', null],
)
const insertOpenCodeSession = opencode.prepare(
  'INSERT INTO session VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
)
insertOpenCodeSession.run(
  'ses_aaa',
  'p1',
  null,
  'witty-nebula',
  '/home/dev/work/proj',
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
  '/home/dev/work/proj',
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
      input: { filePath: '/home/dev/work/proj/src/stream.ts' },
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
    '/home/dev/work/proj',
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
    'Retry Budget Review',
    50,
    '2026-08-04 19:38:58.830144583+00:00',
    JSON.stringify(['file:///home/dev/work/proj']),
    '',
  ],
)
agy.close()

const copilot = recreate('copilot/session-store.db')
copilot.exec(`
  CREATE TABLE sessions(
    id TEXT PRIMARY KEY,
    cwd TEXT,
    repository TEXT,
    host_type TEXT,
    branch TEXT,
    summary TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE turns(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    turn_index INTEGER NOT NULL,
    user_message TEXT,
    assistant_response TEXT,
    timestamp TEXT,
    UNIQUE(session_id, turn_index)
  );
  CREATE TABLE session_files(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    file_path TEXT NOT NULL,
    tool_name TEXT,
    turn_index INTEGER,
    UNIQUE(session_id, file_path)
  );
`)
const insertCopilotSession = copilot.prepare(
  'INSERT INTO sessions VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
)
insertCopilotSession.run(
  'c51a6cd4-ff7c-40af-ac6b-7ef82da474ca',
  '/home/dev/work/proj',
  'example-org/probe-alpha',
  'github',
  'feature/alpha',
  'Chase the duplicate listener',
  '2026-08-24T18:13:48.383Z',
  '2026-08-24T18:13:50.611Z',
)
// A session outside a repository: Copilot leaves branch and repository null.
insertCopilotSession.run(
  '222fe270-df55-4a9a-8afd-2821ed25322d',
  '/home/dev/work/other',
  null,
  null,
  null,
  'Rename the sidecar loader',
  '2026-08-24T18:14:02.271Z',
  '2026-08-24T18:14:04.260Z',
)
const insertCopilotTurn = copilot.prepare(
  'INSERT INTO turns(session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?1, ?2, ?3, ?4, ?5)',
)
insertCopilotTurn.run(
  'c51a6cd4-ff7c-40af-ac6b-7ef82da474ca',
  0,
  'Chase the duplicate listener',
  'The listener is attached twice.',
  '2026-08-24T18:13:52.015Z',
)
// A turn still in flight: the user message is stored before any reply exists.
insertCopilotTurn.run(
  'c51a6cd4-ff7c-40af-ac6b-7ef82da474ca',
  1,
  'Now check the teardown path',
  null,
  '2026-08-24T18:13:59.500Z',
)
insertCopilotTurn.run(
  '222fe270-df55-4a9a-8afd-2821ed25322d',
  0,
  'Rename the sidecar loader',
  'Renamed it to loadSidecar.',
  '2026-08-24T18:14:21.400Z',
)
const insertCopilotFile = copilot.prepare(
  'INSERT INTO session_files(session_id, file_path, tool_name, turn_index) VALUES (?1, ?2, ?3, ?4)',
)
insertCopilotFile.run(
  'c51a6cd4-ff7c-40af-ac6b-7ef82da474ca', '/home/dev/work/proj/src/listener.ts', 'edit', 0,
)
insertCopilotFile.run(
  'c51a6cd4-ff7c-40af-ac6b-7ef82da474ca', '/home/dev/work/proj/src/teardown.ts', 'create', 1,
)
// A blank path: the store is the client's, so it is not assumed to be clean.
insertCopilotFile.run('c51a6cd4-ff7c-40af-ac6b-7ef82da474ca', '   ', 'edit', 1)
copilot.close()

// goose stores one SQLite database for Desktop and CLI alike. The columns here
// follow goose's own reader: sessions keyed by `id` with `working_dir`, and
// messages whose `content_json` is a JSON array of typed blocks.
const goose = recreate('goose/sessions.db')
goose.exec(`
  CREATE TABLE sessions(id TEXT PRIMARY KEY, name TEXT, description TEXT, session_type TEXT, working_dir TEXT, parent_session_id TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE messages(id INTEGER PRIMARY KEY, message_id TEXT, session_id TEXT, role TEXT, content_json TEXT, created_timestamp INTEGER);
`)
const insertGooseSession = goose.prepare(
  'INSERT INTO sessions VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
)
// The three timestamp encodings goose's reader tolerates in one column: an ISO
// string, unix seconds, and unix milliseconds. The manifest normalises all
// three to milliseconds in SQL, so each one needs a row to normalise.
insertGooseSession.run(
  '20260218_1', 'daily', 'Rework the retry budget', 'user',
  '/home/dev/work/proj', null, '2026-02-18T09:20:00Z', '2026-02-18T10:05:00Z',
)
insertGooseSession.run(
  '20260218_2', 'seconds', 'Session timed in unix seconds', 'user',
  '/home/dev/work/proj', '20260218_1', '1771406400', '1771410000',
)
insertGooseSession.run(
  '20260218_3', 'millis', 'Session timed in unix milliseconds', 'user',
  '/home/dev/work/other', null, '1771406400000', '1771410000000',
)
const insertGooseMessage = goose.prepare(
  'INSERT INTO messages VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
)
insertGooseMessage.run(
  1, 'msg_g_user', '20260218_1', 'user',
  JSON.stringify([{ type: 'text', text: 'raise the retry budget' }]),
  1771406400000,
)
// Two text blocks in one message: goose concatenates them, so the reader must
// not drop the second.
insertGooseMessage.run(
  2, 'msg_g_asst', '20260218_1', 'assistant',
  JSON.stringify([
    { type: 'text', text: 'Raised it to five.' },
    { type: 'text', text: 'The backoff is unchanged.' },
  ]),
  1771406460000,
)
// A tool block beside a text one. Only the text is indexed; the marker proves
// the tool payload never reaches the index.
insertGooseMessage.run(
  3, 'msg_g_tool', '20260218_1', 'assistant',
  JSON.stringify([
    { type: 'toolResponse', text: 'SECRET_TOOL_OUTPUT_MUST_NOT_BE_INDEXED' },
    { type: 'text', text: 'Read the config.' },
  ]),
  1771406520000,
)
// A session whose content_json is absent. goose defaults it to '[]', and the
// manifest's COALESCE has to do the same rather than drop the row.
insertGooseMessage.run(4, 'msg_g_empty', '20260218_2', 'user', null, 1771406400000)
goose.close()

console.log('fixtures written')
