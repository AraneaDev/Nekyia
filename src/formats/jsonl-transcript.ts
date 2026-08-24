import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { Glob } from 'bun'
import type { Config } from '../config'
import type { Manifest } from '../manifests/load'
import { makeUid } from '../types'
import type { Diagnostic, SessionDoc, SessionRef } from '../types'
import { collectPaths } from './paths'
import { userPromptText } from '../render'

const HEAD_BYTES = 16 * 1024
const MAX_ROW_CHARS = 4 * 1024 * 1024
const INJECTED_INPUT_PREFIXES = [
  '<recommended_plugins>',
  '<environment_context>',
  '<permissions instructions>',
  '<collaboration_mode>',
  '<apps_instructions>',
  '<plugins_instructions>',
  '<skills_instructions>',
  '<image_generation_notes>',
] as const

/** The contract every store reader implements: cheap discovery first, expensive hydration only for sessions that changed. */
export interface FormatModule {
  discover(
    manifest: Manifest,
    root: string,
  ): Promise<{ refs: SessionRef[]; diagnostics: Diagnostic[] }>
  hydrate(
    manifest: Manifest,
    root: string,
    ref: SessionRef,
    config: Config,
  ): Promise<SessionDoc>
}

type JsonObject = Record<string, unknown>
type BunFileHandle = ReturnType<typeof Bun.file>
type BunFileWriter = ReturnType<BunFileHandle['writer']>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function get(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined
  let current = value
  for (const part of path.split('.')) {
    if (!isObject(current)) return undefined
    current = current[part]
  }
  return current
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value
    .filter((block): block is JsonObject => isObject(block) && block.type === 'text')
    .map((block) => typeof block.text === 'string' ? block.text.trim() : '')
    .filter(Boolean)
    .join('\n')
    .trim()
}

function textOfType(
  value: unknown,
  type: 'input_text' | 'output_text',
  accept: (text: string) => boolean = () => true,
): string {
  if (!Array.isArray(value)) return ''
  return value
    .filter((block): block is JsonObject => isObject(block) && block.type === type)
    .map((block) => typeof block.text === 'string' ? block.text.trim() : '')
    .filter((text) => text.length > 0 && accept(text))
    .join('\n')
    .trim()
}

/**
 * Titles are bounded here only to keep one runaway line out of the index. The
 * limit matches the widest the display will ever draw, so a wide terminal is
 * never short of text that was thrown away at index time.
 */
const TITLE_LIMIT = 512

function firstLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0]!.trim()
  return line.length <= TITLE_LIMIT ? line : `${line.slice(0, TITLE_LIMIT - 1)}…`
}

function isInjectedInput(value: string): boolean {
  const trimmed = value.trimStart()
  return INJECTED_INPUT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

function codexInputText(value: unknown): string {
  return textOfType(value, 'input_text', (text) => !isInjectedInput(text))
}

function parsedTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function nativeIdFromFilename(path: string): string {
  const name = basename(path)
  if (name.endsWith('.jsonl')) return name.slice(0, -'.jsonl'.length)
  return name.slice(0, name.length - extname(name).length)
}

function warn(client: string, path: string | null, error: unknown): Diagnostic {
  return {
    client,
    level: 'warn',
    path,
    message: error instanceof Error ? error.message : String(error),
  }
}

async function readHead(path: string): Promise<string> {
  return Bun.file(path).slice(0, HEAD_BYTES).text()
}

function parseHead(text: string): {
  rows: JsonObject[]
  malformed: boolean
  incompleteFinalLine: boolean
} {
  const rows: JsonObject[] = []
  let malformed = false
  const lines = text.split('\n')
  const incompleteFinalLine = !text.endsWith('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (!line) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isObject(parsed)) rows.push(parsed)
      else malformed = true
    } catch {
      if (!(incompleteFinalLine && index === lines.length - 1)) malformed = true
    }
  }
  return { rows, malformed, incompleteFinalLine }
}

function baseRef(
  manifest: Manifest,
  path: string,
  stat: { size: number; mtime: Date },
  nativeId: string,
  startedAt: number,
  cwd: string | null,
  gitBranch: string | null,
  title: string | null,
): SessionRef {
  const endedAt = stat.mtime.getTime()
  return {
    uid: makeUid(manifest.id, nativeId),
    client: manifest.id,
    nativeId,
    cwd,
    gitBranch,
    title,
    startedAt,
    endedAt,
    turns: null,
    parentNativeId: null,
    tier: manifest.tier,
    origin: 'manifest',
    sourcePaths: [path],
    fingerprint: `${Math.floor(endedAt)}:${stat.size}`,
  }
}

