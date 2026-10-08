import { expect, spyOn, test } from 'bun:test'
import React from 'react'
import { render } from 'ink-testing-library'
import { DEFAULT_CONFIG } from '../src/config'
import { mountPicker, runPick, type PickDependencies } from '../src/commands/pick'
import { buildAdapter, type Adapter } from '../src/core/adapter'
import { IndexDb } from '../src/core/db'
import { validateManifest } from '../src/manifests/load'
import {
  App, fitKeys, indexAgeSeverity, previewLines, safeCommandForClipboard,
  SEVERITY_COLOR, type CommandCopyWork,
} from '../src/tui/App'
import { shareLines } from '../src/tui/Preview'
import {
  createHostClipboard, releaseTerminal, writeTtySequence, type ClipboardRuntime,
} from '../src/tui/clipboard'
import type { ExecPlan, SessionRef } from '../src/types'
import codebuffManifest from '../src/manifests/builtin/codebuff.json'

const NOW = 1_800_000_000_000

function seed(db: IndexDb, over: Partial<SessionRef> = {}): SessionRef {
  const ref: SessionRef = {
    uid: 'claude:a', client: 'claude', nativeId: 'a', cwd: '/home/dev/work/proj', gitBranch: 'main',
    title: 'Fix the SSE reconnect race', startedAt: 0, endedAt: NOW, turns: 3,
    parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: [], fingerprint: '',
    ...over,
  }
  db.upsertRef(ref)
  db.upsertDoc({
    ref, prompts: ['fix the sse reconnect'], prose: [], files: ['src/z.ts', 'src/sse.ts'],
    truncated: false,
  })
  return ref
}

const adapters = [buildAdapter(validateManifest({
  schema: 1, id: 'claude', name: 'Claude Code', roots: ['/nonexistent'],
  format: 'jsonl-transcript', tier: 'resume',
  jsonl: { glob: '*.jsonl', variant: 'claude' },
  resume: { cmd: 'claude', args: ['--resume', '{id}'], cwd: '{cwd}' },
  brief: { cmd: 'claude', args: ['{prompt}'], cwd: '{cwd}' },
}))]

const opts = { cwd: '/home/dev/work/proj', now: NOW, checkResumePlan: () => ({ ok: true }) }
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

/** Everything below the rule that separates the list from the preview. */
function previewOf(frame: string): string {
  const lines = frame.split('\n')
  const rule = lines.findIndex((line) => /^─+$/u.test(line.trim()) && line.trim().length > 10)
  return rule === -1 ? '' : lines.slice(rule + 1).join('\n')
}

test('the picker never renders taller than the terminal', async () => {
  const db = IndexDb.open(':memory:')
  for (let i = 0; i < 40; i++) {
    seed(db, {
      uid: `claude:${i}`,
      nativeId: String(i),
      title: `session ${i} ${'a long title that wraps across the terminal width '.repeat(3)}`,
    })
  }
  // A files-touched block plus a wrapping title is what used to push the preview
  // past the height the list had already been sized against.
  const heavy = seed(db, { uid: 'claude:files', nativeId: 'files' })
  db.upsertDoc({
    ref: heavy,
    prompts: ['a first prompt line'],
    prose: [],
    files: Array.from({ length: 6 }, (_, i) => `/home/dev/work/proj/src/deeply/nested/module/file-${i}.ts`),
    truncated: false,
  })

  for (const rows of [8, 12, 16, 20, 24, 30, 40]) {
    const view = render(
      <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={rows} />,
    )
    await tick()
    const frame = view.lastFrame()!
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows)
    view.unmount()
  }
})

test('the preview stays full-width below the list and compact stats at every terminal width', async () => {
  const db = IndexDb.open(':memory:')
  for (let i = 0; i < 30; i++) seed(db, { uid: `claude:${i}`, nativeId: String(i) })

  for (const columns of [40, 60, 80, 120, 160, 220]) {
    const view = render(
      <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={30} columns={columns} />,
    )
    await tick()
    const lines = view.lastFrame()!.split('\n')
    const rule=lines.findIndex(line=>/^─+$/u.test(line.trim()))
    expect(rule).toBeGreaterThan(0)
    expect(Bun.stringWidth(lines[rule]!)).toBe(columns)
    expect(lines[rule+1]).toContain('Fix the SSE reconnect race')
    expect(view.lastFrame()!.includes('Current results')).toBe(columns>=140)
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns)
    expect(lines.length).toBeLessThanOrEqual(30)
    view.unmount()
  }
})

test('a resize relays out instead of leaving the previous frame behind', async () => {
  const db = IndexDb.open(':memory:')
  for (let i = 0; i < 30; i++) seed(db, { uid: `claude:${i}`, nativeId: String(i) })

  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={40} />,
  )
  await tick()
  expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(40)

  view.rerender(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={14} />,
  )
  await tick()
  expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(14)
  view.unmount()
})

test('the picker lists a session and shows a deterministic preview', () => {
  const db = IndexDb.open(':memory:')
  seed(db)
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} />)
  const frame = view.lastFrame()!
  expect(frame).toContain('Fix the SSE reconnect race')
  expect(frame).toContain('main · 2 files')
  expect(frame).toContain('Prompt text')
  expect(frame).toContain('fix the sse reconnect')
  view.unmount()
  db.close()
})

test('typing and pasted multi-codepoint text filter the list and grapheme backspace is atomic', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { title: 'reconnect 🧪' })
  const unrelated = seed(db, { uid: 'claude:b', nativeId: 'b', title: 'Unrelated work' })
  db.upsertDoc({ ref: unrelated, prompts: ['different topic'], prose: [], files: [], truncated: false })
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} />)
  view.stdin.write('reconnect 🧪')
  await tick()
  expect(view.lastFrame()).toContain('reconnect 🧪')
  expect(view.lastFrame()).not.toContain('Unrelated work')
  view.stdin.write('\u007f')
  await tick()
  expect(view.lastFrame()).toContain('▸ reconnect')
  expect(view.lastFrame()?.split('\n', 1)[0]).not.toContain('🧪')
  view.unmount()
  db.close()
})

test('enter emits one resume plan for a resume-tier row', async () => {
  const db = IndexDb.open(':memory:')
  seed(db)
  const plans: ExecPlan[] = []
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={(plan) => plans.push(plan)} {...opts} />)
  view.stdin.write('\r')
  await tick()
  view.stdin.write('\r')
  await tick()
  expect(plans).toHaveLength(1)
  expect(plans[0]?.kind).toBe('resume')
  expect(plans[0]?.args).toEqual(['--resume', 'a'])
  view.unmount()
  db.close()
})

test('search-tier activation explicitly confirms a new briefed, not resumed, session', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { tier: 'search' })
  let plan: ExecPlan | undefined
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={(value) => { plan = value }} {...opts} />)
  view.stdin.write('\r')
  await tick()
  const frame = view.lastFrame()!.toLowerCase()
  expect(frame).toContain('new session')
  expect(frame).toContain('brief')
  expect(frame).not.toContain('resumed')
  view.stdin.write('\r')
  await tick()
  expect(plan?.kind).toBe('brief')
  expect(plan?.prompt).toContain('Handover from a previous session')
  view.unmount()
  db.close()
})

test('escape cancels confirmation and tab toggles directory scope', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { tier: 'search' })
  seed(db, { uid: 'claude:far', nativeId: 'far', cwd: '/somewhere/else', title: 'Far away work' })
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} />)
  expect(view.lastFrame()).not.toContain('Far away work')
  view.stdin.write('\r')
  await tick()
  view.stdin.write('\u001b')
  await tick()
  expect(view.lastFrame()).toContain('type to search')
  view.stdin.write('\t')
  await tick()
  expect(view.lastFrame()).toContain('Far away work')
  view.unmount()
  db.close()
})

test('unmodified p, y and f always search; ctrl+p, ctrl+y and ctrl+f are shortcuts', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { title: 'apple fry type' })
  const copied: string[] = []
  const clipboard = { writeText: async (text: string) => { copied.push(text) } }
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} clipboard={clipboard} onExec={() => {}} {...opts} />)
  view.stdin.write('p')
  await tick()
  expect(view.lastFrame()).toContain('▸ p')
  expect(copied).toEqual([])
  view.stdin.write('\u007f')
  await tick()
  view.stdin.write('\u0010')
  await tick()
  expect(copied).toEqual(['fix the sse reconnect'])
  expect(view.lastFrame()).toContain('first prompt copied')
  view.stdin.write('app')
  await tick()
  expect(view.lastFrame()).toContain('▸ app')
  for (let index = 0; index < 3; index++) {
    view.stdin.write('\u007f')
    await tick()
  }
  view.stdin.write('\u0019')
  await tick()
  expect(copied[1]).toContain("claude --resume a")
  view.stdin.write('\u0006')
  await tick()
  expect(view.lastFrame()).toContain('proj · claude')
  view.unmount()
  db.close()
})

test('the default clipboard factory is used without requiring navigator.clipboard', async () => {
  const db = IndexDb.open(':memory:')
  seed(db)
  const copied: string[] = []
  let factories = 0
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts}
    clipboardFactory={() => {
      factories++
      return { writeText: async (text) => { copied.push(text) } }
    }}
  />)
  view.stdin.write('\u0010')
  await tick()
  expect(copied).toEqual(['fix the sse reconnect'])
  expect(factories).toBe(1)
  view.unmount()
  db.close()
})

