import type Database from 'bun:sqlite'
import type { DialogueTurn } from '../types'

const PASSAGE_CHARS = 4096
const OVERLAP_CHARS = 256
const ENVELOPES = ['environment_context', 'skills_instructions', 'apps_instructions',
  'plugins_instructions', 'permissions instructions', 'collaboration_mode',
  'recommended_plugins', 'system-reminder', 'local-command-caveat', 'local-command-stdout']

/** Filter recognized harness envelopes for search only; retained history stays verbatim. */
export function searchableText(text: string): string {
  let result = text.replace(/^# AGENTS\.md instructions for [^\n]*\r?\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/u, '')
  if (/^# AGENTS\.md instructions for [^\n]*$/u.test(result)) return ''
  if (/^Base directory for this skill:/u.test(result)) return ''
  let previous: string
  do {
    previous = result
    for (const tag of ENVELOPES) {
      result = result.replace(new RegExp(`^\\s*<${tag}>[\\s\\S]*?</${tag}>\\s*`, 'u'), '')
    }
  } while (result !== previous)
  return result.trim()
}

/** Legacy facets have no message boundaries; standalone harness records split searchable segments. */
export function* legacySearchTurns(role: DialogueTurn['role'], text: string): Generator<DialogueTurn> {
  const tags = ENVELOPES.join('|')
  const envelope = new RegExp(`(?:^|\\n)(?:# AGENTS\\.md instructions for [^\\n]*\\r?\\n\\s*<INSTRUCTIONS>[\\s\\S]*?</INSTRUCTIONS>|[ \t]*<(?<tag>${tags})>[\\s\\S]*?</\\k<tag>>)`,'gu')
  let offset = 0
  for (const match of text.matchAll(envelope)) {
    const segment = text.slice(offset, match.index)
    if (segment.trim()) yield { role, text: segment }
    offset = match.index + match[0].length
  }
  const segment = text.slice(offset)
  if (segment.trim()) yield { role, text: segment }
}

/** Oversized tokens separate passages rather than manufacturing adjacency between their neighbors. */
function* chunks(text: string): Generator<string> {
  let start = 0
  for (const token of text.matchAll(/\S+/gu)) {
    if (token[0].length <= PASSAGE_CHARS) continue
    yield* boundedChunks(text.slice(start, token.index))
    start = token.index + token[0].length
  }
  yield* boundedChunks(text.slice(start))
}

/** Split at whitespace with bounded overlap, keeping tokens intact. */
function* boundedChunks(text: string): Generator<string> {
  let offset = 0
  while (offset < text.length) {
    let end = Math.min(text.length, offset + PASSAGE_CHARS)
    if (end < text.length && !/\s/u.test(text[end]!)) {
      while (end > offset && !/\s/u.test(text[end - 1]!)) end--
    }
    yield text.slice(offset, end)
    if (end === text.length) break
    offset = Math.max(offset + 1, end - OVERLAP_CHARS)
    // Starting inside a token would make an identifier's suffix searchable.
    while (offset < end && !/\s/u.test(text[offset - 1]!)) offset++
  }
}

/** Atomically replaced alongside the original session text and ordered history. */
export function writePassages(db: Database, uid: string, title: string, dialogue: readonly DialogueTurn[]): void {
  db.query('DELETE FROM session_passage WHERE uid = ?').run(uid)
  const insert = db.query('INSERT INTO session_passage (uid, title, prompt, reply) VALUES (?, ?, ?, ?)')
  const heading = searchableText(title)
  if (heading) insert.run(uid, heading, '', '')
  const seen = new Set<string>()
  for (const turn of dialogue) {
    if (turn.role !== 'user' && turn.role !== 'assistant') continue
    for (const text of chunks(searchableText(turn.text))) {
      if (!text.trim()) continue
      const key = text
      if (seen.has(key)) continue
      seen.add(key)
      insert.run(uid, '', turn.role === 'user' ? text : '', turn.role === 'assistant' ? text : '')
    }
  }
}
