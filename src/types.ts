/** Identifies one agent CLI. Constrained by isSafeClientId so it survives a round trip through a uid and through terminal output. */
export type ClientId = string

/** Upper bound on a client id, so a hostile manifest cannot produce unbounded uids. */
export const MAX_CLIENT_ID_LENGTH = 256
/** Control and bidi characters, which neither half of a uid may contain. Mirrors the class every command that accepts a uid enforces. */
const UNSAFE_UID_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/

/** Client ids must safely round-trip through UIDs and terminal diagnostics. */
export function isSafeClientId(value: unknown): value is ClientId {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CLIENT_ID_LENGTH
    && !value.includes(':')
    && !UNSAFE_UID_TEXT.test(value)
}

/**
 * Widest uid the commands that accept one will take.
 *
 * `forget`, `show` and the CLI refuse anything longer, so a uid over this
 * length names a session no user can ever reach.
 */
export const MAX_UID_LENGTH = 4_096

/**
 * Upper bound on a native session id.
 *
 * A uid is `client:nativeId`, so the widest client id and its separator have to
 * fit beside it. Bounding the native id against the widest client possible
 * keeps the guarantee independent of which client produced the session.
 */
export const MAX_NATIVE_ID_LENGTH = MAX_UID_LENGTH - 1 - MAX_CLIENT_ID_LENGTH

/**
 * Native ids must survive the same round trip client ids do.
 *
 * The native id is the untrusted half of a uid: it comes from transcript
 * content rather than from a manifest. A session whose id fails this check
 * would still be indexed, searchable and offered in the picker while
 * `nekyia forget <uid>` refused it as malformed, leaving `prune --client`,
 * which deletes every session of that client, as the only way to remove it.
 * Producers therefore reject such a session instead of sanitising the id:
 * sanitising could collapse two distinct sessions onto a single uid.
 */
export function isSafeNativeId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_NATIVE_ID_LENGTH
    && !UNSAFE_UID_TEXT.test(value)
}

/**
 * How far Nekyia can honestly take you back into a session.
 *
 * `resume` attaches to the exact session by id, and only where that command
 * was actually verified. `search` starts a fresh session from a handover.
 * `detected` means a store was found but no launch is claimed.
 */
export type Tier = 'resume' | 'search' | 'detected'

/** Where a client definition came from, so diagnostics can say whether the user or Nekyia is responsible for it. */
export type Origin = 'manifest' | 'user-manifest'

/** The cheap half of a session: metadata and a fingerprint, read during discovery without opening the transcript. */
export interface SessionRef {
  uid: string
  client: ClientId
  nativeId: string
  cwd: string | null
  gitBranch: string | null
  title: string | null
  /** Unix epoch time in milliseconds. */
  startedAt: number
  /** Unix epoch time in milliseconds. */
  endedAt: number
  turns: number | null
  parentNativeId: string | null
  tier: Tier
  origin: Origin
  sourcePaths: string[]
  fingerprint: string
}

/**
 * Per-session ceiling on recorded paths, so one runaway session cannot bloat the index.
 *
 * Every reader that fills `SessionDoc.files` shares it, and marks the document
 * truncated on reaching it rather than quietly returning a partial list.
 */
export const MAX_SESSION_FILES = 1024

/**
 * Per-session ceiling on recorded file events, separate from the path ceiling.
 *
 * A session can name few files and operate on them many times, so the two
 * bounds count different things and each says only what it means: a complete
 * file list next to a capped event log is a normal, honest state.
 */
export const MAX_SESSION_FILE_EVENTS = 4096

/** What a tool call did to the file it named. */
export type FileEventKind = 'read' | 'write' | 'edit' | 'delete' | 'move' | 'unknown'

/**
 * One file operation, as the index is willing to know it.
 *
 * `turn` counts the dialogue turns recorded before the call, which is the index
 * `session_turn` uses, so a reader can jump from an event to what was being
 * said. It counts recorded turns: when assistant prose was dropped over the
 * byte cap the count sits below the true conversation position, so it is a
 * position in the indexed dialogue and never a transcript line number.
 *
 * No content of any kind appears here. The index says where; the transcript
 * says what.
 */
