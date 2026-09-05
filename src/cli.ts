#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { runReindex, type ReindexOptions } from './commands/reindex'
import { runSearch, type SearchOptions } from './commands/search'
import { runShow, type ShowOptions } from './commands/show'
import { parseSince, runTimeline, type TimelineCommandOptions } from './commands/timeline'
import type { DoctorOptions } from './commands/doctor'
import type { PruneOptions } from './commands/privacy'
import { parseUid } from './types'

/** The help text, and the single source of truth for the command surface. */
export const USAGE = `nekyia - search every agent CLI session on your machine and resume the right one

usage:
  nekyia                        open the picker
  nekyia search <query>         search without the picker
  nekyia blame <path>           list recent sessions that touched this file
  nekyia timeline [--dir <p>]   what happened to files in a directory, in order
  nekyia last                   resume or re-brief the latest session here
  nekyia index [--rebuild]      refresh the index
  nekyia show <uid>             print a deterministic handover as markdown
  nekyia doctor                 report what was found and what could not be read
  nekyia forget <uid>           remove one session from the index
  nekyia prune --missing        remove sessions whose source is gone
  nekyia exclude <glob>         never index a directory again
  nekyia --version              print the version and where this came from

options:
  --client <id>     only this client
  --file <path>     only sessions that touched a matching path
  --sort <mode>     auto | recent | relevance
  --all             ignore the current directory scope
  --limit <n>       maximum rows (default 40)
  --json            machine-readable output
  --max-chars <n>   character budget for show (default 40000)
  --sniff           inspect likely unsupported stores (doctor only)
  --emit-manifest <path>  write a draft for the first sniffed store (doctor only)
  --dir <path>      directory a timeline covers (default: the current one)
  --since <when>    30m, 12h, 2d, 3w, or a date such as 2026-08-01

blame takes only --client, --limit, and --json: it always searches every
directory, newest first, for the one file the path resolves to.

timeline groups events by session because ordering inside a session is exact
and ordering between them is by end time only. It reads the index, never a
transcript.
`

/** Represents an error originating from CLI argument parsing or command validation. */
class CliError extends Error {}

const OPTIONS = {
  client: { type: 'string' },
  file: { type: 'string' },
  sort: { type: 'string' },
  limit: { type: 'string' },
  all: { type: 'boolean' },
  json: { type: 'boolean' },
  rebuild: { type: 'boolean' },
  yes: { type: 'boolean' },
  quiet: { type: 'boolean' },
  'max-chars': { type: 'string' },
  sniff: { type: 'boolean' },
  'emit-manifest': { type: 'string' },
  missing: { type: 'boolean' },
  dir: { type: 'string' },
  since: { type: 'string' },
} as const

/** Every subcommand the CLI answers to; anything else is an unknown command. */
const COMMANDS = ['index', 'search', 'blame', 'timeline', 'last', 'show', 'doctor', 'forget', 'prune', 'exclude']

/** Parses CLI arguments into typed options and positional arguments. */
function parse(args: string[]) {
  try {
    return parseArgs({ args, allowPositionals: true, strict: true, options: OPTIONS })
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error))
  }
}

/** Checks if any of the specified keys are present in the provided values object. */
function present(values: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => values[key] !== undefined)
}

/** Validates and parses a string into a positive integer limit, or undefined if absent. */
function positiveLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new CliError('--limit must be a positive integer')
  }
  return limit
}

/**
 * What an invocation asked for, once the arguments have been read and judged.
 *
 * Separating the decision from the doing is what makes the contract testable:
 * the rules are a pure function of argv, while running them opens an index and
 * spawns clients. A test can then name the rule that fired and read the options
 * a command was going to be given, instead of inferring both from an exit code.
 */
export type CliPlan =
  | { kind: 'usage' }
  | { kind: 'version' }
  | { kind: 'pick' }
  | { kind: 'unknown'; command: string }
  | { kind: 'last' }
  | { kind: 'forget'; uid?: string }
  | { kind: 'exclude'; glob?: string }
  | { kind: 'prune'; options: PruneOptions }
  | { kind: 'doctor'; options: DoctorOptions }
  | { kind: 'index'; options: ReindexOptions }
  | { kind: 'show'; options: ShowOptions }
  | { kind: 'timeline'; options: TimelineCommandOptions }
  | { kind: 'search'; options: SearchOptions }

/**
 * Turns argv into the plan it asks for, or throws `CliError` naming the rule it broke.
 *
 * `cwd` and `now` are parameters rather than reads of the ambient process so a
 * plan is a function of its inputs alone, which is what lets a test assert the
 * resolved directory and the window `--since` opens.
 */