function discoverClaude(
  manifest: Manifest,
  path: string,
  stat: { size: number; mtime: Date },
  rows: JsonObject[],
  headTruncated: boolean,
): SessionRef | null {
  const nativeId = nativeIdFromFilename(path)
  if (!nativeId) return null
  const first = rows[0]
  if (!first) {
    return headTruncated
      ? baseRef(
        manifest,
        path,
        stat,
        nativeId,
        stat.mtime.getTime(),
        null,
        null,
        null,
      )
      : null
  }
  let cwd: string | null = null
  let branch: string | null = null
  let title: string | null = null
  let startedAt = stat.mtime.getTime()
  let hasStartedAt = false

  for (const row of rows) {
    if (cwd === null && typeof row.cwd === 'string') cwd = row.cwd
    if (branch === null && typeof row.gitBranch === 'string') branch = row.gitBranch
    if (!hasStartedAt) {
      const parsed = parsedTimestamp(row.timestamp)
      if (parsed !== null) {
        startedAt = parsed
        hasStartedAt = true
      }
    }
    if (title === null && row.toolUseResult === undefined) {
      const message = isObject(row.message) ? row.message : undefined
      if (message?.role === 'user') {
        const text = userPromptText(textOf(message.content))
        if (text) title = firstLine(text)
      }
    }
  }

  return baseRef(manifest, path, stat, nativeId, startedAt, cwd, branch, title)
}

function discoverCodex(
  manifest: Manifest,
  path: string,
  stat: { size: number; mtime: Date },
  rows: JsonObject[],
): SessionRef | null {
  let nativeId: string | null = null
  let cwd: string | null = null
  let title: string | null = null
  let startedAt = stat.mtime.getTime()
  let hasMetadata = false

  for (const row of rows) {
    const payload = isObject(row.payload) ? row.payload : undefined
    if (!hasMetadata && row.type === 'session_meta' && payload
      && typeof payload.session_id === 'string' && payload.session_id.length > 0) {
        nativeId = payload.session_id
      if (typeof payload.cwd === 'string') cwd = payload.cwd
      startedAt = parsedTimestamp(row.timestamp) ?? startedAt
      hasMetadata = true
    }
    if (title === null && row.type === 'response_item' && payload?.type === 'message'
      && payload.role === 'user') {
      const text = codexInputText(payload.content)
      if (text) title = firstLine(text)
    }
  }

  return nativeId === null
    ? null
    : baseRef(manifest, path, stat, nativeId, startedAt, cwd, null, title)
}

function discoverGeneric(
  manifest: Manifest & { format: 'jsonl-transcript' },
  path: string,
  stat: { size: number; mtime: Date },
  rows: JsonObject[],
): SessionRef | null {
  const spec = manifest.jsonl.generic
  const idFrom = spec?.idFrom ?? 'filename'
  let nativeId = idFrom === 'filename' ? nativeIdFromFilename(path) : null
  let cwd: string | null = null
  let title: string | null = null
  let startedAt = stat.mtime.getTime()
  let hasStartedAt = false
  const userRoles = new Set(spec?.userRoles ?? ['user', 'human'])

  for (const row of rows) {
    if (nativeId === null) {
      const value = get(row, idFrom)
      if (typeof value === 'string' && value.length > 0) nativeId = value
    }
    if (cwd === null) {
      const value = get(row, spec?.cwdPath)
      if (typeof value === 'string') cwd = value
    }
    if (spec?.tsPath && !hasStartedAt) {
      const parsed = parsedTimestamp(get(row, spec.tsPath))
      if (parsed !== null) {
        startedAt = parsed
        hasStartedAt = true
      }
    }
    if (title === null) {
      const role = get(row, spec?.rolePath)
      const text = textOf(get(row, spec?.textPath))
      if (typeof role === 'string' && userRoles.has(role) && text) title = firstLine(text)
    }
  }

  return !nativeId
    ? null
    : baseRef(manifest, path, stat, nativeId, startedAt, cwd, null, title)
}

