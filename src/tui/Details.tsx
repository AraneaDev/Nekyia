import React from 'react'
import { Menu } from './ActionMenu'
import type { SessionDetail, QualityReason } from '../core/session-detail'
import type { StoredRef } from '../core/db'

const MAX_SOURCE_PATHS = 256
const qualityLabels: Record<QualityReason, string> = {
  'source-missing': 'Source transcript is no longer on disk',
  truncated: 'Source content exceeded the indexing limit',
  degraded: 'Source content could not be read completely',
  'legacy-text': 'Older index: conversation order unavailable',
  'file-order': 'File operation order unavailable',
  'reader-cap': 'Retained history exceeds the reader limit',
  'details-unavailable': 'Session details could not be loaded',
}

/** Indexed provenance and checked launch availability for the selected session. */
export interface DetailsProps {
  detail: SessionDetail
  refData: StoredRef | null
  launchReason: string | null
  rows: number
  columns: number
  onClose: () => void
  helpOpen?: boolean
  onHelpClose?: () => void
}

/**
 * Exposes all completeness reasons behind the compact badge. Entries are
 * informational; source paths are bounded in count and sanitized by the menu.
 */
export function Details({ detail, refData, launchReason, rows, columns, onClose, helpOpen, onHelpClose }: DetailsProps) {
  const fileCount = detail.fileCount === null ? 'unavailable'
    : `${detail.fileCountCapped ? 'at least ' : ''}${detail.fileCount}`
  const labels = [
    `UID: ${detail.uid}`,
    `Client: ${refData?.client ?? 'unavailable'}`,
    `Branch: ${refData?.gitBranch ?? 'none'}`,
    `Files: ${fileCount}`,
    ...detail.reasons.map(reason => `Quality: ${qualityLabels[reason]}`),
    ...(launchReason ? [`Launch: ${launchReason}`] : []),
    ...(refData?.sourcePaths ?? []).slice(0, MAX_SOURCE_PATHS).map(path => `Source: ${path}`),
  ]
  return <Menu title="Session details" items={labels.map((label, index) => ({ id: String(index), label, enabled: false }))}
    rows={rows} columns={columns} onSelect={() => {}} onClose={onClose}
    helpOpen={helpOpen} onHelpClose={onHelpClose} help="up/down read · type to find · esc back"
  />
}