export function planCli(argv: string[], cwd: string = process.cwd(), now: number = Date.now()): CliPlan {
  const subcommand = argv[0]
  if (subcommand === '--help' || subcommand === '-h') return { kind: 'usage' }
  if (subcommand === '--version' || subcommand === '-v' || subcommand === 'version') {
    return { kind: 'version' }
  }
  if (!subcommand) return { kind: 'pick' }
  if (!COMMANDS.includes(subcommand)) return { kind: 'unknown', command: subcommand }

  const { values, positionals } = parse(argv.slice(1))
  const ALL = Object.keys(OPTIONS)

  if (subcommand === 'last') {
    if (positionals.length > 0) throw new CliError('last does not accept positional arguments')
    if (present(values, ALL)) throw new CliError('last does not accept options')
    return { kind: 'last' }
  }
  if (subcommand === 'forget') {
    if (positionals.length > 1) throw new CliError('forget accepts exactly one uid')
    if (present(values, ALL)) throw new CliError('forget does not accept options')
    return { kind: 'forget', uid: positionals[0] }
  }
  if (subcommand === 'exclude') {
    if (positionals.length > 1) throw new CliError('exclude accepts exactly one glob')
    if (present(values, ALL)) throw new CliError('exclude does not accept options')
    return { kind: 'exclude', glob: positionals[0] }
  }
  if (subcommand === 'prune') {
    if (positionals.length > 0) throw new CliError('prune does not accept positional arguments')
    if (present(values, ALL.filter((key) => key !== 'missing' && key !== 'client'))) {
      throw new CliError('only --missing and --client can be used with prune')
    }
    return { kind: 'prune', options: { missing: values.missing === true, client: values.client } }
  }
  if (subcommand === 'doctor') {
    if (positionals.length > 0) throw new CliError('doctor does not accept positional arguments')
    if (present(values, ['client', 'file', 'sort', 'limit', 'all', 'rebuild', 'yes', 'quiet', 'max-chars', 'missing', 'dir', 'since'])) {
      throw new CliError('only --json, --sniff, and --emit-manifest can be used with doctor')
    }
    if (values['emit-manifest'] !== undefined && values.sniff !== true) {
      throw new CliError('--emit-manifest requires --sniff')
    }
    if (values['emit-manifest'] !== undefined && values.json === true) {
      throw new CliError('--json cannot be combined with --emit-manifest')
    }
    return {
      kind: 'doctor',
      options: {
        emitManifest: values['emit-manifest'],
        json: values.json === true,
        sniff: values.sniff === true,
      },
    }
  }
  if (subcommand === 'index') {
    if (positionals.length > 0) throw new CliError('index does not accept positional arguments')
    if (present(values, ['client', 'file', 'sort', 'limit', 'all', 'json', 'max-chars', 'sniff', 'emit-manifest', 'missing', 'dir', 'since'])) {
      throw new CliError('search options cannot be used with index')
    }
    return {
      kind: 'index',
      options: {
        rebuild: values.rebuild === true,
        quiet: values.quiet === true,
        yes: values.yes === true,
      },
    }
  }
  if (subcommand === 'show') {
    // A bare `show` is not rejected here: the command prints its own usage,
    // which is the message a user missing an argument should see.
    if (!positionals[0]) return { kind: 'show', options: {} }
    if (positionals.length !== 1) throw new CliError('show accepts exactly one uid')
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(positionals[0])) {
      throw new CliError('uid must not contain control characters')
    }
    try {
      parseUid(positionals[0])
    } catch {
      throw new CliError(`malformed uid: ${positionals[0]}`)
    }
    if (present(values, ['client', 'file', 'sort', 'limit', 'all', 'json', 'rebuild', 'yes', 'quiet', 'sniff', 'emit-manifest', 'missing', 'dir', 'since'])) {
      throw new CliError('only --max-chars can be used with show')
    }
    return {
      kind: 'show',
      options: { uid: positionals[0], maxChars: nonNegative(values['max-chars']) },
    }
  }
  if (subcommand === 'timeline') {
    if (positionals.length > 0) throw new CliError('timeline takes no positional arguments')
    if (present(values, [
      'file', 'sort', 'all', 'rebuild', 'yes', 'quiet', 'max-chars',
      'sniff', 'emit-manifest', 'missing',
    ])) {
      throw new CliError('only --dir, --since, --client, --limit, and --json can be used with timeline')
    }
    let since: number | undefined
    if (values.since !== undefined) {
      try {
        since = parseSince(values.since, now)
      } catch (error) {
        throw new CliError(error instanceof Error ? error.message : String(error))
      }
    }
    return {
      kind: 'timeline',
      options: {
        dir: resolve(cwd, values.dir ?? '.'),
        since,
        client: values.client,
        limit: positiveLimit(values.limit),
        json: values.json === true,
      },
    }
  }
  if (subcommand === 'blame') {
    if (positionals.length !== 1 || !positionals[0]) {
      throw new CliError('blame accepts exactly one path')
    }
    if (present(values, [
      'file', 'sort', 'all', 'rebuild', 'yes', 'quiet', 'max-chars',
      'sniff', 'emit-manifest', 'missing', 'dir', 'since',
    ])) {
      throw new CliError('only --client, --limit, and --json can be used with blame')
    }
    const file = positionals[0]
    if (file.length > 16_384 || /[\u0000-\u001f\u007f-\u009f]/u.test(file)) {
      throw new CliError('blame path is too long or contains control characters')
    }
    return {
      kind: 'search',
      options: {
        exactFile: resolve(cwd, file),
        client: values.client,
        limit: positiveLimit(values.limit),
        json: values.json === true,
        sort: 'recent',
      },
    }
  }

  if (present(values, ['rebuild', 'yes', 'quiet', 'max-chars', 'sniff', 'emit-manifest', 'missing', 'dir', 'since'])) {
    throw new CliError('index options cannot be used with search')
  }
  const sort = values.sort
  if (sort !== undefined && sort !== 'auto' && sort !== 'recent' && sort !== 'relevance') {
    throw new CliError('--sort must be auto, recent, or relevance')
  }
  return {
    kind: 'search',
    options: {
      text: positionals.join(' ') || undefined,
      cwd: values.all ? undefined : cwd,
      client: values.client,
      file: values.file,
      sort,
      limit: positiveLimit(values.limit),
      json: values.json === true,
    },
  }
}

