import { expect, test } from 'bun:test'
import React from 'react'
import { render } from 'ink-testing-library'
import { DEFAULT_CONFIG } from '../src/config'
import { mountPicker, runPick, type PickDependencies } from '../src/commands/pick'
import { buildAdapter, type Adapter } from '../src/core/adapter'
import { IndexDb } from '../src/core/db'
import { validateManifest } from '../src/manifests/load'
import { App, previewLines, safeCommandForClipboard, type CommandCopyWork } from '../src/tui/App'
import { shareLines } from '../src/tui/Preview'
import { createHostClipboard, type ClipboardRuntime } from '../src/tui/clipboard'
import type { ExecPlan, SessionRef } from '../src/types'

const NOW = 1_800_000_000_000

function seed(db: IndexDb, over: Partial<SessionRef> = {}): SessionRef {
  const ref: SessionRef = {
    uid: 'claude:a', client: 'claude', nativeId: 'a', cwd: '/root/proj', gitBranch: 'main',
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

const opts = { cwd: '/root/proj', now: NOW }
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
    files: Array.from({ length: 6 }, (_, i) => `/root/proj/src/deeply/nested/module/file-${i}.ts`),
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

test('the preview sits under the list at every width', async () => {
  const db = IndexDb.open(':memory:')
  for (let i = 0; i < 30; i++) seed(db, { uid: `claude:${i}`, nativeId: String(i) })

  for (const columns of [80, 132, 220]) {
    const view = render(
      <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={30} columns={columns} />,
    )
    await tick()
    const lines = view.lastFrame()!.split('\n')
    // A row sharing its line with a vertical rule would mean a split pane.
    // The gutter itself is a │ now, so a split pane shows as a rule further in.
    expect(lines.filter((line) => /^[▌│]\s*claude/.test(line) && line.slice(2).includes('│')).length)
      .toBe(0)
    // The rule that separates list from preview runs across the frame.
    expect(lines.some((line) => /^─+$/u.test(line.trim()) && line.trim().length > 20)).toBe(true)
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
  expect(frame.indexOf('src/sse.ts')).toBeLessThan(frame.indexOf('src/z.ts'))
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
  expect(view.lastFrame()).toContain('this directory · claude')
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
      plan: () => ({ kind: wrongKind, cmd: 'claude', args: [], cwd: '/root/proj' }),
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
    { kind: 'resume', cmd: 'claude\u001b[31m', args: ['--resume', 'a'], cwd: '/root/proj' },
    { kind: 'resume', cmd: 'claude', args: ['--resume', 'id\nnext'], cwd: '/root/proj' },
    { kind: 'resume', cmd: 'claude', args: ['--resume', 'a'], cwd: '/root/\u202eevil' },
    { kind: 'resume', cmd: 'claude', args: ['x'.repeat(20_000)], cwd: '/root/proj' },
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
    { kind: 'resume', cmd: 'claude', args: ['--resume', huge], cwd: '/root/proj' },
    { kind: 'resume', cmd: 'claude', args: [], cwd: `/root/${huge}` },
    { kind: 'resume', cmd: 'claude', args: ['--flag', huge], cwd: '/root/proj' },
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

test('production picker mount enables Ink alternate-screen ownership', () => {
  let options: unknown
  const fakeRender = ((_node: React.ReactNode, value: unknown) => {
    options = value
    return { waitUntilExit: async () => {}, unmount: () => {} }
  }) as never
  mountPicker({} as never, fakeRender)
  expect(options).toEqual({ alternateScreen: true })
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
    title: `start\n\u001b[31m${'x'.repeat(2_000_000)}tail`,
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
  expect(frame).not.toContain('tail')
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
  const plan: ExecPlan = { kind: 'resume', cmd: 'claude', args: ['--resume', 'a'], cwd: '/root/proj' }
  const db = {
    close: () => { events.push('close') },
  } as unknown as IndexDb
  const deps: PickDependencies = {
    isTTY: () => true,
    needsConsent: () => false,
    indexExists: () => true,
    indexPath: () => '/index.db',
    loadConfig: () => DEFAULT_CONFIG,
    buildAdapters: () => ({ adapters, diagnostics: [] }),
    openDb: () => db,
    cwd: () => '/root/proj',
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
      props.onExec({ kind: 'resume', cmd: 'claude', args: [], cwd: '/root/proj' })
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

test('a directory with nothing in it points at the key that widens the search', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:only', nativeId: 'only' })
  const view = render(
    <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={24} />,
  )
  await tick()
  expect(view.lastFrame()!).toContain('Press tab to search every directory')

  // Once the scope is widened the hint has done its job and gets out of the way.
  view.stdin.write('\t')
  await tick()
  expect(view.lastFrame()!).not.toContain('Press tab to search every directory')
  view.unmount()
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
  expect(frame).toContain('tab scope')
  expect(frame).toContain('enter resume')
  expect(frame).toContain('esc quit')
  for (const glyph of ['⇥', '↵']) expect(frame).not.toContain(glyph)
  view.unmount()
})
