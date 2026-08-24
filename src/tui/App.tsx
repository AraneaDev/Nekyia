import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import type { Config } from '../config'
import type { Adapter } from '../core/adapter'
import { buildBrief } from '../core/brief'
import type { IndexDb } from '../core/db'
import { shellQuote } from '../core/resume'
import type { ExecPlan } from '../types'
import { boundedDisplayText, List } from './List'
import { Preview } from './Preview'
import { useSessions } from './useSessions'
import { createHostClipboard, type ClipboardLike } from './clipboard'

const CLIENTS = [undefined, 'claude', 'codex', 'opencode', 'kilo', 'codebuff', 'agy'] as const
const SEARCH_COLUMNS = 512
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

function safeHeight(rows: unknown): number {
  return typeof rows === 'number' && Number.isFinite(rows)
    ? Math.max(5, Math.floor(rows) - 12)
    : 12
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
}

export function App({
  db, cfg, adapters, cwd, now, onExec, clipboard,
  clipboardFactory = createHostClipboard,
}: AppProps) {
  const { exit } = useApp()
  const sessions = useSessions(db, cfg, cwd)
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const [note, setNote] = useState('')
  const executing = useRef(false)
  const mounted = useRef(true)
  const selectedRow = sessions.rows[sessions.selected]
  const clipboardApi = useMemo(
    () => clipboard === undefined ? clipboardFactory() : clipboard,
    [clipboard, clipboardFactory],
  )

  useEffect(() => () => { mounted.current = false }, [])

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
    if (key.escape || (key.ctrl && input === 'c')) { exit(); return }
    if (key.upArrow) { sessions.move(-1); return }
    if (key.downArrow) { sessions.move(1); return }
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
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{'> '}</Text>
        <Text>{shownSearch}</Text>
        <Text dimColor>{shownSearch ? '' : 'type to search'}</Text>
      </Box>
      <Box marginTop={1}>
        <List rows={sessions.rows} selected={sessions.selected} height={safeHeight(process.stdout.rows)} now={now} />
      </Box>
      <Box marginTop={1} borderStyle="single" borderColor="gray" flexDirection="column">
        <Preview row={selectedRow} db={db} now={now} />
      </Box>
      <Box>
        <Text dimColor>
          {sessions.rows.length} sessions - {sessions.scope === 'cwd' ? 'this directory' : 'everywhere'}
          {shownClient ? ` - ${shownClient}` : ''}{shownNote ? ` - ${shownNote}` : ''}
        </Text>
      </Box>
      <Box><Text dimColor>enter run - ctrl+p prompt - ctrl+y command - ctrl+f client - tab scope - esc quit</Text></Box>
    </Box>
  )
}
