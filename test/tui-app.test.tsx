import { expect, spyOn, test } from 'bun:test'
import React from 'react'
import { render } from 'ink-testing-library'
import { DEFAULT_CONFIG } from '../src/config'
import { mountPicker, runPick, type PickDependencies } from '../src/commands/pick'
import { buildAdapter, type Adapter } from '../src/core/adapter'
import { IndexDb } from '../src/core/db'
import { query } from '../src/core/query'
import { validateManifest } from '../src/manifests/load'
import {
  App, fitKeys, indexAgeSeverity, previewLines, safeCommandForClipboard,
  SEVERITY_COLOR, type CommandCopyWork,
} from '../src/tui/App'
import { buildPreviewLines, shareLines } from '../src/tui/Preview'
import {
  createHostClipboard, releaseTerminal, writeTtySequence, type ClipboardRuntime,
} from '../src/tui/clipboard'
import type { Row } from '../src/core/query'
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
    indexedAt: () => undefined,
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
    cwd: () => '/root/proj',
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
    loadConfig: () => DEFAULT_CONFIG,
    buildAdapters: () => ({ adapters, diagnostics: [] }),
    openDb: () => db,
    cwd: () => '/root/proj',
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

test('a failed manual reindex is reported and stops the picker rather than looping silently', async () => {
  const messages: string[] = []
  const db = { close: () => {} } as unknown as IndexDb
  const deps: PickDependencies = {
    isTTY: () => true,
    needsConsent: () => false,
    indexExists: () => true,
    indexPath: () => '/index.db',
    indexedAt: () => undefined,
    loadConfig: () => DEFAULT_CONFIG,
    buildAdapters: () => ({ adapters, diagnostics: [] }),
    openDb: () => db,
    cwd: () => '/root/proj',
    now: () => NOW,
    mount: (props) => ({
      waitUntilExit: async () => { props.onReindex?.() },
      unmount: () => {},
    }),
    checkPlan: () => { throw new Error('nothing was ever selected') },
    runPlan: async () => { throw new Error('nothing was ever selected') },
    ensureIndex: async () => { throw new Error('disk full') },
    error: (value) => { messages.push(value) },
  }
  expect(await runPick(deps)).toBe(1)
  expect(messages).toEqual(['could not refresh the session index: disk full'])
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
  expect(view.lastFrame()!).toContain('Press tab to search everywhere')

  // Once the scope is widened the hint has done its job and gets out of the way.
  view.stdin.write('\t')
  await tick()
  expect(view.lastFrame()!).not.toContain('Press tab to search everywhere')
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
  expect(frame).toContain('enter resume')
  expect(frame).toContain('ctrl+o history')
  for (const glyph of ['⇥', '↵']) expect(frame).not.toContain(glyph)
  // Whatever is shown is shown whole; a hint cut in half helps nobody.
  expect(frame).not.toContain('…')
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
  expect(header()).toContain('2 sessions · proj')

  view.stdin.write('\u0006')
  await tick()
  expect(header()).toContain('1 session · proj · claude')
  view.stdin.write('\u0006')
  await tick()
  expect(header()).toContain('1 session · proj · codex')

  // Three presses is the whole cycle. It used to take seven, five of which
  // filtered to a client this machine has never run.
  view.stdin.write('\u0006')
  await tick()
  expect(header()).toContain('2 sessions · proj')
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
  expect(frame).toContain('esc quit')
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
  // Browsing fits the blocks into a third of the screen, so the tail is unreachable.
  expect(view.lastFrame()!).not.toContain('reply line 90')
  expect(view.lastFrame()!).toContain('ctrl+o history')

  view.stdin.write('\u000f')
  await tick()
  const opened = view.lastFrame()!
  // The footer says what the keys do here, so the mode is never a guess.
  expect(opened).toContain('up/down scroll')
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
  expect(closed).toContain('ctrl+o history')
  expect(closed).toContain('a long session')
  view.unmount()
})

/** The row shape `buildPreviewLines` takes, built from what the index stored. */
function previewRow(db: IndexDb, uid: string): Row {
  return { ...db.getRef(uid)!, score: 0, collapsed: 0 }
}

/** Every dialogue line the history drew, as [speaker, text] pairs. */
function spoken(lines: ReturnType<typeof buildPreviewLines>): Array<[string, string]> {
  return lines
    .filter((line) => line.label === 'asked' || line.label === 'replied')
    .map((line) => [line.label!, line.text])
}