test('host clipboard selects an argv-based helper and reports helper failure truthfully', async () => {
  const calls: Array<{ command: string; args: string[]; text: string }> = []
  let exitCode = 0
  const runtime: ClipboardRuntime = {
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    which: (command) => command === 'wl-copy' ? '/usr/bin/wl-copy' : null,
    run: async (command, args, text) => { calls.push({ command, args, text }); return exitCode },
    isTTY: false,
    writeTty: async () => { throw new Error('not reached') },
  }
  const clipboard = createHostClipboard(runtime)
  expect(clipboard).not.toBeNull()
  await clipboard!.writeText('literal $(touch nope); `nope`')
  expect(calls).toEqual([{
    command: '/usr/bin/wl-copy', args: [], text: 'literal $(touch nope); `nope`',
  }])
  exitCode = 3
  expect(clipboard!.writeText('denied')).rejects.toThrow('status 3')
})

test('OSC52 fallback accepts the generic UTF-8 ceiling and reports only that a sequence was sent', async () => {
  const writes: string[] = []
  const runtime: ClipboardRuntime = {
    platform: 'linux', env: {}, which: () => null,
    run: async () => { throw new Error('not reached') },
    isTTY: true,
    writeTty: async (sequence) => { writes.push(sequence) },
  }
  const clipboard = createHostClipboard(runtime)
  expect(await clipboard!.writeText('🧪'.repeat(16_384))).toBe('sent')
  expect(writes).toHaveLength(1)
  const encoded = writes[0]!.match(/^\u001b\]52;c;([^\u0007]+)\u0007$/)?.[1]
  expect(encoded).toBeDefined()
  expect(Buffer.from(encoded!, 'base64').byteLength).toBeLessThanOrEqual(65_536)
})

test('display helpers are ineligible without their matching nonempty display environment', () => {
  for (const env of [{}, { WAYLAND_DISPLAY: '', DISPLAY: '' }]) {
    const lookedUp: string[] = []
    const clipboard = createHostClipboard({
      platform: 'linux', env,
      which: (command) => { lookedUp.push(command); return `/usr/bin/${command}` },
      run: async () => 0, isTTY: false, writeTty: async () => {},
    })
    expect(clipboard).toBeNull()
    expect(lookedUp).toEqual([])
  }
})

test('host clipboard selects platform-native and X11 helpers with exact argv', async () => {
  const calls: Array<{ command: string; args: string[]; text: string }> = []
  const runtime = (platform: string, env: Record<string, string | undefined>): ClipboardRuntime => ({
    platform,
    env,
    which: (command) => `/usr/bin/${command}`,
    run: async (command, args, text) => {
      calls.push({ command, args, text })
      return 0
    },
    isTTY: false,
    writeTty: async () => {},
  })

  await createHostClipboard(runtime('darwin', {}))!.writeText('mac text')
  await createHostClipboard(runtime('win32', {}))!.writeText('windows text')
  await createHostClipboard(runtime('linux', { DISPLAY: ':0' }))!.writeText('x11 text')

  expect(calls).toEqual([
    { command: '/usr/bin/pbcopy', args: [], text: 'mac text' },
    { command: '/usr/bin/clip', args: [], text: 'windows text' },
    { command: '/usr/bin/xclip', args: ['-selection', 'clipboard'], text: 'x11 text' },
  ])
})

test('a failed eligible helper falls back to OSC52 only on a TTY', async () => {
  const writes: string[] = []
  const ttyRuntime: ClipboardRuntime = {
    platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' },
    which: (command) => command === 'wl-copy' ? '/usr/bin/wl-copy' : null,
    run: async () => 9, isTTY: true,
    writeTty: async (sequence) => { writes.push(sequence) },
  }
  expect(await createHostClipboard(ttyRuntime)!.writeText('fallback text')).toBe('sent')
  expect(writes).toHaveLength(1)

  const nonTty = { ...ttyRuntime, isTTY: false, writeTty: async () => { throw new Error('not reached') } }
  expect(createHostClipboard(nonTty)!.writeText('failure')).rejects.toThrow('status 9')
})

test('every clipboard backend rejects oversized UTF-8 before spawning or writing', async () => {
  let runs = 0
  let writes = 0
  const helper = createHostClipboard({
    platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, which: () => '/usr/bin/wl-copy',
    run: async () => { runs++; return 0 }, isTTY: true, writeTty: async () => { writes++ },
  })!
  expect(helper.writeText('x'.repeat(65_537))).rejects.toThrow('65,536')
  expect(runs).toBe(0)
  expect(writes).toBe(0)

  const osc = createHostClipboard({
    platform: 'linux', env: {}, which: () => null, run: async () => 0,
    isTTY: true, writeTty: async () => { writes++ },
  })!
  expect(osc.writeText('🧪'.repeat(16_385))).rejects.toThrow('65,536')
  expect(writes).toBe(0)
})

test('host clipboard discovery failures degrade to unavailable off-TTY', () => {
  expect(createHostClipboard({
    platform: 'linux', env: {}, which: () => { throw new Error('broken PATH') },
    run: async () => 0, isTTY: false, writeTty: async () => {},
  })).toBeNull()
})

test('copied prompts are bounded and strip terminal and bidi controls', async () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db)
  db.upsertDoc({
    ref,
    prompts: [`start\r\u001b[31m\u0085\u202etail${'x'.repeat(100_000)}`],
    prose: [], files: [], truncated: false,
  })
  const copied: string[] = []
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters}
    clipboard={{ writeText: async (text) => { copied.push(text) } }} onExec={() => {}} {...opts} />)
  view.stdin.write('\u0010')
  await tick()
  expect(copied).toHaveLength(1)
  expect(copied[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/u)
  expect(Buffer.byteLength(copied[0]!, 'utf8')).toBeLessThanOrEqual(16_384)
  view.unmount()
  db.close()
})

test('row tier and adapter plan kind must agree in both directions', async () => {
  for (const [tier, wrongKind] of [['resume', 'brief'], ['search', 'resume']] as const) {
    const db = IndexDb.open(':memory:')
    seed(db, { tier })
    const wrong: Adapter = {
      ...adapters[0]!,
      plan: () => ({ kind: wrongKind, cmd: 'claude', args: [], cwd: '/home/dev/work/proj' }),
    }
    const plans: ExecPlan[] = []
    const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[wrong]}
      onExec={(plan) => plans.push(plan)} {...opts} />)
    view.stdin.write('\r')
    await tick()
    expect(plans).toEqual([])
    expect(view.lastFrame()).toContain('plan does not match')
    expect(view.lastFrame()).not.toContain('enter to continue')
    view.unmount()
    db.close()
  }
})

test('unsafe or oversized resume commands are rejected before the clipboard backend', async () => {
  const badPlans: ExecPlan[] = [
    { kind: 'resume', cmd: 'claude\u001b[31m', args: ['--resume', 'a'], cwd: '/home/dev/work/proj' },
    { kind: 'resume', cmd: 'claude', args: ['--resume', 'id\nnext'], cwd: '/home/dev/work/proj' },
    { kind: 'resume', cmd: 'claude', args: ['--resume', 'a'], cwd: '/root/\u202eevil' },
    { kind: 'resume', cmd: 'claude', args: ['x'.repeat(20_000)], cwd: '/home/dev/work/proj' },
  ]
  for (const plan of badPlans) {
    const db = IndexDb.open(':memory:')
    seed(db)
    let writes = 0
    const adapter: Adapter = { ...adapters[0]!, plan: () => plan }
    const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[adapter]}
      clipboard={{ writeText: async () => { writes++ } }} onExec={() => {}} {...opts} />)
    view.stdin.write('\u0019')
    await tick()
    expect(writes).toBe(0)
    expect(view.lastFrame()).toContain('command unsafe to copy')
    view.unmount()
    db.close()
  }
})

test('25 MiB native-id, cwd and arg values are rejected before bounded control scans', async () => {
  const huge = 'x'.repeat(25 * 1024 * 1024)
  const cases: ExecPlan[] = [
    { kind: 'resume', cmd: 'claude', args: ['--resume', huge], cwd: '/home/dev/work/proj' },
    { kind: 'resume', cmd: 'claude', args: [], cwd: `/root/${huge}` },
    { kind: 'resume', cmd: 'claude', args: ['--flag', huge], cwd: '/home/dev/work/proj' },
  ]
  for (const plan of cases) {
    const work: CommandCopyWork = { scannedCodeUnits: 0 }
    expect(safeCommandForClipboard(plan, work)).toBeNull()
    expect(work.scannedCodeUnits).toBeLessThanOrEqual(8_192)

    const db = IndexDb.open(':memory:')
    seed(db)
    let writes = 0
    const adapter: Adapter = { ...adapters[0]!, plan: () => plan }
    const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[adapter]}
      clipboard={{ writeText: async () => { writes++ } }} onExec={() => {}} {...opts} />)
    view.stdin.write('\u0019')
    await tick()
    expect(writes).toBe(0)
    view.unmount()
    db.close()
  }
})

test('production picker mount enables alternate-screen ownership and cheap repaints', () => {
  let options: unknown
  const fakeRender = ((_node: React.ReactNode, value: unknown) => {
    options = value
    return { waitUntilExit: async () => {}, unmount: () => {} }
  }) as never
  mountPicker({} as never, fakeRender)
  expect(options).toEqual({
    alternateScreen: true,
    incrementalRendering: true,
    maxFps: 60,
  })
})

test('clipboard absence and rejection are reported without claiming success', async () => {
  const db = IndexDb.open(':memory:')
  seed(db)
  const unavailable = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} clipboard={null} onExec={() => {}} {...opts} />)
  unavailable.stdin.write('\u0010')
  await tick()
  expect(unavailable.lastFrame()).toContain('clipboard unavailable')
  expect(unavailable.lastFrame()).not.toContain('copied')
  unavailable.unmount()

  const rejected = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} clipboard={{ writeText: async () => { throw new Error('denied') } }} onExec={() => {}} {...opts} />)
  rejected.stdin.write('\u0019')
  await tick()
  expect(rejected.lastFrame()).toContain('copy failed')
  expect(rejected.lastFrame()).not.toContain('copied')
  rejected.unmount()
  db.close()
})

