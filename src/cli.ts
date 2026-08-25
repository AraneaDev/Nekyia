#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { runReindex } from './commands/reindex'
import { runSearch, type SearchOptions } from './commands/search'
import { runShow } from './commands/show'
import { parseUid } from './types'

/** The help text, and the single source of truth for the command surface. */
export const USAGE = `nekyia - search every agent CLI session on your machine and resume the right one

usage:
  nekyia                        open the picker
  nekyia search <query>         search without the picker
  nekyia blame <path>           list recent sessions that touched this file
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

blame takes only --client, --limit, and --json: it always searches every
directory, newest first, for the one file the path resolves to.
`

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
} as const

function parse(args: string[]) {
  try {
    return parseArgs({ args, allowPositionals: true, strict: true, options: OPTIONS })
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error))
  }
}

function present(values: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => values[key] !== undefined)
}

function positiveLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new CliError('--limit must be a positive integer')
  }
  return limit
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

async function dispatch(argv: string[]): Promise<number> {
  const subcommand = argv[0]
  if (subcommand === '--help' || subcommand === '-h') {
    console.log(USAGE)
    return 0
  }
  if (subcommand === '--version' || subcommand === '-v' || subcommand === 'version') {
    const pkg = await import('../package.json', { with: { type: 'json' } })
      .then((module) => module.default as { version?: string })
      .catch(() => ({ version: undefined }))
    console.log(versionText(typeof pkg.version === 'string' ? pkg.version : 'unknown'))
    return 0
  }
  if (!subcommand) {
    const { runPick } = await import('./commands/pick')
    return runPick()
  }
  if (!['index', 'search', 'blame', 'last', 'show', 'doctor', 'forget', 'prune', 'exclude'].includes(subcommand)) {
    console.error(`unknown command: ${subcommand}\n`)
    console.error(USAGE)
    return 2
  }

  const { values, positionals } = parse(argv.slice(1))
  if (subcommand === 'last') {
    if (positionals.length > 0) throw new CliError('last does not accept positional arguments')
    if (present(values, Object.keys(OPTIONS))) {
      throw new CliError('last does not accept options')
    }
    const { runLast } = await import('./commands/last')
    return runLast()
  }
  if (subcommand === 'forget') {
    if (positionals.length > 1) throw new CliError('forget accepts exactly one uid')
    if (present(values, Object.keys(OPTIONS))) {
      throw new CliError('forget does not accept options')
    }
    const { runForget } = await import('./commands/privacy')
    return runForget(positionals[0])
  }
  if (subcommand === 'prune') {
    if (positionals.length > 0) throw new CliError('prune does not accept positional arguments')
    if (present(values, Object.keys(OPTIONS).filter((key) => key !== 'missing' && key !== 'client'))) {
      throw new CliError('only --missing and --client can be used with prune')
    }
    const { runPrune } = await import('./commands/privacy')
    return runPrune({ missing: values.missing === true, client: values.client })
  }
  if (subcommand === 'exclude') {
    if (positionals.length > 1) throw new CliError('exclude accepts exactly one glob')
    if (present(values, Object.keys(OPTIONS))) {
      throw new CliError('exclude does not accept options')
    }
    const { runExclude } = await import('./commands/privacy')
    return runExclude(positionals[0])
  }
  if (subcommand === 'doctor') {
    if (positionals.length > 0) throw new CliError('doctor does not accept positional arguments')
    if (present(values, ['client', 'file', 'sort', 'limit', 'all', 'rebuild', 'yes', 'quiet', 'max-chars', 'missing'])) {
      throw new CliError('only --json, --sniff, and --emit-manifest can be used with doctor')
    }
    if (values['emit-manifest'] !== undefined && values.sniff !== true) {
      throw new CliError('--emit-manifest requires --sniff')
    }
    if (values['emit-manifest'] !== undefined && values.json === true) {
      throw new CliError('--json cannot be combined with --emit-manifest')
    }
    const { runDoctor } = await import('./commands/doctor')
    return runDoctor({
      emitManifest: values['emit-manifest'],
      json: values.json === true,
      sniff: values.sniff === true,
    })
  }
  if (subcommand === 'show') {
    if (!positionals[0]) return runShow({})
    if (positionals.length !== 1) throw new CliError('show accepts exactly one uid')
    if (/[\u0000-\u001f\u007f-\u009f]/.test(positionals[0])) {
      throw new CliError('uid must not contain control characters')
    }
    try {
      parseUid(positionals[0])
    } catch {
      throw new CliError(`malformed uid: ${positionals[0]}`)
    }
    if (present(values, ['client', 'file', 'sort', 'limit', 'all', 'json', 'rebuild', 'yes', 'quiet', 'sniff', 'emit-manifest', 'missing'])) {
      throw new CliError('only --max-chars can be used with show')
    }
    let maxChars: number | undefined
    if (values['max-chars'] !== undefined) {
      maxChars = Number(values['max-chars'])
      if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
        throw new CliError('--max-chars must be a non-negative integer')
      }
    }
    return runShow({ uid: positionals[0], maxChars })
  }
  if (subcommand === 'blame') {
    if (positionals.length !== 1 || !positionals[0]) {
      throw new CliError('blame accepts exactly one path')
    }
    if (present(values, [
      'file', 'sort', 'all', 'rebuild', 'yes', 'quiet', 'max-chars',
      'sniff', 'emit-manifest', 'missing',
    ])) {
      throw new CliError('only --client, --limit, and --json can be used with blame')
    }
    const file = positionals[0]
    if (file.length > 16_384 || /[\u0000-\u001f\u007f-\u009f]/u.test(file)) {
      throw new CliError('blame path is too long or contains control characters')
    }
    return runSearch({
      exactFile: resolve(file),
      client: values.client,
      limit: positiveLimit(values.limit),
      json: values.json === true,
      sort: 'recent',
    })
  }
  if (subcommand === 'index') {
    if (positionals.length > 0) throw new CliError('index does not accept positional arguments')
    if (present(values, ['client', 'file', 'sort', 'limit', 'all', 'json', 'max-chars', 'sniff', 'emit-manifest', 'missing'])) {
      throw new CliError('search options cannot be used with index')
    }
    return runReindex({
      rebuild: values.rebuild === true,
      quiet: values.quiet === true,
      yes: values.yes === true,
    })
  }

  if (present(values, ['rebuild', 'yes', 'quiet', 'max-chars', 'sniff', 'emit-manifest', 'missing'])) {
    throw new CliError('index options cannot be used with search')
  }
  const sort = values.sort
  if (sort !== undefined && sort !== 'auto' && sort !== 'recent' && sort !== 'relevance') {
    throw new CliError('--sort must be auto, recent, or relevance')
  }

  let limit: number | undefined
  if (values.limit !== undefined) {
    limit = Number(values.limit)
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new CliError('--limit must be a positive integer')
    }
  }

  const search: SearchOptions = {
    text: positionals.join(' ') || undefined,
    cwd: values.all ? undefined : process.cwd(),
    client: values.client,
    file: values.file,
    sort,
    limit,
    json: values.json === true,
  }
  return runSearch(search)
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
