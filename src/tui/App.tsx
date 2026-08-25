import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, measureElement, Text, useApp, useInput, type DOMElement } from 'ink'
import type { Config } from '../config'
import type { Adapter } from '../core/adapter'
import { buildBrief } from '../core/brief'
import type { IndexDb } from '../core/db'
import { shellQuote } from '../core/resume'
import type { ExecPlan } from '../types'
import { boundedDisplayText, List } from './List'
import { projectName } from '../render'
import { buildPreviewLines, Preview } from './Preview'
import { useSessions } from './useSessions'
import { createHostClipboard, type ClipboardLike } from './clipboard'

const CLIENTS = [undefined, 'claude', 'codex', 'opencode', 'kilo', 'codebuff', 'agy'] as const
const SEARCH_COLUMNS = 512
/** Cap held-key history repaints while preserving every accumulated line. */
const HISTORY_SCROLL_FRAME_MS = 32
/** First-paint estimate of non-list chrome; layout measurement corrects it immediately. */
const CHROME_SEED = 12

/**
 * Content lines the preview may claim. Derived from the terminal alone, never
 * from its own content, so sizing cannot feed back into itself.
 */
/**
 * An empty screen is the one place with nothing useful to displace, so it says
 * what to do next rather than reporting that a query matched nothing.
 */
function EmptyState({ searching, narrowed }: { searching: boolean; narrowed: boolean }) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text>{searching ? 'Nothing came up.' : 'No sessions indexed yet.'}</Text>
      <Text dimColor wrap="truncate-end">
        {searching
          ? <>Try fewer words{narrowed ? <>, or press <Text color="cyan">tab</Text> to search everywhere</> : null}.</>
          : <>Run <Text color="cyan">nekyia index</Text> to read the histories your agent CLIs already keep.</>}
      </Text>
    </Box>
  )
}

function SparseHint({ project }: { project: string }) {
  return (
    <Box marginTop={1} flexDirection="column" flexShrink={0}>
      <Text dimColor wrap="truncate-end">
        Only {project} is being searched.
      </Text>
      <Text dimColor wrap="truncate-end">
        Press <Text color="cyan">tab</Text> to search everywhere.
      </Text>
    </Box>
  )
}

/**
 * Keeps as many hints as the width allows, in the order given, so a narrow
 * terminal loses the least useful key rather than truncating the last one
 * mid-word and leaving a hint nobody can read.
 */
export function fitKeys(keys: [string, string][], columns: number): [string, string][] {
  const out: [string, string][] = []
  let used = 0
  for (const entry of keys) {
    const width = entry[0].length + 1 + entry[1].length + (out.length ? 3 : 0)
    if (used + width > Math.max(0, columns)) break
    out.push(entry)
    used += width
  }
  return out
}

/** Rows the list keeps while the detail view is being read, for context only. */
export const INSPECT_LIST_ROWS = 4

export function previewLines(rows: number): number {
  // About a third of the screen, so a tall terminal shows the session rather
  // than a dozen lines under a very long list, while the list keeps the rest.
  return Math.max(4, Math.min(Math.floor(rows / 3), Math.max(4, rows - 10)))
}
const COPY_PROMPT_CHARS = 65_536
const COPY_PROMPT_BYTES = 16_384
const COPY_COMMAND_BYTES = 8_192
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const CLIPBOARD_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu
const CLIPBOARD_BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/gu
const UNSAFE_COMMAND = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/u

export type { ClipboardLike } from './clipboard'

interface Confirmation {
  plan: ExecPlan
  chars: number
  client: string
}

function sanitizePromptForClipboard(text: string): string {
  let sample = text.slice(0, COPY_PROMPT_CHARS)
  const last = sample.charCodeAt(sample.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) sample = sample.slice(0, -1)
  const safe = sample.replace(CLIPBOARD_CONTROLS, ' ').replace(CLIPBOARD_BIDI, '')
  const bytes = new TextEncoder().encode(safe)
  if (bytes.byteLength <= COPY_PROMPT_BYTES) return safe
  let end = COPY_PROMPT_BYTES
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return new TextDecoder().decode(bytes.subarray(0, end))
}

export interface CommandCopyWork {
  scannedCodeUnits: number
}

function commandUnitUnsafe(code: number): boolean {
  return code <= 0x1f
    || (code >= 0x7f && code <= 0x9f)
    || code === 0x061c
    || code === 0x200e
    || code === 0x200f
    || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2066 && code <= 0x206f)
    || code === 0xfeff
}