test('preview bounds and sanitizes every untrusted field before Ink renders it', () => {
  const db = IndexDb.open(':memory:')
  seed(db, {
    title: `start\n\u001b[31m${'x'.repeat(2_000_000)}END_UNTRUSTED_TITLE`,
    cwd: `/root/\u202eevil${'c'.repeat(2_000_000)}`,
    gitBranch: `branch\n${'b'.repeat(2_000_000)}`,
  })
  db.raw().query('UPDATE session_text SET prompts = ? WHERE uid = ?').run(`prompt\n\u001b[2J${'q'.repeat(2_000_000)}`, 'claude:a')
  db.raw().query('INSERT INTO session_file(uid, path) VALUES (?, ?)').run('claude:a', `unsafe\n\u001b[H${'z'.repeat(2_000_000)}`)
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} />)
  const frame = view.lastFrame()!
  expect(frame).not.toContain('\u001b')
  expect(frame).not.toContain('\u202e')
  expect(frame.length).toBeLessThan(5_000)
  expect(frame).not.toContain('END_UNTRUSTED_TITLE')
  view.unmount()
  db.close()
})

test('filter changes and non-finite terminal height never activate a stale row', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:a', nativeId: 'a', title: 'alpha' })
  seed(db, { uid: 'claude:b', nativeId: 'b', title: 'beta' })
  const plans: ExecPlan[] = []
  const previousRows = process.stdout.rows
  Object.defineProperty(process.stdout, 'rows', { configurable: true, value: Number.NaN })
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={(plan) => plans.push(plan)} {...opts} />)
  view.stdin.write('beta')
  await tick()
  view.stdin.write('\r')
  await tick()
  expect(plans[0]?.args).toEqual(['--resume', 'b'])
  view.unmount()
  Object.defineProperty(process.stdout, 'rows', { configurable: true, value: previousRows })
  db.close()
})

test('adapter planning failures are contained in the picker', async () => {
  const db = IndexDb.open(':memory:')
  seed(db)
  const broken: Adapter = { ...adapters[0]!, plan: () => { throw new Error('broken') } }
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[broken]} onExec={() => {}} {...opts} />)
  view.stdin.write('\r')
  await tick()
  expect(view.lastFrame()).toContain('could not plan')
  view.unmount()
  db.close()
})

test('arrow keys move the preview selection and ctrl-c never executes a row', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:a', nativeId: 'a', title: 'alpha' })
  seed(db, { uid: 'claude:b', nativeId: 'b', title: 'beta' })
  const plans: ExecPlan[] = []
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={(plan) => plans.push(plan)} {...opts} />)
  view.stdin.write('\u001b[B')
  await tick()
  // The gutter rail marks the row under the cursor, and the preview below the
  // rule follows it rather than staying on the row the picker opened with.
  expect(view.lastFrame()!).toContain('│ claude     now proj           alpha')
  expect(previewOf(view.lastFrame()!)).toContain('beta')
  view.stdin.write('\u001b[A')
  await tick()
  expect(view.lastFrame()!).toContain('▌ claude     now proj           alpha')
  expect(previewOf(view.lastFrame()!)).toContain('alpha')
  view.stdin.write('\u0003')
  await tick()
  expect(plans).toEqual([])
  view.unmount()
  db.close()
})

test('runPick tears Ink and the database down before checking and running the plan', async () => {
  const events: string[] = []
  const plan: ExecPlan = { kind: 'resume', cmd: 'claude', args: ['--resume', 'a'], cwd: '/home/dev/work/proj' }
  const db = {
    close: () => { events.push('close') },
  } as unknown as IndexDb
  const deps: PickDependencies = {
    isTTY: () => true,
    needsConsent: () => false,
    indexExists: () => true,
    indexPath: () => '/index.db',
    indexedAt: () => undefined,
    loadConfig: () => DEFAULT_CONFIG,
    buildAdapters: () => ({ adapters, diagnostics: [] }),
    openDb: () => db,
    cwd: () => '/home/dev/work/proj',
    now: () => NOW,
    mount: (props) => {
      props.onExec(plan)
      props.onExec({ ...plan, args: ['wrong'] })
      return {
        waitUntilExit: async () => { events.push('wait') },
        unmount: () => { events.push('unmount') },
      }
    },
    checkPlan: (value) => {
      events.push('check')
      expect(value).toEqual(plan)
      return { ok: true }
    },
    runPlan: async (value) => {
      events.push('run')
      expect(value).toEqual(plan)
      return 17
    },
    ensureIndex: async () => { throw new Error('index already exists') },
    error: () => { throw new Error('unexpected error output') },
  }
  expect(await runPick(deps)).toBe(17)
  expect(events).toEqual(['wait', 'unmount', 'close', 'check', 'run'])
})

test('runPick reindexes and reopens the index when the picker asks for it, then continues', async () => {
  const events: string[] = []
  let mounts = 0
  const db = { close: () => { events.push('close') } } as unknown as IndexDb
  const deps: PickDependencies = {
    isTTY: () => true,
    needsConsent: () => false,
    indexExists: () => true,
    indexPath: () => '/index.db',
    indexedAt: () => undefined,
    loadConfig: () => DEFAULT_CONFIG,
    buildAdapters: () => ({ adapters, diagnostics: [] }),
    openDb: () => { events.push('open'); return db },
    cwd: () => '/home/dev/work/proj',
    now: () => NOW,
    mount: (props) => {
      mounts += 1
      const thisMount = mounts
      return {
        waitUntilExit: async () => {
          events.push(`wait${thisMount}`)
          if (thisMount === 1) props.onReindex?.()
        },
        unmount: () => { events.push(`unmount${thisMount}`) },
      }
    },
    checkPlan: () => { throw new Error('nothing was ever selected') },
    runPlan: async () => { throw new Error('nothing was ever selected') },
    ensureIndex: async () => { events.push('reindex'); return 0 },
    error: () => { throw new Error('unexpected error output') },
  }
  expect(await runPick(deps)).toBe(0)
  expect(mounts).toBe(2)
  expect(events).toEqual(['open', 'wait1', 'unmount1', 'close', 'reindex', 'open', 'wait2', 'unmount2', 'close'])
})

test('a manual reindex that changes nothing on disk still reads as fresh on the remount', async () => {
  // A real reindex that finds nothing new never touches the index file's mtime,
  // so trusting that mtime after a reindex the user just asked for would leave
  // the status line calling a just-refreshed index stale forever. The moment
  // the refresh completed has to stand in for it instead.
  let mounts = 0
  const indexedAtSeen: (number | undefined)[] = []
  const db = { close: () => {} } as unknown as IndexDb
  const deps: PickDependencies = {
    isTTY: () => true,
    needsConsent: () => false,
    indexExists: () => true,
    indexPath: () => '/index.db',
    indexedAt: () => NOW - 999 * 3_600_000,
    loadConfig: () => ({ ...DEFAULT_CONFIG, autoReindexAfterHours: 24_000 }),
    buildAdapters: () => ({ adapters, diagnostics: [] }),
    openDb: () => db,
    cwd: () => '/home/dev/work/proj',
    now: () => NOW,
    mount: (props) => {
      mounts += 1
      const thisMount = mounts
      indexedAtSeen.push(props.indexedAt)
      return {
        waitUntilExit: async () => { if (thisMount === 1) props.onReindex?.() },
        unmount: () => {},
      }
    },
    checkPlan: () => { throw new Error('nothing was ever selected') },
    runPlan: async () => { throw new Error('nothing was ever selected') },
    ensureIndex: async () => 0,
    error: () => { throw new Error('unexpected error output') },
  }
  expect(await runPick(deps)).toBe(0)
  expect(indexedAtSeen).toEqual([NOW - 999 * 3_600_000, NOW])
})

test('a failed manual reindex recovers the readable index and reports failure', async () => {
  const messages: string[] = []
  let mounts = 0
  const notices: (string | undefined)[] = []
  const ages: (number | undefined)[] = []
  const db = { close: () => {} } as unknown as IndexDb
  const deps: PickDependencies = {
    isTTY: () => true,
    needsConsent: () => false,
    indexExists: () => true,
    indexPath: () => '/index.db',
    indexedAt: () => NOW - 7 * 3_600_000,
    loadConfig: () => ({ ...DEFAULT_CONFIG, autoReindexAfterHours: 24_000 }),
    buildAdapters: () => ({ adapters, diagnostics: [] }),
    openDb: () => db,
    cwd: () => '/home/dev/work/proj',
    now: () => NOW,
    mount: (props) => {
      notices.push(props.initialNotice)
      ages.push(props.indexedAt)
      return ({
      waitUntilExit: async () => { if (++mounts === 1) props.onReindex?.() },
      unmount: () => {},
    }) },
    checkPlan: () => { throw new Error('nothing was ever selected') },
    runPlan: async () => { throw new Error('nothing was ever selected') },
    ensureIndex: async () => { throw new Error('disk full') },
    error: (value) => { messages.push(value) },
  }
  expect(await runPick(deps)).toBe(0)
  expect(messages).toEqual([])
  expect(notices).toEqual([undefined, 'Refresh failed: disk full; continuing with the existing index'])
  expect(ages).toEqual([NOW - 7 * 3_600_000, NOW - 7 * 3_600_000])
  expect(mounts).toBe(2)
})

