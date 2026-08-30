import type { IndexDb } from './db'

/** Bounds on a generated handover, so a long session cannot produce an unbounded prompt. */
export interface BriefOpts {
  /** Roughly four characters per token, so 40,000 is about 10k tokens. */
  maxChars?: number
}

/**
 * Internal implementation for StoredText.
 */
interface StoredText {
  prompts: string
  prose: string
}

const DEFAULT_MAX_CHARS = 40_000
const FILE_LIMIT = 40
const PROSE_OMITTED_LINE = 'The end of the session was omitted to fit the character budget.'
/** Said when a size cap stopped indexing short of the whole session. */
const SIZE_CAPPED_LINE = 'Part of this session was too large to index, so some replies are missing from this handover.'
/** Said when the source itself could not be read or parsed, which no setting undoes. */
const DEGRADED_LINE = 'Part of this session could not be read from its source, so some of it is missing from this handover.'

/**
 * The marker that stands in for files the brief does not list, or null when the
 * list is complete. Past the hard cap the real total is unknown, so the marker
 * deliberately claims no number it cannot support.
 */
function fileMarkerFor(remaining: number, capped: boolean): string | null {
  if (capped) return '- (more files omitted)'
  if (remaining <= 0) return null
  return `- (${remaining} more file${remaining === 1 ? '' : 's'} omitted)`
}

// Keep line feeds and tabs, but do not let indexed text execute terminal controls.
/**
 * Internal implementation for safeText.
 */
function safeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

/**
 * Internal implementation for oneLine.
 */
function oneLine(value: string): string {
  return safeText(value).replace(/[\r\n]+/g, ' ').trim()
}

/**
 * Internal implementation for timestamp.
 */
function timestamp(value: number): string {
  if (!Number.isFinite(value)) return '(unknown)'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '(unknown)' : date.toISOString()
}

