import React from 'react'
import { Menu } from './ActionMenu'
import type { SearchRef } from '../core/db'

/** Saved identifiers and policy-filtered metadata; storage remains owned by App. */
export interface BookmarksProps {
  uids: readonly string[]
  refs: readonly SearchRef[]
  rows: number
  columns: number
  onRemove: (uid: string) => void
  onClose: () => void
  helpOpen?: boolean
  onHelpClose?: () => void
}

/**
 * Removes only explicitly selected UIDs. Stale identifiers remain removable
 * without persisting transcript metadata or looking up hidden clients here.
 */
export function Bookmarks({ uids, refs, rows, columns, onRemove, onClose, helpOpen, onHelpClose }: BookmarksProps) {
  const items = uids.map(uid => ({
    id: uid,
    label: refs.find(ref => ref.uid === uid)?.title ?? `${uid} (unavailable)`,
  }))
  return <Menu title="Manage bookmarks — enter removes" items={items}
    rows={rows} columns={columns} onSelect={onRemove} onClose={onClose}
    helpOpen={helpOpen} onHelpClose={onHelpClose}
    help="esc back · enter remove · ↑/↓ choose"
  />
}
