/** Identifies one agent CLI. Constrained by isSafeClientId so it survives a round trip through a uid and through terminal output. */
export type ClientId = string

/** Upper bound on a client id, so a hostile manifest cannot produce unbounded uids. */
export const MAX_CLIENT_ID_LENGTH = 256
const UNSAFE_CLIENT_ID = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/

/** Client ids must safely round-trip through UIDs and terminal diagnostics. */
export function isSafeClientId(value: unknown): value is ClientId {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CLIENT_ID_LENGTH
    && !value.includes(':')
    && !UNSAFE_CLIENT_ID.test(value)
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
export type Origin = 'manifest' | 'user-manifest' | 'sniffed'

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
 * The expensive half of a session, produced by hydration.
 *
 * Tool output is deliberately absent: it is large, noisy, and likely to
 * carry private material that has no business in a search index.
 */
export interface SessionDoc {
  ref: SessionRef
  prompts: string[]
  prose: string[]
  files: string[]
  truncated: boolean
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
