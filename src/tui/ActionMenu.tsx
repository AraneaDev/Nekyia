import React, { useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { boundedDisplayText, wrappedDisplayLines } from './text'
import type { ActionId, ActionItem } from './actions.js'

const SEARCH_COLUMNS = 128
const REASON_COLUMNS = 512
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * A searchable entry with optional checked availability. Informational entries
 * can be disabled without a reason; an unavailable action supplies its reason.
 */
export interface MenuItem {
  id: string
  label: string
  reason?: string | null
  enabled?: boolean
  shortcut?: string | null
}

/**
 * Dialog geometry and callbacks. Help suspends input while retaining the search
 * and selection; closing help returns to this same mounted dialog.
 */
export interface MenuProps {
  title: string
  items: readonly MenuItem[]
  rows: number
  columns: number
  onSelect: (id: string) => void
  onClose: () => void
  help?: string
  helpOpen?: boolean
  onHelpClose?: () => void
}

/**
 * Searchable, scrollable entries with a separate selected-action explanation.
 * Title, search, one entry and footer take precedence over explanation rows.
 */
export function Menu({ title, items, rows, columns, onSelect, onClose, help, helpOpen, onHelpClose }: MenuProps) {
  const [text, setText] = useState('')
  const [index, setIndex] = useState(0)
  const { exit } = useApp()
  const query = text.toLocaleLowerCase()
  const choices = items.filter(item => item.label.toLocaleLowerCase().includes(query))
  const selected = Math.min(index, Math.max(0, choices.length - 1))
  const reason = choices[selected]?.reason
  const wrappedReason = reason ? wrappedDisplayLines(boundedDisplayText(reason, REASON_COLUMNS), columns) : []
  const reasonBudget = Math.max(0, Math.min(rows - 4, rows < 12 ? 2 : 4))
  const reasonLines = wrappedReason.slice(0, reasonBudget)
  if (reasonLines.length && wrappedReason.length > reasonLines.length) {
    const last = reasonLines.length - 1
    reasonLines[last] = `${boundedDisplayText(reasonLines[last]!, Math.max(0, columns - 1))}…`
  }
  const height = Math.max(1, rows - 3 - reasonLines.length)
  const start = Math.max(0, selected - height + 1)

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return }
    if (key.escape) { onClose(); return }
    // Functional updates retain each input event queued before the next paint.
    if (key.upArrow) {
      setIndex(current => Math.max(0, Math.min(current, choices.length - 1) - 1))
      return
    }
    if (key.downArrow) {
      setIndex(current => Math.max(0, Math.min(choices.length - 1, current + 1)))
      return
    }
    if (key.return) {
      const item = choices[selected]
      if (item && item.enabled !== false) onSelect(item.id)
      return
    }
    if (key.backspace || key.delete) {
      setText(current => current.slice(0, [...graphemes.segment(current)].at(-1)?.index ?? 0))
      setIndex(0)
      return
    }
    if (input && !key.ctrl && !key.meta) {
      setText(current => boundedDisplayText(current + input, SEARCH_COLUMNS))
      setIndex(0)
    }
  }, { isActive: !helpOpen })

  if (helpOpen) return <Menu
    title={`${title} help`}
    items={[
      { id: 'nav', label: 'Up/Down choose · Enter select · type to find' },
      { id: 'cancel', label: 'Escape returns to this dialog without resetting it' },
      { id: 'exit', label: 'Ctrl+C exits the picker' },
    ]}
    rows={rows} columns={columns} onSelect={() => {}} onClose={onHelpClose ?? onClose}
  />

  return <Box flexDirection="column" width={columns} height={rows} overflow="hidden">
    <Text bold wrap="truncate-end">{boundedDisplayText(`${title} · ${choices.length ? selected + 1 : 0}/${choices.length}`, columns)}</Text>
    <Text wrap="truncate-end">{boundedDisplayText(`Find: ${text}`, columns)}</Text>
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {choices.slice(start, start + height).map((item, offset) => {
        const active = start + offset === selected
        return <Text key={item.id} wrap="truncate-end" color={active ? 'cyan' : undefined} dimColor={Boolean(item.reason) && !active}>
          {boundedDisplayText(`${active ? '▸ ' : '  '}${item.label}${item.shortcut ? ` (${item.shortcut})` : ''}`, columns)}
        </Text>
      })}
      {!choices.length && <Text>No matching actions</Text>}
    </Box>
    {reasonLines.map((line, offset) => <Text key={offset} color="yellow" wrap="truncate-end">{line}</Text>)}
    <Text dimColor wrap="truncate-end">{boundedDisplayText(help ?? 'esc back · enter select · ↑/↓ choose', columns)}</Text>
  </Box>
}

/** Action registry entries use stable identifiers shared with keyboard dispatch. */
export interface ActionsProps extends Omit<MenuProps, 'title' | 'items' | 'onSelect' | 'help'> {
  items: ActionItem[]
  onAction: (id: ActionId) => void
}

/** Keeps action-menu dispatch tied to the same registry used for help and hints. */
export function Actions({ items, onAction, onClose, rows, columns, helpOpen, onHelpClose }: ActionsProps) {
  return <Menu title="Actions" items={items} rows={rows} columns={columns}
    onSelect={id => onAction(id as ActionId)} onClose={onClose}
    helpOpen={helpOpen} onHelpClose={onHelpClose}
  />
}
