import { expect, test } from 'bun:test'
import { trackedFiles, type GitIo } from '../src/core/git'

function io(exitCode: number, out: string): GitIo {
  return {
    spawn() {
      return {
        stdout: new Response(out).body,
        exited: Promise.resolve(exitCode),
      }
    },
  }
}

test('tracked files come back as absolute paths', async () => {
  const result=await trackedFiles('/root/proj', io(0, 'src/sse.ts\0test/sse.test.ts\0'))
  expect(result.consulted).toBe(true)
  expect([...result.tracked]).toEqual(['/root/proj/src/sse.ts','/root/proj/test/sse.test.ts'])
})
test('a non-zero exit means git was not consulted', async () => {
  const result=await trackedFiles('/root/proj', io(128, ''))
  expect(result).toEqual({ consulted: false, tracked: new Set() })
})
test('a launcher that throws means git was not consulted', async () => {
  const result=await trackedFiles('/root/proj', { spawn() { throw new Error('ENOENT') } })
  expect(result).toEqual({ consulted: false, tracked: new Set() })
})
test('an empty repository is consulted and tracks nothing', async () => {
  const result=await trackedFiles('/root/proj', io(0, ''))
  expect(result).toEqual({ consulted: true, tracked: new Set() })
})
test('a null stdout is unreadable output', async () => {
  const result=await trackedFiles('/root/proj', {
    spawn() {
      return {
        stdout: null,
        exited: Promise.resolve(0),
      }
    },
  })
  expect(result).toEqual({ consulted: false, tracked: new Set() })
})