export function safeCommandForClipboard(plan: ExecPlan, work?: CommandCopyWork): string | null {
  try {
    if (typeof plan.cmd !== 'string' || typeof plan.cwd !== 'string' || !Array.isArray(plan.args)) return null
    // Fixed shell syntax plus conservative quotes/separators around each value.
    let budget = 16
    for (const values of [[plan.cmd, plan.cwd], plan.args]) {
      for (const value of values) {
        if (typeof value !== 'string') return null
        // Reject by O(1) length before any content scan. Eight covers a
        // separator, surrounding quotes and the cwd "./" safety prefix.
        if (value.length + 8 > COPY_COMMAND_BYTES - budget) return null
        let quotes = 0
        for (let index = 0; index < value.length; index++) {
          const code = value.charCodeAt(index)
          if (work) work.scannedCodeUnits++
          if (commandUnitUnsafe(code)) return null
          if (code === 0x27) quotes++
        }
        // POSIX single-quote escaping expands each apostrophe by three units.
        budget += value.length + quotes * 3 + 8
        if (budget > COPY_COMMAND_BYTES) return null
      }
    }
    const command = shellQuote(plan)
    if (UNSAFE_COMMAND.test(command)) return null
    if (new TextEncoder().encode(command).byteLength > COPY_COMMAND_BYTES) return null
    return command
  } catch {
    return null
  }
}

function deleteLastGrapheme(text: string): string {
  let last = 0
  for (const part of GRAPHEMES.segment(text)) last = part.index
  return text.slice(0, last)
}

/** Terminal rows, tracked live so a resize relays out instead of leaving a stale frame. */
export function terminalRows(rows: unknown, fallback = 24): number {
  return typeof rows === 'number' && Number.isFinite(rows) && rows > 0
    ? Math.max(1, Math.floor(rows))
    : fallback
}

interface TerminalSize { rows: number; columns: number }

function useTerminalSize(rowsIn?: number, columnsIn?: number): TerminalSize {
  const read = (): TerminalSize => ({
    rows: terminalRows(rowsIn ?? process.stdout.rows),
    columns: terminalRows(columnsIn ?? process.stdout.columns, 80),
  })
  const [size, setSize] = useState(read)
  useEffect(() => {
    const update = () => setSize((previous) => {
      const next = read()
      return previous.rows === next.rows && previous.columns === next.columns ? previous : next
    })
    update()
    if (rowsIn !== undefined && columnsIn !== undefined) return
    process.stdout.on('resize', update)
    return () => { process.stdout.off('resize', update) }
  }, [rowsIn, columnsIn])
  return size
}

/**
 * Measured height of a flex child, so the list windows against real space.
 * The seed only decides the first paint before layout is measurable; the root
 * box clips, so an over-long seed can never push the frame past the terminal.
 */
function useMeasuredHeight(ref: React.RefObject<DOMElement | null>, seed: number): number {
  const [height, setHeight] = useState(seed)
  useEffect(() => {
    if (!ref.current) return
    const measured = measureElement(ref.current).height
    setHeight((previous) => (previous === measured ? previous : measured))
  })
  return height
}

/**
 * Printable input always searches. Picker actions use ctrl+p, ctrl+y and ctrl+f
 * so a query can begin with any ordinary letter.
 */
export interface AppProps {
  db: IndexDb
  cfg: Config
  adapters: Adapter[]
  cwd: string
  now: number
  onExec: (plan: ExecPlan) => void
  /** null explicitly disables copying; undefined uses the host clipboard when present. */
  clipboard?: ClipboardLike | null
  /** Injectable factory keeps host clipboard selection testable without side effects. */
  clipboardFactory?: () => ClipboardLike | null
  /** Injectable terminal height; the live terminal is used when omitted. */
  rows?: number
  /** Injectable terminal width; the live terminal is used when omitted. */
  columns?: number
}

