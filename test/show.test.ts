import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runShow } from '../src/commands/show'

const restore: (() => void)[] = []

afterEach(() => {
  for (const undo of restore.splice(0)) undo()
})

/**
 * Capture what runShow writes to stderr.
 *
 * The CLI tests already cover these inputs end to end, but they assert only
 * that some line starting "error:" appeared. That passes even when a guard is
 * deleted, because the next guard down reports something too. Pinning the exact
 * message is what makes each guard individually observable.
 */
function captureErrors(): string[] {
  const lines: string[] = []
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  restore.push(() => spy.mockRestore())
  return lines
}

test('show asks for a uid when none is given', async () => {
  const errors = captureErrors()
  expect(await runShow({})).toBe(2)
  expect(errors).toEqual(['usage: nekyia show <uid>'])
})

test('show names control characters as the reason it refused a uid', async () => {
  const errors = captureErrors()
  // Refused before parsing: a uid carrying an escape sequence would otherwise
  // be echoed back into the terminal by the malformed-uid message below.
  expect(await runShow({ uid: 'claude:bad\u001b[2J' })).toBe(2)
  expect(errors).toEqual(['error: uid must not contain control characters'])
})

test('show names a malformed uid, and quotes back the value it rejected', async () => {
  const errors = captureErrors()
  expect(await runShow({ uid: 'no-separator' })).toBe(2)
  expect(errors).toEqual(['error: malformed uid: no-separator'])
})

test('show rejects a uid with an empty half rather than treating it as absent', async () => {
  for (const uid of [':empty-client', 'empty-native:']) {
    const errors = captureErrors()
    expect(await runShow({ uid })).toBe(2)
    expect(errors).toEqual([`error: malformed uid: ${uid}`])
  }
})

test('show names the budget as the reason it refused, not the uid', async () => {
  for (const maxChars of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const errors = captureErrors()
    expect(await runShow({ uid: 'claude:a', maxChars })).toBe(2)
    expect(errors).toEqual(['error: --max-chars must be a non-negative integer'])
  }
})

test('show accepts a budget of zero, which is the boundary of non-negative', async () => {
  // Zero is valid and sits exactly on the guard's edge: `< 0` and `<= 0` differ
  // only here, so without this case the comparison can drift unnoticed.
  const previous = process.env.XDG_DATA_HOME
  const empty = mkdtempSync(join(tmpdir(), 'nekyia-show-'))
  process.env.XDG_DATA_HOME = empty
  restore.push(() => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous
    rmSync(empty, { recursive: true, force: true })
  })

  const errors = captureErrors()
  // It gets past the budget guard and stops at the missing index instead.
  expect(await runShow({ uid: 'claude:a', maxChars: 0 })).toBe(1)
  expect(errors.join(' ')).not.toContain('--max-chars')
})
