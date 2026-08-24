/**
 * Renders a live tmux pane to an SVG, so README images are produced from the
 * real terminal output rather than drawn by hand.
 *
 *   bun run scripts/capture-svg.ts <tmux-session> docs/media/picker.svg
 *
 * Pair it with scripts/demo-index.ts: seed an index of invented sessions, point
 * the picker at it, then capture. No real history is ever on screen.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const session = process.argv[2]
const out = process.argv[3]
if (!session || !out) {
  console.error('usage: bun run scripts/capture-svg.ts <tmux-session> <out.svg>')
  process.exit(2)
}

const CELL_W = 8.4
const CELL_H = 18
const PAD = 16
const RADIUS = 8

/** A dark palette close to a default terminal, kept readable on a light page. */
const BG = '#12151b'
const FG = '#c9d1d9'
const BASE: Record<number, string> = {
  0: '#3b4048', 1: '#e06c75', 2: '#98c379', 3: '#e5c07b',
  4: '#61afef', 5: '#c678dd', 6: '#56b6c2', 7: '#c9d1d9',
  8: '#5c6370', 9: '#ff7b86', 10: '#b5e08c', 11: '#f0d399',
  12: '#7cc3ff', 13: '#dd9ce8', 14: '#6fd3de', 15: '#ffffff',
}

function xterm256(n: number): string {
  if (n < 16) return BASE[n] ?? FG
  if (n < 232) {
    const i = n - 16
    const step = (v: number) => (v === 0 ? 0 : 55 + v * 40)
    const r = step(Math.floor(i / 36))
    const g = step(Math.floor((i % 36) / 6))
    const b = step(i % 6)
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  }
  const v = (8 + (n - 232) * 10).toString(16).padStart(2, '0')
  return `#${v}${v}${v}`
}

interface Style { fg: string | null; bg: string | null; bold: boolean; dim: boolean; inverse: boolean }
interface Span { text: string; style: Style }

const blank = (): Style => ({ fg: null, bg: null, bold: false, dim: false, inverse: false })

function applySgr(style: Style, codes: number[]): Style {
  const next = { ...style }
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!
    if (code === 0) { Object.assign(next, blank()); continue }
    if (code === 1) { next.bold = true; continue }
    if (code === 2) { next.dim = true; continue }
    if (code === 7) { next.inverse = true; continue }
    if (code === 22) { next.bold = false; next.dim = false; continue }
    if (code === 27) { next.inverse = false; continue }
    if (code === 39) { next.fg = null; continue }
    if (code === 49) { next.bg = null; continue }
    if (code >= 30 && code <= 37) { next.fg = BASE[code - 30]!; continue }
    if (code >= 90 && code <= 97) { next.fg = BASE[code - 90 + 8]!; continue }
    if (code >= 40 && code <= 47) { next.bg = BASE[code - 40]!; continue }
    if (code >= 100 && code <= 107) { next.bg = BASE[code - 100 + 8]!; continue }
    if ((code === 38 || code === 48) && codes[i + 1] === 5) {
      const colour = xterm256(codes[i + 2] ?? 7)
      if (code === 38) next.fg = colour
      else next.bg = colour
      i += 2
      continue
    }
    if ((code === 38 || code === 48) && codes[i + 1] === 2) {
      const [r, g, b] = [codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0]
      const colour = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
      if (code === 38) next.fg = colour
      else next.bg = colour
      i += 4
    }
  }
  return next
}

function parseLine(line: string): Span[] {
  const spans: Span[] = []
  let style = blank()
  let text = ''
  const push = () => { if (text) { spans.push({ text, style: { ...style } }); text = '' } }
  const pattern = /\x1b\[([0-9;]*)m/gu
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line)) !== null) {
    text += line.slice(last, match.index)
    push()
    const codes = match[1] === '' ? [0] : match[1]!.split(';').map((part) => Number(part) || 0)
    style = applySgr(style, codes)
    last = match.index + match[0].length
  }
  text += line.slice(last)
  push()
  return spans
}

const escapeXml = (value: string) => value
  .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')

/**
 * Box drawing rendered as text leaves gaps, because a glyph does not fill its
 * cell and how far it falls short depends on the reader's font. Drawing the
 * segments makes every border meet, whatever the page renders with.
 * Each entry is [left, right, up, down] reach from the centre of the cell.
 */
