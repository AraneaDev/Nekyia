import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdin } from 'ink'
import { configDir, saveLauncherChoice, type Config } from '../config'
import { canBrief, type Adapter } from '../core/adapter'
import { buildBrief } from '../core/brief'
import { buildHandoffPlan, MAX_HANDOFF_NOTE_LENGTH, preambleForIntent } from '../core/handoff'
import type { IndexDb } from '../core/db'
import {type TimePreset} from '../core/time-range'
import {
  defaultOnPath, nextLauncher, presentations, resolveForLaunch, type OnPath, type ResolveForLaunch,
} from '../core/launcher'
import { checkPlan, shellQuote } from '../core/resume'
import type { ExecPlan } from '../types'
import { clientColor, List, listWindow } from './List'
import { boundedDisplayText, boundedPathTail, MAX_DISPLAY_COLUMNS, prefixByCodeUnits, wrappedDisplayLines } from './text'
import { projectName, relTime } from '../render'
import { Preview } from './Preview'
import { buildSummaryLines } from './summary'
import { StatsPanel } from './StatsPanel'
import { resultStats } from './result-stats'
import { SESSION_DISPLAY_LIMIT, useSessions } from './useSessions'
import { createHostClipboard, type ClipboardLike } from './clipboard'

import {readSessionDetail, qualityBadge} from '../core/session-detail'
import {readMatchEvidence} from '../core/search-match'
import {compileSearch} from '../core/search-text'
import {chainMembers} from '../core/session-chains'
import {querySnapshot, resolveFacetPath, type Row} from '../core/query'
import {bookmarkStore as createBookmarkStore, type BookmarkStore} from '../core/ui-state'
import {actionsFor, type ActionId} from './actions.js'
import {Actions, Menu} from './ActionMenu'
import {Filters} from './Filters'
import {History} from './History'
import {Details} from './Details'
import {ChainPicker} from './ChainPicker'
import {Bookmarks} from './Bookmarks'
import {paneLayout} from './layout'
import {emptySuggestions} from './empty-state'
import {type PickerRestore} from './state'

const SEARCH_COLUMNS = 512
/** First-paint estimate of non-list chrome; layout measurement corrects it immediately. */

/**
 * Below this height the decorative chrome costs more than it gives. Full chrome
 * is eleven rows, so sixteen is the first height that still leaves the list four
 * rows; under it the separating rule and the two blank spacer rows are dropped
 * and the list gets them back. The preview stays: a list you can see and a
 * session you cannot is the wrong half to keep.
 */

const TIME_LABELS: Record<TimePreset, string> = {
  all: 'All time', today: 'Today', yesterday: 'Yesterday', '7d': 'Last 7 days', '30d': 'Last 30 days',
}

/**
 * Content lines the preview may claim. Derived from the terminal alone, never
 * from its own content, so sizing cannot feed back into itself.
 */
/**
 * An empty screen is the one place with nothing useful to displace, so it says
 * what to do next rather than reporting that a query matched nothing.
 */
function EmptyState({ searching, narrowed, timeFiltered, indexedEmpty = true }: {
  searching: boolean; narrowed: boolean; timeFiltered: boolean; indexedEmpty?: boolean
}) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text>{timeFiltered ? 'No sessions match this time range.' : searching ? 'Nothing came up.' : indexedEmpty ? 'No sessions indexed yet.' : 'No sessions match these filters.'}</Text>
      <Text dimColor wrap="truncate-end">
        {timeFiltered
          ? <>Press <Text color="cyan">ctrl+u</Text> to clear time, or <Text color="cyan">ctrl+d</Text> to change it.</>
          : searching
          ? <>Try fewer words{narrowed ? <>, or press <Text color="cyan">tab</Text> to search everywhere</> : null}.</>
          : !indexedEmpty ? <>Press ctrl+g to reset filters, or use the suggested Actions.</>
          : <>Run <Text color="cyan">nekyia index</Text> to read the histories your agent CLIs already keep.</>}
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

/** Below this, the index is fresh; at or past it, a reindex is worth considering. */
const STALE_INDEX_MS = 3_600_000
/** At or past this, the index is old enough that search results are likely wrong. */
const VERY_STALE_INDEX_MS = 86_400_000

/** How urgently the index's age should be shown, in the same tiers the status line colors. */
export type IndexAgeSeverity = 'fresh' | 'stale' | 'very-stale'

/** Classifies an index age into the severity the status line colors it by. */
export function indexAgeSeverity(ageMs: number): IndexAgeSeverity {
  if (ageMs >= VERY_STALE_INDEX_MS) return 'very-stale'
  if (ageMs >= STALE_INDEX_MS) return 'stale'
  return 'fresh'
}

/**
 * How old the index is, in words that survive their own youngest case.
 *
 * `relTime` answers "now" for anything under a minute, which is right on its
 * own in a column and wrong the moment a suffix is glued to it: "index now old"
 * contradicts itself, and contradicts the green it is drawn in. The line used to
 * appear only once an index was an hour stale, so the phrasing had never met the
 * case that always showing it introduced.
 */
function freshlyIndexed(indexedAt: number, now: number): string {
  const span = relTime(indexedAt, now)
  return span === 'now' ? 'index just refreshed' : `index ${span} old`
}

/** The status-line color for each age severity, escalating from confirmation to warning. */
export const SEVERITY_COLOR: Record<IndexAgeSeverity, string> = {
  fresh: 'green',
  stale: 'yellow',
  'very-stale': 'red',
}

/** Splits the screen between the list and the session preview, scaled to terminal height. */
export function previewLines(rows: number): number {
  // About a third of the screen, so a tall terminal shows the session rather
  // than a dozen lines under a very long list, while the list keeps the rest.
  return Math.max(4, Math.min(Math.floor(rows / 3), Math.max(4, rows - 10)))
}

/**
 * The name to show for a handoff target: the launcher that will actually
 * receive the brief, not the manifest's own name.
 *
 * A manifest with launchers can be named "Codebuff / Freebuff" for display
 * elsewhere, but only the launcher with a brief command can ever receive one
 * (Freebuff takes no prompt), so showing the combined name as a handoff
 * target overstates what will run. Falls back to the manifest name for a
 * client with no launchers of its own.
 */
export function handoffTargetName(adapter: Adapter): string {
  const launchers = adapter.manifest.launchers
  if (!launchers) return adapter.manifest.name
  const briefer = Object.values(launchers).find((launcher) => launcher.brief)
  return briefer?.name ?? adapter.manifest.name
}
const COPY_PROMPT_CHARS = 65_536
const COPY_PROMPT_BYTES = 16_384
const COPY_COMMAND_BYTES = 8_192
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
/**
 * Everything a copied prompt must not carry, which is every control but one.
 *
 * A newline is a prompt's own shape rather than a terminal instruction, and a
 * prompt written across several lines is worth pasting as it was written. A
 * lone carriage return is not spared: it moves a cursor rather than a line.
 */
const CLIPBOARD_CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu
const CLIPBOARD_BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/gu
const UNSAFE_COMMAND = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/u

export type { ClipboardLike } from './clipboard'

/**
 * Details of a session launch confirmation, including the execution plan and client.
 */
interface Confirmation {
  plan: ExecPlan
  chars: number
  client: string
  source?: string
  /** The framing shown to the target, bounded for display; absent for the default continue intent. */
  framing?: string
}

