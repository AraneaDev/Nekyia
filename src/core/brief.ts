import type { IndexDb } from './db'

export interface BriefOpts {
  /** Roughly four characters per token, so 40,000 is about 10k tokens. */
  maxChars?: number
}

interface StoredText {
  prompts: string
  prose: string
}

const DEFAULT_MAX_CHARS = 40_000
const FILE_LIMIT = 40

// Keep line feeds and tabs, but do not let indexed text execute terminal controls.
function safeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

function oneLine(value: string): string {
  return safeText(value).replace(/[\r\n]+/g, ' ').trim()
}

function timestamp(value: number): string {
  if (!Number.isFinite(value)) return '(unknown)'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '(unknown)' : date.toISOString()
}

function budgetOf(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CHARS
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('maxChars must be a non-negative safe integer')
  }
  return value
}

/**
 * Build a deterministic, model-free handover from the privacy-filtered index.
 *
 * The v1 index stores each text facet newline-delimited, so line boundaries are
 * not treated as trustworthy prompt/message boundaries here. Prompt text is
 * carried verbatim (apart from terminal controls); prose is trimmed by its
 * oldest stored lines first.
 */
export function buildBrief(db: IndexDb, uid: string, opts: BriefOpts = {}): string | null {
  const ref = db.getRef(uid)
  if (!ref) return null

  const text = db.raw().query(
    'SELECT prompts, prose FROM session_text WHERE uid = ?',
  ).get(uid) as StoredText | null
  // A discovered but not yet hydrated row has no safe handover content.
  if (!text) return null

  const prompts = safeText(text.prompts ?? '')
  const prose = safeText(text.prose ?? '').split('\n').filter((line) => line.length > 0)
  const files = (db.raw().query(`
    SELECT DISTINCT path FROM session_file
    WHERE uid = ?
    ORDER BY path COLLATE BINARY
    LIMIT ${FILE_LIMIT}
  `).all(uid) as Array<{ path: string }>).map((row) => oneLine(row.path)).filter(Boolean)
  const budget = budgetOf(opts.maxChars)

  const render = (proseStart: number, fileCount: number, overBudget = false): string => {
    const out: string[] = [
      '# Handover from a previous session',
      '',
      `This is context from an earlier ${oneLine(ref.client) || '(unknown)'} session, not a resumed session.`,
      'Tool state and file snapshots are gone, so re-read anything you need.',
    ]
    if (ref.missing) {
      out.push('The original session source is currently unavailable; this handover uses its last indexed copy.')
    }
    if (overBudget) {
      out.push('The requested character budget could not be met without dropping user prompts, so all prompts were retained.')
    }
    out.push(
      '',
      `- Title: ${ref.title ? oneLine(ref.title) || '(none)' : '(none)'}`,
      `- Directory: ${ref.cwd ? oneLine(ref.cwd) || '(unknown)' : '(unknown)'}`,
    )
    if (ref.gitBranch) out.push(`- Branch: ${oneLine(ref.gitBranch) || '(unknown)'}`)
    out.push(`- Ended: ${timestamp(ref.endedAt)}`, '', '## What I asked, in order', '')
    if (prompts) out.push(prompts)
    else out.push('(No user prompts were retained in the index.)')

    if (fileCount > 0) {
      out.push('', '## Files touched', '')
      for (let index = 0; index < fileCount; index++) out.push(`- ${files[index]}`)
    }
    if (proseStart < prose.length) {
      out.push('', '## Where it ended', '')
      for (let index = proseStart; index < prose.length; index++) out.push(prose[index]!)
    }
    return out.join('\n')
  }

  // Measure the mandatory portion once. Each optional array entry contributes
  // one joining newline plus its own length, allowing exact linear selection
  // without repeatedly slicing and rebuilding the whole brief.
  let body = render(prose.length, 0)
  if (body.length > budget) return render(prose.length, 0, true)

  const FILE_HEADING_COST = 3 + '## Files touched'.length
  const allFilesCost = files.length === 0
    ? 0
    : FILE_HEADING_COST + files.reduce((total, file) => total + 3 + file.length, 0)
  let fileCount = files.length
  let selectedLength = body.length + allFilesCost
  const filesNeedTrimming = selectedLength > budget
  if (filesNeedTrimming) {
    fileCount = 0
    selectedLength = body.length
    while (fileCount < files.length) {
      const nextCost = (fileCount === 0 ? FILE_HEADING_COST : 0)
        + 3 + files[fileCount]!.length // newline + "- " + path
      if (selectedLength + nextCost > budget) break
      selectedLength += nextCost
      fileCount++
    }
  }

  const PROSE_HEADING_COST = 3 + '## Where it ended'.length
  let proseStart = prose.length
  if (!filesNeedTrimming && prose.length > 0 && selectedLength + PROSE_HEADING_COST <= budget) {
    let proseCost = PROSE_HEADING_COST
    for (let index = prose.length - 1; index >= 0; index--) {
      const nextCost = 1 + prose[index]!.length
      if (selectedLength + proseCost + nextCost > budget) break
      proseCost += nextCost
      proseStart = index
    }
  }

  body = render(proseStart, fileCount)
  return body
}