async function rowsFromStream(
  path: string,
  visit: (row: JsonObject) => void,
  manifest: Manifest & { format: 'jsonl-transcript' },
): Promise<boolean> {
  const decoder = new TextDecoder()
  let buffer = ''
  let scanner = new JsonRowScanner(manifest)
  let spoolDir: string | null = null
  let spoolFile: BunFileHandle | null = null
  let spoolWriter: BunFileWriter | null = null
  let skippedOversizedRow = false

  function visitLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isObject(parsed)) visit(parsed)
    } catch {
      // A malformed transcript row must not make hydration fail.
    }
  }

  async function finishRow(): Promise<void> {
    const file = spoolFile
    const writer = spoolWriter
    const directory = spoolDir
    spoolDir = null
    spoolFile = null
    spoolWriter = null
    if (file && writer && directory) {
      try {
        await writer.end()
        const disposition = classifyOversizedRow(scanner, manifest)
        if (disposition === 'discard') {
          skippedOversizedRow = true
        } else {
          visitLine(await file.text())
        }
      } finally {
        try {
          await file.delete()
        } finally {
          rmSync(directory, { recursive: true, force: true })
        }
      }
    } else {
      visitLine(buffer)
    }
    buffer = ''
    scanner = new JsonRowScanner(manifest)
  }

  async function startSpool(segment: string): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), 'nekyia-jsonl-spool-'))
    spoolDir = directory
    chmodSync(directory, 0o700)
    const file = Bun.file(join(directory, 'row.jsonl'))
    spoolFile = file
    const writer = file.writer({ highWaterMark: 64 * 1024 })
    spoolWriter = writer
    await writer.write(buffer)
    await writer.write(segment)
    buffer = ''
  }

  async function cleanupSpool(): Promise<void> {
    const file = spoolFile
    const writer = spoolWriter
    const directory = spoolDir
    spoolDir = null
    spoolFile = null
    spoolWriter = null
    try {
      if (writer) await writer.end()
    } finally {
      try {
        if (file) await file.delete()
      } finally {
        if (directory) rmSync(directory, { recursive: true, force: true })
      }
    }
  }

  async function consume(text: string): Promise<void> {
    let offset = 0
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset)
      const end = newline < 0 ? text.length : newline
      const segment = text.slice(offset, end)
      scanner.feed(segment)

      if (spoolWriter) {
        await spoolWriter.write(segment)
      } else {
        if (buffer.length + segment.length > MAX_ROW_CHARS) {
          // Unknown large rows may contain user prompts or tool inputs. Spooling
          // bounds memory until the structural scanner can classify the complete
          // row; only proven private output or prose is discarded without parsing.
          await startSpool(segment)
        } else {
          buffer += segment
        }
      }

      if (newline < 0) return
      await finishRow()
      offset = newline + 1
    }
  }

  try {
    for await (const chunk of Bun.file(path).stream()) {
      await consume(decoder.decode(chunk, { stream: true }))
    }
    await consume(decoder.decode())
    if (buffer || spoolFile) await finishRow()
    return skippedOversizedRow
  } finally {
    await cleanupSpool()
  }
}

type ScanContext = {
  kind: 'object' | 'array'
  path: string[]
  key: string | null
  expectingKey: boolean
}

class JsonRowScanner {
  private readonly contexts: ScanContext[] = []
  private readonly keys = new Set<string>()
  private readonly values = new Map<string, Set<string>>()
  private readonly relevantKeys = new Set<string>()
  private readonly relevantValues = new Set<string>()
  private inString = false
  private escaped = false
  private token = ''
  private tokenTruncated = false

  constructor(manifest: Manifest & { format: 'jsonl-transcript' }) {
    if (manifest.jsonl.variant === 'codex') {
      this.relevantValues.add('payload.type')
      this.relevantValues.add('payload.role')
    } else if (manifest.jsonl.variant === 'claude') {
      this.relevantKeys.add('toolUseResult')
      this.relevantValues.add('message.role')
      this.relevantValues.add('message.content.type')
    } else if (manifest.jsonl.generic?.rolePath) {
      this.relevantValues.add(manifest.jsonl.generic.rolePath)
    }
  }

  feed(text: string): void {
    for (const character of text) {
      if (this.inString) {
        if (this.escaped) {
          this.appendToken(`\\${character}`)
          this.escaped = false
        } else if (character === '\\') {
          this.escaped = true
        } else if (character === '"') {
          this.inString = false
          this.finishString()
        } else {
          this.appendToken(character)
        }
        continue
      }

      if (character === '"') {
        this.inString = true
        this.token = ''
        this.tokenTruncated = false
      } else if (character === '{') {
        this.contexts.push({
          kind: 'object',
          path: this.takeValuePath(),
          key: null,
          expectingKey: true,
        })
      } else if (character === '[') {
        this.contexts.push({
          kind: 'array',
          path: this.takeValuePath(),
          key: null,
          expectingKey: false,
        })
      } else if (character === '}' || character === ']') {
        this.contexts.pop()
      } else if (character === ',') {
        const context = this.contexts.at(-1)
        if (context?.kind === 'object') {
          context.key = null
          context.expectingKey = true
        }
      }
    }
  }

