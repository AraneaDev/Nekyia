/**
 * Seeds an index of invented sessions for screenshots and demos.
 *
 * The picker reads whatever index XDG_DATA_HOME points at, so this never sees
 * or touches a real history:
 *
 *   bun run scripts/demo-index.ts /tmp/nekyia-demo
 *   XDG_DATA_HOME=/tmp/nekyia-demo XDG_CONFIG_HOME=/tmp/nekyia-demo nekyia
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IndexDb } from '../src/core/db'
import type { SessionRef, Tier } from '../src/types'

const root = process.argv[2] ?? '/tmp/nekyia-demo'
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Ages are relative to the run, so a screenshot always reads as recent work. */
const NOW = Date.now()

interface Seed {
  client: string
  project: string
  title: string
  ageMs: number
  turns: number
  tier: Tier
  branch: string
  prompts?: string[]
  replies?: string[]
  files?: string[]
}

const SEEDS: Seed[] = [
  {
    client: 'claude', project: 'api-gateway', branch: 'main', ageMs: 22 * 60_000, turns: 41,
    tier: 'resume', title: 'the retry budget is shared across tenants, it should be per tenant',
    prompts: [
      'the retry budget is shared across tenants, it should be per tenant',
      'walk me through where the budget is decremented',
      'why is it keyed by route at all?',
      'show me what breaks if the key changes',
      'does the hedging path read the same counter?',
      'add a test that a noisy tenant cannot starve a quiet one',
      'what happens on the first request for an unseen tenant?',
      'make the default budget configurable per tenant',
      'the integration test is flaky now, is that us?',
      'run it twenty times and tell me the failure rate',
      'ok, pin the clock in that test instead of sleeping',
      'update the rate-limits doc to describe per-tenant budgets',
    ],
    replies: [
      'The budget lives on the client, so every tenant draws from the same counter.',
      'Decremented in retry-budget.ts before the hedge fires, keyed by route rather than tenant.',
      'Moving the key to the tenant id fixes the sharing without touching the hedging path.',
      'Route was the original key because budgets predate tenancy; nothing depends on it now.',
      'Changing the key alters two call sites and one test fixture, nothing in the wire format.',
      'The hedging path reads the same counter, so it inherits the fix rather than needing one.',
      'Added a test with one tenant spending its budget while another still gets its retries.',
      'An unseen tenant starts at the full default rather than at zero, which matches the docs.',
      'Made the default overridable per tenant, falling back to the global value when unset.',
      'The flake predates this: the test slept 50ms and CI is slower than that under load.',
      'Twenty runs, three failures, all the same sleep. Pinning the clock takes it to zero.',
      'Rewrote it against an injected clock, so it no longer depends on how busy the runner is.',
      'Updated rate-limits.md to describe per-tenant budgets and the fallback.',
    ],
    files: [
      'src/gateway/retry-budget.ts', 'src/gateway/tenant.ts', 'src/gateway/router.ts',
      'test/retry-budget.test.ts', 'docs/rate-limits.md',
    ],
  },
  {
    client: 'claude', project: 'billing-svc', branch: 'fix/idempotency', ageMs: 3 * HOUR, turns: 28,
    tier: 'resume', title: 'a retried charge can double bill when the webhook lands twice',
    prompts: ['a retried charge can double bill when the webhook lands twice'],
    replies: [
      'The handler is idempotent on charge id but the webhook carries a delivery id.',
      'Storing the delivery id and rejecting a repeat closes it.',
    ],
    files: ['src/billing/webhook.ts', 'src/billing/charge.ts', 'test/webhook.test.ts'],
  },
  {
    client: 'codex', project: 'api-gateway', branch: 'main', ageMs: 6 * HOUR, turns: 12,
    tier: 'search', title: 'add structured logging around the upstream timeout path',
    files: ['src/gateway/logging.ts'],
  },
  {
    client: 'claude', project: 'web-console', branch: 'feat/filters', ageMs: 9 * HOUR, turns: 63,
    tier: 'resume', title: 'the saved filter chips lose their order after a reload',
    prompts: ['the saved filter chips lose their order after a reload'],
    files: ['app/filters/store.ts', 'app/filters/Chips.tsx', 'app/filters/persist.ts'],
  },
  {
    client: 'opencode', project: 'billing-svc', branch: 'main', ageMs: 14 * HOUR, turns: 19,
    tier: 'search', title: 'port the invoice numbering to the new sequence table',
    files: ['migrations/0042_invoice_seq.sql', 'src/billing/invoice.ts'],
  },
  {
    client: 'claude', project: 'infra', branch: 'main', ageMs: DAY, turns: 34, tier: 'resume',
    title: 'the nightly restore drill fails whenever the snapshot is older than a week',
    prompts: ['the nightly restore drill fails whenever the snapshot is older than a week'],
    files: ['terraform/backups.tf', 'scripts/restore-drill.sh', 'docs/runbook-restore.md'],
  },
  {
    client: 'codebuff', project: 'search-svc', branch: 'main', ageMs: DAY + 4 * HOUR, turns: 22,
    tier: 'search', title: 'stemming is applied twice for german, so plurals miss',
    files: ['src/search/analyzer.rs', 'src/search/lang/de.rs'],
  },
  {
    client: 'claude', project: 'web-console', branch: 'main', ageMs: 2 * DAY, turns: 17,
    tier: 'resume', title: 'make the empty state say what to do next instead of just being empty',
    prompts: ['make the empty state say what to do next instead of just being empty'],
    files: ['app/components/EmptyState.tsx'],
  },
  {
    client: 'kilo', project: 'search-svc', branch: 'main', ageMs: 2 * DAY + 5 * HOUR, turns: 8,
    tier: 'search', title: 'sketch a relevance scoring change and argue against it',
  },
  {
    client: 'claude', project: 'api-gateway', branch: 'fix/hedging', ageMs: 3 * DAY, turns: 51,
    tier: 'resume', title: 'hedged requests are firing even when the first response already won',
    prompts: ['hedged requests are firing even when the first response already won'],
    files: ['src/gateway/hedge.ts', 'src/gateway/client.ts', 'test/hedge.test.ts', 'docs/hedging.md'],
  },
  {
    client: 'agy', project: 'infra', branch: 'main', ageMs: 3 * DAY + 7 * HOUR, turns: 15,
    tier: 'search', title: 'draft the incident review for the certificate expiry',
    files: ['docs/incidents/2026-03-cert-expiry.md'],
  },
  {
    client: 'claude', project: 'billing-svc', branch: 'main', ageMs: 4 * DAY, turns: 26,
    tier: 'resume', title: 'refunds past ninety days should fail loudly, not silently no-op',
    prompts: ['refunds past ninety days should fail loudly, not silently no-op'],
    files: ['src/billing/refund.ts', 'test/refund.test.ts'],
  },
  {
    client: 'codex', project: 'web-console', branch: 'main', ageMs: 5 * DAY, turns: 9,
    tier: 'search', title: 'convert the settings page to the new form primitives',
    files: ['app/settings/page.tsx', 'app/settings/form.tsx'],
  },
  {
    client: 'claude', project: 'search-svc', branch: 'perf/segments', ageMs: 6 * DAY, turns: 44,
    tier: 'resume', title: 'segment merges stall the write path for seconds at a time',
    prompts: ['segment merges stall the write path for seconds at a time'],
    files: ['src/search/segment.rs', 'src/search/merge.rs', 'bench/merge.rs'],
  },
  {
    client: 'opencode', project: 'infra', branch: 'main', ageMs: 8 * DAY, turns: 11,
    tier: 'search', title: 'pin the runner image so builds stop drifting between weeks',
    files: ['.github/workflows/ci.yml'],
  },
  {
    client: 'claude', project: 'web-console', branch: 'main', ageMs: 9 * DAY, turns: 30,
    tier: 'resume', title: 'the table header detaches from the body on a narrow viewport',
    prompts: ['the table header detaches from the body on a narrow viewport'],
    files: ['app/components/Table.tsx', 'app/styles/table.css'],
  },
  {
    client: 'codebuff', project: 'api-gateway', branch: 'main', ageMs: 11 * DAY, turns: 7,
    tier: 'search', title: 'explain how the circuit breaker decides to half-open',
  },
  {
    client: 'claude', project: 'infra', branch: 'main', ageMs: 13 * DAY, turns: 38,
    tier: 'resume', title: 'split the monolithic terraform state before it takes an hour to plan',
    prompts: ['split the monolithic terraform state before it takes an hour to plan'],
    files: ['terraform/main.tf', 'terraform/network.tf', 'terraform/data.tf', 'docs/tf-layout.md'],
  },
  {
    client: 'claude', project: 'billing-svc', branch: 'main', ageMs: 16 * DAY, turns: 21,
    tier: 'resume', title: 'proration is off by a day whenever the plan changes on the first',
    prompts: ['proration is off by a day whenever the plan changes on the first'],
    files: ['src/billing/proration.ts', 'test/proration.test.ts'],
  },
  {
    client: 'kilo', project: 'web-console', branch: 'main', ageMs: 20 * DAY, turns: 6,
    tier: 'search', title: 'compare two approaches to optimistic updates',
  },
  {
    client: 'claude', project: 'search-svc', branch: 'main', ageMs: 24 * DAY, turns: 33,
    tier: 'resume', title: 'highlighting drops the match when it straddles a token boundary',
    prompts: ['highlighting drops the match when it straddles a token boundary'],
    files: ['src/search/highlight.rs', 'test/highlight.rs'],
  },
  {
    client: 'agy', project: 'api-gateway', branch: 'main', ageMs: 29 * DAY, turns: 13,
    tier: 'search', title: 'write the migration note for the header rename',
    files: ['docs/migrations/header-rename.md'],
  },
]

