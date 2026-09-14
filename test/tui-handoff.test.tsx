import { afterEach, expect, test } from 'bun:test'
import React from 'react'
import { cleanup, render } from 'ink-testing-library'
import { DEFAULT_CONFIG } from '../src/config'
import { buildAdapter, type Adapter } from '../src/core/adapter'
import { IndexDb } from '../src/core/db'
import { validateManifest } from '../src/manifests/load'
import { App } from '../src/tui/App'
import type { ExecPlan, SessionRef } from '../src/types'

const databases: IndexDb[] = []
afterEach(() => { cleanup(); for (const db of databases.splice(0)) db.close() })
const tick = () => new Promise((resolve) => setTimeout(resolve, 35))
const opts = { cwd: '/root/proj', now: 1800000000000, clipboard: null }
const available = () => ({ ok: true })

function adapter(id: string, brief = true): Adapter {
  return buildAdapter(validateManifest({
    schema: 1, id, name: id, roots: ['/nonexistent'], format: 'jsonl-transcript', tier: 'resume',
    jsonl: { glob: '*.jsonl', variant: 'claude' },
    resume: { cmd: id, args: ['resume', '{id}'], cwd: '{cwd}' },
    ...(brief ? { brief: { cmd: id, args: ['{prompt}'], cwd: '{cwd}' } } : {}),
  }))
}

function seed(hydrated = true) {
  const db = IndexDb.open(':memory:')
  databases.push(db)
  const ref: SessionRef = {
    uid: 'claude:a', client: 'claude', nativeId: 'a', cwd: opts.cwd, gitBranch: 'main',
    title: 'Fix reconnect', startedAt: 0, endedAt: opts.now, turns: 2,
    parentNativeId: null, tier: 'resume', origin: 'manifest', sourcePaths: [], fingerprint: 'f',
  }
  db.upsertRef(ref)
  if (hydrated) db.upsertDoc({ ref, prompts: ['fix reconnect'], prose: [], files: [], truncated: false })
  return db
}

test('ctrl+t chooses another client, confirms the data flow, and emits exactly one fresh plan', async () => {
  const db = seed()
  const plans: ExecPlan[] = []
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[adapter('claude'), adapter('codex'), adapter('kilo')]}
    checkHandoffPlan={available} onExec={(plan) => plans.push(plan)} {...opts} />)
  await tick()
  expect(view.lastFrame()).toContain('ctrl+t')
  view.stdin.write('\u0014')
  await tick()
  expect(view.lastFrame()).toContain('Hand off')
  expect(view.lastFrame()).not.toContain('claude')
  view.stdin.write('\u001b[B')
  await tick()
  expect(view.lastFrame()).toContain('▸ kilo')
  view.stdin.write('\u001b[A')
  await tick()
  view.stdin.write('\r')
  await tick()
  const frame = view.lastFrame()!
  expect(frame).toContain('new session in codex')
  expect(frame.replace(/\s+/gu, ' ')).toContain('selected claude session')
  expect(frame).toContain('configured model provider')
  expect(frame).not.toContain('cannot resume')
  expect(plans).toEqual([])
  view.stdin.write('\r')
  await tick()
  view.stdin.write('\r')
  await tick()
  expect(plans).toHaveLength(1)
  expect(plans[0]).toMatchObject({ kind: 'brief', cmd: 'codex', cwd: opts.cwd })
  expect(plans[0]!.prompt).toContain('fix reconnect')
})

test('escape cancels confirmation to the selected target and then returns to the original query', async () => {
  const db = seed()
  const plans: ExecPlan[] = []
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[adapter('claude'), adapter('codex')]}
    checkHandoffPlan={available} onExec={(plan) => plans.push(plan)} {...opts} />)
  view.stdin.write('reconnect')
  await tick()
  view.stdin.write('\u0014')
  await tick()
  view.stdin.write('ignored search text')
  await tick()
  view.stdin.write('\r')
  await tick()
  view.stdin.write('\u001b')
  await tick()
  expect(view.lastFrame()).toContain('▸ codex')
  view.stdin.write('\u001b')
  await tick()
  expect(view.lastFrame()).toContain('▸ reconnect')
  expect(view.lastFrame()).not.toContain('ignored search text')
  expect(plans).toEqual([])
})