  hasKey(path: string): boolean {
    return this.keys.has(path)
  }

  hasValue(path: string, value: string): boolean {
    return this.values.get(path)?.has(value) ?? false
  }

  valuesAt(path: string): ReadonlySet<string> {
    return this.values.get(path) ?? new Set()
  }

  private finishString(): void {
    const context = this.contexts.at(-1)
    if (!context) return
    const decoded = this.decodeToken()
    if (context.kind === 'object' && context.expectingKey) {
      context.key = decoded
      context.expectingKey = false
      if (decoded !== null) {
        const path = [...context.path, decoded].join('.')
        if (this.relevantKeys.has(path)) this.keys.add(path)
      }
      return
    }

    const path = context.kind === 'object' && context.key !== null
      ? [...context.path, context.key]
      : context.path
    const key = path.join('.')
    if (decoded !== null && this.relevantValues.has(key)) {
      const values = this.values.get(key) ?? new Set<string>()
      if (values.size < 16) values.add(decoded)
      this.values.set(key, values)
    }
    if (context.kind === 'object') context.key = null
  }

  private appendToken(text: string): void {
    if (this.token.length + text.length <= 256) this.token += text
    else this.tokenTruncated = true
  }

  private decodeToken(): string | null {
    if (this.tokenTruncated) return null
    try {
      const decoded: unknown = JSON.parse(`"${this.token}"`)
      return typeof decoded === 'string' ? decoded : null
    } catch {
      return null
    }
  }

  private takeValuePath(): string[] {
    const context = this.contexts.at(-1)
    if (!context) return []
    if (context.kind === 'array' || context.key === null) return context.path
    const path = [...context.path, context.key]
    context.key = null
    return path
  }
}

function classifyOversizedRow(
  scanner: JsonRowScanner,
  manifest: Manifest & { format: 'jsonl-transcript' },
): 'discard' | 'preserve' | 'unknown' {
  if (manifest.jsonl.variant === 'codex') {
    if (scanner.hasValue('payload.type', 'function_call_output')) return 'discard'
    if (scanner.hasValue('payload.type', 'function_call')) return 'preserve'
    if (scanner.hasValue('payload.type', 'message')) {
      if (scanner.hasValue('payload.role', 'user')) return 'preserve'
      if (scanner.valuesAt('payload.role').size > 0) return 'discard'
    }
    return 'unknown'
  }
  if (manifest.jsonl.variant === 'claude') {
    if (scanner.hasKey('toolUseResult')) return 'discard'
    if (scanner.hasValue('message.role', 'user')) return 'preserve'
    if (scanner.hasValue('message.role', 'assistant')) {
      return scanner.hasValue('message.content.type', 'tool_use')
        ? 'preserve'
        : 'discard'
    }
    return 'unknown'
  }
  const rolePath = manifest.jsonl.generic?.rolePath
  if (!rolePath) return 'unknown'
  const roles = scanner.valuesAt(rolePath)
  const userRoles = new Set(manifest.jsonl.generic?.userRoles ?? ['user', 'human'])
  if ([...roles].some((role) => userRoles.has(role))) return 'preserve'
  return roles.size > 0 ? 'discard' : 'unknown'
}

function hydrateClaude(
  row: JsonObject,
  overCap: boolean,
  prompts: string[],
  prose: string[],
  files: Set<string>,
): number {
  if (row.toolUseResult !== undefined) return 0
  const message = isObject(row.message) ? row.message : undefined
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return 0

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isObject(block) && block.type === 'tool_use') collectPaths(block.input, files)
    }
  }
  const text = textOf(message.content)
  if (message.role === 'user') {
    const asked = userPromptText(text)
    if (!asked) return 0
    prompts.push(asked)
  } else {
    if (!text) return 0
    if (!overCap) prose.push(text)
  }
  return 1
}

