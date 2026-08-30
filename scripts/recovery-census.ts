#!/usr/bin/env bun
/**
 * Counts what a session store could tell a recovery command, without quoting any of it.
 *
 * Three questions, one walk.
 *
 * Kind coverage says how often an operation is knowable at all, which is what
 * `timeline` has to be honest about.
 *
 * Byte reconstructibility says how often a call carries content. It reads tool
 * inputs only, and the first version of this census stopped there and drew a
 * recovery conclusion from it. That was the wrong denominator twice over: a
 * `Read` names a file in its input and returns the file in its result, so
 * counting inputs alone files every read under "mention" and makes the store
 * look far poorer than it is.
 *
 * Per-file coverage is the question a recovery command actually faces: for one
 * file that is gone, is there anything to hand back? It matches tool results to
 * their calls, takes the best evidence anywhere in the session, and then asks
 * git whether it already had the file, because content git also holds is not
 * worth recovering from a transcript.
 *
 * Counts only. No path, prompt or file content is printed, here or anywhere.
 */
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

const ROOTS = [
  join(homedir(), '.claude', 'projects'),
  join(homedir(), '.codex', 'sessions'),
]

/** A tool result shorter than this is a status line, not a file. */


/** What a tool call proves about the file it names. */
type Recoverability = 'whole' | 'patch' | 'mention'

/** The best a session can offer for one file, if that file were gone. */
type Evidence = 'whole' | 'fragment' | 'none'

const EVIDENCE_RANK: Record<Evidence, number> = { none: 0, fragment: 1, whole: 2 }

interface Counts {
  calls: number
  byKind: Map<string, number>
  byRecoverability: Map<Recoverability, number>
  unknownTools: Map<string, number>
  /** Per distinct file per session, keyed by the best evidence found for it. */
  byEvidence: Map<Evidence, number>
  /** Of files with whole or fragment evidence, what git already has. */
  tracked: number
  untracked: number
  uncheckable: number
}

function empty(): Counts {
  return {
    calls: 0,
    byKind: new Map(),
    byRecoverability: new Map(),
    unknownTools: new Map(),
    byEvidence: new Map(),
    tracked: 0,
    untracked: 0,
    uncheckable: 0,
  }
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

/**
 * Whether a tool call's input names a file at all.
 *
 * The census counts path-naming calls, so a call that names none must not
 * reach the denominator: `AskUserQuestion` and `WebSearch` are not operations
 * on a file whose kind went unrecognised, they are calls this question is not
 * about. Codex is already counted this way, one patch header at a time, so
 * gating claude the same way is what makes the two columns comparable.
 *
 * Deliberately a local copy of what `src/formats/paths.ts` does rather than an
 * import: this script measures a store from the outside, and would otherwise
 * be measuring the indexer's own opinion of itself.
 */
const PATH_KEYS = new Set([
  'file_path', 'filePath', 'path', 'notebook_path', 'notebookPath', 'file',
])

function looksLikePath(value: string): boolean {
  if (value.length <= 1 || /[\r\n]/u.test(value)) return false
  if (!/\s/u.test(value)) return true
  if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//iu.test(value)) return false
  if (/^(?:\/|\.\.?\/|~\/|[A-Za-z]:[\\/])/u.test(value)) return true
  return /[/\\]/u.test(value) || /\.[A-Za-z0-9]{1,16}$/u.test(value)
}

/** The first path-shaped value in a call's input, which is the file the call is about. */
function firstPath(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = firstPath(child)
      if (found !== null) return found
    }
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  for (const [key, child] of Object.entries(value)) {
    if (PATH_KEYS.has(key) && typeof child === 'string' && looksLikePath(child)) return child
    const found = firstPath(child)
    if (found !== null) return found
  }
  return null
}

const CLAUDE_TOOL_KINDS: Record<string, string> = {
  Read: 'read', NotebookRead: 'read',
  Write: 'write',
  Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
}

function classifyClaude(name: string, input: unknown, counts: Counts): void {
  const kind = CLAUDE_TOOL_KINDS[name] ?? 'unknown'
  counts.calls++
  bump(counts.byKind, kind)
  if (kind === 'unknown') bump(counts.unknownTools, name)
  const body = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  if (typeof body.content === 'string') bump(counts.byRecoverability, 'whole')
  else if (typeof body.old_string === 'string') bump(counts.byRecoverability, 'patch')
  else bump(counts.byRecoverability, 'mention')
}

