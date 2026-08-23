export type ClientId = string

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
  files: string[]
  truncated: boolean
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
