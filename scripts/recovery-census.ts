#!/usr/bin/env bun
/**
 * Counts what a session store could tell a recovery command, without quoting any of it.
 *
 * Two questions, one walk. Kind coverage says how often an operation is
 * knowable at all, which is what `timeline` has to be honest about. Byte
 * reconstructibility says how often the pre-edit content is really there,
 * which decides whether a `recover` command is worth writing.
 */
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOTS = [
  join(homedir(), '.claude', 'projects'),
  join(homedir(), '.codex', 'sessions'),
]

/** What a tool call proves about the file it names. */
type Recoverability = 'whole' | 'patch' | 'mention'

interface Counts {
  calls: number
  byKind: Map<string, number>
  byRecoverability: Map<Recoverability, number>
  unknownTools: Map<string, number>
}

function empty(): Counts {
  return { calls: 0, byKind: new Map(), byRecoverability: new Map(), unknownTools: new Map() }
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1)
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

function classifyCodex(input: string, counts: Counts): void {
  for (const line of input.split(/\r?\n|\\n/u)) {
    const match = /^\*\*\* (Add|Update|Delete) File: /u.exec(line)
    if (!match) continue
    counts.calls++
    const verb = match[1]
    bump(counts.byKind, verb === 'Add' ? 'write' : verb === 'Delete' ? 'delete' : 'edit')
    // An Add carries the whole file after its header; the others are hunks
    // against a base this census cannot see.
    bump(counts.byRecoverability, verb === 'Add' ? 'whole' : 'patch')
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

    for (const file of files) {
      const text = await Bun.file(file).text().catch(() => '')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let row: Record<string, unknown>
        try {
          row = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const message = row.message as Record<string, unknown> | undefined
        if (client === 'claude' && Array.isArray(message?.content)) {
          for (const block of message.content as Array<Record<string, unknown>>) {
            if (block?.type === 'tool_use' && typeof block.name === 'string') {
              classifyClaude(block.name, block.input, counts)
            }
          }
        }
        const payload = (row.type === 'response_item' ? row.payload : row) as
          Record<string, unknown> | undefined
        if (client === 'codex' && payload?.type === 'custom_tool_call'
          && typeof payload.input === 'string') {
          classifyCodex(payload.input, counts)
        }
      }
    }
  }

  for (const [client, counts] of perClient) {
    console.log(`\n## ${client}`)
    console.log(`sessions: ${sessions.get(client) ?? 0}, path-naming calls: ${counts.calls}`)
    console.log('\nkind coverage:')
    for (const [kind, n] of [...counts.byKind].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${kind.padEnd(8)} ${n} (${((n / counts.calls) * 100).toFixed(1)}%)`)
    }
    console.log('\nbyte reconstructibility:')
    for (const [shape, n] of [...counts.byRecoverability].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${shape.padEnd(8)} ${n} (${((n / counts.calls) * 100).toFixed(1)}%)`)
    }
    if (counts.unknownTools.size > 0) {
      console.log('\ntools dominating the unknown bucket:')
      for (const [name, n] of [...counts.unknownTools].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        console.log(`  ${name.padEnd(16)} ${n}`)
      }
    }
  }
}

await main()