export interface FileEvent {
  path: string
  kind: FileEventKind
  turn: number | null
}

/**
 * The expensive half of a session, produced by hydration.
 *
 * Tool output is deliberately absent: it is large, noisy, and likely to
 * carry private material that has no business in a search index.
 */
export interface SessionDoc {
  ref: SessionRef
  prompts: string[]
  prose: string[]
  /**
   * The same user and assistant text as `prompts` and `prose`, but kept in the
   * order it was said rather than grouped by speaker.
   *
   * The grouped facets are what full-text search ranks and what a handover
   * quotes, so they stay as they are. Only a transcript-style history needs the
   * interleaving, and only a reader that can produce it fills this in: optional,
   * because a format that cannot order its turns must not claim it can.
   */
  dialogue?: DialogueTurn[]
  files: string[]
  /**
   * The same operations as `files`, kept in the order they happened rather than
   * deduplicated by path.
   *
   * Optional, like `dialogue`: a reader that cannot order its file operations
   * must not claim it can. `files` keeps its own meaning and its own cap, and
   * nothing that reads it is affected by this being present or absent.
   */
  fileEvents?: FileEvent[]
  /**
   * What this reader could see: `ordered` for operations in order, `paths` for
   * file names only. Absent means `paths`, because a reader running under this
   * schema would have said `ordered` if it could. The third level, `unknown`,
   * is reachable only through the migration default, which is what makes it
   * mean "indexed before file events" rather than "this client never will".
   */
  fileDetail?: 'paths' | 'ordered'
  /** `MAX_SESSION_FILE_EVENTS` stopped the log short. Distinct from `truncated`, which no setting change fixes here. */
  fileEventsTruncated?: boolean
  /**
   * A size cap stopped the read short: the whole file was over `maxFileBytes`,
   * a running byte budget ran out, or a single value was too large to keep.
   * Raising the cap can recover the missing content, and `doctor` says so.
   */
  truncated: boolean
  /**
   * Content was lost to a parse or read failure rather than to a cap: a
   * malformed element, an unreadable sidecar, a source that could not be
   * located. No setting recovers it, so it must never be reported as a cap.
   *
   * Optional because most readers never lose content this way, and a producer
   * that cannot degrade should not have to say so on every document it builds.
   */
  degraded?: boolean
}

/** One thing said in a session, by whom, in the order the transcript recorded it. */
export interface DialogueTurn {
  role: 'user' | 'assistant'
  text: string
}

/**
 * A fully resolved command to launch, with the directory it must run in.
 *
 * `kind` records whether this attaches to the original session or starts a
 * fresh one from a handover, so the caller never implies more than it can deliver.
 */
export interface ExecPlan {
  kind: 'resume' | 'brief'
  cmd: string
  args: string[]
  cwd: string
  prompt?: string
}

/** Severity of a diagnostic. Anything above `ok` marks a client's discovery as non-authoritative. */
export type DiagnosticLevel = 'ok' | 'warn' | 'error'

/** One thing Nekyia could not do, named plainly, with the path that caused it. */
export interface Diagnostic {
  client: ClientId
  level: DiagnosticLevel
  path: string | null
  message: string
}

/** Builds the index-wide identifier for a session. The client id cannot contain a colon, so the first colon always separates the two halves. */
export function makeUid(client: ClientId, nativeId: string): string {
  return `${client}:${nativeId}`
}

/** Splits a uid back into its client and native id, throwing rather than guessing when the shape is wrong. */
export function parseUid(uid: string): { client: ClientId; nativeId: string } {
  const separator = uid.indexOf(':')

  if (separator <= 0 || separator === uid.length - 1) {
    throw new Error(`malformed uid: ${uid}`)
  }

  return {
    client: uid.slice(0, separator),
    nativeId: uid.slice(separator + 1),
  }
}