/** Validates and parses a character budget, which may be zero but never negative. */
function nonNegative(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const budget = Number(value)
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new CliError('--max-chars must be a non-negative integer')
  }
  return budget
}

/**
 * A terminal that understands OSC 8 shows a link; every other one, and any
 * redirected output, gets the address written out so nothing is lost.
 */
function link(text: string, url: string): string {
  return process.stdout.isTTY
    ? `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`
    : `${text} · ${url}`
}

/** Renders the version line, linking to the release when the terminal supports hyperlinks. */
export function versionText(version: string, hyperlink = link): string {
  return [
    `nekyia ${version}`,
    'Find the session. Pick up the thread.',
    '',
    'In the Odyssey, Odysseus digs the trench and the dead crowd forward;',
    'he holds them back until the one shade he needs may speak.',
    '',
    `Built by ${hyperlink('Aranea Development', 'https://aranea-development.nl')}`,
    `Source at ${hyperlink('AraneaDev/Nekyia', 'https://github.com/AraneaDev/Nekyia')}`,
  ].join('\n')
}

/**
 * Runs the plan an invocation asked for.
 *
 * Every rule already fired in `planCli`, so this holds nothing but the wiring:
 * which module to load and what to hand it. The imports stay dynamic so a
 * command pays only for the code it uses.
 */
async function dispatch(argv: string[]): Promise<number> {
  const plan = planCli(argv)
  switch (plan.kind) {
    case 'usage':
      console.log(USAGE)
      return 0
    case 'version': {
      const pkg = await import('../package.json', { with: { type: 'json' } })
        .then((module) => module.default as { version?: string })
        .catch(() => ({ version: undefined }))
      console.log(versionText(typeof pkg.version === 'string' ? pkg.version : 'unknown'))
      return 0
    }
    case 'unknown':
      console.error(`unknown command: ${plan.command}\n`)
      console.error(USAGE)
      return 2
    case 'pick': {
      const { runPick } = await import('./commands/pick')
      return runPick()
    }
    case 'last': {
      const { runLast } = await import('./commands/last')
      return runLast()
    }
    case 'forget': {
      const { runForget } = await import('./commands/privacy')
      return runForget(plan.uid)
    }
    case 'prune': {
      const { runPrune } = await import('./commands/privacy')
      return runPrune(plan.options)
    }
    case 'exclude': {
      const { runExclude } = await import('./commands/privacy')
      return runExclude(plan.glob)
    }
    case 'doctor': {
      const { runDoctor } = await import('./commands/doctor')
      return runDoctor(plan.options)
    }
    case 'index':
      return runReindex(plan.options)
    case 'show':
      return runShow(plan.options)
    case 'timeline':
      return runTimeline(plan.options)
    case 'search':
      return runSearch(plan.options)
  }
}

/** Parses argv, dispatches to a command, and returns the process exit code rather than exiting itself, so tests can drive it. */
export async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv)
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`error: ${error.message}`)
      return 2
    }
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