test('runPick handles non-TTY, missing index, mount failures and exits without a selection', async () => {
  const messages: string[] = []
  const base = {
    isTTY: () => false,
    needsConsent: () => false,
    indexExists: () => true,
    ensureIndex: async () => 1,
    error: (message: string) => { messages.push(message) },
  }
  expect(await runPick(base)).toBe(1)
  expect(messages.join(' ')).toContain('terminal')

  messages.length = 0
  expect(await runPick({ ...base, isTTY: () => true, indexExists: () => false })).toBe(1)
  expect(messages.join(' ')).toContain('index')

  let closed = 0
  const db = { close: () => { closed++ } } as unknown as IndexDb
  expect(await runPick({
    ...base,
    isTTY: () => true,
    openDb: () => db,
    loadConfig: () => DEFAULT_CONFIG,
    buildAdapters: () => ({ adapters, diagnostics: [] }),
    mount: () => { throw new Error('mount failed') },
  })).toBe(1)
  expect(closed).toBe(1)

  expect(await runPick({
    ...base,
    isTTY: () => true,
    openDb: () => db,
    loadConfig: () => DEFAULT_CONFIG,
    buildAdapters: () => ({ adapters, diagnostics: [] }),
    mount: () => ({ waitUntilExit: async () => {}, unmount: () => {} }),
  })).toBe(0)
  expect(closed).toBe(2)
})

test('runPick closes the database and never checks a plan when Ink exit fails', async () => {
  const events: string[] = []
  const db = { close: () => { events.push('close') } } as unknown as IndexDb
  const code = await runPick({
    isTTY: () => true,
    needsConsent: () => false,
    indexExists: () => true,
    openDb: () => db,
    loadConfig: () => DEFAULT_CONFIG,
    buildAdapters: () => ({ adapters, diagnostics: [] }),
    mount: (props) => {
      props.onExec({ kind: 'resume', cmd: 'claude', args: [], cwd: '/home/dev/work/proj' })
      return {
        waitUntilExit: async () => { events.push('wait'); throw new Error('Ink failed\n\u001b[2J') },
        unmount: () => { events.push('unmount') },
      }
    },
    checkPlan: () => { events.push('check'); return { ok: true } },
    error: (value) => {
      events.push(`error:${value}`)
      expect(value).not.toContain('\n')
      expect(value).not.toContain('\u001b')
    },
  })
  expect(code).toBe(1)
  expect(events).toEqual(['wait', 'unmount', 'close', 'error:picker failed: Ink failed  [2J'])
})

test('the preview budget never outgrows the terminal', () => {
  for (const rows of [4, 8, 12, 24, 40, 100]) {
    const lines = previewLines(rows)
    expect(lines).toBeGreaterThanOrEqual(2)
    expect(lines).toBeLessThanOrEqual(Math.max(2, rows))
  }
})

test('the preview drops a first prompt that only restates the title', async () => {
  const db = IndexDb.open(':memory:')
  // Longer than the 120 columns the prompt is bounded to and shorter than the
  // 160 the title gets, so comparing the bounded forms would miss the match.
  const shared = `resume the release work ${'and keep going '.repeat(9)}`.trim()
  expect(shared.length).toBeGreaterThan(120)
  const ref = seed(db, { uid: 'claude:dup', nativeId: 'dup', title: shared })
  db.upsertDoc({ ref, prompts: [shared], prose: [], files: [], truncated: false })

  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24} />,
  )
  await tick()
  const opening = shared.slice(0, 40)
  const echoed = view.lastFrame()!.split('\n').filter((line) => line.includes(opening))
  // Once in the list row, once as the preview title, and nowhere else.
  expect(echoed.length).toBe(2)
  view.unmount()
})

test('the preview keeps a first prompt that differs from the title', async () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:diff', nativeId: 'diff', title: 'a short title' })
  db.upsertDoc({
    ref, prompts: ['an entirely different opening prompt'], prose: [], files: [], truncated: false,
  })
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24} />,
  )
  await tick()
  expect(view.lastFrame()!).toContain('an entirely different opening prompt')
  view.unmount()
})

test('an empty project filter offers a counterfactual action that widens scope', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:only', nativeId: 'only' })
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24}
    initialState={{ text: '', filters: { scope: '/empty/project', client: null, time: { kind: 'preset', preset: 'all' }, sort: 'auto', bookmarkedOnly: false }, selectedUid: null, selectedIndex: 0, listTop: 0, reader: null }} />)
  await tick()
  expect(view.lastFrame()).toContain('Show all projects')
  expect(view.lastFrame()).not.toContain('Fix the SSE reconnect race')
  view.stdin.write('\u000b'); await tick()
  view.stdin.write('Show all projects'); await tick()
  view.stdin.write('\r'); await tick()
  expect(view.lastFrame()).toContain('Fix the SSE reconnect race')
  expect(view.lastFrame()!.split('\n')[0]).toContain('everywhere')
  view.unmount()
  db.close()
})

test('typing lights the matching span inside a title', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:m', nativeId: 'm', title: 'fix the retry budget' })
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24} />,
  )
  await tick()
  view.stdin.write('retry')
  await tick()
  // The title survives being split into lit and unlit spans.
  expect(view.lastFrame()!).toContain('fix the retry budget')
  view.unmount()
})

test('the preview takes about a third of the screen and leaves the list the rest', () => {
  for (const rows of [100, 60, 34, 24]) {
    const preview = previewLines(rows)
    expect(preview).toBeGreaterThanOrEqual(Math.floor(rows / 3) - 1)
    expect(preview).toBeLessThanOrEqual(Math.floor(rows / 3))
    // The list must survive: it never drops below what is left after the pane.
    expect(rows - preview).toBeGreaterThan(preview)
  }
  // A short terminal keeps a floor rather than collapsing to nothing.
  for (const rows of [4, 8, 12]) expect(previewLines(rows)).toBeGreaterThanOrEqual(4)
})

test('a long reply cannot crowd out what was asked or which files moved', () => {
  // 3 lines to split between a short ask, a long reply and a short file list.
  expect(shareLines(3, [1, 40, 1])).toEqual([1, 1, 1])
  // Slack from a block that wants little falls to the ones that want more.
  expect(shareLines(10, [1, 40, 1])).toEqual([1, 8, 1])
  // Nothing to give, nothing given.
  expect(shareLines(0, [5, 5])).toEqual([0, 0])
  expect(shareLines(-3, [5, 5])).toEqual([0, 0])
  // Never more than a block actually has.
  expect(shareLines(100, [2, 3])).toEqual([2, 3])
})

test('a search that matches nothing says what to do about it', async () => {
  const db = IndexDb.open(':memory:')
  seed(db)
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24} />,
  )
  await tick()
  view.stdin.write('zzqqx')
  await tick()
  const frame = view.lastFrame()!
  expect(frame).toContain('Nothing came up')
  expect(frame).toContain('Try fewer words')
  // The rule and the empty preview are noise once there is nothing to preview.
  expect(frame).not.toContain('nothing selected')
  expect(frame.split('\n').some((line) => /^─+$/u.test(line.trim()))).toBe(false)
  view.unmount()
})

test('an index with nothing in it points at the command that fills it', async () => {
  const db = IndexDb.open(':memory:')
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24} />,
  )
  await tick()
  const frame = view.lastFrame()!
  expect(frame).toContain('No sessions indexed yet')
  expect(frame).toContain('nekyia index')
  view.unmount()
})

test('the footer names its keys rather than drawing them', async () => {
  const db = IndexDb.open(':memory:')
  seed(db)
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24} />,
  )
  await tick()
  const frame = view.lastFrame()!
  // A reader who does not already know the glyph cannot find the key.
  expect(frame).toContain('enter Resume')
  expect(frame).toContain('ctrl+k Actions')
  expect(frame).toContain('ctrl+g Filters')
  expect(frame).toContain('F1 Help')
  expect(frame).toContain('ctrl+k Actions')
  for (const glyph of ['⇥', '↵']) expect(frame).not.toContain(glyph)
  // Whatever is shown is shown whole; a hint cut in half helps nobody.
  expect(frame).not.toContain('…')
  view.stdin.write('\u000b'); await tick()
  view.stdin.write('Inspect history'); await tick()
  expect(view.lastFrame()).toContain('Inspect history (ctrl+o)')
  view.unmount()
})

test('ctrl+f steps only through the clients the index actually holds', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:one', nativeId: 'one', title: 'claude work' })
  seed(db, { uid: 'codex:one', client: 'codex', nativeId: 'one', title: 'codex work' })
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24} />,
  )
  await tick()
  const header = () => view.lastFrame()!.split('\n', 1)[0]!
  expect(header()).toContain('2 sessions')
  expect(header()).toContain('proj')

  view.stdin.write('\u0006')
  await tick()
  expect(header()).toContain('1 session')
  expect(header()).toContain('proj · claude')
  view.stdin.write('\u0006')
  await tick()
  expect(header()).toContain('1 session')
  expect(header()).toContain('proj · codex')

  // Three presses is the whole cycle. It used to take seven, five of which
  // filtered to a client this machine has never run.
  view.stdin.write('\u0006')
  await tick()
  expect(header()).toContain('2 sessions')
  expect(header()).toContain('proj')
  expect(header()).not.toContain('codex')
  view.unmount()
  db.close()
})

test('an index with no clients in it offers no client key to press', async () => {
  const db = IndexDb.open(':memory:')
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24} />,
  )
  await tick()
  const frame = view.lastFrame()!
  expect(frame).toContain('No sessions indexed yet')
  // Nothing to cycle to, so the hint that promises the cycle is not offered.
  expect(frame).not.toContain('ctrl+f')
  expect(frame).toContain('F1 Help')
  // And pressing it anyway is a no-op rather than a crash.
  view.stdin.write('\u0006')
  await tick()
  expect(view.lastFrame()!).toContain('No sessions indexed yet')
  view.unmount()
  db.close()
})