/** A wrapped, scrollable confirmation whose action hints never compete with its body for rows. */
function BriefConfirmation({ details, rows, columns }: {
  details: Confirmation
  rows: number
  columns: number
}) {
  const [scroll, setScroll] = useState(0)
  const width = Math.max(1, columns - 2)
  const lines = useMemo(() => {
    const cmd = boundedDisplayText(details.plan.cmd, 80) || '(unknown command)'
    const directory = boundedDisplayText(details.plan.cwd, 120) || '(unknown directory)'
    return [
      'Start a new briefed session',
      `${cmd} in ${directory}`,
      `Start a new session in ${details.client} with a ${details.chars} character brief.`,
      ...(details.source ? [`Context from the selected ${details.source} session.`] : []),
      ...(details.framing ? [`Framing: ${details.framing}`] : []),
      'It carries no tool state or file snapshots, and it costs tokens.',
      'The target client may send this context to its configured model provider.',
    ].flatMap((text) => wrappedDisplayLines(text, width))
  }, [details, width])
  const actions = wrappedDisplayLines('enter continue, esc back', width)
  const overflowing = lines.length + actions.length > rows
  const footerRows = Math.max(0, rows - 1)
  const footerLines = [
    ...(overflowing ? wrappedDisplayLines('up/down scroll', width) : []),
    ...actions,
  ]
  const footer = footerRows === 0 ? [] : footerLines.slice(-footerRows)
  const visible = Math.min(lines.length, Math.max(1, rows - footer.length))
  const maxScroll = Math.max(0, lines.length - visible)
  const offset = Math.min(scroll, maxScroll)

  // A resize can expose the whole body; do not revive a stale offset when it shrinks again.
  useEffect(() => { setScroll((previous) => Math.min(previous, maxScroll)) }, [maxScroll])
  useInput((_input, key) => {
    if (key.upArrow) setScroll(Math.max(0, offset - 1))
    else if (key.downArrow) setScroll(Math.min(maxScroll, offset + 1))
    else if (key.pageUp) setScroll(Math.max(0, offset - visible))
    else if (key.pageDown) setScroll(Math.min(maxScroll, offset + visible))
  })

  return (
    <Box flexDirection="column" paddingX={1} width={columns} height={visible + footer.length} overflow="hidden">
      {lines.slice(offset, offset + visible).map((line, index) => (
        <Box key={offset + index} height={1} flexShrink={0}>
          <Text bold={offset + index === 0} color={offset + index === 0 ? 'yellow' : undefined} wrap="truncate-end">
            {line}
          </Text>
        </Box>
      ))}
      {footer.map((line, index) => (
        <Box key={`footer-${index}`} height={1} flexShrink={0}>
          <Text dimColor wrap="truncate-end">{line}</Text>
        </Box>
      ))}
    </Box>
  )
}

/** Holds the source fixed while the user navigates handoff targets. */
interface HandoffPicker {
  uid: string
  source: string
  adapters: Adapter[]
  index: number
}

/**
 * Cleans prompt text for clipboard use, stripping unsafe controls and bounding length.
 */
function sanitizePromptForClipboard(text: string): string {
  let sample = text.slice(0, COPY_PROMPT_CHARS)
  const last = sample.charCodeAt(sample.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) sample = sample.slice(0, -1)
  const safe = sample
    .replace(/\r\n/gu, '\n')
    .replace(CLIPBOARD_CONTROLS, ' ')
    .replace(CLIPBOARD_BIDI, '')
  const bytes = new TextEncoder().encode(safe)
  if (bytes.byteLength <= COPY_PROMPT_BYTES) return safe
  let end = COPY_PROMPT_BYTES
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return new TextDecoder().decode(bytes.subarray(0, end))
}

/** Records how much text the copy guard inspected, so the bound can be asserted in tests. */
export interface CommandCopyWork {
  scannedCodeUnits: number
}

/**
 * Checks if a single code unit represents a control or bidirectional formatting character.
 */
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

/**
 * Renders a launch command safe to place on the clipboard, or null when it cannot be.
 *
 * The clipboard is a loaded gun: this text may be pasted straight into a
 * shell. Every value is quoted, control and bidi characters are refused
 * outright, and the work is bounded so a hostile transcript cannot stall the
 * picker.
 */
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

/**
 * Removes the last grapheme cluster from a string safely, handling multi-code-unit characters.
 */
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

/**
 * Dimensions of the terminal viewport.
 */
interface TerminalSize { rows: number; columns: number }

/**
 * A React hook that tracks the active terminal size and reacts to window resizes.
 */
