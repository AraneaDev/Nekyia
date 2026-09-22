import type { Row } from './core/query'
import { boundedDisplayText } from './tui/text'

/** Version of the machine-readable output contract. */
export const AGENT_CONTRACT_VERSION = 1

/** Launch capability represented by an indexed session. */
export type AgentCapability = 'resume' | 'search' | 'detected'

/** Extraction quality state an agent must inspect before trusting context. */
export interface AgentQuality {
  missing: boolean
  truncated: boolean
  degraded: boolean
  fileDetail: 'unknown' | 'paths' | 'ordered'
  eventsTruncated: boolean
}

/** Versioned public representation of one search result. */
export interface AgentSearchRow {
  contractVersion: number
  uid: string
  client: string
  nativeId: string
  cwd: string | null
  gitBranch: string | null
  title: string | null
  startedAt: number
  endedAt: number
  turns: number | null
  parentNativeId: string | null
  tier: AgentCapability
  capability: AgentCapability
  origin: string
  score: number
  collapsed: number
  sourcePaths: string[]
  quality: AgentQuality
  limitations: string[]
  matchedUid?: string
  launcher?: string
}

/** Versioned public representation of one structured session export. */
export interface AgentContext {
  contractVersion: number
  uid: string
  client: string
  nativeId: string
  cwd: string | null
  gitBranch: string | null
  title: string | null
  startedAt: number
  endedAt: number
  turns: number | null
  tier: AgentCapability
  origin: string
  sourcePaths: string[]
  prompts: string[]
  assistantProse: string[]
  dialogue: Array<{ role: 'user' | 'assistant'; text: string }>
  files: string[]
  events: Array<{ ordinal: number; turn: number | null; path: string; kind: string }>
  quality: AgentQuality
  limitations: string[]
}

/** Machine-readable command failure envelope. */
export interface AgentError {
  version: number
  error: { code: string; message: string }
}

/** Emits one bounded JSON error object for callers that explicitly requested JSON. */
export function emitAgentError(code: string, message: string): void {
  const output: AgentError = {
    version: AGENT_CONTRACT_VERSION,
    error: {
      code: boundedDisplayText(code, 128) || 'error',
      message: boundedDisplayText(message, 512) || 'unknown error',
    },
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

/** Optional quality fields attached to a narrow query result. */
type QualityInput = Row & Partial<{
  truncated: boolean
  degraded: boolean
  fileDetail: 'unknown' | 'paths' | 'ordered'
  eventsTruncated: boolean
}>

/** Derives stable limitation codes from indexed quality and launch state. */
function limitationsFor(input: QualityInput): string[] {
  const limitations: string[] = []
  if (input.missing) limitations.push('source-missing')
  if (input.truncated) limitations.push('content-truncated')
  if (input.degraded) limitations.push('content-degraded')
  if (input.fileDetail !== 'ordered') limitations.push('file-events-unordered')
  if (input.eventsTruncated) limitations.push('file-events-truncated')
  if (input.tier === 'detected') limitations.push('not-launchable')
  return limitations
}

/** Converts one indexed row into the bounded, versioned agent contract. */
export function serializeSearchRow(input: QualityInput, sourcePaths: string[]): AgentSearchRow {
  const quality: AgentQuality = {
    missing: input.missing,
    truncated: input.truncated === true,
    degraded: input.degraded === true,
    fileDetail: input.fileDetail ?? 'unknown',
    eventsTruncated: input.eventsTruncated === true,
  }
  return {
    contractVersion: AGENT_CONTRACT_VERSION,
    uid: boundedDisplayText(input.uid, 4096),
    client: boundedDisplayText(input.client, 256),
    nativeId: boundedDisplayText(input.nativeId, 4096),
    cwd: input.cwd === null ? null : boundedDisplayText(input.cwd, 4096),
    gitBranch: input.gitBranch === null ? null : boundedDisplayText(input.gitBranch, 4096),
    title: input.title === null ? null : boundedDisplayText(input.title, 4096),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    turns: input.turns,
    parentNativeId: input.parentNativeId,
    tier: input.tier,
    capability: input.tier,
    origin: input.origin,
    score: input.score,
    collapsed: input.collapsed,
    sourcePaths: sourcePaths.map((path) => boundedDisplayText(path, 4096)),
    quality,
    limitations: limitationsFor(input),
    ...(input.matchedUid === undefined ? {} : { matchedUid: input.matchedUid }),
    ...(input.launcher === undefined ? {} : { launcher: input.launcher }),
  }
}