test('the full history reads as a conversation, opening prompt included', () => {
  const db = IndexDb.open(':memory:')
  // The opening prompt is also the title. Browsing drops it as a restatement;
  // a transcript that skipped it would start mid-conversation.
  const ref = seed(db, { uid: 'claude:talk', nativeId: 'talk', title: 'opening question' })
  db.upsertDoc({
    ref,
    prompts: ['opening question', 'follow-up question'],
    prose: ['opening answer', 'follow-up answer'],
    dialogue: [
      { role: 'user', text: 'opening question' },
      { role: 'assistant', text: 'opening answer' },
      { role: 'user', text: 'follow-up question' },
      { role: 'assistant', text: 'follow-up answer' },
    ],
    files: ['src/a.ts'],
    truncated: false,
  })

  const lines = buildPreviewLines(db, previewRow(db, ref.uid), { full: true, maxLines: 200 })
  expect(spoken(lines)).toEqual([
    ['asked', 'opening question'],
    ['replied', 'opening answer'],
    ['asked', 'follow-up question'],
    ['replied', 'follow-up answer'],
  ])
  // Replies stay dimmed, and the files a session touched still close it out.
  expect(lines.find((line) => line.label === 'replied')?.dim).toBe(true)
  expect(lines.filter((line) => line.label === 'touched').map((line) => line.text))
    .toEqual(['src/a.ts'])

  // Browsing keeps the grouped blocks: all prompts, then all replies.
  const browsing = buildPreviewLines(db, previewRow(db, ref.uid), { maxLines: 12 })
  expect(spoken(browsing)).toEqual([
    ['asked', 'follow-up question'],
    ['replied', 'opening answer'],
  ])
  db.close()
})

test('inspecting shows file operations in the order they happened', () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:ops', nativeId: 'ops', title: 'fix the sse race' })
  db.upsertDoc({
    ref,
    prompts: ['fix the sse race'],
    prose: ['done'],
    dialogue: [
      { role: 'user', text: 'fix the sse race' },
      { role: 'assistant', text: 'done' },
    ],
    files: ['src/sse.ts'],
    fileDetail: 'ordered',
    fileEvents: [
      { path: 'src/sse.ts', kind: 'read', turn: 1 },
      { path: 'src/sse.ts', kind: 'edit', turn: 3 },
    ],
    truncated: false,
  })
  const lines = buildPreviewLines(db, previewRow(db, ref.uid), { full: true, maxLines: 200 })
  const touched = lines.filter((line) => line.text.includes('src/sse.ts'))
  expect(touched.map((line) => line.text)).toEqual([
    'read    src/sse.ts',
    'edit    src/sse.ts',
  ])
  db.close()
})
test('browsing keeps the alphabetical file list it always had', () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:browse', nativeId: 'browse', title: 'a session' })
  db.upsertDoc({
    ref,
    prompts: ['a session'],
    prose: ['done'],
    files: ['b.ts', 'a.ts'],
    fileDetail: 'ordered',
    fileEvents: [
      { path: 'b.ts', kind: 'edit', turn: 0 },
      { path: 'a.ts', kind: 'read', turn: 1 },
    ],
    truncated: false,
  })
  const lines = buildPreviewLines(db, previewRow(db, ref.uid), { maxLines: 12 })
  expect(lines.some((line) => line.text === 'a.ts')).toBe(true)
  expect(lines.some((line) => line.text.includes('read'))).toBe(false)
  db.close()
})

test('a session indexed before ordered turns falls back to the grouped history', () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:old', nativeId: 'old', title: 'an older session' })
  db.upsertDoc({
    ref,
    prompts: ['first question', 'second question'],
    prose: ['first answer', 'second answer'],
    files: [],
    truncated: false,
  })
  expect(db.raw().query('SELECT * FROM session_turn').all()).toEqual([])

  const lines = buildPreviewLines(db, previewRow(db, ref.uid), { full: true, maxLines: 200 })
  // Grouped, not chronological: exactly what the fallback promises until the
  // session is hydrated again.
  expect(spoken(lines)).toEqual([
    ['asked', 'first question'],
    ['replied', 'first answer'],
  ])
  expect(lines.map((line) => line.text)).toContain('second question')
  expect(lines.every((line) => line.text !== 'history display capped; indexed dialogue continues'))
    .toBe(true)
  db.close()
})

test('the full history wraps a long reply instead of dropping its tail', () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:wide', nativeId: 'wide', title: 'long dialogue' })
  const answer = `${'abcdefghij '.repeat(40)}visible tail`
  db.upsertDoc({
    ref,
    prompts: ['long dialogue'],
    prose: [answer],
    dialogue: [
      { role: 'user', text: 'long dialogue' },
      { role: 'assistant', text: answer },
    ],
    files: [],
    truncated: false,
  })

  const lines = buildPreviewLines(db, previewRow(db, ref.uid), {
    columns: 40, full: true, maxLines: 500,
  })
  const start = lines.findIndex((line) => line.label === 'replied')
  const reply = lines.slice(start).map((line) => line.text)
  expect(reply.length).toBeGreaterThan(1)
  expect(reply.every((line) => Bun.stringWidth(line) <= 40 - 9)).toBe(true)
  expect(reply.join('')).toBe(answer)
  db.close()
})