function useTerminalSize(rowsIn?: number, columnsIn?: number): TerminalSize {
  /**
   * Reads the current terminal dimensions, falling back to safe defaults if unavailable.
   */
  const read = (): TerminalSize => ({
    rows: terminalRows(rowsIn ?? process.stdout.rows),
    columns: terminalRows(columnsIn ?? process.stdout.columns, 80),
  })
  const [size, setSize] = useState(read)
  useEffect(() => {
    /**
     * Polls the latest dimensions and updates state if they changed since the last paint.
     */
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
 * Printable input always searches. Picker actions use ctrl+p, ctrl+y and ctrl+f
 * so a query can begin with any ordinary letter.
 */
export interface AppProps {
  db: IndexDb
  cfg: Config
  adapters: Adapter[]
  cwd: string
  now: number
  /**
   * Hands the chosen launch to the host.
   *
   * `pendingCopy` is a clipboard write still in flight, if one is. The host must
   * settle it before the client takes the terminal over: the OSC 52 fallback
   * writes its escape sequence to stdout, and the helper process is a child of
   * this one, so an unawaited copy either lands in the client's terminal or dies
   * with the picker.
   */
  onExec: (plan: ExecPlan, pendingCopy?: Promise<void>) => void
  /** Preflight for handoffs while the target picker can still report failures. */
  checkResumePlan?: typeof checkPlan
  checkHandoffPlan?: typeof checkPlan
  /** Whether a launcher's command is on PATH. Injectable so tests never depend on the host. */
  onPath?: OnPath
  /** Persists a launcher choice. Injectable so tests never write the user's config. */
  saveLauncher?: (clientId: string, launcher: string) => Promise<void>
  /** Requests a reindex. Offered, and ctrl+r wired to it, only once the index has gone stale. */
  onReindex?: () => void
  /** null explicitly disables copying; undefined uses the host clipboard when present. */
  clipboard?: ClipboardLike | null
  /** Injectable factory keeps host clipboard selection testable without side effects. */
  clipboardFactory?: () => ClipboardLike | null
  /** Injectable terminal height; the live terminal is used when omitted. */
  rows?: number
  /** Injectable terminal width; the live terminal is used when omitted. */
  columns?: number
  /**
   * When the index was last written, as Unix epoch milliseconds.
   *
   * Omitted when it cannot be read, which leaves the age unstated rather than
   * guessed at.
   */
  indexedAt?: number
  clock?: () => number
  initialState?: PickerRestore
  onStateChange?: (state: PickerRestore) => void
  initialNotice?: string
  bookmarkStore?: BookmarkStore
}

/** The picker: search, scoping, client filtering, history inspection, and launch. */
export function App({
  db, cfg, adapters, cwd, now, onExec, onReindex, clipboard,
  clipboardFactory = createHostClipboard, rows, columns, indexedAt,
  checkHandoffPlan = checkPlan, checkResumePlan = checkPlan, onPath, saveLauncher = saveLauncherChoice,
  initialState, onStateChange, initialNotice, bookmarkStore: storeIn, clock,
}: AppProps) {
  const { exit } = useApp()
  const {stdin}=useStdin()
  const { rows: terminalHeight, columns: terminalWidth } = useTerminalSize(rows, columns)
  const [mode,setMode]=useState<'actions'|'help'|'filters'|'history'|'details'|'chain'|'bookmarks'|null>(initialState?.reader?'history':null)
  const [helpOpen,setHelpOpen]=useState(false)
  useEffect(()=>{
    /** Recognizes F1 while preserving the active dialog draft. */
    const onKey=(chunk:Buffer|string)=>{if(['\x1bOP','\x1b[11~'].includes(String(chunk))){if(mode==='help')return;if(mode||confirm||handoff||launcherAsk)setHelpOpen(true);else setMode('help')}}
    stdin.on('data',onKey);return()=>{stdin.off('data',onKey)}
  })
  const [readerUid,setReaderUid]=useState<string|null>(initialState?.reader?.anchor.uid??null)
  const [readerState,setReaderState]=useState<PickerRestore['reader']>(initialState?.reader??null)
  const store=useMemo(()=>storeIn??createBookmarkStore(configDir()),[storeIn])
  const [savedBookmarks,setSavedBookmarks]=useState(()=>store.load())
  const bookmarkUids=useMemo(()=>new Set(savedBookmarks.state.uids),[savedBookmarks.state])
  const pathCheck = useMemo(() => onPath ?? defaultOnPath(), [onPath])
  // Launcher choices made this run, layered over whatever was saved on disk. A
  // failed save still applies for the rest of the session, because refusing to
  // act on a choice that was just made would be a worse surprise than one that
  // does not survive a restart.
  const [choices, setChoices] = useState<Record<string, string>>(cfg.launchers ?? {})
  const liveCfg = useMemo(() => ({ ...cfg, launchers: choices }), [cfg, choices])
  const shown = useMemo(
    () => presentations(adapters.map((adapter) => adapter.manifest), liveCfg, pathCheck),
    [adapters, liveCfg, pathCheck],
  )
  /** Which client to ask about, and which of its options is highlighted, while the picker waits on an answer. */
  const [launcherAsk, setLauncherAsk] = useState<{ client: string; uid:string; options: string[]; index: number } | null>(null)
  const sessions = useSessions(db, cfg, cwd, shown, now, initialState, bookmarkUids, clock)
  const readerAllowed=readerUid===null||sessions.snapshot.some(ref=>ref.uid===readerUid&&!cfg.hiddenClients?.includes(ref.client))
  const readerExtras=useMemo(()=>{
    if(!readerUid||!readerAllowed)return []
    const files=db.fileEventsForUid(readerUid)
    const metadata=db.fileDetailsFor([readerUid]).get(readerUid)
    const fallback=files.events.length?null:db.filePathsForUid(readerUid)
    return [...(files.events.length?files.events.map(event=>`${event.kind} ${event.path}`):fallback?.paths??[]),
      ...(metadata?.detail!=='ordered'?['file operation order unavailable']:[]),
      ...(files.capped||fallback?.capped||metadata?.eventsTruncated?['file operation log was capped']:[])]
  },[db,readerUid,readerAllowed])
  const selectedRow = sessions.rows[sessions.selected]
  const handoffTargets = useMemo(
    () => adapters.filter((adapter) => adapter.id !== selectedRow?.client && !cfg.hiddenClients?.includes(adapter.id) && canBrief(adapter.manifest)),
    [adapters, selectedRow?.client, cfg.hiddenClients],
  )
  const [statsVisible, setStatsVisible] = useState(initialState?.statsVisible ?? true)
  const statsAvailable = terminalWidth >= 140 && terminalHeight >= 18
  const layout=paneLayout(terminalWidth,terminalHeight,4,statsVisible)
  const stats = useMemo(() => resultStats(sessions.rows, now), [sessions.rows, now])
  const reading=mode==='history'&&readerAllowed
  // Launch checks plan the session and, for a search-tier client, build its
  // whole brief. They depend on the selected row and launcher policy only, so
  // they run when the selection changes rather than on every keypress, and
  // they sit above the early returns so the input handler never reads them
  // before they exist. The reader shows none of them, so it never pays for them.
  const launchState=useMemo(()=>{
    if(reading)return {selectedAdapter:undefined,resolved:null,native:false,launchReason:null,contextReason:null}
    const selectedAdapter=selectedRow?adapterFor(selectedRow.client):undefined
    const resolved=selectedRow&&selectedAdapter?resolveRowLauncher(selectedAdapter,selectedRow):null
    const resolutionReason=selectedRow?.missing?'Source missing':!selectedAdapter?'No adapter available':resolved?.kind==='unavailable'?resolved.message:null
    const native=Boolean(selectedRow&&resolved&&resolved.kind==='resolved'&&resolved.tier==='resume')
    const checkedNative=(()=>{
      if(!native||!selectedRow||!selectedAdapter||resolved?.kind!=='resolved')return null
      try {
        const plan=selectedAdapter.plan(selectedRow,undefined,resolved.launcher)
        return plan?checkResumePlan(plan):{ok:false,reason:'This session cannot be launched'}
      }catch{return {ok:false,reason:'Could not validate the launch'}}
    })()
    const launchReason=resolutionReason??(checkedNative&&!checkedNative.ok?checkedNative.reason??'This session cannot be launched':null)
  
    const contextReason=(()=>{
      if(!selectedRow||!selectedAdapter||!canBrief(selectedAdapter.manifest))return 'No context launcher available'
      if(resolved?.kind==='unavailable')return resolved.message
      try {
        if(resolved?.kind==='resolved'&&resolved.tier==='search'){
          const brief=buildBrief(db,selectedRow.uid)
          if(!brief)return 'Nothing indexed for this session yet'
          const plan=selectedAdapter.plan(selectedRow,brief,resolved.launcher)
          if(!plan||plan.kind!=='brief')return 'This context session cannot be launched'
          const checked=checkResumePlan(plan)
          return checked.ok?null:checked.reason??'This context session cannot be launched'
        }
        const result=buildHandoffPlan(db,selectedRow.uid,selectedRow.client,adapters)
        if(!result.ok)return result.reason
        const checked=checkResumePlan(result.plan)
        return checked.ok?null:checked.reason??'This context session cannot be launched'
      }catch{return 'Could not validate the context launch'}
    })()
    return {selectedAdapter,resolved,native,launchReason,contextReason}
  },[reading,selectedRow,adapters,liveCfg,pathCheck,checkResumePlan,db])
  const {selectedAdapter,resolved,native,launchReason,contextReason}=launchState
  const detailLines = layout.mode === 'compact' ? 1 : previewLines(terminalHeight)
  const listHeight = Math.max(1, layout.bodyRows - detailLines)
  const summaryRows = layout.mode === 'compact' ? 1 : Math.max(1, detailLines - 1)
  const availabilityCache=useRef(new Map<string,string|null>())
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const [handoff, setHandoff] = useState<HandoffPicker | null>(null)
  /** null outside note-entry; a string, possibly empty, while typing a custom framing for the highlighted target. */
  const [handoffNote, setHandoffNote] = useState<string | null>(null)
  const [note, setNote] = useState(initialNotice??savedBookmarks.warning??'')
  const executing = useRef(false)
  const mounted = useRef(true)
  // The clipboard write still running, if any. Held so the launch can settle it
  // rather than racing the client for the terminal.
  const pendingCopy = useRef<Promise<void> | null>(null)
  const rich=useMemo(()=>selectedRow?readSessionDetail(db,selectedRow.uid):null,[db,selectedRow?.uid])
  const expression=compileSearch(sessions.text,'prefix-last')
  const matchingUid=selectedRow?.matchedUid??selectedRow?.uid
  const matchingDetail=useMemo(()=>matchingUid&&expression?readSessionDetail(db,matchingUid):null,[db,matchingUid,expression])
  const evidence=useMemo(()=>matchingUid&&expression?readMatchEvidence(db,matchingUid,expression,matchingDetail?.turns??[]):null,[db,matchingUid,expression,matchingDetail])
  const detail = useMemo(() => buildSummaryLines(selectedRow, rich, evidence, {
    columns: layout.previewWidth,
    maxLines: summaryRows,
  }), [selectedRow, rich, evidence, layout.previewWidth, summaryRows])
  useEffect(()=>{
    onStateChange?.({text:sessions.text,filters:sessions.filters,selectedUid:selectedRow?.uid??null,selectedIndex:sessions.selected,
      listTop:listWindow(sessions.rows,sessions.selected,listHeight,layout.listWidth,layout.mode!=='compact',bookmarkUids)[0],reader:reading?readerState:null,
      ...(!statsVisible ? { statsVisible: false } : {})})
  },[sessions.text,sessions.filters,selectedRow?.uid,sessions.selected,sessions.rows,listHeight,layout.listWidth,layout.mode,bookmarkUids,statsVisible,reading,readerState,onStateChange])
  const clipboardApi = useMemo(
    () => clipboard === undefined ? clipboardFactory() : clipboard,
    [clipboard, clipboardFactory],
  )

  useEffect(() => () => { mounted.current = false }, [])
  useEffect(()=>{
    if(mode==='history'&&!readerAllowed){setMode(null);setReaderUid(null);setReaderState(null);announce('Reader session is unavailable under current policy; returned to browse')}
  },[mode,readerAllowed])
  useEffect(()=>{
    if(readerAllowed&&initialState?.selectedUid&&!sessions.rows.some(row=>row.uid===initialState.selectedUid)){announce('Selected session no longer matches; nearest result selected')}
  },[])


  /**
   * Displays a temporary notification in the footer.
   */
  function announce(message: string): void {
    if (mounted.current) setNote(message)
  }

  /**
   * Retrieves the launch adapter registered for the given client ID.
   */
  function adapterFor(client: string): Adapter | undefined {
    return adapters.find((adapter) => adapter.id === client)
  }

  /**
   * Flushes the final launch plan to the host process and exits the picker.
   */
  function emit(plan: ExecPlan): void {
    if (executing.current) return
    executing.current = true
    onExec(plan, pendingCopy.current ?? undefined)
    exit()
  }

  /**
   * Safely calls the adapter's plan method, returning an object containing the plan and a boolean indicating if an adapter planning exception occurred.
   */
  function planSafely(
    adapter: Adapter, row: NonNullable<typeof selectedRow>, brief?: string, launcher?: string,
  ): {
    plan: ExecPlan | null
    failed: boolean
  } {
    try {
      return { plan: adapter.plan(row, brief, launcher), failed: false }
    } catch {
      announce('could not plan this session')
      return { plan: null, failed: true }
    }
  }

  /**
   * What to act on for a row's client: a settled launcher (undefined for a
   * client with no `launchers` of its own) and the tier to treat it as, a
   * question that still needs asking, or a refusal to explain instead.
   *
   * Both `activate` and `copyCommand` plan a launch for the selected row, and
   * both need the same answer to "which client, and does that change the
   * tier": `copyCommand` used to skip this and plan with no launcher at all,
   * which planned nothing once a resume-tier launcher was the active choice.
   */
  type RowLauncher = ResolveForLaunch

  /**
   * Resolves which launcher opens `row`'s store, and what tier to treat it as.
   *
   * A thin wrapper over `resolveForLaunch`: the resolution itself, and its
   * refusal wording for an uninstalled launcher, live in one place shared with
   * `nekyia last`.
   */
  function resolveRowLauncher(adapter: Adapter, row: NonNullable<typeof selectedRow>, chosen?: string): RowLauncher {
    return resolveForLaunch(adapter.manifest, row.tier, liveCfg, pathCheck, chosen)
  }

  /**
   * Initiates a resume or brief plan based on the currently selected row, confirming if necessary.
   *
   * `chosen` is the launcher just picked from the ask overlay, applied to this
   * activation immediately rather than waiting on the state update it also
   * triggers, so the same keypress that answers the question also acts on it.
   */
  function activate(chosen?: string, explicitRow?: Row): void {
    const row = explicitRow ?? selectedRow
    if (!row || executing.current) return
    const adapter = adapterFor(row.client)
    if (!adapter) { announce(`no adapter for ${boundedDisplayText(row.client, 32)}`); return }

    const resolved = resolveRowLauncher(adapter, row, chosen)
    if (resolved.kind === 'unavailable') { announce(resolved.message); return }
    if (resolved.kind === 'ask') { setLauncherAsk({ client: adapter.id, uid:row.uid, options: resolved.options, index: 0 }); return }
    const { launcher, tier } = resolved

    if (tier === 'resume') {
      const { plan, failed } = planSafely(adapter, row, undefined, launcher)
      if (!plan) {
        if (!failed) announce('this session cannot be launched')
        return
      }
      if (plan.kind !== 'resume') { announce('adapter plan does not match the resume session'); return }
      try {
        const checked=checkResumePlan(plan)
        if(!checked.ok){announce(checked.reason??'This session cannot be launched');return}
      }catch{announce('Could not validate the launch');return}
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
    const { plan, failed } = planSafely(adapter, row, brief, launcher)
    if (!plan) {
      if (!failed) announce('this session cannot be launched')
      return
    }
    if (plan.kind !== 'brief') { announce('adapter plan does not match the search session'); return }
    try {
      const checked=checkResumePlan(plan)
      if(!checked.ok){announce(checked.reason??'This context session cannot be launched');return}
    }catch{announce('Could not validate the launch');return}
    setConfirm({ plan, chars: brief.length, client: boundedDisplayText(launcher ?? row.client, 32) })
  }

  /** Applies a launcher choice for this run and saves it; a failed save still applies it for now. */
  async function chooseLauncher(client: string, name: string, thenActivate: boolean): Promise<void> {
    setLauncherAsk(null)
    setChoices((current) => ({ ...current, [client]: name }))
    if (thenActivate) {
      const uid=launcherAsk?.uid
      const ref=uid?db.getRef(uid):null
      activate(name,ref?{...ref,score:0,collapsed:0}:undefined)
    }
    try {
      await saveLauncher(client, name)
    } catch {
      announce('could not save the launcher choice; it applies to this run only')
    }
  }

  /** Flips the selected row's store to its next installed launcher. */
  function flipSelectedLauncher(): void {
    const adapter = selectedRow ? adapterFor(selectedRow.client) : undefined
    if (!adapter?.manifest.launchers) { announce('this client opens in only one way'); return }
    const next = nextLauncher(adapter.manifest, liveCfg, pathCheck)
    if (!next) { announce('only one of its clients is on PATH'); return }
    void chooseLauncher(adapter.id, next, false)
    announce(`opens in ${adapter.manifest.launchers[next]!.name}`)
  }

  /** Checks target capability without hiding configured choices. */
  function targetAvailability(target:Adapter):string|null {
    if(!handoff)return null
    const key=`${handoff.uid}:${target.id}`
    if(availabilityCache.current.has(key))return availabilityCache.current.get(key)!
    let reason:string|null
    try {
      const result=buildHandoffPlan(db,handoff.uid,target.id,adapters)
      if(!result.ok)reason=result.reason
      else {const checked=checkHandoffPlan(result.plan);reason=checked.ok?null:checked.reason??'Launcher unavailable'}
    }catch{reason='Could not validate this target'}
    availabilityCache.current.set(key,reason)
    return reason
  }
  /** Offers clients with brief templates, including those with no history yet. */
  function openHandoff(): void {
    if (!selectedRow) return
    const targets = handoffTargets
    if (!targets.length) { announce('no other client available'); return }
    setNote('')
    availabilityCache.current.clear()
    setHandoff({ uid: selectedRow.uid, source: selectedRow.client, adapters: targets, index: 0 })
  }

  /** Keeps planning and availability failures in the picker so another target can be chosen. */
  function chooseHandoffTarget(preamble?: string): void {
    if (!handoff) return
    const target = handoff.adapters[handoff.index]
    if (!target) return
    const unavailable=targetAvailability(target)
    if(unavailable){announce(unavailable);return}
    try {
      const result = buildHandoffPlan(db, handoff.uid, target.id, adapters, { preamble })
      if (!result.ok) { announce(boundedDisplayText(result.reason, 120)); return }
      const checked = checkHandoffPlan(result.plan)
      if (!checked.ok) {
        announce(boundedDisplayText(checked.reason ?? 'this session cannot be launched', 120))
        return
      }
      setNote('')
      setConfirm({
        plan: result.plan, chars: result.briefChars,
        client: boundedDisplayText(handoffTargetName(target), 64),
        source: boundedDisplayText(handoff.source, 32),
        framing: preamble ? boundedDisplayText(preamble, 96) : undefined,
      })
    } catch {
      announce('could not plan this handoff')
    }
  }

  /**
   * Writes text to the host clipboard, notifying the user on success or failure.
   */
  async function writeClipboard(text: string, success: string): Promise<void> {
    if (!clipboardApi) { announce('clipboard unavailable'); return }
    try {
      const result = await clipboardApi.writeText(text)
      announce(result === 'sent' ? `${success.replace(/ copied$/u, '')} copy sequence sent` : success)
    } catch {
      announce('copy failed')
    }
  }

  /**
   * The first thing the user actually asked, whole.
   */
  function firstPromptText(uid: string): string {
    // The ordered turns are the only place a prompt's own boundaries survive.
    // The `prompts` facet is every prompt joined by newlines, so its first line
    // is the first line of the first prompt, and a prompt written across
    // several lines came back with the rest of itself missing.
    try {
      const turn = db.raw().query(`
        SELECT substr(text, 1, ?) AS text FROM session_turn
        WHERE uid = ? AND role = 'user' ORDER BY ordinal LIMIT 1
      `).get(COPY_PROMPT_CHARS, uid) as { text: string | null } | null
      if (turn?.text) return turn.text
    } catch {
      // No turn table, or none that can be read: a session indexed before
      // ordered turns existed has only the flat facet, and so does one whose
      // reader records no dialogue. Fall through rather than refuse.
    }
    const flat = db.raw().query(`
      SELECT substr(prompts, 1, ?) AS prompts FROM session_text WHERE uid = ?
    `).get(COPY_PROMPT_CHARS, uid) as { prompts: string | null } | null
    return flat?.prompts?.split(/\r?\n/u, 1)[0] ?? ''
  }

  /**
   * Retrieves and copies the first valid prompt from the selected session to the clipboard.
   */
  function copyPrompt(): void {
    const row = selectedRow
    if (!row) return
    try {
      const prompt = sanitizePromptForClipboard(firstPromptText(row.uid))
      if (!prompt) { announce('no indexed prompt for this session'); return }
      pendingCopy.current = writeClipboard(prompt, 'first prompt copied')
    } catch {
      announce('could not read the first prompt')
    }
  }

  /**
   * Derives a safe CLI command to resume the selected session and copies it to the clipboard.
   */
  function copyCommand(): void {
    const row = selectedRow
    if (!row) return
    const adapter = adapterFor(row.client)
    if (!adapter) { announce('no resume command for this client'); return }
    const resolved = resolveRowLauncher(adapter, row)
    if (resolved.kind === 'unavailable') { announce(resolved.message); return }
    if (resolved.kind === 'ask') { announce('press enter or ctrl+l to choose which client opens this'); return }
    const { launcher, tier } = resolved
    if (tier !== 'resume') { announce('no resume command for this client'); return }
    const { plan } = planSafely(adapter, row, undefined, launcher)
    try {
      if (!plan || plan.kind !== 'resume') { announce('no resume command for this client'); return }
    } catch {
      announce('resume command unsafe to copy')
      return
    }
    const command = safeCommandForClipboard(plan)
    if (!command) { announce('resume command unsafe to copy'); return }
    pendingCopy.current = writeClipboard(command, 'resume command copied')
  }

  /** Opens a verified match anchor or literal retained-history fallback. */
  function openHistory(uid:string):void {
    setReaderUid(uid)
    const anchor=evidence?.uid===uid?evidence.anchor:null
    setReaderState({anchor:{uid,ordinal:anchor?.ordinal??null,offset:anchor?.offset??0,fallbackLine:0},findText:anchor?'':sessions.text,hitIndex:-1})
    setMode('history')
  }
  /** Captures current state before releasing Ink and refreshing the index. */
  function requestRefresh():void {
    if(!onReindex)return
    onStateChange?.({text:sessions.text,filters:sessions.filters,selectedUid:selectedRow?.uid??null,selectedIndex:sessions.selected,
      listTop:listWindow(sessions.rows,sessions.selected,listHeight,layout.listWidth,layout.mode!=='compact',bookmarkUids)[0],reader:reading?readerState:null,
      ...(!statsVisible ? { statsVisible: false } : {})})
    executing.current=true;onReindex();exit()
  }
  /** Waits for durable storage before changing the visible bookmark state. */
  async function toggleBookmark(uid:string,remove=false):Promise<void> {
    try {
      const state=remove?await store.remove(uid):await store.set(uid,!bookmarkUids.has(uid))
      if(mounted.current){setSavedBookmarks({...savedBookmarks,state});announce(remove?'Bookmark removed':'Bookmark saved')}
    }catch(error){announce(error instanceof Error?error.message:'Could not save bookmark')}
  }
  /** Routes the registry and keyboard through the existing launch handlers. */
  function dispatchAction(id:ActionId):void {
    setMode(null)
    if(id==='resume')activate()
    else if(id==='handoff'){
      if(handoffTargets.length)openHandoff()
      else if(resolved?.kind==='resolved'&&resolved.tier==='search')activate()
      else if(selectedRow&&selectedAdapter){
        try {
          const result=buildHandoffPlan(db,selectedRow.uid,selectedRow.client,adapters)
          if(!result.ok){announce(result.reason);return}
          const checked=checkResumePlan(result.plan)
          if(!checked.ok){announce(checked.reason??'This context session cannot be launched');return}
          setConfirm({plan:result.plan,chars:result.briefChars,client:boundedDisplayText(selectedRow.client,32)})
        }catch{announce('Could not validate the context launch')}
      }
    }
    else if(id==='inspect'&&selectedRow)openHistory(evidence?.uid??selectedRow.uid)
    else if(id==='inspect-match'&&matchingUid)openHistory(matchingUid)
    else if(id==='details')setMode('details')
    else if(id==='chain')setMode('chain')
    else if(id==='copy-prompt')copyPrompt()
    else if(id==='copy-command')copyCommand()
    else if(id==='bookmark'&&selectedRow)void toggleBookmark(selectedRow.uid)
    else if(id==='manage-bookmarks')setMode('bookmarks')
    else if(id==='filters')setMode('filters')
    else if(id==='clear-search')sessions.setText('')
    else if(id==='refresh')requestRefresh()
    else if(id==='stats'){
      if(statsAvailable)setStatsVisible(current=>!current)
      else announce('Stats need 140 columns and 18 rows')
    }
  }
  useInput((input, key) => {
    if (executing.current) return
    if (key.ctrl && input === 'c') { exit(); return }
    if(reading&&!helpOpen&&(key.ctrl&&(input==='d'||input==='u'))){
      if(input==='d')sessions.cycleTimePreset();else sessions.clearTimePreset();setHelpOpen(false);setMode(null);return
    }
    if (mode || helpOpen) return
    if (launcherAsk) {
      if (key.escape) { setLauncherAsk(null); return }
      if (key.tab || key.upArrow || key.downArrow) {
        setLauncherAsk({ ...launcherAsk, index: (launcherAsk.index + 1) % launcherAsk.options.length })
        return
      }
      if (key.return) { void chooseLauncher(launcherAsk.client, launcherAsk.options[launcherAsk.index]!, true); return }
      return
    }
    if (confirm) {
      if (key.return) emit(confirm.plan)
      else if (key.escape) setConfirm(null)
      return
    }
    if (handoff && handoffNote !== null) {
      if (key.escape) { setHandoffNote(null) }
      else if (key.ctrl && input === 'c') exit()
      else if (key.return) { chooseHandoffTarget(handoffNote.trim() || undefined) }
      else if (key.backspace || key.delete) setHandoffNote(deleteLastGrapheme(handoffNote))
      else if (input && !key.ctrl && !key.meta) {
        // `input` can be a whole pasted string in one call, so the cap has to
        // apply to the combined result, not gate on the note's length so far.
        setHandoffNote(prefixByCodeUnits(handoffNote + input, MAX_HANDOFF_NOTE_LENGTH).sample)
      }
      return
    }
    if (handoff) {
      if (key.escape) { setHandoff(null); setNote('') }
      else if (key.ctrl && input === 'c') exit()
      else if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1
        setHandoff({ ...handoff, index: (handoff.index + delta + handoff.adapters.length) % handoff.adapters.length })
        setNote('')
      } else if (key.return) chooseHandoffTarget()
      else if (input === 'r') chooseHandoffTarget(preambleForIntent('review'))
      else if (input === 'n') { setHandoffNote(''); setNote('') }
      return
    }
    if (key.ctrl && input === 'c') { exit(); return }
    if (key.ctrl && (input === 'd' || input === 'u')) {
      if (input === 'd') sessions.cycleTimePreset()
      else sessions.clearTimePreset()
      setMode(null)
      return
    }
    if (key.ctrl && input === 'o') {if(selectedRow)openHistory(evidence?.uid??selectedRow.uid);return}
    if (key.ctrl && input === 'k') {setMode('actions');return}
    if (key.ctrl && input === 'g') {setMode('filters');return}
    if (key.ctrl && input === 'b') {if(selectedRow)void toggleBookmark(selectedRow.uid);return}
    if (key.ctrl && input === 'e') {if(selectedRow)setMode('chain');return}
    if (key.ctrl && input === 's') {dispatchAction('stats');return}
    if (input === '\x1bOP' || input === '\x1b[11~' || input === '[11~') {setMode('help');return}
    if (key.escape) { exit(); return }
    if (key.upArrow) { sessions.move(-1); return }
    if (key.downArrow) { sessions.move(1); return }
    if (key.tab) { sessions.toggleScope(); return }
    if (key.return) {if(resolved?.kind==='resolved'&&resolved.tier==='search'&&contextReason&&handoffTargets.length)dispatchAction('handoff');else activate();return}
    if (key.backspace || key.delete) {
      sessions.setText(deleteLastGrapheme(sessions.text))
      return
    }

    if (key.ctrl && input === 'p') { copyPrompt(); return }
    if (key.ctrl && input === 'y') { copyCommand(); return }
    if (key.ctrl && input === 't') { dispatchAction('handoff'); return }
    if (key.ctrl && input === 'l') { flipSelectedLauncher(); return }
    if (key.ctrl && input === 'f') { sessions.cycleClient(); return }
    if (key.ctrl && input === 'r') {requestRefresh();return}
    if (input && !key.ctrl && !key.meta) {
      sessions.setText(boundedDisplayText(`${sessions.text}${input}`, SEARCH_COLUMNS))
    }
  })

  /** Dismisses the current overlay without resetting committed browse state. */
  const close=()=>{setHelpOpen(false);setMode(null)}
  const helpProps={helpOpen,
    /** Returns from contextual help to its still-mounted dialog. */
    onHelpClose:()=>setHelpOpen(false)}
  if(reading&&readerUid){
    const ref=sessions.snapshot.find(item=>item.uid===readerUid)
    const subtitle=ref?[ref.cwd?projectName(ref.cwd):'',ref.title??''].filter(Boolean).join(' · '):undefined
    return <History {...helpProps} key={readerUid} detail={readSessionDetail(db,readerUid)} evidence={evidence?.uid===readerUid?evidence:null} subtitle={subtitle}
      initial={readerState} extraLines={readerExtras} rows={terminalHeight} columns={terminalWidth} onPosition={setReaderState} onClose={close} onRefresh={requestRefresh}/>
  }
  if(helpOpen&&(launcherAsk||confirm||handoff))return <Menu title="Launch help" items={[
    {id:'choose',label:'Up/Down or Tab choose launcher/target'},
    {id:'confirm',label:'Enter confirms the displayed action'},
    {id:'context',label:'Fresh context starts a new session; native state is not transferred'},
    {id:'provider',label:'The configured provider may receive context; tokens may be used'},
    {id:'note',label:'Target menu: r review framing, n custom note'},
    {id:'back',label:'Escape goes back without discarding the current draft'},
  ]} rows={terminalHeight} columns={terminalWidth} onSelect={()=>{}} onClose={()=>setHelpOpen(false)}/>
  if(launcherAsk){
    const visible=Math.max(1,terminalHeight-3)
    const start=Math.max(0,launcherAsk.index-visible+1)
    return <Box flexDirection="column" width={terminalWidth} height={terminalHeight} overflow="hidden">
      <Text bold>Open with</Text>
      <Box flexGrow={1} flexDirection="column" overflow="hidden">{launcherAsk.options.slice(start,start+visible).map((name,index)=><Text key={name} wrap="truncate-end">{boundedDisplayText(`${start+index===launcherAsk.index?'▸ ':''}${name}`,terminalWidth)}</Text>)}</Box>
      <Text wrap="truncate-end">tab switch · enter open · esc cancel</Text>
    </Box>
  }
  if (confirm) {
    return <BriefConfirmation details={confirm} rows={terminalHeight} columns={terminalWidth} />
  }

  if (handoff && handoffNote !== null) {
    const target = handoff.adapters[handoff.index]
    return (
      <Box flexDirection="column" paddingX={1} width={terminalWidth} height={terminalHeight} overflow="hidden">
        <Text bold color="yellow" wrap="truncate-end">
          Custom note for {boundedDisplayText(target ? handoffTargetName(target) : '', 64)}
        </Text>
        <Text dimColor wrap="truncate-end">Replaces the default framing. Enter to launch, esc to go back.</Text>
        <Text wrap="truncate-end">{boundedPathTail(handoffNote, Math.max(1, terminalWidth - 2))}</Text>
      </Box>
    )
  }

  if (handoff) {
    const visible = Math.max(1, terminalHeight - 5)
    const start = Math.max(0, Math.min(handoff.index - Math.floor(visible / 2), handoff.adapters.length - visible))
    return (
      <Box flexDirection="column" paddingX={1} width={terminalWidth} height={terminalHeight} overflow="hidden">
        <Text bold color="yellow" wrap="truncate-end">Hand off to another client</Text>
        <Text dimColor wrap="truncate-end">Start fresh with the last indexed context.</Text>
        {handoff.adapters.slice(start, start + visible).map((adapter, offset) => (
          <Text key={adapter.id} color={start + offset === handoff.index ? 'cyan' : undefined} wrap="truncate-end">
            {start + offset === handoff.index ? '▸ ' : '  '}{boundedDisplayText(`${handoffTargetName(adapter)}${targetAvailability(adapter)?` — ${targetAvailability(adapter)}`:''}`, Math.max(1, terminalWidth - 6))}
          </Text>
        ))}
        <Text dimColor wrap="truncate-end">{handoff.index + 1}/{handoff.adapters.length} · up/down choose, enter continue, r review, n note, esc cancel</Text>
        <Text color="yellow" wrap="truncate-end">{boundedDisplayText(note, 120)}</Text>
      </Box>
    )
  }

  const actionItems=actionsFor({hasSelection:Boolean(selectedRow),canResume:Boolean(selectedRow&&(native||resolved?.kind==='ask')&&!launchReason),resumeReason:launchReason??(!native&&resolved?.kind!=='ask'?'Use Start fresh with context':null),
    canHandoff:Boolean(selectedRow&&(contextReason===null||handoffTargets.length)),handoffReason:contextReason,hasMatch:Boolean(evidence),hasPrompt:Boolean(rich?.latestUser),hasCommand:native&&!launchReason,
    bookmarked:Boolean(selectedRow&&bookmarkUids.has(selectedRow.uid)),hasQuery:Boolean(sessions.text),refreshing:!onReindex,statsVisible,statsAvailable}).map(item=>item.id==='resume'&&resolved?.kind==='ask'?{...item,label:'Choose launcher'}:item)
  const suggestions=!sessions.rows.length?emptySuggestions({text:sessions.text,filters:sessions.filters},sessions.countMatches):[]
  if(mode==='actions'&&suggestions.length)return <Menu title="Actions — widen search" {...helpProps} items={[...suggestions.map((item,index)=>({id:`suggestion:${index}`,label:item.label})),...actionItems]} rows={terminalHeight} columns={terminalWidth} onClose={close} onSelect={id=>{
    if(id.startsWith('suggestion:')){const item=suggestions[Number(id.split(':')[1])];if(item){sessions.setText(item.text);sessions.applyFilters(item.filters);close()}}
    else dispatchAction(id as ActionId)
  }}/>
  if(mode==='actions')return <Actions items={actionItems} {...helpProps} rows={terminalHeight} columns={terminalWidth} onAction={dispatchAction} onClose={close}/>
  if(mode==='help')return <Menu title="Help — browse shortcuts" items={[
    {id:'actions',label:'Ctrl+K Actions menu'},{id:'filters',label:'Ctrl+G Filters'},{id:'help',label:'F1 Help'},
    {id:'search',label:'Printable characters search'},
    {id:'scope',label:'Tab toggles project scope'},
    {id:'client',label:'Ctrl+F cycles client in browse'},
    {id:'time',label:'Ctrl+D cycles time presets'},
    {id:'clear-time',label:'Ctrl+U clears time'},
    {id:'launcher',label:'Ctrl+L Choose launcher'},
    // Prefixed: the Filters entry above and the filters action share an id, and a
    // repeated key makes React drop or duplicate one of the two rows.
    ...actionItems.map(item=>({id:`action:${item.id}`,label:`${item.shortcut??'Actions menu'} ${item.label}`,reason:item.reason})),
    {id:'reader',label:'History: Ctrl+F find · F3/Shift+F3 hit · Home/End · Esc back'},
  ]} rows={terminalHeight} columns={terminalWidth} onSelect={()=>{}} onClose={close}/>
  if(mode==='filters')return <Filters {...helpProps} clock={clock} value={sessions.filters} now={now} cwd={cwd} clients={sessions.clientCycle.filter((client):client is string=>client!==undefined)}
    branches={[...new Set(sessions.snapshot.filter(ref=>!cfg.hiddenClients?.includes(ref.client)).map(ref=>ref.gitBranch))]} rows={terminalHeight} columns={terminalWidth}
    onApply={value=>{sessions.applyFilters(value);close()}} onClose={close}/>
  if(mode==='details'&&rich)return <Details {...helpProps} detail={rich} refData={db.getRef(rich.uid)} launchReason={launchReason} rows={terminalHeight} columns={terminalWidth} onClose={close}/>
  if(mode==='bookmarks')return <Bookmarks {...helpProps} uids={savedBookmarks.state.uids.filter(uid=>!cfg.hiddenClients?.includes(uid.split(':')[0]!))} refs={sessions.snapshot.filter(ref=>!cfg.hiddenClients?.includes(ref.client))} rows={terminalHeight} columns={terminalWidth} onRemove={uid=>void toggleBookmark(uid,true)} onClose={close}/>
  if(mode==='chain'&&selectedRow){
    const members=chainMembers(sessions.snapshot,selectedRow.uid).filter(ref=>!cfg.hiddenClients?.includes(ref.client))
    const range=sessions.activeTimeRange
    const matching=new Set(querySnapshot(db,cfg,sessions.snapshot,{text:sessions.text,matchMode:'prefix-last',cwd:sessions.scope??undefined,client:sessions.client,...range,
      branch:sessions.filters.branch,file:sessions.filters.file?.exact?undefined:sessions.filters.file?.path,exactFile:sessions.filters.file?.exact?resolveFacetPath(sessions.filters.file.path,cwd)??undefined:undefined,
      bookmarkedUids:sessions.filters.bookmarkedOnly?bookmarkUids:undefined,includeMissing:true,collapse:false,now}).map(row=>row.uid))
    return <ChainPicker {...helpProps} items={members.map(ref=>({...ref,matchesFilters:matching.has(ref.uid),parentLabel:ref.parentNativeId?`parent ${ref.parentNativeId}${members.filter(member=>member.nativeId===ref.parentNativeId).length>1?' (ambiguous)':members.some(member=>member.nativeId===ref.parentNativeId)?'':' (unknown)'}`:'root'}))}
      rows={terminalHeight} columns={terminalWidth} onClose={close} onInspect={openHistory} actionForMember={uid=>{
        const member=members.find(ref=>ref.uid===uid)
        const adapter=member?adapterFor(member.client):undefined
        let label=member?.tier==='search'?'Start fresh with context':'Resume session'
        if(!member||!adapter)return {label,enabled:false,reason:'No adapter available'}
        const resolution=resolveRowLauncher(adapter,{...member,score:0,collapsed:0})
        if(resolution.kind==='unavailable')return {label,enabled:false,reason:resolution.message}
        if(resolution.kind==='ask')return {label:'Choose launcher',enabled:true,reason:null}
        label=resolution.tier==='search'?'Start fresh with context':'Resume session'
        if(member.missing&&resolution.tier==='resume')return {label,enabled:false,reason:'Source missing'}
        try {
          const brief=resolution.tier==='search'?buildBrief(db,member.uid):undefined
          const plan=adapter.plan(member,brief??undefined,resolution.launcher)
          if(!plan)return {label,enabled:false,reason:'This session cannot be launched'}
          const checked=checkResumePlan(plan)
          return {label,enabled:checked.ok,reason:checked.ok?null:checked.reason??'Launcher unavailable'}
        }catch{return {label,enabled:false,reason:'Could not validate the launch'}}
      }} onResume={uid=>{
        const row=members.find(member=>member.uid===uid);if(row){close();activate(undefined,{...row,score:0,collapsed:0})}
      }}/>
  }
  const timeFiltered=sessions.filters.time.kind==='custom'||sessions.timePreset!=='all'
  const filterLabel=[timeFiltered?(sessions.filters.time.kind==='custom'?'Custom time':TIME_LABELS[sessions.timePreset]):'',sessions.filters.sort!=='auto'?sessions.filters.sort:'',
    sessions.filters.branch!==undefined?`branch:${sessions.filters.branch??'none'}`:'',sessions.filters.file?`file:${sessions.filters.file.path}`:'',sessions.filters.bookmarkedOnly?'Bookmarked':''].filter(Boolean).join(' · ')
  const found=sessions.overflowed?`${SESSION_DISPLAY_LIMIT}+ sessions`:`${sessions.rows.length} session${sessions.rows.length===1?'':'s'}`
  const indexAge=indexedAt!==undefined&&Number.isFinite(indexedAt)?freshlyIndexed(indexedAt,now):''
  const badge=rich?qualityBadge(rich.reasons):''
  const status:{text:string;color?:string;dim?:boolean}[]=[
    {text:found},
    ...(filterLabel?[{text:filterLabel,color:'cyan'}]:[]),
    ...(badge?[{text:badge,color:'yellow'}]:[]),
    {text:sessions.scope?projectName(sessions.scope):'everywhere',dim:!sessions.scope},
    ...(sessions.client?[{text:sessions.client,color:clientColor(sessions.client)}]:[]),
    ...(note?[{text:note,color:'yellow'}]:[]),
    ...(indexAge&&indexedAt!==undefined?[{text:indexAge,color:SEVERITY_COLOR[indexAgeSeverity(now-indexedAt)],dim:indexAgeSeverity(now-indexedAt)==='fresh'}]:[]),
  ].map(part=>({...part,text:boundedDisplayText(part.text,terminalWidth)}))
  const primary=actionItems.find(item=>item.id===(resolved?.kind==='resolved'&&resolved.tier==='search'?'handoff':'resume'))
  // The primary action leads, because enter is the key most people press next;
  // when it cannot run its name stays, dimmed, rather than becoming a bare
  // "unavailable" that does not say what is unavailable.
  // Short forms, so the primary action costs no more width than the hint it
  // displaced and Filters still fits beside it at eighty columns.
  const primaryLabel=primary?.label==='Resume session'?'Resume':primary?.label==='Start fresh with context'?'Start fresh':primary?.label
  const keys:[string,string][]=[...(primaryLabel&&selectedRow?[['enter',primaryLabel]] as [string,string][]:[]),['ctrl+k','Actions'],['ctrl+g','Filters'],['F1','Help'],['ctrl+o','History'],...(statsAvailable?[['ctrl+s','Stats']] as [string,string][]:[]),['esc','quit']]
  const list=<List rows={sessions.rows} selected={sessions.selected} height={listHeight} now={now} columns={layout.listWidth} query={sessions.text} bookmarks={bookmarkUids} wrapSelected={layout.mode!=='compact'}/>
  const quick=<Preview lines={detail} maxLines={summaryRows}/>
  const availabilityText = resolved?.kind === 'ask' ? 'Choose launcher'
    : resolved?.kind === 'resolved' && resolved.tier === 'search'
      ? !handoffTargets.length && contextReason ? contextReason : 'Start fresh with context'
      : launchReason ?? 'Resume session available'
  const availabilityProblem = resolved?.kind === 'resolved' && resolved.tier === 'search'
    ? !handoffTargets.length && Boolean(contextReason)
    : resolved?.kind !== 'ask' && Boolean(launchReason)
  return <Box flexDirection="column" height={terminalHeight} width={terminalWidth} overflow="hidden">
    <Text wrap="truncate-end"><Text bold color="cyan">nekyia</Text>{status.map((part,index)=><React.Fragment key={index}>
      <Text dimColor>{' · '}</Text><Text color={part.color} dimColor={part.dim}>{part.text}</Text>
    </React.Fragment>)}</Text>
    {sessions.text
      ? <Text wrap="truncate-end"><Text color="cyan" bold>{'▸ '}</Text>{boundedPathTail(sessions.text,Math.max(1,terminalWidth-2))}</Text>
      : <Text wrap="truncate-end"><Text color="cyan" bold>{'▸ '}</Text><Text dimColor>type to search</Text></Text>}
    {!sessions.rows.length?<Box flexDirection="column" flexGrow={1} overflow="hidden">
      <EmptyState indexedEmpty={sessions.snapshot.length===0} searching={Boolean(sessions.text)} narrowed={sessions.scope!==null} timeFiltered={timeFiltered}/>
      {suggestions.map((item,index)=><Text key={item.label} wrap="truncate-end">{`${index+1}. ${item.label} (Actions)`}</Text>)}
      <Text dimColor wrap="truncate-end">Ctrl+K Actions · Ctrl+G edit/reset filters · Ctrl+R refresh</Text>
    </Box>:<Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Box height={listHeight} overflow="hidden">
        <Box width={layout.listWidth} flexShrink={0}>{list}</Box>
        {layout.statsWidth>0&&<>
          <Box width={2} flexShrink={0}><Text dimColor>{'│\n'.repeat(listHeight).trimEnd()}</Text></Box>
          <StatsPanel stats={stats} columns={layout.statsWidth} rows={listHeight} overflowed={sessions.overflowed}/>
        </>}
      </Box>
      {layout.mode!=='compact'&&<Text dimColor>{'─'.repeat(Math.min(MAX_DISPLAY_COLUMNS,terminalWidth))}</Text>}
      <Box height={detailLines} flexDirection="column" overflow="hidden">
        {quick}
        {layout.mode !== 'compact' && <Text dimColor={!availabilityProblem} color={availabilityProblem ? 'yellow' : undefined} wrap="truncate-end">{boundedDisplayText(availabilityText, layout.previewWidth)}</Text>}
      </Box>
    </Box>}
    <Text wrap="truncate-end">{fitKeys(keys,terminalWidth).map(([key,label],index)=><React.Fragment key={key}>
      {index?'   ':''}<Text color="cyan">{key}</Text> <Text dimColor={key!=='enter'||!primary?.enabled}>{label}</Text>
    </React.Fragment>)}</Text>
  </Box>
}