test('a launch directory with nothing indexed under it opens on the whole index', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:a', nativeId: 'a', title: 'gateway work', cwd: '/work/api-gateway' })
  seed(db, { uid: 'claude:b', nativeId: 'b', title: 'console work', cwd: '/work/web-console' })
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
      cwd="/work/never-indexed" now={NOW} rows={24} />,
  )
  // Truthful on the first frame: the header names what is being searched before
  // anything has had a chance to lay out.
  expect(view.lastFrame()!).toContain('everywhere')
  await tick()
  const frame = view.lastFrame()!
  expect(frame).toContain('everywhere')
  expect(frame).not.toContain('never-indexed')
  expect(frame).toContain('gateway work')
  expect(frame).toContain('console work')

  // Tab still narrows from there, to the project of the row under the cursor.
  view.stdin.write('\u001b[B')
  await tick()
  view.stdin.write('\t')
  await tick()
  const scoped = view.lastFrame()!
  expect(scoped).toContain('web-console')
  expect(scoped).toContain('console work')
  expect(scoped).not.toContain('gateway work')
  view.unmount()
  db.close()
})

test('tab narrows to the project under the cursor and widens back', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:a', nativeId: 'a', title: 'gateway work', cwd: '/work/api-gateway' })
  seed(db, { uid: 'claude:b', nativeId: 'b', title: 'console work', cwd: '/work/web-console' })
  // The launch directory has a session of its own, which is what makes the
  // picker open scoped to it. Without one it would open on the whole index,
  // and this test would never see the widening half of tab.
  seed(db, { uid: 'claude:here', nativeId: 'here', title: 'local work', cwd: '/somewhere-else' })
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
      cwd="/somewhere-else" now={NOW} rows={24} />,
  )
  await tick()
  // Launched outside either project, so the scope names where it actually is.
  expect(view.lastFrame()!).toContain('somewhere-else')
  expect(view.lastFrame()!).not.toContain('gateway work')

  view.stdin.write('\t')
  await tick()
  expect(view.lastFrame()!).toContain('everywhere')
  expect(view.lastFrame()!).toContain('gateway work')
  expect(view.lastFrame()!).toContain('console work')

  // Move onto the console row, then narrow to whatever the cursor is on.
  view.stdin.write('\u001b[B')
  await tick()
  view.stdin.write('\t')
  await tick()
  const scoped = view.lastFrame()!
  expect(scoped).toContain('web-console')
  expect(scoped).toContain('console work')
  expect(scoped).not.toContain('gateway work')

  // And back out again.
  view.stdin.write('\t')
  await tick()
  expect(view.lastFrame()!).toContain('everywhere')
  view.unmount()
})

test('the footer drops hints it cannot fit rather than cutting one in half', () => {
  const keys: [string, string][] = [
    ['enter', 'resume'], ['ctrl+o', 'history'], ['tab', 'scope'], ['esc', 'quit'],
  ]
  // Everything fits when there is room.
  expect(fitKeys(keys, 200)).toEqual(keys)
  // "enter resume" is 12 wide; "ctrl+o history" is 14 more plus a 3 space gap.
  expect(fitKeys(keys, 12)).toEqual([['enter', 'resume']])
  expect(fitKeys(keys, 28)).toEqual([['enter', 'resume']])
  expect(fitKeys(keys, 29)).toEqual([['enter', 'resume'], ['ctrl+o', 'history']])
  // Nothing fits in nothing, and a negative width is not a crash.
  expect(fitKeys(keys, 0)).toEqual([])
  expect(fitKeys(keys, -20)).toEqual([])
})

test('ctrl+o opens the history, scrolls it, and hands focus back', async () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:long', nativeId: 'long', title: 'a long session' })
  db.upsertDoc({
    ref,
    prompts: Array.from({ length: 30 }, (_, i) => `prompt line ${i}`),
    prose: Array.from({ length: 200 }, (_, i) => `reply line ${i}`),
    files: [],
    truncated: false,
  })

  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={30} />,
  )
  await tick()
  // The quick preview is bounded; the full reader makes the retained tail reachable.
  expect(view.lastFrame()!).not.toContain('reply line 90')
  expect(view.lastFrame()!).toContain('ctrl+k Actions')

  view.stdin.write('\u000f')
  await tick()
  const opened = view.lastFrame()!
  // The footer says what the keys do here, so the mode is never a guess.
  expect(opened).toContain('History · claude:long')
  expect(opened).toContain('Esc back')
  expect(listRowsOf(opened)).toBe(0)
  expect(opened.split('\n').length).toBeLessThanOrEqual(30)
  expect(opened).toContain('prompt line 0')

  // Down scrolls the history rather than moving the list selection.
  for (let i = 0; i < 40; i++) view.stdin.write('\u001b[B')
  await tick()
  const scrolled = view.lastFrame()!
  expect(scrolled).not.toContain('prompt line 0')
  expect(scrolled).toContain('reply line')

  // Escape closes what it opened, and does not quit.
  view.stdin.write('\u001b')
  await tick()
  const closed = view.lastFrame()!
  expect(closed).toContain('ctrl+k Actions')
  expect(closed).toContain('a long session')
  view.unmount()
})

test('scrolling stops at the end of the history instead of running past it', async () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:short', nativeId: 'short', title: 'a short session' })
  db.upsertDoc({ ref, prompts: ['only one prompt'], prose: [], files: [], truncated: false })

  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={30} />,
  )
  await tick()
  view.stdin.write('\u000f')
  await tick()
  for (let i = 0; i < 50; i++) view.stdin.write('\u001b[B')
  await tick()
  // A history shorter than the pane cannot be scrolled off the top.
  expect(view.lastFrame()!).toContain('only one prompt')
  expect(view.lastFrame()!).toContain('Lines 1-')
  view.unmount()
})

test('indexAgeSeverity classifies age into the tiers the status line colors', () => {
  const HOUR = 3_600_000
  const DAY = 86_400_000
  expect(indexAgeSeverity(0)).toBe('fresh')
  expect(indexAgeSeverity(HOUR - 1)).toBe('fresh')
  expect(indexAgeSeverity(HOUR)).toBe('stale')
  expect(indexAgeSeverity(DAY - 1)).toBe('stale')
  expect(indexAgeSeverity(DAY)).toBe('very-stale')
  expect(indexAgeSeverity(DAY * 30)).toBe('very-stale')
})

test('each severity has its own status-line color, escalating with age', () => {
  expect(SEVERITY_COLOR.fresh).toBe('green')
  expect(SEVERITY_COLOR.stale).toBe('yellow')
  expect(SEVERITY_COLOR['very-stale']).toBe('red')
})

test('the picker says how old the index is when it has gone stale', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:stale', nativeId: 'stale' })
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    indexedAt={NOW - 7 * 3_600_000} {...opts}
  />)
  await tick()
  // Searching a stale index silently is the failure worth avoiding: the user
  // concludes the session cannot be found, rather than that it is not indexed yet.
  expect(view.lastFrame()).toContain('index 7h old')
  view.unmount()
  db.close()
})

test('a fresh index is shown too, so the status line confirms things are fine', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:fresh', nativeId: 'fresh' })
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    indexedAt={NOW - 60_000} {...opts}
  />)
  await tick()
  expect(view.lastFrame()).toContain('index 1m old')
  view.unmount()
  db.close()
})

test('a very stale index reads the same way a stale one does, one tier further', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:very-stale', nativeId: 'very-stale' })
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    indexedAt={NOW - 2 * 86_400_000} {...opts}
  />)
  await tick()
  expect(view.lastFrame()).toContain('index 2d old')
  view.unmount()
  db.close()
})

test('an unknown index age is left unstated rather than guessed at', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:unknown', nativeId: 'unknown' })
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts}
  />)
  await tick()
  expect(view.lastFrame()).not.toMatch(/index \S+ old/)
  view.unmount()
  db.close()
})

test('refresh is discoverable through Actions for fresh, unknown and stale indexes', async () => {
  const db = IndexDb.open(':memory:')
  seed(db)
  for (const indexedAt of [NOW - 60_000, undefined, NOW - 7 * 3_600_000]) {
    const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
      onReindex={() => {}} indexedAt={indexedAt} {...opts} />)
    await tick()
    expect(view.lastFrame()).toContain('ctrl+k Actions')
    view.stdin.write('\u000b'); await tick()
    view.stdin.write('Refresh'); await tick()
    expect(view.lastFrame()).toContain('Refresh index (ctrl+r)')
    view.unmount()
  }
  db.close()
})

test('ctrl+r asks the host to reindex, once the index is stale enough to offer it', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:a', nativeId: 'a' })
  let requested = 0
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    onReindex={() => { requested += 1 }}
    indexedAt={NOW - 7 * 3_600_000} {...opts}
  />)
  await tick()
  view.stdin.write('')
  await tick()
  expect(requested).toBe(1)
  view.unmount()
  db.close()
})

test('ctrl+r explicitly refreshes even when the index is fresh', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:a', nativeId: 'a' })
  let requested = 0
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    onReindex={() => { requested += 1 }}
    indexedAt={NOW - 60_000} {...opts}
  />)
  await tick()
  view.stdin.write('')
  await tick()
  expect(requested).toBe(1)
  view.unmount()
  db.close()
})

/**
 * A runPick dependency set that reaches the launch, with every failure path
 * closed off. Each test opens exactly one of them, so a failure it did not ask
 * for shows up as a thrown error rather than a silently different exit code.
 */
function launchingDeps(overrides: Partial<PickDependencies> = {}): PickDependencies {
  const plan: ExecPlan = { kind: 'resume', cmd: 'claude', args: ['--resume', 'a'], cwd: '/home/dev/work/proj' }
  return {
    isTTY: () => true,
    needsConsent: () => false,
    indexExists: () => true,
    indexPath: () => '/index.db',
    indexedAt: () => undefined,
    loadConfig: () => DEFAULT_CONFIG,
    buildAdapters: () => ({ adapters, diagnostics: [] }),
    openDb: () => ({ close: () => {} }) as unknown as IndexDb,
    cwd: () => '/home/dev/work/proj',
    now: () => NOW,
    mount: (props) => {
      props.onExec(plan)
      return { waitUntilExit: async () => {}, unmount: () => {} }
    },
    checkPlan: () => ({ ok: true }),
    runPlan: async () => 0,
    ensureIndex: async () => { throw new Error('index already exists') },
    error: (text) => { throw new Error(`unexpected error output: ${text}`) },
    ...overrides,
  }
}