test('the full history stops at its character budget and says that it did', () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:huge', nativeId: 'huge', title: 'a huge session' })
  // Three turns of 500,000 characters: the first two fit inside the 1 MiB
  // budget, the third is cut to what is left of it, and a fourth never starts.
  const block = (mark: string) => mark.repeat(500_000)
  db.upsertDoc({
    ref,
    prompts: [],
    prose: [],
    dialogue: [
      { role: 'user', text: block('a') },
      { role: 'assistant', text: block('b') },
      { role: 'user', text: block('c') },
      { role: 'assistant', text: 'never reached' },
    ],
    files: [],
    truncated: false,
  })

  const lines = buildPreviewLines(db, previewRow(db, ref.uid), {
    columns: 521, full: true, maxLines: 10_000,
  })
  const shown = lines.filter((line) => line.label !== undefined).map((line) => line.text).join('')
  expect(shown.length).toBe(1_048_576)
  expect(shown.split('a').length - 1).toBe(500_000)
  expect(shown.split('b').length - 1).toBe(500_000)
  expect(shown.split('c').length - 1).toBe(48_576)
  expect(shown).not.toContain('never reached')
  expect(lines.map((line) => line.text))
    .toContain('history display capped; indexed dialogue continues')
  db.close()
})

test('the full history stops at its turn budget and says that it did', () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:many', nativeId: 'many', title: 'a chatty session' })
  db.upsertDoc({
    ref,
    prompts: [],
    prose: [],
    dialogue: Array.from({ length: 4_100 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      text: `turn ${index}`,
    })),
    files: [],
    truncated: false,
  })

  const lines = buildPreviewLines(db, previewRow(db, ref.uid), { full: true, maxLines: 10_000 })
  const said = spoken(lines)
  expect(said.length).toBe(4_096)
  expect(said[0]).toEqual(['asked', 'turn 0'])
  expect(said.at(-1)).toEqual(['replied', 'turn 4095'])
  expect(lines.map((line) => line.text))
    .toContain('history display capped; indexed dialogue continues')
  db.close()
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
  expect(view.lastFrame()!).toContain('a short session')
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

test('reindex is only offered once the index has actually gone stale', async () => {
  const db = IndexDb.open(':memory:')
  seed(db, { uid: 'claude:a', nativeId: 'a' })
  const fresh = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    indexedAt={NOW - 60_000} {...opts}
  />)
  await tick()
  expect(fresh.lastFrame()).not.toContain('reindex')
  fresh.unmount()

  const unknown = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} />)
  await tick()
  expect(unknown.lastFrame()).not.toContain('reindex')
  unknown.unmount()

  const stale = render(<App
    db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
    indexedAt={NOW - 7 * 3_600_000} {...opts} columns={100}
  />)
  await tick()
  expect(stale.lastFrame()).toContain('ctrl+r')
  expect(stale.lastFrame()).toContain('reindex')
  stale.unmount()
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

test('ctrl+r does nothing when the index is fresh and no offer is shown', async () => {
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
  expect(requested).toBe(0)
  view.unmount()
  db.close()
})

/**
 * A runPick dependency set that reaches the launch, with every failure path
 * closed off. Each test opens exactly one of them, so a failure it did not ask
 * for shows up as a thrown error rather than a silently different exit code.
 */
function launchingDeps(overrides: Partial<PickDependencies> = {}): PickDependencies {
  const plan: ExecPlan = { kind: 'resume', cmd: 'claude', args: ['--resume', 'a'], cwd: '/root/proj' }
  return {
    isTTY: () => true,
    needsConsent: () => false,
    indexExists: () => true,
    indexPath: () => '/index.db',
    indexedAt: () => undefined,
    loadConfig: () => DEFAULT_CONFIG,
    buildAdapters: () => ({ adapters, diagnostics: [] }),
    openDb: () => ({ close: () => {} }) as unknown as IndexDb,
    cwd: () => '/root/proj',
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
    checkPlan: () => ({ ok: false, reason: 'the directory /root/proj no longer exists' }),
    runPlan: async () => { throw new Error('must not launch a rejected plan') },
    error: (text) => { errors.push(text) },
  }))

  expect(code).toBe(1)
  expect(errors).toEqual(['the directory /root/proj no longer exists'])
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