function hydrateCodex(
  row: JsonObject,
  overCap: boolean,
  prompts: string[],
  prose: string[],
  files: Set<string>,
): number {
  if (row.type !== 'response_item') return 0
  const payload = isObject(row.payload) ? row.payload : undefined
  if (!payload) return 0

  if (payload.type === 'function_call') {
    if (typeof payload.arguments === 'string') {
      try {
        collectPaths(JSON.parse(payload.arguments) as unknown, files)
      } catch {
        // Malformed tool arguments have no indexable content.
      }
    }
    return 0
  }
  if (payload.type !== 'message') return 0
  if (payload.role === 'user') {
    const text = userPromptText(codexInputText(payload.content))
    if (!text) return 0
    prompts.push(text)
    return 1
  }
  if (payload.role === 'assistant') {
    const text = textOfType(payload.content, 'output_text')
    if (!text) return 0
    if (!overCap && text) prose.push(text)
    return 1
  }
  return 0
}

function hydrateGeneric(
  row: JsonObject,
  overCap: boolean,
  prompts: string[],
  prose: string[],
  userRoles: Set<string>,
  assistantRoles: Set<string>,
  rolePath: string | undefined,
  textPath: string | undefined,
): number {
  const role = get(row, rolePath)
  const text = textOf(get(row, textPath))
  if (typeof role !== 'string' || !text) return 0
  if (userRoles.has(role)) {
    const asked = userPromptText(text)
    if (!asked) return 0
    prompts.push(asked)
  }
  else if (assistantRoles.has(role)) {
    if (!overCap) prose.push(text)
  } else return 0
  return 1
}

/** Reads line-per-record transcripts, either through a client-specific variant or a manifest-described generic shape. */
export const jsonlTranscript: FormatModule = {
  async discover(manifest, root) {
    const refs: SessionRef[] = []
    const diagnostics: Diagnostic[] = []
    if (manifest.format !== 'jsonl-transcript') {
      return { refs, diagnostics: [warn(manifest.id, root, 'not a jsonl manifest')] }
    }

    try {
      const glob = new Glob(manifest.jsonl.glob)
      for await (const path of glob.scan({ cwd: root, absolute: true, onlyFiles: true })) {
        try {
          const file = Bun.file(path)
          const stat = await file.stat()
          const parsed = parseHead(await readHead(path))
          if (parsed.malformed) diagnostics.push(warn(manifest.id, path, 'malformed JSONL row'))
          const ref = manifest.jsonl.variant === 'claude'
            ? discoverClaude(
              manifest,
              path,
              stat,
              parsed.rows,
              parsed.rows.length === 0
                && !parsed.malformed
                && parsed.incompleteFinalLine
                && stat.size > HEAD_BYTES,
            )
            : manifest.jsonl.variant === 'codex'
              ? discoverCodex(manifest, path, stat, parsed.rows)
              : discoverGeneric(manifest, path, stat, parsed.rows)
          if (ref) refs.push(ref)
        } catch (error) {
          diagnostics.push(warn(manifest.id, path, error))
        }
      }
    } catch (error) {
      diagnostics.push(warn(manifest.id, root, error))
    }
    return { refs, diagnostics }
  },

  async hydrate(manifest, _root, ref, config) {
    if (manifest.format !== 'jsonl-transcript') {
      throw new Error('not a jsonl manifest')
    }
    const path = ref.sourcePaths[0]
    if (!path) throw new Error(`session has no source path: ${ref.uid}`)
    const overCap = (await Bun.file(path).stat()).size > config.maxFileBytes
    const prompts: string[] = []
    const prose: string[] = []
    const files = new Set<string>()
    const generic = manifest.jsonl.generic
    const genericUserRoles = new Set(generic?.userRoles ?? ['user', 'human'])
    const genericAssistantRoles = new Set(generic?.assistantRoles ?? ['assistant'])
    let turns = 0

    const oversizedRow = await rowsFromStream(path, (row) => {
      turns += manifest.jsonl.variant === 'claude'
        ? hydrateClaude(row, overCap, prompts, prose, files)
        : manifest.jsonl.variant === 'codex'
          ? hydrateCodex(row, overCap, prompts, prose, files)
          : hydrateGeneric(
            row,
            overCap,
            prompts,
            prose,
            genericUserRoles,
            genericAssistantRoles,
            generic?.rolePath,
            generic?.textPath,
          )
    }, manifest)

    return {
      ref: { ...ref, turns },
      prompts,
      prose,
      files: [...files],
      truncated: overCap || oversizedRow,
    }
  },
}
