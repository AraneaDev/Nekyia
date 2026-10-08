import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadBookmarks, removeBookmark, setBookmark } from '../src/core/ui-state'

let tmp: string
let dir: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nekyia-bookmarks-')))
  dir = join(tmp, 'private')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

test('missing bookmarks are empty, writable and do not create files', () => {
  expect(loadBookmarks(dir)).toEqual({ state: { version: 1, uids: [] }, warning: null, writable: true })
  expect(() => statSync(dir)).toThrow()
})

test('bookmarks round trip UIDs alone and remain until explicitly removed', async () => {
  await setBookmark(dir, 'session-a', true)
  await setBookmark(dir, 'session-a', true)
  await setBookmark(dir, 'stale-session', true)
  expect(loadBookmarks(dir).state).toEqual({ version: 1, uids: ['session-a', 'stale-session'] })
  expect(JSON.parse(readFileSync(join(dir, 'ui-state.json'), 'utf8'))).toEqual({ version: 1, uids: ['session-a', 'stale-session'] })
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(statSync(join(dir, 'ui-state.json')).mode & 0o777).toBe(0o600)
  await setBookmark(dir, 'session-a', false)
  expect((await removeBookmark(dir, 'stale-session')).uids).toEqual([])
})

test('duplicate stored UIDs count once toward capacity', async () => {
  mkdirSync(dir)
  writeFileSync(join(dir, 'ui-state.json'), JSON.stringify({ version: 1, uids: Array(300).fill('a') }))
  expect(loadBookmarks(dir).state.uids).toEqual(['a'])
  await setBookmark(dir, 'b', true)
  expect(loadBookmarks(dir).state.uids).toEqual(['a', 'b'])
})

test('capacity failures preserve disk contents and existing bookmark toggles work', async () => {
  mkdirSync(dir)
  writeFileSync(join(dir, 'ui-state.json'), JSON.stringify({ version: 1, uids: Array.from({ length: 256 }, (_, i) => `uid-${i}`) }))
  const before = readFileSync(join(dir, 'ui-state.json'), 'utf8')
  await expect(setBookmark(dir, 'extra', true)).rejects.toThrow(/256/)
  expect(readFileSync(join(dir, 'ui-state.json'), 'utf8')).toBe(before)
  await setBookmark(dir, 'uid-0', true)
  await removeBookmark(dir, 'uid-0')
  expect(loadBookmarks(dir).state.uids).toHaveLength(255)
})

for (const raw of ['{broken', '{"version":2,"uids":["a"]}', '{"version":1,"uids":[42]}', '{"version":1,"uids":[""]}', '{"version":1,"uids":["a"],"title":"private"}', JSON.stringify({ version: 1, uids: Array.from({ length: 257 }, (_, i) => `${i}`) }), ' '.repeat(1024 * 1024 + 1)]) {
  test(`invalid state is read-only and never overwritten (${raw.length} bytes)`, async () => {
    mkdirSync(dir)
    writeFileSync(join(dir, 'ui-state.json'), raw)
    const loaded = loadBookmarks(dir)
    expect(loaded.writable).toBe(false)
    expect(loaded.warning).toBeTruthy()
    expect(loaded.state.uids).toEqual([])
    await expect(setBookmark(dir, 'a', true)).rejects.toThrow()
    expect(readFileSync(join(dir, 'ui-state.json'), 'utf8')).toBe(raw)
  })
}

test('file and directory symlinks are rejected without changing their targets', async () => {
  mkdirSync(dir)
  const outside = join(tmp, 'outside.json')
  const raw = '{"version":1,"uids":["outside"]}'
  writeFileSync(outside, raw)
  symlinkSync(outside, join(dir, 'ui-state.json'))
  expect(loadBookmarks(dir).writable).toBe(false)
  await expect(setBookmark(dir, 'a', true)).rejects.toThrow()
  expect(readFileSync(outside, 'utf8')).toBe(raw)
  rmSync(dir, { recursive: true })
  const outsideDir = join(tmp, 'outside-dir')
  mkdirSync(outsideDir)
  writeFileSync(join(outsideDir, 'ui-state.json'), raw)
  symlinkSync(outsideDir, dir)
  expect(loadBookmarks(dir).writable).toBe(false)
  await expect(setBookmark(dir, 'a', true)).rejects.toThrow()
  expect(readFileSync(join(outsideDir, 'ui-state.json'), 'utf8')).toBe(raw)
})