test('picker excludes clients without brief templates and does not require existing history', async () => {
  const db = seed()
  const target = adapter('codex')
  expect(target.detect()).toBe(false)
  const view = render(<App db={db} cfg={DEFAULT_CONFIG}
    adapters={[adapter('claude'), adapter('no-brief', false), target]}
    checkHandoffPlan={available} onExec={() => {}} {...opts} />)
  view.stdin.write('\u0014')
  await tick()
  expect(view.lastFrame()).toContain('codex')
  expect(view.lastFrame()).not.toContain('no-brief')
  view.unmount()
  const single = render(<App db={db} cfg={DEFAULT_CONFIG}
    adapters={[adapter('claude'), adapter('no-brief', false)]} onExec={() => {}} {...opts} />)
  single.stdin.write('\u0014')
  await tick()
  expect(single.lastFrame()).toContain('no other client available')
  expect(single.lastFrame()).not.toContain('Hand off')
})

test('missing executable leaves the target picker open so another client can be selected', async () => {
  const db = seed()
  const view = render(<App db={db} cfg={DEFAULT_CONFIG}
    adapters={[adapter('claude'), adapter('missing'), adapter('codex')]}
    checkHandoffPlan={(plan) => plan.cmd === 'missing'
      ? { ok: false, reason: 'missing was not found or is not executable' } : { ok: true }}
    onExec={() => {}} {...opts} />)
  view.stdin.write('\u0014')
  await tick()
  view.stdin.write('\r')
  await tick()
  expect(view.lastFrame()).toContain('▸ missing')
  expect(view.lastFrame()).toContain('not found or is not executable')
  view.stdin.write('\u001b[B')
  await tick()
  view.stdin.write('\r')
  await tick()
  expect(view.lastFrame()).toContain('new session in codex')
})

test('planning exceptions, missing indexed content, and validation exceptions are recoverable', async () => {
  for (const failure of ['plan', 'content', 'check']) {
    const db = seed(failure !== 'content')
    const target = adapter('codex')
    if (failure === 'plan') target.plan = () => { throw new Error('bad plan') }
    const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[adapter('claude'), target]}
      checkHandoffPlan={() => { if (failure === 'check') throw new Error('bad check'); return { ok: true } }}
      onExec={() => { throw new Error('must not launch') }} {...opts} />)
    view.stdin.write('\u0014')
    await tick()
    view.stdin.write('\r')
    await tick()
    expect(view.lastFrame()).toContain('Hand off')
    expect(view.lastFrame()).toContain(failure === 'content' ? 'nothing indexed' : 'could not plan this handoff')
    view.unmount()
  }
})

test('many target names are sanitized and windowed to fit a small terminal', async () => {
  const db = seed()
  const targets = Array.from({ length: 30 }, (_, i) => {
    const target = adapter(`target-${i}`)
    target.manifest.name = `target-${i}\u001b[2J\u202e${'x'.repeat(2000)}`
    return target
  })
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[adapter('claude'), ...targets]}
    onExec={() => {}} {...opts} rows={8} columns={45} />)
  view.stdin.write('\u0014')
  await tick()
  view.stdin.write('\u001b[A')
  await tick()
  const frame = view.lastFrame()!
  expect(frame).toContain('▸ target-29')
  expect(frame).not.toContain('\u202e')
  expect(frame.split('\n').length).toBeLessThanOrEqual(8)
  expect(frame).not.toContain('target-0')
})

test('ctrl+t on an empty list is a no-op and ordinary t still searches', async () => {
  const db = IndexDb.open(':memory:')
  databases.push(db)
  const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[adapter('claude'), adapter('codex')]}
    onExec={() => {}} {...opts} />)
  view.stdin.write('\u0014')
  await tick()
  expect(view.lastFrame()).not.toContain('Hand off')
  view.stdin.write('t')
  await tick()
  expect(view.lastFrame()).toContain('▸ t')
})