/**
 * Internal implementation for budgetOf.
 */
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
 * The index stores each text facet newline-delimited, so line boundaries are
 * not treated as trustworthy prompt/message boundaries here. Prompt text is
 * carried verbatim (apart from terminal controls); prose is trimmed by its
 * oldest stored lines first. Whatever the budget or the file cap leaves out is
 * announced by a marker line, because the receiving model acts on this text and
 * must never read a shortened list as a complete one.
 *
 * The same applies to what indexing itself never captured: a session a size cap
 * cut short, or one whose source could not be read, says so in the header. Both
 * lines sit in the mandatory body, so they are measured with it and are never
 * the entries the budget drops. A handover that hides its own gaps is worse
 * than a short one.
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
  // One row past the cap, so a session with exactly FILE_LIMIT files is
  // distinguishable from one the cap truncated. Only the cap is ever rendered.
  const fileRows = db.raw().query(`
    SELECT DISTINCT path FROM session_file
    WHERE uid = ?
    ORDER BY path COLLATE BINARY
    LIMIT ${FILE_LIMIT + 1}
  `).all(uid) as Array<{ path: string }>
  const cappedByLimit = fileRows.length > FILE_LIMIT
  const files = fileRows.slice(0, FILE_LIMIT).map((row) => oneLine(row.path)).filter(Boolean)
  const budget = budgetOf(opts.maxChars)

  // The markers are parameters rather than something render() derives, so that
  // the mandatory-body measurement below can ask for a brief without them and
  // then price each marker in as an entry of its own.
  /**
   * Internal implementation for render.
   */
  const render = (
    proseStart: number,
    fileCount: number,
    fileMarker: string | null,
    proseOmitted: boolean,
    overBudget = false,
  ): string => {
    const out: string[] = [
      '# Handover from a previous session',
      '',
      `This is context from an earlier ${oneLine(ref.client) || '(unknown)'} session, not a resumed session.`,
      'Tool state and file snapshots are gone, so re-read anything you need.',
    ]
    if (ref.missing) {
      out.push('The original session source is currently unavailable; this handover uses its last indexed copy.')
    }
    if (ref.truncated) out.push(SIZE_CAPPED_LINE)
    if (ref.degraded) out.push(DEGRADED_LINE)
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

    if (fileCount > 0 || fileMarker) {
      out.push('', '## Files touched', '')
      for (let index = 0; index < fileCount; index++) out.push(`- ${files[index]}`)
      if (fileMarker) out.push(fileMarker)
    }
    if (proseStart < prose.length) {
      out.push('', '## Where it ended', '')
      for (let index = proseStart; index < prose.length; index++) out.push(prose[index]!)
    } else if (proseOmitted) {
      out.push('', PROSE_OMITTED_LINE)
    }
    return out.join('\n')
  }

  // Measure the mandatory portion once. Each optional array entry contributes
  // one joining newline plus its own length, allowing exact linear selection
  // without repeatedly slicing and rebuilding the whole brief.
  let body = render(prose.length, 0, null, false)
  // Prompts are never dropped, so this brief is already past the budget. It
  // still says what it left out: an over-budget handover is no less misleading
  // for presenting an empty file list as the whole truth.
  if (body.length > budget) {
    return render(prose.length, 0, fileMarkerFor(files.length, cappedByLimit), prose.length > 0, true)
  }

  // A marker line is priced exactly like the entries it stands in for, so an
  // omission notice can never be the thing that pushes the brief over budget.
  const FILE_HEADING_COST = 3 + '## Files touched'.length
  const PROSE_OMITTED_COST = 2 + PROSE_OMITTED_LINE.length // blank line + the notice
  const PROSE_HEADING_COST = 3 + '## Where it ended'.length
  /**
   * Internal implementation for markerCost.
   */
  const markerCost = (marker: string | null): number => (marker === null ? 0 : 1 + marker.length)

  const allFilesMarker = fileMarkerFor(0, cappedByLimit)
  const allFilesCost = files.length === 0 && allFilesMarker === null
    ? 0
    : FILE_HEADING_COST + markerCost(allFilesMarker)
      + files.reduce((total, file) => total + 3 + file.length, 0)
  let fileCount = files.length
  let fileMarker = allFilesMarker
  let selectedLength = body.length + allFilesCost
  const filesNeedTrimming = selectedLength > budget
  if (filesNeedTrimming) {
    // Trimming always leaves something out, so room for the file marker is
    // reserved at every step: a path is admitted only when the marker for
    // whatever is still left over fits beside it. That marker shrinks as paths
    // are admitted, so the pass stays linear and the final cost is the one the
    // last admission already checked.
    //
    // Trimming also means the tail has no room, since prose is only selected
    // when the file list came through whole. The notice that the tail is gone
    // is therefore reserved ahead of the paths: a closing state that vanishes
    // unannounced costs the reader more than one more path does.
    const proseReserve = prose.length > 0 && body.length + PROSE_OMITTED_COST <= budget
      ? PROSE_OMITTED_COST
      : 0
    fileCount = 0
    let filesCost = FILE_HEADING_COST
    while (fileCount < files.length) {
      const nextCost = 3 + files[fileCount]!.length // newline + "- " + path
      const nextMarker = fileMarkerFor(files.length - (fileCount + 1), cappedByLimit)
      if (body.length + proseReserve + filesCost + nextCost + markerCost(nextMarker) > budget) break
      filesCost += nextCost
      fileCount++
    }
    fileMarker = fileMarkerFor(files.length - fileCount, cappedByLimit)
    selectedLength = body.length + filesCost + markerCost(fileMarker)
    // Reached only with no file admitted: not even the heading and the marker
    // fit beside the reserved notice, so the section goes entirely rather than
    // half-stated.
    if (selectedLength + proseReserve > budget) {
      fileCount = 0
      fileMarker = null
      selectedLength = body.length
    }
  }

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

  // Nothing of the tail survived the budget: say so where the tail would have
  // been, if the notice itself fits. Cost is the blank line plus the notice.
  const proseOmitted = prose.length > 0 && proseStart === prose.length
    && selectedLength + PROSE_OMITTED_COST <= budget

  body = render(proseStart, fileCount, fileMarker, proseOmitted)
  return body
}