test('tab, backspace and delete leave the reader instead of moving the ground under it', async () => {
  const db = IndexDb.open(':memory:')
  const ref = seed(db, { uid: 'claude:aa', nativeId: 'aa', title: 'reconnect work' })
  db.upsertDoc({
    ref,
    prompts: Array.from({ length: 40 }, (_, i) => `prompt line ${i}`),
    prose: [], files: [], truncated: false,
  })
  seed(db, { uid: 'claude:zz', nativeId: 'zz', cwd: '/somewhere/else', title: 'far away work' })

  // Ink blanks `input` for all three keys, so the printable-key guard cannot
  // see them: each one used to change the list while the reader stayed open on
  // a different session at the offset it had been left at.
  for (const key of ['\t', '\u007f', '\u001b[3~']) {
    const view = render(
      <App db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}} {...opts} rows={30} />,
    )
    await tick()
    view.stdin.write('\u000f')
    await tick()
    for (let i = 0; i < 8; i++) view.stdin.write('\u001b[B')
    await tick()
    expect(view.lastFrame()!).toContain('up/down scroll')

    view.stdin.write(key)
    await tick()
    const frame = view.lastFrame()!
    expect(frame).not.toContain('up/down scroll')
    expect(frame).toContain('ctrl+o history')
    // The reader reopens at the top rather than at the offset it was left at.
    view.stdin.write('\u000f')
    await tick()
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
  expect(previewOf(view.lastFrame()!)).toContain('a scrollable session')

  for (let i = 0; i < 60; i++) view.stdin.write('\u001b[B')
  await tick()
  expect(previewOf(view.lastFrame()!)).not.toContain('a scrollable session')

  // Forty presses back is further than the pane can have travelled, so the top
  // must be back. It was not: the down presses banked invisible scroll debt
  // that the up presses paid off before the pane moved a single line.
  for (let i = 0; i < 40; i++) view.stdin.write('\u001b[A')
  await tick()
  expect(previewOf(view.lastFrame()!)).toContain('a scrollable session')
  view.unmount()
  db.close()
})

test('a short terminal spends its rows on the list rather than on decoration', async () => {
  const db = IndexDb.open(':memory:')
  for (let i = 0; i < 12; i++) {
    const ref = seed(db, { uid: `claude:${i}`, nativeId: String(i), title: `session number ${i}` })
    db.upsertDoc({ ref, prompts: [`prompt ${i}`], prose: [`reply ${i}`], files: [], truncated: false })
  }

  // Eleven rows of fixed chrome left every one of these heights with a single
  // usable list row. The preview is kept at all of them; the spacer rows and
  // the rule are what get handed back.
  const expected: Record<number, number> = { 8: 1, 10: 2, 12: 4, 14: 6, 20: 7 }
  for (const rows of [8, 10, 12, 14, 20]) {
    const view = render(<App
      db={db} cfg={DEFAULT_CONFIG} adapters={adapters} onExec={() => {}}
      {...opts} rows={rows} columns={100}
    />)
    await tick()
    const frame = view.lastFrame()!
    expect(listRowsOf(frame)).toBe(expected[rows]!)
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows)
    // Whatever else is dropped, the preview stays: this line is drawn nowhere
    // but the pane under the list.
    expect(frame).toContain('/root/proj · main · now ago')
    // The rule is decoration, so it is the first thing a short terminal loses.
    const hasRule = frame.split('\n').some((line) => /^─+$/u.test(line.trim()))
    expect(hasRule).toBe(rows >= 16)
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
  expect(frame).toContain('source transcript no longer on disk')
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
  expect(frame).not.toContain('up/down scroll')
  expect(frame).toContain('esc quit')
  expect(frame).toContain('No sessions indexed yet')
  view.unmount()
  db.close()
})

test('the preview head uses the whole pane, not the width the label gutter costs', () => {
  const db = IndexDb.open(':memory:')
  seed(db, {
    uid: 'claude:wide', nativeId: 'wide',
    cwd: '/root/a-project-directory-with-a-name-long-enough-to-fill-the-pane',
  })
  const row = query(db, DEFAULT_CONFIG, { limit: 1, now: NOW })[0]!
  const lines = buildPreviewLines(db, row, { columns: 40, maxLines: 12, now: NOW })
  const meta = lines[1]!
  // Nothing draws a gutter for a head line, so charging it for one left the
  // line cut nine columns short with nine columns of pane sitting empty.
  expect(meta.label).toBeUndefined()
  expect(Bun.stringWidth(meta.text)).toBe(40)
  // Block bodies do hang off the gutter and still pay for it.
  const body = lines.find((line) => line.label !== undefined && line.text)!
  expect(Bun.stringWidth(body.text)).toBeLessThanOrEqual(40 - 9)
  db.close()
})

test('runPick settles a copy still in flight before the client takes the terminal', async () => {
  const events: string[] = []
  let finishCopy = () => {}
  const copy = new Promise<void>((resolve) => {
    finishCopy = () => { events.push('copied'); resolve() }
  })
  const plan: ExecPlan = { kind: 'resume', cmd: 'claude', args: ['--resume', 'a'], cwd: '/root/proj' }
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
        { kind: 'resume', cmd: 'claude', args: ['--resume', 'a'], cwd: '/root/proj' },
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