const BOX: Record<string, [boolean, boolean, boolean, boolean]> = {
  '─': [true, true, false, false],
  '│': [false, false, true, true],
  '┌': [false, true, false, true],
  '┐': [true, false, false, true],
  '└': [false, true, true, false],
  '┘': [true, false, true, false],
  '├': [false, true, true, true],
  '┤': [true, false, true, true],
  '┬': [true, true, false, true],
  '┴': [true, true, true, false],
  '┼': [true, true, true, true],
}

function boxSegments(char: string, cellX: number, cellTop: number, colour: string): string[] {
  const reach = BOX[char]
  if (!reach) return []
  const [left, right, up, down] = reach
  const midX = cellX + CELL_W / 2
  const midY = cellTop + CELL_H / 2
  const out: string[] = []
  const line = (x1: number, y1: number, x2: number, y2: number) => out.push(
    `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"`
    + ` stroke="${colour}" stroke-width="1" shape-rendering="crispEdges"/>`,
  )
  if (left) line(cellX, midY, midX, midY)
  if (right) line(midX, midY, cellX + CELL_W, midY)
  if (up) line(midX, cellTop, midX, midY)
  if (down) line(midX, midY, midX, cellTop + CELL_H)
  return out
}

const captured = Bun.spawnSync(['tmux', 'capture-pane', '-t', session, '-e', '-p'])
if (!captured.success) {
  console.error(`tmux capture failed: ${captured.stderr.toString()}`)
  process.exit(1)
}
// Trailing blank rows are padding from the pane, not part of the interface.
const lines = captured.stdout.toString().replace(/\n+$/u, '').split('\n')
const columns = Math.max(...lines.map((line) => line.replace(/\x1b\[[0-9;]*m/gu, '').length))
const width = Math.ceil(columns * CELL_W + PAD * 2)
const height = Math.ceil(lines.length * CELL_H + PAD * 2)

const body: string[] = []
lines.forEach((line, rowIndex) => {
  const y = PAD + rowIndex * CELL_H
  let column = 0
  for (const span of parseLine(line)) {
    const width_ = span.text.length
    const fg = span.style.inverse ? (span.style.bg ?? BG) : (span.style.fg ?? FG)
    const bg = span.style.inverse ? (span.style.fg ?? FG) : span.style.bg
    const x = PAD + column * CELL_W
    if (bg) {
      body.push(
        `<rect x="${x.toFixed(1)}" y="${(y - 13).toFixed(1)}" `
        + `width="${(width_ * CELL_W).toFixed(1)}" height="${CELL_H}" fill="${bg}"/>`,
      )
    }
    // Box drawing becomes vector segments; everything else stays selectable text.
    let run = ''
    let runStart = column
    const flush = () => {
      // Renderers drop leading whitespace inside a text node even with
      // xml:space, which silently pulls a run left out of its column. Spacing
      // comes from the x position instead, so only the inked part is emitted.
      const lead = run.length - run.trimStart().length
      const inked = run.trim()
      if (!inked) { run = ''; return }
      const weight = span.style.bold ? ' font-weight="600"' : ''
      const opacity = span.style.dim && !span.style.inverse ? ' opacity="0.62"' : ''
      // Pin the span to the cell grid, so the font's own advance width cannot
      // drift the columns apart.
      body.push(
        `<text x="${(PAD + (runStart + lead) * CELL_W).toFixed(1)}" y="${y.toFixed(1)}"`
        + ` fill="${fg}"${weight}${opacity} textLength="${(inked.length * CELL_W).toFixed(1)}"`
        + ` lengthAdjust="spacingAndGlyphs" xml:space="preserve">${escapeXml(inked)}</text>`,
      )
      run = ''
    }
    for (const char of span.text) {
      if (BOX[char]) {
        flush()
        body.push(...boxSegments(char, PAD + column * CELL_W, y - 13, fg))
        runStart = column + 1
      } else {
        if (!run) runStart = column
        run += char
      }
      column += 1
    }
    flush()
  }
})

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="13">
<rect width="${width}" height="${height}" rx="${RADIUS}" fill="${BG}"/>
${body.join('\n')}
</svg>
`

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, svg)
console.log(`wrote ${out} (${columns}x${lines.length} cells, ${width}x${height}px)`)
