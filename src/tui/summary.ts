import type { Row } from '../core/query'
import type { MatchEvidence } from '../core/search-match'
import { qualityBadge, type SessionDetail } from '../core/session-detail'
import { shareLines, type PreviewLine } from './Preview'
import { boundedDisplayText, wrappedDisplayLines } from './text'

const SUMMARY_CODE_UNITS = 8192

/** Geometry of the quick preview; full retained history belongs to the reader. */
export interface SummaryOptions {
  columns: number
  maxLines: number
}

/**
 * Builds the selected-session preview without reading the database or changing
 * selection. Evidence may belong to a matching child while the title and launch
 * target remain the selected row. Metadata precedes fairly shared summaries;
 * the renderer clips metadata itself when even that exceeds the pane height.
 */
export function buildSummaryLines(
  row: Row | undefined,
  detail: SessionDetail | null,
  evidence: MatchEvidence | null,
  { columns, maxLines }: SummaryOptions,
): PreviewLine[] {
  if (!row || !detail) return []
  const title = row.title ?? '(no title)'
  const lines: PreviewLine[] = [{ text: boundedDisplayText(title, columns), bold: true }]
  const badge = qualityBadge(detail.reasons)
  if (badge) lines.push({ text: `${badge} · Actions → Session details`, color: 'yellow' })
  if (evidence) {
    if (evidence.uid !== row.uid) {
      lines.push({ text: boundedDisplayText(`Matched related session ${evidence.uid}`, columns) })
    }
    lines.push({ text: evidence.text, label: evidence.field, spans: evidence.spans })
  }
  const files = detail.fileCount === null ? 'File details unavailable'
    : `${detail.fileCountCapped ? 'at least ' : ''}${detail.fileCount} files`
  lines.push({ text: boundedDisplayText(`${row.gitBranch ?? 'No branch'} · ${files}`, columns) })

  const incomplete = detail.reasons.some(reason => ['truncated', 'degraded', 'reader-cap'].includes(reason))
  const replyLabel = !detail.ordered ? 'Reply text' : incomplete ? 'Last retained reply' : 'Latest reply'
  const summaries = [
    { label: detail.ordered ? 'Latest request' : 'Prompt text', body: detail.latestUser },
    { label: replyLabel, body: detail.latestReply },
  ]
  const normalizedTitle = (row.title ?? '').trim().toLocaleLowerCase()
  const blocks = summaries.flatMap(({ label, body }) => {
    if (!body || body.trim().toLocaleLowerCase() === normalizedTitle) return []
    // Bound before wrapping: cursor movement must never reflow a full transcript.
    return [wrappedDisplayLines(`${label}: ${body.slice(0, SUMMARY_CODE_UNITS)}`, columns)]
  })
  const shares = shareLines(Math.max(0, maxLines - lines.length), blocks.map(block => block.length))
  blocks.forEach((block, index) => {
    block.slice(0, shares[index]).forEach(text => lines.push({ text }))
  })
  return lines
}
