import { buildBrief, type BriefOpts } from './brief'
import type { Adapter } from './adapter'
import type { IndexDb } from './db'
import type { ClientId, ExecPlan } from '../types'

/** Character budget follows the brief builder's prompt-preserving contract. */
export type HandoffOpts = BriefOpts

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
