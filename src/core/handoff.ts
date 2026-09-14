import { buildBrief, type BriefOpts } from './brief'
import type { Adapter } from './adapter'
import type { IndexDb } from './db'
import type { ClientId, ExecPlan } from '../types'

/** Character budget follows the brief builder's prompt-preserving contract. */
export type HandoffOpts = BriefOpts

/** How the target should treat a handover: pick up the work, or critique it instead of extending it. */
export type HandoffIntent = 'continue' | 'review'

/** Told once here so the CLI and the TUI picker offer the identical wording. */
const REVIEW_PREAMBLE = 'Review this session’s changes critically rather than continuing them: look for bugs, missed edge cases, and better approaches instead of treating the work as already correct.'

/** A custom note fits one instruction, not an essay; the brief itself carries the real context. Shared so the CLI and the TUI enforce the same cap. */
export const MAX_HANDOFF_NOTE_LENGTH = 2_000

/** The preamble a built-in intent contributes to a brief. `continue` adds nothing: it is today's default framing, named only so callers can pass it explicitly. */
export function preambleForIntent(intent: HandoffIntent): string | undefined {
  return intent === 'review' ? REVIEW_PREAMBLE : undefined
}

/** A fresh-session launch plan, or the reason it could not be built. */
export type HandoffResult =
  | { ok: true; plan: ExecPlan; briefChars: number }
  | { ok: false; reason: string }

/** Builds a fresh target session from the source's last indexed context. */
export function buildHandoffPlan(
  db: IndexDb,
  uid: string,
  targetClient: ClientId,
  adapters: Adapter[],
  opts: HandoffOpts = {},
): HandoffResult {
  const ref = db.getRef(uid)
  if (!ref) return { ok: false, reason: `no session with uid ${uid}` }
  const target = adapters.find((adapter) => adapter.id === targetClient)
  if (!target) return { ok: false, reason: `no adapter for ${targetClient}` }
  const brief = buildBrief(db, uid, opts)
  if (!brief) return { ok: false, reason: 'nothing indexed for this session yet' }
  const plan = target.plan(ref, brief)
  if (!plan || plan.kind !== 'brief') {
    return { ok: false, reason: 'this session cannot be launched' }
  }
  return { ok: true, plan, briefChars: brief.length }
}