export function App({
  db, cfg, adapters, cwd, now, onExec, clipboard,
  clipboardFactory = createHostClipboard, rows, columns,
}: AppProps) {
  const { exit } = useApp()
  const { rows: terminalHeight, columns: terminalWidth } = useTerminalSize(rows, columns)
  const listRef = useRef<DOMElement | null>(null)
  const detailRef = useRef<DOMElement | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [scroll, setScroll] = useState(0)
  // Reading the history is worth most of the screen; the list keeps a few rows
  // so you can still see what you are reading about. Whichever pane is not
  // growing gets a fixed height, and both are measured rather than computed,
  // so no arithmetic here can drift from what Yoga actually laid out.
  const listHeight = useMeasuredHeight(
    listRef,
    Math.max(1, inspecting ? INSPECT_LIST_ROWS : terminalHeight - CHROME_SEED),
  )
  const detailLines = useMeasuredHeight(
    detailRef,
    Math.max(1, inspecting ? terminalHeight - INSPECT_LIST_ROWS - 7 : previewLines(terminalHeight)),
  )
  const sessions = useSessions(db, cfg, cwd)
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const [note, setNote] = useState('')
  const executing = useRef(false)
  const mounted = useRef(true)
  const queuedScroll = useRef(0)
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectedRow = sessions.rows[sessions.selected]
  const detail = useMemo(
    () => buildPreviewLines(db, selectedRow, {
      columns: terminalWidth, maxLines: detailLines, full: inspecting, now,
    }),
    [db, selectedRow, terminalWidth, detailLines, inspecting, now],
  )
  const maxScroll = Math.max(0, detail.length - detailLines)
  // Selecting another session, or leaving inspect, starts the reader at the top.
  const offset = Math.min(scroll, maxScroll)
  const clipboardApi = useMemo(
    () => clipboard === undefined ? clipboardFactory() : clipboard,
    [clipboard, clipboardFactory],
  )

  function cancelQueuedScroll(): void {
    queuedScroll.current = 0
    if (scrollTimer.current !== null) clearTimeout(scrollTimer.current)
    scrollTimer.current = null
  }

  function applyScroll(delta: number): void {
    setScroll((at) => Math.max(0, at + delta))
  }

  function queueScroll(delta: number): void {
    if (scrollTimer.current === null) {
      // A single tap should feel immediate. Repeats arriving during the next
      // frame are accumulated and committed together when the timer fires.
      applyScroll(delta)
      scrollTimer.current = setTimeout(() => {
        scrollTimer.current = null
        const accumulated = queuedScroll.current
        queuedScroll.current = 0
        if (mounted.current && accumulated !== 0) applyScroll(accumulated)
      }, HISTORY_SCROLL_FRAME_MS)
      return
    }
    queuedScroll.current += delta
  }

  useEffect(() => () => {
    mounted.current = false
    cancelQueuedScroll()
  }, [])

  function announce(message: string): void {
    if (mounted.current) setNote(message)
  }

  function adapterFor(client: string): Adapter | undefined {
    return adapters.find((adapter) => adapter.id === client)
  }

  function emit(plan: ExecPlan): void {
    if (executing.current) return
    executing.current = true
    onExec(plan)
    exit()
  }

  function planSafely(adapter: Adapter, row: NonNullable<typeof selectedRow>, brief?: string): {
    plan: ExecPlan | null
    failed: boolean
  } {
    try {
      return { plan: adapter.plan(row, brief), failed: false }
    } catch {
      announce('could not plan this session')
      return { plan: null, failed: true }
    }
  }

  function activate(): void {
    const row = selectedRow
    if (!row || executing.current) return
    const adapter = adapterFor(row.client)
    if (!adapter) { announce(`no adapter for ${boundedDisplayText(row.client, 32)}`); return }

    if (row.tier === 'resume') {
      const { plan, failed } = planSafely(adapter, row)
      if (!plan) {
        if (!failed) announce('this session cannot be launched')
        return
      }
      if (plan.kind !== 'resume') { announce('adapter plan does not match the resume session'); return }
      emit(plan)
      return
    }

    let brief: string | null
    try {
      brief = buildBrief(db, row.uid)
    } catch {
      announce('could not build a brief for this session')
      return
    }
    if (!brief) { announce('nothing indexed for this session yet'); return }
    const { plan, failed } = planSafely(adapter, row, brief)
    if (!plan) {
      if (!failed) announce('this session cannot be launched')
      return
    }
    if (plan.kind !== 'brief') { announce('adapter plan does not match the search session'); return }
    setConfirm({ plan, chars: brief.length, client: boundedDisplayText(row.client, 32) })
  }

  async function writeClipboard(text: string, success: string): Promise<void> {
    if (!clipboardApi) { announce('clipboard unavailable'); return }
    try {
      const result = await clipboardApi.writeText(text)
      announce(result === 'sent' ? `${success.replace(/ copied$/u, '')} copy sequence sent` : success)
    } catch {
      announce('copy failed')
    }
  }

  function copyPrompt(): void {
    const row = selectedRow
    if (!row) return
    try {
      const result = db.raw().query(`
        SELECT substr(prompts, 1, ?) AS prompts FROM session_text WHERE uid = ?
      `).get(COPY_PROMPT_CHARS, row.uid) as { prompts: string | null } | null
      const prompt = sanitizePromptForClipboard(result?.prompts?.split(/\r?\n/u, 1)[0] ?? '')
      if (!prompt) { announce('no indexed prompt for this session'); return }
      void writeClipboard(prompt, 'first prompt copied')
    } catch {
      announce('could not read the first prompt')
    }
  }

  function copyCommand(): void {
    const row = selectedRow
    if (!row) return
    if (row.tier !== 'resume') { announce('no resume command for this client'); return }
    const adapter = adapterFor(row.client)
    if (!adapter) { announce('no resume command for this client'); return }
    const { plan } = planSafely(adapter, row)
    try {
      if (!plan || plan.kind !== 'resume') { announce('no resume command for this client'); return }
    } catch {
      announce('resume command unsafe to copy')
      return
    }
    const command = safeCommandForClipboard(plan)
    if (!command) { announce('resume command unsafe to copy'); return }
    void writeClipboard(command, 'resume command copied')
  }

  function cycleClient(): void {
    const index = CLIENTS.indexOf(sessions.client as typeof CLIENTS[number])
    sessions.setClient(CLIENTS[(index + 1) % CLIENTS.length])
  }

  useInput((input, key) => {
    if (executing.current) return
    if (confirm) {
      if (key.return) emit(confirm.plan)
      else if (key.escape) setConfirm(null)
      return
    }
    if (key.ctrl && input === 'c') { exit(); return }
    if (key.ctrl && input === 'o') {
      cancelQueuedScroll()
      setInspecting((previous) => !previous)
      setScroll(0)
      return
    }
    if (inspecting) {
      // Escape closes what it opened before it closes the picker.
      if (key.escape) { cancelQueuedScroll(); setInspecting(false); setScroll(0); return }
      if (key.upArrow) { queueScroll(-1); return }
      if (key.downArrow) { queueScroll(1); return }
      if (key.pageUp) {
        cancelQueuedScroll(); setScroll((at) => Math.max(0, at - detailLines)); return
      }
      if (key.pageDown) {
        cancelQueuedScroll(); setScroll((at) => at + detailLines); return
      }
      // Anything that changes the list would move the ground under the reader,
      // so typing leaves the history and goes back to searching.
      if (input && !key.ctrl && !key.meta) {
        cancelQueuedScroll(); setInspecting(false); setScroll(0)
      }
    }
    if (key.escape) { exit(); return }
    if (key.upArrow) { sessions.move(-1); setScroll(0); return }
    if (key.downArrow) { sessions.move(1); setScroll(0); return }
    if (key.tab) { sessions.toggleScope(); return }
    if (key.return) { activate(); return }
    if (key.backspace || key.delete) {
      sessions.setText(deleteLastGrapheme(sessions.text))
      return
    }

    if (key.ctrl && input === 'p') { copyPrompt(); return }
    if (key.ctrl && input === 'y') { copyCommand(); return }
    if (key.ctrl && input === 'f') { cycleClient(); return }
    if (input && !key.ctrl && !key.meta) {
      sessions.setText(boundedDisplayText(`${sessions.text}${input}`, SEARCH_COLUMNS))
    }
  })

  if (confirm) {
    const cmd = boundedDisplayText(confirm.plan.cmd, 80) || '(unknown command)'
    const directory = boundedDisplayText(confirm.plan.cwd, 120) || '(unknown directory)'
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="yellow">Start a new briefed session</Text>
        <Text>{cmd} in {directory}</Text>
        <Text dimColor>
          {confirm.client} cannot resume by id. This starts a NEW session seeded with a {confirm.chars} character brief.
        </Text>
        <Text dimColor>It carries no tool state or file snapshots, and it costs tokens.</Text>
        <Box marginTop={1}><Text>enter to continue, esc to go back</Text></Box>
      </Box>
    )
  }

  const shownSearch = boundedDisplayText(sessions.text, SEARCH_COLUMNS)
  const shownClient = sessions.client ? boundedDisplayText(sessions.client, 32) : ''
  const shownNote = boundedDisplayText(note, 120)
  // The root is pinned to the terminal so Yoga, not a hardcoded chrome estimate,
  // decides who yields space. The list takes the slack the preview leaves; both
  // clip rather than pushing the frame past the last row and scrolling the top away.
  // Name what is being filtered. "this directory" left the reader guessing
  // which one, and launching from a parent made it look like it did nothing.
  const scope = sessions.scope ? projectName(sessions.scope) : 'everywhere'
  const context = [`${sessions.rows.length} sessions`, scope, shownClient, shownNote]
    .filter(Boolean).join(' · ')
  // The first key names what enter does to the row under the cursor, so the
  // hint matches the outcome instead of always promising a resume.
  const enterLabel = selectedRow && selectedRow.tier !== 'resume' ? 'brief' : 'resume'
  const narrowed = sessions.scope !== null
  const empty = sessions.rows.length === 0
  // A directory with almost nothing in it is the first thing a new user sees,
  // so it points at the key that widens the search rather than sitting blank.
  const sparse = !empty && narrowed && sessions.rows.length <= 1
  // Named, not drawn. A reader who does not already know that ⇥ means tab
  // cannot find the key, and the hints elsewhere say "press tab" in words.
  const keys: [string, string][] = inspecting
    ? [
      ['up/down', 'scroll'], ['pgup/pgdn', 'page'],
      ['enter', enterLabel], ['ctrl+o', 'close'], ['esc', 'close'],
    ]
    // Keys that act on a session are not offered when there is no session to
    // act on; a hint that does nothing is worse than one that is missing.
    : [
      ...(selectedRow
        ? [
          ['enter', enterLabel], ['ctrl+o', 'history'],
          ['ctrl+p', 'prompt'], ['ctrl+y', 'command'],
        ] as [string, string][]
        : []),
      ['ctrl+f', 'client'], ['tab', 'scope'], ['esc', 'quit'],
    ]

  // The root is pinned to the terminal so Yoga, not a hardcoded chrome estimate,
  // decides who yields space. The list takes the slack the preview leaves; both
  // clip rather than pushing the frame past the last row and scrolling the top away.
  return (
    <Box flexDirection="column" height={terminalHeight} overflow="hidden">
      <Box flexShrink={0}>
        <Box flexGrow={1}><Text dimColor wrap="truncate-end">nekyia</Text></Box>
        <Text dimColor wrap="truncate-end">{context}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text color="cyan">{'▸ '}</Text>
        <Text>{shownSearch}</Text>
        <Text dimColor>{shownSearch ? '' : 'type to search'}</Text>
      </Box>
      <Box
        ref={listRef} marginTop={1}
        flexGrow={inspecting ? 0 : 1} flexShrink={1}
        height={inspecting ? INSPECT_LIST_ROWS : undefined} minHeight={1}
        flexDirection="column" overflow="hidden"
      >
        {empty
          ? <EmptyState searching={Boolean(sessions.text.trim())} narrowed={narrowed} />
          : (
            <List
              rows={sessions.rows} selected={sessions.selected}
              height={listHeight} now={now} columns={terminalWidth} query={sessions.text}
            />
          )}
      </Box>
      {selectedRow ? (
        <>
          <Box flexShrink={0} marginTop={1}>
            <Text dimColor>{'─'.repeat(Math.max(1, terminalWidth))}</Text>
          </Box>
          <Box
            ref={detailRef}
            flexGrow={inspecting ? 1 : 0} flexShrink={1} minHeight={1}
            height={inspecting ? undefined : previewLines(terminalHeight)}
            flexDirection="column" overflow="hidden"
          >
            <Preview lines={detail} offset={offset} maxLines={detailLines} />
          </Box>
        </>
      ) : null}
      {sparse && !inspecting ? <SparseHint project={scope} /> : null}
      <Box flexShrink={0} marginTop={1}>
        <Text wrap="truncate-end">
          {fitKeys(keys, terminalWidth).map(([key, label], index) => (
            <Text key={key}>
              {index ? <Text dimColor>{'   '}</Text> : null}
              <Text>{key}</Text><Text dimColor>{` ${label}`}</Text>
            </Text>
          ))}
        </Text>
      </Box>
    </Box>
  )
}