test('runPick reports a launch it could not validate rather than launching it', async () => {
  const errors: string[] = []
  const code = await runPick(launchingDeps({
    checkPlan: () => { throw new Error('stat exploded') },
    runPlan: async () => { throw new Error('must not launch an unvalidated plan') },
    error: (text) => { errors.push(text) },
  }))

  expect(code).toBe(1)
  expect(errors).toEqual(['could not validate the launch: stat exploded'])
})

test('runPick refuses a plan the check rejected, and passes on the reason given', async () => {
  const errors: string[] = []
  const code = await runPick(launchingDeps({
    checkPlan: () => ({ ok: false, reason: 'the directory /home/dev/work/proj no longer exists' }),
    runPlan: async () => { throw new Error('must not launch a rejected plan') },
    error: (text) => { errors.push(text) },
  }))

  expect(code).toBe(1)
  expect(errors).toEqual(['the directory /home/dev/work/proj no longer exists'])
})

test('runPick still says something when the check rejects without a reason', async () => {
  const errors: string[] = []
  const code = await runPick(launchingDeps({
    // A rejection carrying no reason must not surface as an empty line: the
    // fallback is the only thing standing between the user and silence.
    checkPlan: () => ({ ok: false }),
    runPlan: async () => { throw new Error('must not launch a rejected plan') },
    error: (text) => { errors.push(text) },
  }))

  expect(code).toBe(1)
  expect(errors).toEqual(['the selected session cannot be launched'])
})

test('runPick reports a client that could not be launched', async () => {
  const errors: string[] = []
  const code = await runPick(launchingDeps({
    runPlan: async () => { throw new Error('spawn failed') },
    error: (text) => { errors.push(text) },
  }))

  expect(code).toBe(1)
  expect(errors).toEqual(['could not launch the client: spawn failed'])
})

/** Counts the session rows actually on screen; each one opens with the gutter glyph. */
function listRowsOf(frame: string): number {
  return frame.split('\n').filter((line) => /^[▌│]\s/u.test(line)).length
}

test('tab, backspace and delete cannot change browse state until history is explicitly closed', async () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:aa', nativeId: 'aa', title: 'reconnect work' })
  db.upsertDoc({
    ref,
    prompts: Array.from({ length: 40 }, (_, i) => `prompt line ${i}`),
    prose: [], files: [], truncated: false,
  })
  seed(db, { uid: 'claude:zz', nativeId: 'zz', cwd: '/somewhere/else', title: 'far away work' })

  // Nonprinting browse keys cannot change selection or filters beneath an open reader.
  // After Escape returns to browse, those same keys retain their normal meaning.
  for (const key of ['\t', '\u007f', '\u001b[3~']) {
    const view = render(
      <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={30} />,
    )
    await tick()
    view.stdin.write('\u000f')
    await tick()
    for (let i = 0; i < 8; i++) view.stdin.write('\u001b[B')
    await tick()
    expect(view.lastFrame()!).toContain('History · claude:aa')

    view.stdin.write(key)
    await tick()
    const frame = view.lastFrame()!
    expect(frame).toContain('History · claude:aa')
    expect(frame).not.toContain('far away work')
    view.stdin.write('\u001b'); await tick(80)
    view.stdin.write(key); await tick()
    expect(view.lastFrame()).toContain('ctrl+k Actions')
    // The original session remains inspectable; Home reaches its retained start.
    view.stdin.write('\u000f')
    await tick()
    view.stdin.write('\u001b[H'); await tick()
    expect(view.lastFrame()!).toContain('prompt line 0')
    view.unmount()
  }
  // And tab still did its own job on the way out.
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={30} />,
  )
  await tick()
  view.stdin.write('\u000f')
  await tick()
  view.stdin.write('\u001b'); await tick(80)
  view.stdin.write('\t')
  await tick()
  expect(view.lastFrame()!).toContain('far away work')
  view.unmount()
  db.close()
})

test('scrolling past the end costs nothing to come back from', async () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:mid', nativeId: 'mid', title: 'a scrollable session' })
  db.upsertDoc({
    ref,
    prompts: Array.from({ length: 30 }, (_, i) => `prompt line ${i}`),
    prose: [], files: [], truncated: false,
  })
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={30} />,
  )
  await tick()
  view.stdin.write('\u000f')
  await tick()
  expect(view.lastFrame()).toContain('prompt line 0')

  for (let i = 0; i < 60; i++) view.stdin.write('\u001b[B')
  await tick()
  expect(view.lastFrame()).not.toContain('prompt line 0')

  // Forty presses back is further than the pane can have travelled, so the top
  // must be back. It was not: the down presses banked invisible scroll debt
  // that the up presses paid off before the pane moved a single line.
  for (let i = 0; i < 40; i++) view.stdin.write('\u001b[A')
  await tick()
  expect(view.lastFrame()).toContain('prompt line 0')
  view.unmount()
  db.close()
})

test('a short terminal spends its rows on the list rather than on decoration', async () => {
  const db = IndexDb.open(':memory:')
  for (let i = 0; i < 12; i++) {
    const ref = seed(db, { uid: `claude:${i}`, nativeId: String(i), title: `session number ${i}` })
    db.upsertDoc({ ref, prompts: [`prompt ${i}`], prose: [`reply ${i}`], files: [], truncated: false })
  }

  // Compact previews leave several list rows usable; taller stacked panes
  // retain both browsing and inspection access within the terminal budget.
  const minimum: Record<number, number> = { 8: 3, 10: 4, 12: 3, 14: 4, 20: 6 }
  for (const rows of [8, 10, 12, 14, 20]) {
    const view = render(<App
      db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
      {...opts} rows={rows} columns={100}
    />)
    await tick()
    const frame = view.lastFrame()!
    expect(listRowsOf(frame)).toBeGreaterThanOrEqual(minimum[rows]!)
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows)
    // The selected session and inspection entry point remain visible.
    expect(frame).toContain('session number 0')
    expect(frame).toContain('ctrl+k Actions')
    // The rule is decoration, so it is the first thing a short terminal loses.
    const hasRule = frame.split('\n').some((line) => /^─+$/u.test(line.trim()))
    expect(hasRule).toBe(rows >= 12)
    view.unmount()
  }
  db.close()
})

test('a long query keeps its tail on one row instead of taking rows from the list', async () => {
  const db = IndexDb.open(':memory:')
  for (let i = 0; i < 12; i++) {
    seed(db, { uid: `claude:${i}`, nativeId: String(i), title: `session number ${i}` })
  }
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    {...opts} rows={14} columns={100}
  />)
  await tick()
  const before = listRowsOf(view.lastFrame()!)
  expect(before).toBeGreaterThan(1)

  // 320 characters of a term every row carries, so the list still matches and
  // the only thing under test is what the prompt does with the width.
  view.stdin.write('session '.repeat(40))
  await tick(80)
  const lines = view.lastFrame()!.split('\n')
  // The prompt is bounded to the terminal, not to the 512 it may store, so it
  // occupies exactly one row and takes none from the list.
  expect(lines.filter((line) => line.includes('session session')).length).toBe(1)
  expect(listRowsOf(lines.join('\n'))).toBe(before)
  // The tail is what stayed: the end of what was just typed, with the overflow
  // fallen off the left rather than the other way round.
  expect(lines[1]!).toContain('…')
  expect(lines[1]!.trimEnd().endsWith('session')).toBe(true)
  view.unmount()
  db.close()
})

test('a session whose transcript has gone says so instead of vanishing', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:gone', nativeId: 'gone', title: 'work on a deleted transcript' })
  db.markMissing(['claude:gone'])
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24} />,
  )
  await tick()
  const frame = view.lastFrame()!
  // Dropping it turns "the file is gone" into "the session never existed".
  expect(frame).toContain('work on a deleted transcript')
  expect(frame).toContain('Source missing')
  view.unmount()
  db.close()
})

test('a count past the query limit is reported as such, and one session is one', async () => {
  const empty = IndexDb.open(':memory:')
  const none = render(
    <App db={empty} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24} />,
  )
  await tick()
  expect(none.lastFrame()!).toContain('0 sessions')
  none.unmount()
  empty.close()

  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:one', nativeId: 'one' })
  const one = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24} />,
  )
  await tick()
  expect(one.lastFrame()!).toContain('1 session ')
  expect(one.lastFrame()!).not.toContain('1 sessions')
  one.unmount()

  for (let i = 0; i < 501; i++) seed(db, { uid: `claude:n${i}`, nativeId: `n${i}` })
  const many = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24} />,
  )
  await tick()
  // Telling someone holding thousands of sessions that they have 500 is simply
  // untrue, and it hides every row past the limit behind a confident number.
  expect(many.lastFrame()!).toContain('500+ sessions')
  many.unmount()
  db.close()
})

test('ctrl+o with nothing selected does not open a mode with nothing in it', async () => {
  const db = IndexDb.open(':memory:')
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24} />,
  )
  await tick()
  view.stdin.write('\u000f')
  await tick()
  const frame = view.lastFrame()!
  // The reader's footer promised keys that do nothing, and its escape closed
  // something invisible instead of quitting, so the first press looked dead.
  expect(frame).not.toContain('History ·')
  expect(frame).toContain('F1 Help')
  expect(frame).toContain('No sessions indexed yet')
  view.unmount()
  db.close()
})