function classifyCodex(input: string, counts: Counts, files: Map<string, Evidence>): void {
  for (const line of input.split(/\r?\n|\\n/u)) {
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(line)
    if (!match) continue
    counts.calls++
    const verb = match[1]!
    bump(counts.byKind, verb === 'Add' ? 'write' : verb === 'Delete' ? 'delete' : 'edit')
    // An Add carries the whole file after its header; the others are hunks
    // against a base this census cannot see.
    bump(counts.byRecoverability, verb === 'Add' ? 'whole' : 'patch')
    const path = match[2]!.trim()
    if (!looksLikePath(path)) continue
    // A Delete header says the file existed and is gone. That is a fact about
    // the timeline, not a byte a recovery could return.
    record(files, path, verb === 'Add' ? 'whole' : verb === 'Update' ? 'fragment' : 'none')
  }
}

/** Keeps the best evidence seen for a file, since a recovery needs only one good copy. */
function record(files: Map<string, Evidence>, path: string, evidence: Evidence): void {
  const held = files.get(path)
  if (held === undefined || EVIDENCE_RANK[evidence] > EVIDENCE_RANK[held]) {
    files.set(path, evidence)
  }
}



const trackedByRoot = new Map<string, Set<string> | null>()
const rootByCwd = new Map<string, string | null>()

function gitRoot(cwd: string): string | null {
  const held = rootByCwd.get(cwd)
  if (held !== undefined) return held
  let root: string | null = null
  try {
    const proc = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], {
      stdout: 'pipe', stderr: 'ignore',
    })
    if (proc.exitCode === 0) {
      const out = new TextDecoder().decode(proc.stdout).trim()
      if (out) root = out
    }
  } catch {
    root = null
  }
  rootByCwd.set(cwd, root)
  return root
}

function trackedFiles(root: string): Set<string> | null {
  const held = trackedByRoot.get(root)
  if (held !== undefined) return held
  let set: Set<string> | null = null
  try {
    const proc = Bun.spawnSync(['git', '-C', root, 'ls-files', '-z'], {
      stdout: 'pipe', stderr: 'ignore',
    })
    if (proc.exitCode === 0) {
      set = new Set(new TextDecoder().decode(proc.stdout)
        .split('\0')
        .filter((entry) => entry.length > 0)
        .map((entry) => join(root, entry)))
    }
  } catch {
    set = null
  }
  trackedByRoot.set(root, set)
  return set
}

/**
 * Folds one session's files into the totals, asking git what it already holds.
 *
 * Only files with content are asked about: whether git tracks a file nobody can
 * recover anyway says nothing. Tracked status is read as of now rather than as
 * of when the session ran, which is the honest limit of measuring after the
 * fact, and a directory that is gone or was never a repository is counted as
 * uncheckable rather than as untracked, because guessing there would inflate
 * the one number the build decision rests on.
 */
function fold(counts: Counts, files: Map<string, Evidence>, cwd: string | null): void {
  const root = cwd ? gitRoot(cwd) : null
  const tracked = root ? trackedFiles(root) : null
  for (const [path, evidence] of files) {
    bump(counts.byEvidence, evidence)
    if (evidence === 'none') continue
    if (!cwd || !tracked) {
      counts.uncheckable++
      continue
    }
    const resolved = isAbsolute(path) ? normalize(path) : normalize(join(cwd, path))
    if (tracked.has(resolved)) counts.tracked++
    else counts.untracked++
  }
}

function walk(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) walk(path, out)
    else if (entry.endsWith('.jsonl')) out.push(path)
  }
}

interface PendingCall {
  name: string
  path: string
  windowed: boolean
}

