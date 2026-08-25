export type ClientId = string

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

export type Tier = 'resume' | 'search' | 'detected'

export type Origin = 'manifest' | 'user-manifest' | 'sniffed'

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

export interface SessionDoc {
  ref: SessionRef
  prompts: string[]
  prose: string[]
  /** Ordered user and assistant text for transcript-style history views. */
  dialogue?: DialogueTurn[]
  files: string[]
  truncated: boolean
}

export interface DialogueTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface ExecPlan {
  kind: 'resume' | 'brief'
  cmd: string
  args: string[]
  cwd: string
  prompt?: string
}

export type DiagnosticLevel = 'ok' | 'warn' | 'error'

export interface Diagnostic {
  client: ClientId
  level: DiagnosticLevel
  path: string | null
  message: string
}

export function makeUid(client: ClientId, nativeId: string): string {
  return `${client}:${nativeId}`
}

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