test('runPick settles a copy still in flight before the client takes the terminal', async () => {
  const events: string[] = []
  let finishCopy = () => {}
  const copy = new Promise<void>((resolve) => {
    finishCopy = () => { events.push('copied'); resolve() }
  })
  const plan: ExecPlan = { kind: 'resume', cmd: 'claude', args: ['--resume', 'a'], cwd: '/home/dev/work/proj' }
  const code = await runPick(launchingDeps({
    mount: (props) => {
      props.onExec(plan, copy)
      return {
        waitUntilExit: async () => { events.push('wait') },
        unmount: () => {
          events.push('unmount')
          // The helper only reports back after Ink has let go of the terminal.
          setTimeout(finishCopy, 5)
        },
      }
    },
    runPlan: async () => { events.push('run'); return 0 },
  }))

  expect(code).toBe(0)
  // An OSC 52 sequence written after this point lands in the launched client's
  // terminal, and the helper process dies with this one when the launch
  // replaces it, so the copy is silently lost.
  expect(events).toEqual(['wait', 'unmount', 'copied', 'run'])
})

test('a clipboard helper that never returns delays the launch rather than blocking it', async () => {
  const events: string[] = []
  const started = Date.now()
  const code = await runPick(launchingDeps({
    mount: (props) => {
      props.onExec(
        { kind: 'resume', cmd: 'claude', args: ['--resume', 'a'], cwd: '/home/dev/work/proj' },
        new Promise<void>(() => {}),
      )
      return { waitUntilExit: async () => {}, unmount: () => { events.push('unmount') } }
    },
    runPlan: async () => { events.push('run'); return 0 },
  }))

  expect(code).toBe(0)
  expect(events).toEqual(['unmount', 'run'])
  // Bounded: a stuck helper is a delay before the client starts, never a hang.
  expect(Date.now() - started).toBeLessThan(3_000)
})

test('a terminal that has been handed to a client takes no further escape sequence', async () => {
  // The drain before a launch waits half a second for a copy to finish, and
  // then gives up and launches anyway. A helper that hangs past that and only
  // then fails would fall back to OSC 52, writing its escape sequence into a
  // terminal the client now owns. Waiting was never ownership, so the handover
  // is stated instead: past it, the sequence is dropped rather than misdelivered.
  const written: string[] = []
  const spy = spyOn(process.stdout, 'write').mockImplementation(((
    chunk: unknown, callback?: (error?: Error | null) => void,
  ) => {
    written.push(String(chunk))
    callback?.(null)
    return true
  }) as typeof process.stdout.write)
  try {
    const mine = { owned: true }
    await writeTtySequence('before', mine)
    expect(written).toEqual(['before'])

    releaseTerminal(mine)
    await writeTtySequence('after', mine)
    expect(written).toEqual(['before'])
  } finally {
    spy.mockRestore()
  }
})

test('copying the first prompt takes the whole prompt, not its first line', async () => {
  // The stored `prompts` facet is every prompt joined by newlines, so its first
  // line is the first line of the first prompt and not the prompt. A prompt
  // written across several lines was copied with everything after the first
  // line silently dropped. The ordered turns already hold the real boundary.
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:multi', nativeId: 'multi' })
  db.upsertDoc({
    ref,
    prompts: ['refactor the parser\nkeep the error messages\nand add a test', 'then ship it'],
    prose: ['on it'],
    files: [],
    truncated: false,
    dialogue: [
      { role: 'user', text: 'refactor the parser\nkeep the error messages\nand add a test' },
      { role: 'assistant', text: 'on it' },
      { role: 'user', text: 'then ship it' },
    ],
  })

  const copied: string[] = []
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    clipboard={{ writeText: async (text: string) => { copied.push(text) } }} {...opts}
  />)
  await tick()
  view.stdin.write('\u0010')
  await tick()

  expect(copied).toEqual(['refactor the parser\nkeep the error messages\nand add a test'])
  view.unmount()
  db.close()
})

test('a session indexed before ordered turns still copies the line it has', async () => {
  // Nothing rewrites an old session until it is hydrated again, so the flat
  // facet stays the only thing there is for it. Falling back to the old
  // behaviour beats announcing that there is no prompt.
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:old', nativeId: 'old' })
  db.upsertDoc({
    ref, prompts: ['an older prompt'], prose: [], files: [], truncated: false,
  })

  const copied: string[] = []
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    clipboard={{ writeText: async (text: string) => { copied.push(text) } }} {...opts}
  />)
  await tick()
  view.stdin.write('\u0010')
  await tick()

  expect(copied).toEqual(['an older prompt'])
  view.unmount()
  db.close()
})

test('the first prompt is the first user turn, not the first turn', async () => {
  // A transcript can open with an assistant turn, and the key is called
  // "prompt" for a reason.
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:assistant-first', nativeId: 'assistant-first' })
  db.upsertDoc({
    ref,
    prompts: ['what I actually asked'],
    prose: ['a greeting nobody asked for'],
    files: [],
    truncated: false,
    dialogue: [
      { role: 'assistant', text: 'a greeting nobody asked for' },
      { role: 'user', text: 'what I actually asked' },
    ],
  })

  const copied: string[] = []
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    clipboard={{ writeText: async (text: string) => { copied.push(text) } }} {...opts}
  />)
  await tick()
  view.stdin.write('\u0010')
  await tick()

  expect(copied).toEqual(['what I actually asked'])
  view.unmount()
  db.close()
})

test('a fresh index does not describe itself as old', async () => {
  // `relTime` answers "now" for anything under a minute, so the age line read
  // "index now old": a contradiction in itself, and the opposite of what the
  // green it is drawn in means. The line only ever appeared once an index was
  // an hour stale, so the phrasing had never met its own fresh case.
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:justnow', nativeId: 'justnow' })
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    indexedAt={NOW - 5_000} {...opts}
  />)
  await tick()
  expect(view.lastFrame()).not.toContain('now old')
  expect(view.lastFrame()).toContain('index just refreshed')
  view.unmount()
  db.close()
})

test('a session that just ended is not described as "now ago"', async () => {
  // The same gluing mistake, one line further down and older than the age
  // indicator: `relTime` names a point in time and the suffix wants a span.
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:fresh', nativeId: 'fresh', endedAt: NOW - 5_000 })
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts}
  />)
  await tick()
  expect(view.lastFrame()).not.toContain('now ago')
  expect(view.lastFrame()).toMatch(/claude\s+now\s/u)
  view.unmount()
  db.close()
})

const sharedAdapters = [buildAdapter(validateManifest({ ...codebuffManifest, roots: ['/nonexistent'] }))]
const both = (command: string) => command === 'codebuff' || command === 'freebuff'

function seedShared(db: IndexDb): void {
  seed(db, { uid: 'codebuff:c1', client: 'codebuff', nativeId: 'c1', tier: 'search', title: 'A shared chat' })
}

test('with both clients installed and no choice saved, Enter asks which one', async () => {
  const db = IndexDb.open(':memory:')
  seedShared(db)
  const saves: Array<[string, string]> = []
  const plans: ExecPlan[] = []
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={sharedAdapters} onExec={(plan) => plans.push(plan)}
      onPath={both} saveLauncher={async (client, name) => { saves.push([client, name]) }} {...opts} />,
  )
  view.stdin.write('\r')
  await tick()
  expect(view.lastFrame()).toContain('Open with')
  view.stdin.write('\t')
  await tick()
  view.stdin.write('\r')
  await tick()
  expect(saves).toEqual([['codebuff', 'freebuff']])
  expect(plans[0]).toMatchObject({ kind: 'resume', cmd: 'freebuff', args: ['--continue', 'c1', '--cwd', '/home/dev/work/proj'] })
  view.unmount()
  db.close()
})

test('a saved choice opens without asking, and the row shows it', async () => {
  const db = IndexDb.open(':memory:')
  seedShared(db)
  const plans: ExecPlan[] = []
  const view = render(
    <App db={db} cfg={{ ...DEFAULT_CONFIG, launchers: { codebuff: 'freebuff' } }} adapters={sharedAdapters}
      onExec={(plan) => plans.push(plan)} onPath={both} saveLauncher={async () => {}} {...opts} />,
  )
  expect(view.lastFrame()).toContain('freebuff')
  view.stdin.write('\r')
  await tick()
  expect(view.lastFrame()).not.toContain('Open with')
  expect(plans[0]?.cmd).toBe('freebuff')
  view.unmount()
  db.close()
})

test('ctrl+l flips the launcher, saves it, and the row label follows', async () => {
  const db = IndexDb.open(':memory:')
  seedShared(db)
  const saves: Array<[string, string]> = []
  const view = render(
    <App db={db} cfg={{ ...DEFAULT_CONFIG, launchers: { codebuff: 'codebuff' } }} adapters={sharedAdapters}
      onExec={() => {}} onPath={both} saveLauncher={async (client, name) => { saves.push([client, name]) }} {...opts} />,
  )
  view.stdin.write('\x0C')
  await tick()
  expect(saves).toEqual([['codebuff', 'freebuff']])
  expect(view.lastFrame()).toContain('freebuff')
  view.unmount()
  db.close()
})

test('with neither client installed, Enter says so instead of launching', async () => {
  const db = IndexDb.open(':memory:')
  seedShared(db)
  const plans: ExecPlan[] = []
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={sharedAdapters} onExec={(plan) => plans.push(plan)}
      onPath={() => false} saveLauncher={async () => {}} {...opts} />,
  )
  view.stdin.write('\r')
  await tick()
  expect(view.lastFrame()).toContain('none of codebuff, freebuff')
  view.stdin.write('\u000b'); await tick()
  view.stdin.write('Resume'); await tick()
  expect(view.lastFrame()).toContain('is on PATH')
  expect(plans).toEqual([])
  view.unmount()
  db.close()
})

