/**
 * Captures every interface state to docs/media, from the running picker.
 *
 *   bun run scripts/shots.ts             # all shots, as SVG
 *   bun run scripts/shots.ts inspect     # one shot by name
 *   bun run scripts/shots.ts --webp      # also write WebP beside each SVG
 *
 * SVG is the committed format: terminal output is text and rules, so it stays
 * crisp at any zoom and costs a fraction of a raster. WebP is there for places
 * that will not render SVG.
 *
 * The picker runs in the sandbox from scripts/demo-sandbox.ts: the invented
 * transcripts in test/fixtures/demo, indexed by the real indexer, with no way
 * to reach real history. Re-run this after any interface change; the shots
 * in the README are generated, not drawn.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { prepareSandbox, shellSetup, type Sandbox } from './demo-sandbox'

const root = join(import.meta.dir, '..')
const media = join(root, 'docs', 'media')
const work = '/tmp/nekyia-shots'
const SESSION = 'nekyia-shots'

interface Shot {
  name: string
  what: string
  columns: number
  rows: number
  /** tmux keys sent after the picker is up. Strings starting with ':' are typed literally. */
  keys: string[]
  /** Text that must appear before the shot is taken. */
  settled?: string
}

const SHOTS: Shot[] = [
  {
    name: 'picker',
    what: 'browsing every session',
    columns: 132, rows: 34,
    // The first row is the one session with several prompts and a branch, which
    // is everything the preview has to show.
    keys: ['Tab'],
  },
  {
    name: 'search',
    what: 'a query, with the match lit in each title',
    columns: 132, rows: 24,
    // A query that matches once shows the feature; one that matches many shows
    // what it is for, which is picking a session out of a list at a glance.
    keys: ['Tab', ':the'],
    settled: '\u25b8 the',
  },
  {
    name: 'inspect',
    what: 'the history open and scrolled',
    columns: 132, rows: 34,
    keys: ['Tab', 'C-o', 'Down', 'Down', 'Down'],
    settled: 'scroll',
  },
  {
    name: 'scoped',
    what: 'narrowed to one project',
    columns: 132, rows: 24,
    keys: ['Tab', 'Down', 'Down', 'Down', 'Tab'],
  },
  {
    name: 'empty',
    what: 'a search that matched nothing',
    columns: 132, rows: 12,
    keys: ['Tab', ':zzqqx'],
    settled: 'Nothing came up',
  },
  {
    name: 'narrow',
    what: 'the same picker on a narrow terminal',
    columns: 80, rows: 24,
    keys: ['Tab'],
  },
]

function run(command: string[]): string {
  const result = Bun.spawnSync(command)
  if (!result.success) {
    throw new Error(`${command.join(' ')} failed: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString()
}

function pane(): string {
  return Bun.spawnSync(['tmux', 'capture-pane', '-t', SESSION, '-p']).stdout.toString()
}

const sleep = (ms: number) => Bun.sleepSync(ms)

/** Polls rather than guessing at a duration; the picker's start time varies. */
function waitFor(text: string, what: string, timeoutMs = 60_000): void {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pane().includes(text)) return
    sleep(250)
  }
  throw new Error(`timed out waiting for ${what}\n--- pane ---\n${pane()}`)
}

function capture(shot: Shot, sandbox: Sandbox): void {
  Bun.spawnSync(['tmux', 'kill-session', '-t', SESSION])
  run([
    'tmux', 'new-session', '-d', '-s', SESSION,
    '-x', String(shot.columns), '-y', String(shot.rows), '-c', '/home',
  ])
  run(['tmux', 'send-keys', '-t', SESSION, `${shellSetup(sandbox)}; nek`, 'Enter'])
  waitFor('type to search', `${shot.name}: the picker to start`)

  for (const key of shot.keys) {
    if (key.startsWith(':')) run(['tmux', 'send-keys', '-t', SESSION, '-l', key.slice(1)])
    else run(['tmux', 'send-keys', '-t', SESSION, key])
    sleep(180)
  }
  if (shot.settled) waitFor(shot.settled, `${shot.name}: ${shot.settled}`)
  // One more beat so the measured layout has settled before the frame is taken.
  sleep(600)

  const out = join(media, `${shot.name}.svg`)
  run(['bun', 'run', join(root, 'scripts', 'capture-svg.ts'), SESSION, out])
  if (alsoWebp) {
    const raster = out.replace(/\.svg$/u, '.webp')
    // Density lifts the rasteriser above the SVG's nominal size, so the text
    // is not resampled from a thumbnail.
    run(['convert', '-density', '192', '-background', 'none', out, '-quality', '92', raster])
  }
  Bun.spawnSync(['tmux', 'kill-session', '-t', SESSION])
  console.log(`  ${shot.name.padEnd(8)} ${shot.columns}x${shot.rows}  ${shot.what}`)
}

const argv = process.argv.slice(2)
const alsoWebp = argv.includes('--webp')
const wanted = argv.filter((value) => !value.startsWith('--'))
const chosen = wanted.length ? SHOTS.filter((shot) => wanted.includes(shot.name)) : SHOTS
if (!chosen.length) {
  console.error(`no such shot. known: ${SHOTS.map((shot) => shot.name).join(', ')}`)
  process.exit(2)
}

if (!Bun.spawnSync(['which', 'tmux']).success) {
  console.error('tmux is required: the shots are taken from a real terminal, not rendered')
  process.exit(2)
}

mkdirSync(media, { recursive: true })
console.log('indexing the demo fixture')
const sandbox = prepareSandbox(work)

for (const shot of chosen) capture(shot, sandbox)
console.log(`\nwrote ${chosen.length} shot(s) to docs/media`)