function seedRef(seed: Seed, index: number): SessionRef {
  const endedAt = NOW - seed.ageMs
  return {
    uid: `${seed.client}:demo-${String(index).padStart(3, '0')}`,
    client: seed.client,
    nativeId: `demo-${String(index).padStart(3, '0')}`,
    cwd: `/home/dev/work/${seed.project}`,
    gitBranch: seed.branch,
    title: seed.title,
    startedAt: endedAt - seed.turns * 90_000,
    endedAt,
    turns: seed.turns,
    parentNativeId: null,
    tier: seed.tier,
    origin: 'manifest',
    sourcePaths: [],
    fingerprint: `demo-${index}`,
  }
}

rmSync(root, { recursive: true, force: true })
const data = join(root, 'nekyia')
mkdirSync(data, { recursive: true, mode: 0o700 })
chmodSync(data, 0o700)

// The picker asks for indexing consent on a fresh data directory, and would
// then offer to read the real history. Recording consent up front keeps the
// demo pointed at nothing but its own seeded index.
const consent = join(data, 'consent-v1')
writeFileSync(consent, 'nekyia-index-consent-v1\n', { mode: 0o600 })
chmodSync(consent, 0o600)

const db = IndexDb.open(join(data, 'index.db'))
SEEDS.forEach((seed, index) => {
  const ref = seedRef(seed, index)
  db.upsertRef(ref)
  db.upsertDoc({
    ref,
    prompts: seed.prompts ?? [],
    prose: seed.replies ?? [],
    files: (seed.files ?? []).map((file) => `/home/dev/work/${seed.project}/${file}`),
    truncated: false,
  })
})

console.log(`seeded ${SEEDS.length} demo sessions into ${join(data, 'index.db')}`)
console.log(`run: XDG_DATA_HOME=${root} XDG_CONFIG_HOME=${root} nekyia`)
