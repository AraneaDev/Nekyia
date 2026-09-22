import { AGENT_CONTRACT_VERSION, type AgentContext } from '../agent-contract'
import type { IndexDb } from './db'

/** Stored full-text facets for one hydrated session. */
interface StoredText {
  prompts: string | null
  prose: string | null
}

/** One ordered dialogue row from the index. */
interface StoredTurn {
  role: 'user' | 'assistant'
  text: string
}

const DEFAULT_MAX_CHARS = 40_000

/** Validates the structured export character budget. */
function budgetOf(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CHARS
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('maxChars must be a non-negative safe integer')
  return value
}

/** Splits grouped text facets without inventing boundaries beyond newlines. */
function splitStored(value: string | null): string[] {
  return value ? value.split('\n').filter((entry) => entry.length > 0) : []
}

/** Reads ordered turns when the current index schema contains that table. */
function readDialogue(db: IndexDb, uid: string): StoredTurn[] {
  try {
    return db.raw().query(
      'SELECT role, text FROM session_turn WHERE uid = ? ORDER BY ordinal',
    ).all(uid) as StoredTurn[]
  } catch {
    return []
  }
}

/** Builds bounded structured context from the read-only index, without opening a transcript. */
export function buildContext(
  db: IndexDb,
  uid: string,
  opts: { maxChars?: number } = {},
): AgentContext | null {
  const ref = db.getRef(uid)
  if (!ref) return null
  const text = db.raw().query(
    'SELECT prompts, prose FROM session_text WHERE uid = ?',
  ).get(uid) as StoredText | null
  if (!text) return null

  const dialogue = readDialogue(db, uid)
  const prompts = dialogue.length > 0
    ? dialogue.filter((turn) => turn.role === 'user').map((turn) => turn.text)
    : splitStored(text.prompts)
  const assistantProse = dialogue.length > 0
    ? dialogue.filter((turn) => turn.role === 'assistant').map((turn) => turn.text)
    : splitStored(text.prose)
  const details = db.fileDetailsFor([uid]).get(uid) ?? { detail: 'unknown', eventsTruncated: false }
  const events = db.fileEventsFor([uid])
    .filter((event) => event.uid === uid)
    .map(({ ordinal, turn, path, kind }) => ({ ordinal, turn, path, kind }))
  const files = db.fileFacetsForUid(uid)
  const limitations: string[] = []
  if (ref.missing) limitations.push('source-missing')
  if (ref.truncated) limitations.push('content-truncated')
  if (ref.degraded) limitations.push('content-degraded')
  if (details.detail !== 'ordered') limitations.push('file-events-unordered')
  if (details.eventsTruncated) limitations.push('file-events-truncated')

  const context: AgentContext = {
    contractVersion: AGENT_CONTRACT_VERSION,
    uid: ref.uid,
    client: ref.client,
    nativeId: ref.nativeId,
    cwd: ref.cwd,
    gitBranch: ref.gitBranch,
    title: ref.title,
    startedAt: ref.startedAt,
    endedAt: ref.endedAt,
    turns: ref.turns,
    tier: ref.tier,
    origin: ref.origin,
    sourcePaths: [...ref.sourcePaths],
    prompts,
    assistantProse,
    dialogue,
    files,
    events,
    quality: {
      missing: ref.missing,
      truncated: ref.truncated,
      degraded: ref.degraded,
      fileDetail: details.detail as 'unknown' | 'paths' | 'ordered',
      eventsTruncated: details.eventsTruncated,
    },
    limitations,
  }

  const budget = budgetOf(opts.maxChars)
  if (JSON.stringify(context).length <= budget) return context

  context.assistantProse = []
  context.dialogue = context.dialogue.filter((turn) => turn.role === 'user')
  context.limitations = [...context.limitations, 'budget-trimmed']
  while (context.files.length > 0 && JSON.stringify(context).length > budget) context.files.pop()
  return context
}