test('failed writes report an error and do not claim a bookmark was saved', async () => {
  mkdirSync(dir)
  mkdirSync(join(dir, 'ui-state.json'))
  await expect(setBookmark(dir, 'a', true)).rejects.toThrow()
  expect(statSync(join(dir, 'ui-state.json')).isDirectory()).toBe(true)
})

test('concurrent processes merge bookmark updates without losing UIDs', async () => {
  const modulePath = resolve('src/core/ui-state.ts')
  const children = Array.from({ length: 8 }, (_, i) => Bun.spawn([
    process.execPath, '-e', `import {setBookmark} from ${JSON.stringify(modulePath)}; await setBookmark(${JSON.stringify(dir)}, ${JSON.stringify(`uid-${i}`)}, true)`,
  ], { stdout: 'pipe', stderr: 'pipe' }))
  const outcomes = await Promise.all(children.map(async child => ({ exit: await child.exited, stderr: await new Response(child.stderr).text() })))
  expect(outcomes).toEqual(Array.from({ length: 8 }, () => ({ exit: 0, stderr: '' })))
  expect(loadBookmarks(dir).state.uids.sort()).toEqual(['uid-0', 'uid-1', 'uid-2', 'uid-3', 'uid-4', 'uid-5', 'uid-6', 'uid-7'])
})

test('same-process concurrent updates are serialized too', async () => {
  await Promise.all(Array.from({ length: 8 }, (_, i) => setBookmark(dir, `uid-${i}`, true)))
  expect(loadBookmarks(dir).state.uids.sort()).toEqual(['uid-0', 'uid-1', 'uid-2', 'uid-3', 'uid-4', 'uid-5', 'uid-6', 'uid-7'])
})

test('an old incomplete acquisition is recovered without losing bookmarks', async () => {
  await setBookmark(dir, 'existing', true)
  const lock = join(dir, '.ui-state.lock')
  mkdirSync(lock)
  const old = new Date(Date.now() - 60_000)
  utimesSync(lock, old, old)
  await setBookmark(dir, 'new', true)
  expect(loadBookmarks(dir).state.uids).toEqual(['existing', 'new'])
  expect(readdirSync(dir)).toEqual(['ui-state.json'])
})

test('a recovery guard stranded while writing its owner can be reclaimed', async () => {
  await setBookmark(dir, 'existing', true)
  const guard = join(dir, '.ui-state.lock.recovery')
  mkdirSync(guard)
  writeFileSync(join(guard, 'owner'), '')
  const old = new Date(Date.now() - 60_000)
  utimesSync(guard, old, old)
  await setBookmark(dir, 'new', true)
  expect(loadBookmarks(dir).state.uids).toEqual(['existing', 'new'])
  expect(readdirSync(dir)).toEqual(['ui-state.json'])
})

test('an old lock held by a live process stays protected', async () => {
  await setBookmark(dir, 'existing', true)
  const lock = join(dir, '.ui-state.lock')
  mkdirSync(lock)
  const owner = join(lock, 'owner')
  const raw = JSON.stringify({ token: randomUUID(), pid: process.pid })
  writeFileSync(owner, raw)
  const old = new Date(Date.now() - 60_000)
  utimesSync(owner, old, old)
  await expect(setBookmark(dir, 'new', true)).rejects.toThrow(/busy/)
  expect(loadBookmarks(dir).state.uids).toEqual(['existing'])
  expect(readFileSync(owner, 'utf8')).toBe(raw)
  expect(readdirSync(dir).sort()).toEqual(['.ui-state.lock', 'ui-state.json'])
})