async function readSession(file: string, client: string, counts: Counts): Promise<void> {
  const text = await Bun.file(file).text().catch(() => '')
  const files = new Map<string, Evidence>()
  const pending = new Map<string, PendingCall>()
  let cwd: string | null = null

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof row.cwd === 'string' && row.cwd) cwd = row.cwd

    const message = row.message as Record<string, unknown> | undefined
    if (client === 'claude' && Array.isArray(message?.content)) {
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          const path = firstPath(block.input)
          if (path === null) continue
          classifyClaude(block.name, block.input, counts)
          const body = block.input as Record<string, unknown>
          if (typeof body?.content === 'string') record(files, path, 'whole')
          else if (typeof body?.old_string === 'string') record(files, path, 'fragment')
          else record(files, path, 'none')
          if (typeof block.id === 'string') {
            pending.set(block.id, {
              name: block.name,
              path,
              // A read that asked for a window returns one, so the transcript
              // holds part of the file even when the result looks substantial.
              windowed: body?.offset !== undefined || body?.limit !== undefined,
            })
          }
        }
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const call = pending.get(block.tool_use_id)
          pending.delete(block.tool_use_id)
          if (!call || block.is_error === true) continue
          if (typeof block.content !== 'string' && !Array.isArray(block.content)) continue
          if (call.name === 'Read' || call.name === 'NotebookRead') {
            record(files, call.path, call.windowed ? 'fragment' : 'whole')
          }
        }
      }
    }

    const payload = (row.type === 'response_item' ? row.payload : row) as
      Record<string, unknown> | undefined
    if (client === 'codex') {
      if (payload?.type === 'custom_tool_call' && typeof payload.input === 'string') {
        classifyCodex(payload.input, counts, files)
      }
      if (payload?.type === 'function_call' && typeof payload.arguments === 'string') {
        try {
          const parsed = JSON.parse(payload.arguments) as Record<string, unknown>
          const path = firstPath(parsed)
          if (path !== null) {
            const name = typeof payload.name === 'string' ? payload.name : 'unknown'
            classifyClaude(name, parsed, counts)
            pending.set('codex', {
              name,
              path,
              windowed: parsed.offset !== undefined || parsed.limit !== undefined,
            })
          }
        } catch {
          // Malformed tool arguments
        }
      }
      if (payload?.type === 'function_call_output') {
        const call = pending.get('codex')
        pending.delete('codex')
        if (call && typeof payload.output === 'string') {
          if (call.name === 'Read' || call.name === 'NotebookRead') {
            record(files, call.path, call.windowed ? 'fragment' : 'whole')
          }
        }
      }
    }
    // Codex states its working directory once, in the metadata row that opens a
    // rollout, which is nested under `payload` like a response item but is not
    // one. Reading only the response-item shape finds nothing and silently
    // makes every codex file uncheckable against git.
    if (client === 'codex' && row.type === 'session_meta') {
      const meta = row.payload as Record<string, unknown> | undefined
      if (typeof meta?.cwd === 'string' && meta.cwd) cwd = meta.cwd
    }
  }

  fold(counts, files, cwd)
}

function percent(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : 'n/a'
}

async function main(): Promise<void> {
  const perClient = new Map<string, Counts>()
  const sessions = new Map<string, number>()

  for (const root of ROOTS) {
    const client = root.includes('.codex') ? 'codex' : 'claude'
    const files: string[] = []
    walk(root, files)
    sessions.set(client, (sessions.get(client) ?? 0) + files.length)
    const counts = perClient.get(client) ?? empty()
    perClient.set(client, counts)
    for (const file of files) await readSession(file, client, counts)
  }

  for (const [client, counts] of perClient) {
    console.log(`\n## ${client}`)
    console.log(`sessions: ${sessions.get(client) ?? 0}, path-naming calls: ${counts.calls}`)

    console.log('\nkind coverage:')
    for (const [kind, n] of [...counts.byKind].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${kind.padEnd(8)} ${n} (${percent(n, counts.calls)})`)
    }

    console.log('\nbyte reconstructibility, by call, tool inputs only:')
    for (const [shape, n] of [...counts.byRecoverability].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${shape.padEnd(8)} ${n} (${percent(n, counts.calls)})`)
    }

    const distinct = [...counts.byEvidence.values()].reduce((a, b) => a + b, 0)
    console.log('\nper-file coverage, one row per file per session, results included:')
    for (const shape of ['whole', 'fragment', 'none'] as Evidence[]) {
      const n = counts.byEvidence.get(shape) ?? 0
      console.log(`  ${shape.padEnd(8)} ${n} (${percent(n, distinct)})`)
    }
    console.log(`  distinct files: ${distinct}`)

    const withContent = counts.tracked + counts.untracked + counts.uncheckable
    console.log('\ngit overlap, files with whole or fragment content:')
    console.log(`  tracked     ${counts.tracked} (${percent(counts.tracked, withContent)})`)
    console.log(`  untracked   ${counts.untracked} (${percent(counts.untracked, withContent)})`)
    console.log(`  uncheckable ${counts.uncheckable} (${percent(counts.uncheckable, withContent)})`)

    if (counts.unknownTools.size > 0) {
      // The tool names themselves are the author's installed inventory, so the
      // census reports their shape rather than listing them.
      const total = [...counts.unknownTools.values()].reduce((a, b) => a + b, 0)
      const editing = [...counts.unknownTools.keys()]
        .filter((name) => /edit|write|patch|create|delete|save/iu.test(name))
      console.log(`\nunknown-kind calls: ${total} across ${counts.unknownTools.size} tools`)
      console.log(`  names suggesting a file edit: ${editing.length}`)
    }
  }
}

await main()
