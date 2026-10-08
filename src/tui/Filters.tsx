import React, { useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { Menu } from './ActionMenu'
import { clearedFilters, resolveCustomTime, type PickerFilters } from './state'
import { parseTimeBound } from '../core/time-range'
import { boundedDisplayText, boundedErrorMessage } from './text'

/** Data and callbacks supplied by the picker; edits remain local until Apply. */
export interface FiltersProps {
  value: PickerFilters
  now: number
  clock?: () => number
  cwd: string
  clients: string[]
  branches: (string | null)[]
  rows: number
  columns: number
  onApply: (filters: PickerFilters) => void
  onClose: () => void
  helpOpen?: boolean
  onHelpClose?: () => void
}

/** A focusable row in the filter dialog. */
interface Field { id: string; label: string }
const TIMES = ['all', 'today', 'yesterday', '7d', '30d', 'custom'] as const
const TIME_LABELS = ['All time', 'Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'Custom']

/** Moves through a bounded list in either direction, including unset choices. */
function cycle<T>(choices: readonly T[], current: T, direction: number): T {
  const index = choices.indexOf(current)
  return choices[(Math.max(0, index) + direction + choices.length) % choices.length]!
}

/** Full draft dialog keeps text, policy and committed picker state outside its edits. */
export function Filters({ value, now, clock, cwd, clients, branches, rows, columns, onApply, onClose, helpOpen = false, onHelpClose }: FiltersProps) {
  const [draft, setDraft] = useState<PickerFilters>(() => ({ ...value }))
  const [focus, setFocus] = useState('project')
  const [error, setError] = useState<{ field: string; text: string } | null>(null)
  const { exit } = useApp()
  const custom = draft.time.kind === 'custom' ? draft.time : null
  const time = draft.time.kind === 'preset' ? draft.time.preset : 'custom'
  const fields: Field[] = [
    { id: 'project', label: `Project: ${draft.scope ?? 'All projects'}` },
    { id: 'reset-project', label: 'Reset project' },
    { id: 'client', label: `Client: ${draft.client ?? 'All visible clients'}` },
    { id: 'reset-client', label: 'Reset client' },
    { id: 'time', label: `Time: ${TIME_LABELS[TIMES.indexOf(time)]}` },
    { id: 'reset-time', label: 'Reset time' },
  ]
  if (custom) fields.push(
    { id: 'since', label: `Since: ${custom.sinceText || '(open lower bound)'}` },
    { id: 'reset-since', label: 'Reset since' },
    { id: 'until', label: `Until: ${custom.untilText || '(open upper bound)'}` },
    { id: 'reset-until', label: 'Reset until' },
  )
  fields.push(
    { id: 'sort', label: `Sort: ${draft.sort === 'auto' ? 'Auto' : draft.sort === 'recent' ? 'Recent' : 'Relevance'}` },
    { id: 'reset-sort', label: 'Reset sort' },
    { id: 'branch', label: `Branch: ${draft.branch === undefined ? 'All branches' : draft.branch === null ? 'No branch' : draft.branch}` },
    { id: 'reset-branch', label: 'Reset branch' },
    { id: 'file', label: `File: ${draft.file?.path || '(any file)'}` },
    { id: 'file-mode', label: `File matching: ${draft.file?.exact ? 'Exact path' : 'Contains path'}` },
    { id: 'reset-file', label: 'Reset file' },
    { id: 'bookmarks', label: `Bookmarks: ${draft.bookmarkedOnly ? 'Bookmarked only' : 'All sessions'}` },
    { id: 'reset-bookmarks', label: 'Reset bookmarks' },
    { id: 'clear', label: 'Clear all filters' },
    { id: 'apply', label: 'Apply' },
    { id: 'cancel', label: 'Cancel' },
  )
  const selected = Math.max(0, fields.findIndex(field => field.id === focus))
  const visibleHeight = Math.max(1, rows - 3)
  const start = Math.max(0, Math.min(selected - visibleHeight + 1, fields.length - visibleHeight))

  /** Changes one field without mutating the supplied committed state. */
  function patch(next: Partial<PickerFilters>) {
    setDraft(current => ({ ...current, ...next }))
    setError(null)
  }

  /** Edits custom spelling without repeatedly resolving relative time bounds. */
  function editBound(field: 'since' | 'until', text: string) {
    if (!custom) return
    patch({ time: { ...custom, [field === 'since' ? 'sinceText' : 'untilText']: text } })
  }

  /** Exposes the reset for each selected field as well as its separate control. */
  function reset(field: string) {
    switch (field) {
      case 'project': patch({ scope: null }); break
      case 'client': patch({ client: null }); break
      case 'time': patch({ time: { kind: 'preset', preset: 'all' } }); break
      case 'since': editBound('since', ''); break
      case 'until': editBound('until', ''); break
      case 'sort': patch({ sort: 'auto' }); break
      case 'branch': patch({ branch: undefined }); break
      case 'file': case 'file-mode': patch({ file: undefined }); break
      case 'bookmarks': patch({ bookmarkedOnly: false }); break
    }
  }

  /** Resolves changed custom input exactly once and points diagnostics at their field. */
  function apply() {
    const appliedNow = clock?.() ?? now
    let next = draft
    if (custom) {
      try {
        if (custom.sinceText.trim()) parseTimeBound(custom.sinceText.trim(), appliedNow, '--since')
      } catch (caught) {
        setError({ field: 'since', text: boundedErrorMessage(caught) }); setFocus('since'); return
      }
      try {
        if (custom.untilText.trim()) parseTimeBound(custom.untilText.trim(), appliedNow, '--until')
      } catch (caught) {
        setError({ field: 'until', text: boundedErrorMessage(caught) }); setFocus('until'); return
      }
      try {
        const unchanged = value.time.kind === 'custom'
          && custom.sinceText === value.time.sinceText && custom.untilText === value.time.untilText
        next = { ...draft, time: unchanged ? value.time : resolveCustomTime(custom.sinceText, custom.untilText, appliedNow) }
      } catch (caught) {
        setError({ field: 'until', text: boundedErrorMessage(caught) }); setFocus('until'); return
      }
    }
    // Remove inactive optional fields so consumers receive a complete canonical reset.
    if (next.branch === undefined || !next.file?.path) {
      next = { ...next }
      if (next.branch === undefined) delete next.branch
      if (!next.file?.path) delete next.file
    }
    onApply(next)
    onClose()
  }

  /** Activates choices, actions and resets from a single keyboard navigation model. */
  function activate(field: string, direction = 1) {
    if (field.startsWith('reset-')) { reset(field.slice(6)); return }
    switch (field) {
      case 'project': patch({ scope: draft.scope === null ? cwd : null }); break
      case 'client': patch({ client: cycle<string | null>([null, ...new Set(clients)], draft.client, direction) }); break
      case 'time': {
        const preset = cycle(TIMES, time, direction)
        patch({ time: preset === 'custom' ? { kind: 'custom', range: {}, sinceText: '', untilText: '' } : { kind: 'preset', preset } })
        break
      }
      case 'sort': patch({ sort: cycle(['auto', 'recent', 'relevance'] as const, draft.sort, direction) }); break
      case 'branch': patch({ branch: cycle<string | null | undefined>([undefined, ...new Set(branches)], draft.branch, direction) }); break
      case 'file-mode': patch({ file: { path: draft.file?.path ?? '', exact: !draft.file?.exact } }); break
      case 'bookmarks': patch({ bookmarkedOnly: !draft.bookmarkedOnly }); break
      case 'clear': setDraft(clearedFilters()); setError(null); break
      case 'apply': apply(); break
      case 'cancel': onClose(); break
    }
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return }
    if (key.escape) { onClose(); return }
    if (key.upArrow || key.downArrow || key.tab) {
      const direction = key.upArrow || (key.tab && key.shift) ? -1 : 1
      setFocus(fields[(selected + direction + fields.length) % fields.length]!.id)
      return
    }
    if (key.ctrl && input === 's') { apply(); return }
    if (key.ctrl && input === 'r') { reset(focus.replace(/^reset-/u, '')); return }
    if (key.return || key.leftArrow || key.rightArrow) { activate(focus, key.leftArrow ? -1 : 1); return }
    const textField = focus === 'since' || focus === 'until' || focus === 'file' || focus === 'project'
    if (!textField || key.meta || (key.ctrl && input !== 'u')) return
    const current = focus === 'file' ? draft.file?.path ?? '' : focus === 'project' ? draft.scope ?? '' : custom?.[focus === 'since' ? 'sinceText' : 'untilText'] ?? ''
    let text: string
    if (key.ctrl && input === 'u') text = ''
    else if (key.backspace || key.delete) text = Array.from(current).slice(0, -1).join('')
    else if (input && !key.ctrl) text = boundedDisplayText(current + input, 512)
    else return
    if (focus === 'file') patch({ file: text ? { path: text, exact: draft.file?.exact ?? false } : undefined })
    else if (focus === 'project') patch({ scope: text || null })
    else editBound(focus as 'since' | 'until', text)
  }, { isActive: !helpOpen })

  if (helpOpen) return <Menu title="Filter help" rows={rows} columns={columns} onClose={onHelpClose ?? onClose} onSelect={() => {}}
    items={[
      { id: 'navigation', label: 'Tab / arrows select controls' },
      { id: 'choices', label: 'Enter / left-right change choices' },
      { id: 'text', label: 'Type project/file paths and dates' },
      { id: 'clear', label: 'Ctrl+U clears text; Ctrl+R resets' },
      { id: 'apply', label: 'Ctrl+S Apply; Esc Cancel draft' },
      { id: 'utc', label: 'Dates UTC; ISO needs Z/offset' },
      { id: 'spans', label: 'Spans: 30m, 12h, 2d, 3w' },
      { id: 'bounds', label: 'Since inclusive; Until exclusive' },
      { id: 'reset', label: 'Reset rows clear one filter' },
      { id: 'clear-all', label: 'Clear all retains search text' },
    ]} help="esc back to your draft" />

  return <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
    <Text bold wrap="truncate-end">Filters · edit draft, then Apply</Text>
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {fields.slice(start, start + visibleHeight).map(field => <Text key={field.id} color={field.id === focus ? 'cyan' : undefined} wrap="truncate-end">
        {boundedDisplayText(`${field.id === focus ? '▸ ' : '  '}${field.label}${error?.field === field.id ? ` · Error: ${error.text}` : ''}`, columns)}
      </Text>)}
    </Box>
    <Text dimColor wrap="truncate-end">{boundedDisplayText(custom ? 'Dates UTC; ISO: Z/offset; spans: 2d; since inclusive / until exclusive' : 'Today/Yesterday: local days; 7d/30d: rolling; Custom: UTC dates or spans', columns)}</Text>
    <Text dimColor wrap="truncate-end">{boundedDisplayText('ctrl+s apply · esc cancel · tab choose · enter/←/→ change · type paths/dates · ctrl+u clear', columns)}</Text>
  </Box>
}
