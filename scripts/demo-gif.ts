/**
 * Records the README's opening GIF from the running picker.
 *
 *   bun run scripts/demo-gif.ts          # writes docs/media/demo.gif
 *
 * Every frame is a real tmux pane, captured with scripts/capture-svg.ts, and
 * nothing is drawn. The sessions on screen come from scripts/demo-sandbox.ts,
 * which also keeps real history out and makes the GIF the same on every run.
 * The pre-commit hook relies on that to re-record without churn.
 *
 * Frames are captured after each keystroke and given a display time here, so
 * the loop plays at reading speed however long the capture itself took.
 *
 * Needs tmux, rsvg-convert and ffmpeg.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareSandbox, shellSetup } from './demo-sandbox'

const root = join(import.meta.dir, '..')
const out = join(root, 'docs', 'media', 'demo.gif')
const work = '/tmp/nekyia-gif'
const SESSION = 'nekyia-gif'
const COLUMNS = 132
const ROWS = 30

/** Must match scripts/capture-svg.ts, so every frame shares one canvas. */
const CELL_W = 8.4
const CELL_H = 18
const PAD = 16
const BG = '#12151b'
const WIDTH = Math.ceil(COLUMNS * CELL_W + PAD * 2)
const HEIGHT = Math.ceil(ROWS * CELL_H + PAD * 2)

type Step =
  /**
   * Types each chunk as one burst, one frame per chunk. Search matches whole
   * words, so a frame per letter would flash "Nothing came up" mid-word.
   */
  | { type: string[], each: number, hold: number }
  /** Sends one tmux key, then takes a frame. */
  | { key: string, hold: number, settled?: string }
  /** Waits for text, then takes a frame. */
  | { wait: string, hold: number }

const STEPS: Step[] = [
  { type: ['n', 'e', 'k'], each: 0.12, hold: 0.3 },
  { key: 'Enter', hold: 0 },
  { wait: 'type to search', hold: 0.5 },
  { key: 'Tab', hold: 0.9 },
  { type: ['retry', ' tenant'], each: 1.0, hold: 1.2 },
  { key: 'C-o', hold: 2.4, settled: 'scroll' },
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

function waitFor(text: string, timeoutMs = 60_000): void {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pane().includes(text)) return
    Bun.sleepSync(250)
  }
  throw new Error(`timed out waiting for "${text}"\n--- pane ---\n${pane()}`)
}

const frames: { file: string, seconds: number }[] = []

/**
 * capture-svg trims trailing blank rows and sizes the canvas to the widest
 * line, so the shell prompt and the picker come out at different sizes. Each
 * frame is set on one fixed canvas before it is rasterised.
 */
function frame(seconds: number): void {
  Bun.sleepSync(300)
  const index = String(frames.length).padStart(3, '0')
  const svg = join(work, 'frames', `${index}.svg`)
  run(['bun', 'run', join(root, 'scripts', 'capture-svg.ts'), SESSION, svg])
  const fixed = readFileSync(svg, 'utf8')
    .replace(/<svg [^>]*>/u, (tag) => tag
      .replace(/width="[^"]*"/u, `width="${WIDTH}"`)
      .replace(/height="[^"]*"/u, `height="${HEIGHT}"`)
      .replace(/viewBox="[^"]*"/u, `viewBox="0 0 ${WIDTH} ${HEIGHT}"`))
    .replace(/<rect width="[^"]*" height="[^"]*"/u, `<rect width="${WIDTH}" height="${HEIGHT}"`)
  writeFileSync(svg, fixed)
  const png = join(work, 'frames', `${index}.png`)
  run(['rsvg-convert', '--background-color', BG, '-o', png, svg])
  frames.push({ file: png, seconds })
}

for (const tool of ['tmux', 'rsvg-convert', 'ffmpeg']) {
  if (!Bun.spawnSync(['which', tool]).success) {
    console.error(`${tool} is required`)
    process.exit(2)
  }
}

rmSync(work, { recursive: true, force: true })
console.log('indexing the demo fixture')
const sandbox = prepareSandbox(join(work, 'sandbox'))
mkdirSync(join(work, 'frames'), { recursive: true })

Bun.spawnSync(['tmux', 'kill-session', '-t', SESSION])
run([
  'tmux', 'new-session', '-d', '-s', SESSION,
  '-x', String(COLUMNS), '-y', String(ROWS), '-c', '/home',
])
run(['tmux', 'send-keys', '-t', SESSION, shellSetup(sandbox), 'Enter'])
Bun.sleepSync(800)
frame(0.4)

for (const step of STEPS) {
  if ('type' in step) {
    step.type.forEach((chunk, i) => {
      run(['tmux', 'send-keys', '-t', SESSION, '-l', chunk])
      frame(i === step.type.length - 1 ? step.hold : step.each)
    })
  } else if ('key' in step) {
    run(['tmux', 'send-keys', '-t', SESSION, step.key])
    if (step.settled) waitFor(step.settled)
    frame(step.hold)
  } else {
    waitFor(step.wait)
    Bun.sleepSync(600)
    frame(step.hold)
  }
}
Bun.spawnSync(['tmux', 'kill-session', '-t', SESSION])

// A zero-length frame is a transition nobody should see, such as the shell
// between Enter and the picker drawing.
const shown = frames.filter((f) => f.seconds > 0)
const list = shown.map((f) => `file '${f.file}'\nduration ${f.seconds}`).join('\n')
// The concat demuxer ignores the last duration unless the file is listed again.
writeFileSync(join(work, 'frames.txt'), `${list}\nfile '${shown.at(-1)!.file}'\n`)

const scale = 'scale=960:-1:flags=lanczos'
run([
  'ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
  '-i', join(work, 'frames.txt'),
  '-vf', `${scale},split[a][b];[a]palettegen=max_colors=64:stats_mode=full[p];[b][p]paletteuse=dither=none`,
  '-fps_mode', 'vfr', '-loop', '0', out,
])
const kb = Math.round(Bun.file(out).size / 1024)
console.log(`wrote ${out} (${shown.length} frames, ${kb} KB)`)