test('compact confirmations keep every line readable by scrolling, with launch and cancel hints fixed', async () => {
  const directory = '/Users/jellestoel/repos/a-very-long-project-directory-name/packages/some-long-package-name'
  for (const [columns, rows] of [[45, 8], [45, 12], [80, 8]]) {
    const db = seed()
    db.raw().run('UPDATE session SET cwd = ? WHERE uid = ?', [directory, 'claude:a'])
    const plans: ExecPlan[] = []
    const view = render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[adapter('claude'), adapter('codex')]}
      checkHandoffPlan={available} onExec={(plan) => plans.push(plan)} {...opts}
      cwd={directory} columns={columns} rows={rows} />)
    view.stdin.write('\u0014')
    await tick()
    view.stdin.write('\r')
    await tick()

    const bodyOf = (frame: string) => {
      const lines = frame.split('\n').map((line) => line.trim())
      expect(lines.length).toBeLessThanOrEqual(rows!)
      for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns!)
      expect(frame).toContain('enter')
      expect(frame).toContain('esc')
      const footer = lines.findIndex((line) => line === 'up/down scroll' || line === 'enter continue, esc back')
      expect(footer).toBeGreaterThan(0)
      return lines.slice(0, footer)
    }
    let previous = view.lastFrame()!
    const seen = bodyOf(previous)
    expect(seen[0]).toBe('Start a new briefed session')
    const scrollable = previous.includes('up/down scroll')
    let bottom = !scrollable
    for (let step = 0; scrollable && step < 40; step++) {
      view.stdin.write('\u001b[B')
      await tick()
      const frame = view.lastFrame()!
      const body = bodyOf(frame)
      if (frame === previous) { bottom = true; break }
      seen.push(body.at(-1)!)
      previous = frame
    }
    expect(bottom).toBe(true)
    const readable = seen.join('').replace(/\s/gu, '')
    for (const text of [
      'Start a new briefed session', `codex in ${directory}`,
      'Start a new session in codex', 'selected claude session',
      'It carries no tool state or file snapshots, and it costs tokens.',
      'The target client may send this context to its configured model provider.',
    ]) expect(readable).toContain(text.replace(/\s/gu, ''))
    expect(plans).toEqual([])
    if (scrollable) {
      view.stdin.write('\u001b[A')
      await tick()
      expect(view.lastFrame()).not.toBe(previous)
    }
    view.stdin.write('\u001b')
    await tick()
    expect(view.lastFrame()).toContain('Hand off')
    view.stdin.write('\r')
    await tick()
    expect(bodyOf(view.lastFrame()!)[0]).toBe('Start a new briefed session')
    view.stdin.write('\r')
    await tick()
    expect(plans).toHaveLength(1)
    expect(plans[0]!.cwd).toBe(directory)
    view.unmount()
  }
})

test('at the smallest heights the footer drops the scroll hint before it drops enter/esc', async () => {
  const db = seed()
  const targets = [adapter('claude'), adapter('codex')]
  const onExec = () => {}
  const props = { db, cfg: DEFAULT_CONFIG, adapters: targets, checkHandoffPlan: available, onExec, ...opts }
  const view = render(<App {...props} rows={24} columns={45} />)
  view.stdin.write('')
  await tick()
  view.stdin.write('\r')
  await tick()

  // Shrink one row at a time: once scrolling is needed, "enter"/"esc" must
  // survive every height down to the floor, even as the scroll hint itself
  // is sacrificed first. Regression test for the CodeRabbit-flagged bug
  // where slice(0, rows - 1) dropped the action line before the hint.
  for (let rows = 24; rows >= 2; rows--) {
    view.rerender(<App {...props} rows={rows} columns={45} />)
    await tick()
    const frame = view.lastFrame()!
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows)
    expect(frame).toContain('enter')
    expect(frame).toContain('esc')
  }
})

test('confirmation paging and resize preserve readable content and reset the scroll bound', async () => {
  const db = seed()
  const targets = [adapter('claude'), adapter('codex')]
  const onExec = () => {}
  const props = { db, cfg: DEFAULT_CONFIG, adapters: targets, checkHandoffPlan: available, onExec, ...opts }
  const view = render(<App {...props} rows={8} columns={45} />)
  view.stdin.write('\u0014')
  await tick()
  view.stdin.write('\r')
  await tick()
  const first = view.lastFrame()!
  expect(first).toContain('up/down scroll')
  view.stdin.write('\u001b[6~')
  await tick()
  expect(view.lastFrame()).not.toBe(first)
  expect(view.lastFrame()).toContain('configured model provider.')
  view.stdin.write('\u001b[5~')
  await tick()
  expect(view.lastFrame()).toBe(first)
  view.stdin.write('\u001b[6~')
  await tick()
  view.rerender(<App {...props} rows={24} columns={80} />)
  await tick()
  const expanded = view.lastFrame()!
  expect(expanded).toContain('Start a new briefed session')
  expect(expanded).toContain('The target client may send this context to its configured model provider.')
  expect(expanded).not.toContain('up/down scroll')
  view.rerender(<App {...props} rows={8} columns={45} />)
  await tick()
  expect(view.lastFrame()).toBe(first)
})