test('ctrl+y copies the command of the client the store opens in', async () => {
  const db = IndexDb.open(':memory:')
  seedShared(db)
  const copied: string[] = []
  const view = render(
    <App db={db} cfg={{ ...DEFAULT_CONFIG, launchers: { codebuff: 'freebuff' } }} adapters={sharedAdapters}
      onExec={() => {}} onPath={both} saveLauncher={async () => {}}
      clipboard={{ writeText: async (text) => { copied.push(text) } }} {...opts} />,
  )
  view.stdin.write('')
  await tick()
  expect(copied[0]).toContain('freebuff --continue c1')
  view.unmount()
  db.close()
})


test('ctrl+d cycles activity windows against the injected picker time', async () => {
  const db = IndexDb.open(':memory:')
  const midnight = new Date(NOW)
  midnight.setHours(0, 0, 0, 0)
  const entries = [
    ['today', NOW], ['yesterday', midnight.getTime() - 3_600_000],
    ['week', NOW - 5 * 86_400_000], ['month', NOW - 20 * 86_400_000],
    ['old', NOW - 60 * 86_400_000], ['future', NOW + 1], ['undated', 0],
  ] as const
  for (const [name, endedAt] of entries) {
    seed(db, { uid: `claude:${name}`, nativeId: name, title: `${name} activity`, endedAt })
  }
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    {...opts} rows={30} columns={100}
  />)
  try {
    await tick()
    expect(view.lastFrame()).toContain('7 sessions')
    expect(view.lastFrame()).toContain('F1 Help')
    const windows: readonly [string, readonly string[]][] = [
      ['Today', ['today']], ['Yesterday', ['yesterday']],
      ['Last 7 days', ['today', 'yesterday', 'week']],
      ['Last 30 days', ['today', 'yesterday', 'week', 'month']],
      ['All time', entries.map(([name]) => name)],
    ]
    for (const [label, matching] of windows) {
      view.stdin.write('\u0004')
      await tick()
      const frame = view.lastFrame()!
      if (label !== 'All time') expect(frame).toContain(label)
      else expect(frame.split('\n')[0]).not.toMatch(/Today|Yesterday|Last (?:7|30) days/u)
      expect(frame).toContain(`${matching.length} session${matching.length === 1 ? '' : 's'}`)
      for (const [name] of entries) {
        if (matching.includes(name)) expect(frame).toContain(`${name} activity`)
        else expect(frame).not.toContain(`${name} activity`)
      }
    }
  } finally { view.unmount(); db.close() }
})

test('cycling and clearing time reset selection while keeping query, project and client', async () => {
  // Keep every candidate on the same local day, even where NOW falls at midnight.
  const localNoon = new Date(NOW)
  localNoon.setHours(12, 0, 0, 0)
  const pickerNow = localNoon.getTime()
  for (const clear of [false, true]) {
    const db = IndexDb.open(':memory:')
    seed(db, { uid: 'claude:first', nativeId: 'first', title: 'needle first', endedAt: pickerNow })
    seed(db, { uid: 'claude:second', nativeId: 'second', title: 'needle second', endedAt: pickerNow - 1_000 })
    seed(db, { uid: 'claude:other-text', nativeId: 'other-text', title: 'unrelated title', endedAt: pickerNow - 2_000 })
    seed(db, { uid: 'claude:away', nativeId: 'away', title: 'needle away', cwd: '/other/project', endedAt: pickerNow - 3_000 })
    seed(db, { uid: 'codex:other', client: 'codex', nativeId: 'other', title: 'needle other client', endedAt: pickerNow - 4_000 })
    const plans: ExecPlan[] = []
    const view = render(<App
      db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={(plan) => plans.push(plan)}
      cwd="/unindexed" now={pickerNow} rows={24} columns={100} checkResumePlan={() => ({ ok: true })}
    />)
    try {
      await tick()
      // Make scope an explicit choice rather than relying on its launch default.
      view.stdin.write('\t')
      await tick()
      view.stdin.write('\u0006')
      await tick()
      view.stdin.write('needle')
      await tick()
      if (clear) { view.stdin.write('\u0004'); await tick() }
      view.stdin.write('\u001b[B')
      await tick()
      expect(view.lastFrame()).toMatch(/▌.*needle second/u)
      view.stdin.write(clear ? '\u0015' : '\u0004')
      await tick()
      const frame = view.lastFrame()!
      expect(frame).toContain('▸ needle')
      expect(frame).toContain('proj')
      expect(frame).toContain('claude')
      expect(frame).toContain('2 sessions')
      expect(frame).toMatch(/▌.*needle first/u)
      expect(frame).not.toContain('unrelated title')
      expect(frame).not.toContain('needle away')
      expect(frame).not.toContain('needle other client')
      view.stdin.write('\r')
      await tick()
      expect(plans[0]).toMatchObject({ kind: 'resume', args: ['--resume', 'first'] })
    } finally { view.unmount(); db.close() }
  }
})

test('an empty time window explains ctrl+u and clears without dropping typed text', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:old', nativeId: 'old', title: 'historic needle', endedAt: NOW - 60 * 86_400_000 })
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    {...opts} rows={8} columns={80}
  />)
  try {
    await tick()
    view.stdin.write('needle')
    await tick()
    view.stdin.write('\u0004')
    await tick()
    const empty = view.lastFrame()!
    expect(empty).toContain('0 sessions')
    expect(empty).toContain('Today')
    expect(empty).toContain('No sessions match')
    expect(empty).toContain('ctrl+u')
    expect(empty).toMatch(/clear(?:s)? time/u)
    expect(empty).not.toContain('No sessions indexed')
    expect(empty).not.toContain('nekyia index')
    expect(empty.split('\n').length).toBeLessThanOrEqual(8)
    view.stdin.write('\u0015')
    await tick()
    expect(view.lastFrame()).toContain('historic needle')
    expect(view.lastFrame()).toContain('▸ needle')
    expect(view.lastFrame()!.split('\n')[0]).not.toContain('Today')
  } finally { view.unmount(); db.close() }
})

test('time changes close history and reopen it at the beginning', async () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { title: 'scrollable activity' })
  db.upsertDoc({
    ref, prompts: Array.from({ length: 40 }, (_, i) => `prompt line ${i}`),
    prose: [], files: [], truncated: false,
  })
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    {...opts} rows={30} columns={100}
  />)
  try {
    await tick()
    for (const key of ['\u0004', '\u0015']) {
      view.stdin.write('\u000f')
      await tick()
      for (let i = 0; i < 12; i++) view.stdin.write('\u001b[B')
      await tick()
      expect(view.lastFrame()).not.toContain('prompt line 0')
      view.stdin.write(key)
      await tick()
      expect(view.lastFrame()).not.toContain('History ·')
      expect(view.lastFrame()).toContain('ctrl+k Actions')
      view.stdin.write('\u000f')
      await tick()
      view.stdin.write('\u001b[H'); await tick()
      expect(view.lastFrame()).toContain('prompt line 0')
      view.stdin.write('\u000f')
      await tick()
    }
  } finally { view.unmount(); db.close() }
})

test('active time windows fit short terminals and their shortcuts remain discoverable in Help', async () => {
  const db = IndexDb.open(':memory:')
  for (let i = 0; i < 30; i++) seed(db, { uid: `claude:time-${i}`, nativeId: `time-${i}` })
  for (const rows of [8, 12, 16, 24, 30]) {
    const view = render(<App
      db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
      {...opts} rows={rows} columns={80}
    />)
    try {
      await tick()
      view.stdin.write('\u0004')
      await tick()
      const frame = view.lastFrame()!
      expect(frame).toContain('Today')
      expect(frame).toContain('ctrl+g Filters')
      view.stdin.write('\u001bOP'); await tick()
      view.stdin.write('Ctrl+U'); await tick()
      expect(view.lastFrame()).toMatch(/clear(?:s)? time/u)
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows)
    } finally { view.unmount() }
  }
  db.close()
})

test('ordinary d and u still enter search text', async () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:deploy', nativeId: 'deploy', title: 'deploy change' })
  db.upsertDoc({ ref, prompts: ['d u deploy change'], prose: [], files: [], truncated: false })
  seed(db, { uid: 'claude:parser', nativeId: 'parser', title: 'parser fix' })
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts}
  />)
  try {
    await tick()
    for (const letter of ['d', 'u']) {
      view.stdin.write(letter)
      await tick()
      expect(view.lastFrame()).toContain(`▸ ${letter}`)
      expect(view.lastFrame()).toContain('deploy change')
      expect(view.lastFrame()).not.toContain('parser fix')
      expect(view.lastFrame()).not.toContain('Today')
      view.stdin.write('\u007f')
      await tick()
    }
  } finally { view.unmount(); db.close() }
})


test('one time-filtered session keeps Filters accessible in an eight-row terminal', async () => {
  const db = IndexDb.open(':memory:')
  seed(db)
  const view = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    {...opts} rows={8} columns={80}
  />)
  try {
    await tick()
    view.stdin.write('\u0004')
    await tick()
    expect(view.lastFrame()).toContain('ctrl+g Filters')
    expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(8)
  } finally { view.unmount(); db.close() }
})


test('an active range remains visible beside a long project name at eighty columns', async () => {
  const db = IndexDb.open(':memory:')
  const cwd = `/work/${'a-long-project-name-'.repeat(8)}`
  seed(db, { cwd })
  const props = { db, cfg: DEFAULT_CONFIG, adapters, onExec: () => {}, cwd, now: NOW, rows: 24, columns: 80 }
  const view = render(<App {...props} />)
  // Match Ink's output stream to the actual viewport, rather than its default 100 columns.
  Object.defineProperty(view.stdout, 'columns', { value: 80 })
  view.rerender(<App {...props} />)
  try {
    await tick()
    view.stdin.write('\u0004')
    await tick()
    const frame = view.lastFrame()!
    expect(frame.split('\n')[0]).toContain('Today')
    expect(frame).toContain('ctrl+g Filters')
    for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
  } finally { view.unmount(); db.close() }
})
