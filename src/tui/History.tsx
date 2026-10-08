import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdin } from 'ink'
import type { SessionDetail } from '../core/session-detail'
import type { MatchEvidence } from '../core/search-match'
import type { PickerRestore, ReaderAnchor } from './state'
import { anchorLine, buildHistoryLines, findHistory, nextHit, type HistoryLine } from './history.js'
import { boundedDisplayText, wrappedDisplayLines } from './text'
import { Menu } from './ActionMenu'

const NO_EXTRA_LINES: readonly string[] = []

/** Reader input and continuity callbacks. */
export interface HistoryProps {
  detail: SessionDetail
  evidence?: MatchEvidence | null
  rows: number
  columns: number
  initial?: PickerRestore['reader']
  onPosition(value: PickerRestore['reader']): void
  onClose(): void
  onRefresh?(): void
  helpOpen?: boolean
  onHelpClose?(): void
  /** Bounded file events and provenance notices supplied by the selected-session loader. */
  extraLines?: readonly string[]
}

/** Full-screen retained conversation reader with semantic position and literal find. */
export function History({ detail, evidence, rows, columns, initial, onPosition, onClose, onRefresh, helpOpen = false, onHelpClose, extraLines = NO_EXTRA_LINES }: HistoryProps) {
  const { exit } = useApp()
  const { stdin } = useStdin()
  const width = Math.max(1, Math.min(512, columns))
  const height = Math.max(1, rows)
  const searchTurns = useMemo(() => detail.ordered ? detail.turns : [
    { ordinal: -1, role: 'user', text: detail.latestUser ?? '' },
    { ordinal: -2, role: 'assistant', text: detail.latestReply ?? '' },
  ], [detail])
  const lines = useMemo(() => {
    const body: HistoryLine[] = buildHistoryLines(searchTurns, width).map(line => detail.ordered ? line : {
      ...line, ordinal: null, legacyOrdinal: line.ordinal ?? undefined,
      text: line.endOffset === 0 && line.offset === 0
        ? line.text === 'Prompt' ? 'Prompt text' : line.text === 'Reply' ? 'Reply text' : line.text
        : line.text,
    })
    for (const raw of extraLines) {
      for (const text of wrappedDisplayLines(raw, width)) body.push({ text, ordinal: null, offset: 0, endOffset: 0 })
    }
    return body.length ? body : [{ text: 'No retained conversation', ordinal: null, offset: 0, endOffset: 0 }]
  }, [detail, searchTurns, width, extraLines])
  const [anchor, setAnchor] = useState<ReaderAnchor>(() => initial?.anchor.uid === detail.uid
    ? initial.anchor
    : { uid: detail.uid, ordinal: evidence?.anchor?.ordinal ?? detail.turns[0]?.ordinal ?? null,
      offset: evidence?.anchor?.offset ?? 0, fallbackLine: 0 })
  const [findText, setFindText] = useState(initial?.findText ?? '')
  const [hitIndex, setHitIndex] = useState(initial?.hitIndex ?? -1)
  const hitIndexRef = useRef(hitIndex)
  hitIndexRef.current = hitIndex
  const [finding, setFinding] = useState(false)
  const hits = useMemo(() => findHistory(searchTurns, findText), [searchTurns, findText])
  const [fallbackMatch] = useState(Boolean(initial?.findText))
  const unlocated = !hits.length && (fallbackMatch || Boolean(evidence && !evidence.anchor))
  const notices = [
    ...(unlocated ? ['Match location unavailable in retained history'] : []),
    ...(detail.reasons.includes('reader-cap') ? ['retained history capped'] : []),
  ].flatMap(text => wrappedDisplayLines(text, width)).slice(0, Math.max(0, height - 3))
  const chrome = height >= 4 ? 2 + notices.length : 1
  const room = Math.max(1, height - chrome)
  const maximum = Math.max(0, lines.length - room)
  const top = Math.min(maximum, anchorLine(lines, anchor))
  const positionCallback = useRef(onPosition)
  positionCallback.current = onPosition
  useEffect(() => { positionCallback.current({ anchor, findText, hitIndex }) }, [anchor, findText, hitIndex])

  /** Scroll to a rendered row and remember its underlying position. */
  const move = (line: number) => {
    const index = Math.max(0, Math.min(maximum, line))
    const target = lines[index]!
    setAnchor({ uid: detail.uid, ordinal: target.ordinal, offset: target.offset, fallbackLine: index })
  }
  /** Apply each queued scroll key relative to the latest pending anchor. */
  const moveRelative = (delta: number) => {
    setAnchor(previous => {
      const previousTop = Math.min(maximum, anchorLine(lines, previous))
      const index = Math.max(0, Math.min(maximum, previousTop + delta))
      const target = lines[index]!
      return { uid: detail.uid, ordinal: target.ordinal, offset: target.offset, fallbackLine: index }
    })
  }
  /** Select a hit using a semantic anchor or an explicit legacy row. */
  const jump = (index: number) => {
    hitIndexRef.current = index
    setHitIndex(index)
    const hit = hits[index]
    if (hit) {
      const fallbackLine = detail.ordered ? top : anchorLine(lines.map(line => ({ ...line, ordinal: line.legacyOrdinal ?? null })), {
        uid: detail.uid, ordinal: hit.ordinal, offset: hit.start, fallbackLine: top,
      })
      setAnchor({ uid: detail.uid, ordinal: detail.ordered ? hit.ordinal : null, offset: hit.start, fallbackLine })
    }
  }
  /** Update literal find atomically with its first hit, leaving no-hit position unchanged. */
  const updateFind = (text: string) => {
    setFindText(text)
    const matches = findHistory(searchTurns, text)
    hitIndexRef.current = matches.length ? 0 : -1
    setHitIndex(hitIndexRef.current)
    const hit = matches[0]
    if (!hit) return
    const fallbackLine = detail.ordered ? top : anchorLine(lines.map(line => ({ ...line, ordinal: line.legacyOrdinal ?? null })), {
      uid: detail.uid, ordinal: hit.ordinal, offset: hit.start, fallbackLine: top,
    })
    setAnchor({ uid: detail.uid, ordinal: detail.ordered ? hit.ordinal : null, offset: hit.start, fallbackLine })
  }
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return }
    if (key.ctrl && input === 'o') { onClose(); return }
    if (key.ctrl && input === 'r' && onRefresh) { onRefresh(); return }
    if (key.ctrl && input === 'f') { setFinding(true); return }
    if (key.escape) { if (finding) setFinding(false); else onClose(); return }
    if (finding) {
      if (key.return) { setFinding(false); return }
      if (key.backspace || key.delete) {
        updateFind([...findText].slice(0, -1).join('')); return
      }
      if (!key.ctrl && !key.meta && input && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
        updateFind((findText + input).slice(0, 4096))
      }
      return
    }
    if (key.upArrow) moveRelative(-1)
    else if (key.downArrow) moveRelative(1)
    else if (key.pageUp) moveRelative(-room)
    else if (key.pageDown) moveRelative(room)
    else if (key.home) move(0)
    else if (key.end) move(maximum)
  }, { isActive: !helpOpen })
  // Ink's public Key drops function-key names; recognize only F3 sequences on the raw stream.
  useEffect(() => {
    /** Decode supported terminal F3 encodings omitted from Ink Key. */
    const functionKey = (data: Buffer | string) => {
      if (helpOpen) return
      const sequence = data.toString()
      if (/^\u001b(?:OR|\[R|\[13~|\[\[C)$/u.test(sequence)) jump(nextHit(hitIndexRef.current, hits.length, 1))
      else if (/^\u001b\[(?:1;2R|13;2~)$/u.test(sequence)) jump(nextHit(hitIndexRef.current, hits.length, -1))
    }
    stdin.on('data', functionKey)
    return () => { stdin.removeListener('data', functionKey) }
  })
  const hitLabel = findText ? hits.length ? `hit ${Math.min(hits.length, Math.max(1, hitIndex + 1))} of ${hits.length}` : 'No matches' : ''
  const footer = finding ? `Find: ${findText} · ${hitLabel} · Esc close find`
    : width<60 ? `Esc back · ${hitLabel||'Ctrl+F find'} · ${top+1}-${Math.min(lines.length,top+room)}/${lines.length}`
    : `Lines ${top + 1}-${Math.min(lines.length, top + room)} of ${lines.length}${hitLabel?` · ${hitLabel}`:''} · Esc back · Ctrl+F find`
  if (helpOpen) return <Menu title="History help" items={[
    { id: 'move', label: 'Up/Down: scroll one line; PageUp/PageDown: scroll one page', enabled: false },
    { id: 'ends', label: 'Home/End: start/end of retained history', enabled: false },
    { id: 'find', label: 'Ctrl+F: literal conversation find; Enter: close find', enabled: false },
    { id: 'hits', label: 'F3/Shift+F3: next/previous hit with wraparound', enabled: false },
    { id: 'back', label: 'Escape: close find first, then return to browse; Ctrl+O: return', enabled: false },
    { id: 'refresh', label: 'Ctrl+R: refresh index; Ctrl+C: exit', enabled: false },
  ]} rows={height} columns={width} onSelect={() => {}} onClose={onHelpClose ?? (() => {})}
    help="Esc returns to the same reader position and find" />
  return <Box flexDirection="column" width={width}>
    {height >= 4 ? <Text bold>{boundedDisplayText(`History · ${detail.uid}`, width)}</Text> : null}
    {height >= 4 ? notices.map((notice, index) => <Text key={`notice:${index}`} color="yellow">{boundedDisplayText(notice, width)}</Text>) : null}
    {lines.slice(top, top + room).map((line, index) => <Text key={top + index}>{boundedDisplayText(line.text, width)}</Text>)}
    {height >= 2 ? <Text dimColor>{boundedDisplayText(footer, width)}</Text> : null}
  </Box>
}
